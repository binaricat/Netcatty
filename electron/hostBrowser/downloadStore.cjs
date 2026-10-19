"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_DOWNLOADS = 500;
const STATUSES = new Set(["waiting", "progressing", "completed", "cancelled", "interrupted"]);

function normalizeDownload(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || raw.id.length > 128
    || typeof raw.hostId !== "string" || !raw.hostId || raw.hostId.length > 256) throw new Error("Invalid download");
  return {
    id: raw.id,
    hostId: raw.hostId,
    filename: String(raw.filename || "download").slice(0, 255),
    url: String(raw.url || "").slice(0, 4096),
    savePath: typeof raw.savePath === "string" ? raw.savePath.slice(0, 4096) : "",
    status: STATUSES.has(raw.status) ? raw.status : "interrupted",
    received: Number.isSafeInteger(raw.received) && raw.received >= 0 ? raw.received : 0,
    total: Number.isSafeInteger(raw.total) && raw.total >= 0 ? raw.total : 0,
    startedAt: Number.isSafeInteger(raw.startedAt) && raw.startedAt > 0 ? raw.startedAt : Date.now(),
    endedAt: Number.isSafeInteger(raw.endedAt) && raw.endedAt > 0 ? raw.endedAt : null,
  };
}

function createDownloadStore(app) {
  const file = path.join(app.getPath("userData"), "host-browser-downloads.json");
  let items = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      items = parsed.slice(0, MAX_DOWNLOADS).flatMap((raw) => {
        try {
          const item = normalizeDownload(raw);
          if (item.status === "progressing" || item.status === "waiting") item.status = "interrupted";
          return [item];
        } catch { return []; }
      });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("[HostBrowser] Could not read downloads:", error?.message);
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(items), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const isMissing = (item) => item.status === "completed" && (!item.savePath || !fs.existsSync(item.savePath));
  return {
    list(hostId) {
      return items.filter((item) => item.hostId === hostId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((item) => ({ ...item, missing: isMissing(item) }));
    },
    get(hostId, id) { return items.find((item) => item.hostId === hostId && item.id === id) || null; },
    upsert(raw) {
      const next = normalizeDownload(raw);
      const index = items.findIndex((item) => item.id === next.id);
      if (index >= 0 && items[index].hostId !== next.hostId) throw new Error("Download belongs to another host");
      if (index >= 0) items[index] = next;
      else items.unshift(next);
      items = items.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_DOWNLOADS);
      persist();
      return next;
    },
    remove(hostId, id) {
      const next = items.filter((item) => item.hostId !== hostId || item.id !== id || ["waiting", "progressing"].includes(item.status));
      if (next.length === items.length) return false;
      items = next;
      persist();
      return true;
    },
    clearFinished(hostId) {
      const next = items.filter((item) => item.hostId !== hostId || ["waiting", "progressing"].includes(item.status));
      if (next.length !== items.length) { items = next; persist(); }
    },
  };
}

module.exports = { createDownloadStore };
