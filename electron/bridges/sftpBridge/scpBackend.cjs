/**
 * SCP-mode remote filesystem backend.
 * Browse/manage via carefully quoted shell; transfers via OpenSSH scp -t/-f protocol.
 *
 * The exec layer is injectible for unit tests:
 *   exec(command) -> Promise<{ stdout, stderr, code }>
 *   execStream(command) -> Promise<Duplex-like stream with write/on/close/end>
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { executeBoundedSshCommand, terminateSshExecStream } = require("../boundedSshExec.cjs");
const { invalidateSshTransport } = require("../sshTransportInvalidation.cjs");
const {
  buildFileControlLine,
  buildAck,
  consumeAck,
  createSourceStreamParser,
  ScpProtocolError,
} = require("./scpProtocol.cjs");
const {
  shellQuote,
  assertSafeRemotePath,
  buildScpSinkCommand,
  buildScpSourceCommand,
  buildListCommand,
  buildListCommandLs,
  buildStatCommand,
  buildMkdirCommand,
  buildDeleteCommand,
  buildUnlinkCommand,
  buildRenameCommand,
  buildChmodCommand,
  buildHomeCommand,
  buildRealpathCommand,
  parseListRecords,
  parseLsLaOutput,
  parseStatRecord,
  modeToPermissionsString,
  isScpModeClient,
  shellQuotePath,
  ScpShellError,
} = require("./scpShell.cjs");

/**
 * Bridge an AbortSignal to the transfer object used by SCP upload/download.
 * scpBackend only observes transfer.cancelled + transfer.abort(); signal.aborted
 * alone is never read mid-transfer.
 */
function createTransferFromAbortSignal(signal) {
  if (!signal) return null;
  const transfer = {
    cancelled: !!signal.aborted,
    abort: null,
  };
  const onAbort = () => {
    transfer.cancelled = true;
    try {
      if (typeof transfer.abort === "function") transfer.abort();
    } catch {
      // ignore abort hook failures
    }
  };
  if (signal.aborted) {
    transfer.cancelled = true;
  } else if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onAbort, { once: true });
    transfer.detachAbortSignal = () => {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
    };
  }
  return transfer;
}

function createScpBackend(deps = {}) {
  const {
    exec,
    execStream,
    fsModule = fs,
    pathModule = path,
  } = deps;

  if (typeof exec !== "function") {
    throw new Error("scpBackend requires deps.exec(command)");
  }
  if (typeof execStream !== "function") {
    throw new Error("scpBackend requires deps.execStream(command)");
  }

  async function runOrThrow(command, { allowNonZero = false, signal = null } = {}) {
    if (signal?.aborted) {
      throw new Error("Transfer cancelled");
    }
    const result = await exec(command, { signal });
    if (!allowNonZero && result.code !== 0 && result.code != null) {
      const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.code}`;
      throw new ScpShellError(detail);
    }
    return result;
  }

  async function list(remotePath, options = {}) {
    const dir = remotePath || ".";
    const encoding = options.encoding || "utf-8";
    const signal = options.signal || null;
    assertSafeRemotePath(dir === "." ? "." : dir);
    let records;
    try {
      const result = await runOrThrow(buildListCommand(dir, encoding), { allowNonZero: true, signal });
      if (result.code === 0) {
        records = parseListRecords(result.stdout, encoding);
        if (records.length === 0 && (result.stdout || "").trim()) {
          records = null;
        }
      }
    } catch (err) {
      if (signal?.aborted || /cancel/i.test(err?.message || "")) throw err;
      records = null;
    }
    if (!records) {
      const ls = await runOrThrow(buildListCommandLs(dir, encoding), { signal });
      records = parseLsLaOutput(ls.stdout, { basePath: dir });
    }
    // Resolve symlink targets so UI can navigate directory links
    // (isNavigableDirectory requires linkTarget === "directory").
    const base = dir === "." ? "." : dir.replace(/\/+$/, "") || "/";
    const entries = [];
    for (const rec of records) {
      if (signal?.aborted) throw new Error("Transfer cancelled");
      const entry = toListEntry(rec);
      if (rec.type === "symlink") {
        const fullPath = base === "/"
          ? `/${rec.name}`
          : base === "."
            ? rec.name
            : `${base}/${rec.name}`;
        entry.linkTarget = await resolveSymlinkTargetType(fullPath, { encoding, signal });
      }
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Follow a symlink with shell tests (same idea as SFTP client.stat following links).
   * `[ -d path ]` follows symlinks; combined with known-symlink listing.
   */
  async function resolveSymlinkTargetType(remotePath, options = {}) {
    try {
      const encoding = options.encoding || "utf-8";
      const signal = options.signal || null;
      // -e fails for broken links; -d follows to the target.
      const cmd = [
        `p=${shellQuotePath(remotePath, encoding)}`,
        'if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo broken; exit 0; fi',
        'if [ -d "$p" ]; then echo directory; else echo file; fi',
      ].join("; ");
      const result = await runOrThrow(cmd, { allowNonZero: true, signal });
      const kind = (result.stdout || "").trim().split(/\r?\n/).pop();
      if (kind === "directory") return "directory";
      if (kind === "file") return "file";
      return null;
    } catch {
      return null;
    }
  }

  function toListEntry(rec) {
    const sizeNum = Number(rec.size) || 0;
    return {
      name: rec.name,
      type: rec.type,
      linkTarget: rec.type === "symlink" ? "file" : null,
      size: `${sizeNum} bytes`,
      lastModified: new Date(rec.modifyTime || Date.now()).toISOString(),
      permissions: rec.permissions,
      ...(rec.owner ? { owner: rec.owner } : {}),
      // raw fields for internal use
      _size: sizeNum,
      _modifyTime: rec.modifyTime,
    };
  }

  async function stat(remotePath, options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    const result = await runOrThrow(buildStatCommand(remotePath, encoding), { signal });
    return parseStatRecord(result.stdout);
  }

  async function mkdir(remotePath, options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    await runOrThrow(buildMkdirCommand(remotePath, {
      recursive: options.recursive !== false,
      encoding,
    }), { signal });
    return true;
  }

  async function remove(remotePath, options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    let recursive = !!options.recursive;
    if (!recursive) {
      try {
        const st = await stat(remotePath, { signal, encoding });
        recursive = st.isDirectory;
      } catch {
        // best-effort delete
      }
    }
    await runOrThrow(buildDeleteCommand(remotePath, { recursive, encoding }), { signal });
    return true;
  }

  async function unlink(remotePath, options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    await runOrThrow(buildUnlinkCommand(remotePath, encoding), { signal });
    return true;
  }

  async function rename(oldPath, newPath, options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    await runOrThrow(buildRenameCommand(oldPath, newPath, encoding), { signal });
    return true;
  }

  async function chmod(remotePath, mode, options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    let modeStr;
    if (typeof mode === "number") {
      modeStr = (mode & 0o7777).toString(8).padStart(3, "0");
    } else {
      modeStr = String(mode);
    }
    await runOrThrow(buildChmodCommand(remotePath, modeStr, encoding), { signal });
    return true;
  }

  /**
   * Decode remote path bytes using the session encoding. When encoding is utf-8
   * (including auto→utf-8 first open), invalid UTF-8 sequences fall back to
   * gb18030 so Chinese $HOME paths open instead of becoming mojibake that then
   * fails to list. Returns the decoded string and the encoding that produced it.
   */
  function decodeRemotePathBytes(raw, encoding = "utf-8") {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || "");
    const enc = String(encoding || "utf-8").toLowerCase();
    if (enc === "gb18030" || enc === "gbk" || enc === "gb2312") {
      try {
        // eslint-disable-next-line global-require
        const iconv = require("iconv-lite");
        return { text: iconv.decode(buf, "gb18030"), encoding: "gb18030" };
      } catch {
        return { text: buf.toString("utf8"), encoding: "utf-8" };
      }
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      return { text, encoding: "utf-8" };
    } catch {
      try {
        // eslint-disable-next-line global-require
        const iconv = require("iconv-lite");
        return { text: iconv.decode(buf, "gb18030"), encoding: "gb18030" };
      } catch {
        return { text: buf.toString("utf8"), encoding: "utf-8" };
      }
    }
  }

  async function homeDir(options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    // Prefer a marker so we know base64 succeeded (raw $HOME may also contain '/').
    const result = await runOrThrow(
      'if command -v base64 >/dev/null 2>&1; then printf "B64:"; printf "%s" "$HOME" | base64 | tr -d "\\r\\n"; '
      + 'elif command -v openssl >/dev/null 2>&1; then printf "B64:"; printf "%s" "$HOME" | openssl base64 | tr -d "\\r\\n"; '
      + 'else printf "RAW:%s" "$HOME"; fi',
      { signal },
    );
    let home = (result.stdout || "").trim();
    let usedEncoding = String(encoding || "utf-8").toLowerCase();
    if (home.startsWith("B64:")) {
      try {
        const raw = Buffer.from(home.slice(4), "base64");
        const decoded = decodeRemotePathBytes(raw, encoding);
        home = decoded.text;
        usedEncoding = decoded.encoding;
      } catch {
        home = "";
      }
    } else if (home.startsWith("RAW:")) {
      home = home.slice(4);
    }
    home = (home || "").trim();
    if (typeof options.onDetectedEncoding === "function" && usedEncoding) {
      try {
        options.onDetectedEncoding(usedEncoding);
      } catch {
        // ignore observer errors
      }
    }
    if (home) return home;
    throw new ScpShellError("Could not determine home directory");
  }

  async function realpath(remotePath, options = {}) {
    const signal = options.signal || null;
    const encoding = options.encoding || "utf-8";
    const result = await runOrThrow(buildRealpathCommand(remotePath || ".", encoding), { signal });
    const abs = (result.stdout || "").trim().split(/\r?\n/)[0];
    if (!abs) throw new ScpShellError("Could not resolve remote path");
    return abs;
  }

  async function readFile(remotePath, options = {}) {
    // Prefer scp -f for binary fidelity; also works when cat is restricted.
    const chunks = [];
    await downloadToWritable(remotePath, {
      write: (buf) => {
        chunks.push(Buffer.from(buf));
      },
      end: () => {},
    }, {
      fileSize: null,
      transfer: options.transfer || null,
      onProgress: null,
      encoding: options.encoding || "utf-8",
      signal: options.signal || null,
      maxBytes: options.maxBytes,
    });
    return Buffer.concat(chunks);
  }

  async function writeFile(remotePath, content, options = {}) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const tmpLocal = options.tempLocalPath;
    if (tmpLocal) {
      await fsModule.promises.writeFile(tmpLocal, buffer);
      try {
        await uploadFile(tmpLocal, remotePath, {
          fileSize: buffer.length,
          transfer: options.transfer || null,
          onProgress: options.onProgress || null,
          mode: options.mode,
          encoding: options.encoding || "utf-8",
          signal: options.signal || null,
        });
      } finally {
        try { await fsModule.promises.unlink(tmpLocal); } catch { /* ignore */ }
      }
      return true;
    }
    // Stream from memory via a temp-less path: write through scp sink using buffer
    await uploadBuffer(buffer, remotePath, {
      transfer: options.transfer || null,
      onProgress: options.onProgress || null,
      mode: options.mode || 0o0644,
      encoding: options.encoding || "utf-8",
      signal: options.signal || null,
    });
    return true;
  }

  async function uploadFile(localPath, remotePath, options = {}) {
    // Always use a fresh size for the SCP wire header so a shrinking/growing
    // file between enqueue and open cannot desync the remote scp -t peer.
    const st = await fsModule.promises.stat(localPath);
    const hasProvidedReadStream = typeof options.openReadStream === "function";
    const fileSize = hasProvidedReadStream ? Number(options.fileSize) : st.size;
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new Error("Verified SCP uploads require a valid file size");
    }
    const mode = options.mode != null ? options.mode : (st.mode & 0o777);
    const transfer = options.transfer || null;
    const onProgress = options.onProgress || null;
    const encoding = options.encoding || "utf-8";
    const signal = options.signal || null;

    const remoteParent = pathModule.posix.dirname(remotePath) || ".";
    const baseName = pathModule.posix.basename(remotePath);
    assertSafeRemotePath(remoteParent === "." ? "." : remoteParent);
    assertSafeRemotePath(remotePath);

    // Ensure parent exists
    if (remoteParent && remoteParent !== ".") {
      await mkdir(remoteParent, { recursive: true, encoding, signal });
    }

    const command = buildScpSinkCommand(remoteParent, encoding);
    const stream = await execStream(command, { signal: options.signal || transfer?.signal || null });
    const abort = () => {
      try { stream.close?.(); } catch { /* ignore */ }
      try { stream.destroy?.(); } catch { /* ignore */ }
    };
    if (transfer) {
      const prev = transfer.abort;
      transfer.abort = () => {
        abort();
        if (typeof prev === "function") prev();
      };
    }

    try {
      // Register for ACK before the remote can reply (and before we write).
      await waitForAck(stream, transfer, signal);

      const control = buildFileControlLine({
        mode,
        size: fileSize,
        name: baseName,
        encoding,
      });
      // Arm ACK before write so a fast remote cannot race; if write fails, swallow
      // the orphaned ACK rejection (stream close would otherwise go unhandled).
      await writeAndWaitAck(stream, control, transfer, signal);

      let transferred = 0;
      // Arm the final ACK listener before the trailing NUL so a fast remote cannot
      // race past waitForAck and hang the upload. Race it with the stream so a
      // mid-stream remote error/cancel does not leave an unhandled rejection.
      const finalAck = waitForAck(stream, transfer, signal);
      let activeReadStream = null;
      let activeReadCompletion = Promise.resolve();
      const streamDone = new Promise((resolve, reject) => {
        const openedReadStream = hasProvidedReadStream
          ? options.openReadStream()
          : fsModule.createReadStream(localPath, { highWaterMark: 256 * 1024 });
        const readStream = openedReadStream?.stream || openedReadStream;
        activeReadCompletion = Promise.resolve(openedReadStream?.completed);
        activeReadStream = readStream;
        if (transfer) transfer.readStream = readStream;

        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          readStream.removeAllListeners();
          if (err) {
            try { readStream.destroy(); } catch { /* ignore */ }
            reject(err);
          } else {
            resolve();
          }
        };

        readStream.on("data", (chunk) => {
          if (transfer?.cancelled || signal?.aborted) {
            finish(new Error("Transfer cancelled"));
            return;
          }
          if (transferred + chunk.length > fileSize) {
            finish(new Error("Verified SCP upload stream exceeded its declared size"));
            return;
          }
          const ok = stream.write(chunk);
          transferred += chunk.length;
          if (typeof onProgress === "function") {
            onProgress(transferred, fileSize);
          }
          if (!ok) {
            readStream.pause();
            stream.once("drain", () => readStream.resume());
          }
        });
        readStream.on("error", finish);
        readStream.on("end", () => {
          if (transferred !== fileSize) {
            finish(new Error(
              `Verified SCP upload stream ended early: expected ${fileSize} bytes, got ${transferred}`,
            ));
            return;
          }
          stream.write(Buffer.from([0x00]));
          finish(null);
        });
        stream.on("error", finish);
      });

      try {
        await Promise.all([streamDone, finalAck]);
      } catch (err) {
        // Whichever side loses first must not leave the other as unhandled rejection,
        // and must stop the local reader (including a drain-paused stream).
        void streamDone.catch(() => {});
        void finalAck.catch(() => {});
        try { activeReadStream?.destroy(); } catch { /* ignore */ }
        await activeReadCompletion.catch(() => {});
        throw err;
      }
      await activeReadCompletion;
      await closeStream(stream);
      if (transfer?.cancelled || signal?.aborted) throw new Error("Transfer cancelled");
      if (typeof onProgress === "function") onProgress(fileSize, fileSize);
      return true;
    } catch (err) {
      abort();
      try { transfer?.readStream?.destroy(); } catch { /* ignore */ }
      throw err;
    }
  }

  async function uploadBuffer(buffer, remotePath, options = {}) {
    const fileSize = buffer.length;
    const mode = options.mode != null ? options.mode : 0o0644;
    const transfer = options.transfer || null;
    const onProgress = options.onProgress || null;
    const remoteParent = pathModule.posix.dirname(remotePath) || ".";
    const baseName = pathModule.posix.basename(remotePath);

    const encoding = options.encoding || "utf-8";
    const signal = options.signal || null;
    if (remoteParent && remoteParent !== ".") {
      await mkdir(remoteParent, { recursive: true, encoding, signal });
    }

    const command = buildScpSinkCommand(remoteParent, encoding);
    const stream = await execStream(command, { signal: signal || transfer?.signal || null });
    const abort = () => {
      try { stream.close?.(); } catch { /* ignore */ }
      try { stream.destroy?.(); } catch { /* ignore */ }
    };
    if (transfer) {
      const prev = transfer.abort;
      transfer.abort = () => {
        abort();
        if (typeof prev === "function") prev();
      };
    }

    try {
      await waitForAck(stream, transfer, signal);
      await writeAndWaitAck(stream, buildFileControlLine({
        mode,
        size: fileSize,
        name: baseName,
        encoding,
      }), transfer, signal);

      const chunkSize = 256 * 1024;
      let offset = 0;
      while (offset < buffer.length) {
        if (transfer?.cancelled || signal?.aborted) throw new Error("Transfer cancelled");
        const end = Math.min(offset + chunkSize, buffer.length);
        await writeAll(stream, buffer.subarray(offset, end));
        offset = end;
        if (typeof onProgress === "function") onProgress(offset, fileSize);
      }
      // Arm final ACK before trailing NUL; swallow orphan if write fails.
      await writeAndWaitAck(stream, Buffer.from([0x00]), transfer, signal);
      await closeStream(stream);
      return true;
    } catch (err) {
      abort();
      throw err;
    }
  }

  async function downloadFile(remotePath, localPath, options = {}) {
    const transfer = options.transfer || null;
    const onProgress = options.onProgress || null;
    let fileSize = Number.isFinite(options.fileSize) ? options.fileSize : null;
    if (fileSize == null) {
      try {
        const st = await stat(remotePath, {
          encoding: options.encoding || "utf-8",
          signal: options.signal || null,
        });
        fileSize = st.size;
      } catch {
        fileSize = 0;
      }
    }

    await fsModule.promises.mkdir(pathModule.dirname(localPath), { recursive: true });
    const writeStream = fsModule.createWriteStream(localPath);
    if (transfer) transfer.writeStream = writeStream;
    // Attach error listener immediately — createWriteStream can emit before we open SCP.
    let earlyWriteError = null;
    const onEarlyWriteError = (err) => {
      earlyWriteError = err || new Error("Local write stream failed");
    };
    writeStream.on("error", onEarlyWriteError);

    try {
      if (earlyWriteError) throw earlyWriteError;
      const downloadResult = await downloadToWritable(remotePath, writeStream, {
        fileSize,
        transfer,
        onProgress,
        encoding: options.encoding || "utf-8",
        signal: options.signal || null,
      });
      if (earlyWriteError) throw earlyWriteError;
      await new Promise((resolve, reject) => {
        writeStream.end((err) => (err ? reject(err) : resolve()));
      });
      return downloadResult;
    } catch (err) {
      try { writeStream.destroy(); } catch { /* ignore */ }
      try { await fsModule.promises.unlink(localPath); } catch { /* ignore */ }
      throw err;
    } finally {
      try { writeStream.removeListener("error", onEarlyWriteError); } catch { /* ignore */ }
    }
  }

  async function downloadToWritable(remotePath, writable, {
    fileSize,
    transfer,
    onProgress,
    encoding = "utf-8",
    signal = null,
    maxBytes = null,
  } = {}) {
    assertSafeRemotePath(remotePath);
    const command = buildScpSourceCommand(remotePath, encoding);
    const stream = await execStream(command, {
      signal: signal || transfer?.signal || null,
    });
    const isCancelled = () => transfer?.cancelled || signal?.aborted;
    let settleDownload = null;
    const abort = () => {
      try { stream.close?.(); } catch { /* ignore */ }
      try { stream.destroy?.(); } catch { /* ignore */ }
    };
    if (transfer) {
      const prev = transfer.abort;
      transfer.abort = () => {
        settleDownload?.(new Error("Transfer cancelled"));
        abort();
        if (typeof prev === "function") prev();
      };
    }

    const parser = createSourceStreamParser({ encoding });
    let transferred = 0;
    let expectedSize = fileSize;
    let gotFile = false;
    const readLimit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : null;
    const createReadLimitError = (actualBytes) => {
      const error = new Error(
        `Remote file is too large to read into memory (${actualBytes} bytes; maximum ${readLimit} bytes). `
        + "Use SFTP download for large files.",
      );
      error.code = "SFTP_READ_TOO_LARGE";
      error.maxBytes = readLimit;
      error.actualBytes = actualBytes;
      return error;
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        settleDownload = null;
        // Explicit untrack before removeAllListeners (which would drop once handlers).
        try { stream.__netcattyUntrack?.(); } catch { /* ignore */ }
        try { stream.__netcattyCleanupAbort?.(); } catch { /* ignore */ }
        stream.removeAllListeners();
        if (err) reject(err);
        else resolve();
      };
      settleDownload = finish;

      let processing = false;
      const queue = [];
      const processQueue = async () => {
        if (processing || settled) return;
        processing = true;
        try {
          while (queue.length > 0 && !settled) {
            if (isCancelled()) {
              finish(new Error("Transfer cancelled"));
              return;
            }
            const chunk = queue.shift();
            try {
              const events = parser.feed(chunk);
              for (const ev of events) {
                if (settled) return;
                if (ev.type === "file-start") {
                  gotFile = true;
                  expectedSize = ev.size;
                  if (readLimit != null && ev.size > readLimit) {
                    finish(createReadLimitError(ev.size));
                    abort();
                    return;
                  }
                  stream.write(buildAck());
                } else if (ev.type === "file-data") {
                  if (readLimit != null && transferred + ev.data.length > readLimit) {
                    finish(createReadLimitError(transferred + ev.data.length));
                    abort();
                    return;
                  }
                  const canContinue = writable.write(ev.data);
                  transferred += ev.data.length;
                  if (typeof onProgress === "function") {
                    onProgress(transferred, expectedSize || transferred);
                  }
                  // Backpressure: wait for drain, or fail if the writable errors.
                  if (canContinue === false) {
                    await new Promise((resolveDrain, rejectDrain) => {
                      const onDrain = () => {
                        cleanup();
                        resolveDrain();
                      };
                      const onWritableError = (err) => {
                        cleanup();
                        rejectDrain(err);
                      };
                      const cleanup = () => {
                        writable.removeListener("drain", onDrain);
                        writable.removeListener("error", onWritableError);
                      };
                      writable.once("drain", onDrain);
                      writable.once("error", onWritableError);
                    });
                  }
                } else if (ev.type === "file-end") {
                  stream.write(buildAck());
                  if (typeof onProgress === "function") {
                    onProgress(transferred, expectedSize || transferred);
                  }
                  finish(null);
                  try { stream.close?.(); } catch { /* ignore */ }
                  return;
                } else if (ev.type === "directory") {
                  stream.write(buildAck());
                } else if (ev.type === "end-directory") {
                  stream.write(buildAck());
                } else if (ev.type === "time") {
                  stream.write(buildAck());
                }
              }
            } catch (err) {
              finish(err);
              return;
            }
          }
        } finally {
          processing = false;
          if (!settled && queue.length > 0) {
            void processQueue();
          } else if (!settled && typeof stream.resume === "function") {
            try { stream.resume(); } catch { /* ignore */ }
          }
        }
      };

      stream.on("data", (chunk) => {
        if (settled) return;
        if (isCancelled()) {
          finish(new Error("Transfer cancelled"));
          return;
        }
        queue.push(Buffer.from(chunk));
        // Pause the remote stream while we apply local backpressure.
        try { stream.pause?.(); } catch { /* ignore */ }
        void processQueue();
      });
      stream.on("error", (err) => {
        if (isCancelled()) {
          finish(new Error("Transfer cancelled"));
          return;
        }
        finish(err);
      });
      if (typeof writable?.on === "function") {
        writable.on("error", (err) => {
          finish(err || new Error("Local write stream failed"));
          try { stream.close?.(); } catch { /* ignore */ }
        });
      }
      stream.on("close", () => {
        if (settled) return;
        // Abort closes the stream; surface cancel rather than protocol incompleteness.
        if (isCancelled()) {
          finish(new Error("Transfer cancelled"));
          return;
        }
        try {
          parser.finish();
        } catch (err) {
          finish(err);
          return;
        }
        if (!gotFile) {
          finish(new ScpProtocolError("SCP source closed without a file"));
          return;
        }
        finish(null);
      });
      stream.stderr?.on?.("data", () => {
        // ignore stderr chatter unless we fail
      });

      // execStream may return a stream that its AbortSignal handler already
      // closed synchronously. Settle from cancellation state instead of
      // depending on a close event that may have happened before listeners.
      if (isCancelled()) {
        finish(new Error("Transfer cancelled"));
        abort();
        return;
      }
      if (stream.__netcattyEarlyError) {
        finish(stream.__netcattyEarlyError);
        return;
      }
      if (
        stream.__netcattyClosed === true
        || stream.closed === true
        || stream.destroyed === true
        || stream.readableEnded === true
      ) {
        finish(new ScpProtocolError("SCP source closed before protocol setup"));
        return;
      }
      void writeAll(stream, buildAck()).then(() => {
        if (isCancelled()) {
          finish(new Error("Transfer cancelled"));
        }
      }, finish);
    });

    if (isCancelled()) throw new Error("Transfer cancelled");
    return { fileSize: expectedSize, transferred };
  }

  /**
   * Write a buffer then wait for the peer ACK. Arms the ACK listener before the
   * write so a fast remote cannot race past waitForAck. If the write fails (or
   * anything throws before the ACK settles), the orphaned ACK rejection is
   * swallowed so process-level unhandledRejection does not fire when the
   * stream later closes under abort().
   */
  async function writeAndWaitAck(stream, buffer, transfer, signal = null) {
    const ack = waitForAck(stream, transfer, signal);
    try {
      await writeAll(stream, buffer);
      await ack;
    } catch (err) {
      void ack.catch(() => {});
      throw err;
    }
  }

  function waitForAck(stream, transfer, signal = null) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let settled = false;
      let poll = null;
      const onData = (chunk) => {
        if (settled) return;
        if (transfer?.cancelled || signal?.aborted) {
          cleanup();
          reject(new Error("Transfer cancelled"));
          return;
        }
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        const result = consumeAck(buf);
        if (result.status === "incomplete") return;
        cleanup();
        if (result.status === "ok") resolve();
        else reject(new ScpProtocolError(result.message || "SCP remote error", result.status));
      };
      const onError = (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      };
      const onClose = () => {
        if (settled) return;
        cleanup();
        if (transfer?.cancelled || signal?.aborted) {
          reject(new Error("Transfer cancelled"));
          return;
        }
        reject(new ScpProtocolError("SCP stream closed while waiting for ACK"));
      };
      const cleanup = () => {
        settled = true;
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        stream.removeListener("data", onData);
        stream.removeListener("error", onError);
        stream.removeListener("close", onClose);
      };
      stream.on("data", onData);
      stream.on("error", onError);
      stream.on("close", onClose);
      // Poll cancel flag so aborts work even when the remote sends no bytes.
      if (transfer || signal) {
        poll = setInterval(() => {
          if (transfer?.cancelled || signal?.aborted) {
            cleanup();
            reject(new Error("Transfer cancelled"));
          }
        }, 25);
        if (typeof poll.unref === "function") poll.unref();
      }
      if (transfer?.cancelled || signal?.aborted) {
        cleanup();
        reject(new Error("Transfer cancelled"));
        return;
      }
      if (stream.__netcattyEarlyError) {
        const earlyError = stream.__netcattyEarlyError;
        cleanup();
        reject(earlyError);
        return;
      }
      if (
        stream.__netcattyClosed === true
        || stream.closed === true
        || stream.destroyed === true
        || stream.readableEnded === true
      ) {
        cleanup();
        reject(new ScpProtocolError("SCP stream closed before waiting for ACK"));
      }
    });
  }

  function writeAll(stream, buffer) {
    return new Promise((resolve, reject) => {
      if (!stream || typeof stream.write !== "function") {
        reject(new Error("Invalid SCP stream"));
        return;
      }
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      try {
        let invokedCallback = false;
        const ok = stream.write(buffer, (err) => {
          invokedCallback = true;
          done(err);
        });
        if (ok === false) {
          stream.once("drain", () => done());
          return;
        }
        // Some mocks ignore the write callback; resolve on next tick if still pending.
        queueMicrotask(() => {
          if (!settled && !invokedCallback) done();
        });
      } catch (err) {
        done(err);
      }
    });
  }

  function closeStream(stream) {
    return new Promise((resolve) => {
      try {
        if (typeof stream.end === "function") {
          stream.end(() => resolve());
          return;
        }
      } catch { /* ignore */ }
      try { stream.close?.(); } catch { /* ignore */ }
      resolve();
    });
  }

  return {
    list,
    stat,
    mkdir,
    remove,
    unlink,
    rename,
    chmod,
    homeDir,
    realpath,
    readFile,
    writeFile,
    uploadFile,
    uploadBuffer,
    downloadFile,
    downloadToWritable,
  };
}

/**
 * Build exec/execStream adapters from an ssh2 Client.
 */
function createSshExecAdapters(sshClient) {
  function exec(command, options = {}) {
    return executeBoundedSshCommand(sshClient, command, {
      signal: options.signal || null,
      openingTimeoutMs: options.openingTimeoutMs,
      runTimeoutMs: options.runTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
  }

  function execStream(command, options = {}) {
    const signal = options.signal || null;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Transfer cancelled"));
        return;
      }
      let settled = false;
      let streamRef = null;
      let openingTimer = null;
      let abortCleaned = false;
      const cleanupAbort = () => {
        if (abortCleaned || !signal) return;
        abortCleaned = true;
        try { signal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
        if (streamRef?.__netcattyCleanupAbort === cleanupAbort) {
          delete streamRef.__netcattyCleanupAbort;
        }
        if (openingTimer) clearTimeout(openingTimer);
        openingTimer = null;
      };
      const onAbort = () => {
        try { streamRef?.close?.(); } catch { /* ignore */ }
        try { streamRef?.destroy?.(); } catch { /* ignore */ }
        cleanupAbort();
        if (!settled) {
          settled = true;
          reject(new Error("Transfer cancelled"));
          if (!streamRef) invalidateSshTransport(sshClient);
        }
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      openingTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        terminateSshExecStream(streamRef);
        reject(new Error("SSH exec channel open timed out after 15000 ms"));
        invalidateSshTransport(sshClient);
      }, 15_000);
      openingTimer.unref?.();
      try {
        sshClient.exec(command, (err, stream) => {
          if (openingTimer) clearTimeout(openingTimer);
          openingTimer = null;
          if (settled) {
            try { stream?.close?.(); } catch { /* ignore */ }
            try { stream?.destroy?.(); } catch { /* ignore */ }
            return;
          }
          if (err) {
            settled = true;
            cleanupAbort();
            reject(err);
            return;
          }
          streamRef = stream;
          // Keep terminal stream state sticky across the async handoff. A close
          // or error can otherwise occur after this promise resolves but before
          // the SCP parser installs its own listeners.
          stream.__netcattyClosed = false;
          stream.__netcattyEarlyError = null;
          stream.on("close", () => {
            stream.__netcattyClosed = true;
          });
          stream.on("error", (streamErr) => {
            stream.__netcattyEarlyError = stream.__netcattyEarlyError || streamErr;
          });
          if (signal) {
            stream.__netcattyCleanupAbort = cleanupAbort;
            stream.on("close", cleanupAbort);
            // AbortSignal does not replay an abort that happened just before the
            // listener was installed. Recheck during the exec handoff.
            if (signal.aborted) {
              cleanupAbort();
              onAbort();
              reject(new Error("Transfer cancelled"));
              return;
            }
          }
          settled = true;
          resolve(stream);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        cleanupAbort();
        reject(err);
      }
    });
  }

  return { exec, execStream };
}

/**
 * Get or create a cached SCP backend for a client object.
 */
function getScpBackendForClient(client) {
  if (!client) throw new Error("SFTP session not found");
  if (client.__netcattyScpBackend) return client.__netcattyScpBackend;
  const sshClient = client.client;
  if (!sshClient || typeof sshClient.exec !== "function") {
    throw new Error("SCP mode requires an SSH session with exec support");
  }
  // Track live exec streams so closeSftp can abort in-flight ops without
  // tearing down a shared terminal SSH socket.
  if (!client.__netcattyScpActiveStreams) {
    client.__netcattyScpActiveStreams = new Set();
  }
  const base = createSshExecAdapters(sshClient);
  const track = (stream) => {
    if (!stream) return stream;
    client.__netcattyScpActiveStreams.add(stream);
    const untrack = () => {
      try { client.__netcattyScpActiveStreams.delete(stream); } catch { /* ignore */ }
    };
    stream.__netcattyUntrack = untrack;
    stream.once?.("close", untrack);
    stream.once?.("end", untrack);
    stream.once?.("error", untrack);
    return stream;
  };
  // Wrap base.exec so shell list/stat/mkdir streams are also abortable on closeSftp.
  const trackedExec = (command, options = {}) => new Promise((resolve, reject) => {
    executeBoundedSshCommand(sshClient, command, {
      signal: options.signal || null,
      openingTimeoutMs: options.openingTimeoutMs,
      runTimeoutMs: options.runTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      onStream: track,
    }).then(resolve, reject);
  });
  const adapters = {
    exec: trackedExec,
    execStream: async (command, options = {}) => {
      const stream = await base.execStream(command, options);
      return track(stream);
    },
  };
  client.__netcattyScpTrackedExec = trackedExec;
  const backend = createScpBackend(adapters);
  client.__netcattyScpBackend = backend;
  return backend;
}

/**
 * Abort all in-flight SCP exec streams for a client without ending the SSH socket.
 * Used when closeSftp is called for session-backed handles (agent Stop/timeout).
 */
function abortScpClientStreams(client) {
  const streams = client?.__netcattyScpActiveStreams;
  if (!streams || typeof streams.forEach !== "function") return;
  for (const stream of [...streams]) {
    try { stream.close?.(); } catch { /* ignore */ }
    try { stream.destroy?.(); } catch { /* ignore */ }
    try { streams.delete(stream); } catch { /* ignore */ }
  }
}

module.exports = {
  createScpBackend,
  createSshExecAdapters,
  createTransferFromAbortSignal,
  getScpBackendForClient,
  abortScpClientStreams,
  isScpModeClient,
  shellQuote,
  modeToPermissionsString,
};
