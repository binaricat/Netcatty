#!/usr/bin/env node
/* global process, console */
/**
 * Render each completed DEC 2026 synchronized-output frame immediately.
 *
 * xterm normally routes a mode-close refresh through requestAnimationFrame.
 * If the next synchronized frame starts before that callback, rendering is
 * suppressed until xterm's one-second safety timeout. This patch marks the
 * mode-close refresh as synchronous and carries that signal to RenderService.
 * It also renders a flushed synchronized-output buffer synchronously, matching
 * the pending upstream proposal for frames split across input chunks.
 *
 * Upstream: https://github.com/xtermjs/xterm.js/pull/6073. Applied to the
 * installed minified builds like patch-xterm-webgl-atlas.cjs. The exact package
 * version and complete surrounding expressions are checked. Both CJS and ESM
 * builds are validated and staged before either is atomically replaced.
 *
 * Idempotent.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_VERSION = "6.1.0-beta.220";
const VERSION_FILE = "node_modules/@xterm/xterm/package.json";
const REFRESH_MARKER = "/*netcatty:sync-render*/";
const LISTENER_MARKER = "/*netcatty:sync-render-listener*/";
const CLOSE_MARKER = "/*netcatty:sync-render-close*/";

const markedMethod = (value) => `${value.slice(0, -1)}${REFRESH_MARKER}}`;
const markedExpression = (value, marker) => `${value}${marker}`;

const TARGETS = [
  {
    file: "node_modules/@xterm/xterm/lib/xterm.js",
    edits: [
      {
        from: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),i?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
        to: "refreshRows(e,t,i=!1,s=!1){if(this._isPaused)return void(this._needsFullRefresh=!0);if(this._coreService.decPrivateModes.synchronizedOutput)return void this._syncOutputHandler.bufferRows(e,t);const r=this._syncOutputHandler.flush();r&&(e=Math.min(e,r.start),t=Math.max(t,r.end)),s||(this._isNextRenderRedrawOnly=!1),(i||r)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
        mark: markedMethod,
      },
      {
        from: "this._register(this._inputHandler.onRequestRefreshRows(e=>this.refresh(e?.start??0,e?.end??this.rows-1)))",
        to: "this._register(this._inputHandler.onRequestRefreshRows(e=>this.refresh(e?.start??0,e?.end??this.rows-1,e?.sync??!1)))",
        mark: (value) => markedExpression(value, LISTENER_MARKER),
      },
      {
        from: "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire(void 0);break",
        to: "case 2026:this._coreService.decPrivateModes.synchronizedOutput?(this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire({sync:!0})):this._onRequestRefreshRows.fire(void 0);break",
        mark: (value) => markedExpression(value, CLOSE_MARKER),
        legacy: [
          "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire({sync:!0});break/*netcatty:sync-render-close*/",
        ],
      },
    ],
  },
  {
    file: "node_modules/@xterm/xterm/lib/xterm.mjs",
    edits: [
      {
        from: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),r?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
        to: "refreshRows(e,t,r=!1,s=!1){if(this._isPaused){this._needsFullRefresh=!0;return}if(this._coreService.decPrivateModes.synchronizedOutput){this._syncOutputHandler.bufferRows(e,t);return}let o=this._syncOutputHandler.flush();o&&(e=Math.min(e,o.start),t=Math.max(t,o.end)),s||(this._isNextRenderRedrawOnly=!1),(r||o)?this._renderRows(e,t):this._renderDebouncer.refresh(e,t,this._rowCount)}",
        mark: markedMethod,
      },
      {
        from: "this._register(this._inputHandler.onRequestRefreshRows(t=>this.refresh(t?.start??0,t?.end??this.rows-1)))",
        to: "this._register(this._inputHandler.onRequestRefreshRows(t=>this.refresh(t?.start??0,t?.end??this.rows-1,t?.sync??!1)))",
        mark: (value) => markedExpression(value, LISTENER_MARKER),
      },
      {
        from: "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire(void 0);break",
        to: "case 2026:this._coreService.decPrivateModes.synchronizedOutput?(this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire({sync:!0})):this._onRequestRefreshRows.fire(void 0);break",
        mark: (value) => markedExpression(value, CLOSE_MARKER),
        legacy: [
          "case 2026:this._coreService.decPrivateModes.synchronizedOutput=!1,this._onRequestRefreshRows.fire({sync:!0});break/*netcatty:sync-render-close*/",
        ],
      },
    ],
  },
];

let already = 0;
let upstream = 0;
let missing = 0;
const writes = [];

const count = (source, value) => source.split(value).length - 1;
const warnInvalid = (file, detail) => {
  console.warn(`[patch-xterm-sync-render] ERROR: ${detail} in ${file}. ` +
    "Refresh the exact targets before upgrading @xterm/xterm.");
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

for (const target of TARGETS) {
  const abs = path.resolve(process.cwd(), target.file);
  let source;
  let stat;
  try {
    source = fs.readFileSync(abs, "utf8");
    stat = fs.statSync(abs);
  } catch {
    warnInvalid(target.file, "target is missing");
    continue;
  }

  let output = source;
  let markedEdits = 0;
  let upstreamEdits = 0;
  let pendingEdits = 0;
  let invalid = false;
  for (const edit of target.edits) {
    const marked = edit.mark(edit.to);
    const markedMatches = count(source, marked);
    const fromMatches = count(source, edit.from);
    const toMatches = count(source, edit.to);
    const legacyMatches = edit.legacy?.filter((value) => count(source, value) > 0) ?? [];
    const legacy = legacyMatches.find((value) => count(source, value) === 1);
    if (markedMatches === 1) {
      markedEdits++;
    } else if (legacy && legacyMatches.length === 1 && fromMatches === 0 && toMatches === 0) {
      output = output.replace(legacy, marked);
      pendingEdits++;
    } else if (fromMatches === 1 && toMatches === 0) {
      output = output.replace(edit.from, marked);
      pendingEdits++;
    } else if (fromMatches === 0 && toMatches === 1) {
      upstreamEdits++;
    } else {
      invalid = true;
      break;
    }
  }

  if (invalid || (upstreamEdits > 0 && upstreamEdits !== target.edits.length)) {
    warnInvalid(target.file, "complete synchronized-render contexts were not found in one consistent state");
  } else if (upstreamEdits === target.edits.length) {
    upstream++;
  } else if (markedEdits === target.edits.length) {
    already++;
  } else if (markedEdits + pendingEdits === target.edits.length && pendingEdits > 0) {
    writes.push({ abs, file: target.file, mode: stat.mode, source, output });
  } else {
    warnInvalid(target.file, "synchronized-render edits were incomplete");
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
