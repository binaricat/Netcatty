#!/usr/bin/env node
/* global process, console */
/**
 * Disable @xterm/addon-webgl's cross-terminal texture-atlas sharing.
 *
 * xterm's WebGL addon shares ONE TextureAtlas across terminal instances whose
 * config (font / size / theme / device-pixel-ratio) is equal — see
 * `acquireTextureAtlas`, which does `if (configEquals) { ownedBy.push; return
 * atlas }`. In a split workspace two panes then share an atlas, so clearing or
 * rebuilding it for one pane (which netcatty does on resize / DPR change / font
 * change / tab show to recover from glyph corruption) corrupts the OTHER pane's
 * rendering — the persistent "花屏 / garbled" report in issue #1063, most
 * visible in split view where both panes stay on screen.
 *
 * Fix: give every terminal its own atlas by removing the "reuse a matching
 * atlas" loop, so each terminal falls through to creating its own. The published
 * package is minified, so we string-replace the exact loop in both the CJS and
 * ESM builds. This runs from `postinstall` (after patch-package).
 *
 * Idempotent. If the upstream code changes (e.g. an @xterm/addon-webgl upgrade)
 * the loop won't be found; we warn loudly but do not fail the install, and the
 * strings below must then be refreshed for the new version.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "/*netcatty:#1063 atlas-isolation*/";

// Exact (minified) "reuse a shared atlas" loops. Keep the previous stable
// package strings so old release branches still get the #1063 protection.
const TARGETS = [
  {
    file: "node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs",
    loops: [
      // @xterm/addon-webgl@0.20.0-beta.219
      "for(let u=0;u<J.length;u++){let p=J[u];if(Ee(p.config,h))return p.ownedBy.push(i),p.atlas}",
      // @xterm/addon-webgl@0.19.0
      "for(let h=0;h<le.length;h++){let f=le[h];if(Mi(f.config,u))return f.ownedBy.push(i),f.atlas}",
    ],
  },
  {
    file: "node_modules/@xterm/addon-webgl/lib/addon-webgl.js",
    loops: [
      // @xterm/addon-webgl@0.20.0-beta.219
      "for(let e=0;e<a.length;e++){const i=a[e];if((0,r.configEquals)(i.config,c))return i.ownedBy.push(t),i.atlas}",
      // @xterm/addon-webgl@0.19.0
      "for(let t=0;t<r.length;t++){const i=r[t];if((0,n.configEquals)(i.config,d))return i.ownedBy.push(e),i.atlas}",
    ],
  },
];

let patched = 0;
let already = 0;
let missing = 0;

for (const { file, loops } of TARGETS) {
  const abs = path.resolve(process.cwd(), file);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch {
    console.warn(`[patch-xterm-webgl-atlas] skip (not found): ${file}`);
    missing++;
    continue;
  }
  if (src.includes(MARKER)) {
    already++;
    continue;
  }
  const loop = loops.find((candidate) => src.includes(candidate));
  if (!loop) {
    console.warn(
      `[patch-xterm-webgl-atlas] WARNING: atlas-sharing loop not found in ${file}. ` +
        "@xterm/addon-webgl likely changed — split-view WebGL may garble again (#1063). " +
        "Refresh the minified target strings in scripts/patch-xterm-webgl-atlas.cjs.",
    );
    missing++;
    continue;
  }
  fs.writeFileSync(abs, src.replace(loop, MARKER));
  patched++;
}

console.log(
  `[patch-xterm-webgl-atlas] atlas isolation: patched=${patched} already=${already} missing=${missing}`,
);
