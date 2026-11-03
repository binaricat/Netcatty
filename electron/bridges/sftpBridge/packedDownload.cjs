"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { createGunzip } = require("node:zlib");
const { shellQuotePath } = require("./scpShell.cjs");
const { safeSend } = require("../ipcUtils.cjs");

const OPEN_TIMEOUT = 15_000;
const IDLE_TIMEOUT = 120_000;
const MAX_ENTRIES = 1_000_000;
const unsupported = () => ({ status: "fallback", reason: "unsupported" });
const conflict = () => ({ status: "fallback", reason: "conflict" });
const active = new Map();

// Packed transfers lease their connection before waiting for a renderer queue
// slot. Observe the real WebContents in main, since worker senders have no
// lifecycle events and renderer finally blocks do not run after a crash/reload.
function createRendererLeaseHandlers({ retain, release, cancel }) {
  const owners = new Map();
  const keyFor = (payload) => JSON.stringify([payload?.sftpId, payload?.leaseId]);
  const detach = (owner) => {
    owner.sender.removeListener("destroyed", owner.onGone);
    owner.sender.removeListener("render-process-gone", owner.onGone);
    owner.sender.removeListener("did-start-navigation", owner.onNavigation);
    if (owners.get(owner.sender.id) === owner) owners.delete(owner.sender.id);
  };
  const forget = (owner, key) => {
    owner?.leases.delete(key);
    if (owner && owner.leases.size === 0) detach(owner);
  };
  return {
    async retain(event, payload) {
      const sender = event?.sender;
      if (payload?.cancelOnOwnerGone !== true || typeof sender?.on !== "function") return retain(event, payload);
      if (sender.isDestroyed?.()) return { success: false, reason: "Download window is no longer available" };
      let owner = owners.get(sender.id);
      if (!owner) {
        owner = { sender, leases: new Map(), gone: false };
        owner.onGone = () => {
          if (owner.gone) return;
          owner.gone = true;
          detach(owner);
          for (const entry of owner.leases.values()) {
            void entry.pending.then(async (result) => {
              if (!result?.success) return;
              try { await cancel(entry.event, entry.payload); }
              finally { await release(entry.event, entry.payload); }
            }).catch(() => {});
          }
          owner.leases.clear();
        };
        owner.onNavigation = (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace) owner.onGone();
        };
        owners.set(sender.id, owner);
        sender.once("destroyed", owner.onGone);
        sender.once("render-process-gone", owner.onGone);
        sender.on("did-start-navigation", owner.onNavigation);
      }
      const key = keyFor(payload);
      const pending = owner.leases.get(key)?.pending || Promise.resolve().then(() => retain(event, payload));
      owner.leases.set(key, { event, payload, pending });
      try {
        const result = await pending;
        if (!result?.success) forget(owner, key);
        return owner.gone ? { success: false, reason: "Download window is no longer available" } : result;
      } catch (error) { forget(owner, key); throw error; }
    },
    release(event, payload) {
      forget(owners.get(event?.sender?.id), keyFor(payload));
      return release(event, payload);
    },
  };
}

const PROBE = [
  "if tar -czf - -C /dev ./null >/dev/null 2>&1; then printf NC_PACK_GZIP;",
  "elif tar -cf - -C /dev ./null >/dev/null 2>&1; then printf NC_PACK_TAR;",
  "else printf NC_PACK_UNSUPPORTED; fi",
].join(" ");

function validateName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\/\\\x00-\x1f\ufffd]/u.test(name)) {
    throw new Error("Invalid archive path component");
  }
  if (process.platform === "win32" && (/[<>:"|?*]|[ .]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) {
    throw new Error("Cannot represent archive path on this filesystem");
  }
}

function archivePath(rawPath, names) {
  if (typeof rawPath !== "string" || rawPath.length > 16384) throw new Error("Invalid archive path");
  const relative = rawPath.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
  const parts = relative.split("/");
  parts.forEach(validateName);
  if (!names.has(parts[0])) throw new Error("Unexpected path outside the downloaded selection");
  return relative;
}

async function statIfPresent(file) {
  try { return await fsp.lstat(file); } catch (e) { if (e.code !== "ENOENT") throw e; return null; }
}

function cancelActive(transferId, senderId) {
  const operation = active.get(transferId);
  if (!operation || (senderId != null && operation.senderId != null && senderId !== operation.senderId)) return false;
  operation.controller.abort();
  return true;
}

function closeChannel(stream) {
  stream?.on("error", () => {});
  stream?.stderr?.on("error", () => {});
  try { stream?.close(); } catch { /* channel already gone */ }
  try { stream?.destroy(); } catch { /* transport already gone */ }
}

async function openChannel(ssh, command, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Timed out opening archive channel")), OPEN_TIMEOUT);
    const onAbort = () => finish(signal.reason);
    function finish(error, channel) {
      if (finished) { if (channel) closeChannel(channel); return; }
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve(channel);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try { ssh.exec(command, (error, channel) => finish(error, channel)); } catch (error) { finish(error); }
  });
}

// Keep stderr out of the binary stream. Both an intact stream AND explicit SSH
// exit status are required, so a disconnected transport cannot publish a prefix.
async function receive(ssh, command, file, signal, report) {
  const stream = await openChannel(ssh, command, signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let stderr = "", bytes = 0, lastUpdate = 0, exitCode;
  const idle = setTimeout(() => controller.abort(new Error("Timed out receiving packed download")), IDLE_TIMEOUT);
  stream.stderr?.on("data", data => { stderr = (stderr + data.toString()).slice(-2048); });
  stream.stderr?.on("error", e => controller.abort(e));
  const status = new Promise((resolve, reject) => {
    stream.once("exit", code => { exitCode = code; });
    stream.once("error", reject);
    stream.once("close", code => {
      const result = code ?? exitCode;
      if (result === 0) resolve();
      else reject(new Error("Remote tar did not complete" + (stderr.trim() ? ": " + stderr.trim() : "")));
    });
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    if (controller.signal.aborted) reject(controller.signal.reason);
  });
  const meter = new Transform({ transform(chunk, _enc, cb) {
    idle.refresh();
    bytes += chunk.length;
    if (Date.now() - lastUpdate >= 180) { report("receiving", bytes); lastUpdate = Date.now(); }
    cb(null, chunk);
  } });
  const copy = pipeline(stream, meter, fs.createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
  try {
    await Promise.all([copy, status]);
    return bytes;
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    controller.abort(reason);
    closeChannel(stream);
    await Promise.allSettled([copy, status]);
    throw reason;
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", onAbort);
  }
}

async function extractArchive(file, stage, gzip, selectedNames, signal) {
  const extractor = require("tar-stream").extract();
  const names = new Set(selectedNames);
  const entries = new Map();
  let requiresRegularDownload = false;
  const manifest = selectedNames.length > 1 ? new Map() : null;
  const processing = (async () => {
    for await (const entry of extractor) {
      signal.throwIfAborted();
      const header = entry.header;
      const relative = archivePath(header.name, names);
      const parent = path.posix.dirname(relative);
      if (entries.has(relative) || (parent !== "." && entries.get(parent) !== "directory")) {
        throw new Error("Duplicate archive entry or unsafe parent: " + relative);
      }
      if (entries.size >= MAX_ENTRIES || !Number.isSafeInteger(header.size) || header.size < 0) {
        throw new Error("Packed download exceeds supported archive limits");
      }
      const dest = path.join(stage, relative);
      if (header.type === "file" || header.type === "contiguous-file") {
        await pipeline(entry, fs.createWriteStream(dest, { flags: "wx", mode: 0o600 | (header.mode & 0o177) }), { signal });
        if (header.mtime instanceof Date && Number.isFinite(+header.mtime)) {
          // Some target filesystems reject valid but out-of-range remote dates.
          await fsp.utimes(dest, header.mtime, header.mtime).catch(() => {});
        }
        const stat = await fsp.lstat(dest);
        if (stat.size !== header.size) throw new Error("Incomplete archived file: " + relative);
        manifest?.set(relative, stat);
        entries.set(relative, "file");
      } else {
        if (header.size !== 0) throw new Error("Invalid non-file archive entry");
        if (header.type === "directory") {
          await fsp.mkdir(dest, { mode: 0o700 }); // exclusive; catches case/Unicode aliases on this filesystem
        } else if (header.type === "link") {
          const target = archivePath(header.linkname, names);
          if (entries.get(target) !== "file") throw new Error("Unsafe hard link in packed download: " + relative);
          await fsp.link(path.join(stage, target), dest);
        } else if (header.type === "symlink") {
          const link = header.linkname;
          if (typeof link !== "string" || !link || path.posix.isAbsolute(link) || /^[a-z]:/i.test(link) || /[\\\x00-\x1f]/u.test(link)
              || !names.has(path.posix.join(parent, link).split("/")[0])) {
            throw new Error("Unsafe symbolic link in packed download: " + relative);
          }
          if (link.split("/").includes("..")) {
            // A relative parent link can be valid in a normal directory tree,
            // but resolving symlink chains safely is outside this extractor.
            // Validate the REST of the archive before allowing ordinary SFTP
            // fallback; corrupt/truncated archives must still be hard errors.
            requiresRegularDownload = true;
            entries.set(relative, "symlink");
            entry.resume();
            continue;
          }
          await fsp.symlink(link, dest);
        } else throw new Error("Unsupported special file in packed download: " + relative);
        if (manifest) manifest.set(relative, await fsp.lstat(dest));
        entries.set(relative, header.type === "link" ? "file" : header.type);
        entry.resume();
      }
    }
  })();
  // Require the two terminal zero blocks, in addition to tar header checksums
  // and gzip's CRC. A channel exit code alone does not prove completeness.
  let size = 0, tail = Buffer.alloc(0);
  const trailer = new Transform({ transform(chunk, _enc, cb) {
    size += chunk.length;
    tail = chunk.length >= 1024 ? Buffer.from(chunk.subarray(-1024)) : Buffer.concat([tail, chunk]).subarray(-1024);
    cb(null, chunk);
  } });
  const streams = [fs.createReadStream(file), ...(gzip ? [createGunzip()] : []), trailer, extractor];
  const parsing = pipeline(...streams, { signal });
  try { await Promise.all([processing, parsing]); } catch (error) {
    extractor.destroy(error);
    await Promise.allSettled([processing, parsing]);
    throw error;
  }
  if (size % 512 || tail.length !== 1024 || tail.some(v => v !== 0) || selectedNames.some(n => !entries.has(n))) {
    throw new Error("Incomplete packed download");
  }
  if (requiresRegularDownload) {
    const error = new Error("Packed download contains links requiring ordinary SFTP transfer");
    error.code = "PACKED_DOWNLOAD_UNSUPPORTED";
    throw error;
  }
  return manifest;
}

function sameInode(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino;
}

async function undoPromotion(destination, name, manifest) {
  // Only undo entries we actually installed. Never move a published tree
  // back to staging and rm -r it: another app may already have added files.
  const removable = [];
  const directories = new Set(["."]);
  for (const [relative, expected] of manifest || []) {
    if (relative !== name && !relative.startsWith(name + "/")) continue;
    if (!directories.has(path.posix.dirname(relative))) continue;
    const full = path.join(destination, relative), actual = await statIfPresent(full);
    if (!sameInode(actual, expected)) continue;
    if (actual.isDirectory()) directories.add(relative);
    else if (actual.mtimeMs !== expected.mtimeMs || actual.size !== expected.size) continue;
    removable.push({ full, expected });
  }
  for (const { full, expected } of removable.reverse()) {
    const actual = await statIfPresent(full);
    if (!sameInode(actual, expected)) continue;
    if (actual.isDirectory()) {
      try { await fsp.rmdir(full); } catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
    } else if (actual.mtimeMs === expected.mtimeMs && actual.size === expected.size) await fsp.unlink(full);
  }
}

async function publish(stage, destination, names, signal, manifest) {
  const published = [];
  try {
    // First reserve ALL names exclusively. A competing transfer cannot take
    // over this selection between preflight and publication.
    for (const name of names) {
      signal.throwIfAborted();
      const from = path.join(stage, name), to = path.join(destination, name);
      const source = await fsp.lstat(from);
      if (source.isDirectory()) {
        await fsp.mkdir(to, { mode: 0o700 });
        published.push({ from, to, name, directory: true, reserved: await fsp.lstat(to) });
      } else {
        await fsp.link(from, to); // atomic no-clobber, even for a dangling symlink
        published.push({ from, to, reserved: source });
      }
    }
    signal.throwIfAborted();
    // Already staged and validated. Finish this short commit even if the user
    // cancels concurrently; never report a successful publication as cancelled.
    for (const item of published.filter(item => item.directory)) {
      const actual = await fsp.lstat(item.to);
      if (actual.dev !== item.reserved.dev || actual.ino !== item.reserved.ino) {
        throw new Error("Download target changed before publication");
      }
      await fsp.rename(item.from, item.to); // POSIX replaces only an empty directory
      item.promoted = true;
    }
  } catch (e) {
    for (const item of published.reverse()) {
      if (item.promoted) {
        await undoPromotion(destination, item.name, manifest);
      } else {
        const actual = await statIfPresent(item.to);
        if (actual && actual.dev === item.reserved.dev && actual.ino === item.reserved.ino) {
          if (item.directory) {
            try { await fsp.rmdir(item.to); } catch (err) { if (err.code !== "ENOTEMPTY") throw err; }
          } else if (actual.size === item.reserved.size && actual.mtimeMs === item.reserved.mtimeMs) await fsp.unlink(item.to);
        }
      }
    }
    if (e.code === "EEXIST" || e.code === "ENOTEMPTY") return conflict();
    if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(e.code)) return unsupported();
    throw e;
  }
  return { status: "completed" };
}

async function downloadPacked({ client, payload, encoding, execProbe, event }) {
  const { transferId, names, localDirectory, remoteDirectory } = payload;
  if (typeof transferId !== "string" || !transferId || active.has(transferId)) throw new Error("Invalid packed download ID");
  if (!Array.isArray(names) || names.length === 0 || names.some(name =>
    typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0") ||
    (process.platform === "win32" && name.includes("\\")))) throw new Error("Invalid packed download selection");
  if (new Set(names).size !== names.length || !path.isAbsolute(localDirectory) || !path.posix.isAbsolute(remoteDirectory)) {
    throw new Error("Invalid packed download paths");
  }
  const controller = new AbortController(), { signal } = controller;
  active.set(transferId, { controller, senderId: event?.sender?.id, sftpId: payload.sftpId });
  let temp;
  try {
    const destination = await fsp.realpath(localDirectory);
    for (const name of names) if (await statIfPresent(path.join(destination, name))) return conflict();
    signal.throwIfAborted();
    if (names.length > 1000 || names.some(name => /[\\\x00-\x1f\ufffd]/u.test(name)) || /[\x00-\x1f]/u.test(remoteDirectory)) return unsupported();
    const ssh = client?.client;
    if (!client) throw new Error("SFTP session not found");
    if (process.platform === "win32" || typeof ssh?.exec !== "function" || client.__netcattySingleChannelSsh || ssh.__netcattySingleChannelSsh
        || client.__netcattySudoMode || encoding !== "utf-8") return unsupported();
    let mode;
    try {
      const result = await execProbe(ssh, PROBE, { signal, openingTimeoutMs: OPEN_TIMEOUT, runTimeoutMs: 10_000, maxOutputBytes: 2048 });
      mode = result.stdout;
    } catch (e) {
      signal.throwIfAborted();
      if (/exec.*(fail|deni|unavailable|prohibit)|unable to exec|administratively prohibited|not permitted|only.*sftp|remote command failed/i.test(e.message)) return unsupported();
      throw e;
    }
    if (mode !== "NC_PACK_GZIP" && mode !== "NC_PACK_TAR") return unsupported();
    signal.throwIfAborted();
    temp = await fsp.mkdtemp(path.join(destination, ".netcatty-download-"));
    const archive = path.join(temp, "archive"), stage = path.join(temp, "contents");
    await fsp.mkdir(stage, { mode: 0o700 });
    const gzip = mode === "NC_PACK_GZIP";
    const command = "cd " + shellQuotePath(remoteDirectory, encoding) + " && export COPYFILE_DISABLE=1 && exec tar " + (gzip ? "-czf -" : "-cf -")
      + " " + names.map(n => shellQuotePath("./" + n, encoding)).join(" ");
    const report = (phase, bytes) => {
      safeSend(event?.sender, "netcatty:sftp:packedProgress", { transferId, phase, bytes });
    };
    report("receiving", 0);
    const bytes = await receive(ssh, command, archive, signal, report);
    report("extracting", bytes);
    const manifest = await extractArchive(archive, stage, gzip, names, signal);
    return await publish(stage, destination, names, signal, manifest);
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    if (error.code === "PACKED_DOWNLOAD_UNSUPPORTED") return unsupported();
    throw error;
  } finally {
    active.delete(transferId);
    if (temp) await fsp.rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

function cancelSession(sftpId) {
  for (const operation of active.values()) if (operation.sftpId === sftpId) operation.controller.abort();
}

module.exports = { downloadPacked, cancelActive, cancelSession, extractArchive, publish, createRendererLeaseHandlers };
