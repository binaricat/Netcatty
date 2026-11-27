"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PRELOAD_BUNDLE_FILENAME,
  PRELOAD_SOURCE_FILENAME,
  isBundledPreloadPath,
  resolvePreloadPath,
  resolvePreloadWebPreferences,
} = require("./preloadPath.cjs");

test("resolvePreloadPath prefers preload.bundle.cjs when present and falls back to preload.cjs", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-preload-path-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  assert.equal(resolvePreloadPath(dir), path.join(dir, PRELOAD_SOURCE_FILENAME));
  assert.equal(isBundledPreloadPath(path.join(dir, PRELOAD_SOURCE_FILENAME)), false);

  const bundlePath = path.join(dir, PRELOAD_BUNDLE_FILENAME);
  await fs.promises.writeFile(bundlePath, "// bundle\n");
  assert.equal(resolvePreloadPath(dir), bundlePath);
  assert.equal(isBundledPreloadPath(bundlePath), true);
});

test("resolvePreloadWebPreferences enables sandbox for bundled preload and passes os release", () => {
  const bundledPrefs = resolvePreloadWebPreferences("/app/electron/preload.bundle.cjs");
  assert.equal(bundledPrefs.sandbox, true);
  assert.deepEqual(bundledPrefs.additionalArguments, [`--netcatty-os-release=${os.release()}`]);

  const sourcePrefs = resolvePreloadWebPreferences("/app/electron/preload.cjs");
  assert.equal(sourcePrefs.sandbox, false);
  assert.deepEqual(sourcePrefs.additionalArguments, [`--netcatty-os-release=${os.release()}`]);
});
