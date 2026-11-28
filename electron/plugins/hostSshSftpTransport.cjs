"use strict";

const posixPath = require("node:path").posix;
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const schema = require("./generated/plugin-contract.schema.json");

const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);
const SFTP_LIMITS = schema.$defs.VaultHostSftpLimits.const;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function modeToEntryType(mode) {
  const kind = (typeof mode === "number" ? mode : 0) & S_IFMT;
  if (kind === S_IFDIR) return "directory";
  if (kind === S_IFREG) return "file";
  if (kind === S_IFLNK) return "symlink";
  return "other";
}

function assertRemotePath(value) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > SFTP_LIMITS.maxPathBytes || value.includes("\0")) {
    throw fail("invalidArgument", "Remote SFTP path is invalid");
  }
  return value;
}

const MAX_RECURSIVE_DELETE_NODES = 1_000;

function assertSafeDeletePath(value) {
  const p = assertRemotePath(value).trim();
  const normalized = posixPath.normalize(p);
  if (normalized === "/" || normalized === "." || normalized === ".." || normalized === "" || /^~\/?$/u.test(normalized)) {
    throw fail("invalidArgument", "Refusing to delete root or current directory");
  }
  return p;
}

function raceWithCallerSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(fail("cancelled", "SFTP operation was cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(fail("cancelled", "SFTP operation was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

function runWithOperationSignal(signal, timeoutMs, fn) {
  const opController = new AbortController();
  let timedOut = false;
  if (signal?.aborted) {
    return Promise.reject(fail("cancelled", "SFTP operation was cancelled"));
  }
  const onAbort = () => opController.abort(signal?.reason ?? fail("cancelled", "SFTP operation was cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    opController.abort(fail("deadlineExceeded", "SFTP operation timed out"));
  }, timeoutMs);
  timer.unref?.();

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      opController.signal.removeEventListener("abort", onOpAbort);
      if (ok) resolve(value);
      else reject(value);
    };
    const onOpAbort = () => {
      done(false, timedOut
        ? fail("deadlineExceeded", "SFTP operation timed out")
        : fail("cancelled", "SFTP operation was cancelled"));
    };
    opController.signal.addEventListener("abort", onOpAbort, { once: true });
    Promise.resolve()
      .then(() => fn(opController.signal))
      .then((val) => done(true, val), (err) => done(false, err));
  });
}

/**
 * Bounded main-process SFTP adapter sharing `PluginHostSshExecTransport`'s
 * pooled SSH2 connections, App Lock teardown, and binding revocation lifecycle.
 */
class PluginHostSshSftpTransport {
  constructor({ sshExecTransport }) {
    this.sshExecTransport = sshExecTransport;
    /** @type {WeakMap<object, Promise<object>>} ssh2 conn -> sftp subsystem */
    this.sftpByConn = new WeakMap();
  }

  #openSftp(conn, callerSignal) {
    let opening = this.sftpByConn.get(conn);
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (typeof conn?.sftp !== "function") {
          reject(fail("unsupported", "SSH server does not support SFTP"));
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(fail("deadlineExceeded", "Opening SFTP subsystem timed out"));
        }, SFTP_LIMITS.timeoutMs);
        timer.unref?.();

        conn.sftp((err, sftp) => {
          clearTimeout(timer);
          if (settled) {
            // Late open after timeout: close immediately so SFTPWrapper does not leak.
            if (sftp) {
              sftp.on?.("error", () => {});
              try { sftp.end?.(); } catch { /* ignore */ }
            }
            return;
          }
          settled = true;
          if (err || !sftp) {
            reject(fail("unavailable", err?.message || "Failed to open SFTP subsystem"));
            return;
          }
          const evict = () => {
            if (this.sftpByConn.get(conn) === opening) this.sftpByConn.delete(conn);
          };
          sftp.on?.("error", evict);
          sftp.once?.("close", evict);
          sftp.once?.("end", evict);
          resolve(sftp);
        });
      }).catch((err) => {
        if (this.sftpByConn.get(conn) === opening) this.sftpByConn.delete(conn);
        throw err;
      });
      this.sftpByConn.set(conn, opening);
    }
    return raceWithCallerSignal(opening, callerSignal);
  }

  async #withSftp(ctx, operation) {
    const lease = await this.sshExecTransport.acquireConnection(ctx);
    try {
      const sftp = await this.#openSftp(lease.conn, lease.signal);
      return await runWithOperationSignal(lease.signal, SFTP_LIMITS.timeoutMs, (opSignal) => operation(sftp, opSignal));
    } catch (err) {
      if (err instanceof PluginRpcError) throw err;
      if (lease.signal.aborted) throw fail("cancelled", "SFTP operation was cancelled");
      if (err?.code === "ECONNRESET" || err?.code === "EPIPE") lease.invalidate();
      throw fail("unavailable", err?.message ? String(err.message).slice(0, 256) : "SFTP operation failed");
    } finally {
      lease.release();
    }
  }

  listDir(ctx, remotePath) {
    const p = assertRemotePath(remotePath);
    return this.#withSftp(ctx, (sftp) => new Promise((resolve, reject) => {
      sftp.readdir(p, (err, list) => {
        if (err) {
          reject(fail(err.code === 2 ? "notFound" : "unavailable", err.message || "Failed to list directory"));
          return;
        }
        const items = Array.isArray(list) ? list : [];
        const truncated = items.length > SFTP_LIMITS.maxEntries;
        const entries = items.slice(0, SFTP_LIMITS.maxEntries).map((item) => ({
          name: String(item.filename ?? "").slice(0, 1024),
          type: modeToEntryType(item.attrs?.mode),
          size: Math.max(0, Number(item.attrs?.size ?? 0) || 0),
          mtime: Math.max(0, Math.round(Number(item.attrs?.mtime ?? 0) || 0)),
          ...(typeof item.attrs?.mode === "number" ? { mode: item.attrs.mode & 0o7777 } : {}),
        })).filter((entry) => entry.name.length > 0);
        resolve({ path: p, entries, truncated });
      });
    }));
  }

  stat(ctx, remotePath) {
    const p = assertRemotePath(remotePath);
    return this.#withSftp(ctx, (sftp) => new Promise((resolve, reject) => {
      sftp.lstat(p, (err, attrs) => {
        if (err) {
          if (err.code === 2 || /no such file/i.test(String(err.message ?? ""))) {
            resolve({ exists: false });
            return;
          }
          reject(fail("unavailable", err.message || "Failed to stat remote path"));
          return;
        }
        resolve({
          exists: true,
          type: modeToEntryType(attrs?.mode),
          size: Math.max(0, Number(attrs?.size ?? 0) || 0),
          mtime: Math.max(0, Math.round(Number(attrs?.mtime ?? 0) || 0)),
          ...(typeof attrs?.mode === "number" ? { mode: attrs.mode & 0o7777 } : {}),
        });
      });
    }));
  }

  readFile(ctx, { path: remotePath, encoding = "utf8", maxBytes }) {
    const p = assertRemotePath(remotePath);
    const limit = Math.max(1, Math.min(SFTP_LIMITS.maxFileBytes, maxBytes ?? SFTP_LIMITS.maxFileBytes));
    return this.#withSftp(ctx, (sftp, signal) => new Promise((resolve, reject) => {
      const stream = sftp.createReadStream(p, { start: 0, end: limit });
      const chunks = [];
      let total = 0;
      let truncated = false;
      const onAbort = () => {
        try { stream.destroy(); } catch { /* ignore */ }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stream.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (total + buf.length > limit) {
          const remaining = limit - total;
          if (remaining > 0) chunks.push(buf.subarray(0, remaining));
          total = limit;
          truncated = true;
          stream.destroy();
          return;
        }
        chunks.push(buf);
        total += buf.length;
      });
      stream.once("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        if (truncated) {
          const combined = Buffer.concat(chunks, total);
          resolve({
            data: encoding === "base64" ? combined.toString("base64") : combined.toString("utf8"),
            encoding,
            bytes: combined.length,
            truncated: true,
          });
          return;
        }
        reject(fail(err?.code === 2 ? "notFound" : "unavailable", err?.message || "Failed to read remote file"));
      });
      stream.once("close", () => {
        signal.removeEventListener("abort", onAbort);
        if (!truncated) return;
        const combined = Buffer.concat(chunks, total);
        resolve({
          data: encoding === "base64" ? combined.toString("base64") : combined.toString("utf8"),
          encoding,
          bytes: combined.length,
          truncated: true,
        });
      });
      stream.once("end", () => {
        signal.removeEventListener("abort", onAbort);
        const combined = Buffer.concat(chunks, total);
        resolve({
          data: encoding === "base64" ? combined.toString("base64") : combined.toString("utf8"),
          encoding,
          bytes: combined.length,
          truncated,
        });
      });
    }));
  }

  writeFile(ctx, { path: remotePath, data, encoding = "utf8" }) {
    const p = assertRemotePath(remotePath);
    const bytes = encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
    if (bytes.length > SFTP_LIMITS.maxFileBytes) {
      return Promise.reject(fail("resourceExhausted", "Remote SFTP write exceeds 2 MiB limit"));
    }
    return this.#withSftp(ctx, (sftp, signal) => new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(p);
      let finished = false;
      const onAbort = () => {
        try { stream.destroy(new Error("cancelled")); } catch { /* ignore */ }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stream.once("finish", () => {
        finished = true;
      });
      stream.once("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(fail("unavailable", err?.message || "Failed to write remote file"));
      });
      stream.once("close", () => {
        signal.removeEventListener("abort", onAbort);
        if (!finished && !stream.writableFinished) {
          reject(fail("unavailable", "Remote SFTP write closed before completion"));
          return;
        }
        resolve({ bytesWritten: bytes.length });
      });
      stream.end(bytes);
    }));
  }

  mkdir(ctx, remotePath) {
    const p = assertRemotePath(remotePath);
    return this.#withSftp(ctx, (sftp) => new Promise((resolve, reject) => {
      sftp.mkdir(p, (err) => {
        if (err) {
          reject(fail("unavailable", err.message || "Failed to create remote directory"));
          return;
        }
        resolve({ created: true });
      });
    }));
  }

  delete(ctx, { path: remotePath, recursive = false }) {
    const p = assertSafeDeletePath(remotePath);
    return this.#withSftp(ctx, async (sftp, opSignal) => {
      const assertNotAborted = () => {
        if (opSignal.aborted) {
          throw fail("cancelled", "SFTP operation was cancelled");
        }
      };
      const statPath = (target) => new Promise((resolve, reject) => {
        sftp.lstat(target, (err, attrs) => (err ? reject(err) : resolve(attrs)));
      });
      const unlinkPath = (target) => new Promise((resolve, reject) => {
        sftp.unlink(target, (err) => (err ? reject(err) : resolve()));
      });
      const rmdirPath = (target) => new Promise((resolve, reject) => {
        sftp.rmdir(target, (err) => (err ? reject(err) : resolve()));
      });
      const readdirPath = (target) => new Promise((resolve, reject) => {
        sftp.readdir(target, (err, list) => (err ? reject(err) : resolve(list ?? [])));
      });
      let visitedNodes = 0;
      const removeNode = async (target, depth) => {
        assertNotAborted();
        if (depth > 32) throw fail("resourceExhausted", "Recursive SFTP delete exceeded maximum depth");
        if (++visitedNodes > MAX_RECURSIVE_DELETE_NODES) {
          throw fail("resourceExhausted", "Recursive SFTP delete exceeded maximum entry limit");
        }
        const attrs = await statPath(target);
        assertNotAborted();
        if (modeToEntryType(attrs?.mode) !== "directory") {
          await unlinkPath(target);
          return;
        }
        if (recursive) {
          const children = await readdirPath(target);
          for (const child of children) {
            assertNotAborted();
            const name = child?.filename;
            if (!name || name === "." || name === "..") continue;
            await removeNode(posixPath.join(target, name), depth + 1);
          }
        }
        assertNotAborted();
        await rmdirPath(target);
      };
      try {
        await removeNode(p, 0);
        return { deleted: true };
      } catch (err) {
        if (err instanceof PluginRpcError) throw err;
        throw fail(err?.code === 2 ? "notFound" : "unavailable", err?.message || "Failed to delete remote path");
      }
    });
  }
}

module.exports = { PluginHostSshSftpTransport, assertRemotePath, assertSafeDeletePath };
