#!/usr/bin/env node
/* global console, process */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// xterm 6.1 beta applies a joined run's *total* width correction as
// letter-spacing, which Chromium can apply once per glyph. Joined cells are
// already sized in terminal columns; use that width instead of changing the
// text spacing (which can also interfere with contextual shaping).
const VERSION = "6.1.0-beta.292";
// Share the terminalBidiJoiner gate. Scope this fix to the new RTL
// shaping path; leave the existing ASCII font-ligature renderer unchanged.
const rtl = new RegExp(require("../lib/terminalRtlCharacter.json"), "u");
const patches = [
  ["xterm.js", "k!==this.defaultSpacing&&(w.style.letterSpacing=`\${k}px`)",
    `H&&${rtl}.test($)?(w.style.width=\`\${y*_}px\`,w.style.letterSpacing="0px",w.style.overflow="clip"):k!==this.defaultSpacing&&(w.style.letterSpacing=\`\${k}px\`)`],
  ["xterm.mjs", "Ot!==this.defaultSpacing&&(I.style.letterSpacing=`\${Ot}px`)",
    `fi&&${rtl}.test(_i)?(I.style.width=\`\${Rr*h}px\`,I.style.letterSpacing="0px",I.style.overflow="clip"):Ot!==this.defaultSpacing&&(I.style.letterSpacing=\`\${Ot}px\`)`],
];

function patchJoinedWidth(source, original, replacement) {
  if (source.split(replacement).length === 2 && !source.replace(replacement, "").includes(original)) return source;
  if (source.split(original).length !== 2) throw new Error("unexpected xterm joined-width patch anchor");
  return source.replace(original, replacement);
}

function patchInstalledXterm(root = process.cwd()) {
  const base = path.resolve(root, "node_modules/@xterm/xterm");
  const version = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).version;
  if (version !== VERSION) throw new Error(`unsupported @xterm/xterm \${version}; expected \${VERSION}`);
  const files = patches.map(([file, original, replacement]) => {
    const filename = path.join(base, "lib", file);
    const source = fs.readFileSync(filename, "utf8");
    return [filename, source, patchJoinedWidth(source, original, replacement)];
  });
  for (const [filename, source, patched] of files) {
    if (source !== patched) fs.writeFileSync(filename, patched);
  }
  if (files.some(([, source, patched]) => source !== patched)) {
    fs.rmSync(path.resolve(root, "node_modules/.vite"), { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { patchInstalledXterm(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { patchInstalledXterm };
