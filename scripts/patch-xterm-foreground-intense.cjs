#!/usr/bin/env node
/* global process, console */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_VERSIONS = {
  xterm: "6.1.0-beta.292",
  "addon-webgl": "0.20.0-beta.291",
};

// Resolve the optional color only when rendering bold default-foreground cells.
// Buffer attributes and serialized terminal output stay unchanged. Converting
// renderer-local colors before inverse/decoration/selection processing lets the
// existing renderer handle their precedence, contrast and dimming normally.
const PATCHES = [
  {
    file: "xterm/lib/xterm.js",
    original: "t.foreground=m(e.foreground,d),t.background=",
    replacement: "t.foreground=m(e.foreground,d),t.foregroundIntense=m(e.foregroundIntense,void 0),t.background=",
  },
  {
    file: "xterm/lib/xterm.mjs",
    original: "t.foreground=M(e.foreground,qe),t.background=",
    replacement: "t.foreground=M(e.foreground,qe),t.foregroundIntense=M(e.foregroundIntense,void 0),t.background=",
  },
  {
    file: "xterm/lib/xterm.js",
    original: "let V=W.getFgColor(),q=W.getFgColorMode(),X=W.getBgColor(),Y=W.getBgColorMode();",
    replacement: "let V=W.getFgColor(),q=W.getFgColorMode(),X=W.getBgColor(),Y=W.getBgColorMode();if(q===0&&W.isBold()&&b.foregroundIntense){V=b.foregroundIntense.rgba>>>8;q=50331648;}",
  },
  {
    file: "xterm/lib/xterm.mjs",
    original: "let de=x.getFgColor(),Ft=x.getFgColorMode(),Se=x.getBgColor(),Ht=x.getBgColorMode(),Br=!!x.isInverse();",
    replacement: "let de=x.getFgColor(),Ft=x.getFgColorMode(),Se=x.getBgColor(),Ht=x.getBgColorMode(),Br=!!x.isInverse();if(Ft===0&&x.isBold()&&f.foregroundIntense){de=f.foregroundIntense.rgba>>>8;Ft=50331648;}",
  },
  {
    file: "addon-webgl/lib/addon-webgl.js",
    original: "this.result.fg=t.fg,this.result.ext=",
    replacement: "this.result.fg=t.isBold()&&t.getFgColorMode()===0&&this._themeService.colors.foregroundIntense?(t.fg&~67108863)|50331648|(this._themeService.colors.foregroundIntense.rgba>>>8):t.fg,this.result.ext=",
  },
  {
    file: "addon-webgl/lib/addon-webgl.mjs",
    original: "this.result.fg=e.fg,this.result.ext=",
    replacement: "this.result.fg=e.isBold()&&e.getFgColorMode()===0&&this._themeService.colors.foregroundIntense?(e.fg&~67108863)|50331648|(this._themeService.colors.foregroundIntense.rgba>>>8):e.fg,this.result.ext=",
  },
];

function patchXtermSource(source, patch) {
  // Some replacements contain the original. Check the fully patched shape
  // first, then reject any additional original occurrences in the remainder.
  const patchedCount = source.split(patch.replacement).length - 1;
  if (patchedCount === 1 && !source.replace(patch.replacement, "").includes(patch.original)) {
    return { source, changed: false };
  }
  const originalCount = source.split(patch.original).length - 1;
  if (patchedCount === 0 && originalCount === 1) {
    return { source: source.replace(patch.original, patch.replacement), changed: true };
  }
  throw new Error(`${patch.file}: unexpected foreground-intense patch shape (original=${originalCount}, patched=${patchedCount})`);
}

function patchInstalledXterm(root = process.cwd()) {
  const base = path.resolve(root, "node_modules/@xterm");
  for (const [name, expected] of Object.entries(EXPECTED_VERSIONS)) {
    const actual = JSON.parse(fs.readFileSync(path.join(base, name, "package.json"), "utf8")).version;
    if (actual !== expected) throw new Error(`unsupported @xterm/${name} version ${actual}; expected ${expected}`);
  }
  // Validate every bundle before writing any, so a changed dependency cannot
  // leave an installation with only one renderer patched.
  const files = new Map();
  let changed = 0;
  for (const patch of PATCHES) {
    const source = files.get(patch.file) ?? fs.readFileSync(path.join(base, patch.file), "utf8");
    const result = patchXtermSource(source, patch);
    files.set(patch.file, result.source);
    if (result.changed) changed++;
  }
  if (changed) {
    for (const [file, source] of files) fs.writeFileSync(path.join(base, file), source);
    fs.rmSync(path.resolve(root, "node_modules/.vite"), { recursive: true, force: true });
  }
  return { changed, checked: PATCHES.length };
}

if (require.main === module) {
  try {
    const result = patchInstalledXterm();
    console.log(`[patch-xterm-foreground-intense] changed=${result.changed} checked=${result.checked}`);
  } catch (error) {
    console.error(`[patch-xterm-foreground-intense] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_VERSIONS, PATCHES, patchXtermSource, patchInstalledXterm };
