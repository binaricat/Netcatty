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
// Keep the outer span exactly on the grid. When wider fallback glyphs would
// extend into the next cell, compress the complete shaped text horizontally
// in an inner span. Keep the untouched text together for browser bidi/shaping,
// and avoid measuring DOM layout during rendering: xterm's existing spacing
// calculation already supplies the difference from the cached natural width.
const patches = [
  { file: "xterm.js", joined: "H", chars: "$", span: "w", width: "y*_", spacing: "k", rows: "m" },
  { file: "xterm.mjs", joined: "fi", chars: "_i", span: "I", width: "Rr*h", spacing: "Ot", rows: "p" },
].map(({ file, joined, chars, span, width, spacing, rows }) => {
  const defaultSpacing = `${spacing}!==this.defaultSpacing&&(${span}.style.letterSpacing=\`\${${spacing}}px\`)`;
  const original = `,${defaultSpacing},${rows}.push(${span}),`;
  const replacement = [
    `;if(${joined}&&${rtl}.test(${chars})){`,
    `const allocated=${width};${span}.style.width=allocated+"px";${span}.style.letterSpacing="0px";`,
    `if(${spacing}<0&&allocated>0){`,
    'const run=this._document.createElement("span");',
    `run.textContent=${span}.textContent;`,
    'run.style.transformOrigin="left center";',
    `run.style.transform="scaleX("+allocated/(allocated-${spacing})+")";`,
    `${span}.replaceChildren(run);`,
    `}}else{${defaultSpacing}}${rows}.push(${span}),`,
  ].join("");
  return [file, original, replacement];
});

function patchJoinedWidth(source, original, replacement) {
  if (source.split(replacement).length === 2 && !source.replace(replacement, "").includes(original)) return source;
  if (source.split(original).length !== 2) throw new Error("unexpected xterm joined-width patch anchor");
  return source.replace(original, replacement);
}

function patchInstalledXterm(root = process.cwd()) {
  const base = path.resolve(root, "node_modules/@xterm/xterm");
  const version = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).version;
  if (version !== VERSION) throw new Error(`unsupported @xterm/xterm ${version}; expected ${VERSION}`);
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
