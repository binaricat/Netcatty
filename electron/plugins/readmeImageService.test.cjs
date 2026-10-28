"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createReadmeImageResolver } = require("./readmeImageService.cjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const hash = (body) => createHash("sha256").update(body).digest("hex");
const ref = (body) => ({ path: `/assets/${hash(body)}.png`, sha256: hash(body), size: body.length });

test("verified raster images are decoded in the isolated rasterizer and re-encoded", async () => {
  let calls = 0;
  const resolve = createReadmeImageResolver({ rasterize: async (input) => { calls++; assert.equal(input.mimeType, "image/png"); assert.equal(input.maxEdge, 1024); return png; } });
  assert.match(await resolve({ reference: ref(png), read: async () => png }), /^data:image\/png;base64,/);
  assert.equal(calls, 1);
  await assert.rejects(resolve({ reference: { ...ref(png), sha256: "a".repeat(64) }, read: async () => png }), /bytes/);
  await assert.rejects(resolve({ reference: { ...ref(png), size: 1 }, read: async () => png }), /bytes/);
  await assert.rejects(resolve({ reference: { ...ref(png), path: "/a.svg" }, read: async () => png }), /Unsupported/);
  const huge = Buffer.from(png); huge.writeUInt32BE(5000, 16);
  await assert.rejects(resolve({ reference: ref(huge), read: async () => huge }), /dimensions/);
  assert.equal(calls, 1);
});

test("invalid rasterizer output is never returned", async () => {
  const resolve = createReadmeImageResolver({ rasterize: async () => Buffer.from("bad") });
  await assert.rejects(resolve({ reference: ref(png), read: async () => png }), /header/);
});
