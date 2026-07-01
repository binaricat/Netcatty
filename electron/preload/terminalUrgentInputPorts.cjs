"use strict";

const {
  TERMINAL_URGENT_INPUT_PORT_CHANNEL,
} = require("../bridges/terminalUrgentInputChannel.cjs");

function createTerminalUrgentInputPortRegistry(options = {}) {
  const {
    ipcRenderer,
    onPortError = console.error,
  } = options;
  let port = null;

  function closePort() {
    if (!port) return;
    try {
      port.close?.();
    } catch {
      // Ignore stale urgent-port close races while replacing a worker.
    }
    port = null;
  }

  function register() {
    ipcRenderer?.on?.(TERMINAL_URGENT_INPUT_PORT_CHANNEL, (event) => {
      closePort();
      const nextPort = event?.ports?.[0];
      if (!nextPort) return;
      port = nextPort;
      try {
        port.start?.();
      } catch {
        // Some Electron MessagePort implementations do not require start().
      }
    });
  }

  function postInterrupt(sessionId, trace) {
    if (!sessionId || !port) return false;
    try {
      port.postMessage({
        kind: "interrupt",
        sessionId,
        trace,
      });
      return true;
    } catch (err) {
      closePort();
      try {
        onPortError?.("Terminal urgent input port failed", err);
      } catch {
        // Diagnostics must not affect Ctrl+C fallback.
      }
      return false;
    }
  }

  return {
    register,
    postInterrupt,
    close: closePort,
    hasPortForTest: () => Boolean(port),
  };
}

module.exports = {
  createTerminalUrgentInputPortRegistry,
};
