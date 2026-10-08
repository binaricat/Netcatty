"use strict";

const fs = require("node:fs");
const { pipeline } = require("node:stream/promises");

// Node's fs.copyFile accelerates the data copy with Linux copy_file_range().
// FUSE/network filesystems such as GVFS SMB mounts, NFS and CIFS can reject
// that syscall with ENOTSUP/EOPNOTSUPP (nodejs/node#36439) even though plain
// read/write copies — what cp does — succeed. Those refuse-to-copy errnos fall
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

// Exclusive copy with COPYFILE_EXCL semantics that falls back to a read/write
// stream when the destination filesystem refuses the accelerated copy syscall.
// A partially written target name is left in place on failure for the caller
// to clean up, matching fs.copyFile's failure behavior.
async function copyFileExclusiveWithFallback(source, target) {
  try {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    return;
  } catch (error) {
    if (!isCopyFallbackError(error)) throw error;
  }
  await pipeline(
    fs.createReadStream(source),
    fs.createWriteStream(target, { flags: "wx" }),
  );
}

module.exports = {
  copyFileExclusiveWithFallback,
  isCopyFallbackError,
  isMetadataUnsupportedError,
};
