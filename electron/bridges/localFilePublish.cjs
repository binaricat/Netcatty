"use strict";

const fs = require("node:fs");

// Publish a prepared regular file without replacing any destination entry.
// Hardlinks make complete bytes visible atomically. FAT-like filesystems use an
// exclusively created handle instead: partial contents can be visible there,
// but no pathname cleanup may remove a concurrent writer's replacement.
// Resolves with the published inode identity ({ dev, ino, size }) so callers can
// verify an open destination handle before later metadata stamping.
async function publishLocalFileExclusive(source, target, assertNotCancelled = () => {}, preparedHandle) {
  assertNotCancelled();
  try {
    await fs.promises.link(source, target);
    // The hardlink shares the published inode; stat either name.
    const linkedStat = await fs.promises.lstat(source);
    return { dev: linkedStat.dev, ino: linkedStat.ino, size: linkedStat.size };
  } catch (error) {
    if (!["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EXDEV"].includes(error?.code)) throw error;
  }

  let input;
  let output;
  let failure;
  let publishedIdentity;
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
    await output.chmod(stat.mode & 0o7777);
    await output.utimes(stat.atime, stat.mtime);
    const ownedStat = await output.stat();
    const targetStat = await fs.promises.lstat(target);
    if (!targetStat.isFile() || targetStat.dev !== ownedStat.dev || targetStat.ino !== ownedStat.ino) {
      throw new Error("Local download target changed during replacement");
    }
    publishedIdentity = { dev: ownedStat.dev, ino: ownedStat.ino, size: ownedStat.size };
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
