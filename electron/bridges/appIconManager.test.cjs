"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appIconManager = require("./appIconManager.cjs");

test("normalizeAppIconVariant falls back to original for invalid values", () => {
  assert.equal(appIconManager.normalizeAppIconVariant("nope"), "original");
  assert.equal(appIconManager.normalizeAppIconVariant("bright"), "bright");
});

test("resolveVariantIconPath prefers public sources in dev when both exist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-dev-"));
  const publicPath = path.join(tmp, "public", "icons", "variants", "bright.png");
  const distPath = path.join(tmp, "dist", "icons", "variants", "bright.png");
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.writeFileSync(publicPath, "public-new");
  fs.writeFileSync(distPath, "dist-old");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true });
  assert.equal(appIconManager.resolveVariantIconPath("bright", tmp), publicPath);
});

test("resolveVariantIconPath prefers dist sources when packaged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-packaged-"));
  const publicPath = path.join(tmp, "public", "icons", "variants", "bright.png");
  const distPath = path.join(tmp, "dist", "icons", "variants", "bright.png");
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.writeFileSync(publicPath, "public-new");
  fs.writeFileSync(distPath, "dist-packaged");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: false });
  assert.equal(appIconManager.resolveVariantIconPath("bright", tmp), distPath);
});

test("applyAppIconVariant updates current icon path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-apply-"));
  const publicDir = path.join(tmp, "public");
  const variantsDir = path.join(publicDir, "icons", "variants");
  fs.mkdirSync(variantsDir, { recursive: true });
  const originalPath = path.join(publicDir, "icon.png");
  const brightPath = path.join(variantsDir, "bright.png");
  fs.writeFileSync(originalPath, "orig");
  fs.writeFileSync(brightPath, "bright");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true });
  const windows = [];
  const applied = appIconManager.applyAppIconVariant("bright", {
    app: { isPackaged: false, dock: { setIcon() {} } },
    BrowserWindow: { getAllWindows: () => windows },
    nativeImage: {
      createFromBuffer: (buf) => ({ buffer: buf.toString() }),
      createFromPath: (p) => ({ path: p }),
    },
    appPath: tmp,
    isMac: true,
  });

  assert.equal(applied, true);
  assert.equal(appIconManager.getAppIconVariant(), "bright");
  assert.equal(appIconManager.getAppIconPath(tmp), brightPath);
});
