"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSiteIconStore, validImageDataUrl } = require("./siteIconStore.cjs");

const favicon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==";

test("website icons persist per host and user overrides survive automatic updates", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-site-icons-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = { getPath: () => dir };
  const first = createSiteIconStore(app);
  first.set("host-a", "https://example.com/page", { mode: "auto", dataUrl: favicon });
  assert.equal(first.get("host-a", "https://example.com/other").dataUrl, favicon);
  assert.equal(first.get("host-b", "https://example.com/page"), null);
  first.set("host-a", "https://example.com/page", { mode: "custom", glyph: "\u2726", color: "#123456" });
  first.set("host-a", "https://example.com/page", { mode: "auto", dataUrl: favicon });
  const reopened = createSiteIconStore(app);
  assert.deepEqual(reopened.get("host-a", "https://example.com/page"), {
    hostId: "host-a", origin: "https://example.com", mode: "custom",
    dataUrl: null, glyph: "\u2726", color: "#123456",
  });
  reopened.reset("host-a", "https://example.com/page");
  assert.equal(createSiteIconStore(app).get("host-a", "https://example.com/page"), null);
});

test("website icon images accept only bounded raster data", () => {
  assert.equal(validImageDataUrl(favicon), true);
  assert.equal(validImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(validImageDataUrl(`data:image/png;base64,${Buffer.alloc(65 * 1024).toString("base64")}`), false);
});
