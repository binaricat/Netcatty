"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validImageDataUrl } = require("./siteIconStore.cjs");

const MAX_BOOKMARKS = 1000;

function normalizeBookmark(raw, previous = null) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid bookmark");
  const url = new URL(String(raw.url || ""));
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Bookmarks require an HTTP or HTTPS address without credentials");
  }
  const scope = raw.scope === "all-hosts" ? "all-hosts" : "host";
  const hostId = scope === "host" ? String(raw.hostId || "").slice(0, 256) : null;
  if (scope === "host" && !hostId) throw new Error("Host bookmark is missing its host");
  const title = String(raw.title || url.hostname).trim().slice(0, 120);
  const icon = String(raw.icon || title[0] || "\u25c7").trim().slice(0, 4);
  const color = /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : "#247969";
  const now = Date.now();
  return {
    id: previous?.id || (typeof raw.id === "string" && raw.id.trim() && raw.id.length <= 128 ? raw.id : randomUUID()),
    title: title || url.hostname,
    url: url.href,
    scope,
    hostId,
    icon: icon || "\u25c7",
    iconMode: raw.iconMode === "custom" ? "custom" : "auto",
    iconDataUrl: raw.iconDataUrl === null ? null
      : validImageDataUrl(raw.iconDataUrl) ? raw.iconDataUrl
        : previous?.iconDataUrl || null,
    color,
    order: Number.isSafeInteger(raw.order) ? raw.order : (previous?.order ?? 0),
    createdAt: previous?.createdAt || (Number.isSafeInteger(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now),
    updatedAt: previous ? now : (Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now),
  };
}

function createBookmarkStore(app, onChange = () => {}) {
  const file = path.join(app.getPath("userData"), "host-browser-bookmarks.json");
  let items = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed) && parsed.length <= MAX_BOOKMARKS) {
      items = parsed.flatMap((item) => {
        try { return [normalizeBookmark(item)]; } catch { return []; }
      });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("[HostBrowser] Could not read bookmarks:", error?.message);
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(items), { mode: 0o600 });
    fs.renameSync(temporary, file);
    onChange(items);
  };
  return {
    list: () => items.map((item) => ({ ...item })),
    upsert(input) {
      const index = items.findIndex((item) => item.id === input?.id);
      if (index < 0 && items.length >= MAX_BOOKMARKS) throw new Error("Bookmark limit reached");
      const next = normalizeBookmark(input, index >= 0 ? items[index] : null);
      if (index >= 0) items[index] = next;
      else items.push(next);
      persist();
      return { ...next };
    },
    remove(id) {
      const next = items.filter((item) => item.id !== id);
      if (next.length !== items.length) { items = next; persist(); }
    },
    apply(input) {
      if (!Array.isArray(input) || input.length > MAX_BOOKMARKS) throw new Error("Invalid bookmark list");
      const ids = new Set();
      const next = input.map((item) => {
        const normalized = normalizeBookmark(item);
        if (ids.has(normalized.id)) throw new Error("Duplicate bookmark ID");
        ids.add(normalized.id);
        return normalized;
      });
      items = next;
      persist();
    },
  };
}

module.exports = { createBookmarkStore, normalizeBookmark };
