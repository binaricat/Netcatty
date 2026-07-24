#!/usr/bin/env node
/* global process, console */
/**
 * Apply Netcatty's @xterm/addon-webgl glyph-atlas safety fixes.
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
 * Linux/Wayland GPU stacks can also corrupt dense terminal output into black
 * cell blocks when xterm generates mipmaps for the glyph atlas (#2158,
 * xtermjs/xterm.js#5986). Upstream fixed this in xtermjs/xterm.js#5987 by using
 * non-mipmapped linear filters. Apply that narrow fix to the currently pinned
 * beta so Netcatty does not need to absorb unrelated xterm beta changes.
 *
 * Idempotent. If the upstream code changes (e.g. an @xterm/addon-webgl upgrade)
 * and neither the expected target nor the upstream fixed form is found, fail
 * the install so a release cannot silently lose either protection.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ATLAS_MARKER = "/*netcatty:#1063 atlas-isolation*/";
const MIPMAP_MARKER = "/*netcatty:#2158 no-atlas-mipmaps*/";

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function filterSequence(gl) {
  return (
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_MIN_FILTER,${gl}.LINEAR),` +
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_MAG_FILTER,${gl}.LINEAR)`
  );
}

function mipmapPath(gl, pages, index) {
  const upload = `${gl}.texImage2D(${gl}.TEXTURE_2D,0,${gl}.RGBA,${gl}.RGBA,${gl}.UNSIGNED_BYTE,${pages}.pages[${index}].canvas),`;
  const version = `this._atlasTextures[${index}].version=${pages}.pages[${index}].version`;
  return {
    target: `${upload}${gl}.generateMipmap(${gl}.TEXTURE_2D),${version}`,
    replacement: `${upload}${MIPMAP_MARKER}${filterSequence(gl)},${version}`,
  };
}

function upstreamFixedPath(gl, pages, index) {
  return (
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_WRAP_T,${gl}.CLAMP_TO_EDGE),` +
    `${filterSequence(gl)},` +
    `${gl}.texImage2D(${gl}.TEXTURE_2D,0,${gl}.RGBA,${gl}.RGBA,${gl}.UNSIGNED_BYTE,${pages}.pages[${index}].canvas),` +
    `this._atlasTextures[${index}].version=${pages}.pages[${index}].version`
  );
}

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
    mipmapPaths: [
      mipmapPath("t", "r", "n"), // @xterm/addon-webgl@0.20.0-beta.219
      mipmapPath("t", "n", "s"), // @xterm/addon-webgl@0.19.0
    ],
    upstreamFixedPaths: [
      upstreamFixedPath("t", "r", "s"), // @xterm/addon-webgl@0.20.0-beta.276
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
    mipmapPaths: [
      mipmapPath("t", "e", "i"), // @xterm/addon-webgl@0.20.0-beta.219
      mipmapPath("e", "t", "i"), // @xterm/addon-webgl@0.19.0
    ],
    upstreamFixedPaths: [
      upstreamFixedPath("t", "e", "i"), // @xterm/addon-webgl@0.20.0-beta.276
    ],
  },
];

const atlas = { patched: 0, already: 0, missing: 0 };
const mipmap = { patched: 0, already: 0, upstream: 0, missing: 0 };

for (const { file, loops, mipmapPaths, upstreamFixedPaths } of TARGETS) {
  const abs = path.resolve(process.cwd(), file);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch {
    console.warn(`[patch-xterm-webgl-atlas] skip (not found): ${file}`);
    atlas.missing++;
    mipmap.missing++;
    continue;
  }
  let next = src;

  if (next.includes(ATLAS_MARKER)) {
    atlas.already++;
  } else {
    const loop = loops.find((candidate) => next.includes(candidate));
    if (loop) {
      next = next.replace(loop, ATLAS_MARKER);
      atlas.patched++;
    } else {
      console.warn(
        `[patch-xterm-webgl-atlas] ERROR: atlas-sharing loop not found in ${file}. ` +
          "Refresh the minified target strings before upgrading @xterm/addon-webgl (#1063).",
      );
      atlas.missing++;
    }
  }

  const markerCount = countOccurrences(next, MIPMAP_MARKER);
  const patchedMatches = mipmapPaths.reduce(
    (count, candidate) => count + countOccurrences(next, candidate.replacement),
    0,
  );
  const targetMatches = mipmapPaths.reduce(
    (count, candidate) => count + countOccurrences(next, candidate.target),
    0,
  );
  const upstreamMatches = upstreamFixedPaths.reduce(
    (count, candidate) => count + countOccurrences(next, candidate),
    0,
  );
  const hasMipmapCall = next.includes(".generateMipmap(");

  if (markerCount === 1 && patchedMatches === 1 && targetMatches === 0 && !hasMipmapCall) {
    mipmap.already++;
  } else if (markerCount === 0 && targetMatches === 1) {
    const candidate = mipmapPaths.find((path) => next.includes(path.target));
    next = next.replace(candidate.target, candidate.replacement);
    if (next.includes(".generateMipmap(")) {
      console.warn(
        `[patch-xterm-webgl-atlas] ERROR: another mipmap call remains in ${file}. ` +
          "Refresh the scoped target strings before upgrading @xterm/addon-webgl (#2158).",
      );
      mipmap.missing++;
    } else {
      mipmap.patched++;
    }
  } else if (
    markerCount === 0 &&
    targetMatches === 0 &&
    upstreamMatches === 1 &&
    !hasMipmapCall
  ) {
    // xtermjs/xterm.js#5987 is already present in the glyph-atlas upload path.
    mipmap.upstream++;
  } else {
    console.warn(
      `[patch-xterm-webgl-atlas] ERROR: glyph-atlas mipmap path is missing or ambiguous in ${file}. ` +
        "Confirm xtermjs/xterm.js#5987 before upgrading @xterm/addon-webgl (#2158).",
    );
    mipmap.missing++;
  }

  if (next !== src) fs.writeFileSync(abs, next);
}

console.log(
  `[patch-xterm-webgl-atlas] atlas: patched=${atlas.patched} already=${atlas.already} missing=${atlas.missing}; ` +
    `mipmap: patched=${mipmap.patched} already=${mipmap.already} upstream=${mipmap.upstream} missing=${mipmap.missing}`,
);

if (atlas.missing > 0 || mipmap.missing > 0) process.exitCode = 1;
