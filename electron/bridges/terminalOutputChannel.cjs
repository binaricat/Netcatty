"use strict";

const TERMINAL_OUTPUT_PORT_CHANNEL = "netcatty:terminal-output-port";

function createTerminalOutputChannel(options = {}) {
  const MessageChannelMain = options.MessageChannelMain;
  const sessions = new Map();

  function closeEntry(entry) {
    try {
      entry?.port?.close?.();
    } catch {
      // Ignore close races while tearing down a terminal output route.
    }
  }

  function openSession(sessionId, webContents, openOptions = {}) {
    if (!sessionId || !webContents || typeof MessageChannelMain !== "function") {
      return false;
    }

    closeSession(sessionId);
    const { port1, port2 } = new MessageChannelMain();
    const transferToWorker = openOptions.transferToWorker === true;
    sessions.set(sessionId, {
      port: port1,
      webContentsId: webContents.id,
      transferToWorker,
    });
    webContents.postMessage(TERMINAL_OUTPUT_PORT_CHANNEL, { sessionId }, [port2]);
    return transferToWorker ? port1 : true;
  }

  function send(sessionId, data, meta) {
    if (!sessionId || !data) return false;
    const entry = sessions.get(sessionId);
    if (!entry || entry.transferToWorker) return false;
    entry.port.postMessage(meta ? { sessionId, data, meta } : { sessionId, data });
    return true;
  }

  function drainSession(sessionId, requestId) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.transferToWorker || !requestId) return false;
    try {
      entry.port.postMessage({ kind: "drain", sessionId, requestId });
      return true;
    } catch {
      return false;
    }
  }

  function closeSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    closeEntry(entry);
    sessions.delete(sessionId);
  }

  function closeAll() {
    for (const entry of sessions.values()) {
      closeEntry(entry);
    }
    sessions.clear();
  }

  return {
    openSession,
    send,
    drainSession,
    closeSession,
    closeAll,
    getSessionForTest: (sessionId) => sessions.get(sessionId),
  };
}

module.exports = {
  TERMINAL_OUTPUT_PORT_CHANNEL,
  createTerminalOutputChannel,
};
