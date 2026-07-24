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
 * Heavy TUIs can also fill more atlas pages than GlyphRenderer allocated WebGL
 * textures for (xtermjs/xterm.js#6038). The next render then dereferences a
 * missing texture and stops repainting even though terminal input and buffer
 * updates continue. Upstream fixed this in xtermjs/xterm.js#6043. Backport the
 * same capacity eviction to the pinned beta and clamp the upload loop as a
 * defensive last resort (#2455).
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
const CAPACITY_MARKER = "/*netcatty:#2455 atlas-capacity*/";
const CAPACITY_GUARD_MARKER = "/*netcatty:#2455 atlas-capacity-guard*/";
const CAPACITY_PATCH_VERSION = "0.20.0-beta.219";
const CAPACITY_SKIP_VERSIONS = new Set(["0.19.0"]);

const EVICT_METHOD =
  `_evictAllPages(){${CAPACITY_MARKER}` +
  "for(const page of this._pages)this._onRemoveTextureAtlasCanvas.fire(page.canvas),page.canvas.remove();" +
  "this._pages.length=0,this._activePages.length=0,this._overflowSizePage=void 0," +
  "this._cacheMap.clear(),this._cacheMapCombined.clear(),this._didWarmUp=!1,this._requestClearModel=!0}";
const CREATE_PAGE_METHOD = "_createNewPage(){";

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
    capacityPaths: {
      fallback:
        "if(a.length<4||a.some(T=>T.canvas.width!==a[0].canvas.width)){let T=new u0(this._document,this._textureSize);return this._pages.push(T),this._activePages.push(T),this._onAddTextureAtlasCanvas.fire(T.canvas),T}",
      overflow:
        "this._overflowSizePage||(this._overflowSizePage=new u0(this._document,this._config.deviceMaxTextureSize),this.pages.push(this._overflowSizePage),this._requestClearModel=!0,this._onAddTextureAtlasCanvas.fire(this._overflowSizePage.canvas))",
      render:
        "for(let s=0;s<this._atlas.pages.length;s++)this._atlas.pages[s].version!==this._atlasTextures[s].version",
      fallbackReplacement:
        "if(a.length<4||a.some(T=>T.canvas.width!==a[0].canvas.width)){this._evictAllPages();let T=new u0(this._document,this._textureSize);return this._pages.push(T),this._activePages.push(T),this._onAddTextureAtlasCanvas.fire(T.canvas),T}",
      overflowReplacement:
        "this._overflowSizePage||(i.maxAtlasPages&&this._pages.length>=i.maxAtlasPages&&this._evictAllPages(),this._overflowSizePage=new u0(this._document,this._config.deviceMaxTextureSize),this.pages.push(this._overflowSizePage),this._requestClearModel=!0,this._onAddTextureAtlasCanvas.fire(this._overflowSizePage.canvas))",
      renderReplacement:
        `${CAPACITY_GUARD_MARKER}for(let s=0;s<Math.min(this._atlas.pages.length,this._atlasTextures.length);s++)this._atlas.pages[s].version!==this._atlasTextures[s].version`,
    },
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
    capacityPaths: {
      fallback:
        "if(s.length<4||s.some(t=>t.canvas.width!==s[0].canvas.width)){const t=new Q(this._document,this._textureSize);return this._pages.push(t),this._activePages.push(t),this._onAddTextureAtlasCanvas.fire(t.canvas),t}",
      overflow:
        "this._overflowSizePage||(this._overflowSizePage=new Q(this._document,this._config.deviceMaxTextureSize),this.pages.push(this._overflowSizePage),this._requestClearModel=!0,this._onAddTextureAtlasCanvas.fire(this._overflowSizePage.canvas))",
      render:
        "for(let t=0;t<this._atlas.pages.length;t++)this._atlas.pages[t].version!==this._atlasTextures[t].version",
      fallbackReplacement:
        "if(s.length<4||s.some(t=>t.canvas.width!==s[0].canvas.width)){this._evictAllPages();const t=new Q(this._document,this._textureSize);return this._pages.push(t),this._activePages.push(t),this._onAddTextureAtlasCanvas.fire(t.canvas),t}",
      overflowReplacement:
        "this._overflowSizePage||(_.maxAtlasPages&&this._pages.length>=_.maxAtlasPages&&this._evictAllPages(),this._overflowSizePage=new Q(this._document,this._config.deviceMaxTextureSize),this.pages.push(this._overflowSizePage),this._requestClearModel=!0,this._onAddTextureAtlasCanvas.fire(this._overflowSizePage.canvas))",
      renderReplacement:
        `${CAPACITY_GUARD_MARKER}for(let t=0;t<Math.min(this._atlas.pages.length,this._atlasTextures.length);t++)this._atlas.pages[t].version!==this._atlasTextures[t].version`,
    },
  },
];

const atlas = { patched: 0, already: 0, missing: 0 };
const mipmap = { patched: 0, already: 0, upstream: 0, missing: 0 };
const capacity = { patched: 0, already: 0, skipped: 0, missing: 0 };

let webglVersion = "";
try {
  const packageJson = path.resolve(
    process.cwd(),
    "node_modules/@xterm/addon-webgl/package.json",
  );
  webglVersion = JSON.parse(fs.readFileSync(packageJson, "utf8")).version || "";
} catch {
  // Missing package metadata is handled as an unknown version below.
}

for (const { file, loops, mipmapPaths, upstreamFixedPaths, capacityPaths } of TARGETS) {
  const abs = path.resolve(process.cwd(), file);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch {
    console.warn(`[patch-xterm-webgl-atlas] skip (not found): ${file}`);
    atlas.missing++;
    mipmap.missing++;
    capacity.missing++;
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

  if (webglVersion === CAPACITY_PATCH_VERSION) {
    if (next.includes(CAPACITY_MARKER)) {
      const complete =
        next.includes(EVICT_METHOD) &&
        next.includes(capacityPaths.fallbackReplacement) &&
        next.includes(capacityPaths.overflowReplacement) &&
        next.includes(capacityPaths.renderReplacement) &&
        !next.includes(capacityPaths.fallback) &&
        !next.includes(capacityPaths.overflow) &&
        !next.includes(capacityPaths.render);
      if (complete) {
        capacity.already++;
      } else {
        console.warn(
          `[patch-xterm-webgl-atlas] ERROR: incomplete atlas-capacity patch in ${file}.`,
        );
        capacity.missing++;
      }
    } else {
      const exactTargets = [
        CREATE_PAGE_METHOD,
        capacityPaths.fallback,
        capacityPaths.overflow,
        capacityPaths.render,
      ];
      if (exactTargets.every((target) => countOccurrences(next, target) === 1)) {
        next = next.replace(CREATE_PAGE_METHOD, `${EVICT_METHOD}${CREATE_PAGE_METHOD}`);
        next = next.replace(capacityPaths.fallback, capacityPaths.fallbackReplacement);
        next = next.replace(capacityPaths.overflow, capacityPaths.overflowReplacement);
        next = next.replace(capacityPaths.render, capacityPaths.renderReplacement);
        capacity.patched++;
      } else {
        console.warn(
          `[patch-xterm-webgl-atlas] ERROR: atlas-capacity path is missing or ambiguous in ${file}. ` +
            "Refresh the scoped targets before changing @xterm/addon-webgl (#2455).",
        );
        capacity.missing++;
      }
    }
  } else if (CAPACITY_SKIP_VERSIONS.has(webglVersion)) {
    // Historical 0.19 branches still use this script. Do not make their npm
    // install fail for a backport that is intentionally scoped to beta.219.
    capacity.skipped++;
  } else {
    console.warn(
      `[patch-xterm-webgl-atlas] ERROR: unsupported @xterm/addon-webgl version ` +
        `${webglVersion || "(unknown)"} in ${file}. Confirm xtermjs/xterm.js#6043 ` +
        "before changing the pinned version (#2455).",
    );
    capacity.missing++;
  }

  if (next !== src) fs.writeFileSync(abs, next);
}

console.log(
  `[patch-xterm-webgl-atlas] atlas: patched=${atlas.patched} already=${atlas.already} missing=${atlas.missing}; ` +
    `mipmap: patched=${mipmap.patched} already=${mipmap.already} upstream=${mipmap.upstream} missing=${mipmap.missing}; ` +
    `capacity: patched=${capacity.patched} already=${capacity.already} skipped=${capacity.skipped} missing=${capacity.missing}`,
);

if (atlas.missing > 0 || mipmap.missing > 0 || capacity.missing > 0) process.exitCode = 1;
