"use strict";

const {
  logTerminalInterruptDebug,
  normalizeTrace,
} = require("../bridges/terminalInterruptDiagnostics.cjs");
const {
  clearTerminalSessionPerformanceState,
} = require("../bridges/emitTerminalSessionData.cjs");

const DEFAULT_SESSION_LIFECYCLE_TOMBSTONE_TTL_MS = 60_000;
const DEFAULT_MAX_SESSION_LIFECYCLE_TOMBSTONES = 2_048;

const SESSION_START_CHANNELS = new Set([
  "netcatty:start",
  "netcatty:local:start",
  "netcatty:telnet:start",
  "netcatty:mosh:start",
  "netcatty:et:start",
  "netcatty:serial:start",
  "netcatty:local:reconnect",
  "netcatty:external:start",
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
  onCurrentSessionExit = null,
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
        onCurrentSessionExit?.(payload.sessionId, sessionGeneration);
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
        return Promise.resolve();
      }
      const pending = previous.then(
        () => deliver(payload?.data, false),
        () => deliver(payload?.data, false),
      );
      trackPendingOutput(sessionId, pending);
      return pending;
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
    return pending;
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
        return deliverTerminalData(payload);
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
  // Optional hook for suppressed-but-diagnostic failures so they still reach
  // the main process's persistent crash log via the "worker-error" channel.
  const reportSuppressedError = typeof options.reportSuppressedError === "function"
    ? options.reportSuppressedError
    : null;
  const ipcMain = createIpcMainHarness();
  let started = false;
  const outputPorts = createOutputPortRegistry();
  const pendingOutputBySession = new Map();
  const sessionOutputGenerations = new Map();
  const sessionRequestIds = new Map();
  const sessionOperationTails = new Map();
  const sessionOperationKinds = new Map();
  const sessionCloseEpochs = new Map();
  const sessionLifecycleTombstoneTimes = new Map();
  const sessionStartMarkers = new Set();
  const pendingSessionStartBootEpochs = new Map();
  let urgentInputPorts = null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sessionLifecycleTombstoneTtlMs = Number.isFinite(options.sessionLifecycleTombstoneTtlMs)
    ? Math.max(0, Number(options.sessionLifecycleTombstoneTtlMs))
    : DEFAULT_SESSION_LIFECYCLE_TOMBSTONE_TTL_MS;
  const maxSessionLifecycleTombstones = Number.isFinite(options.maxSessionLifecycleTombstones)
    ? Math.max(1, Math.floor(Number(options.maxSessionLifecycleTombstones)))
    : DEFAULT_MAX_SESSION_LIFECYCLE_TOMBSTONES;
  const setDefaultTransportIdleTtlMs = typeof options.setDefaultTransportIdleTtlMs === "function"
    ? options.setDefaultTransportIdleTtlMs
    : (value) => require("../bridges/sshConnectionPool.cjs").setDefaultTransportIdleTtlMs(value);

  function canPruneSessionLifecycleTombstone(sessionId) {
    return !sessionOperationTails.has(sessionId)
      && !sessionStartMarkers.has(sessionId)
      && !pendingOutputBySession.has(sessionId);
  }

  function deleteSessionLifecycleTombstone(sessionId) {
    sessionLifecycleTombstoneTimes.delete(sessionId);
    sessionOutputGenerations.delete(sessionId);
    sessionCloseEpochs.delete(sessionId);
    pendingSessionStartBootEpochs.delete(sessionId);
  }

  function normalizeBootEpoch(bootEpoch) {
    if (!Number.isFinite(bootEpoch)) return undefined;
    return Number(bootEpoch);
  }

  function rememberPendingStartBootEpoch(sessionId, bootEpoch) {
    const normalized = normalizeBootEpoch(bootEpoch);
    if (!sessionId || normalized === undefined) return;
    pendingSessionStartBootEpochs.set(sessionId, normalized);
  }

  function shouldSkipStaleEpochClose(sessionId, bootEpoch) {
    const closeEpoch = normalizeBootEpoch(bootEpoch);
    if (closeEpoch === undefined || !sessionId) return false;
    const ownerEpoch = pendingSessionStartBootEpochs.get(sessionId);
    return ownerEpoch !== undefined && ownerEpoch > closeEpoch;
  }

  function pruneSessionLifecycleTombstones() {
    const currentTime = now();
    for (const [sessionId, closedAt] of sessionLifecycleTombstoneTimes) {
      if (currentTime - closedAt < sessionLifecycleTombstoneTtlMs) continue;
      if (!canPruneSessionLifecycleTombstone(sessionId)) continue;
      deleteSessionLifecycleTombstone(sessionId);
    }
    if (sessionLifecycleTombstoneTimes.size <= maxSessionLifecycleTombstones) return;
    for (const sessionId of [...sessionLifecycleTombstoneTimes.keys()]) {
      if (sessionLifecycleTombstoneTimes.size <= maxSessionLifecycleTombstones) break;
      if (!canPruneSessionLifecycleTombstone(sessionId)) continue;
      deleteSessionLifecycleTombstone(sessionId);
    }
  }

  function touchSessionLifecycleTombstone(sessionId) {
    if (!sessionId) return;
    sessionLifecycleTombstoneTimes.delete(sessionId);
    sessionLifecycleTombstoneTimes.set(sessionId, now());
  }

  function finalizeNaturalSessionExit(sessionId) {
    if (!sessionId) return;
    sessionStartMarkers.delete(sessionId);
    sessionRequestIds.delete(sessionId);
    clearTerminalSessionPerformanceState(sessionId);
    touchSessionLifecycleTombstone(sessionId);
    pruneSessionLifecycleTombstones();
  }

  const createWorkerOutputSender = () => createSender(
    parentPort,
    0,
    outputPorts,
    terminalDataPipeline,
    pendingOutputBySession,
    sessionOutputGenerations,
    sessionRequestIds,
    null,
    finalizeNaturalSessionExit,
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
    clearTerminalSessionPerformanceState(sessionId);
    touchSessionLifecycleTombstone(sessionId);
    pruneSessionLifecycleTombstones();
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
      const naturalExitGenerations = new Map();
      const requestedSessionGeneration = requestedSessionId
        ? (sessionOutputGenerations.get(requestedSessionId) ?? 0)
        : null;
      if (requestedSessionId) {
        sessionRequestIds.set(requestedSessionId, message.requestId);
        sessionLifecycleTombstoneTimes.delete(requestedSessionId);
      }
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
          (sessionId, generation) => {
            naturalExitGenerations.set(sessionId, generation);
            finalizeNaturalSessionExit(sessionId);
          },
        ),
      }, message.payload);
      const sessionId = result?.sessionId;
      if (isSessionStart && sessionId) {
        const currentGeneration = sessionOutputGenerations.get(sessionId) ?? 0;
        const exitedGeneration = naturalExitGenerations.get(sessionId);
        const exitedDuringRequest = exitedGeneration !== undefined
          && currentGeneration > exitedGeneration;
        const requestedGenerationStillCurrent = requestedSessionGeneration === null
          || currentGeneration === requestedSessionGeneration;
        if (!exitedDuringRequest && requestedGenerationStillCurrent) {
          sessionRequestIds.set(sessionId, message.requestId);
          sessionStartMarkers.add(sessionId);
          sessionLifecycleTombstoneTimes.delete(sessionId);
        } else {
          sessionRequestIds.delete(sessionId);
          sessionStartMarkers.delete(sessionId);
        }
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
          null,
          finalizeNaturalSessionExit,
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
        pruneSessionLifecycleTombstones();
      }
    });
  }

  function dispatchRequest(message) {
    pruneSessionLifecycleTombstones();
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
    rememberPendingStartBootEpoch(sessionId, message.payload?.bootEpoch);
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
    if (shouldSkipStaleEpochClose(sessionId, message.payload?.bootEpoch)) {
      if (expectsResponse) {
        parentPort.postMessage({
          kind: "response",
          requestId: message.requestId,
          result: { skipped: true, reason: "boot-epoch-mismatch" },
        });
      }
      return;
    }
    sessionCloseEpochs.set(sessionId, (sessionCloseEpochs.get(sessionId) ?? 0) + 1);
    pendingSessionStartBootEpochs.delete(sessionId);
    touchSessionLifecycleTombstone(sessionId);
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
    pruneSessionLifecycleTombstones();
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
    try {
      listener({
        sender: createSender(
          parentPort,
          message.webContentsId,
          outputPorts,
          terminalDataPipeline,
          pendingOutputBySession,
          sessionOutputGenerations,
          sessionRequestIds,
          null,
          finalizeNaturalSessionExit,
        ),
      }, message.payload);
    } catch (err) {
      // Send listeners (write/resize/flow/close) are fire-and-forget; a throw
      // here is synchronous and would otherwise escape as an uncaught
      // exception on the worker's message loop.
      console.error(`[TerminalWorker] send listener failed for ${message.channel}:`, err);
      if (reportSuppressedError) {
        try {
          reportSuppressedError("send-listener", err, `send listener failed for ${message.channel}`);
        } catch {
          // Reporting must never be able to escalate into a worker crash.
        }
      }
    }
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
    if (message?.kind === "set-ssh-transport-idle-ttl") {
      setDefaultTransportIdleTtlMs(message.value);
      return;
    }
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
        null,
        finalizeNaturalSessionExit,
      );
    },
    closeUrgentInputPortsForTest() {
      urgentInputPorts?.closeAll();
    },
    _getSessionLifecycleStateCountsForTests() {
      pruneSessionLifecycleTombstones();
      return {
        outputGenerations: sessionOutputGenerations.size,
        closeEpochs: sessionCloseEpochs.size,
      };
    },
  };
}

module.exports = {
  createTerminalWorkerRuntime,
  createOutputPortRegistry,
};
