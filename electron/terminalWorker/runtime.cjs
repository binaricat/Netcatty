"use strict";

const {
  logTerminalInterruptDebug,
  normalizeTrace,
} = require("../bridges/terminalInterruptDiagnostics.cjs");

const SESSION_START_CHANNELS = new Set([
  "netcatty:start",
  "netcatty:local:start",
  "netcatty:telnet:start",
  "netcatty:mosh:start",
  "netcatty:et:start",
  "netcatty:serial:start",
  "netcatty:local:reconnect",
]);

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

function createOutputPortRegistry() {
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

  function postControl(sessionId, message) {
    const port = outputPorts.get(sessionId);
    if (!port) return false;
    try {
      port.postMessage({ ...message, sessionId });
      return true;
    } catch {
      closeSession(sessionId);
      return false;
    }
  }

  function open(sessionId, port) {
    if (!sessionId || !port) return;
    closeSession(sessionId);
    outputPorts.set(sessionId, port);
    try {
      port.start?.();
    } catch {
      // Some Electron MessagePort implementations do not require start().
    }
  }

  return {
    open,
    post,
    postControl,
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
    close,
    closeAll,
  };
}

function createSender(
  parentPort,
  webContentsId,
  outputPorts,
  terminalDataPipeline,
  pendingOutputBySession = new Map(),
  sessionOutputGenerations = new Map(),
  sessionRequestIds = new Map(),
  fixedOriginRequestId = null,
) {
  const ownedSessionGenerations = new Map();
  const getOwnedSessionGeneration = (sessionId) => {
    if (!ownedSessionGenerations.has(sessionId)) {
      ownedSessionGenerations.set(sessionId, sessionOutputGenerations.get(sessionId) ?? 0);
    }
    return ownedSessionGenerations.get(sessionId);
  };
  const trackPendingOutput = (sessionId, pending) => {
    pendingOutputBySession.set(sessionId, pending);
    const clearPending = () => {
      if (pendingOutputBySession.get(sessionId) === pending) {
        pendingOutputBySession.delete(sessionId);
      }
    };
    void pending.then(clearPending, clearPending);
  };
  const getOriginRequestId = (sessionId) => (
    fixedOriginRequestId || sessionRequestIds.get(sessionId) || null
  );
  const postRendererEvent = (channel, payload) => {
    const explicitGeneration = payload?._terminalSessionGeneration;
    const sessionGeneration = Number.isSafeInteger(explicitGeneration)
      ? explicitGeneration
      : payload?.sessionId
        ? getOwnedSessionGeneration(payload.sessionId)
        : undefined;
    const rendererPayload = explicitGeneration === undefined
      ? payload
      : Object.freeze(Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "_terminalSessionGeneration"),
      ));
    const originRequestId = getOriginRequestId(payload?.sessionId);
    if (channel === "netcatty:exit" && payload?.sessionId) {
      if ((sessionOutputGenerations.get(payload.sessionId) ?? 0) === sessionGeneration) {
        sessionOutputGenerations.set(payload.sessionId, sessionGeneration + 1);
        pendingOutputBySession.delete(payload.sessionId);
        outputPorts?.closeSession?.(payload.sessionId);
        terminalDataPipeline?.detach?.(payload.sessionId, undefined, "session-closed");
      }
    }
    parentPort.postMessage({
      kind: "renderer-event",
      webContentsId,
      channel,
      payload: rendererPayload,
      ...(sessionGeneration === undefined ? {} : { sessionGeneration }),
      ...(originRequestId ? { originRequestId } : {}),
    });
  };
  const deliverTerminalData = (payload) => {
    const sessionId = payload?.sessionId;
    const explicitGeneration = payload?._terminalSessionGeneration;
    const outputGeneration = Number.isSafeInteger(explicitGeneration)
      ? explicitGeneration
      : getOwnedSessionGeneration(sessionId);
    const originRequestId = getOriginRequestId(sessionId);
    if ((sessionOutputGenerations.get(sessionId) ?? 0) !== outputGeneration) return;
    const tapMessage = {
      kind: "output-tap",
      sessionId: payload?.sessionId,
      data: payload?.data,
      sessionGeneration: outputGeneration,
      ...(originRequestId ? { originRequestId } : {}),
    };
    if (payload?.meta) tapMessage.meta = payload.meta;
    if (payload?.tapped !== true) parentPort.postMessage(tapMessage);
    const pipelineProcessed = payload?.pipelineProcessed === true;
    const pipelineMode = terminalDataPipeline?.getOutputMode?.(payload?.sessionId) ?? 0;
    let sensitiveInputState;
    if (!pipelineProcessed && pipelineMode !== 0) {
      sensitiveInputState = terminalDataPipeline.observeOutput?.(
        payload?.sessionId,
        payload?.data,
      ) === true;
    }
    const deliver = (data, transformed = false) => {
      if ((sessionOutputGenerations.get(sessionId) ?? 0) !== outputGeneration) return;
      const inheritedIngressBytes = payload?.meta?.pluginPipelineIngressBytes;
      const replayedRawIngressBytes = !transformed
        && !pipelineProcessed
        && Number.isFinite(inheritedIngressBytes)
        ? Math.max(0, Number(inheritedIngressBytes)) + String(payload?.data ?? "").length
        : null;
      const pipelineMeta = {
        ...(payload?.meta ?? {}),
        ...(replayedRawIngressBytes == null
          ? {}
          : { pluginPipelineIngressBytes: replayedRawIngressBytes }),
        ...(transformed
          ? {
            pluginPipelineIngressBytes:
              Number(payload?.meta?.pluginPipelineIngressBytes ?? 0)
              + String(payload?.data ?? "").length,
            pluginPipelineProcessed: true,
          }
          : {}),
        ...(sensitiveInputState === undefined
          ? {}
          : { pluginPipelineSensitiveInput: sensitiveInputState }),
      };
      const meta = Object.keys(pipelineMeta).length > 0 ? pipelineMeta : undefined;
      if (outputPorts?.post?.(payload?.sessionId, data, meta)) return;
      const outputMessage = {
        kind: "output",
        sessionId: payload?.sessionId,
        data,
        tapped: true,
        sessionGeneration: outputGeneration,
        ...(originRequestId ? { originRequestId } : {}),
      };
      if (meta) outputMessage.meta = meta;
      parentPort.postMessage(outputMessage);
    };
    const previous = pendingOutputBySession.get(sessionId);
    if (pipelineProcessed || !terminalDataPipeline?.interceptOutput || (pipelineMode & 2) === 0) {
      if (!previous) {
        deliver(payload?.data, false);
        return;
      }
      const pending = previous.then(
        () => deliver(payload?.data, false),
        () => deliver(payload?.data, false),
      );
      trackPendingOutput(sessionId, pending);
      return;
    }
    const interceptAndDeliver = () => {
      try {
        return Promise.resolve(terminalDataPipeline.interceptOutput(sessionId, payload?.data)).then(
          (data) => deliver(data, true),
          () => deliver(payload?.data, false),
        );
      } catch {
        deliver(payload?.data, false);
        return undefined;
      }
    };
    // Invoke the pipeline immediately so its bounded byte window and monotonic
    // deadline cover time spent waiting behind earlier transforms. The
    // pipeline owns per-session transform ordering; this outer registry only
    // retains the latest barrier for direct fail-open output and session exit.
    const pending = Promise.resolve(interceptAndDeliver());
    trackPendingOutput(sessionId, pending);
  };
  return {
    id: webContentsId,
    claimSessionGeneration(sessionId) {
      return getOwnedSessionGeneration(sessionId);
    },
    isDestroyed() {
      return false;
    },
    send(channel, payload) {
      if (channel === "netcatty:data") {
        deliverTerminalData(payload);
        return;
      }
      if (channel === "netcatty:exit" && payload?.sessionId) {
        const pending = pendingOutputBySession.get(payload.sessionId);
        if (pending) {
          void pending.then(
            () => postRendererEvent(channel, payload),
            () => postRendererEvent(channel, payload),
          );
          return;
        }
      }
      postRendererEvent(channel, payload);
    },
  };
}

function createTerminalWorkerRuntime(options = {}) {
  const {
    parentPort,
    registerBridges,
    terminalDataPipeline,
  } = options;
  const ipcMain = createIpcMainHarness();
  let started = false;
  const outputPorts = createOutputPortRegistry();
  const pendingOutputBySession = new Map();
  const sessionOutputGenerations = new Map();
  const sessionRequestIds = new Map();
  const sessionOperationTails = new Map();
  const sessionOperationKinds = new Map();
  const sessionCloseEpochs = new Map();
  const sessionStartMarkers = new Set();
  let urgentInputPorts = null;

  const createWorkerOutputSender = () => createSender(
    parentPort,
    0,
    outputPorts,
    terminalDataPipeline,
    pendingOutputBySession,
    sessionOutputGenerations,
    sessionRequestIds,
  );

  function replayWorkerOutput(sessionId, chunks) {
    const sender = createWorkerOutputSender();
    for (const chunk of chunks || []) {
      const data = chunk && typeof chunk === "object" && "data" in chunk ? chunk.data : chunk;
      const meta = chunk && typeof chunk === "object" ? chunk.meta : undefined;
      const pipelineProcessed = meta?.pluginPipelineProcessed === true;
      sender.send("netcatty:data", {
        sessionId,
        data,
        meta,
        tapped: true,
        pipelineProcessed,
      });
    }
  }

  function invalidateSessionOutput(sessionId) {
    if (!sessionId) return;
    sessionOutputGenerations.set(
      sessionId,
      (sessionOutputGenerations.get(sessionId) ?? 0) + 1,
    );
    pendingOutputBySession.delete(sessionId);
    outputPorts.closeSession(sessionId);
    terminalDataPipeline?.detach?.(sessionId, undefined, "session-closed");
    sessionRequestIds.delete(sessionId);
  }

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
      const isSessionStart = SESSION_START_CHANNELS.has(message.channel);
      const requestedSessionId = isSessionStart ? message.payload?.sessionId : null;
      if (requestedSessionId) sessionRequestIds.set(requestedSessionId, message.requestId);
      const result = await handler({
        sender: createSender(
          parentPort,
          message.webContentsId,
          outputPorts,
          terminalDataPipeline,
          pendingOutputBySession,
          sessionOutputGenerations,
          sessionRequestIds,
          isSessionStart ? message.requestId : null,
        ),
      }, message.payload);
      const sessionId = result?.sessionId;
      if (isSessionStart && sessionId) {
        sessionRequestIds.set(sessionId, message.requestId);
        sessionStartMarkers.add(sessionId);
      }
      parentPort.postMessage({
        kind: "response",
        requestId: message.requestId,
        result,
        ...(typeof sessionId === "string"
          ? { sessionGeneration: sessionOutputGenerations.get(sessionId) ?? 0 }
          : {}),
      });
    } catch (err) {
      parentPort.postMessage({
        kind: "response",
        requestId: message.requestId,
        error: err?.message || String(err),
      });
    }
  }

  async function closeSupersededSessionStart(message) {
    const sessionId = message.payload?.sessionId;
    if (!sessionId) return;
    parentPort.postMessage({
      kind: "session-superseding",
      sessionId,
      sessionGeneration: sessionOutputGenerations.get(sessionId) ?? 0,
      replacementRequestId: message.requestId,
    });
    invalidateSessionOutput(sessionId);
    const closeHandler = ipcMain.handlers.get("netcatty:close:await");
    if (closeHandler) {
      await closeHandler({
        sender: createSender(
          parentPort,
          message.webContentsId,
          outputPorts,
          terminalDataPipeline,
          pendingOutputBySession,
          sessionOutputGenerations,
          sessionRequestIds,
        ),
      }, { sessionId });
    }
  }

  function postRequestError(message, error) {
    parentPort.postMessage({
      kind: "response",
      requestId: message.requestId,
      error: error?.message || String(error),
    });
  }

  function trackSessionOperation(sessionId, operation, kind) {
    sessionOperationTails.set(sessionId, operation);
    sessionOperationKinds.set(sessionId, kind);
    void operation.finally(() => {
      if (sessionOperationTails.get(sessionId) === operation) {
        sessionOperationTails.delete(sessionId);
        sessionOperationKinds.delete(sessionId);
      }
    });
  }

  function dispatchRequest(message) {
    const sessionId = SESSION_START_CHANNELS.has(message.channel)
      ? message.payload?.sessionId
      : null;
    if (message.channel === "netcatty:close:await" && message.payload?.sessionId) {
      dispatchSessionClose(message, true);
      return;
    }
    if (!sessionId) {
      void handleRequest(message);
      return;
    }
    const closeEpoch = sessionCloseEpochs.get(sessionId) ?? 0;
    const previous = sessionOperationTails.get(sessionId);
    const previousKind = sessionOperationKinds.get(sessionId);
    const shouldClosePreviousStart = previousKind === "start" || sessionStartMarkers.has(sessionId);
    const current = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      if ((sessionCloseEpochs.get(sessionId) ?? 0) !== closeEpoch) {
        postRequestError(message, new Error("Terminal session start was cancelled by close"));
        return;
      }
      try {
        if (shouldClosePreviousStart) await closeSupersededSessionStart(message);
        if ((sessionCloseEpochs.get(sessionId) ?? 0) !== closeEpoch) {
          postRequestError(message, new Error("Terminal session start was cancelled by close"));
          return;
        }
        sessionStartMarkers.add(sessionId);
        await handleRequest(message);
      } catch (error) {
        postRequestError(message, error);
      }
    });
    trackSessionOperation(sessionId, current, "start");
  }

  function dispatchSessionClose(message, expectsResponse) {
    const sessionId = message.payload?.sessionId;
    if (!sessionId) {
      if (expectsResponse) void handleRequest(message);
      else handleSend(message);
      return;
    }
    sessionCloseEpochs.set(sessionId, (sessionCloseEpochs.get(sessionId) ?? 0) + 1);
    const previous = sessionOperationTails.get(sessionId);
    const current = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      try {
        if (expectsResponse) {
          invalidateSessionOutput(sessionId);
          await handleRequest(message);
        } else {
          handleSend(message);
        }
        sessionStartMarkers.delete(sessionId);
      } catch (error) {
        if (expectsResponse) postRequestError(message, error);
      }
    });
    trackSessionOperation(sessionId, current, "close");
  }

  function handleSend(message) {
    const listener = ipcMain.listeners.get(message.channel);
    if (!listener) return;
    if (message.channel === "netcatty:interrupt") {
      terminalDataPipeline?.clearSensitiveInput?.(message.payload?.sessionId);
      const trace = normalizeTrace(message.payload);
      logTerminalInterruptDebug("worker-received-send", {
        channel: message.channel,
        webContentsId: message.webContentsId,
      }, trace);
    }
    if (message.channel === "netcatty:close" && message.payload?.sessionId) {
      invalidateSessionOutput(message.payload.sessionId);
    }
    listener({
      sender: createSender(
        parentPort,
        message.webContentsId,
        outputPorts,
        terminalDataPipeline,
        pendingOutputBySession,
        sessionOutputGenerations,
      ),
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
    if (message?.kind === "close-urgent-input-port") {
      urgentInputPorts?.close(message.webContentsId);
      return;
    }
    if (message?.kind === "output-port") {
      const sessionGeneration = sessionOutputGenerations.get(message.sessionId) ?? 0;
      if (Number.isSafeInteger(message.sessionGeneration)
        && message.sessionGeneration !== sessionGeneration) {
        try { ports?.[0]?.close?.(); } catch {}
        return;
      }
      outputPorts.open(message.sessionId, ports?.[0]);
      replayWorkerOutput(message.sessionId, message.bufferedOutput);
      const pending = pendingOutputBySession.get(message.sessionId);
      const notifyReady = () => parentPort.postMessage({
        kind: "output-port-ready",
        sessionId: message.sessionId,
        ...(Number.isSafeInteger(message.sessionGeneration) ? { sessionGeneration } : {}),
        ...(message.outputPortRequestId
          ? { outputPortRequestId: message.outputPortRequestId }
          : {}),
      });
      if (pending) {
        void pending.then(
          notifyReady,
          notifyReady,
        );
      } else {
        notifyReady();
      }
      return;
    }
    if (message?.kind === "terminal-interceptor-port") {
      terminalDataPipeline?.attach?.(message, ports?.[0]);
      return;
    }
    if (message?.kind === "terminal-interceptor-detach") {
      terminalDataPipeline?.detach?.(message.sessionId, message.direction, "detached");
      return;
    }
    if (message?.kind === "output-flush") {
      replayWorkerOutput(message.sessionId, message.chunks);
      return;
    }
    if (message?.kind === "close-output-port") {
      invalidateSessionOutput(message.sessionId);
      return;
    }
    if (message?.kind === "output-drain") {
      outputPorts.postControl(message.sessionId, {
        kind: "drain",
        requestId: message.requestId,
      });
      return;
    }
    if (message?.kind === "request") {
      dispatchRequest(message);
      return;
    }
    if (message?.kind === "send") {
      if (message.channel === "netcatty:close" && message.payload?.sessionId) {
        dispatchSessionClose(message, false);
        return;
      }
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
      return createSender(
        parentPort,
        webContentsId,
        outputPorts,
        terminalDataPipeline,
        pendingOutputBySession,
        sessionOutputGenerations,
        sessionRequestIds,
      );
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
