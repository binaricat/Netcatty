"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// Node's fs.copyFile accelerates the data copy with Linux copy_file_range().
// FUSE/network filesystems such as GVFS SMB mounts, NFS and CIFS can reject
// that syscall with ENOTSUP/EOPNOTSUPP (nodejs/node#36439) even though plain
// read/write copies (what cp does) succeed. Those refuse-to-copy errnos fall
// back to a stream copy so the transfer still completes.
const COPY_FALLBACK_ERRNOS = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"]);
// gvfsd-fuse-style backends also only partially implement metadata operations:
// chmod/utimes can return ENOTSUP/EOPNOTSUPP (or ENOSYS) on data that is fully
// writable. Those are tolerated as best-effort by callers of this module.
const METADATA_UNSUPPORTED_ERRNOS = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function isCopyFallbackError(error) {
  return COPY_FALLBACK_ERRNOS.has(error?.code);
}

function isMetadataUnsupportedError(error) {
  return METADATA_UNSUPPORTED_ERRNOS.has(error?.code);
}

// Same shape as the transfer bridge's local stream cancellation error, so
// callers can treat a cancelled fallback copy like any other cancellation.
function cancelledError() {
  const error = new Error("Transfer cancelled");
  error.code = "ABORT_ERR";
  return error;
}

// Comparable signature of the inode a name currently resolves to (same shape
// as the transfer bridge's stableLocalFileIdentity).
function fileIdentity(statLike) {
  return [statLike?.dev, statLike?.ino, statLike?.size].join(":");
}

// An EEXIST carrying `targetOwnershipRelinquished` tells callers that the
// destination name has changed hands: whoever (or whatever) now holds the
// pathname did not create it through this module, so a caller's pre-commit
// cleanup must not unlink the pathname (its bytes may have no other visible
// name; a relabelled copy is disclosed via `stalePath` instead).
function identityChangedError(target) {
  return Object.assign(
    new Error(`EEXIST: file exists, ${target} changed hands while its mode was being applied`),
    { code: "EEXIST", targetOwnershipRelinquished: true },
  );
}

// Apply `mode` to `target` while proving the metadata change cannot land on a
// concurrent replacement of the pathname: chmod through the pathname is only
// safe once the pathname is again verified (before and after the change) to
// resolve to the inode `copiedIdentity` describes, so a successful return can
// never bless a replacement for the caller's later publication. The preferred
// path performs the change through an owned handle, which pins the inode: the
// opened inode must still be the copied one before it is touched, and again
// after the change the pathname is re-verified (a replacement could have won
// the name while the metadata change was in flight). A copy too restrictive
// to open for reading must still regain its intended mode, so that case
// chmods through the pathname — but because a pathname chmod cannot be pinned
// to the copied inode, the name is re-verified once more *before* the mode
// change, so a pathname that already changed hands fails closed without
// mutating the replacement's permissions (the post-change revalidation below
// could refuse to bless that replacement, but nothing could undo the mutated
// mode).
// Identity mismatches fail closed like COPYFILE_EXCL; the replacement is
// left in place and the caller never publishes it.
async function chmodOnCopiedFile(target, mode, copiedIdentity) {
  let handle;
  try {
    handle = await fs.promises.open(target, fs.constants.O_RDONLY);
  } catch (openError) {
    if (openError?.code !== "EACCES" && openError?.code !== "EPERM") throw openError;
    // Cannot hold a handle on the unreadable copy: the mode change must go
    // through the pathname. Since a pathname chmod cannot be pinned to the
    // copied inode, first confirm the name still resolves to the copy the
    // mode was meant for and fail closed without touching the file if it does
    // not — a pathname chmod on a concurrent replacement would mutate that
    // replacement's permissions, which nothing could undo afterwards.
    let preChmodIdentity = null;
    try {
      preChmodIdentity = fileIdentity(await fs.promises.lstat(target));
    } catch { preChmodIdentity = null; }
    if (copiedIdentity === null || preChmodIdentity !== copiedIdentity) {
      throw identityChangedError(target);
    }
    await fs.promises.chmod(target, mode);
    let chmodgedIdentity = null;
    try {
      chmodgedIdentity = fileIdentity(await fs.promises.lstat(target));
    } catch { chmodgedIdentity = null; }
    if (copiedIdentity === null || chmodgedIdentity !== copiedIdentity) {
      throw identityChangedError(target);
    }
    return;
  }
  try {
    const heldIdentity = fileIdentity(await handle.stat());
    if (copiedIdentity === null || heldIdentity !== copiedIdentity) {
      throw identityChangedError(target);
    }
    await handle.chmod(mode);
    // The chmod was pinned to the held inode, but the pathname itself may have
    // been replaced while the (possibly slow) metadata change ran. Like the
    // pathname branch above, revalidate the name before returning success so a
    // replacement is never blessed for the caller's later publication.
    let chmodgedIdentity = null;
    try {
      chmodgedIdentity = fileIdentity(await fs.promises.lstat(target));
    } catch { chmodgedIdentity = null; }
    if (chmodgedIdentity !== heldIdentity) {
      throw identityChangedError(target);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

// Exclusive copy with COPYFILE_EXCL semantics that falls back to a read/write
// stream when the destination filesystem refuses the accelerated copy syscall.
// A partially written target name is left in place on failure for the caller
// to clean up, matching fs.copyFile's failure behavior.
// `mode` (optional) is applied to the fallback stream so mounts that reject
// chmod still receive restrictive creation-mode bits instead of the broader
// default 0666. The destination's umask can narrow the stream's creation
// mode below `mode`, so the created file's mode is verified afterwards and
// any masked bit restored; a chmod-refusing mount cannot promise `mode`, so
// the copy fails closed rather than producing a narrower file. On the
// accelerated copyFile path the source's mode is carried
// over, so `mode` is re-applied with chmod; when that chmod is refused the
// gvfsd-fuse-style way (ENOTSUP/EOPNOTSUPP/ENOSYS) the copy is redone as a
// stream so the target is still created with `mode` instead of leaking the
// potentially broader staged source mode. The removal of the replaced copy is
// relabel-then-verify: rename moves whatever currently owns the name to a
// private side name without deleting anything, and only an inode verifiably
// equal to the copy this module produced is unlinked from that side name.
// `options` (optional) carries cancellation: `signal` (AbortSignal) aborts
// the fallback stream immediately, and `assertNotCancelled` is re-checked
// between streamed chunks so cancelling a slow GVFS/FUSE copy stops writing
// to the mount instead of finishing the whole staged copy first.
async function copyFileExclusiveWithFallback(source, target, mode = null, options = {}) {
  const creationMode = Number.isInteger(mode) && mode >= 0 ? mode & 0o7777 : null;
  const assertNotCancelled = typeof options.assertNotCancelled === "function"
    ? options.assertNotCancelled
    : () => {};
  const signal = options.signal;
  try {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    if (creationMode === null) return;
    // Pin the identity of the produced copy while the (possibly slow, e.g.
    // network-backed) chmod below runs, so the replacement only removes a
    // name that still resolves to our own inode.
    let copiedIdentity = null;
    try {
      copiedIdentity = fileIdentity(await fs.promises.lstat(target));
    } catch { copiedIdentity = null; }
    try {
      await chmodOnCopiedFile(target, creationMode, copiedIdentity);
      return;
    } catch (error) {
      if (!isMetadataUnsupportedError(error)) throw error;
    }
    // The accelerated copy preserved the source's mode and this mount refuses
    // chmod, so the intended mode can never be applied to it afterwards.
    // Replace it with a streamed copy whose creation mode carries the
    // intended (no broader than requested) bits.
    // Relabel-then-verify instead of check-then-unlink: `rename` moves
    // whatever the name currently holds to a side name without deleting
    // anything, so a concurrent replacement that lands between verification
    // and removal cannot be destroyed. Only a name whose inode was verified
    // to be the copy this module produced is unlinked, from a private side
    // name; anything else is relinked back (or left aside untouched) and the
    // operation fails closed like COPYFILE_EXCL.
    {
      const stalePath = `${target}.stale-${crypto.randomUUID().replace(/-/g, "")}`;
      let moved = false;
      let restoreLinkFailure = null;
      try {
        await fs.promises.rename(target, stalePath);
        moved = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (moved) {
        let staleIdentity = null;
        try {
          staleIdentity = fileIdentity(await fs.promises.lstat(stalePath));
        } catch { staleIdentity = null; }
        if (copiedIdentity === null || staleIdentity !== copiedIdentity) {
          // The name changed hands before (or while) it was relabeled. It is
          // no longer ours: put it back without clobbering whoever re-created
          // the name (a failed restore leaves the verified data aside, never
          // deleted) and fail closed like COPYFILE_EXCL.
          try {
            await fs.promises.link(stalePath, target);
          } catch (linkError) {
            // Hardlink-less destinations (the GVFS/FUSE mounts this fallback
            // exists for) cannot restore through `link`. POSIX offers no
            // non-overwriting rename, so a check-then-rename fallback would
            // replace a concurrent writer's freshly created `target`: the
            // separate absence check races with its creation. Fail closed
            // instead, leaving the verified data aside at the disclosed side
            // name rather than clobbering whoever re-created the pathname.
            if (linkError?.code !== "EEXIST") restoreLinkFailure = linkError;
          }
          throw Object.assign(
            new Error(
              `EEXIST: file exists, ${target} changed while its mode could not be applied;`
              + ` the verified copy was left aside at ${stalePath}`,
            ),
            // `targetOwnershipRelinquished` tells the caller that the name
            // was just relabelled back to its foreign owner (restored with
            // `link`) or was already re-created by a newer writer, so the
            // caller's pre-commit cleanup must not unlink the pathname.
            { code: "EEXIST", stalePath, targetOwnershipRelinquished: true, cause: restoreLinkFailure },
          );
        }
        await fs.promises.unlink(stalePath);
      }
    }
  } catch (error) {
    if (!isCopyFallbackError(error)) throw error;
  }
  const writeOptions = { flags: "wx" };
  if (creationMode !== null) writeOptions.mode = creationMode;
  assertNotCancelled();
  if (signal?.aborted) throw cancelledError();
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort(cancelledError());
  signal?.addEventListener?.("abort", abortFromExternalSignal, { once: true });
  // Re-check cancellation between chunks: a multi-gigabyte staged file being
  // streamed onto a slow GVFS/FUSE mount must stop writing as soon as the
  // caller cancels, instead of finishing the whole temporary copy (and
  // lingering on the network mount) before the result is discarded.
  const cancellationGate = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        assertNotCancelled();
      } catch (error) {
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(source),
      cancellationGate,
      fs.createWriteStream(target, writeOptions),
      { signal: controller.signal },
    );
  } finally {
    signal?.removeEventListener?.("abort", abortFromExternalSignal);
  }
  if (creationMode !== null) {
    // The destination applies the process umask to the stream's creation
    // mode (e.g. an intended 0664 becomes 0600 under umask 0077), so the
    // created file can be narrower than the mode promised to the caller.
    // Restore any masked bit through the pinned copied inode; a mount that
    // refuses chmod can never carry the exact mode, so fail closed instead
    // of leaving a narrower mode for the later promotion to publish.
    let createdIdentity = null;
    let createdMode = null;
    try {
      const createdStat = await fs.promises.lstat(target);
      createdIdentity = fileIdentity(createdStat);
      createdMode = createdStat.mode & 0o7777;
    } catch { createdMode = null; }
    if (createdMode !== creationMode) {
      try {
        await chmodOnCopiedFile(target, creationMode, createdIdentity);
      } catch (chmodError) {
        if (!isMetadataUnsupportedError(chmodError)) throw chmodError;
        throw Object.assign(
          new Error(`EPERM: operation not permitted, umask narrowed the creation mode of ${target} and the mount refuses chmod`),
          { code: "EPERM" },
        );
      }
    }
  }
}

module.exports = {
  copyFileExclusiveWithFallback,
  isCopyFallbackError,
  isMetadataUnsupportedError,
};
