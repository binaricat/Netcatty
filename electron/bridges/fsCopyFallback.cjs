"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
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

// Comparable signature of the inode a name currently resolves to (same shape
// as the transfer bridge's stableLocalFileIdentity).
function fileIdentity(statLike) {
  return [statLike?.dev, statLike?.ino, statLike?.size].join(":");
}

// Exclusive copy with COPYFILE_EXCL semantics that falls back to a read/write
// stream when the destination filesystem refuses the accelerated copy syscall.
// A partially written target name is left in place on failure for the caller
// to clean up, matching fs.copyFile's failure behavior.
// `mode` (optional) is applied to the fallback stream so mounts that reject
// chmod still receive restrictive creation-mode bits instead of the broader
// default 0666. On the accelerated copyFile path the source's mode is carried
// over, so `mode` is re-applied with chmod; when that chmod is refused the
// gvfsd-fuse-style way (ENOTSUP/EOPNOTSUPP/ENOSYS) the copy is redone as a
// stream so the target is still created with `mode` instead of leaking the
// potentially broader staged source mode. The removal of the replaced copy is
// relabel-then-verify: rename moves whatever currently owns the name to a
// private side name without deleting anything, and only an inode verifiably
// equal to the copy this module produced is unlinked from that side name.
async function copyFileExclusiveWithFallback(source, target, mode = null) {
  const creationMode = Number.isInteger(mode) && mode >= 0 ? mode & 0o7777 : null;
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
      await fs.promises.chmod(target, creationMode);
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
          // the name (a failed relink leaves the verified data aside, never
          // deleted) and fail closed like COPYFILE_EXCL.
          try {
            await fs.promises.link(stalePath, target);
          } catch { /* target already re-occupied by someone else */ }
          throw Object.assign(
            new Error(`EEXIST: file exists, ${target} changed while its mode could not be applied`),
            { code: "EEXIST" },
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
  await pipeline(
    fs.createReadStream(source),
    fs.createWriteStream(target, writeOptions),
  );
}

module.exports = {
  copyFileExclusiveWithFallback,
  isCopyFallbackError,
  isMetadataUnsupportedError,
};
