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

test("original icon uses platform-specific sizing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-platform-"));
  const publicDir = path.join(tmp, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const macPath = path.join(publicDir, "icons", "variants", "macos", "original.png");
  const desktopPath = path.join(publicDir, "icons", "variants", "original.png");
  fs.mkdirSync(path.dirname(macPath), { recursive: true });
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.writeFileSync(macPath, "mac");
  fs.writeFileSync(desktopPath, "desktop");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: true });
  assert.equal(appIconManager.resolveVariantIconPath("original", tmp), macPath);

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: false });
  assert.equal(appIconManager.resolveVariantIconPath("original", tmp), desktopPath);
});

test("macOS variants use HIG-sized assets without changing other platforms", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-variant-platform-"));
  const variantsDir = path.join(tmp, "public", "icons", "variants");
  const macVariantsDir = path.join(variantsDir, "macos");
  fs.mkdirSync(macVariantsDir, { recursive: true });
  const desktopPath = path.join(variantsDir, "bright.png");
  const macPath = path.join(macVariantsDir, "bright.png");
  fs.writeFileSync(desktopPath, "desktop");
  fs.writeFileSync(macPath, "mac");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: true });
  assert.equal(appIconManager.resolveVariantIconPath("bright", tmp), macPath);

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: false });
  assert.equal(appIconManager.resolveVariantIconPath("bright", tmp), desktopPath);
});

test("macOS leaves the Dock icon unchanged when its runtime original asset is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-mac-missing-"));
  const publicDir = path.join(tmp, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "icon.png"), "packaged-mac");
  fs.writeFileSync(path.join(publicDir, "icon-win.png"), "full-bleed");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: true });
  let dockSetCount = 0;
  const applied = appIconManager.applyAppIconVariant("original", {
    app: { isPackaged: false, dock: { setIcon() { dockSetCount += 1; } } },
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: {
      createFromBuffer: (buf) => ({ buffer: buf.toString() }),
      createFromPath: (p) => ({ path: p }),
    },
    appPath: tmp,
    isMac: true,
  });

  assert.equal(applied, false);
  assert.equal(dockSetCount, 0);
});

test("applyAppIconVariant updates current icon path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-apply-"));
  const publicDir = path.join(tmp, "public");
  const variantsDir = path.join(publicDir, "icons", "variants");
  fs.mkdirSync(variantsDir, { recursive: true });
  const originalPath = path.join(publicDir, "icon.png");
  const brightPath = path.join(variantsDir, "macos", "bright.png");
  fs.mkdirSync(path.dirname(brightPath), { recursive: true });
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
