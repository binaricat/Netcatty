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
 * string patch on the minified build, like patch-xterm-webgl-atlas.cjs. The
 * exact package version and complete refreshRows method are checked so an xterm
 * upgrade or minifier change fails installation rather than mispatching code.
 *
 * Idempotent. Both builds are validated before either is replaced.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "/*netcatty:sync-render*/";
const EXPECTED_VERSION = "6.1.0-beta.220";
const VERSION_FILE = "node_modules/@xterm/xterm/package.json";

const TARGETS = [
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js",
    from: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),i?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
    to: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),(i||r)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs",
    from: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),r?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
    to: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),(r||o)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
  },
];

let already = 0;
let upstream = 0;
let missing = 0;
const writes = [];

const count = (source, value) => source.split(value).length - 1;
const warnInvalid = (file, detail) => {
  console.warn(`[patch-xterm-sync-render] ERROR: ${detail} in ${file}. ` +
    "Refresh the exact target before upgrading @xterm/xterm.");
  missing++;
};

try {
  const versionPath = path.resolve(process.cwd(), VERSION_FILE);
  const version = JSON.parse(fs.readFileSync(versionPath, "utf8")).version;
  if (version !== EXPECTED_VERSION) {
    warnInvalid(VERSION_FILE, `expected version ${EXPECTED_VERSION}, found ${version}`);
  }
} catch {
  warnInvalid(VERSION_FILE, "package version is missing or invalid");
}

for (const { file, from, to } of TARGETS) {
  const abs = path.resolve(process.cwd(), file);
  let source;
  let stat;
  try {
    source = fs.readFileSync(abs, "utf8");
    stat = fs.statSync(abs);
  } catch {
    warnInvalid(file, "target is missing");
    continue;
  }

  const marked = `${to.slice(0, -1)}${MARKER}}`;
  const markerMatches = count(source, MARKER);
  const targetMatches = count(source, from);
  const upstreamMatches = count(source, to);
  if (markerMatches === 1 && count(source, marked) === 1) {
    already++;
  } else if (markerMatches === 0 && targetMatches === 1 && upstreamMatches === 0) {
    writes.push({ abs, file, mode: stat.mode, source, output: source.replace(from, marked) });
  } else if (markerMatches === 0 && targetMatches === 0 && upstreamMatches === 1) {
    upstream++;
  } else {
    warnInvalid(file, "complete sync-render method was not found exactly once");
  }
}

let patched = 0;
if (missing === 0 && writes.length > 0) {
  const staged = [];
  const committed = [];
  try {
    for (const write of writes) {
      const temp = `${write.abs}.netcatty-${process.pid}-${staged.length}.tmp`;
      fs.writeFileSync(temp, write.output, { encoding: "utf8", flag: "wx", mode: write.mode });
      staged.push({ ...write, temp });
    }
    for (const write of staged) {
      fs.renameSync(write.temp, write.abs);
      committed.push(write);
    }
    patched = committed.length;
  } catch (error) {
    console.warn(`[patch-xterm-sync-render] ERROR: atomic replacement failed: ${error.message}`);
    missing++;
    for (const write of committed.reverse()) {
      try {
        const rollback = `${write.abs}.netcatty-${process.pid}-rollback.tmp`;
        fs.writeFileSync(rollback, write.source, { encoding: "utf8", flag: "wx", mode: write.mode });
        fs.renameSync(rollback, write.abs);
      } catch (rollbackError) {
        console.warn(`[patch-xterm-sync-render] ERROR: rollback failed for ${write.file}: ${rollbackError.message}`);
      }
    }
  } finally {
    for (const write of staged) {
      try {
        fs.rmSync(write.temp, { force: true });
      } catch {}
    }
  }
}

console.log(
  `[patch-xterm-sync-render] patched=${patched} already=${already} upstream=${upstream} missing=${missing}`,
);

if (missing > 0) process.exitCode = 1;
