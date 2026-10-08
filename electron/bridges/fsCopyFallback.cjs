"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

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

// Best-effort check that `candidate` holds only a prefix of `source`'s bytes:
// a partial destination left behind by a copyFile failure can never contain
// data beyond the source's size, and its leading bytes must equal the
// source's leading bytes. The comparison is capped so a multi-gigabyte source
// is never streamed in full for verification; combined with the caller's
// pinned inode identity it disambiguates a copyFile leftover from a
// concurrent writer's file.
async function isSourceContentPrefix(source, candidate, limit = 1024 * 1024) {
  let sourceSize = null;
  let candidateSize = null;
  try {
    const [sourceStat, candidateStat] = await Promise.all([
      fs.promises.stat(source),
      fs.promises.stat(candidate),
    ]);
    sourceSize = sourceStat.size;
    candidateSize = candidateStat.size;
  } catch {
    return false;
  }
  if (candidateSize > sourceSize) return false;
  const length = Math.min(candidateSize, limit);
  // An empty prefix matches any source the candidate is not larger than.
  if (length === 0) return true;
  const sourceHandle = await fs.promises.open(source, "r").catch(() => null);
  if (!sourceHandle) return false;
  try {
    const candidateHandle = await fs.promises.open(candidate, "r").catch(() => null);
    if (!candidateHandle) return false;
    try {
      const sourceBytes = Buffer.allocUnsafe(length);
      const candidateBytes = Buffer.allocUnsafe(length);
      let sourceRead = 0;
      let candidateRead = 0;
      while (sourceRead < length) {
        const { bytesRead } = await sourceHandle.read(sourceBytes, sourceRead, length - sourceRead);
        if (!bytesRead) break;
        sourceRead += bytesRead;
      }
      while (candidateRead < length) {
        const { bytesRead } = await candidateHandle.read(candidateBytes, candidateRead, length - candidateRead);
        if (!bytesRead) break;
        candidateRead += bytesRead;
      }
      // A candidate that shrank (or a source that shrank below it) since it
      // was stat'ed cannot be verified as a stable prefix of the source.
      if (candidateRead < length || sourceRead < length) return false;
      return candidateBytes.equals(sourceBytes.subarray(0, length));
    } finally {
      await candidateHandle.close().catch(() => {});
    }
  } finally {
    await sourceHandle.close().catch(() => {});
  }
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
// chmods through the pathname, but because a pathname chmod cannot be pinned
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
    // not: a pathname chmod on a concurrent replacement would mutate that
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
// Note: the fallback stream is written through an owned handle, not a
// createWriteStream(target) stream, so the streamed inode's identity can be
// pinned and revalidated against the pathname below.
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
  // Only a copy-fallback errno raised by the copyFile syscall itself moves
  // this call to the stream fallback: a later metadata/relabel error that
  // happens to carry such a code (e.g. EINVAL from fchmod on a FUSE backend)
  // must propagate, otherwise a successfully completed accelerated copy would
  // be mistaken for a failed one and streamed over the still-existing target,
  // which fails closed with EEXIST below and discloses a relinquished target.
  let copySyscallInFlight = false;
  // Identity of whatever held `target` when a copy-fallback errno surfaced,
  // pinned so a later EEXIST on the stream's exclusive open can be checked
  // against it: only an entry that is verifiably this helper's own leftover
  // partial (the copy's best-effort self-cleanup can fail) must be cleaned by
  // this module; anything else is a concurrent writer's file.
  let copyLeftoverIdentity = null;
  try {
    copySyscallInFlight = true;
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    copySyscallInFlight = false;
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
      // The accelerated copy preserves the source's mode. When it already
      // carries the requested mode, discarding it to recreate the data
      // through `open(..., creationMode)` would only expose the copy to the
      // process umask (a 0664 requested mode can become 0600, and the second
      // chmod refusal then turns a transfer that already succeeded into a
      // hard EPERM failure). Stat the accelerated result instead and keep it
      // when its identity is still the one pinned before the refused chmod
      // and its mode already equals the requested one.
      let keptStat = null;
      try {
        keptStat = await fs.promises.lstat(target);
      } catch { keptStat = null; }
      if (
        copiedIdentity !== null
        && keptStat !== null
        && fileIdentity(keptStat) === copiedIdentity
        && (keptStat.mode & 0o7777) === creationMode
      ) {
        return;
      }
    }
    // Otherwise the accelerated copy does not carry the requested mode and
    // this mount refuses chmod, so the intended mode can never be applied to
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
    if (!(copySyscallInFlight && isCopyFallbackError(error))) throw error;
    // The accelerated copy refused to run; fall through to the stream
    // fallback (libuv's best-effort removal of its partial destination may
    // have failed, so the pathname may still hold this helper's own partial).
  }
  // Pin the identity of whatever currently holds `target` before the
  // exclusive open below: when the accelerated copy's failed best-effort
  // self-cleanup leaves its own partial behind the pathname, the EEXIST the
  // open reports must not be mistaken for a concurrent writer's file (see
  // the open's EEXIST handler). The relabel path above reaches this point
  // only with the name absent (its verified partial was unlinked, or was
  // never left where this copy call could have written it), so the pin is
  // null there and cannot mislabel a foreign entry as ours.
  copyLeftoverIdentity = null;
  try {
    copyLeftoverIdentity = fileIdentity(await fs.promises.lstat(target));
  } catch { copyLeftoverIdentity = null; }
  assertNotCancelled();
  if (signal?.aborted) throw cancelledError();
  // The copy is driven through owned handles instead of fs streams: only a
  // handle pins the inode the copy actually wrote (a stream's fd is closed
  // by the time the copy ends), which the pathname revalidation below needs.
  // The exclusive open here also keeps COPYFILE_EXCL semantics for EEXIST.
  const copyLoop = async (readHandle, writeHandle) => {
    // Re-check cancellation between chunks: a multi-gigabyte staged file
    // being streamed onto a slow GVFS/FUSE mount must stop writing as soon
    // as the caller cancels, instead of finishing the whole temporary copy
    // (and lingering on the network mount) before the result is discarded.
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      assertNotCancelled();
      if (signal?.aborted) throw cancelledError();
      const { bytesRead } = await readHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        assertNotCancelled();
        const { bytesWritten } = await writeHandle.write(
          buffer, written, bytesRead - written, position + written,
        );
        if (!bytesWritten) throw new Error("Local transfer made no write progress");
        written += bytesWritten;
      }
      position += bytesRead;
    }
    const writtenStat = await writeHandle.stat();
    return {
      writtenIdentity: fileIdentity(writtenStat),
      writtenMode: writtenStat.mode & 0o7777,
    };
  };
  let copied = null;
  {
    let readHandle = null;
    let writeHandle = null;
    try {
      readHandle = await fs.promises.open(source, "r");
      try {
        writeHandle = await fs.promises.open(target, "wx", creationMode === null ? 0o666 : creationMode);
      } catch (openError) {
        // The exclusive open fails with EEXIST before a single byte is
        // written. Normally a concurrent writer created or replaced `target`
        // after the accelerated-copy path decided to stream but before this
        // open (the relabel block above only ran on the chmod-refusal path,
        // so it did not move the entry away here), and the failure must be
        // marked with `targetOwnershipRelinquished` so the caller's
        // pre-commit cleanup does not unlink the pathname and destroy that
        // writer's only visible file. The accelerated copyFile path is the
        // exception: libuv unlinks its own partial destination when the copy
        // falls back, but that removal is best-effort and can itself fail,
        // so the entry behind the EEXIST may be this helper's own leftover
        // partial. Verify the entry (identity pinned right after the copy
        // failure, plus a source-prefix bytes check) before treating the
        // name as changed hands: a verified leftover is unlinked and the
        // exclusive open retried, so the stream fallback actually runs and
        // the caller's cleanup is not skipped for this module's own file.
        if (openError?.code === "EEXIST") {
          let clearedVerifiedLeftover = false;
          let verificationFailure = null;
          try {
            const existingIdentity = fileIdentity(await fs.promises.lstat(target));
            if (
              copyLeftoverIdentity !== null
              && existingIdentity === copyLeftoverIdentity
              && await isSourceContentPrefix(source, target)
            ) {
              await fs.promises.unlink(target);
              writeHandle = await fs.promises.open(
                target, "wx", creationMode === null ? 0o666 : creationMode,
              );
              clearedVerifiedLeftover = true;
            }
          } catch (clearingError) {
            verificationFailure = clearingError;
            clearedVerifiedLeftover = false;
          }
          if (!clearedVerifiedLeftover) {
            throw Object.assign(
              new Error(`EEXIST: file exists, ${target} changed hands before the fallback stream could open it`),
              {
                code: "EEXIST",
                targetOwnershipRelinquished: true,
                ...(verificationFailure ? { cause: verificationFailure } : {}),
              },
            );
          }
        } else {
          throw openError;
        }
      }
      // Pin the created inode's identity immediately: the copy loop below can
      // also fail (cancellation, a read/write error on the mount), and a
      // failing copy never reaches the final pathname revalidation, so the
      // created inode's held identity is what a failure-time revalidation
      // compares against.
      let heldIdentity = null;
      try {
        const heldStat = await writeHandle.stat();
        // The copy loop may fail midway with partial data written, so the
        // failure-time revaluation cannot compare sizes (they grow while the
        // copy runs); ownership is pinned by the writable inode's dev/ino.
        heldIdentity = `${heldStat.dev}:${heldStat.ino}`;
      } catch { heldIdentity = null; }
      try {
        copied = await copyLoop(readHandle, writeHandle);
      } catch (copyError) {
        // A rejected copy loop bypasses the post-copy revalidation entirely,
        // so the partial destination's ownership cannot simply be decided by
        // a check-then-throw: the caller's error cleanup unlinks the pathname,
        // and a concurrent replacement can win the name between this check
        // and that unlink, so a verified check does not tie the cleanup to
        // the inode. Cleanup is relabel-then-verify instead (the same pattern
        // as the mode-fallback path above): rename moves whatever currently
        // owns the pathname to a private side name without deleting anything,
        // and only an inode verifiably equal to the one this module created is
        // unlinked from that side name (a name no concurrent writer can race
        // it on). Anything else is relinked back (or left aside untouched,
        // never destroyed) and the handover is marked so the caller's cleanup
        // leaves the pathname alone.
        const stalePath = `${target}.stale-${crypto.randomUUID().replace(/-/g, "")}`;
        let moved = false;
        let relabelError = null;
        try {
          await fs.promises.rename(target, stalePath);
          moved = true;
        } catch (relabelFailure) {
          // ENOENT: the partial destination is already gone, so there is
          // nothing left to clean. Any other failure leaves ownership
          // unverified; fail closed by marking the handover so the caller
          // never unlinks a name this module could not verify (any leftover
          // partial is disclosed by the caller's recovery reporting).
          if (relabelFailure?.code !== "ENOENT") relabelError = relabelFailure;
        }
        let staleIdentity = null;
        if (moved) {
          try {
            const staleStat = await fs.promises.lstat(stalePath);
            staleIdentity = `${staleStat.dev}:${staleStat.ino}`;
          } catch { staleIdentity = null; }
        }
        if (moved && heldIdentity !== null && staleIdentity === heldIdentity) {
          // The side name verifiably holds this module's partial inode still
          // referenced through the pinned write handle; unlink it from the
          // private side name, which a concurrent writer cannot race because
          // only this relabel knows the name. If the mount refuses the
          // removal, the verified partial data persists at the side name, so
          // the unlink failure is preserved and the artifact is disclosed to
          // the caller (via `stalePath`) instead of silently leaving hidden
          // partial files to accumulate on the destination.
          let unlinkFailure = null;
          try {
            await fs.promises.unlink(stalePath);
          } catch (failure) {
            unlinkFailure = failure;
          }
          // The pathname itself has already been cleaned through the verified
          // side name, but a replacement could re-create it before the
          // caller's cleanup runs: still mark the handover so that unlink
          // never destroys a re-created foreign file.
          throw Object.assign(copyError, {
            targetOwnershipRelinquished: true,
            ...(unlinkFailure ? { cause: unlinkFailure, stalePath } : {}),
          });
        }
        if (moved) {
          // The relabelled side name holds a foreign replacement: put it back
          // without clobbering whoever re-created the pathname (a failed
          // restore leaves the verified data aside, never deleted).
          let restoreError = null;
          try {
            await fs.promises.link(stalePath, target);
          } catch (linkError) {
            // EEXIST means the pathname was already re-created by a newer
            // writer and their name wins; keep the verified data aside.
            if (linkError?.code !== "EEXIST") restoreError = linkError;
          }
          throw Object.assign(
            new Error(`EEXIST: file exists, ${target} changed hands while the fallback stream was copying`),
            {
              code: copyError?.code,
              cause: restoreError ?? copyError,
              stalePath,
              targetOwnershipRelinquished: true,
            },
          );
        }
        // Nothing was relabelled (renamed away) or the relabel could not be
        // verified: in both cases the caller must not unlink the pathname, so
        // the handover is marked either way.
        throw Object.assign(copyError, {
          targetOwnershipRelinquished: true,
          ...(relabelError ? { cause: relabelError } : {}),
        });
      }
    } finally {
      await writeHandle?.close().catch(() => {});
      await readHandle?.close().catch(() => {});
    }
  }
  const writtenIdentity = copied?.writtenIdentity ?? null;
  const writtenMode = copied?.writtenMode ?? null;
  if (creationMode !== null && writtenMode !== creationMode) {
    // The destination applies the process umask to the stream's creation
    // mode (e.g. an intended 0664 becomes 0600 under umask 0077), so the
    // created file can be narrower than the mode promised to the caller.
    // Restore any masked bit through the pinned copied inode; a mount that
    // refuses chmod can never carry the exact mode, so fail closed instead
    // of leaving a narrower mode for the later promotion to publish.
    try {
      await chmodOnCopiedFile(target, creationMode, writtenIdentity);
    } catch (chmodError) {
      if (!isMetadataUnsupportedError(chmodError)) throw chmodError;
      throw Object.assign(
        new Error(`EPERM: operation not permitted, umask narrowed the creation mode of ${target} and the mount refuses chmod`),
        { code: "EPERM" },
      );
    }
  }
  // Revalidate the pathname against the pinned copied inode before
  // returning, even when no chmod ran (the common case where the created
  // mode already matched): a replacement that won the name while the copy
  // ran must never be blessed for the caller's later publication.
  // chmodOnCopiedFile already performed this revalidation on the chmod
  // path, so the check is simply repeated unconditionally here.
  let finalIdentity = null;
  try {
    finalIdentity = fileIdentity(await fs.promises.lstat(target));
  } catch { finalIdentity = null; }
  if (finalIdentity !== writtenIdentity) {
    throw identityChangedError(target);
  }
}

module.exports = {
  copyFileExclusiveWithFallback,
  isCopyFallbackError,
  isMetadataUnsupportedError,
};
