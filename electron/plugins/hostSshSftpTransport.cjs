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

function assertSafeDeletePath(value) {
  const p = assertRemotePath(value).trim();
  const normalized = posixPath.normalize(p);
  if (normalized === "/" || normalized === "." || normalized === ".." || normalized === "~" || normalized === "") {
    throw fail("invalidArgument", "Refusing to delete root or current directory");
  }
  return p;
}

function raceWithSignal(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(fail("cancelled", "SFTP operation was cancelled"));
      return;
    }
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(fail("cancelled", "SFTP operation was cancelled"));
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      reject(fail("deadlineExceeded", "SFTP operation timed out"));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
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

  #openSftp(conn, signal) {
    const cached = this.sftpByConn.get(conn);
    if (cached) return cached;
    const opening = raceWithSignal(
      new Promise((resolve, reject) => {
        if (typeof conn?.sftp !== "function") {
          reject(fail("unsupported", "SSH server does not support SFTP"));
          return;
        }
        conn.sftp((err, sftp) => {
          if (err || !sftp) {
            reject(fail("unavailable", err?.message || "Failed to open SFTP subsystem"));
            return;
          }
          sftp.once?.("close", () => {
            if (this.sftpByConn.get(conn) === opening) this.sftpByConn.delete(conn);
          });
          sftp.once?.("end", () => {
            if (this.sftpByConn.get(conn) === opening) this.sftpByConn.delete(conn);
          });
          resolve(sftp);
        });
      }),
      signal,
      SFTP_LIMITS.timeoutMs,
    ).catch((err) => {
      if (this.sftpByConn.get(conn) === opening) this.sftpByConn.delete(conn);
      throw err;
    });
    this.sftpByConn.set(conn, opening);
    return opening;
  }

  async #withSftp(ctx, operation) {
    const lease = await this.sshExecTransport.acquireConnection(ctx);
    try {
      const sftp = await this.#openSftp(lease.conn, lease.signal);
      return await raceWithSignal(operation(sftp, lease.signal), lease.signal, SFTP_LIMITS.timeoutMs);
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
      const onAbort = () => {
        try { stream.destroy(new Error("cancelled")); } catch { /* ignore */ }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stream.once("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(fail("unavailable", err?.message || "Failed to write remote file"));
      });
      stream.once("close", () => {
        signal.removeEventListener("abort", onAbort);
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
    return this.#withSftp(ctx, async (sftp) => {
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
      const removeNode = async (target, depth) => {
        if (depth > 32) throw fail("resourceExhausted", "Recursive SFTP delete exceeded maximum depth");
        const attrs = await statPath(target);
        if (modeToEntryType(attrs?.mode) !== "directory") {
          await unlinkPath(target);
          return;
        }
        if (recursive) {
          const children = await readdirPath(target);
          for (const child of children) {
            const name = child?.filename;
            if (!name || name === "." || name === "..") continue;
            await removeNode(posixPath.join(target, name), depth + 1);
          }
        }
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
