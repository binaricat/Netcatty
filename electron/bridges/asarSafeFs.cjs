/**
 * asarSafeFs - Local filesystem reads that bypass Electron's asar interception.
 *
 * Electron patches node:fs so that ANY local path whose segment ends with
 * .asar (case-insensitive) is treated as an asar archive instead of reaching
 * the real filesystem (electron/lib/node/asar-fs-wrapper.ts, asarRe = /\.asar/i).
 * Uploading a real file named app.asar then fails before any network I/O with
 * the archive-root error `ENOENT,  not found in <path>` (the two spaces come
 * from the empty inner filePath), while the identical bytes named app.bin
 * upload fine (#3450).
 *
 * The official switch is process.noAsar = true, but it must only be flipped
 * around the exact fs call that resolves the path, because:
 * - stat / open resolve asar-ness synchronously at call time, and fd-level
 *   operations (fs.read, handle.stat, fs.fstat) on the returned real fd are
 *   not intercepted again;
 * - fs.createReadStream resolves asar-ness lazily when the stream opens the
 *   fd, so a synchronous toggle around the call is not enough — open the fd
 *   with a scoped toggle and hand the stream `{ fd }` instead;
 * - ssh2 fastPut resolves asar-ness through the synchronous `fs.open` inside
 *   fastXfer, so a scoped toggle around the fastPut call covers it.
 * The toggle is always restored synchronously, so concurrent require() from
 * app.asar and other asar-aware fs users are unaffected.
 */
const fs = require("node:fs");

function withNoAsar(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

/** stat() a real local file, ignoring any .asar-looking path segment. */
function statLocal(filePath, options) {
  return withNoAsar(() => fs.promises.stat(filePath, options));
}

/** Open a real local file handle (fd reads afterwards are not intercepted). */
function openLocal(filePath, flags = "r") {
  return withNoAsar(() => fs.promises.open(filePath, flags));
}

/**
 * Read stream for a real local file. The fd is opened under a scoped noAsar
 * toggle (fs.openSync) because fs.createReadStream resolves asar-ness lazily
 * when the stream opens the fd. The stream auto-closes the fd.
 */
function createLocalReadStream(filePath, options = {}) {
  return withNoAsar(() => {
    const fd = fs.openSync(filePath, "r");
    try {
      return fs.createReadStream(filePath, { ...options, fd, autoClose: true });
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      throw error;
    }
  });
}

/**
 * Promise-returning variant: open failures reject instead of throwing
 * synchronously, matching the error shape of the patched fs.createReadStream.
 */
function openLocalReadStream(filePath, options = {}) {
  return Promise.resolve().then(() => createLocalReadStream(filePath, options));
}

/**
 * ssh2 fastPut for a real local file. fastXfer performs its local fs.open
 * synchronously inside the call, so the scoped toggle covers the one patched
 * call it makes; subsequent reads go through the real fd.
 */
function fastPutLocal(sftp, localPath, remotePath, options, callback) {
  return withNoAsar(() => sftp.fastPut(localPath, remotePath, options, callback));
}

module.exports = {
  withNoAsar,
  statLocal,
  openLocal,
  createLocalReadStream,
  openLocalReadStream,
  fastPutLocal,
};
