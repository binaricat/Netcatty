"use strict";

const { trackEmitted } = require("./terminalFlowAck.cjs");
const {
  attachTerminalOutputPerfMeta,
  createTerminalOutputPerfMeta,
  logTerminalOutputPerf,
} = require("./terminalPerformanceDiagnostics.cjs");

let getSession = null;
let outputChannel = null;
let onSessionActivity = null;
/** @type {Set<(sessionId: string, data: string) => void>} */
const dataTaps = new Set();
const emitPerfLogStateBySession = new Map();

function configureTerminalSessionDataEmitter(options = {}) {
  getSession = typeof options.getSession === "function" ? options.getSession : null;
  outputChannel = options.outputChannel || null;
  onSessionActivity = typeof options.onSessionActivity === "function"
    ? options.onSessionActivity
    : null;
}

function addTerminalDataTap(listener) {
  if (typeof listener !== "function") return () => {};
  dataTaps.add(listener);
  return () => dataTaps.delete(listener);
}

function getEmitPerfLogDetails(sessionId, terminalPerf, options = {}) {
  if (!terminalPerf) return null;
  const key = sessionId || "__unknown__";
  const now = Date.now();
  const state = emitPerfLogStateBySession.get(key) || {
    lastLoggedAt: 0,
    batchChunks: 0,
    batchChars: 0,
    batchLineFeeds: 0,
  };

  state.batchChunks += 1;
  state.batchChars += terminalPerf.chars;
  state.batchLineFeeds += terminalPerf.lineFeeds;

  const shouldLog =
    state.lastLoggedAt === 0
    || state.batchChars >= 512 * 1024
    || state.batchLineFeeds >= 200
    || now - state.lastLoggedAt >= 1000;

  if (!shouldLog) {
    emitPerfLogStateBySession.set(key, state);
    return null;
  }

  const details = {
    id: terminalPerf.id,
    sessionId,
    chars: terminalPerf.chars,
    lineFeeds: terminalPerf.lineFeeds,
    batchChunks: state.batchChunks,
    batchChars: state.batchChars,
    batchLineFeeds: state.batchLineFeeds,
    cols: options?.cols,
    rows: options?.rows,
  };

  emitPerfLogStateBySession.set(key, {
    lastLoggedAt: now,
    batchChunks: 0,
    batchChars: 0,
    batchLineFeeds: 0,
  });
  return details;
}

function emitTerminalSessionData(contents, sessionId, data, options = {}) {
  const currentSession = getSession && sessionId ? getSession(sessionId) : null;
  if (options.session && currentSession !== options.session) return false;
  if (sessionId && data && onSessionActivity) {
    try {
      onSessionActivity({ sessionId, phase: "touch" });
    } catch {
      // Session activity tracking is best-effort and must not break output.
    }
  }
  if (currentSession && sessionId && data) {
    trackEmitted(currentSession, typeof data === "string" ? data.length : 0, sessionId);
  }
  if (sessionId && data) {
    for (const tap of dataTaps) {
      try {
        tap(sessionId, data);
      } catch (err) {
        console.warn("[emitTerminalSessionData] tap failed", err);
      }
    }
  }
  const terminalPerf = createTerminalOutputPerfMeta(sessionId, data);
  const meta = attachTerminalOutputPerfMeta(options?.meta, terminalPerf);
  const emitPerfDetails = getEmitPerfLogDetails(sessionId, terminalPerf, options);
  if (emitPerfDetails) {
    logTerminalOutputPerf("backend-emit", emitPerfDetails);
  }
  if (outputChannel?.send?.(sessionId, data, meta)) return true;
  const generation = options.session?._terminalSessionGeneration;
  contents?.send("netcatty:data", {
    sessionId,
    data,
    ...(meta ? { meta } : {}),
    ...(Number.isSafeInteger(generation) ? { _terminalSessionGeneration: generation } : {}),
  });
  return true;
}

module.exports = {
  configureTerminalSessionDataEmitter,
  emitTerminalSessionData,
  addTerminalDataTap,
};
