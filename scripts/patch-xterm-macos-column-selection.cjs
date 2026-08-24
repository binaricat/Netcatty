#!/usr/bin/env node
/* global process, console */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_XTERM_VERSION = "6.1.0-beta.292";
const FORCE_SELECTION_OPTION = "macOptionClickForcesSelection";
const META_OPTION = "macOptionIsMeta".padEnd(FORCE_SELECTION_OPTION.length, " ");

// xterm normally treats macOptionClickForcesSelection and column selection as
// mutually exclusive. Netcatty needs both when Option is not Meta: Option must
// keep forcing local selection inside mouse-aware programs, and that local
// selection must retain the standard macOS rectangular shape. Patch the pinned
// bundles at install time and fail closed if upstream changes the expected code
// shape.
const PATCHES = [
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js",
    original: "!(f.isMac&&this._optionsService.rawOptions.macOptionClickForcesSelection)",
    replacement: `!(f.isMac&&this._optionsService.rawOptions.${META_OPTION})`,
    preserveLength: true,
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs",
    original: "!(ie&&this._optionsService.rawOptions.macOptionClickForcesSelection)",
    replacement: `!(ie&&this._optionsService.rawOptions.${META_OPTION})`,
    preserveLength: true,
  },
  {
    file: "node_modules/@xterm/xterm/src/browser/services/SelectionService.ts",
    original: "return event.altKey && !(Browser.isMac && this._optionsService.rawOptions.macOptionClickForcesSelection);",
    replacement: `return event.altKey && !(Browser.isMac && this._optionsService.rawOptions.${META_OPTION});`,
    preserveStatementLength: true,
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js.map",
    original: "return event.altKey && !(Browser.isMac && this._optionsService.rawOptions.macOptionClickForcesSelection);",
    replacement: `return event.altKey && !(Browser.isMac && this._optionsService.rawOptions.${META_OPTION});`,
    preserveStatementLength: true,
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs.map",
    original: "return event.altKey && !(Browser.isMac && this._optionsService.rawOptions.macOptionClickForcesSelection);",
    replacement: `return event.altKey && !(Browser.isMac && this._optionsService.rawOptions.${META_OPTION});`,
    preserveStatementLength: true,
  },
];

function sameLengthExpression(expression, length) {
  if (expression.length > length) throw new Error("replacement expression is too long");
  // Keep generated bundle offsets stable so the shipped source maps remain valid.
  return `${expression}${" ".repeat(length - expression.length)}`;
}

function sameLengthStatement(statement, length) {
  if (!statement.endsWith(";") || statement.length > length) {
    throw new Error("replacement statement cannot preserve the target length");
  }
  return `${statement.slice(0, -1)}${" ".repeat(length - statement.length)};`;
}

function replacementForPatch(patch) {
  if (!patch.replacement) throw new Error(`missing replacement for ${patch.file}`);
  if (patch.preserveLength) {
    return sameLengthExpression(patch.replacement, patch.original.length);
  }
  if (patch.preserveStatementLength) {
    return sameLengthStatement(patch.replacement, patch.original.length);
  }
  return patch.replacement;
}

function patchXtermSource(source, patch) {
  const replacement = replacementForPatch(patch);

  const originalCount = source.split(patch.original).length - 1;
  const patchedCount = source.split(replacement).length - 1;
  if (originalCount === 1 && patchedCount === 0) {
    return { source: source.replace(patch.original, replacement), changed: true };
  }
  if (originalCount === 0 && patchedCount === 1) {
    return { source, changed: false };
  }
  throw new Error(
    `${patch.file}: expected exactly one original or patched selection predicate ` +
      `(original=${originalCount}, patched=${patchedCount})`,
  );
}

/**
 * @param {string} root
 * @param {Pick<typeof fs, "rmSync">} fsImpl
 */
function invalidateViteCache(root = process.cwd(), fsImpl = fs) {
  const cachePath = path.resolve(root, "node_modules/.vite");
  fsImpl.rmSync(cachePath, { recursive: true, force: true });
  return cachePath;
}

function patchInstalledXterm(root = process.cwd()) {
  const packageJsonPath = path.resolve(root, "node_modules/@xterm/xterm/package.json");
  const version = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
  if (version !== EXPECTED_XTERM_VERSION) {
    throw new Error(
      `unsupported @xterm/xterm version ${version}; expected ${EXPECTED_XTERM_VERSION}`,
    );
  }

  let changed = 0;
  for (const patch of PATCHES) {
    const absolutePath = path.resolve(root, patch.file);
    const source = fs.readFileSync(absolutePath, "utf8");
    const result = patchXtermSource(source, patch);
    if (result.changed) {
      fs.writeFileSync(absolutePath, result.source);
      changed++;
    }
  }
  const viteCachePath = invalidateViteCache(root);
  return { changed, checked: PATCHES.length, version, viteCachePath };
}

if (require.main === module) {
  try {
    const result = patchInstalledXterm();
    console.log(
      `[patch-xterm-macos-column-selection] version=${result.version} ` +
        `changed=${result.changed} checked=${result.checked} vite-cache=invalidated`,
    );
  } catch (error) {
    console.error(`[patch-xterm-macos-column-selection] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_XTERM_VERSION,
  PATCHES,
  invalidateViteCache,
  patchInstalledXterm,
  patchXtermSource,
  replacementForPatch,
  sameLengthExpression,
  sameLengthStatement,
};
