#!/usr/bin/env node
"use strict";

// Backport xterm.js #6069 without moving the coordinated xterm beta versions.
const fs = require("node:fs");
const path = require("node:path");

const release = 'this._gl.getExtension("WEBGL_lose_context")?.loseContext()';
const anchors = {
  "addon-webgl.js": "this._canvas.parentElement?.removeChild(this._canvas),(0,r.removeTerminalFromCache)(this._terminal)",
  "addon-webgl.mjs": "this._canvas.parentElement?.removeChild(this._canvas),be(this._terminal)",
};

function patchContextRelease(source, anchor) {
  if (source.includes(`${anchor},${release}`)) return source;
  // Refuse an unknown build rather than silently skipping the resource fix.
  if (source.split(anchor).length !== 2) {
    throw new Error("Unknown WebGL renderer teardown; review the context-release backport");
  }
  return source.replace(anchor, `${anchor},${release}`);
}

function main() {
  // Validate both formats before writing either one.
  const builds = Object.entries(anchors).map(([name, anchor]) => {
    const file = path.resolve("node_modules/@xterm/addon-webgl/lib", name);
    const source = fs.readFileSync(file, "utf8");
    return { file, source, patched: patchContextRelease(source, anchor) };
  });
  for (const { file, source, patched } of builds) {
    if (source !== patched) fs.writeFileSync(file, patched);
  }
  console.log("[patch-xterm-webgl-context] context release verified in both builds");
}

if (require.main === module) main();
module.exports = { patchContextRelease, anchors };
