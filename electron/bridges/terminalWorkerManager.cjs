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

const ESC = "\x1b";
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

function readCsiSequence(input, startIndex) {
  if (input[startIndex] !== ESC || input[startIndex + 1] !== "[") return null;
  for (let index = startIndex + 2; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return { sequence: input.slice(startIndex, index + 1), end: index + 1 };
    }
  }
  return null;
}

function getAlternateScreenAction(sequence) {
  if (!sequence.startsWith("\x1b[") || sequence.length < 3) return null;
  const final = sequence.at(-1);
  if (final !== "h" && final !== "l") return null;
  const params = sequence.slice(2, -1);
  if (!params.startsWith("?")) return null;
  const modes = params
    .slice(1)
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
  if (!modes.some((mode) => ALT_SCREEN_MODES.has(mode))) return null;
  return final === "h" ? "enter" : "leave";
}

function inspectAlternateScreenWindow(text) {
  let mayAffectTerminalState = false;
  let finalAction = null;
  let hasIncompleteSequence = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ESC) continue;
    const sequence = readCsiSequence(text, index);
    if (sequence) {
      const action = getAlternateScreenAction(sequence.sequence);
      if (action) {
        mayAffectTerminalState = true;
        finalAction = action;
      }
      index = sequence.end - 1;
      continue;
    }
    if (text.slice(index).startsWith("\x1b[?")) {
      mayAffectTerminalState = true;
      hasIncompleteSequence = true;
      finalAction = null;
    }
  }
  return { mayAffectTerminalState, finalAction, hasIncompleteSequence };
}

function inspectAlternateScreenSequenceStartedBeforeBoundary(text, boundary) {
  let mayAffectTerminalState = false;
  let finalAction = null;
  for (let index = 0; index < Math.min(boundary, text.length); index += 1) {
    if (text[index] !== ESC) continue;
    const sequence = readCsiSequence(text, index);
    if (!sequence) {
      if (text.slice(index).startsWith("\x1b[?")) {
        mayAffectTerminalState = true;
      }
      continue;
    }
    if (sequence.end > boundary) {
      const action = getAlternateScreenAction(sequence.sequence);
      if (action) {
        mayAffectTerminalState = true;
        finalAction = action;
      }
    }
    index = sequence.end - 1;
  }
  return { mayAffectTerminalState, finalAction };
}

function inspectDroppedTerminalState({
  droppedHead,
  droppedTail,
  retainedHead,
  droppedBytes,
}) {
  if (droppedBytes <= 0) {
    return { mayAffectTerminalState: false, finalAlternateScreenAction: undefined };
  }
  const headInspection = inspectAlternateScreenWindow(droppedHead);
  const tailContext = droppedTail === droppedHead ? droppedHead : droppedTail;
  const tailInspection = inspectAlternateScreenWindow(tailContext);
  const tailWithRetainedInspection = inspectAlternateScreenWindow(`${tailContext}${retainedHead}`);
  const splitTailInspection = inspectAlternateScreenSequenceStartedBeforeBoundary(
    `${tailContext}${retainedHead}`,
    tailContext.length,
  );
  const sampledBytes = droppedHead.length + (droppedTail === droppedHead ? 0 : droppedTail.length);
  const hasUninspectedMiddle = droppedBytes > sampledBytes;
  const finalAlternateScreenAction = splitTailInspection.finalAction
    || tailInspection.finalAction
    || (!hasUninspectedMiddle ? headInspection.finalAction : undefined)
    || undefined;
  return {
    mayAffectTerminalState: Boolean(
      headInspection.hasIncompleteSequence
      || tailWithRetainedInspection.hasIncompleteSequence
      || hasUninspectedMiddle
      || headInspection.finalAction
      || tailInspection.finalAction
      || splitTailInspection.mayAffectTerminalState
      || tailWithRetainedInspection.finalAction
    ),
    finalAlternateScreenAction,
  };
}

function mergeTerminalOutputMeta(previous, next) {
  if (!next) return previous;
  const nextAction = next.droppedOutputMayAffectTerminalState
    ? next.droppedOutputAlternateScreenAction
    : (next.droppedOutputAlternateScreenAction ?? previous?.droppedOutputAlternateScreenAction);
  const merged = {
    ...(previous || {}),
    ...next,
    droppedOutputMayAffectTerminalState: Boolean(
      previous?.droppedOutputMayAffectTerminalState
      || next.droppedOutputMayAffectTerminalState
    ),
    droppedOutputAlternateScreenAction: nextAction,
  };
  if (!merged.droppedOutputAlternateScreenAction) {
    delete merged.droppedOutputAlternateScreenAction;
  }
  return merged;
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
  const pendingOutputBytes = new Map();
  const closedSessions = new Set();
  const outputPortPending = new Set();
  const outputPortReady = new Set();
  const sessionWebContentsIds = new Map();
  const urgentInputWebContentsIds = new Set();
  const outputTaps = new Set();
  const maxPendingOutputChunks = Number.isFinite(options.maxPendingOutputChunks)
    ? Math.max(0, Math.trunc(options.maxPendingOutputChunks))
    : 512;
  const maxPendingOutputBytes = Number.isFinite(options.maxPendingOutputBytes)
    ? Math.max(0, Math.trunc(options.maxPendingOutputBytes))
    : 2 * 1024 * 1024;
  const maxDroppedStateScanBytes = Math.max(256, options.maxDroppedStateScanBytes ?? 2048);

  function rejectAllPending(error) {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  }

  function clearBufferedOutput(sessionId) {
    if (!sessionId) return;
    pendingOutput.delete(sessionId);
    pendingOutputBytes.delete(sessionId);
  }

  function takeBufferedOutput(sessionId) {
    const chunks = pendingOutput.get(sessionId) || [];
    pendingOutput.delete(sessionId);
    pendingOutputBytes.delete(sessionId);
    return chunks;
  }

  function normalizeOutputChunk(data, meta) {
    if (data && typeof data === "object" && "data" in data) {
      const mergedMeta = mergeTerminalOutputMeta(data.meta, meta);
      return mergedMeta ? { data: data.data, meta: mergedMeta } : data.data;
    }
    return meta ? { data, meta } : data;
  }

  function getOutputChunkData(chunk) {
    return chunk && typeof chunk === "object" && "data" in chunk ? chunk.data : chunk;
  }

  function getOutputChunkMeta(chunk) {
    return chunk && typeof chunk === "object" ? chunk.meta : undefined;
  }

  function getOutputChunkLength(chunk) {
    const data = getOutputChunkData(chunk);
    return typeof data === "string" ? data.length : 0;
  }

  function withOutputChunkMeta(chunk, meta) {
    const mergedMeta = mergeTerminalOutputMeta(getOutputChunkMeta(chunk), meta);
    if (!mergedMeta) return chunk;
    return { data: getOutputChunkData(chunk), meta: mergedMeta };
  }

  function readBufferedOutputHead(chunks, limit) {
    if (limit <= 0) return "";
    let head = "";
    for (const chunk of chunks) {
      if (head.length >= limit) break;
      const data = getOutputChunkData(chunk);
      if (typeof data !== "string") continue;
      head += data.slice(0, limit - head.length);
    }
    return head;
  }

  function trimBufferedOutput(sessionId, chunks) {
    let totalBytes = pendingOutputBytes.get(sessionId) || 0;
    let droppedBytes = 0;
    let droppedHead = "";
    let droppedTail = "";
    let droppedMeta;

    const recordDropped = (text, meta) => {
      if (meta) {
        droppedMeta = mergeTerminalOutputMeta(droppedMeta, meta);
      }
      if (!text) return;
      if (droppedHead.length < maxDroppedStateScanBytes) {
        droppedHead += text.slice(0, maxDroppedStateScanBytes - droppedHead.length);
      }
      droppedTail = `${droppedTail}${text}`.slice(-maxDroppedStateScanBytes);
    };

    while (
      chunks.length > 0
      && (
        chunks.length > maxPendingOutputChunks
        || totalBytes > maxPendingOutputBytes
      )
    ) {
      const chunk = chunks[0];
      const data = getOutputChunkData(chunk);
      const dataLength = getOutputChunkLength(chunk);
      const dropWholeChunk = chunks.length > maxPendingOutputChunks;
      const overLimitBytes = Math.max(0, totalBytes - maxPendingOutputBytes);
      const bytesToDrop = dropWholeChunk ? dataLength : Math.min(dataLength, overLimitBytes);
      if (bytesToDrop <= 0) break;

      if (typeof data !== "string" || bytesToDrop >= dataLength) {
        chunks.shift();
        totalBytes = Math.max(0, totalBytes - dataLength);
        droppedBytes += dataLength;
        recordDropped(typeof data === "string" ? data : "", getOutputChunkMeta(chunk));
        continue;
      }

      const droppedText = data.slice(0, bytesToDrop);
      const retainedText = data.slice(bytesToDrop);
      chunks[0] = getOutputChunkMeta(chunk)
        ? { data: retainedText, meta: getOutputChunkMeta(chunk) }
        : retainedText;
      totalBytes = Math.max(0, totalBytes - bytesToDrop);
      droppedBytes += bytesToDrop;
      recordDropped(droppedText);
    }

    const terminalState = inspectDroppedTerminalState({
      droppedHead,
      droppedTail,
      retainedHead: readBufferedOutputHead(chunks, maxDroppedStateScanBytes),
      droppedBytes,
    });
    if (terminalState.mayAffectTerminalState) {
      droppedMeta = mergeTerminalOutputMeta(droppedMeta, {
        droppedOutputMayAffectTerminalState: true,
        droppedOutputAlternateScreenAction: terminalState.finalAlternateScreenAction,
      });
    }
    if (droppedMeta && chunks.length > 0) {
      chunks[0] = withOutputChunkMeta(chunks[0], droppedMeta);
    }
    pendingOutputBytes.set(sessionId, totalBytes);
  }

  function bufferOutput(sessionId, data, meta) {
    if (
      !sessionId
      || closedSessions.has(sessionId)
      || maxPendingOutputChunks === 0
      || maxPendingOutputBytes === 0
    ) {
      return;
    }
    const chunks = pendingOutput.get(sessionId) || [];
    const chunk = normalizeOutputChunk(data, meta);
    chunks.push(chunk);
    pendingOutputBytes.set(
      sessionId,
      (pendingOutputBytes.get(sessionId) || 0) + getOutputChunkLength(chunk),
    );
    trimBufferedOutput(sessionId, chunks);
    pendingOutput.set(sessionId, chunks);
  }

  function flushBufferedOutput(sessionId) {
    const chunks = pendingOutput.get(sessionId);
    if (!sessionId || !chunks?.length) return;
    pendingOutput.delete(sessionId);
    pendingOutputBytes.delete(sessionId);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const data = chunk && typeof chunk === "object" && "data" in chunk ? chunk.data : chunk;
      const meta = chunk && typeof chunk === "object" ? chunk.meta : undefined;
      if (!deliverOutputToRenderer(sessionId, data, meta)) {
        for (let retryIndex = index; retryIndex < chunks.length; retryIndex += 1) {
          bufferOutput(sessionId, chunks[retryIndex]);
        }
        break;
      }
    }
  }

  function sendOutputOverLegacyIpc(sessionId, data, meta) {
    const webContentsId = sessionWebContentsIds.get(sessionId);
    if (!webContentsId) return false;
    const contents = electronModule?.webContents?.fromId?.(webContentsId);
    if (!contents?.send) return false;
    contents.send("netcatty:data", meta ? { sessionId, data, meta } : { sessionId, data });
    return true;
  }

  function deliverOutputToRenderer(sessionId, data, meta) {
    if (terminalOutputChannel?.send?.(sessionId, data, meta)) return true;
    return sendOutputOverLegacyIpc(sessionId, data, meta);
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

  function deliverReadyPortFallbackOutput(sessionId, data, meta) {
    outputPortReady.delete(sessionId);
    terminalOutputChannel?.closeSession?.(sessionId);
    if (!sendOutputOverLegacyIpc(sessionId, data, meta)) {
      bufferOutput(sessionId, data, meta);
    }
  }

  function unwrapMessageEvent(eventOrMessage) {
    if (
      eventOrMessage &&
      typeof eventOrMessage === "object" &&
      !("kind" in eventOrMessage) &&
      "data" in eventOrMessage
    ) {
      return eventOrMessage.data;
    }
    return eventOrMessage;
  }

  function handleMessage(eventOrMessage) {
    const message = unwrapMessageEvent(eventOrMessage);
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
      // Chunks sent through the runtime sender's port fallback were already
      // announced via a dedicated output-tap message (message.tapped);
      // notifying taps again here would double-write session logs and
      // script output buffers. Plain output messages (e.g. from the early
      // worker sender) still need the notification.
      if (!message.tapped) {
        notifyOutputTaps(message.sessionId, message.data);
      }
      if (outputPortPending.has(message.sessionId)) {
        bufferOutput(message.sessionId, message.data, message.meta);
        return;
      }
      if (outputPortReady.has(message.sessionId)) {
        deliverReadyPortFallbackOutput(message.sessionId, message.data, message.meta);
        return;
      }
      if (!deliverOutputToRenderer(message.sessionId, message.data, message.meta)) {
        bufferOutput(message.sessionId, message.data, message.meta);
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
      return;
    }
    if (message.kind === "zmodem-upload-dialog") {
      void handleZmodemUploadDialogRequest(message);
      return;
    }
    if (message.kind === "zmodem-download-dialog") {
      void handleZmodemDownloadDialogRequest(message);
    }
  }

  async function handleZmodemUploadDialogRequest(message) {
    try {
      const contents = electronModule?.webContents?.fromId?.(message.webContentsId);
      const win = contents && electronModule?.BrowserWindow?.fromWebContents
        ? electronModule.BrowserWindow.fromWebContents(contents)
        : null;
      const result = await electronModule?.dialog?.showOpenDialog?.(win || undefined, {
        properties: ["openFile", "multiSelections"],
        title: "Select files to upload (ZMODEM)",
      });
      child?.postMessage?.({
        kind: "zmodem-upload-dialog-result",
        requestId: message.requestId,
        result: result || { canceled: true, filePaths: [] },
      });
    } catch (err) {
      child?.postMessage?.({
        kind: "zmodem-upload-dialog-result",
        requestId: message.requestId,
        error: err?.message || String(err),
      });
    }
  }

  async function handleZmodemDownloadDialogRequest(message) {
    try {
      const contents = electronModule?.webContents?.fromId?.(message.webContentsId);
      const win = contents && electronModule?.BrowserWindow?.fromWebContents
        ? electronModule.BrowserWindow.fromWebContents(contents)
        : null;
      const result = await electronModule?.dialog?.showOpenDialog?.(win || undefined, {
        properties: ["openDirectory", "createDirectory"],
        title: "Select download directory (ZMODEM)",
      });
      child?.postMessage?.({
        kind: "zmodem-download-dialog-result",
        requestId: message.requestId,
        result: result || { canceled: true, filePaths: [] },
      });
    } catch (err) {
      child?.postMessage?.({
        kind: "zmodem-download-dialog-result",
        requestId: message.requestId,
        error: err?.message || String(err),
      });
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
    pendingOutputBytes.clear();
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
    if (channel === "netcatty:close:await" && payload?.sessionId) {
      closeOutputSession(payload.sessionId);
    } else if (payload?.sessionId) {
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
      pendingOutputBytes.clear();
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
