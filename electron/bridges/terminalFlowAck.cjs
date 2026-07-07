"use strict";

const {
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
} = require("../../infrastructure/config/terminalFlowConstants.cjs");
const { logTerminalOutputPerf } = require("./terminalPerformanceDiagnostics.cjs");

function getFlowTarget(session) {
  return session?.stream || session?.proc || session?.socket || session?.serialPort || null;
}

function ensureFlowState(session) {
  if (!session.flowState) {
    session.flowState = {
      rendererPaused: false,
      unackedBytes: 0,
      bufferedBytes: 0,
      appliedPause: false,
      outputPaused: false,
      firstUnackedAt: 0,
      lastEmittedAt: 0,
      lastAckAt: 0,
      lastPerfAckLogAt: 0,
      sessionId: null,
    };
  }
  const state = session.flowState;
  state.rendererPaused = Boolean(state.rendererPaused);
  state.unackedBytes = Number.isFinite(state.unackedBytes) ? Math.max(0, state.unackedBytes) : 0;
  state.bufferedBytes = Number.isFinite(state.bufferedBytes) ? Math.max(0, state.bufferedBytes) : 0;
  state.appliedPause = Boolean(state.appliedPause);
  state.firstUnackedAt = Number.isFinite(state.firstUnackedAt) ? Math.max(0, state.firstUnackedAt) : 0;
  state.lastEmittedAt = Number.isFinite(state.lastEmittedAt) ? Math.max(0, state.lastEmittedAt) : 0;
  state.lastAckAt = Number.isFinite(state.lastAckAt) ? Math.max(0, state.lastAckAt) : 0;
  state.lastPerfAckLogAt = Number.isFinite(state.lastPerfAckLogAt) ? Math.max(0, state.lastPerfAckLogAt) : 0;
  state.sessionId = typeof state.sessionId === "string" && state.sessionId ? state.sessionId : null;
  if (typeof state.outputPaused !== "boolean") {
    state.outputPaused = state.appliedPause && (state.rendererPaused || state.unackedBytes >= FLOW_HIGH_WATER_MARK);
  }
  return session.flowState;
}

function applyPause(session, target) {
  try {
    target.pause?.();
  } catch (err) {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn("Flow control pause failed", err);
    }
  }
}

function applyResume(session, target) {
  try {
    target.resume?.();
  } catch (err) {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn("Flow control resume failed", err);
    }
  }
}

function getFlowPerfDetails(session, extra = {}) {
  const state = ensureFlowState(session);
  return {
    sessionId: state.sessionId || session?.id || session?.sessionId || null,
    protocol: session?.protocol || session?.type || null,
    rendererPaused: state.rendererPaused,
    outputPaused: state.outputPaused,
    appliedPause: state.appliedPause,
    unackedBytes: state.unackedBytes,
    bufferedBytes: state.bufferedBytes,
    highWaterMark: FLOW_HIGH_WATER_MARK,
    lowWaterMark: FLOW_LOW_WATER_MARK,
    ...extra,
  };
}

function rememberSessionId(state, sessionId) {
  if (typeof sessionId === "string" && sessionId) {
    state.sessionId = sessionId;
  }
}

// NOTE on FLOW_HIGH_WATER_MARK size (issue #1961): for SSH sessions the flow
// target is the ssh2 channel, so pause() stops the remote until resume() plus a
// full round-trip. The watermark is kept near ssh2's own 2MB channel window
// (WINDOW_THRESHOLD 1MB); a small watermark pauses/resumes dozens of times
// during a multi-MB dump (e.g. `tail -2000f big.log`) and adds ~1 RTT per cycle
// on WAN links, which is what made those dumps crawl.
function reconcileSessionFlow(session) {
  if (!session) return;
  const state = ensureFlowState(session);
  const target = getFlowTarget(session);
  if (!target) return;

  if (!state.outputPaused && (state.rendererPaused || state.unackedBytes >= FLOW_HIGH_WATER_MARK)) {
    state.outputPaused = true;
  } else if (state.outputPaused && !state.rendererPaused && state.unackedBytes <= FLOW_LOW_WATER_MARK) {
    state.outputPaused = false;
  }

  const pendingBytes = state.unackedBytes + state.bufferedBytes;
  const shouldPause = state.outputPaused || pendingBytes >= FLOW_HIGH_WATER_MARK;
  const shouldResume = !state.outputPaused && pendingBytes <= FLOW_LOW_WATER_MARK;

  if (!state.appliedPause && shouldPause) {
    logTerminalOutputPerf("backend-flow-pause", getFlowPerfDetails(session, { pendingBytes }));
    applyPause(session, target);
    state.appliedPause = true;
    return;
  }

  if (state.appliedPause && shouldResume) {
    logTerminalOutputPerf("backend-flow-resume", getFlowPerfDetails(session, { pendingBytes }));
    applyResume(session, target);
    state.appliedPause = false;
  }
}

function setRendererFlowPaused(session, paused) {
  if (!session) return;
  const state = ensureFlowState(session);
  state.rendererPaused = Boolean(paused);
  reconcileSessionFlow(session);
}

function trackEmitted(session, bytes, sessionId) {
  if (!session || !Number.isFinite(bytes) || bytes <= 0) return;
  const state = ensureFlowState(session);
  rememberSessionId(state, sessionId);
  const now = Date.now();
  if (state.unackedBytes === 0) {
    state.firstUnackedAt = now;
  }
  state.lastEmittedAt = now;
  state.unackedBytes += bytes;
  reconcileSessionFlow(session);
}

function trackAck(session, bytes, sessionId) {
  if (!session || !Number.isFinite(bytes) || bytes <= 0) return;
  const state = ensureFlowState(session);
  rememberSessionId(state, sessionId);
  const now = Date.now();
  const unackedBefore = state.unackedBytes;
  state.unackedBytes = Math.max(0, state.unackedBytes - bytes);
  state.lastAckAt = now;
  const ackAgeMs = state.firstUnackedAt ? now - state.firstUnackedAt : 0;
  if (
    unackedBefore > 0
    && (
      now - state.lastPerfAckLogAt >= 1000
      || (
        state.unackedBytes === 0
        && (ackAgeMs >= 250 || unackedBefore >= 64 * 1024)
      )
    )
  ) {
    state.lastPerfAckLogAt = now;
    logTerminalOutputPerf("backend-flow-ack", getFlowPerfDetails(session, {
      bytes,
      unackedBefore,
      unackedAfter: state.unackedBytes,
      ackAgeMs,
      sinceLastEmitMs: state.lastEmittedAt ? now - state.lastEmittedAt : null,
    }));
  }
  if (state.unackedBytes === 0) {
    state.firstUnackedAt = 0;
  }
  reconcileSessionFlow(session);
}

function setBufferedOutputBytes(session, bytes) {
  if (!session) return;
  const state = ensureFlowState(session);
  state.bufferedBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  reconcileSessionFlow(session);
}

function shouldAcceptSessionOutput(session) {
  if (!session) return true;
  const state = ensureFlowState(session);
  return !state.outputPaused;
}

function isTransferSentryActive(transferSentry) {
  try {
    return Boolean(transferSentry?.isActive?.());
  } catch {
    return false;
  }
}

function shouldProcessSessionOutput(session, transferSentry) {
  return Boolean(session) || isTransferSentryActive(transferSentry);
}

function clearSessionFlowState(session, options = {}) {
  if (!session?.flowState) return;
  const target = getFlowTarget(session);
  if (session.flowState.appliedPause && target && options.resume !== false) {
    applyResume(session, target);
  }
  session.flowState = {
    rendererPaused: false,
    unackedBytes: 0,
    bufferedBytes: 0,
    appliedPause: false,
    outputPaused: false,
    firstUnackedAt: 0,
    lastEmittedAt: 0,
    lastAckAt: 0,
    lastPerfAckLogAt: 0,
    sessionId: null,
  };
}

module.exports = {
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
  setRendererFlowPaused,
  setBufferedOutputBytes,
  trackEmitted,
  trackAck,
  shouldAcceptSessionOutput,
  shouldProcessSessionOutput,
  clearSessionFlowState,
  reconcileSessionFlow,
};
