"use strict";

const path = require("node:path");
const { createHash } = require("node:crypto");
const { createBoundedIconRasterizer, inspectContributionIconSource } = require("./contributionIconService.cjs");
const { createIsolatedContributionIconRasterizer } = require("./contributionIconRasterizer.cjs");

function createReadmeImageResolver({ BrowserWindow, rasterize } = {}) {
  const decode = createBoundedIconRasterizer(rasterize ?? createIsolatedContributionIconRasterizer({ BrowserWindow }), { maxConcurrent: 2, maxQueued: 8 });
  let pending = 0;
  return async ({ reference, read }) => {
    if (pending >= 10) throw new Error("README image queue is full");
    pending++;
    try {
      const body = await read();
      if (!Buffer.isBuffer(body) || body.length !== reference.size || body.length > 256 * 1024
        || createHash("sha256").update(body).digest("hex") !== reference.sha256) throw new Error("Invalid README image bytes");
      const extension = path.extname(reference.path);
      if (![".png", ".webp"].includes(extension)) throw new Error("Unsupported README image");
      const inspected = inspectContributionIconSource(body, extension);
      const png = await decode({ body, ...inspected, maxEdge: 1024 });
      if (!Buffer.isBuffer(png) || !png.length || png.length > 4 * 1024 * 1024) throw new Error("Invalid README image output");
      inspectContributionIconSource(png, ".png", 1024);
      return `data:image/png;base64,${png.toString("base64")}`;
    } finally { pending--; }
  };
}
module.exports = { createReadmeImageResolver };
