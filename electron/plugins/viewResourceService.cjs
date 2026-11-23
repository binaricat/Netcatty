"use strict";
const path = require("node:path");
const { readContainedFile } = require("./pluginProtocol.cjs");
const { inspectContributionIconSource, createBoundedIconRasterizer } = require("./contributionIconService.cjs");
const { createIsolatedContributionIconRasterizer } = require("./contributionIconRasterizer.cjs");
class PluginViewResources {
  constructor({ electron, packageStore }) {
    this.packageStore = packageStore;
    this.rasterize = createBoundedIconRasterizer(createIsolatedContributionIconRasterizer(electron), { maxConcurrent: 2, maxQueued: 16 });
  }
  async image(plugin, resource) {
    if (typeof resource !== 'string' || resource.length > 256 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(resource)
      || resource.split('/').some((part) => !part || part === '.' || part === '..')) throw new TypeError('Invalid plugin image path');
    const root = await this.packageStore.preparePackageRoot(plugin);
    const file = await readContainedFile(root, resource.split('/'), 512 * 1024);
    if (path.extname(resource).toLowerCase() === '.svg' && /<!DOCTYPE|<\?xml-stylesheet|\b(?:href|src)\s*=|@import|url\s*\(/i.test(file.body.toString('utf8'))) throw new Error('Plugin SVG references are unavailable');
    const inspected = inspectContributionIconSource(file.body, path.extname(resource).toLowerCase());
    const png = await this.rasterize({ body: file.body, ...inspected, maxEdge: 2048 });
    if (png.length > 4 * 1024 * 1024) throw new Error('Plugin image exceeds size limit');
    inspectContributionIconSource(png, '.png', 2048);
    return { url: `data:image/png;base64,${png.toString('base64')}` };
  }
}
module.exports = { PluginViewResources };
