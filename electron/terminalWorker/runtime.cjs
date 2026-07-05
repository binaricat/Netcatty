"use strict";

const {
  logTerminalInterruptDebug,
  normalizeTrace,
} = require("../bridges/terminalInterruptDiagnostics.cjs");

function createIpcMainHarness() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
  };
}

function normalizeMessageEvent(eventOrMessage) {
  if (eventOrMessage && typeof eventOrMessage === "object" && "data" in eventOrMessage) {
    return {
      message: eventOrMessage.data,
      ports: eventOrMessage.ports || [],
    };
  }
  return {
    message: eventOrMessage,
    ports: eventOrMessage?.ports || [],
  };
}

function createOutputPortRegistry(parentPort) {
  const outputPorts = new Map();

  function closeSession(sessionId) {
    const port = outputPorts.get(sessionId);
    if (!port) return;
    outputPorts.delete(sessionId);
    try {
      port.close?.();
    } catch {
      // Ignore close races while tearing down a worker-owned output port.
    }
  }

  function post(sessionId, data, meta) {
    const port = outputPorts.get(sessionId);
    if (!port) return false;
    try {
      port.postMessage(meta ? { sessionId, data, meta } : { sessionId, data });
      return true;
    } catch {
      closeSession(sessionId);
      return false;
    }
  }

  function open(sessionId, port, bufferedOutput = []) {
    if (!sessionId || !port) return;
    closeSession(sessionId);
    outputPorts.set(sessionId, port);
    try {
      port.start?.();
    } catch {
      // Some Electron MessagePort implementations do not require start().
    }
    for (const chunk of bufferedOutput || []) {
      const data = chunk && typeof chunk === "object" && "data" in chunk ? chunk.data : chunk;
      const meta = chunk && typeof chunk === "object" ? chunk.meta : undefined;
      post(sessionId, data, meta);
    }
    parentPort.postMessage({ kind: "output-port-ready", sessionId });
  }

  function flush(sessionId, chunks = []) {
    for (const chunk of chunks || []) {
      const data = chunk && typeof chunk === "object" && "data" in chunk ? chunk.data : chunk;
      const meta = chunk && typeof chunk === "object" ? chunk.meta : undefined;
      if (!post(sessionId, data, meta)) {
        parentPort.postMessage(meta ? { kind: "output", sessionId, data, meta } : { kind: "output", sessionId, data });
      }
    }
  }

  return {
    open,
    post,
    flush,
    closeSession,
  };
}

function addPortMessageListener(port, callback) {
  if (typeof port?.on === "function") {
    port.on("message", callback);
    return;
  }
  if (port) {
    port.onmessage = callback;
  }
}

function createUrgentInputPortRegistry(dispatch) {
  const ports = new Map();

  function close(webContentsId) {
    const port = ports.get(webContentsId);
    if (!port) return;
    ports.delete(webContentsId);
    try {
      port.close?.();
    } catch {
      // Ignore stale urgent input port close races.
    }
  }

  function open(webContentsId, port) {
    if (!webContentsId || !port) return;
    close(webContentsId);
    ports.set(webContentsId, port);
    addPortMessageListener(port, (eventOrMessage) => {
      const { message } = normalizeMessageEvent(eventOrMessage);
      dispatch(webContentsId, message);
    });
    try {
      port.start?.();
    } catch {
      // Some Electron MessagePort implementations do not require start().
    }
  }

  function closeAll() {
    for (const webContentsId of Array.from(ports.keys())) {
      close(webContentsId);
    }
  }

  return {
    open,
    closeAll,
  };
}

function createSender(parentPort, webContentsId, outputPorts) {
  return {
    id: webContentsId,
    isDestroyed() {
      return false;
    },
    send(channel, payload) {
      if (channel === "netcatty:data") {
        const tapMessage = {
          kind: "output-tap",
          sessionId: payload?.sessionId,
          data: payload?.data,
        };
        if (payload?.meta) tapMessage.meta = payload.meta;
        parentPort.postMessage(tapMessage);
        if (outputPorts?.post?.(payload?.sessionId, payload?.data, payload?.meta)) {
          return;
        }
        const outputMessage = {
          kind: "output",
          sessionId: payload?.sessionId,
          data: payload?.data,
          // The output-tap message above already notified main-process taps
          // for this chunk; flag the fallback delivery so the worker manager
          // does not notify them a second time (would double-write session
          // logs and script output buffers).
          tapped: true,
        };
        if (payload?.meta) outputMessage.meta = payload.meta;
        parentPort.postMessage(outputMessage);
        return;
      }
      if (channel === "netcatty:exit" && payload?.sessionId) {
        outputPorts?.closeSession?.(payload.sessionId);
      }
      parentPort.postMessage({
        kind: "renderer-event",
        webContentsId,
        channel,
        payload,
      });
    },
  };
}

function createTerminalWorkerRuntime(options = {}) {
  const {
    parentPort,
    registerBridges,
  } = options;
  const ipcMain = createIpcMainHarness();
  let started = false;
  const outputPorts = createOutputPortRegistry(parentPort);
  let urgentInputPorts = null;

  async function handleRequest(message) {
    const handler = ipcMain.handlers.get(message.channel);
    if (!handler) {
      parentPort.postMessage({
        kind: "response",
        requestId: message.requestId,
        error: `No terminal worker handler registered for ${message.channel}`,
      });
      return;
    }
    try {
      const result = await handler({
        sender: createSender(parentPort, message.webContentsId, outputPorts),
      }, message.payload);
      parentPort.postMessage({
        kind: "response",
        requestId: message.requestId,
        result,
      });
    } catch (err) {
      parentPort.postMessage({
        kind: "response",
        requestId: message.requestId,
        error: err?.message || String(err),
      });
    }
  }

  function handleSend(message) {
    const listener = ipcMain.listeners.get(message.channel);
    if (!listener) return;
    if (message.channel === "netcatty:interrupt") {
      const trace = normalizeTrace(message.payload);
      logTerminalInterruptDebug("worker-received-send", {
        channel: message.channel,
        webContentsId: message.webContentsId,
      }, trace);
    }
    if (message.channel === "netcatty:close" && message.payload?.sessionId) {
      outputPorts.closeSession(message.payload.sessionId);
    }
    listener({
      sender: createSender(parentPort, message.webContentsId, outputPorts),
    }, message.payload);
  }

  function handleUrgentInput(webContentsId, message) {
    if (message?.kind !== "interrupt" || !message.sessionId) return;
    handleSend({
      channel: "netcatty:interrupt",
      payload: {
        sessionId: message.sessionId,
        trace: message.trace,
        urgentInputPort: true,
      },
      webContentsId,
    });
  }

  function handleMessage(eventOrMessage) {
    const { message, ports } = normalizeMessageEvent(eventOrMessage);
    if (message?.kind === "urgent-input-port") {
      urgentInputPorts?.open(message.webContentsId, ports?.[0]);
      return;
    }
    if (message?.kind === "output-port") {
      outputPorts.open(message.sessionId, ports?.[0], message.bufferedOutput);
      return;
    }
    if (message?.kind === "output-flush") {
      outputPorts.flush(message.sessionId, message.chunks);
      return;
    }
    if (message?.kind === "close-output-port") {
      outputPorts.closeSession(message.sessionId);
      return;
    }
    if (message?.kind === "request") {
      void handleRequest(message);
      return;
    }
    if (message?.kind === "send") {
      handleSend(message);
    }
  }

  function start() {
    if (started) return;
    started = true;
    urgentInputPorts = createUrgentInputPortRegistry(handleUrgentInput);
    registerBridges?.(ipcMain);
    parentPort.on("message", handleMessage);
  }

  return {
    start,
    ipcMain,
    createSender(webContentsId) {
      return createSender(parentPort, webContentsId, outputPorts);
    },
    closeUrgentInputPortsForTest() {
      urgentInputPorts?.closeAll();
    },
  };
}

module.exports = {
  createTerminalWorkerRuntime,
  createOutputPortRegistry,
};
