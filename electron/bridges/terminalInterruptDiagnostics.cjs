"use strict";

const DEBUG_ENV_KEYS = [
  "NETCATTY_CTRL_C_DEBUG",
  "NETCATTY_TERMINAL_DEBUG",
];

function isEnvEnabled() {
  return DEBUG_ENV_KEYS.some((key) => process.env[key] === "1");
}

function normalizeTrace(payload = {}) {
  const trace = payload?.trace && typeof payload.trace === "object" ? payload.trace : null;
  if (!trace && !isEnvEnabled()) return null;
  const now = Date.now();
  return {
    debug: trace?.debug === true || isEnvEnabled(),
    traceId: typeof trace?.traceId === "string" && trace.traceId
      ? trace.traceId
      : `ctrlc-backend-${now.toString(36)}`,
    source: typeof trace?.source === "string" ? trace.source : "backend",
    sessionId: typeof trace?.sessionId === "string" ? trace.sessionId : payload?.sessionId,
    rendererKeyAt: Number.isFinite(trace?.rendererKeyAt) ? trace.rendererKeyAt : undefined,
    rendererSendAt: Number.isFinite(trace?.rendererSendAt) ? trace.rendererSendAt : undefined,
    rendererStatus: typeof trace?.rendererStatus === "string" ? trace.rendererStatus : undefined,
    rendererHasSelection: trace?.rendererHasSelection === true,
    rendererPriority: trace?.rendererPriority && typeof trace.rendererPriority === "object"
      ? trace.rendererPriority
      : undefined,
  };
}

function isTraceEnabled(trace) {
  return Boolean(trace?.debug || isEnvEnabled());
}

function getStreamState(stream) {
  if (!stream) return null;
  let isPaused;
  try {
    isPaused = typeof stream.isPaused === "function" ? stream.isPaused() : undefined;
  } catch {
    isPaused = undefined;
  }
  return {
    destroyed: Boolean(stream.destroyed),
    readableEnded: Boolean(stream.readableEnded),
    readableFlowing: stream.readableFlowing,
    isPaused,
    writableEnded: Boolean(stream.writableEnded),
    writableDestroyed: Boolean(stream.writableDestroyed),
    writableNeedDrain: Boolean(stream.writableNeedDrain),
  };
}

function getSessionSnapshot(session) {
  if (!session) return { exists: false };
  const flowState = session.flowState
    ? {
        rendererPaused: Boolean(session.flowState.rendererPaused),
        unackedBytes: Number(session.flowState.unackedBytes) || 0,
        appliedPause: Boolean(session.flowState.appliedPause),
      }
    : null;
  return {
    exists: true,
    type: session.type || null,
    protocol: session.protocol || null,
    hostname: session.hostname || null,
    hasStream: Boolean(session.stream),
    hasProc: Boolean(session.proc),
    hasSocket: Boolean(session.socket),
    hasSerialPort: Boolean(session.serialPort),
    stream: getStreamState(session.stream),
    flowState,
    pendingAutomatedWriteTimers: Array.isArray(session.pendingAutomatedWriteTimers)
      ? session.pendingAutomatedWriteTimers.length
      : 0,
    hasDiscardPendingData: typeof session.discardPendingData === "function",
    closed: Boolean(session.closed),
  };
}

function safeJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return nested.toString();
    if (typeof nested === "function") return "[function]";
    return nested;
  });
}

function logTerminalInterruptDebug(event, details = {}, trace = null) {
  if (!isTraceEnabled(trace)) return;
  const now = Date.now();
  const payload = {
    event,
    traceId: trace?.traceId,
    sessionId: trace?.sessionId || details.sessionId,
    at: now,
    deltaFromRendererKeyMs: Number.isFinite(trace?.rendererKeyAt)
      ? now - trace.rendererKeyAt
      : undefined,
    deltaFromRendererSendMs: Number.isFinite(trace?.rendererSendAt)
      ? now - trace.rendererSendAt
      : undefined,
    ...details,
  };
  try {
    console.info(`[Netcatty Ctrl+C] ${safeJson(payload)}`);
  } catch {
    // Diagnostics must never affect terminal control flow.
  }
}

function rememberInterruptTrace(session, trace) {
  if (!session || !trace) return;
  session.lastInterruptTrace = trace;
  session.lastInterruptTraceAt = Date.now();
}

function getRecentInterruptTrace(session, maxAgeMs = 10000) {
  if (!session?.lastInterruptTrace || !Number.isFinite(session.lastInterruptTraceAt)) return null;
  return Date.now() - session.lastInterruptTraceAt <= maxAgeMs ? session.lastInterruptTrace : null;
}

function logTerminalOutputDropSample(session, details = {}) {
  const trace = getRecentInterruptTrace(session);
  if (!trace || !isTraceEnabled(trace)) return;
  const now = Date.now();
  const bytes = Number(details.bytes) || 0;
  if (!session._interruptDropDiagnostics) {
    session._interruptDropDiagnostics = {
      count: 0,
      bytes: 0,
      lastLogAt: 0,
    };
  }
  const state = session._interruptDropDiagnostics;
  state.count += 1;
  state.bytes += bytes;
  const shouldLog = state.count === 1 || now - state.lastLogAt >= 500;
  if (!shouldLog) return;
  state.lastLogAt = now;
  logTerminalInterruptDebug("ssh-output-drop-while-paused", {
    ...details,
    dropCountSinceSessionStart: state.count,
    dropBytesSinceSessionStart: state.bytes,
    session: getSessionSnapshot(session),
  }, trace);
}

function logTerminalInterruptDrainDropSample(session, details = {}) {
  const trace = getRecentInterruptTrace(session);
  if (!trace || !isTraceEnabled(trace)) return;
  const now = Date.now();
  const bytes = Number(details.droppedBytes ?? details.bytes) || 0;
  if (!session._interruptDrainDiagnostics) {
    session._interruptDrainDiagnostics = {
      count: 0,
      bytes: 0,
      lastLogAt: 0,
    };
  }
  const state = session._interruptDrainDiagnostics;
  state.count += 1;
  state.bytes += bytes;
  const shouldLog = state.count === 1 || now - state.lastLogAt >= 500 || details.accepted === true;
  if (!shouldLog) return;
  state.lastLogAt = now;
  logTerminalInterruptDebug("ssh-output-drain-after-interrupt", {
    ...details,
    drainDropCountSinceInterrupt: state.count,
    drainDropBytesSinceInterrupt: state.bytes,
    session: getSessionSnapshot(session),
  }, trace);
}

function logTerminalFlowAckSample(session, details = {}) {
  const trace = getRecentInterruptTrace(session);
  if (!trace || !isTraceEnabled(trace)) return;
  const now = Date.now();
  const bytes = Number(details.bytes) || 0;
  if (!session._interruptAckDiagnostics) {
    session._interruptAckDiagnostics = {
      countSinceLastLog: 0,
      bytesSinceLastLog: 0,
      totalCount: 0,
      totalBytes: 0,
      lastLogAt: 0,
    };
  }
  const state = session._interruptAckDiagnostics;
  state.countSinceLastLog += 1;
  state.bytesSinceLastLog += bytes;
  state.totalCount += 1;
  state.totalBytes += bytes;

  const shouldLog = state.totalCount === 1 || now - state.lastLogAt >= 500;
  if (!shouldLog) return;

  const countSinceLastLog = state.countSinceLastLog;
  const bytesSinceLastLog = state.bytesSinceLastLog;
  state.countSinceLastLog = 0;
  state.bytesSinceLastLog = 0;
  state.lastLogAt = now;

  logTerminalInterruptDebug("flow-ack-sample", {
    ...details,
    ackCountSinceLastLog: countSinceLastLog,
    ackBytesSinceLastLog: bytesSinceLastLog,
    ackCountSinceInterrupt: state.totalCount,
    ackBytesSinceInterrupt: state.totalBytes,
    session: getSessionSnapshot(session),
  }, trace);
}

function logTerminalFlowPauseSample(session, details = {}) {
  const trace = getRecentInterruptTrace(session);
  if (!trace || !isTraceEnabled(trace)) return;
  const now = Date.now();
  if (!session._interruptPauseDiagnostics) {
    session._interruptPauseDiagnostics = {
      countSinceLastLog: 0,
      totalCount: 0,
      lastLogAt: 0,
    };
  }
  const state = session._interruptPauseDiagnostics;
  state.countSinceLastLog += 1;
  state.totalCount += 1;

  const shouldLog = state.totalCount === 1 || now - state.lastLogAt >= 500;
  if (!shouldLog) return;

  const countSinceLastLog = state.countSinceLastLog;
  state.countSinceLastLog = 0;
  state.lastLogAt = now;

  logTerminalInterruptDebug("flow-pause-sample", {
    ...details,
    pauseChangeCountSinceLastLog: countSinceLastLog,
    pauseChangeCountSinceInterrupt: state.totalCount,
    session: getSessionSnapshot(session),
  }, trace);
}

function resetTerminalFlowAckSample(session) {
  if (!session) return;
  session._interruptAckDiagnostics = null;
  session._interruptDrainDiagnostics = null;
  session._interruptPauseDiagnostics = null;
}

module.exports = {
  getSessionSnapshot,
  getRecentInterruptTrace,
  logTerminalFlowAckSample,
  logTerminalFlowPauseSample,
  logTerminalInterruptDrainDropSample,
  logTerminalInterruptDebug,
  logTerminalOutputDropSample,
  normalizeTrace,
  rememberInterruptTrace,
  resetTerminalFlowAckSample,
};
