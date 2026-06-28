"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  logTerminalInterruptDebug,
  normalizeTrace,
} = require("./terminalInterruptDiagnostics.cjs");
const {
  TERMINAL_URGENT_INPUT_PORT_CHANNEL,
} = require("./terminalUrgentInputChannel.cjs");

function isTerminalWorkerEnabled(options = {}) {
  const env = options.env || process.env;
  return env.NETCATTY_TERMINAL_WORKER !== "0";
}

function defaultWorkerScriptPath() {
  return path.join(__dirname, "..", "terminalWorker", "process.cjs");
}

function createTerminalWorkerManager(options = {}) {
  const {
    utilityProcess,
    terminalOutputChannel = null,
    MessageChannelMain = null,
    workerScriptPath = defaultWorkerScriptPath(),
    electronModule = null,
    onRendererEvent = null,
  } = options;
  let child = null;
  const pending = new Map();
  const pendingOutput = new Map();
  const closedSessions = new Set();
  const outputPortPending = new Set();
  const outputPortReady = new Set();
  const sessionWebContentsIds = new Map();
  const urgentInputWebContentsIds = new Set();
  const outputTaps = new Set();
  const maxPendingOutputChunks = Number.isFinite(options.maxPendingOutputChunks)
    ? Math.max(0, Math.trunc(options.maxPendingOutputChunks))
    : 512;

  function rejectAllPending(error) {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  }

  function clearBufferedOutput(sessionId) {
    if (!sessionId) return;
    pendingOutput.delete(sessionId);
  }

  function takeBufferedOutput(sessionId) {
    const chunks = pendingOutput.get(sessionId) || [];
    pendingOutput.delete(sessionId);
    return chunks;
  }

  function bufferOutput(sessionId, data) {
    if (!sessionId || closedSessions.has(sessionId) || maxPendingOutputChunks === 0) return;
    const chunks = pendingOutput.get(sessionId) || [];
    chunks.push(data);
    while (chunks.length > maxPendingOutputChunks) {
      chunks.shift();
    }
    pendingOutput.set(sessionId, chunks);
  }

  function flushBufferedOutput(sessionId) {
    const chunks = pendingOutput.get(sessionId);
    if (!sessionId || !chunks?.length) return;
    pendingOutput.delete(sessionId);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!deliverOutputToRenderer(sessionId, chunk)) {
        for (let retryIndex = index; retryIndex < chunks.length; retryIndex += 1) {
          bufferOutput(sessionId, chunks[retryIndex]);
        }
        break;
      }
    }
  }

  function sendOutputOverLegacyIpc(sessionId, data) {
    const webContentsId = sessionWebContentsIds.get(sessionId);
    if (!webContentsId) return false;
    const contents = electronModule?.webContents?.fromId?.(webContentsId);
    if (!contents?.send) return false;
    contents.send("netcatty:data", { sessionId, data });
    return true;
  }

  function deliverOutputToRenderer(sessionId, data) {
    if (terminalOutputChannel?.send?.(sessionId, data)) return true;
    return sendOutputOverLegacyIpc(sessionId, data);
  }

  function notifyOutputTaps(sessionId, data) {
    if (!sessionId || !data || outputTaps.size === 0) return;
    for (const tap of outputTaps) {
      try {
        tap(sessionId, data);
      } catch (err) {
        console.warn("[terminalWorkerManager] output tap failed", err);
      }
    }
  }

  function openOutputSession(sessionId, webContentsId) {
    if (!sessionId || !webContentsId) return;
    if (closedSessions.has(sessionId)) {
      clearBufferedOutput(sessionId);
      return;
    }
    sessionWebContentsIds.set(sessionId, webContentsId);
    const contents = electronModule?.webContents?.fromId?.(webContentsId);
    openUrgentInputPort(webContentsId, contents);
    const outputPort = terminalOutputChannel?.openSession?.(sessionId, contents, {
      transferToWorker: true,
    });
    if (outputPort && outputPort !== true && child?.postMessage) {
      outputPortPending.add(sessionId);
      child.postMessage({
        kind: "output-port",
        sessionId,
        bufferedOutput: takeBufferedOutput(sessionId),
      }, [outputPort]);
      return;
    }
    flushBufferedOutput(sessionId);
  }

  function closeOutputSession(sessionId) {
    if (!sessionId) return;
    closedSessions.add(sessionId);
    clearBufferedOutput(sessionId);
    outputPortPending.delete(sessionId);
    outputPortReady.delete(sessionId);
    sessionWebContentsIds.delete(sessionId);
    try {
      child?.postMessage?.({ kind: "close-output-port", sessionId });
    } catch {
      // The worker may already be gone while closing a tab or quitting.
    }
    terminalOutputChannel?.closeSession?.(sessionId);
  }

  function openUrgentInputPort(webContentsId, contents) {
    if (!webContentsId || urgentInputWebContentsIds.has(webContentsId)) return false;
    if (typeof MessageChannelMain !== "function" || !contents?.postMessage || !child?.postMessage) {
      return false;
    }
    const { port1, port2 } = new MessageChannelMain();
    try {
      child.postMessage({
        kind: "urgent-input-port",
        webContentsId,
      }, [port1]);
      contents.postMessage(TERMINAL_URGENT_INPUT_PORT_CHANNEL, {}, [port2]);
      urgentInputWebContentsIds.add(webContentsId);
      return true;
    } catch {
      try { port1?.close?.(); } catch {}
      try { port2?.close?.(); } catch {}
      return false;
    }
  }

  function flushOutputToWorker(sessionId) {
    const chunks = takeBufferedOutput(sessionId);
    if (!chunks.length || closedSessions.has(sessionId)) return;
    try {
      child?.postMessage?.({ kind: "output-flush", sessionId, chunks });
    } catch {
      for (const chunk of chunks) bufferOutput(sessionId, chunk);
    }
  }

  function deliverReadyPortFallbackOutput(sessionId, data) {
    outputPortReady.delete(sessionId);
    terminalOutputChannel?.closeSession?.(sessionId);
    if (!sendOutputOverLegacyIpc(sessionId, data)) {
      bufferOutput(sessionId, data);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "response") {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      if (message.error) {
        entry.reject(new Error(message.error));
      } else {
        const sessionId = message.result?.sessionId;
        openOutputSession(sessionId, entry.webContentsId);
        entry.resolve(message.result);
      }
      return;
    }
    if (message.kind === "output") {
      if (closedSessions.has(message.sessionId)) return;
      notifyOutputTaps(message.sessionId, message.data);
      if (outputPortPending.has(message.sessionId)) {
        bufferOutput(message.sessionId, message.data);
        return;
      }
      if (outputPortReady.has(message.sessionId)) {
        deliverReadyPortFallbackOutput(message.sessionId, message.data);
        return;
      }
      if (!deliverOutputToRenderer(message.sessionId, message.data)) {
        bufferOutput(message.sessionId, message.data);
      }
      return;
    }
    if (message.kind === "output-tap") {
      if (!closedSessions.has(message.sessionId)) {
        notifyOutputTaps(message.sessionId, message.data);
      }
      return;
    }
    if (message.kind === "output-port-ready") {
      outputPortPending.delete(message.sessionId);
      if (!closedSessions.has(message.sessionId)) {
        outputPortReady.add(message.sessionId);
        flushOutputToWorker(message.sessionId);
      }
      return;
    }
    if (message.kind === "renderer-event") {
      if (message.channel === "netcatty:exit" && message.payload?.sessionId) {
        closeOutputSession(message.payload.sessionId);
      }
      if (onRendererEvent) {
        onRendererEvent(message);
        return;
      }
      const contents = electronModule?.webContents?.fromId?.(message.webContentsId);
      contents?.send?.(message.channel, message.payload);
    }
  }

  function handleExit(code) {
    const error = new Error(`Terminal worker exited${Number.isFinite(code) ? ` with code ${code}` : ""}`);
    const exitCode = Number.isFinite(code) ? code : 1;
    for (const [sessionId, webContentsId] of sessionWebContentsIds.entries()) {
      try {
        const contents = electronModule?.webContents?.fromId?.(webContentsId);
        contents?.send?.("netcatty:exit", {
          sessionId,
          exitCode,
          error: error.message,
          reason: "error",
        });
      } catch {
        // Ignore renderer notification failures while unwinding a crashed worker.
      }
    }
    child = null;
    pendingOutput.clear();
    closedSessions.clear();
    outputPortPending.clear();
    outputPortReady.clear();
    sessionWebContentsIds.clear();
    urgentInputWebContentsIds.clear();
    terminalOutputChannel?.closeAll?.();
    rejectAllPending(error);
  }

  function ensureStarted() {
    if (child) return child;
    if (!utilityProcess?.fork) {
      throw new Error("Electron utilityProcess is unavailable");
    }
    child = utilityProcess.fork(workerScriptPath);
    child.on?.("message", handleMessage);
    child.on?.("exit", handleExit);
    return child;
  }

  function request(channel, payload, optionsForRequest = {}) {
    const requestId = randomUUID();
    const worker = ensureStarted();
    const promise = new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, webContentsId: optionsForRequest.webContentsId });
    });
    if (payload?.sessionId) {
      closedSessions.delete(payload.sessionId);
    }
    worker.postMessage({
      kind: "request",
      requestId,
      channel,
      payload,
      webContentsId: optionsForRequest.webContentsId,
    });
    return promise;
  }

  function send(channel, payload, optionsForSend = {}) {
    if (channel === "netcatty:close" && payload?.sessionId) {
      closeOutputSession(payload.sessionId);
    }
    if (channel === "netcatty:interrupt") {
      const trace = normalizeTrace(payload);
      logTerminalInterruptDebug("main-to-worker-send", {
        channel,
        webContentsId: optionsForSend.webContentsId,
        hasChild: Boolean(child),
      }, trace);
    }
    ensureStarted().postMessage({
      kind: "send",
      channel,
      payload,
      webContentsId: optionsForSend.webContentsId,
    });
  }

  function stop() {
    if (!child) return;
    const current = child;
    child = null;
    try {
      current.kill?.();
    } finally {
      pendingOutput.clear();
      closedSessions.clear();
      outputPortPending.clear();
      outputPortReady.clear();
      sessionWebContentsIds.clear();
      urgentInputWebContentsIds.clear();
      terminalOutputChannel?.closeAll?.();
      rejectAllPending(new Error("Terminal worker stopped"));
    }
  }

  return {
    ensureStarted,
    request,
    send,
    hasOpenSession(sessionId) {
      return Boolean(
        sessionId
        && sessionWebContentsIds.has(sessionId)
        && !closedSessions.has(sessionId),
      );
    },
    addOutputTap(listener) {
      if (typeof listener !== "function") return () => {};
      outputTaps.add(listener);
      return () => outputTaps.delete(listener);
    },
    stop,
  };
}

module.exports = {
  createTerminalWorkerManager,
  isTerminalWorkerEnabled,
};
