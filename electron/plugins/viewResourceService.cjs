"use strict";
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { readContainedFile } = require("./pluginProtocol.cjs");
const { inspectContributionIconSource, createBoundedIconRasterizer } = require("./contributionIconService.cjs");
const { createPooledContributionIconRasterizer } = require("./contributionIconRasterizer.cjs");

const MAX_VIEW_RESOURCE_CACHE_ENTRIES = 256;
const MAX_VIEW_RESOURCE_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_DISK_CACHE_FILES = 512;
const VIEW_IMAGE_MAX_EDGE = 2048;

function buildCacheKey(plugin, resource) {
  if (!plugin || typeof plugin.id !== "string" || typeof plugin.activeVersion !== "string") return null;
  return JSON.stringify([plugin.id, plugin.activeVersion, plugin.archiveSha256 ?? "", resource]);
}

function buildDiskCacheFilename(plugin, resource) {
  if (!plugin || typeof plugin.id !== "string" || typeof plugin.activeVersion !== "string"
    || typeof plugin.archiveSha256 !== "string" || !plugin.archiveSha256) return null;
  const digest = createHash("sha256")
    .update(JSON.stringify(["view-v1", plugin.id, plugin.activeVersion, plugin.archiveSha256, resource, VIEW_IMAGE_MAX_EDGE]))
    .digest("hex");
  return `${digest}.png`;
}

class PluginViewResources {
  constructor({ electron, packageStore, rasterizeIcon, cacheDir }) {
    this.packageStore = packageStore;
    this.ownsRasterizer = typeof rasterizeIcon !== "function";
    this.pooledRasterizer = this.ownsRasterizer
      ? createPooledContributionIconRasterizer(electron)
      : rasterizeIcon;
    this.rasterize = createBoundedIconRasterizer(this.pooledRasterizer, { maxConcurrent: 8, maxQueued: 256 });
    this.cacheDir = typeof cacheDir === "string" && cacheDir.length > 0 ? cacheDir : null;
    this.cacheDirReady = null;
    this.diskWritesSincePrune = 0;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.pending = new Map();
  }

  #getCached(key) {
    if (!key || !this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  #setCached(key, value) {
    if (!key) return;
    const size = value.url.length;
    if (size > MAX_VIEW_RESOURCE_CACHE_BYTES) return;
    if (this.cache.has(key)) {
      this.cacheBytes -= this.cache.get(key).url.length;
      this.cache.delete(key);
    }
    while (this.cache.size >= MAX_VIEW_RESOURCE_CACHE_ENTRIES || this.cacheBytes + size > MAX_VIEW_RESOURCE_CACHE_BYTES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cacheBytes -= this.cache.get(oldestKey).url.length;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
    this.cacheBytes += size;
  }

  async #readDiskCache(plugin, resource) {
    if (!this.cacheDir) return null;
    const filename = buildDiskCacheFilename(plugin, resource);
    if (!filename) return null;
    try {
      const filePath = path.join(this.cacheDir, filename);
      const png = await fs.readFile(filePath);
      if (!png.length || png.length > 4 * 1024 * 1024) return null;
      inspectContributionIconSource(png, ".png", VIEW_IMAGE_MAX_EDGE);
      return { url: `data:image/png;base64,${png.toString("base64")}` };
    } catch {
      return null;
    }
  }

  async #writeDiskCache(plugin, resource, png) {
    if (!this.cacheDir) return;
    const filename = buildDiskCacheFilename(plugin, resource);
    if (!filename) return;
    try {
      this.cacheDirReady ??= fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      await this.cacheDirReady;
      const targetPath = path.join(this.cacheDir, filename);
      const tempPath = path.join(this.cacheDir, `.tmp-${randomUUID()}.png`);
      try {
        await fs.writeFile(tempPath, png, { mode: 0o600 });
        await fs.rename(tempPath, targetPath);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
      if (++this.diskWritesSincePrune >= 32) {
        this.diskWritesSincePrune = 0;
        void this.#pruneDiskCache();
      }
    } catch {
      // Disk cache is best-effort; memory cache already holds the decoded image.
    }
  }

  async #pruneDiskCache() {
    if (!this.cacheDir) return;
    try {
      const names = (await fs.readdir(this.cacheDir)).filter((name) => name.endsWith(".png") && !name.startsWith(".tmp-"));
      if (names.length <= MAX_DISK_CACHE_FILES) return;
      const entries = await Promise.all(names.map(async (name) => {
        const fullPath = path.join(this.cacheDir, name);
        const stat = await fs.stat(fullPath).catch(() => null);
        return stat ? { fullPath, mtimeMs: stat.mtimeMs } : null;
      }));
      const valid = entries.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
      const excess = valid.length - MAX_DISK_CACHE_FILES;
      for (let i = 0; i < excess; i += 1) {
        await fs.unlink(valid[i].fullPath).catch(() => {});
      }
    } catch { /* best-effort prune */ }
  }

  async #readPackageImage(plugin, segments) {
    if (typeof this.packageStore.readVerifiedPackageFile === "function") {
      return this.packageStore.readVerifiedPackageFile(plugin, segments, 512 * 1024);
    }
    const root = await this.packageStore.preparePackageRoot(plugin);
    return readContainedFile(root, segments, 512 * 1024);
  }

  async image(plugin, resource) {
    if (typeof resource !== "string" || resource.length > 256 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(resource)
      || resource.split("/").some((part) => !part || part === "." || part === "..")) throw new TypeError("Invalid plugin image path");
    const cacheKey = buildCacheKey(plugin, resource);
    const cached = this.#getCached(cacheKey);
    if (cached) return cached;
    if (cacheKey && this.pending.has(cacheKey)) return this.pending.get(cacheKey);

    const task = (async () => {
      const diskHit = await this.#readDiskCache(plugin, resource);
      if (diskHit) {
        this.#setCached(cacheKey, diskHit);
        return diskHit;
      }
      const file = await this.#readPackageImage(plugin, resource.split("/"));
      if (path.extname(resource).toLowerCase() === ".svg" && /<!DOCTYPE|<\?xml-stylesheet|\b(?:href|src)\s*=|@import|url\s*\(/i.test(file.body.toString("utf8"))) throw new Error("Plugin SVG references are unavailable");
      const inspected = inspectContributionIconSource(file.body, path.extname(resource).toLowerCase());
      const png = await this.rasterize({ body: file.body, ...inspected, maxEdge: VIEW_IMAGE_MAX_EDGE });
      if (png.length > 4 * 1024 * 1024) throw new Error("Plugin image exceeds size limit");
      inspectContributionIconSource(png, ".png", VIEW_IMAGE_MAX_EDGE);
      const result = { url: `data:image/png;base64,${png.toString("base64")}` };
      this.#setCached(cacheKey, result);
      void this.#writeDiskCache(plugin, resource, png);
      return result;
    })();

    if (cacheKey) {
      this.pending.set(cacheKey, task);
      task.finally(() => {
        if (this.pending.get(cacheKey) === task) this.pending.delete(cacheKey);
      }).catch(() => {});
    }
    return task;
  }

  dispose() {
    if (this.ownsRasterizer) this.pooledRasterizer?.dispose?.();
    this.cache.clear();
    this.cacheBytes = 0;
    this.pending.clear();
  }
}
module.exports = { PluginViewResources };
