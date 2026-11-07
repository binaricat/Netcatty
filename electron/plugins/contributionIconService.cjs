"use strict";

const path = require("node:path");
const { createHash } = require("node:crypto");

const { readContainedFile } = require("./pluginProtocol.cjs");
const { createIsolatedContributionIconRasterizer } = require("./contributionIconRasterizer.cjs");

const MAX_ICON_SOURCE_BYTES = 512 * 1024;
const MAX_ICON_PNG_BYTES = 512 * 1024;
const MAX_ICON_EDGE = 64;
const MAX_ICON_SOURCE_EDGE = 4_096;
const MAX_ICON_SOURCE_PIXELS = 16 * 1024 * 1024;
const MAX_CONCURRENT_ICON_RASTERIZATIONS = 2;
const MAX_QUEUED_ICON_RASTERIZATIONS = 64;
const CONTRIBUTION_KINDS = Object.freeze(["commands", "menus", "views"]);
const EXTENSION_MIME_TYPES = Object.freeze({
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
});

function createBoundedIconRasterizer(rasterize, options = {}) {
  if (typeof rasterize !== "function") throw new TypeError("Plugin contribution icon rasterizer is unavailable");
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_ICON_RASTERIZATIONS;
  const maxQueued = options.maxQueued ?? MAX_QUEUED_ICON_RASTERIZATIONS;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new TypeError("Plugin contribution icon rasterization limits are invalid");
  }
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      Promise.resolve().then(() => rasterize(task.payload)).then(task.resolve, task.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return (payload) => new Promise((resolve, reject) => {
    if (queue.length >= maxQueued && active >= maxConcurrent) {
      reject(new Error("Plugin contribution icon rasterization queue is full"));
      return;
    }
    queue.push({ payload, resolve, reject });
    drain();
  });
}

function inspectJpegDimensions(body) {
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < body.length) {
    while (offset < body.length && body[offset] === 0xff) offset += 1;
    const marker = body[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > body.length) break;
    const length = body.readUInt16BE(offset);
    if (length < 2 || offset + length > body.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return { height: body.readUInt16BE(offset + 3), width: body.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function inspectSvgDimensions(body) {
  const source = body.toString("utf8");
  if (source.includes("\0") || /<\s*(?:script|foreignObject)\b/i.test(source)) return null;
  const match = source.match(/<svg\b([^>]*)>/i);
  if (!match || match[1].length > 8_192) return null;
  const attributes = match[1];
  const readLength = (name) => {
    const value = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1]?.trim();
    if (!value || !/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(value)) return null;
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : null;
  };
  let width = readLength("width");
  let height = readLength("height");
  if (!width || !height) {
    const viewBox = attributes.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]
      ?.trim().split(/[\s,]+/).map(Number);
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
      width = Math.round(Math.abs(viewBox[2]));
      height = Math.round(Math.abs(viewBox[3]));
    }
  }
  return width && height ? { width, height } : null;
}

function inspectContributionIconSource(body, extension, maxEdge = MAX_ICON_SOURCE_EDGE) {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error("Plugin contribution icon is empty");
  const expectedMimeType = EXTENSION_MIME_TYPES[extension];
  if (!expectedMimeType) throw new Error("Plugin contribution icon format is unsupported");
  let mimeType = null;
  let dimensions = null;
  if (body.length >= 24
    && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && body.toString("ascii", 12, 16) === "IHDR") {
    mimeType = "image/png";
    dimensions = { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
  } else if (body.length >= 10 && /^GIF8[79]a$/.test(body.toString("ascii", 0, 6))) {
    mimeType = "image/gif";
    dimensions = { width: body.readUInt16LE(6), height: body.readUInt16LE(8) };
  } else if (body.length >= 22 && body.readUInt16LE(0) === 0 && body.readUInt16LE(2) === 1) {
    const count = body.readUInt16LE(4);
    if (count < 1 || body.length < 6 + (count * 16)) throw new Error("Plugin contribution icon header is invalid");
    let width = 0;
    let height = 0;
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + (index * 16);
      width = Math.max(width, body[offset] || 256);
      height = Math.max(height, body[offset + 1] || 256);
    }
    mimeType = "image/x-icon";
    dimensions = { width, height };
  } else if (body.length >= 30
    && body.toString("ascii", 0, 4) === "RIFF"
    && body.toString("ascii", 8, 12) === "WEBP") {
    const kind = body.toString("ascii", 12, 16);
    mimeType = "image/webp";
    if (kind === "VP8X" && body.length >= 30) {
      dimensions = {
        width: 1 + body.readUIntLE(24, 3),
        height: 1 + body.readUIntLE(27, 3),
      };
    } else if (kind === "VP8L" && body.length >= 25 && body[20] === 0x2f) {
      const bits = body.readUInt32LE(21);
      dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    } else if (kind === "VP8 " && body.length >= 30
      && body[23] === 0x9d && body[24] === 0x01 && body[25] === 0x2a) {
      dimensions = { width: body.readUInt16LE(26) & 0x3fff, height: body.readUInt16LE(28) & 0x3fff };
    }
  } else {
    const jpeg = inspectJpegDimensions(body);
    if (jpeg) {
      mimeType = "image/jpeg";
      dimensions = jpeg;
    } else if (extension === ".svg") {
      const svg = inspectSvgDimensions(body);
      if (svg) {
        mimeType = "image/svg+xml";
        dimensions = svg;
      }
    }
  }
  if (!mimeType || !dimensions) throw new Error("Plugin contribution icon header is invalid");
  if (mimeType !== expectedMimeType) throw new Error("Plugin contribution icon format does not match its extension");
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Plugin contribution icon dimensions are invalid");
  }
  if (width > maxEdge || height > maxEdge || width * height > MAX_ICON_SOURCE_PIXELS) {
    throw new Error("Plugin contribution icon dimensions are too large");
  }
  return Object.freeze({ mimeType, width, height });
}

function isDeclaredPackageIcon(manifest, icon) {
  if (!icon || icon.kind !== "package") return false;
  return CONTRIBUTION_KINDS.some((kind) => (
    (manifest?.contributes?.[kind] ?? []).some((contribution) => (
      contribution?.icon?.kind === "package"
      && contribution.icon.light === icon.light
      && contribution.icon.dark === icon.dark
    ))
  ));
}

class PluginContributionIconService {
  constructor(options) {
    this.database = options.database;
    this.packageStore = options.packageStore;
    const rasterizeIcon = options.rasterizeIcon ?? createIsolatedContributionIconRasterizer({
      BrowserWindow: options.BrowserWindow,
    });
    this.rasterizeIcon = createBoundedIconRasterizer(rasterizeIcon, {
      maxConcurrent: options.maxConcurrentRasterizations,
      maxQueued: options.maxQueuedRasterizations,
    });
    this.cache = new Map();
    this.pending = new Map();
  }

  async resolve(payload) {
    const pluginId = typeof payload?.pluginId === "string" && payload.pluginId.length <= 256
      ? payload.pluginId
      : null;
    const icon = payload?.icon;
    const plugin = pluginId ? this.database.getActivePlugin(pluginId) : null;
    if (!pluginId || !isDeclaredPackageIcon(plugin?.manifest, icon)) {
      throw new TypeError("Plugin contribution icon is not declared by the active plugin");
    }
    if (!plugin?.enabled || plugin.runtime?.quarantinedAt != null || !plugin.activeVersion) {
      throw new Error("Plugin contribution icon is unavailable");
    }
    const cacheKey = JSON.stringify([pluginId, plugin.activeVersion, icon.light, icon.dark ?? null]);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    if (this.pending.has(cacheKey)) return this.pending.get(cacheKey);
    const pending = this.#resolveUncached({ pluginId, plugin, icon, cacheKey }).finally(() => {
      if (this.pending.get(cacheKey) === pending) this.pending.delete(cacheKey);
    });
    this.pending.set(cacheKey, pending);
    return pending;
  }

  // Called only with a host-selected, hash-bound registry reference. It shares
  // the existing decoder, queue, cache and pending work with package icons.
  async resolveCatalogAvatar({ sourceId, reference, read }) {
    const key = JSON.stringify(["catalog-avatar", sourceId, reference.path, reference.sha256, reference.size]);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= MAX_QUEUED_ICON_RASTERIZATIONS + MAX_CONCURRENT_ICON_RASTERIZATIONS) {
      throw new Error("Plugin image queue is full");
    }
    const pending = (async () => {
      const body = await read();
      if (!Buffer.isBuffer(body) || body.length !== reference.size || body.length > 256 * 1024
        || createHash("sha256").update(body).digest("hex") !== reference.sha256) throw new Error("Invalid plugin avatar bytes");
      const extension = path.extname(reference.path);
      if (![".png", ".webp"].includes(extension)) throw new Error("Invalid plugin avatar format");
      const inspected = inspectContributionIconSource(body, extension);
      if (inspected.mimeType !== (extension === ".png" ? "image/png" : "image/webp")) throw new Error("Plugin avatar format mismatch");
      const png = await this.rasterizeIcon({ body, ...inspected, maxEdge: MAX_ICON_EDGE });
      if (!png.length || png.length > MAX_ICON_PNG_BYTES) throw new Error("Plugin avatar output is too large");
      inspectContributionIconSource(png, ".png", MAX_ICON_EDGE);
      const value = `data:image/png;base64,${png.toString("base64")}`;
      if (this.cache.size >= 256) this.cache.clear();
      this.cache.set(key, value);
      return value;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  async #resolveUncached({ pluginId, plugin, icon, cacheKey }) {
    const packageRoot = await this.packageStore.preparePackageRoot(plugin);
    const result = Object.freeze({
      light: await this.#readIcon(packageRoot, icon.light),
      ...(icon.dark ? { dark: await this.#readIcon(packageRoot, icon.dark) } : {}),
    });
    const current = this.database.getActivePlugin(pluginId);
    if (!current?.enabled || current.runtime?.quarantinedAt != null
      || current.activeVersion !== plugin.activeVersion
      || !isDeclaredPackageIcon(current.manifest, icon)) {
      throw new Error("Plugin contribution icon ownership changed while loading");
    }
    if (this.cache.size >= 256) this.cache.clear();
    this.cache.set(cacheKey, result);
    return result;
  }

  // Branding is inert installed metadata. It does not share the enabled-only
  // contribution admission path, and accepts no renderer-provided resource path.
  async resolveBrand(pluginId) {
    if (typeof pluginId !== "string" || pluginId.length > 256) throw new TypeError("Invalid plugin ID");
    const plugin = this.database.getActivePlugin(pluginId);
    if (!plugin?.activeVersion || plugin.runtime?.quarantinedAt != null) return null;
    const icon = plugin.manifest?.icon;
    if (icon?.kind !== "package") return null;
    const identity = JSON.stringify([plugin.activeVersion, plugin.archiveSha256, icon]);
    const key = JSON.stringify(["brand", pluginId, identity]);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = (async () => {
      const root = await this.packageStore.preparePackageRoot(plugin);
      const result = { light: await this.#readIcon(root, icon.light, true),
        ...(icon.dark ? { dark: await this.#readIcon(root, icon.dark, true) } : {}) };
      const current = this.database.getActivePlugin(pluginId);
      if (!current || current.runtime?.quarantinedAt != null || identity !== JSON.stringify([current.activeVersion, current.archiveSha256, current.manifest?.icon])) {
        throw new Error("Plugin brand icon ownership changed while loading");
      }
      if (this.cache.size >= 256) this.cache.clear();
      this.cache.set(key, result);
      return result;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  async #readIcon(packageRoot, packagePath, brand = false) {
    const segments = packagePath.split("/");
    const file = await readContainedFile(packageRoot, segments);
    if (file.body.byteLength > MAX_ICON_SOURCE_BYTES) throw new Error("Plugin contribution icon is too large");
    const extension = path.extname(file.filePath).toLowerCase();
    const inspected = brand
      ? (await import("@netcatty/plugin-contract")).inspectPluginBrandIcon(file.body, packagePath)
      : inspectContributionIconSource(file.body, extension);
    const png = await this.rasterizeIcon({
      body: file.body,
      ...inspected,
      maxEdge: MAX_ICON_EDGE,
    });
    if (!png.length || png.length > MAX_ICON_PNG_BYTES) throw new Error("Plugin contribution icon output is too large");
    inspectContributionIconSource(png, ".png", MAX_ICON_EDGE);
    return `data:image/png;base64,${png.toString("base64")}`;
  }
}

module.exports = {
  MAX_ICON_EDGE,
  MAX_CONCURRENT_ICON_RASTERIZATIONS,
  MAX_QUEUED_ICON_RASTERIZATIONS,
  MAX_ICON_SOURCE_EDGE,
  PluginContributionIconService,
  createBoundedIconRasterizer,
  inspectContributionIconSource,
  isDeclaredPackageIcon,
};
