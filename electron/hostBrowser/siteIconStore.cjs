"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_ICONS = 1000;
const MAX_ICON_BYTES = 64 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/vnd.microsoft.icon"]);

function iconOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch { return null; }
}

function validImageDataUrl(value) {
  if (typeof value !== "string" || value.length > MAX_ICON_BYTES * 1.4) return false;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !IMAGE_MIMES.has(match[1])) return false;
  return Buffer.byteLength(match[2], "base64") <= MAX_ICON_BYTES;
}

function normalizeIcon(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid website icon");
  const hostId = typeof raw.hostId === "string" ? raw.hostId.slice(0, 256) : "";
  const origin = iconOrigin(raw.origin);
  if (!hostId || !origin) throw new Error("Invalid website icon target");
  const mode = raw.mode === "custom" ? "custom" : "auto";
  const dataUrl = validImageDataUrl(raw.dataUrl) ? raw.dataUrl : null;
  const glyph = typeof raw.glyph === "string" ? raw.glyph.trim().slice(0, 4) : "";
  const color = /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : "#247969";
  if (!dataUrl && !glyph) throw new Error("Website icon is empty");
  return { hostId, origin, mode, dataUrl, glyph, color };
}

function createSiteIconStore(app) {
  const file = path.join(app.getPath("userData"), "host-browser-site-icons.json");
  const icons = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      for (const raw of parsed.slice(0, MAX_ICONS)) {
        try { const icon = normalizeIcon(raw); icons.set(`${icon.hostId}\n${icon.origin}`, icon); } catch {}
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("[HostBrowser] Could not read website icons:", error?.message);
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...icons.values()]), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const keyFor = (hostId, url) => {
    const origin = iconOrigin(url);
    return origin && typeof hostId === "string" ? `${hostId}\n${origin}` : null;
  };
  return {
    get(hostId, url) { const key = keyFor(hostId, url); return key ? icons.get(key) || null : null; },
    set(hostId, url, input) {
      const key = keyFor(hostId, url);
      if (!key) throw new Error("Invalid website address");
      const previous = icons.get(key);
      if (input.mode === "auto" && previous?.mode === "custom") return previous;
      if (!previous && icons.size >= MAX_ICONS) throw new Error("Website icon limit reached");
      const next = normalizeIcon({ ...input, hostId, origin: iconOrigin(url) });
      icons.set(key, next);
      persist();
      return next;
    },
    reset(hostId, url) {
      const key = keyFor(hostId, url);
      if (key && icons.delete(key)) persist();
    },
  };
}

module.exports = { createSiteIconStore, iconOrigin, validImageDataUrl };
