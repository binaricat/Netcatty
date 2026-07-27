#!/usr/bin/env node
/* global process, console */
/**
 * Render a DEC 2026 synchronized-output frame the moment it closes, instead of
 * on the next debounced tick.
 *
 * xterm's RenderService buffers rows while synchronized output is on and, on
 * close, requests a refresh that is scheduled through the render debouncer
 * (requestAnimationFrame). Under a continuous full-screen animation the next
 * frame opens a new 2026 block before that rAF fires, and `_renderRows` skips
 * while sync is on — so the debounced paint is dropped and the frame only
 * appears when the 1000ms synchronized-output timeout expires. The display is
 * then pinned at ~1fps however fast frames arrive.
 *
 * The fix renders synchronously when a synchronized-output buffer was just
 * flushed. `refreshRows(...,sync,...)` normally does
 * `sync ? _renderRows(...) : _renderDebouncer.refresh(...)`; we widen the
 * condition to also render synchronously when the flush returned buffered rows
 * (the local holding `_syncOutputHandler.flush()`). At that point the mode is
 * already off, so the completed frame paints before the next can reopen it.
 *
 * Upstream: https://github.com/xtermjs/xterm.js (fix pending). Applied here as a
 * string patch on the minified build, like patch-xterm-webgl-atlas.cjs, so a
 * version bump that moves the target surfaces as an install failure rather than
 * silently losing the fix.
 *
 * Idempotent.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "/*netcatty:sync-render*/";

// The minified `sync ? _renderRows(a,b) : _renderDebouncer.refresh(a,b,c)`
// ternary, and the `buffered` local to widen it with. Token names differ
// between the CJS and ESM builds, so each target names its own.
const TARGETS = [
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js",
    // const r = flush(); ... i ? _renderRows(e,t) : _renderDebouncer.refresh(e,t,this._rowCount)
    from: "i?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
    to: "(i||r)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs",
    // let o = flush(); ... r ? _renderRows(e,t) : _renderDebouncer.refresh(e,t,this._rowCount)
    from: "r?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
    to: "(r||o)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)",
  },
];

let patched = 0;
let already = 0;
let upstream = 0;
let missing = 0;

for (const { file, from, to } of TARGETS) {
  const abs = path.resolve(process.cwd(), file);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch {
    console.warn(`[patch-xterm-sync-render] skip (not found): ${file}`);
    missing++;
    continue;
  }
  const withMarker = to + MARKER;
  const markerMatches = src.split(MARKER).length - 1;
  const targetMatches = src.split(from).length - 1;
  const upstreamMatches = src.split(to).length - 1;
  if (markerMatches === 1 && src.includes(withMarker)) {
    already++;
    continue;
  }
  if (markerMatches === 0 && targetMatches === 1 && upstreamMatches === 0) {
    fs.writeFileSync(abs, src.replace(from, withMarker), "utf8");
    patched++;
  } else if (markerMatches === 0 && targetMatches === 0 && upstreamMatches === 1) {
    // The exact upstream fixed form is already present without Netcatty's
    // marker. Leave it untouched so an xterm upgrade can retire this patch.
    upstream++;
  } else {
    console.warn(
      `[patch-xterm-sync-render] ERROR: sync-render ternary not found (or ambiguous) in ${file}. ` +
        "Refresh the minified target before upgrading @xterm/xterm.",
    );
    missing++;
  }
}

console.log(
  `[patch-xterm-sync-render] patched=${patched} already=${already} upstream=${upstream} missing=${missing}`,
);

if (missing > 0) process.exitCode = 1;
