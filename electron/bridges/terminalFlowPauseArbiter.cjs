"use strict";

const { randomUUID } = require("node:crypto");

function createTerminalFlowPauseArbiter(options = {}) {
  const createLeaseId = options.createLeaseId || randomUUID;
  const states = new Map();

  const getState = (sessionId) => {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        directPauseSenders: new Set(),
        leases: new Map(),
      };
      states.set(sessionId, state);
    }
    return state;
  };

  const isPaused = (state) => (
    state.directPauseSenders.size > 0 || state.leases.size > 0
  );

  const cleanup = (sessionId, state) => {
    if (!isPaused(state)) states.delete(sessionId);
  };

  return {
    setDirectPaused(sessionId, senderId, paused) {
      const state = getState(sessionId);
      if (paused) state.directPauseSenders.add(senderId);
      else state.directPauseSenders.delete(senderId);
      const effectivePaused = isPaused(state);
      cleanup(sessionId, state);
      return effectivePaused;
    },

    acquire(sessionId, senderId) {
      const state = getState(sessionId);
      const leaseId = createLeaseId();
      state.leases.set(leaseId, senderId);
      return { leaseId, paused: true };
    },

    owns(sessionId, senderId, leaseId) {
      return states.get(sessionId)?.leases.get(leaseId) === senderId;
    },

    release(sessionId, senderId, leaseId, options = {}) {
      const state = states.get(sessionId);
      if (!state || state.leases.get(leaseId) !== senderId) {
        return { success: false, paused: state ? isPaused(state) : false };
      }
      state.leases.delete(leaseId);
      if (options.keepPaused) state.directPauseSenders.add(senderId);
      const paused = isPaused(state);
      cleanup(sessionId, state);
      return { success: true, paused };
    },

    clearSender(senderId) {
      const changed = [];
      for (const [sessionId, state] of states) {
        const before = isPaused(state);
        state.directPauseSenders.delete(senderId);
        for (const [leaseId, ownerId] of state.leases) {
          if (ownerId === senderId) state.leases.delete(leaseId);
        }
        const paused = isPaused(state);
        if (before !== paused) changed.push({ sessionId, paused });
        cleanup(sessionId, state);
      }
      return changed;
    },

    clearSession(sessionId) {
      states.delete(sessionId);
    },

    reset() {
      states.clear();
    },
  };
}

module.exports = { createTerminalFlowPauseArbiter };
