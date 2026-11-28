"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PRELOAD_BUNDLE_FILENAME = "preload.bundle.cjs";
const PRELOAD_SOURCE_FILENAME = "preload.cjs";

function isBundledPreloadPath(preloadPath) {
  return (
    typeof preloadPath === "string"
    && path.basename(preloadPath) === PRELOAD_BUNDLE_FILENAME
  );
}

/**
 * Prefer the single-file esbuild preload bundle (which runs with sandbox: true).
 * Fall back to the multi-file source preload.cjs if the bundle has not been
 * generated yet (e.g., direct source execution or unit test fixtures).
 */
function resolvePreloadPath(electronDir = __dirname) {
  const bundled = path.join(electronDir, PRELOAD_BUNDLE_FILENAME);
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return path.join(electronDir, PRELOAD_SOURCE_FILENAME);
}

/**
 * Derive sandbox and additionalArguments for a BrowserWindow webPreferences
 * block. Bundled preload requires zero Node.js runtime in the renderer process,
 * saving ~10-14 MiB Private_Dirty per window while keeping getWindowsPtyInfo()
 * working via `--netcatty-os-release=...`.
 */
function resolvePreloadWebPreferences(preloadPath) {
  return {
    sandbox: isBundledPreloadPath(preloadPath),
    additionalArguments: [`--netcatty-os-release=${os.release()}`],
  };
}

module.exports = {
  PRELOAD_BUNDLE_FILENAME,
  PRELOAD_SOURCE_FILENAME,
  isBundledPreloadPath,
  resolvePreloadPath,
  resolvePreloadWebPreferences,
};
