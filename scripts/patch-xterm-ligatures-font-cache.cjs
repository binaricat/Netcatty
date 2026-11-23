#!/usr/bin/env node
/* global process, console */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_VERSION = "0.11.0-beta.292";

// Keep the pinned loaders intact inside a module-level promise cache. Sharing
// the in-flight load avoids repeating font blob reads and GSUB parsing for each
// terminal. Rejected loads are evicted so permission/parse failures can retry.
// enableLigatures always uses the same cacheSize, so the CSS family is the key.
const CJS_LOAD = 'async function(e,t){var n,s;if(!a){if("undefined"!=typeof navigator&&"fonts"in navigator){try{const e=await(null===(s=(n=navigator.permissions).request)||void 0===s?void 0:s.call(n,{name:"local-fonts"}));if(e&&"granted"!==e.state)throw new Error("Permission to access local fonts not granted.")}catch(e){if(e instanceof Error&&"TypeError"!==e.name)throw e}const e={};try{const t=await navigator.fonts.query();for(const n of t)e.hasOwnProperty(n.family)||(e[n.family]=[]),e[n.family].push(n);a=Promise.resolve(e)}catch(e){e instanceof Error&&console.error(e.name,e.message)}}else if("undefined"!=typeof window&&"queryLocalFonts"in window){const e={};try{const t=await window.queryLocalFonts();for(const n of t)e.hasOwnProperty(n.family)||(e[n.family]=[]),e[n.family].push(n);a=Promise.resolve(e)}catch(e){e instanceof Error&&console.error(e.name,e.message)}}null!=a||(a=Promise.resolve({}))}const l=await a;for(const n of(0,o.default)(e)){if(i.includes(n))return;if(l.hasOwnProperty(n)&&l[n].length>0){const e=l[n][0];if("blob"in e){const n=await e.blob(),s=await n.arrayBuffer();return(0,r.loadBuffer)(s,{cacheSize:t})}return}}}';
const ESM_LOAD = 'async function(g,f){if(!zn){if(typeof navigator<"u"&&"fonts"in navigator){try{let y=await navigator.permissions.request?.({name:"local-fonts"});if(y&&y.state!=="granted")throw new Error("Permission to access local fonts not granted.")}catch(y){if(y instanceof Error&&y.name!=="TypeError")throw y}let h={};try{let y=await navigator.fonts.query();for(let k of y)h.hasOwnProperty(k.family)||(h[k.family]=[]),h[k.family].push(k);zn=Promise.resolve(h)}catch(y){y instanceof Error&&console.error(y.name,y.message)}}else if(typeof window<"u"&&"queryLocalFonts"in window){let h={};try{let y=await window.queryLocalFonts();for(let k of y)h.hasOwnProperty(k.family)||(h[k.family]=[]),h[k.family].push(k);zn=Promise.resolve(h)}catch(y){y instanceof Error&&console.error(y.name,y.message)}}zn??=Promise.resolve({})}let p=await zn;for(let h of Or(g)){if(ih.includes(h))return;if(p.hasOwnProperty(h)&&p[h].length>0){let y=p[h][0];if("blob"in y){let T=await(await y.blob()).arrayBuffer();return Hi(T,{cacheSize:f})}return}}}';
const SOURCE_LOAD = `let fontsPromise: Promise<Record<string, IFontMetadata[]>> | undefined = undefined;

/**
 * Loads the font ligature wrapper for the specified font family if it could be
 * resolved, throwing if it is unable to find a suitable match.
 * @param fontFamily The CSS font family definition to resolve
 * @param cacheSize The size of the ligature cache to maintain if the font is resolved
 */
export default async function load(fontFamily: string, cacheSize: number): Promise<Font | undefined> {`;

function cachedLoader(load) {
  return `(()=>{const cache=new Map();const load=${load};return function(fontFamily,cacheSize){if(cache.has(fontFamily))return cache.get(fontFamily);const promise=load(fontFamily,cacheSize);cache.set(fontFamily,promise);promise.catch(()=>{if(cache.get(fontFamily)===promise)cache.delete(fontFamily)});return promise}})()`;
}

const PATCHES = [
  {
    file: "node_modules/@xterm/addon-ligatures/lib/addon-ligatures.js",
    original: `t.default=${CJS_LOAD};const r=n(431),o=s(n(838));`,
    replacement: `t.default=${cachedLoader(CJS_LOAD)};const r=n(431),o=s(n(838));`,
  },
  {
    file: "node_modules/@xterm/addon-ligatures/lib/addon-ligatures.mjs",
    original: `${ESM_LOAD.replace("async function(", "async function Ir(")}var ih=`,
    replacement: `const Ir=${cachedLoader(ESM_LOAD)};var ih=`,
  },
  {
    file: "node_modules/@xterm/addon-ligatures/src/font.ts",
    original: SOURCE_LOAD,
    replacement: SOURCE_LOAD.replace(
      "\n\n/**",
      "\nconst fontCache = new Map<string, Promise<Font | undefined>>();\n\n/**",
    ).replace(
      "export default async function load(fontFamily: string, cacheSize: number): Promise<Font | undefined> {",
      `export default function load(fontFamily: string, cacheSize: number): Promise<Font | undefined> {
  if (fontCache.has(fontFamily)) {
    return fontCache.get(fontFamily)!;
  }
  const promise = loadUncached(fontFamily, cacheSize);
  fontCache.set(fontFamily, promise);
  promise.catch(() => {
    if (fontCache.get(fontFamily) === promise) {
      fontCache.delete(fontFamily);
    }
  });
  return promise;
}

async function loadUncached(fontFamily: string, cacheSize: number): Promise<Font | undefined> {`,
    ),
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
    `${patch.file}: unexpected ligatures font-cache patch shape ` +
      `(original=${originalCount}, patched=${patchedCount})`,
  );
}

function patchInstalledLigatures(root = process.cwd()) {
  const packageJsonPath = path.resolve(root, "node_modules/@xterm/addon-ligatures/package.json");
  const version = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
  if (version !== EXPECTED_VERSION) {
    throw new Error(`unsupported @xterm/addon-ligatures version ${version}; expected ${EXPECTED_VERSION}`);
  }

  // Validate all files before writing any to avoid partially patched installs.
  const results = PATCHES.map(patch => ({
    file: path.resolve(root, patch.file),
    ...patchXtermSource(fs.readFileSync(path.resolve(root, patch.file), "utf8"), patch),
  }));
  const changed = results.filter(result => result.changed);
  for (const result of changed) fs.writeFileSync(result.file, result.source);
  if (changed.length) {
    fs.rmSync(path.resolve(root, "node_modules/.vite"), { recursive: true, force: true });
  }
  return { changed: changed.length, checked: PATCHES.length, version };
}

if (require.main === module) {
  try {
    const result = patchInstalledLigatures();
    console.log(`[patch-xterm-ligatures-font-cache] version=${result.version} changed=${result.changed} checked=${result.checked}`);
  } catch (error) {
    console.error(`[patch-xterm-ligatures-font-cache] ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_VERSION, PATCHES, patchXtermSource, patchInstalledLigatures };
