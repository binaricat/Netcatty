"use strict";

const {
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
} = require("../../infrastructure/config/terminalFlowConstants.cjs");

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
    };
  }
  const state = session.flowState;
  state.rendererPaused = Boolean(state.rendererPaused);
  state.unackedBytes = Number.isFinite(state.unackedBytes) ? Math.max(0, state.unackedBytes) : 0;
  state.bufferedBytes = Number.isFinite(state.bufferedBytes) ? Math.max(0, state.bufferedBytes) : 0;
  state.appliedPause = Boolean(state.appliedPause);
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
    applyPause(session, target);
    state.appliedPause = true;
    return;
  }

  if (state.appliedPause && shouldResume) {
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

function trackEmitted(session, bytes) {
  if (!session || !Number.isFinite(bytes) || bytes <= 0) return;
  const state = ensureFlowState(session);
  state.unackedBytes += bytes;
  reconcileSessionFlow(session);
}

function trackAck(session, bytes) {
  if (!session || !Number.isFinite(bytes) || bytes <= 0) return;
  const state = ensureFlowState(session);
  state.unackedBytes = Math.max(0, state.unackedBytes - bytes);
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
