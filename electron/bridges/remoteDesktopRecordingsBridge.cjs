"use strict";

/**
 * Remote Desktop Session Recordings Bridge (`.webm`).
 *
 * Streams MediaRecorder chunks directly to `<userData>/recordings/<uuid>.webm.part`
 * (mode 0o600), patches EBML Info.Duration on finalize, atomically renames to
 * `<uuid>.webm`, serves zero-RAM HTTP 206 Range streams over the privileged
 * `netcatty-media://` protocol with a per-launch secret token, and handles
 * export, cascade delete, quota/retention GC (protecting saved/bookmarked logs),
 * and crash/shutdown cleanup.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const RECORDING_MEDIA_SCHEME = "netcatty-media";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_PART_AGE_MS = 5 * 60 * 1000;
const MAX_THUMBNAIL_BYTES = 256 * 1024;
const WRITER_CLOSE_TIMEOUT_MS = 3000;

function isValidRecordingId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function sanitizeExportFileName(rawName, fallbackId) {
  const base = typeof rawName === "string" && rawName.trim()
    ? path.basename(rawName.trim())
    : `recording-${fallbackId}.webm`;
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/^\.+/, "");
  const name = cleaned || `recording-${fallbackId}.webm`;
  return name.toLowerCase().endsWith(".webm") ? name : `${name}.webm`;
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

/**
 * Parse a single HTTP `Range: bytes=...` header against `totalSize`.
 * Returns `{ ok: true, start, end }`, `{ ok: false, unsatisfied: true }`, or `null` if no Range header.
 */
function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader || typeof rangeHeader !== "string") return null;
  const trimmed = rangeHeader.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) return { ok: false, unsatisfied: true };

  if (totalSize <= 0) {
    return { ok: false, unsatisfied: true };
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return { ok: false, unsatisfied: true };
  }

  let start;
  let end;
  if (rawStart === "") {
    // Suffix byte range: `bytes=-500`
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { ok: false, unsatisfied: true };
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? totalSize - 1 : Number(rawEnd);
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || start >= totalSize
      || end < start
    ) {
      return { ok: false, unsatisfied: true };
    }
    if (end >= totalSize) {
      end = totalSize - 1;
    }
  }

  return { ok: true, start, end };
}

function createRemoteDesktopRecordingsBridge(options = {}) {
  const {
    recordingsDir: explicitDir,
    getUserDataDir,
    dialog,
    shell,
    BrowserWindow,
    launchToken = crypto.randomBytes(24).toString("hex"),
  } = options;

  const activeWriters = new Map();

  function getRecordingsDir() {
    if (typeof explicitDir === "string" && explicitDir) {
      return explicitDir;
    }
    const base = typeof getUserDataDir === "function" ? getUserDataDir() : null;
    if (!base) {
      throw new Error("Recordings directory is not configured");
    }
    return path.join(base, "recordings");
  }

  async function ensureRecordingsDir() {
    const dir = getRecordingsDir();
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function resolveRecordingPaths(recordingId) {
    if (!isValidRecordingId(recordingId)) {
      throw new Error("Invalid recordingId");
    }
    const dir = path.resolve(getRecordingsDir());
    const finalPath = path.resolve(dir, `${recordingId}.webm`);
    const partPath = path.resolve(dir, `${recordingId}.webm.part`);
    const thumbPath = path.resolve(dir, `${recordingId}.jpg`);
    const thumbPartPath = path.resolve(dir, `${recordingId}.jpg.part`);
    if (
      !finalPath.startsWith(`${dir}${path.sep}`)
      || !partPath.startsWith(`${dir}${path.sep}`)
      || !thumbPath.startsWith(`${dir}${path.sep}`)
      || !thumbPartPath.startsWith(`${dir}${path.sep}`)
    ) {
      throw new Error("Invalid recording path");
    }
    return { dir, finalPath, partPath, thumbPath, thumbPartPath };
  }

  function buildPlaybackUrl(recordingId) {
    return `${RECORDING_MEDIA_SCHEME}://recording/${recordingId}?token=${launchToken}`;
  }

  function buildThumbnailUrl(id) {
    return `${RECORDING_MEDIA_SCHEME}://thumbnail/${id}?token=${launchToken}`;
  }

  async function closeWriterStream(writer) {
    if (!writer) return;
    if (writer.closePromise) {
      return writer.closePromise;
    }
    writer.closed = true;
    writer.closePromise = (async () => {
      await writer.writeChain.catch(() => {});
      const stream = writer.stream;
      if (!stream || stream.destroyed || stream.writableFinished) return;
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stream.removeListener("finish", done);
          stream.removeListener("close", done);
          stream.removeListener("error", done);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            stream.destroy();
          } catch {
            // ignore
          }
          done();
        }, WRITER_CLOSE_TIMEOUT_MS);
        stream.once("finish", done);
        stream.once("close", done);
        stream.once("error", done);
        try {
          stream.end();
        } catch {
          done();
        }
      });
    })();
    return writer.closePromise;
  }

  async function begin(payload = {}) {
    await ensureRecordingsDir();
    const recordingId = crypto.randomUUID();
    const { partPath, finalPath } = resolveRecordingPaths(recordingId);
    const stream = fs.createWriteStream(partPath, { flags: "w", mode: 0o600 });

    const writer = {
      recordingId,
      mimeType: typeof payload.mimeType === "string" ? payload.mimeType : "video/webm",
      hostLabel: typeof payload.hostLabel === "string" ? payload.hostLabel : "",
      protocol: payload.protocol === "vnc" ? "vnc" : "rdp",
      partPath,
      finalPath,
      stream,
      bytesWritten: 0,
      writeChain: Promise.resolve(),
      closed: false,
      error: null,
    };

    stream.on("error", (err) => {
      writer.error = err;
    });

    activeWriters.set(recordingId, writer);
    return { recordingId };
  }

  async function append(payload = {}) {
    const { recordingId, chunk } = payload || {};
    if (!isValidRecordingId(recordingId)) {
      throw new Error("Invalid recordingId");
    }
    const writer = activeWriters.get(recordingId);
    if (!writer || writer.closed) {
      throw new Error("Recording session is not active");
    }
    if (writer.error) {
      throw writer.error;
    }
    const buf = toBuffer(chunk);
    if (!buf) {
      throw new Error("Invalid recording chunk");
    }
    if (buf.length === 0) {
      return { bytesWritten: writer.bytesWritten };
    }

    const writePromise = writer.writeChain.then(() => new Promise((resolve, reject) => {
      if (writer.closed) {
        reject(new Error("Recording session already closed"));
        return;
      }
      if (writer.error) {
        reject(writer.error);
        return;
      }
      const onError = (err) => {
        writer.error = err;
        reject(err);
      };
      writer.stream.once("error", onError);
      const ok = writer.stream.write(buf, (err) => {
        writer.stream.removeListener("error", onError);
        if (err) {
          writer.error = err;
          reject(err);
          return;
        }
        writer.bytesWritten += buf.length;
        resolve(writer.bytesWritten);
      });
      if (!ok) {
        // Backpressure is naturally respected because the write callback runs once flushed.
      }
    }));

    writer.writeChain = writePromise.catch(() => {});
    const bytesWritten = await writePromise;
    return { bytesWritten };
  }

  async function finish(payload = {}) {
    const {
      recordingId,
      durationMs = 0,
      maxBytes,
      retentionDays,
      protectedIds,
    } = payload || {};
    if (!isValidRecordingId(recordingId)) {
      throw new Error("Invalid recordingId");
    }
    const writer = activeWriters.get(recordingId);
    if (!writer) {
      throw new Error("Recording session not found");
    }

    try {
      await closeWriterStream(writer);
      if (writer.error) {
        throw writer.error;
      }

      const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0
        ? Math.round(durationMs)
        : 0;

      if (safeDurationMs > 0) {
        try {
          const { patchWebmDurationFile } = require("./webmDurationPatch.cjs");
          await patchWebmDurationFile(writer.partPath, safeDurationMs);
        } catch (err) {
          console.warn("[Recordings] EBML duration patch skipped:", err?.message || err);
        }
      }

      await fs.promises.rename(writer.partPath, writer.finalPath);
      const stat = await fs.promises.stat(writer.finalPath);

      const mergedProtected = Array.isArray(protectedIds)
        ? [...new Set([...protectedIds, recordingId])]
        : [recordingId];

      if ((typeof maxBytes === "number" && maxBytes > 0) || (typeof retentionDays === "number" && retentionDays > 0)) {
        await runGc({
          maxBytes,
          retentionDays,
          protectedIds: mergedProtected,
        }).catch(() => {});
      }

      return {
        recordingId,
        bytes: stat.size,
        durationMs: safeDurationMs,
        playbackUrl: buildPlaybackUrl(recordingId),
      };
    } catch (err) {
      const { thumbPath, thumbPartPath } = resolveRecordingPaths(recordingId);
      await Promise.all([
        fs.promises.unlink(writer.partPath).catch(() => {}),
        fs.promises.unlink(thumbPath).catch(() => {}),
        fs.promises.unlink(thumbPartPath).catch(() => {}),
      ]);
      throw err;
    } finally {
      activeWriters.delete(recordingId);
    }
  }

  async function abort(payload = {}) {
    const { recordingId } = payload || {};
    if (!isValidRecordingId(recordingId)) {
      return { ok: false };
    }
    const writer = activeWriters.get(recordingId);
    const { partPath, thumbPath, thumbPartPath } = resolveRecordingPaths(recordingId);
    if (writer) {
      activeWriters.delete(recordingId);
      await closeWriterStream(writer);
    }
    await Promise.all([
      fs.promises.unlink(partPath).catch(() => {}),
      fs.promises.unlink(thumbPath).catch(() => {}),
      fs.promises.unlink(thumbPartPath).catch(() => {}),
    ]);
    return { ok: true };
  }

  async function getPlaybackUrl(payload = {}) {
    const { recordingId } = payload || {};
    if (!isValidRecordingId(recordingId)) {
      return { url: null, exists: false };
    }
    const { finalPath } = resolveRecordingPaths(recordingId);
    try {
      const stat = await fs.promises.stat(finalPath);
      if (!stat.isFile()) {
        return { url: null, exists: false };
      }
      return {
        url: buildPlaybackUrl(recordingId),
        exists: true,
        bytes: stat.size,
      };
    } catch {
      return { url: null, exists: false };
    }
  }

  async function saveThumbnail(payload = {}) {
    const { id: rawId, data } = payload || {};
    const id = typeof rawId === "string" && rawId.length > 0 ? rawId : crypto.randomUUID();
    if (!isValidRecordingId(id)) {
      throw new Error("Invalid thumbnail id");
    }
    const buf = toBuffer(data);
    if (!buf || buf.length === 0 || buf.length > MAX_THUMBNAIL_BYTES) {
      throw new Error("Invalid or oversized thumbnail payload");
    }
    await ensureRecordingsDir();
    const { thumbPath, thumbPartPath } = resolveRecordingPaths(id);
    try {
      await fs.promises.writeFile(thumbPartPath, buf, { mode: 0o600 });
      await fs.promises.rename(thumbPartPath, thumbPath);
      return {
        ok: true,
        id,
        url: buildThumbnailUrl(id),
        bytes: buf.length,
      };
    } catch (err) {
      await fs.promises.unlink(thumbPartPath).catch(() => {});
      throw err;
    }
  }

  async function getThumbnailUrl(payload = {}) {
    const { id } = payload || {};
    if (!isValidRecordingId(id)) {
      return { url: null, exists: false };
    }
    const { thumbPath } = resolveRecordingPaths(id);
    try {
      const stat = await fs.promises.stat(thumbPath);
      if (!stat.isFile()) {
        return { url: null, exists: false };
      }
      return {
        url: buildThumbnailUrl(id),
        exists: true,
        bytes: stat.size,
      };
    } catch {
      return { url: null, exists: false };
    }
  }

  async function exportRecording(event, payload = {}) {
    const { recordingId, defaultFileName } = payload || {};
    if (!isValidRecordingId(recordingId)) {
      throw new Error("Invalid recordingId");
    }
    const { finalPath } = resolveRecordingPaths(recordingId);
    const stat = await fs.promises.stat(finalPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error("Recording file not found");
    }
    if (!dialog?.showSaveDialog) {
      throw new Error("Save dialog is unavailable");
    }
    const owner = event?.sender && BrowserWindow?.fromWebContents
      ? BrowserWindow.fromWebContents(event.sender)
      : undefined;
    const safeName = sanitizeExportFileName(defaultFileName, recordingId);
    const result = await dialog.showSaveDialog(owner || undefined, {
      title: "Export Session Recording",
      defaultPath: safeName,
      filters: [{ name: "WebM Video", extensions: ["webm"] }],
    });
    if (result.canceled || !result.filePath) {
      return { saved: false };
    }
    await fs.promises.copyFile(finalPath, result.filePath);
    return { saved: true, filePath: result.filePath };
  }

  async function deleteRecording(payload = {}) {
    const { recordingId } = payload || {};
    if (!isValidRecordingId(recordingId)) {
      return { ok: false };
    }
    const writer = activeWriters.get(recordingId);
    if (writer) {
      activeWriters.delete(recordingId);
      await closeWriterStream(writer);
    }
    const { finalPath, partPath, thumbPath, thumbPartPath } = resolveRecordingPaths(recordingId);
    let removed = false;
    for (const target of [finalPath, partPath, thumbPath, thumbPartPath]) {
      try {
        await fs.promises.unlink(target);
        removed = true;
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
    return { ok: removed };
  }

  async function deleteMany(payload = {}) {
    const ids = Array.isArray(payload?.recordingIds) ? payload.recordingIds : [];
    let deleted = 0;
    for (const recordingId of ids) {
      if (!isValidRecordingId(recordingId)) continue;
      const res = await deleteRecording({ recordingId }).catch(() => ({ ok: false }));
      if (res.ok) deleted += 1;
    }
    return { deleted };
  }

  async function clearAll(payload = {}) {
    const protectedSet = new Set(
      (Array.isArray(payload?.protectedIds) ? payload.protectedIds : [])
        .filter(isValidRecordingId),
    );
    const dir = getRecordingsDir();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return { deleted: 0 };
      throw err;
    }

    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      let id = null;
      let isRecordingFile = false;
      if (name.endsWith(".webm")) {
        id = name.slice(0, -".webm".length);
        isRecordingFile = true;
      } else if (name.endsWith(".webm.part")) {
        id = name.slice(0, -".webm.part".length);
        isRecordingFile = true;
      } else if (name.endsWith(".jpg")) {
        id = name.slice(0, -".jpg".length);
      } else if (name.endsWith(".jpg.part")) {
        id = name.slice(0, -".jpg.part".length);
      } else {
        continue;
      }
      if (!isValidRecordingId(id)) continue;
      if (activeWriters.has(id) || protectedSet.has(id)) continue;
      try {
        await fs.promises.unlink(path.join(dir, name));
        if (isRecordingFile) deleted += 1;
      } catch {
        // ignore individual file delete failure
      }
    }
    return { deleted };
  }

  async function getStats() {
    const dirPath = getRecordingsDir();
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { count: 0, totalBytes: 0, dirPath };
      }
      throw err;
    }
    let count = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isWebm = entry.name.endsWith(".webm");
      const isThumb = entry.name.endsWith(".jpg");
      if (!isWebm && !isThumb) continue;
      const id = isWebm
        ? entry.name.slice(0, -".webm".length)
        : entry.name.slice(0, -".jpg".length);
      if (!isValidRecordingId(id)) continue;
      try {
        const stat = await fs.promises.stat(path.join(dirPath, entry.name));
        if (stat.isFile()) {
          if (isWebm) count += 1;
          totalBytes += stat.size;
        }
      } catch {
        // ignore race with concurrent deletion
      }
    }
    return { count, totalBytes, dirPath };
  }

  async function openFolder() {
    const dirPath = await ensureRecordingsDir();
    if (!shell?.openPath) {
      return { ok: false };
    }
    const errMsg = await shell.openPath(dirPath);
    return { ok: !errMsg };
  }

  async function runGc(payload = {}) {
    const {
      maxBytes,
      retentionDays,
      referencedIds,
      protectedIds,
      purgeAllInactiveParts = false,
      now = Date.now(),
    } = payload || {};

    const protectedSet = new Set(
      (Array.isArray(protectedIds) ? protectedIds : []).filter(isValidRecordingId),
    );
    const referencedSet = Array.isArray(referencedIds)
      ? new Set(referencedIds.filter(isValidRecordingId))
      : null;

    const dir = getRecordingsDir();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return { deleted: 0 };
      throw err;
    }

    let deleted = 0;
    const files = [];
    const thumbFiles = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const fullPath = path.join(dir, name);
      if (name.endsWith(".webm.part") || name.endsWith(".jpg.part")) {
        const suffix = name.endsWith(".webm.part") ? ".webm.part" : ".jpg.part";
        const id = name.slice(0, -suffix.length);
        if (!isValidRecordingId(id) || activeWriters.has(id)) continue;
        try {
          const stat = await fs.promises.stat(fullPath);
          if (purgeAllInactiveParts || now - stat.mtimeMs >= STALE_PART_AGE_MS) {
            await fs.promises.unlink(fullPath);
            if (suffix === ".webm.part") deleted += 1;
          }
        } catch {
          // ignore
        }
        continue;
      }

      if (name.endsWith(".jpg")) {
        const id = name.slice(0, -".jpg".length);
        if (!isValidRecordingId(id)) continue;
        let stat;
        try {
          stat = await fs.promises.stat(fullPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        thumbFiles.push({ id, fullPath, mtimeMs: stat.mtimeMs });
        continue;
      }

      if (!name.endsWith(".webm")) continue;
      const id = name.slice(0, -".webm".length);
      if (!isValidRecordingId(id)) continue;

      let stat;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const isProtected = protectedSet.has(id) || activeWriters.has(id);

      // 1. Orphan sweep when caller passes the full referenced set.
      if (referencedSet && !referencedSet.has(id) && !isProtected) {
        try {
          await fs.promises.unlink(fullPath);
          await fs.promises.unlink(path.join(dir, `${id}.jpg`)).catch(() => {});
          deleted += 1;
          continue;
        } catch {
          // keep in accounting if unlink failed
        }
      }

      // 2. Retention cutoff (never evict protected / bookmarked logs).
      if (
        typeof retentionDays === "number"
        && Number.isFinite(retentionDays)
        && retentionDays > 0
        && !isProtected
      ) {
        const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
        if (stat.mtimeMs < cutoff) {
          try {
            await fs.promises.unlink(fullPath);
            await fs.promises.unlink(path.join(dir, `${id}.jpg`)).catch(() => {});
            deleted += 1;
            continue;
          } catch {
            // keep in accounting if unlink failed
          }
        }
      }

      files.push({
        id,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isProtected,
      });
    }

    // 3. Max storage quota eviction (oldest non-protected first).
    const evictedIds = new Set();
    if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
      let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > maxBytes) {
        const evictable = files
          .filter((f) => !f.isProtected)
          .sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const item of evictable) {
          if (totalBytes <= maxBytes) break;
          try {
            await fs.promises.unlink(item.fullPath);
            await fs.promises.unlink(path.join(dir, `${item.id}.jpg`)).catch(() => {});
            evictedIds.add(item.id);
            totalBytes -= item.size;
            deleted += 1;
          } catch {
            // ignore
          }
        }
      }
    }

    // 4. Sweep orphaned / expired standalone thumbnails.
    const survivingWebmIds = new Set(
      files.filter((f) => !evictedIds.has(f.id)).map((f) => f.id),
    );
    for (const thumb of thumbFiles) {
      if (protectedSet.has(thumb.id) || activeWriters.has(thumb.id) || survivingWebmIds.has(thumb.id)) {
        continue;
      }
      if (referencedSet && !referencedSet.has(thumb.id)) {
        await fs.promises.unlink(thumb.fullPath).catch(() => {});
        continue;
      }
      if (
        typeof retentionDays === "number"
        && Number.isFinite(retentionDays)
        && retentionDays > 0
      ) {
        const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
        if (thumb.mtimeMs < cutoff) {
          await fs.promises.unlink(thumb.fullPath).catch(() => {});
        }
      }
    }

    return { deleted };
  }

  function toSafeWebStream(filePath, streamOpts) {
    const nodeStream = fs.createReadStream(filePath, streamOpts);
    // Guard against unhandled error events if the file is removed mid-playback.
    nodeStream.on("error", () => {});
    return Readable.toWeb(nodeStream);
  }

  /**
   * HTTP 206 Range streaming handler for `netcatty-media://recording/<uuid>?token=<token>`
   * and `netcatty-media://thumbnail/<uuid>?token=<token>`.
   * Zero-RAM streaming via `fs.createReadStream` -> Web `ReadableStream`.
   */
  async function handleMediaProtocolRequest(request) {
    const baseHeaders = {
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Cross-Origin-Resource-Policy": "cross-origin",
    };

    try {
      const url = new URL(request.url);
      const isRecordingHost = url.hostname === "recording";
      const isThumbnailHost = url.hostname === "thumbnail";
      if (url.protocol !== `${RECORDING_MEDIA_SCHEME}:` || (!isRecordingHost && !isThumbnailHost)) {
        return new Response("Not Found", { status: 404, headers: baseHeaders });
      }
      const token = url.searchParams.get("token");
      if (!token || token !== launchToken) {
        return new Response("Forbidden", { status: 403, headers: baseHeaders });
      }
      const recordingId = url.pathname.replace(/^\/+/, "");
      if (!isValidRecordingId(recordingId)) {
        return new Response("Bad Request", { status: 400, headers: baseHeaders });
      }

      const { finalPath, thumbPath } = resolveRecordingPaths(recordingId);
      const method = (request.method || "GET").toUpperCase();

      if (isThumbnailHost) {
        if (method === "HEAD") {
          const stat = await fs.promises.stat(thumbPath).catch(() => null);
          if (!stat || !stat.isFile()) {
            return new Response("Not Found", { status: 404, headers: baseHeaders });
          }
          return new Response(null, {
            status: 200,
            headers: {
              "Cache-Control": "private, max-age=3600",
              "Cross-Origin-Resource-Policy": "cross-origin",
              "Content-Type": "image/jpeg",
              "Content-Length": String(stat.size),
            },
          });
        }
        const bytes = await fs.promises.readFile(thumbPath).catch(() => null);
        if (!bytes) {
          return new Response("Not Found", { status: 404, headers: baseHeaders });
        }
        return new Response(bytes, {
          status: 200,
          headers: {
            "Cache-Control": "private, max-age=3600",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Content-Type": "image/jpeg",
            "Content-Length": String(bytes.byteLength),
          },
        });
      }

      const stat = await fs.promises.stat(finalPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        return new Response("Not Found", { status: 404, headers: baseHeaders });
      }

      const totalSize = stat.size;
      const rangeHeader = typeof request.headers?.get === "function"
        ? request.headers.get("range")
        : request.headers?.range;

      if (rangeHeader) {
        const parsed = parseByteRange(rangeHeader, totalSize);
        if (!parsed || !parsed.ok) {
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes */${totalSize}`,
            },
          });
        }
        const chunkLength = parsed.end - parsed.start + 1;
        const headers = {
          ...baseHeaders,
          "Content-Type": "video/webm",
          "Content-Range": `bytes ${parsed.start}-${parsed.end}/${totalSize}`,
          "Content-Length": String(chunkLength),
        };
        if (method === "HEAD") {
          return new Response(null, { status: 206, headers });
        }
        return new Response(
          toSafeWebStream(finalPath, { start: parsed.start, end: parsed.end }),
          { status: 206, headers },
        );
      }

      const headers = {
        ...baseHeaders,
        "Content-Type": "video/webm",
        "Content-Length": String(totalSize),
      };
      if (method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      return new Response(toSafeWebStream(finalPath), { status: 200, headers });
    } catch {
      return new Response("Not Found", { status: 404, headers: baseHeaders });
    }
  }

  async function cleanupAll() {
    const writers = Array.from(activeWriters.values());
    activeWriters.clear();
    await Promise.all(
      writers.map(async (writer) => {
        try {
          await closeWriterStream(writer);
          const { thumbPath, thumbPartPath } = resolveRecordingPaths(writer.recordingId);
          await Promise.all([
            fs.promises.unlink(writer.partPath).catch(() => {}),
            fs.promises.unlink(thumbPath).catch(() => {}),
            fs.promises.unlink(thumbPartPath).catch(() => {}),
          ]);
        } catch {
          // ignore shutdown cleanup errors
        }
      }),
    );
  }

  function registerHandlers(ipcMain) {
    ipcMain.handle("netcatty:remote-desktop-recording:begin", (_event, payload) => begin(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:append", (_event, payload) => append(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:finish", (_event, payload) => finish(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:abort", (_event, payload) => abort(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:get-playback-url", (_event, payload) => getPlaybackUrl(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:save-thumbnail", (_event, payload) => saveThumbnail(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:get-thumbnail-url", (_event, payload) => getThumbnailUrl(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:export", (event, payload) => exportRecording(event, payload));
    ipcMain.handle("netcatty:remote-desktop-recording:delete", (_event, payload) => deleteRecording(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:delete-many", (_event, payload) => deleteMany(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:clear-all", (_event, payload) => clearAll(payload));
    ipcMain.handle("netcatty:remote-desktop-recording:stats", () => getStats());
    ipcMain.handle("netcatty:remote-desktop-recording:open-folder", () => openFolder());
    ipcMain.handle("netcatty:remote-desktop-recording:gc", (_event, payload) => runGc(payload));
  }

  return {
    RECORDING_MEDIA_SCHEME,
    launchToken,
    getRecordingsDir,
    buildPlaybackUrl,
    buildThumbnailUrl,
    begin,
    append,
    finish,
    abort,
    getPlaybackUrl,
    saveThumbnail,
    getThumbnailUrl,
    exportRecording,
    deleteRecording,
    deleteMany,
    clearAll,
    getStats,
    openFolder,
    runGc,
    handleMediaProtocolRequest,
    cleanupAll,
    registerHandlers,
  };
}

let defaultBridgeInstance = null;

function init(deps = {}) {
  if (!defaultBridgeInstance) {
    defaultBridgeInstance = createRemoteDesktopRecordingsBridge({
      getUserDataDir: () => deps.userDataDir || deps.app?.getPath?.("userData"),
      dialog: deps.electronModule?.dialog || deps.dialog,
      shell: deps.electronModule?.shell || deps.shell,
      BrowserWindow: deps.electronModule?.BrowserWindow || deps.BrowserWindow,
    });
  }
  return defaultBridgeInstance;
}

function getDefaultBridge() {
  return defaultBridgeInstance;
}

module.exports = {
  RECORDING_MEDIA_SCHEME,
  isValidRecordingId,
  sanitizeExportFileName,
  parseByteRange,
  createRemoteDesktopRecordingsBridge,
  init,
  getDefaultBridge,
};
