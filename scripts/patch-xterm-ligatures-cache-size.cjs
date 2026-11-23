#!/usr/bin/env node
/* global process, console */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_VERSION = "0.11.0-beta.292";

// @xterm/addon-ligatures 0.11.0-beta.292 bundles lru-cache v11, which requires
// sizeCalculation to return a positive integer (>= 1). Upstream passes
// `(val, key) => key.length`, which returns 0 for empty terminal lines ("")
// and throws `TypeError: sizeCalculation return invalid (expect positive integer)`
// on every render/refresh touching an empty row.
const PATCHES = [
  {
    file: "node_modules/@xterm/addon-ligatures/lib/addon-ligatures.js",
    original: "new u.LRUCache({maxSize:t.cacheSize,sizeCalculation:(e,t)=>t.length})",
    replacement: "new u.LRUCache({maxSize:t.cacheSize,sizeCalculation:(e,t)=>t.length||1})",
  },
  {
    file: "node_modules/@xterm/addon-ligatures/lib/addon-ligatures.mjs",
    original: "new Ri({maxSize:p.cacheSize,sizeCalculation:((O,w)=>w.length)})",
    replacement: "new Ri({maxSize:p.cacheSize,sizeCalculation:((O,w)=>w.length||1)})",
  },
  {
    file: "node_modules/@xterm/addon-ligatures/src/fontLigatures/index.ts",
    original: "sizeCalculation: ((val: ILigatureData | [number, number][], key: string) => key.length) as any",
    replacement: "sizeCalculation: ((val: ILigatureData | [number, number][], key: string) => key.length || 1) as any",
  },
];

function patchXtermSource(source, patch) {
  const originalCount = source.split(patch.original).length - 1;
  const patchedCount = source.split(patch.replacement).length - 1;
  if (originalCount === 1 && patchedCount === 0) {
    return { source: source.replace(patch.original, patch.replacement), changed: true };
  }
  if (originalCount === 0 && patchedCount === 1) {
    return { source, changed: false };
  }
  throw new Error(
    `${patch.file}: unexpected ligatures cache-size patch shape ` +
      `(original=${originalCount}, patched=${patchedCount})`,
  );
}

function patchInstalledLigaturesCacheSize(root = process.cwd()) {
  const packageJsonPath = path.resolve(root, "node_modules/@xterm/addon-ligatures/package.json");
  const version = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
  if (version !== EXPECTED_VERSION) {
    throw new Error(`unsupported @xterm/addon-ligatures version ${version}; expected ${EXPECTED_VERSION}`);
  }

  // Validate all files before writing any to avoid partially patched installs.
  const results = PATCHES.map((patch) => ({
    file: path.resolve(root, patch.file),
    ...patchXtermSource(fs.readFileSync(path.resolve(root, patch.file), "utf8"), patch),
  }));
  const changed = results.filter((result) => result.changed);
  for (const result of changed) fs.writeFileSync(result.file, result.source);
  if (changed.length) {
    fs.rmSync(path.resolve(root, "node_modules/.vite"), { recursive: true, force: true });
  }
  return { changed: changed.length, checked: PATCHES.length, version };
}

if (require.main === module) {
  try {
    const result = patchInstalledLigaturesCacheSize();
    console.log(
      `[patch-xterm-ligatures-cache-size] version=${result.version} changed=${result.changed} checked=${result.checked}`,
    );
  } catch (error) {
    console.error(`[patch-xterm-ligatures-cache-size] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_VERSION,
  PATCHES,
  patchXtermSource,
  patchInstalledLigaturesCacheSize,
};
