"use strict";

const fs = require("node:fs");
const { isMetadataUnsupportedError } = require("./fsCopyFallback.cjs");

// Publish a prepared regular file without replacing any destination entry.
// Hardlinks make complete bytes visible atomically. FAT-like filesystems use an
// exclusively created handle instead: partial contents can be visible there,
// but no pathname cleanup may remove a concurrent writer's replacement.
// Resolves with the published inode identity ({ dev, ino, size }) so callers can
// verify an open destination handle before later metadata stamping, plus
// `timestampsPreserved`: whether the published inode actually carries the
// prepared file's timestamps. Hardlinked publication shares the inode; the copy
// path re-applies the times and falls back to a pathname-based stamp when the
// handle-based one is refused, reporting `false` when neither could stamp (so
// callers must not treat the metadata as prepared).
async function publishLocalFileExclusive(source, target, assertNotCancelled = () => {}, preparedHandle) {
  assertNotCancelled();
  try {
    await fs.promises.link(source, target);
    // The hardlink shares the published inode; stat either name.
    const linkedStat = await fs.promises.lstat(source);
    return { dev: linkedStat.dev, ino: linkedStat.ino, size: linkedStat.size, timestampsPreserved: true };
  } catch (error) {
    // EISDIR is the misleading libuv mapping for Win32 ERROR_INVALID_FUNCTION
    // when the volume has no hard-link support (exFAT/FAT32); the source here
    // is always a regular prepared file, never a directory (nodejs/node#65817).
    if (!["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EXDEV", "EISDIR"].includes(error?.code)) throw error;
  }

  let input;
  let output;
  let failure;
  let publishedIdentity;
  let timestampsPreserved = true;
  try {
    input = preparedHandle ?? await fs.promises.open(source, "r");
    const stat = await input.stat();
    assertNotCancelled();
    output = await fs.promises.open(target, "wx", stat.mode & 0o7777);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      assertNotCancelled();
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) throw new Error("Prepared local file ended before publication completed");
      let written = 0;
      while (written < bytesRead) {
        assertNotCancelled();
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, position + written);
        if (!bytesWritten) throw new Error("Local publication made no write progress");
        written += bytesWritten;
      }
      position += bytesRead;
    }
    assertNotCancelled();
    // Restore metadata after writes (which may clear special permission bits),
    // through the owned handle rather than a potentially replaced pathname.
    // gvfsd-fuse-style mounts reject chmod/utimes with ENOTSUP even though the
    // bytes are fully published; keep the copy instead of failing the transfer.
    try {
      await output.chmod(stat.mode & 0o7777);
    } catch (chmodError) {
      if (!isMetadataUnsupportedError(chmodError)) throw chmodError;
      // The target was created through the process umask, which may have
      // narrowed the requested mode. Only accept the chmod failure when the
      // published bytes already carry the intended mode; otherwise fail closed
      // rather than silently publishing a narrower one.
      const createdMode = (await output.stat()).mode & 0o7777;
      if (createdMode !== (stat.mode & 0o7777)) throw chmodError;
    }
    timestampsPreserved = false;
    try {
      await output.utimes(stat.atime, stat.mtime);
      timestampsPreserved = true;
    } catch (utimesError) {
      if (!isMetadataUnsupportedError(utimesError)) throw utimesError;
      // The handle-based futimens was refused, but the prepared timestamps can
      // still be applied through the pathname: some backends implement
      // utimensat while rejecting futimens. Retry through the pathname only
      // after the identity check below confirms the name still holds the
      // published inode, so the stamp cannot land on a replacement; if the
      // pathname refuses too, the caller reports the stamp as not prepared so
      // its final best-effort stamp still runs.
    }
    const ownedStat = await output.stat();
    const targetStat = await fs.promises.lstat(target);
    if (!targetStat.isFile() || targetStat.dev !== ownedStat.dev || targetStat.ino !== ownedStat.ino) {
      throw new Error("Local download target changed during replacement");
    }
    if (!timestampsPreserved) {
      try {
        await fs.promises.utimes(target, stat.atime, stat.mtime);
        const stampedStat = await fs.promises.lstat(target);
        if (!stampedStat.isFile() || stampedStat.dev !== ownedStat.dev || stampedStat.ino !== ownedStat.ino) {
          throw new Error("Local download target changed during replacement");
        }
        timestampsPreserved = true;
      } catch (stampingError) {
        if (!isMetadataUnsupportedError(stampingError)) throw stampingError;
      }
    }
    publishedIdentity = {
      dev: ownedStat.dev, ino: ownedStat.ino, size: ownedStat.size, timestampsPreserved,
    };
  } catch (error) {
    failure = error;
  } finally {
    for (const handle of [output, preparedHandle ? undefined : input]) {
      try { await handle?.close(); } catch (error) { failure ??= error; }
    }
  }
  if (failure) {
    // Once exclusive creation succeeded, leave the partial destination intact.
    // The caller must retain its complete prepared file and any original backup.
    if (output) failure.localPublicationIncomplete = true;
    throw failure;
  }
  return publishedIdentity;
}

module.exports = { publishLocalFileExclusive };
