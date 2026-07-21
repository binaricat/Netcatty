"use strict";

const { TERMINAL_OUTPUT_PORT_CHANNEL } = require("../bridges/terminalOutputChannel.cjs");

function createTerminalOutputPortRegistry(options = {}) {
  const {
    ipcRenderer,
    deliverToListeners,
    filterData = null,
    closedTerminalDataSessions = new Set(),
    onPortError = console.error,
    onDrain = null,
  } = options;
  const ports = new Map();

  function closeSession(sessionId) {
    const port = ports.get(sessionId);
    if (!port) return;
    try {
      port.close?.();
    } catch {
      // Ignore close races while replacing or closing output ports.
    }
    ports.delete(sessionId);
  }

  function registerPort(sessionId, port) {
    if (!sessionId || !port) return;
    closeSession(sessionId);
    ports.set(sessionId, port);
    port.onmessage = (event) => {
      const message = event?.data || {};
      const targetSessionId = message.sessionId || sessionId;
      if (message.kind === "drain" && message.requestId) {
        onDrain?.(targetSessionId, message.requestId);
        return;
      }
      if (closedTerminalDataSessions.has(targetSessionId)) return;
      if (!message.data) return;
      try {
        const filtered = typeof filterData === "function"
          ? filterData(targetSessionId, message.data, message)
          : message.data;
        const data = filtered && typeof filtered === "object" && "data" in filtered
          ? filtered.data
          : filtered;
        const meta = filtered && typeof filtered === "object" && "data" in filtered
          ? filtered.meta
          : message.meta;
        if (data) deliverToListeners?.(targetSessionId, data, meta);
      } catch (err) {
        onPortError("Terminal output port callback failed", err);
      }
    };
  }

  function register() {
    ipcRenderer?.on?.(TERMINAL_OUTPUT_PORT_CHANNEL, (event, payload) => {
      registerPort(payload?.sessionId, event?.ports?.[0]);
    });
  }

  return {
    register,
    closeSession,
    closeAll() {
      for (const sessionId of Array.from(ports.keys())) {
        closeSession(sessionId);
      }
    },
    hasSessionForTest: (sessionId) => ports.has(sessionId),
  };
}

module.exports = {
  createTerminalOutputPortRegistry,
};
