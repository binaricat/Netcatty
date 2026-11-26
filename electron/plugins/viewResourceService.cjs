"use strict";
const path = require("node:path");
const { readContainedFile } = require("./pluginProtocol.cjs");
const { inspectContributionIconSource, createBoundedIconRasterizer } = require("./contributionIconService.cjs");
const { createPooledContributionIconRasterizer } = require("./contributionIconRasterizer.cjs");

const MAX_VIEW_RESOURCE_CACHE_ENTRIES = 256;
const MAX_VIEW_RESOURCE_CACHE_BYTES = 24 * 1024 * 1024;

function buildCacheKey(plugin, resource) {
  if (!plugin || typeof plugin.id !== "string" || typeof plugin.activeVersion !== "string") return null;
  return JSON.stringify([plugin.id, plugin.activeVersion, plugin.archiveSha256 ?? "", resource]);
}

class PluginViewResources {
  constructor({ electron, packageStore }) {
    this.packageStore = packageStore;
    this.pooledRasterizer = createPooledContributionIconRasterizer(electron);
    this.rasterize = createBoundedIconRasterizer(this.pooledRasterizer, { maxConcurrent: 8, maxQueued: 256 });
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

  async image(plugin, resource) {
    if (typeof resource !== 'string' || resource.length > 256 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(resource)
      || resource.split('/').some((part) => !part || part === '.' || part === '..')) throw new TypeError('Invalid plugin image path');
    const cacheKey = buildCacheKey(plugin, resource);
    const cached = this.#getCached(cacheKey);
    if (cached) return cached;
    if (cacheKey && this.pending.has(cacheKey)) return this.pending.get(cacheKey);

    const task = (async () => {
      const root = await this.packageStore.preparePackageRoot(plugin);
      const file = await readContainedFile(root, resource.split('/'), 512 * 1024);
      if (path.extname(resource).toLowerCase() === '.svg' && /<!DOCTYPE|<\?xml-stylesheet|\b(?:href|src)\s*=|@import|url\s*\(/i.test(file.body.toString('utf8'))) throw new Error('Plugin SVG references are unavailable');
      const inspected = inspectContributionIconSource(file.body, path.extname(resource).toLowerCase());
      const png = await this.rasterize({ body: file.body, ...inspected, maxEdge: 2048 });
      if (png.length > 4 * 1024 * 1024) throw new Error('Plugin image exceeds size limit');
      inspectContributionIconSource(png, '.png', 2048);
      const result = { url: `data:image/png;base64,${png.toString('base64')}` };
      this.#setCached(cacheKey, result);
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
    this.pooledRasterizer?.dispose?.();
    this.cache.clear();
    this.cacheBytes = 0;
    this.pending.clear();
  }
}
module.exports = { PluginViewResources };
