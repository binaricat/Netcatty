"use strict";

const { releaseAttachedSessionState } = require("./terminalAttachRestore.cjs");

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  logTerminalInterruptDebug,
  normalizeTrace,
} = require("./terminalInterruptDiagnostics.cjs");
const {
  TERMINAL_URGENT_INPUT_PORT_CHANNEL,
} = require("./terminalUrgentInputChannel.cjs");
const {
  clearTerminalSessionPerformanceState,
} = require("./emitTerminalSessionData.cjs");

const DEFAULT_CLOSED_SESSION_TOMBSTONE_TTL_MS = 60_000;
const DEFAULT_MAX_CLOSED_SESSION_TOMBSTONES = 2_048;
const SSH_TRANSPORT_IDLE_TTL_ENV = "NETCATTY_SSH_TRANSPORT_IDLE_TTL_MS";

function resolveInitialTransportIdleTtlMs(options = {}) {
  if (Number.isFinite(options.initialTransportIdleTtlMs)
    && options.initialTransportIdleTtlMs >= 0) {
    return Number(options.initialTransportIdleTtlMs);
  }
  try {
    const { getDefaultTransportIdleTtlMs } = require("./sshConnectionPool.cjs");
    return getDefaultTransportIdleTtlMs();
  } catch {
    return 5 * 60_000;
  }
}

function registerTransportIdleTtlSettingsSync(ipcMain, terminalWorkerManager) {
  if (!ipcMain?.on || !terminalWorkerManager?.setDefaultTransportIdleTtlMs) {
    return () => {};
  }
  const { STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS } = require("./sshConnectionPool.cjs");
  const listener = (_event, payload) => {
    if (payload?.key !== STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS) return;
    terminalWorkerManager.setDefaultTransportIdleTtlMs(payload.value);
  };
  ipcMain.on("netcatty:settings:changed", listener);
  return () => ipcMain.removeListener?.("netcatty:settings:changed", listener);
}

function isTerminalWorkerEnabled(options = {}) {
  const env = options.env || process.env;
  return env.NETCATTY_TERMINAL_WORKER !== "0";
}

const TRANSFER_RENDERER_CHANNELS = new Set([
  "netcatty:transfer:queued",
  "netcatty:transfer:started",
  "netcatty:transfer:progress",
  "netcatty:transfer:complete",
  "netcatty:transfer:cancelled",
  "netcatty:transfer:error",
  "netcatty:compress:progress",
  "netcatty:compress:complete",
  "netcatty:compress:cancelled",
  "netcatty:compress:error",
]);

function shouldForwardWorkerRendererEvent(channel) {
  return !TRANSFER_RENDERER_CHANNELS.has(channel);
}

/**
 * Lift worker-local lifecycleEpoch into main-process space when transferBridge
 * has advanced the control epoch (pause rollback / soft-resume).
 */
function translateWorkerTransferLifecycleEpoch(transferId, workerEpoch) {
  try {
    // Lazy require avoids circular init with transferBridge.
    const transferBridge = require("./transferBridge.cjs");
    if (typeof transferBridge.resolveWorkerTransferLifecycleEpoch === "function") {
      return transferBridge.resolveWorkerTransferLifecycleEpoch(transferId, workerEpoch);
    }
  } catch {
    // transferBridge unavailable in pure unit fixtures
  }
  return workerEpoch;
}

/**
 * Map worker transfer IPC onto the global transfer-center channel.
 * The utilityProcess cannot call BrowserWindow; main must fan these out.
 * Exported for unit tests.
 */
function mapWorkerTransferChannelToGlobalEvent(channel, payload) {
  const transferId = payload?.transferId || payload?.compressionId;
  if (!payload || !transferId) return null;
  if (channel === "netcatty:transfer:progress") {
    return {
      type: "progress",
      transferId,
      transferred: payload.transferred,
      totalBytes: payload.totalBytes,
      speed: payload.speed,
      phase: payload.phase,
      checkpointBytes: payload.checkpointBytes,
      resumeStage: payload.resumeStage,
      downloadCheckpointBytes: payload.downloadCheckpointBytes,
      uploadCheckpointBytes: payload.uploadCheckpointBytes,
      sourceFingerprint: payload.sourceFingerprint,
      lifecycleEpoch: translateWorkerTransferLifecycleEpoch(transferId, payload.lifecycleEpoch),
      lifecycleState: payload.lifecycleState,
      resumable: payload.resumable,
      pauseUnavailableReason: payload.pauseUnavailableReason,
      parentTaskId: payload.parentTaskId,
      directoryEntryIndex: payload.directoryEntryIndex,
      directoryEntryIdentity: payload.directoryEntryIdentity,
    };
  }
  if (channel === "netcatty:transfer:queued" || channel === "netcatty:transfer:started") {
    return {
      ...payload,
      type: channel.endsWith(":queued") ? "queued" : "started",
      transferId,
      lifecycleEpoch: translateWorkerTransferLifecycleEpoch(transferId, payload.lifecycleEpoch),
    };
  }
  if (channel === "netcatty:transfer:complete") {
    return {
      type: "completed",
      transferId,
      endedAt: Date.now(),
      transferred: payload.transferred,
      totalBytes: payload.totalBytes,
      parentTaskId: payload.parentTaskId,
      directoryEntryIndex: payload.directoryEntryIndex,
      directoryEntryIdentity: payload.directoryEntryIdentity,
    };
  }
  if (channel === "netcatty:transfer:cancelled") {
    return {
      type: "cancelled",
      transferId,
      endedAt: Date.now(),
      parentTaskId: payload.parentTaskId,
    };
  }
  if (channel === "netcatty:transfer:error") {
    const message = payload.error || String(payload.error || "Transfer failed");
    const cancelled = /cancel/i.test(message);
    return {
      type: cancelled ? "cancelled" : "failed",
      transferId,
      endedAt: Date.now(),
      error: message,
      parentTaskId: payload.parentTaskId,
    };
  }
  if (channel === "netcatty:compress:progress") {
    return {
      type: "progress",
      transferId,
      phase: payload.phase,
      transferred: payload.transferredBytes,
      totalBytes: payload.totalBytes,
      fileName: payload.fileName,
      sourcePath: payload.sourcePath,
      targetPath: payload.targetPath,
      direction: "upload",
      isDirectory: true,
      controlKind: "compressed-upload",
      lifecycleEpoch: payload.lifecycleEpoch,
      lifecycleState: payload.lifecycleState,
    };
  }
  if (channel === "netcatty:compress:complete") {
    return { type: "completed", transferId, endedAt: Date.now() };
  }
  if (channel === "netcatty:compress:cancelled") {
    return { type: "cancelled", transferId, endedAt: Date.now() };
  }
  if (channel === "netcatty:compress:error") {
    return {
      type: "failed",
      transferId,
      endedAt: Date.now(),
      error: payload.error || "Compressed upload failed",
    };
  }
  return null;
}

function broadcastGlobalTransferEventOnMain(electronModule, eventPayload) {
  if (!eventPayload) return 0;
  const BrowserWindow = electronModule?.BrowserWindow;
  if (!BrowserWindow?.getAllWindows) return 0;
  let sent = 0;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win?.isDestroyed?.()) continue;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed?.()) continue;
      wc.send("netcatty:sftp:global-transfer", eventPayload);
      sent += 1;
    } catch {
      // best-effort
    }
  }
  return sent;
}

function fanoutGlobalTransferFromWorkerEvent(electronModule, channel, payload) {
  const eventPayload = mapWorkerTransferChannelToGlobalEvent(channel, payload);
  return broadcastGlobalTransferEventOnMain(electronModule, eventPayload);
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
  const pluginPipelineIngressBytes = Number(previous?.pluginPipelineIngressBytes ?? 0)
    + Number(next.pluginPipelineIngressBytes ?? 0);
  if (pluginPipelineIngressBytes > 0) merged.pluginPipelineIngressBytes = pluginPipelineIngressBytes;
  else delete merged.pluginPipelineIngressBytes;
  if (typeof next.pluginPipelineSensitiveInput === "boolean") {
    merged.pluginPipelineSensitiveInput = next.pluginPipelineSensitiveInput;
  } else {
    delete merged.pluginPipelineSensitiveInput;
  }
  if (next.pluginPipelineProcessed === true) {
    merged.pluginPipelineProcessed = true;
  } else {
    delete merged.pluginPipelineProcessed;
  }
  if (!merged.droppedOutputMayAffectTerminalState) {
    delete merged.droppedOutputMayAffectTerminalState;
  }
  if (!merged.droppedOutputAlternateScreenAction) {
    delete merged.droppedOutputAlternateScreenAction;
  }
  return merged;
}

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
  const closedSessionSequences = new Map();
  const closedSessionTombstoneTimes = new Map();
  let sessionLifecycleSequence = 0;
  const outputPortPending = new Map();
  const outputPortReady = new Set();
  const outputRoutePending = new Map();
  const pendingSessionStartSequences = new Map();
  const latestSessionStartSequences = new Map();
  const suppressedPendingOutputSessions = new Set();
  const workerSessionIds = new Set();
  const sessionWebContentsIds = new Map();
  const sessionHostIds = new Map();
  const sessionGenerations = new Map();
  const closedSessionGenerations = new Map();
  const supersedingSessionGenerations = new Map();
  const urgentInputPorts = new Map();
  const outputTaps = new Set();
  const terminalInterceptorWarningListeners = new Set();
  const sessionOwnedListeners = new Set();
  const sessionClosedListeners = new Set();
  const workerExitListeners = new Set();
  const workerRendererEventListeners = new Set();
  const externalSessions = new Map();
  const maxPendingOutputChunks = Number.isFinite(options.maxPendingOutputChunks)
    ? Math.max(0, Math.trunc(options.maxPendingOutputChunks))
    : 512;
  const maxPendingOutputBytes = Number.isFinite(options.maxPendingOutputBytes)
    ? Math.max(0, Math.trunc(options.maxPendingOutputBytes))
    : 2 * 1024 * 1024;
  const maxDroppedStateScanBytes = Math.max(256, options.maxDroppedStateScanBytes ?? 2048);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const closedSessionTombstoneTtlMs = Number.isFinite(options.closedSessionTombstoneTtlMs)
    ? Math.max(0, Number(options.closedSessionTombstoneTtlMs))
    : DEFAULT_CLOSED_SESSION_TOMBSTONE_TTL_MS;
  const maxClosedSessionTombstones = Number.isFinite(options.maxClosedSessionTombstones)
    ? Math.max(1, Math.floor(Number(options.maxClosedSessionTombstones)))
    : DEFAULT_MAX_CLOSED_SESSION_TOMBSTONES;
  let transportIdleTtlMs = resolveInitialTransportIdleTtlMs(options);

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
    const displayLength = typeof data === "string" ? data.length : 0;
    // A suppressed interceptor result can carry flow-accounting metadata with
    // an empty display string. Count that record as one bounded buffer unit so
    // the chunk/byte trimming loop cannot stop on a zero-length head.
    return displayLength || (getOutputChunkMeta(chunk) ? 1 : 0);
  }

  function withOutputChunkMeta(chunk, meta) {
    // Dropped metadata describes older chunks. Merge the retained chunk last
    // so latest-chunk state such as sensitive-input classification cannot be
    // revived by an earlier prompt while additive ingress/state metadata is
    // still preserved.
    const mergedMeta = mergeTerminalOutputMeta(meta, getOutputChunkMeta(chunk) || {});
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
      const displayLength = typeof data === "string" ? data.length : 0;
      // Metadata-only suppressed output still represents consumed host input.
      // Drop it atomically when it contributes virtual ingress bytes; partial
      // string slicing cannot safely reduce that metadata accounting.
      const dropWholeChunk = chunks.length > maxPendingOutputChunks
        || dataLength !== displayLength;
      const overLimitBytes = Math.max(0, totalBytes - maxPendingOutputBytes);
      const bytesToDrop = dropWholeChunk ? dataLength : Math.min(dataLength, overLimitBytes);
      if (bytesToDrop <= 0) break;

      if (typeof data !== "string" || bytesToDrop >= dataLength) {
        chunks.shift();
        totalBytes = Math.max(0, totalBytes - dataLength);
        droppedBytes += displayLength;
        recordDropped(typeof data === "string" ? data : "", getOutputChunkMeta(chunk));
        continue;
      }

      const droppedText = data.slice(0, bytesToDrop);
      const retainedText = data.slice(bytesToDrop);
      const retainedMeta = getOutputChunkMeta(chunk);
      const adjustedRetainedMeta = retainedMeta?.pluginPipelineProcessed !== true
        && Number.isFinite(retainedMeta?.pluginPipelineIngressBytes)
        ? mergeTerminalOutputMeta(
          { pluginPipelineIngressBytes: bytesToDrop },
          retainedMeta,
        )
        : retainedMeta;
      chunks[0] = adjustedRetainedMeta
        ? { data: retainedText, meta: adjustedRetainedMeta }
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
      || (closedSessions.has(sessionId) && !hasPendingSessionLifecycle(sessionId))
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

  function isLiveWebContentsId(webContentsId) {
    if (typeof webContentsId !== "number") return false;
    try {
      const contents = electronModule?.webContents?.fromId?.(webContentsId);
      return Boolean(contents && !contents.isDestroyed?.());
    } catch {
      return false;
    }
  }

  async function openOutputSession(sessionId, webContentsId, isStillCurrent = null) {
    if (!sessionId || !webContentsId) return false;
    if (closedSessions.has(sessionId)) {
      clearBufferedOutput(sessionId);
      return false;
    }
    const contents = electronModule?.webContents?.fromId?.(webContentsId);
    if (!contents || contents.isDestroyed?.()) {
      return false;
    }
    const previousWebContentsId = sessionWebContentsIds.get(sessionId) ?? null;
    const openToken = Object.freeze({ webContentsId });
    outputRoutePending.set(sessionId, openToken);
    const onDestroyed = () => {
      if (outputRoutePending.get(sessionId) === openToken) {
        outputRoutePending.delete(sessionId);
      }
    };
    contents.once?.("destroyed", onDestroyed);
    try {
      await Promise.allSettled([...sessionOwnedListeners].map((listener) => (
        Promise.resolve().then(() => listener(Object.freeze({ sessionId, webContentsId })))
      )));
    } finally {
      contents.removeListener?.("destroyed", onDestroyed);
    }
    if (closedSessions.has(sessionId)) return false;
    if (isStillCurrent && !isStillCurrent()) {
      if (outputRoutePending.get(sessionId) === openToken) {
        outputRoutePending.delete(sessionId);
      }
      return false;
    }
    if (outputRoutePending.get(sessionId) !== openToken) {
      return outputRoutePending.get(sessionId)?.webContentsId === webContentsId;
    }
    if (contents.isDestroyed?.()) {
      outputRoutePending.delete(sessionId);
      if (previousWebContentsId == null) {
        send("netcatty:close", { sessionId }, { webContentsId });
      }
      return false;
    }
    let openedUrgentInputPort = false;
    let replacedOutputChannel = false;
    let transferringBufferedOutput = [];
    let workerIpcFailed = false;
    try {
      sessionWebContentsIds.set(sessionId, webContentsId);
      openedUrgentInputPort = openUrgentInputPort(webContentsId, contents);
      const outputPort = terminalOutputChannel?.openSession?.(sessionId, contents, {
        transferToWorker: true,
      });
      replacedOutputChannel = Boolean(outputPort);
      if (outputPort && outputPort !== true && child?.postMessage) {
        const worker = child;
        const outputPortRequestId = randomUUID();
        const sessionGeneration = sessionGenerations.get(sessionId) ?? 0;
        outputPortReady.delete(sessionId);
        outputPortPending.set(sessionId, outputPortRequestId);
        transferringBufferedOutput = takeBufferedOutput(sessionId);
        try {
          worker.postMessage({
            kind: "output-port",
            sessionId,
            outputPortRequestId,
            sessionGeneration,
            bufferedOutput: transferringBufferedOutput,
          }, [outputPort]);
        } catch (error) {
          workerIpcFailed = true;
          retireWorkerAfterIpcFailure(worker, error);
          throw error;
        }
        transferringBufferedOutput = [];
        if (outputRoutePending.get(sessionId) === openToken) {
          outputRoutePending.delete(sessionId);
        }
        return true;
      }
      if (outputRoutePending.get(sessionId) === openToken) {
        outputRoutePending.delete(sessionId);
      }
      flushBufferedOutput(sessionId);
      return true;
    } catch {
      if (workerIpcFailed) return false;
      for (const chunk of transferringBufferedOutput) {
        bufferOutput(sessionId, chunk);
      }
      outputPortPending.delete(sessionId);
      outputPortReady.delete(sessionId);
      if (replacedOutputChannel) {
        terminalOutputChannel?.closeSession?.(sessionId);
      }
      if (
        openedUrgentInputPort
        && previousWebContentsId !== webContentsId
      ) {
        closeUrgentInputPort(webContentsId);
      }
      if (isLiveWebContentsId(previousWebContentsId)) {
        sessionWebContentsIds.set(sessionId, previousWebContentsId);
      } else {
        sessionWebContentsIds.delete(sessionId);
      }
      if (outputRoutePending.get(sessionId) === openToken) {
        outputRoutePending.delete(sessionId);
      }
      if (isLiveWebContentsId(previousWebContentsId)) {
        flushOutputToWorker(sessionId);
      } else {
        clearBufferedOutput(sessionId);
        send("netcatty:close", { sessionId }, { webContentsId });
      }
      return false;
    }
  }

  /**
   * Move a live session's renderer output route to another webContents
   * (AI silent-session observe popup). Same PTY; only the display target changes.
   */
  /** sessionId -> home webContentsId while an attach/observe popup owns display */
  const attachHomeWebContentsIds = new Map();

  async function rebindOutputSession(sessionId, webContentsId) {
    if (!sessionId || !webContentsId) {
      return { success: false, error: "Missing sessionId or webContentsId" };
    }
    if (closedSessions.has(sessionId) || !sessionWebContentsIds.has(sessionId)) {
      return { success: false, error: "Session not found" };
    }
    const previousWebContentsId = sessionWebContentsIds.get(sessionId) ?? null;
    // Remember the first home target so popup destruction / session exit can
    // restore or dual-notify the original owner.
    let rememberedAttachHome = false;
    if (
      previousWebContentsId != null
      && previousWebContentsId !== webContentsId
      && !attachHomeWebContentsIds.has(sessionId)
    ) {
      attachHomeWebContentsIds.set(sessionId, previousWebContentsId);
      rememberedAttachHome = true;
    }
    const ok = await openOutputSession(sessionId, webContentsId);
    if (!ok) {
      if (rememberedAttachHome) {
        attachHomeWebContentsIds.delete(sessionId);
      }
      return { success: false, error: "Failed to rebind session output" };
    }
    return {
      success: true,
      previousWebContentsId,
      webContentsId,
    };
  }

  function findFallbackHomeWebContentsId(preferredId) {
    if (isLiveWebContentsId(preferredId)) return preferredId;
    // Only fall back to registered main app windows — never settings/prewarm/
    // tray/popup renderers, which cannot host the hidden silent Terminal.
    try {
      const wm = require("./windowManager.cjs");
      const mains = typeof wm.getMainWindows === "function"
        ? wm.getMainWindows()
        : (typeof wm.getMainWindow === "function" ? [wm.getMainWindow()].filter(Boolean) : []);
      for (const win of mains) {
        const wc = win?.webContents;
        if (!wc || wc.isDestroyed?.()) continue;
        if (typeof wc.id === "number") return wc.id;
      }
    } catch {
      // ignore
    }
    return null;
  }

  async function restoreAttachHome(sessionId, preferredHomeWebContentsId = null) {
    if (!sessionId) return { success: false, restored: false };
    const savedHomeId = attachHomeWebContentsIds.get(sessionId);
    if (savedHomeId == null) {
      return { success: true, restored: false };
    }
    if (closedSessions.has(sessionId)) {
      attachHomeWebContentsIds.delete(sessionId);
      return { success: true, restored: false };
    }
    const homeId = findFallbackHomeWebContentsId(preferredHomeWebContentsId ?? savedHomeId);
    if (homeId == null) {
      // Keep the attach-home mapping so a later tray re-open can still recover.
      return {
        success: false,
        restored: false,
        error: "Home renderer unavailable",
      };
    }
    const ok = await openOutputSession(sessionId, homeId);
    if (ok) {
      attachHomeWebContentsIds.delete(sessionId);
    }
    return {
      success: ok,
      restored: ok,
      webContentsId: ok ? homeId : undefined,
      error: ok ? undefined : "Failed to restore attach home output",
    };
  }

  function resolveDialogWebContentsId(webContentsId, sessionId) {
    // Dialog requests are interactive session work. During attach/rebind the
    // pending renderer already owns that interaction even though the committed
    // output mapping is intentionally not published until port transfer.
    if (typeof sessionId === "string") {
      const pending = outputRoutePending.get(sessionId)?.webContentsId;
      if (isLiveWebContentsId(pending)) return pending;
      const current = sessionWebContentsIds.get(sessionId);
      if (isLiveWebContentsId(current)) return current;
    }
    // Worker dialogs often still carry the original home id after rebind.
    // Prefer the current display route when this id is a remembered attach home.
    if (typeof webContentsId !== "number") return webContentsId;
    for (const [sessionId, homeId] of attachHomeWebContentsIds.entries()) {
      if (homeId !== webContentsId) continue;
      const current = sessionWebContentsIds.get(sessionId);
      if (isLiveWebContentsId(current)) return current;
    }
    return webContentsId;
  }

  function getAttachHomeWebContentsId(sessionId) {
    if (!sessionId) return null;
    return attachHomeWebContentsIds.get(sessionId) ?? null;
  }

  function clearAttachHome(sessionId) {
    if (sessionId) attachHomeWebContentsIds.delete(sessionId);
  }

  function deleteClosedSessionTombstone(sessionId) {
    closedSessionTombstoneTimes.delete(sessionId);
    closedSessions.delete(sessionId);
    closedSessionSequences.delete(sessionId);
    closedSessionGenerations.delete(sessionId);
  }

  function canPruneClosedSessionTombstone(sessionId) {
    return !pendingSessionStartSequences.has(sessionId)
      && !sessionGenerations.has(sessionId)
      && !workerSessionIds.has(sessionId)
      && !sessionWebContentsIds.has(sessionId)
      && !outputRoutePending.has(sessionId);
  }

  function pruneClosedSessionTombstones() {
    const currentTime = now();
    for (const [sessionId, closedAt] of closedSessionTombstoneTimes) {
      if (currentTime - closedAt < closedSessionTombstoneTtlMs) continue;
      if (!canPruneClosedSessionTombstone(sessionId)) continue;
      deleteClosedSessionTombstone(sessionId);
    }
    if (closedSessionTombstoneTimes.size <= maxClosedSessionTombstones) return;
    for (const sessionId of [...closedSessionTombstoneTimes.keys()]) {
      if (closedSessionTombstoneTimes.size <= maxClosedSessionTombstones) break;
      if (!canPruneClosedSessionTombstone(sessionId)) continue;
      deleteClosedSessionTombstone(sessionId);
    }
  }

  function touchClosedSessionTombstone(sessionId) {
    if (!sessionId) return;
    closedSessionTombstoneTimes.delete(sessionId);
    closedSessionTombstoneTimes.set(sessionId, now());
  }

  function updateClosedSessionSequence(sessionId) {
    closedSessionSequences.set(sessionId, ++sessionLifecycleSequence);
    touchClosedSessionTombstone(sessionId);
  }

  function markSessionClosed(sessionId) {
    if (!sessionId || closedSessions.has(sessionId)) return;
    closedSessions.add(sessionId);
    updateClosedSessionSequence(sessionId);
  }

  function cancelPendingSessionStart(sessionId) {
    if (!pendingSessionStartSequences.delete(sessionId)) return;
    if (closedSessions.has(sessionId)) {
      updateClosedSessionSequence(sessionId);
    }
  }

  function finishPendingSessionStart(entry) {
    if (entry?.requestedSessionId
      && pendingSessionStartSequences.get(entry.requestedSessionId) === entry.requestSequence) {
      pendingSessionStartSequences.delete(entry.requestedSessionId);
    }
  }

  function hasPendingSessionLifecycle(sessionId) {
    const pendingStartSequence = pendingSessionStartSequences.get(sessionId);
    const closedSequence = closedSessionSequences.get(sessionId);
    return pendingStartSequence != null
      && (closedSequence == null || pendingStartSequence > closedSequence);
  }

  function recordClosedSessionGeneration(sessionId, generation) {
    if (!sessionId || !Number.isSafeInteger(generation)) return;
    const previous = closedSessionGenerations.get(sessionId);
    if (previous == null || generation > previous) {
      closedSessionGenerations.set(sessionId, generation);
      touchClosedSessionTombstone(sessionId);
    }
  }

  function recordSupersedingSessionGeneration(message) {
    if (!message?.sessionId
      || !Number.isSafeInteger(message.sessionGeneration)
      || !message.replacementRequestId) return;
    const entry = pending.get(message.replacementRequestId);
    if (!entry?.requestedSessionId || entry.requestedSessionId !== message.sessionId) return;
    let generations = supersedingSessionGenerations.get(message.sessionId);
    if (!generations) {
      generations = new Map();
      supersedingSessionGenerations.set(message.sessionId, generations);
    }
    generations.set(message.sessionGeneration, {
      requestId: message.replacementRequestId,
      requestSequence: entry.requestSequence,
    });
  }

  function takeSupersedingSessionGeneration(sessionId, generation) {
    if (!sessionId || !Number.isSafeInteger(generation)) return null;
    const generations = supersedingSessionGenerations.get(sessionId);
    const marker = generations?.get(generation) ?? null;
    if (!marker) return null;
    generations.delete(generation);
    if (generations.size === 0) supersedingSessionGenerations.delete(sessionId);
    return marker;
  }

  function clearOlderSupersedingSessionGenerations(sessionId, generation) {
    if (!sessionId || !Number.isSafeInteger(generation)) return;
    const generations = supersedingSessionGenerations.get(sessionId);
    if (!generations) return;
    for (const oldGeneration of generations.keys()) {
      if (oldGeneration < generation) generations.delete(oldGeneration);
    }
    if (generations.size === 0) supersedingSessionGenerations.delete(sessionId);
  }

  function isOutputFromNewerGeneration(message) {
    if (!Number.isSafeInteger(message?.sessionGeneration)) return false;
    const closedGeneration = closedSessionGenerations.get(message.sessionId);
    return message.sessionGeneration > (closedGeneration ?? 0);
  }

  function isOutputFromCurrentPendingStart(message) {
    if (!Number.isSafeInteger(message?.sessionGeneration)) return false;
    if (!message?.originRequestId) return isOutputFromNewerGeneration(message);
    const entry = pending.get(message.originRequestId);
    const latestStartSequence = latestSessionStartSequences.get(message.sessionId);
    const isCurrentRequest = entry?.requestedSessionId === message.sessionId
      && latestStartSequence != null
      && entry.requestSequence === latestStartSequence;
    if (!isCurrentRequest) return false;
    const closedGeneration = closedSessionGenerations.get(message.sessionId);
    return closedGeneration == null || message.sessionGeneration > closedGeneration;
  }

  function closeOutputSession(sessionId) {
    if (!sessionId) return;
    markSessionClosed(sessionId);
    latestSessionStartSequences.delete(sessionId);
    suppressedPendingOutputSessions.delete(sessionId);
    workerSessionIds.delete(sessionId);
    clearBufferedOutput(sessionId);
    outputRoutePending.delete(sessionId);
    outputPortPending.delete(sessionId);
    outputPortReady.delete(sessionId);
    sessionWebContentsIds.delete(sessionId);
    sessionHostIds.delete(sessionId);
    const activeGeneration = sessionGenerations.get(sessionId);
    recordClosedSessionGeneration(sessionId, activeGeneration);
    sessionGenerations.delete(sessionId);
    supersedingSessionGenerations.delete(sessionId);
    clearAttachHome(sessionId);
    clearTerminalSessionPerformanceState(sessionId);
    releaseAttachedSessionState(sessionId);
    pruneClosedSessionTombstones();
    const worker = child;
    try {
      worker?.postMessage?.({ kind: "close-output-port", sessionId });
    } catch (error) {
      retireWorkerAfterIpcFailure(worker, error);
    }
    terminalOutputChannel?.closeSession?.(sessionId);
  }

  function notifyExplicitSessionClose(sessionId) {
    if (!sessionId) return;
    const targets = new Set([
      sessionWebContentsIds.get(sessionId),
      attachHomeWebContentsIds.get(sessionId),
    ]);
    for (const targetId of targets) {
      if (typeof targetId !== "number") continue;
      try {
        electronModule?.webContents?.fromId?.(targetId)?.send?.("netcatty:exit", {
          sessionId,
          exitCode: 0,
          reason: "closed",
        });
      } catch {
        // A closing renderer may disappear between lookup and notification.
      }
    }
  }

  function notifySessionClosed(sessionId, reason) {
    if (!sessionId) return;
    for (const listener of [...sessionClosedListeners]) {
      try { listener(Object.freeze({ sessionId, reason })); } catch {}
    }
  }

  function drainOutputSession(sessionId, requestId) {
    if (!sessionId || !requestId || !outputPortReady.has(sessionId)) return false;
    const worker = ensureStarted();
    try {
      worker.postMessage({ kind: "output-drain", sessionId, requestId });
      return true;
    } catch (error) {
      retireWorkerAfterIpcFailure(worker, error);
      return false;
    }
  }

  function openUrgentInputPort(webContentsId, contents) {
    if (!webContentsId || urgentInputPorts.has(webContentsId)) return false;
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
      const onDestroyed = () => closeUrgentInputPort(webContentsId);
      urgentInputPorts.set(webContentsId, { port1, port2, contents, onDestroyed });
      contents.once?.("destroyed", onDestroyed);
      return true;
    } catch {
      try { port1?.close?.(); } catch {}
      try { port2?.close?.(); } catch {}
      try { child?.postMessage?.({ kind: "close-urgent-input-port", webContentsId }); } catch {}
      return false;
    }
  }

  function closeUrgentInputPort(webContentsId) {
    const entry = urgentInputPorts.get(webContentsId);
    if (!entry) return;
    urgentInputPorts.delete(webContentsId);
    entry.contents?.removeListener?.("destroyed", entry.onDestroyed);
    try { entry.port1?.close?.(); } catch {}
    try { entry.port2?.close?.(); } catch {}
    try { child?.postMessage?.({ kind: "close-urgent-input-port", webContentsId }); } catch {}
  }

  function closeAllUrgentInputPorts() {
    for (const webContentsId of Array.from(urgentInputPorts.keys())) {
      closeUrgentInputPort(webContentsId);
    }
  }

  function flushOutputToWorker(sessionId) {
    const chunks = takeBufferedOutput(sessionId);
    if (!chunks.length || closedSessions.has(sessionId)) return;
    const worker = child;
    try {
      worker?.postMessage?.({ kind: "output-flush", sessionId, chunks });
    } catch (error) {
      for (const chunk of chunks) bufferOutput(sessionId, chunk);
      retireWorkerAfterIpcFailure(worker, error);
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
    if (message.kind === "external-session-event") {
      const external = externalSessions.get(message.sessionId);
      if (!external) return;
      if (message.event === "input") {
        const runInput = async () => {
          if (externalSessions.get(message.sessionId) !== external) return;
          await external.onInput?.(message.data);
        };
        const inputPromise = external.inputChain
          ? external.inputChain.then(runInput, runInput)
          : Promise.resolve(runInput());
        const settledInput = inputPromise.catch(async (error) => {
          const notifyClose = external.onClose;
          await finishExternalSession(message.sessionId, {
            reason: "error",
            error: error?.message || String(error),
          }, external.ownerToken).finally(() => Promise.resolve(notifyClose?.("input-error")).catch(() => {}));
        });
        external.inputChain = settledInput;
        void settledInput.finally(() => {
          if (external.inputChain === settledInput) external.inputChain = null;
        });
        return;
      }
      if (message.event === "resize") {
        void Promise.resolve(external.onResize?.({
          columns: message.columns,
          rows: message.rows,
        })).catch(() => {});
        return;
      }
      if (message.event === "flow") {
        external.paused = message.paused === true;
        if (!external.paused) {
          for (const resolve of external.resumeWaiters.splice(0)) resolve();
        }
        return;
      }
      if (message.event === "close") {
        externalSessions.delete(message.sessionId);
        for (const resolve of external.resumeWaiters.splice(0)) resolve();
        void Promise.resolve(external.onClose?.(message.reason || "closed")).catch(() => {});
      }
      return;
    }
    if (message.kind === "session-superseding") {
      recordSupersedingSessionGeneration(message);
      return;
    }
    if (message.kind === "response") {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      if (message.error) {
        if (entry.opensOutputSession && entry.requestedSessionId
          && latestSessionStartSequences.get(entry.requestedSessionId) === entry.requestSequence) {
          clearBufferedOutput(entry.requestedSessionId);
          suppressedPendingOutputSessions.add(entry.requestedSessionId);
          if (!sessionWebContentsIds.has(entry.requestedSessionId)
            && !outputRoutePending.has(entry.requestedSessionId)) {
            workerSessionIds.delete(entry.requestedSessionId);
          }
        }
        finishPendingSessionStart(entry);
        pending.delete(message.requestId);
        entry.reject(new Error(message.error));
      } else {
        const sessionId = message.result?.sessionId;
        if (!entry.opensOutputSession || !sessionId) {
          finishPendingSessionStart(entry);
          pending.delete(message.requestId);
          entry.resolve(message.result);
          return;
        }
        const latestStartSequence = latestSessionStartSequences.get(sessionId);
        if (latestStartSequence != null && entry.requestSequence < latestStartSequence) {
          if (Number.isSafeInteger(message.sessionGeneration)) {
            recordClosedSessionGeneration(sessionId, message.sessionGeneration);
          }
          finishPendingSessionStart(entry);
          pending.delete(message.requestId);
          entry.reject(new Error("Terminal session was superseded by a newer start request"));
          return;
        }
        const closedSequence = closedSessionSequences.get(sessionId);
        if (closedSequence != null && closedSequence >= entry.requestSequence) {
          recordClosedSessionGeneration(sessionId, message.sessionGeneration);
          finishPendingSessionStart(entry);
          pending.delete(message.requestId);
          entry.reject(new Error("Terminal session closed before its output route opened"));
          return;
        }
        suppressedPendingOutputSessions.delete(sessionId);
        closedSessionGenerations.delete(sessionId);
        closedSessions.delete(sessionId);
        closedSessionSequences.delete(sessionId);
        closedSessionTombstoneTimes.delete(sessionId);
        workerSessionIds.add(sessionId);
        if (Number.isSafeInteger(message.sessionGeneration)) {
          sessionGenerations.set(sessionId, message.sessionGeneration);
          clearOlderSupersedingSessionGenerations(sessionId, message.sessionGeneration);
        }
        const isStillCurrent = () => {
          if (!entry.requestedSessionId) return true;
          const latestSequence = latestSessionStartSequences.get(sessionId);
          const currentClosedSequence = closedSessionSequences.get(sessionId);
          return latestSequence === entry.requestSequence
            && !(currentClosedSequence != null && currentClosedSequence >= entry.requestSequence);
        };
        void openOutputSession(sessionId, entry.webContentsId, isStillCurrent).then((opened) => {
          if (pending.get(message.requestId) !== entry) return;
          finishPendingSessionStart(entry);
          pending.delete(message.requestId);
          if (!opened) {
            const currentClosedSequence = closedSessionSequences.get(sessionId);
            if (currentClosedSequence != null && currentClosedSequence >= entry.requestSequence) {
              entry.reject(new Error("Terminal session closed before its output route opened"));
            } else if (entry.requestedSessionId
              && latestSessionStartSequences.get(sessionId) !== entry.requestSequence) {
              recordClosedSessionGeneration(sessionId, message.sessionGeneration);
              if (sessionGenerations.get(sessionId) === message.sessionGeneration) {
                sessionGenerations.delete(sessionId);
              }
              entry.reject(new Error("Terminal session was superseded by a newer start request"));
            } else {
              entry.reject(new Error("Terminal session closed before its output route opened"));
            }
            return;
          }
          entry.resolve(message.result);
        }, (error) => {
          if (pending.get(message.requestId) !== entry) return;
          finishPendingSessionStart(entry);
          pending.delete(message.requestId);
          entry.reject(error);
        });
      }
      return;
    }
    if (message.kind === "output") {
      if (suppressedPendingOutputSessions.has(message.sessionId)
        && !isOutputFromCurrentPendingStart(message)) return;
      if (closedSessions.has(message.sessionId)) {
        if (!hasPendingSessionLifecycle(message.sessionId)
          || !isOutputFromCurrentPendingStart(message)) return;
        bufferOutput(message.sessionId, message.data, message.meta);
        return;
      }
      if (message.sessionId) workerSessionIds.add(message.sessionId);
      // Chunks sent through the runtime sender's port fallback were already
      // announced via a dedicated output-tap message (message.tapped);
      // notifying taps again here would double-write session logs and
      // script output buffers. Plain output messages (e.g. from the early
      // worker sender) still need the notification.
      if (!message.tapped) {
        notifyOutputTaps(message.sessionId, message.data);
      }
      if (outputRoutePending.has(message.sessionId) || outputPortPending.has(message.sessionId)) {
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
      if (suppressedPendingOutputSessions.has(message.sessionId)
        && !isOutputFromCurrentPendingStart(message)) return;
      if (!closedSessions.has(message.sessionId)
        || (hasPendingSessionLifecycle(message.sessionId)
          && isOutputFromCurrentPendingStart(message))) {
        if (message.sessionId) workerSessionIds.add(message.sessionId);
        notifyOutputTaps(message.sessionId, message.data);
      }
      return;
    }
    if (message.kind === "output-port-ready") {
      if (!message.outputPortRequestId
        || outputPortPending.get(message.sessionId) !== message.outputPortRequestId
        || !Number.isSafeInteger(message.sessionGeneration)
        || (sessionGenerations.get(message.sessionId) ?? 0) !== message.sessionGeneration) return;
      outputPortPending.delete(message.sessionId);
      if (!closedSessions.has(message.sessionId)) {
        outputPortReady.add(message.sessionId);
        flushOutputToWorker(message.sessionId);
      }
      return;
    }
    if (message.kind === "terminal-interceptor-warning") {
      for (const listener of [...terminalInterceptorWarningListeners]) {
        try { listener(message.warning); } catch {}
      }
      return;
    }
    if (message.kind === "renderer-event") {
      for (const listener of [...workerRendererEventListeners]) {
        try { listener(message); } catch {}
      }
      // Transfer lifecycle from the utilityProcess cannot use BrowserWindow
      // inside the worker. Fan global-center events from the main process so
      // progress survives SFTP panel hide/unmount.
      fanoutGlobalTransferFromWorkerEvent(electronModule, message.channel, message.payload);

      // Transfer events have one renderer-facing route: global-transfer. Do not
      // also forward the worker's internal channel to the origin window.
      if (!shouldForwardWorkerRendererEvent(message.channel)) return;

      // Prefer the currently rebound display target. Worker-captured
      // webContentsId is from session start and goes stale after attach/rebind.
      const sessionId = message.payload?.sessionId;
      const originEntry = message.originRequestId
        ? pending.get(message.originRequestId)
        : null;
      const latestStartSequence = latestSessionStartSequences.get(sessionId);
      if (message.channel === "netcatty:exit"
        && Number.isSafeInteger(message.sessionGeneration)
      ) {
        const closedGeneration = closedSessionGenerations.get(sessionId);
        if (closedGeneration != null && message.sessionGeneration <= closedGeneration) return;
        if (sessionGenerations.has(sessionId)
          && sessionGenerations.get(sessionId) !== message.sessionGeneration) {
          return;
        }
      }
      const supersedingMarker = message.channel === "netcatty:exit"
        ? takeSupersedingSessionGeneration(sessionId, message.sessionGeneration)
        : null;
      const isSupersededActiveExit = Boolean(
        supersedingMarker
        && latestStartSequence != null
        && latestStartSequence >= supersedingMarker.requestSequence
        && hasPendingSessionLifecycle(sessionId),
      );
      if (isSupersededActiveExit) {
        const displayWebContentsId = sessionWebContentsIds.get(sessionId) ?? message.webContentsId;
        const homeWebContentsId = attachHomeWebContentsIds.get(sessionId) ?? null;
        recordClosedSessionGeneration(sessionId, message.sessionGeneration);
        clearBufferedOutput(sessionId);
        outputRoutePending.delete(sessionId);
        outputPortPending.delete(sessionId);
        outputPortReady.delete(sessionId);
        workerSessionIds.delete(sessionId);
        sessionWebContentsIds.delete(sessionId);
        if (sessionGenerations.get(sessionId) === message.sessionGeneration) {
          sessionGenerations.delete(sessionId);
        }
        clearAttachHome(sessionId);
        terminalOutputChannel?.closeSession?.(sessionId);
        suppressedPendingOutputSessions.add(sessionId);
        notifySessionClosed(sessionId, message.payload?.reason || "superseded");
        const targets = new Set([displayWebContentsId, homeWebContentsId]);
        if (onRendererEvent) {
          for (const webContentsId of targets) {
            if (webContentsId == null) continue;
            onRendererEvent({ ...message, webContentsId });
          }
        } else {
          for (const webContentsId of targets) {
            if (webContentsId == null) continue;
            electronModule?.webContents?.fromId?.(webContentsId)?.send?.(
              message.channel,
              message.payload,
            );
          }
        }
        return;
      }
      const isSupersededStartExit = message.channel === "netcatty:exit"
        && originEntry?.requestedSessionId === sessionId
        && latestStartSequence != null
        && originEntry.requestSequence < latestStartSequence;
      if (isSupersededStartExit) {
        recordClosedSessionGeneration(sessionId, message.sessionGeneration);
        clearBufferedOutput(sessionId);
        workerSessionIds.delete(sessionId);
        finishPendingSessionStart(originEntry);
        pending.delete(message.originRequestId);
        originEntry.reject(new Error("Terminal session was superseded by a newer start request"));
        notifySessionClosed(sessionId, message.payload?.reason);
        return;
      }
      const displayWebContentsId =
        (typeof sessionId === "string" && outputRoutePending.get(sessionId)?.webContentsId)
        || (typeof sessionId === "string" && sessionWebContentsIds.get(sessionId))
        || message.webContentsId;
      const homeWebContentsId =
        (typeof sessionId === "string" && attachHomeWebContentsIds.get(sessionId))
        || null;
      const wasExplicitlyClosed = Boolean(
        message.channel === "netcatty:exit"
        && sessionId
        && closedSessions.has(sessionId)
        && !hasPendingSessionLifecycle(sessionId),
      );
      if (message.channel === "netcatty:exit" && sessionId) {
        if (Number.isSafeInteger(message.sessionGeneration)) {
          recordClosedSessionGeneration(sessionId, message.sessionGeneration);
        }
        cancelPendingSessionStart(sessionId);
        closeOutputSession(sessionId);
        clearAttachHome(sessionId);
        if (!wasExplicitlyClosed) {
          notifySessionClosed(sessionId, message.payload?.reason);
        }
      }
      // Explicit close already notified both display and home before removing
      // their routes. Ignore the worker's later transport-level exit event.
      if (wasExplicitlyClosed) return;
      const targets = new Set();
      if (displayWebContentsId != null) targets.add(displayWebContentsId);
      // Keep the original owner in the loop only for terminal lifecycle. Other
      // renderer events may be interactive and must have a single responder.
      if (message.channel === "netcatty:exit" && homeWebContentsId != null) {
        targets.add(homeWebContentsId);
      }
      if (targets.size === 0 && message.webContentsId != null) {
        targets.add(message.webContentsId);
      }
      if (onRendererEvent) {
        for (const webContentsId of targets) {
          onRendererEvent({
            ...message,
            webContentsId,
          });
        }
        return;
      }
      for (const webContentsId of targets) {
        const contents = electronModule?.webContents?.fromId?.(webContentsId);
        contents?.send?.(message.channel, message.payload);
      }
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
      const webContentsId = resolveDialogWebContentsId(message.webContentsId, message.sessionId);
      const contents = electronModule?.webContents?.fromId?.(webContentsId);
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
      const webContentsId = resolveDialogWebContentsId(message.webContentsId, message.sessionId);
      const contents = electronModule?.webContents?.fromId?.(webContentsId);
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

  function retireWorkerAfterIpcFailure(worker, error) {
    if (!worker || child !== worker) return;
    handleExit(1, error);
    try { worker.kill?.(); } catch {}
  }

  function handleExit(code, cause = null) {
    const error = cause instanceof Error
      ? cause
      : new Error(`Terminal worker exited${Number.isFinite(code) ? ` with code ${code}` : ""}`);
    const exitCode = Number.isFinite(code) ? code : 1;
    for (const listener of [...workerExitListeners]) {
      try { listener(error); } catch {}
    }
    const affectedSessionIds = new Set([
      ...sessionWebContentsIds.keys(),
      ...outputRoutePending.keys(),
      ...workerSessionIds,
      ...pendingOutput.keys(),
      ...pendingSessionStartSequences.keys(),
    ]);
    const sessionNotifications = [];
    for (const sessionId of affectedSessionIds) {
      const hasNewPendingLifecycle = hasPendingSessionLifecycle(sessionId);
      if (closedSessions.has(sessionId) && !hasNewPendingLifecycle) continue;
      if (closedSessions.has(sessionId)) {
        updateClosedSessionSequence(sessionId);
      } else {
        markSessionClosed(sessionId);
      }
      const targets = new Set();
      const webContentsId = sessionWebContentsIds.get(sessionId);
      if (webContentsId != null) targets.add(webContentsId);
      const pendingWebContentsId = outputRoutePending.get(sessionId)?.webContentsId;
      if (pendingWebContentsId != null) targets.add(pendingWebContentsId);
      const homeId = attachHomeWebContentsIds.get(sessionId);
      if (homeId != null) targets.add(homeId);
      sessionNotifications.push({ sessionId, targets });
    }
    child = null;
    pendingOutput.clear();
    pendingOutputBytes.clear();
    outputPortPending.clear();
    outputPortReady.clear();
    outputRoutePending.clear();
    pendingSessionStartSequences.clear();
    latestSessionStartSequences.clear();
    suppressedPendingOutputSessions.clear();
    workerSessionIds.clear();
    sessionWebContentsIds.clear();
    sessionHostIds.clear();
    sessionGenerations.clear();
    closedSessionGenerations.clear();
    supersedingSessionGenerations.clear();
    attachHomeWebContentsIds.clear();
    pruneClosedSessionTombstones();
    closeAllUrgentInputPorts();
    rejectAllPending(error);
    terminalOutputChannel?.closeAll?.();
    const retiredExternalSessions = [...externalSessions.entries()];
    externalSessions.clear();
    for (const [, external] of retiredExternalSessions) {
      for (const resolve of external.resumeWaiters.splice(0)) resolve();
      void Promise.resolve(external.onClose?.("worker-exit")).catch(() => {});
    }
    for (const listener of [...terminalInterceptorWarningListeners]) {
      try {
        listener(Object.freeze({ code: "worker-exit", message: error.message }));
      } catch {}
    }
    for (const { sessionId, targets } of sessionNotifications) {
      for (const targetId of targets) {
        try {
          const contents = electronModule?.webContents?.fromId?.(targetId);
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
      notifySessionClosed(sessionId, "worker-exit");
    }
  }

  function ensureStarted() {
    if (child) return child;
    if (!utilityProcess?.fork) {
      throw new Error("Electron utilityProcess is unavailable");
    }
    // The worker loads the SSH pool before it can receive IPC. Seed the latest
    // value through its environment so a first request (and every replacement
    // worker) can never briefly use the product default instead of the setting.
    const worker = utilityProcess.fork(workerScriptPath, [], {
      env: {
        ...process.env,
        [SSH_TRANSPORT_IDLE_TTL_ENV]: String(transportIdleTtlMs),
      },
    });
    child = worker;
    worker.on?.("message", (message) => {
      if (child === worker) handleMessage(message);
    });
    worker.on?.("exit", (code) => {
      if (child === worker) handleExit(code);
    });
    return worker;
  }

  function setDefaultTransportIdleTtlMs(value) {
    if (!Number.isFinite(value) || value < 0) return transportIdleTtlMs;
    const normalized = Number(value);
    if (normalized === transportIdleTtlMs) return transportIdleTtlMs;
    transportIdleTtlMs = normalized;
    const worker = child;
    if (!worker) return transportIdleTtlMs;
    try {
      worker.postMessage({
        kind: "set-ssh-transport-idle-ttl",
        value: transportIdleTtlMs,
      });
    } catch (error) {
      retireWorkerAfterIpcFailure(worker, error);
    }
    return transportIdleTtlMs;
  }

  function request(channel, payload, optionsForRequest = {}) {
    pruneClosedSessionTombstones();
    if (channel === "netcatty:close:await"
      && payload?.sessionId
      && closedSessions.has(payload.sessionId)
      && !pendingSessionStartSequences.has(payload.sessionId)) {
      return Promise.resolve(undefined);
    }
    const requestId = randomUUID();
    const worker = ensureStarted();
    const requestSequence = ++sessionLifecycleSequence;
    const requestedSessionId = payload?.sessionId && SESSION_START_CHANNELS.has(channel)
      ? payload.sessionId
      : null;
    const promise = new Promise((resolve, reject) => {
      pending.set(requestId, {
        resolve,
        reject,
        requestSequence,
        requestedSessionId,
        webContentsId: optionsForRequest.webContentsId,
        opensOutputSession: channel === "netcatty:start"
          || channel === "netcatty:local:reconnect"
          || channel === "netcatty:external:start"
          || /^(?:netcatty:)(?:local|telnet|mosh|et|serial):start$/u.test(channel),
      });
    });
    let notifyClosedAfterPost = false;
    if (channel === "netcatty:close:await" && payload?.sessionId) {
      const closesPendingLifecycle = hasPendingSessionLifecycle(payload.sessionId);
      notifyClosedAfterPost = !closedSessions.has(payload.sessionId) || closesPendingLifecycle;
      cancelPendingSessionStart(payload.sessionId);
      notifyExplicitSessionClose(payload.sessionId);
      closeOutputSession(payload.sessionId);
    } else if (requestedSessionId) {
      if (pendingSessionStartSequences.has(requestedSessionId)) {
        clearBufferedOutput(requestedSessionId);
        suppressedPendingOutputSessions.add(requestedSessionId);
      }
      pendingSessionStartSequences.set(requestedSessionId, requestSequence);
      latestSessionStartSequences.set(requestedSessionId, requestSequence);
      // Track host id for SFTP transfer session leases (global transfer center).
      if (typeof payload?.hostId === "string" && payload.hostId) {
        sessionHostIds.set(requestedSessionId, payload.hostId);
      }
    }
    try {
      worker.postMessage({
        kind: "request",
        requestId,
        channel,
        payload,
        webContentsId: optionsForRequest.webContentsId,
      });
    } catch (error) {
      retireWorkerAfterIpcFailure(worker, error);
      const entry = pending.get(requestId);
      pending.delete(requestId);
      finishPendingSessionStart(entry);
      entry?.reject(error);
    }
    if (notifyClosedAfterPost) notifySessionClosed(payload.sessionId, "closed");
    return promise;
  }

  async function startExternalSession(optionsForSession = {}) {
    const sessionId = optionsForSession.sessionId;
    const webContentsId = optionsForSession.webContentsId;
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 128) {
      throw new TypeError("External terminal session ID is invalid");
    }
    if (!Number.isSafeInteger(webContentsId) || externalSessions.has(sessionId)) {
      throw new TypeError("External terminal session owner is invalid or already registered");
    }
    const ownerToken = optionsForSession.ownerToken ?? Symbol(`external-session:${sessionId}`);
    const external = {
      ownerToken,
      onInput: optionsForSession.onInput,
      onResize: optionsForSession.onResize,
      onClose: optionsForSession.onClose,
      inputChain: null,
      paused: false,
      resumeWaiters: [],
    };
    externalSessions.set(sessionId, external);
    try {
      return await request("netcatty:external:start", {
        sessionId,
        columns: optionsForSession.columns,
        rows: optionsForSession.rows,
        protocol: optionsForSession.protocol,
        hostLabel: optionsForSession.hostLabel,
        hostname: optionsForSession.hostname,
        sessionLog: optionsForSession.sessionLog,
      }, { webContentsId });
    } catch (error) {
      if (externalSessions.get(sessionId) === external) externalSessions.delete(sessionId);
      throw error;
    }
  }

  async function pushExternalOutput(sessionId, data, meta, ownerToken) {
    const external = externalSessions.get(sessionId);
    if (!external) throw new Error("External terminal session is not registered");
    if (ownerToken !== undefined && external.ownerToken !== ownerToken) return false;
    if (external.paused) {
      await new Promise((resolve) => external.resumeWaiters.push(resolve));
      if (externalSessions.get(sessionId) !== external) return false;
    }
    await request("netcatty:external:output", {
      sessionId,
      data,
      ...(meta === undefined ? {} : { meta }),
    });
    return true;
  }

  async function finishExternalSession(sessionId, details = {}, ownerToken) {
    const external = externalSessions.get(sessionId);
    if (!external) return false;
    if (ownerToken !== undefined && external.ownerToken !== ownerToken) return false;
    externalSessions.delete(sessionId);
    for (const resolve of external.resumeWaiters.splice(0)) resolve();
    try {
      await request("netcatty:external:finish", {
        sessionId,
        reason: details.reason || "closed",
        ...(details.error ? { error: details.error } : {}),
        ...(Array.isArray(details.diagnostics) ? { diagnostics: details.diagnostics } : {}),
      });
    } catch {
      closeOutputSession(sessionId);
    }
    return true;
  }

  function send(channel, payload, optionsForSend = {}) {
    pruneClosedSessionTombstones();
    if (channel === "netcatty:close"
      && payload?.sessionId
      && closedSessions.has(payload.sessionId)
      && !pendingSessionStartSequences.has(payload.sessionId)) {
      closeOutputSession(payload.sessionId);
      return;
    }
    if (channel === "netcatty:close" && payload?.sessionId) {
      const closesPendingLifecycle = hasPendingSessionLifecycle(payload.sessionId);
      const shouldNotifyClosed = !closedSessions.has(payload.sessionId) || closesPendingLifecycle;
      cancelPendingSessionStart(payload.sessionId);
      notifyExplicitSessionClose(payload.sessionId);
      closeOutputSession(payload.sessionId);
      let postError = null;
      const worker = ensureStarted();
      try {
        worker.postMessage({
          kind: "send",
          channel,
          payload,
          webContentsId: optionsForSend.webContentsId,
        });
      } catch (error) {
        retireWorkerAfterIpcFailure(worker, error);
        postError = error;
      }
      if (shouldNotifyClosed) notifySessionClosed(payload.sessionId, "closed");
      if (postError) throw postError;
      return;
    }
    if (channel === "netcatty:interrupt") {
      const trace = normalizeTrace(payload);
      logTerminalInterruptDebug("main-to-worker-send", {
        channel,
        webContentsId: optionsForSend.webContentsId,
        hasChild: Boolean(child),
      }, trace);
    }
    const worker = ensureStarted();
    try {
      worker.postMessage({
        kind: "send",
        channel,
        payload,
        webContentsId: optionsForSend.webContentsId,
      });
    } catch (error) {
      retireWorkerAfterIpcFailure(worker, error);
      throw error;
    }
  }

  function attachTerminalInterceptor(descriptor, port) {
    if (!port) throw new TypeError("Terminal interceptor port is required");
    const worker = ensureStarted();
    try {
      worker.postMessage({
        kind: "terminal-interceptor-port",
        ...descriptor,
      }, [port]);
    } catch (error) {
      retireWorkerAfterIpcFailure(worker, error);
      throw error;
    }
  }

  function detachTerminalInterceptor(sessionId, direction) {
    if (!child) return;
    const worker = child;
    try {
      worker.postMessage({ kind: "terminal-interceptor-detach", sessionId, direction });
    } catch (error) {
      retireWorkerAfterIpcFailure(worker, error);
    }
  }

  function onTerminalInterceptorWarning(listener) {
    if (typeof listener !== "function") throw new TypeError("Terminal interceptor warning listener is required");
    terminalInterceptorWarningListeners.add(listener);
    return Object.freeze({ dispose: () => terminalInterceptorWarningListeners.delete(listener) });
  }

  function onSessionOwned(listener) {
    if (typeof listener !== "function") throw new TypeError("Terminal session owner listener is required");
    sessionOwnedListeners.add(listener);
    return Object.freeze({ dispose: () => sessionOwnedListeners.delete(listener) });
  }

  function onSessionClosed(listener) {
    if (typeof listener !== "function") throw new TypeError("Terminal session close listener is required");
    sessionClosedListeners.add(listener);
    return Object.freeze({ dispose: () => sessionClosedListeners.delete(listener) });
  }

  function onWorkerExit(listener) {
    if (typeof listener !== "function") throw new TypeError("Worker exit listener is required");
    workerExitListeners.add(listener);
    return Object.freeze({ dispose: () => workerExitListeners.delete(listener) });
  }

  function onWorkerRendererEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("Worker renderer event listener is required");
    workerRendererEventListeners.add(listener);
    return Object.freeze({ dispose: () => workerRendererEventListeners.delete(listener) });
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
      closedSessionSequences.clear();
      closedSessionTombstoneTimes.clear();
      outputPortPending.clear();
      outputPortReady.clear();
      outputRoutePending.clear();
      pendingSessionStartSequences.clear();
      latestSessionStartSequences.clear();
      suppressedPendingOutputSessions.clear();
      workerSessionIds.clear();
      sessionWebContentsIds.clear();
      sessionHostIds.clear();
      sessionGenerations.clear();
      closedSessionGenerations.clear();
      supersedingSessionGenerations.clear();
      closeAllUrgentInputPorts();
      terminalInterceptorWarningListeners.clear();
      sessionOwnedListeners.clear();
      sessionClosedListeners.clear();
      workerExitListeners.clear();
      workerRendererEventListeners.clear();
      for (const external of externalSessions.values()) {
        for (const resolve of external.resumeWaiters.splice(0)) resolve();
      }
      externalSessions.clear();
      terminalOutputChannel?.closeAll?.();
      rejectAllPending(new Error("Terminal worker stopped"));
    }
  }

  return {
    ensureStarted,
    /** True when the utilityProcess child is currently alive. */
    isRunning() {
      return Boolean(child);
    },
    request,
    send,
    startExternalSession,
    pushExternalOutput,
    finishExternalSession,
    openOutputSession,
    rebindOutputSession,
    drainOutputSession,
    restoreAttachHome,
    getAttachHomeWebContentsId,
    clearAttachHome,
    attachTerminalInterceptor,
    detachTerminalInterceptor,
    onTerminalInterceptorWarning,
    onSessionOwned,
    onSessionClosed,
    onWorkerExit,
    onWorkerRendererEvent,
    hasOpenSession(sessionId) {
      return Boolean(
        sessionId
        && sessionWebContentsIds.has(sessionId)
        && !closedSessions.has(sessionId),
      );
    },
    getSessionWebContentsId(sessionId) {
      if (!sessionId) return null;
      return sessionWebContentsIds.get(sessionId) ?? null;
    },
    getSessionHostId(sessionId) {
      if (!sessionId) return null;
      return sessionHostIds.get(sessionId) ?? null;
    },
    getSessionOwnerWebContentsId(sessionId) {
      if (!sessionId || closedSessions.has(sessionId)) return null;
      const pendingWebContentsId = outputRoutePending.get(sessionId)?.webContentsId;
      if (isLiveWebContentsId(pendingWebContentsId)) return pendingWebContentsId;
      const currentWebContentsId = sessionWebContentsIds.get(sessionId);
      return isLiveWebContentsId(currentWebContentsId) ? currentWebContentsId : null;
    },
    ownsSession(sessionId, webContentsId) {
      const pendingWebContentsId = outputRoutePending.get(sessionId)?.webContentsId;
      return Boolean(
        sessionId
        && Number.isSafeInteger(webContentsId)
        && (
          (sessionWebContentsIds.get(sessionId) === webContentsId
            && isLiveWebContentsId(webContentsId))
          || (pendingWebContentsId === webContentsId
            && isLiveWebContentsId(webContentsId))
        )
        && !closedSessions.has(sessionId),
      );
    },
    addOutputTap(listener) {
      if (typeof listener !== "function") return () => {};
      outputTaps.add(listener);
      return () => outputTaps.delete(listener);
    },
    setDefaultTransportIdleTtlMs,
    getDefaultTransportIdleTtlMs() {
      return transportIdleTtlMs;
    },
    _getClosedSessionTombstoneCountsForTests() {
      pruneClosedSessionTombstones();
      return {
        sessions: closedSessions.size,
        sequences: closedSessionSequences.size,
        generations: closedSessionGenerations.size,
      };
    },
    stop,
  };
}

module.exports = {
  createTerminalWorkerManager,
  isTerminalWorkerEnabled,
  mapWorkerTransferChannelToGlobalEvent,
  fanoutGlobalTransferFromWorkerEvent,
  broadcastGlobalTransferEventOnMain,
  shouldForwardWorkerRendererEvent,
  registerTransportIdleTtlSettingsSync,
};
