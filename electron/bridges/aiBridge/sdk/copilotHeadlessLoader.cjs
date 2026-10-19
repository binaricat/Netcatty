"use strict";

// The official Windows npm loader forwards arguments to this same native
// executable. Handing it directly to the SDK preserves windowsHide and makes
// the runtime itself the SDK-owned child for stop/forceStop.
const { existsSync } = require("fs");
const path = require("path");

function resolveCopilotPlatformExecutable(loaderPath) {
  const normalized = String(loaderPath || "").trim();
  if (!normalized) return null;
  const pkgName = `@github/copilot-${process.platform}-${process.arch}`;
  // Direct-layout candidate: <root>/node_modules/@github/copilot-<p>-<a>/
  // (works even when package.json is absent or exports change).
  const exeName = `copilot${process.platform === "win32" ? ".exe" : ""}`;
  // Resolution roots: the loader's directory (nested node_modules layout,
  // e.g. npm globals) and its grandparent (hoisted layout).
  const roots = [
    path.dirname(normalized),
    path.join(path.dirname(normalized), "..", ".."),
  ];
  for (const root of roots) {
    // Direct candidates: nested (root/node_modules/<pkg>) and hoisted sibling
    // (root/<pkg>) layouts - both work even when package.json is absent.
    for (const direct of [
      path.join(root, "node_modules", pkgName, exeName),
      path.join(root, pkgName, exeName),
    ]) {
      if (existsSync(direct)) return direct;
    }
    try {
      // Pure path resolution - require.resolve never loads the target, so a
      // package whose main is a native exe resolves to the exe path.
      const resolved = require.resolve(pkgName, { paths: [root] });
      if (resolved && existsSync(resolved)) return resolved;
    } catch { /* try next root */ }
  }
  return null;
}

module.exports = { resolveCopilotPlatformExecutable };
