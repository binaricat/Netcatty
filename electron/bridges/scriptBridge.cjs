"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createScriptRuntime } = require("../scripts/scriptRuntime.cjs");
const { stepsToJavaScript } = require("../scripts/scriptCodegen.cjs");
const {
  appendSessionOutput,
  getOrCreateBuffer,
  removeSessionBuffer,
} = require("../scripts/sessionOutputBuffer.cjs");
const { shellPromptPatterns } = require("../scripts/shellPromptPatterns.cjs");
const { addTerminalDataTap } = require("../bridges/emitTerminalSessionData.cjs");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

let sessions = null;
let electronModule = null;
let terminalBridge = null;
let terminalWorkerManager = null;
let getMainWindow = null;

/** @type {Map<string, object>} */
const runs = new Map();
/** @type {Map<string, object>} */
const recordings = new Map();
/** @type {Map<string, { resolve, reject, type }>} */
const pendingDialogs = new Map();
/** @type {Map<string, { resolve, reject, sessionId }>} */
const pendingScreenSnapshots = new Map();
/** @type {Map<string, symbol>} */
const scriptLogTokens = new Map();
/** @type {Map<string, Promise<void>>} */
const sessionRunChains = new Map();
/** @type {Map<string, { connected?: boolean, hostname?: string, username?: string }>} */
const rendererSessionMetaById = new Map();

function enqueueSessionRun(sessionId, task) {
  const previous = sessionRunChains.get(sessionId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => task());
  sessionRunChains.set(
    sessionId,
    next.then(() => {}, () => {}),
  );
  return next;
}

function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule;
  terminalBridge = deps.terminalBridge;
  terminalWorkerManager = deps.terminalWorkerManager || null;
  getMainWindow = deps.getMainWindow;

  addTerminalDataTap((sessionId, data) => {
    appendSessionOutput(sessionId, data);
  });
  terminalWorkerManager?.addOutputTap?.((sessionId, data) => {
    appendSessionOutput(sessionId, data);
  });
}

function broadcastRuns() {
  const win = getMainWindow?.();
  if (!win?.webContents) return;
  win.webContents.send("netcatty:script:runs-updated", {
    runs: Array.from(runs.values()).map(serializeRun),
  });
}

function serializeRun(run) {
  const now = Date.now();
  const elapsedMs = run.endedAt
    ? run.endedAt - run.startedAt
    : Math.max(0, now - run.startedAt);
  return {
    runId: run.runId,
    scriptId: run.scriptId,
    scriptLabel: run.scriptLabel,
    sessionId: run.sessionId,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    currentStep: run.currentStep,
    stepIndex: run.stepIndex,
    totalSteps: run.totalSteps,
    progressMode: run.progressMode || "activity",
    activityLabel: run.activityLabel,
    progressLabel: run.progressLabel,
    progressCurrent: run.progressCurrent,
    progressTotal: run.progressTotal,
    elapsedMs,
    waitingFor: run.waitingFor,
    logs: run.logs.slice(-200),
    error: run.error,
  };
}

function isWorkerSessionOpen(sessionId) {
  return Boolean(sessionId && terminalWorkerManager?.hasOpenSession?.(sessionId));
}

function rememberRendererSessionMeta(sessionId, meta) {
  if (!sessionId || !meta || typeof meta !== "object") return;
  const prev = rendererSessionMetaById.get(sessionId) || {};
  rendererSessionMetaById.set(sessionId, { ...prev, ...meta });
}

function hasActiveOutputBuffer(sessionId) {
  try {
    return Boolean(String(getOrCreateBuffer(sessionId).getText() || "").trim());
  } catch {
    return false;
  }
}

function isSessionConnected(sessionId) {
  const session = sessions?.get(sessionId);
  if (session) {
    return session.status !== "disconnected";
  }
  const rendererMeta = rendererSessionMetaById.get(sessionId);
  return Boolean(
    rendererMeta?.connected
    || isWorkerSessionOpen(sessionId)
    || hasActiveOutputBuffer(sessionId),
  );
}

function getSessionMeta(sessionId) {
  const session = sessions?.get(sessionId);
  const rendererMeta = rendererSessionMetaById.get(sessionId);
  if (session) {
    return {
      connected: session.status !== "disconnected",
      hostname: session.hostname || session.hostLabel || rendererMeta?.hostname || "",
      username: session.username || rendererMeta?.username || "",
    };
  }
  if (isSessionConnected(sessionId)) {
    return {
      connected: true,
      hostname: rendererMeta?.hostname || "",
      username: rendererMeta?.username || "",
    };
  }
  return { connected: false, hostname: "", username: "" };
}

function notifyScriptSessionInput(sessionId, data) {
  const session = sessions?.get(sessionId);
  const webContents = session?.webContentsId
    ? electronModule.webContents.fromId(session.webContentsId)
    : getMainWindow?.()?.webContents;
  webContents?.send("netcatty:script:session-input", { sessionId, data });
}

function writeToSession(sessionId, data, options = {}) {
  const payload = {
    sessionId,
    data,
    automated: options.automated !== false,
  };
  const webContentsId = getMainWindow?.()?.webContents?.id;
  if (terminalWorkerManager) {
    // Mirror input-based log rewrites into the main-process stream manager
    // (see the netcatty:write forwarder in terminalBridge.registerHandlers);
    // the real write handler runs in the terminal worker process.
    sessionLogStreamManager.registerSudoAutofillInput(sessionId, data);
    terminalWorkerManager.send("netcatty:write", payload, { webContentsId });
  } else {
    terminalBridge?.writeToSession?.(
      { sender: getMainWindow?.()?.webContents },
      payload,
    );
  }
  if (options.automated !== false && data && data !== "\x03") {
    notifyScriptSessionInput(sessionId, data);
  }
}

async function requestScreenSnapshot(sessionId) {
  const session = sessions?.get(sessionId);
  const webContents = session?.webContentsId
    ? electronModule.webContents.fromId(session.webContentsId)
    : getMainWindow?.()?.webContents;
  if (!webContents) {
    return {
      rows: 24,
      cols: 80,
      currentRow: 0,
      lines: getOrCreateBuffer(sessionId).getText().split("\n"),
    };
  }

  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScreenSnapshots.delete(requestId);
      resolve({
        rows: 24,
        cols: 80,
        currentRow: 0,
        lines: getOrCreateBuffer(sessionId).getText().split("\n"),
      });
    }, 3000);
    pendingScreenSnapshots.set(requestId, {
      sessionId,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    webContents.send("netcatty:script:screen-snapshot-request", { requestId, sessionId });
  });
}

function showDialog(type, message, defaultValue, extras = {}) {
  const win = getMainWindow?.();
  const webContents = win?.webContents;
  if (!webContents) {
    if (type === "confirm") return Promise.resolve(false);
    if (type === "prompt") return Promise.resolve(defaultValue || "");
    if (type === "form") return Promise.resolve({});
    if (type === "waitForTimeout") return Promise.resolve("abort");
    return Promise.resolve(undefined);
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDialogs.delete(requestId);
      reject(new Error("Dialog timed out"));
    }, 120000);
    pendingDialogs.set(requestId, {
      type,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    webContents.send("netcatty:script:dialog-request", {
      requestId,
      type,
      message,
      defaultValue,
      ...extras,
    });
  });
}

function showWaitForTimeoutDialog(pattern, timeoutMs) {
  return showDialog(
    "waitForTimeout",
    `Timed out waiting for "${pattern}" after ${timeoutMs}ms`,
    undefined,
    { pattern, timeoutMs },
  );
}

async function syncOutputBufferFromSnapshot(sessionId) {
  const buffer = getOrCreateBuffer(sessionId);
  const syncStartText = buffer.getText();
  let consumedLength = syncStartText.length;
  try {
    const snapshot = await requestScreenSnapshot(sessionId);
    const screenText = (snapshot.lines || []).join("\n");
    if (!screenText) return;
    if (buffer.getText() !== syncStartText) return;
    const existing = buffer.getText();
    if (!existing) {
      buffer.append(screenText.endsWith("\n") ? screenText : `${screenText}\n`);
      consumedLength = buffer.getText().length;
      return;
    }
    const tail = screenText.slice(-8192);
    if (!tail) return;
    const existingTail = existing.slice(-8192);
    if (tail === existingTail || existing.endsWith(tail)) return;
    if (existingTail && tail.includes(existingTail)) {
      buffer.append(tail.slice(tail.indexOf(existingTail) + existingTail.length));
      consumedLength = buffer.getText().length;
      return;
    }
    if (!existing.includes(tail.trim())) {
      buffer.append(tail.startsWith("\n") ? tail : `\n${tail}`);
      consumedLength = buffer.getText().length;
    }
  } catch {
    // Keep startup synchronization best-effort; the current buffer is still baselined below.
  } finally {
    buffer.markOutputConsumedThrough(consumedLength, { preserveTailPatterns: shellPromptPatterns() });
  }
}

async function runScriptOnSession({
  runId,
  scriptId,
  scriptLabel,
  sessionId,
  content,
  permissionMode = "auto",
  sessionMeta,
}) {
  rememberRendererSessionMeta(sessionId, sessionMeta);
  const run = {
    runId,
    scriptId,
    scriptLabel,
    sessionId,
    status: "running",
    startedAt: Date.now(),
    endedAt: undefined,
    currentStep: undefined,
    stepIndex: 0,
    totalSteps: undefined,
    progressMode: "activity",
    activityLabel: undefined,
    progressLabel: undefined,
    progressCurrent: undefined,
    progressTotal: undefined,
    waitingFor: undefined,
    logs: [],
    paused: false,
    aborted: false,
  };
  runs.set(runId, run);
  broadcastRuns();

  const runtime = createScriptRuntime({
    sessionId,
    runId,
    appVersion: electronModule?.app?.getVersion?.(),
    appendLog: (id, message) => {
      const entry = runs.get(id);
      if (!entry) return;
      entry.logs.push({ at: Date.now(), message });
      broadcastRuns();
    },
    writeToSession,
    getOutputBuffer: getOrCreateBuffer,
    getScreenSnapshot: requestScreenSnapshot,
    getSessionMeta,
    showDialog,
    showWaitForTimeoutDialog,
    disconnectSession: async (sid) => {
      if (terminalWorkerManager) {
        terminalWorkerManager.send("netcatty:close", { sessionId: sid });
      } else {
        terminalBridge?.closeSession?.({ sender: {} }, { sessionId: sid });
      }
    },
    startSessionLog: async (sid, logPath) => {
      const session = sessions?.get(sid);
      const defaultDir = electronModule?.app?.getPath?.("documents") || process.cwd();
      const filePath = logPath
        ? path.resolve(String(logPath))
        : path.join(defaultDir, `netcatty-script-${Date.now()}.log`);
      const result = sessionLogStreamManager.startStreamToFile(sid, {
        filePath,
        hostLabel: session?.hostname || session?.hostLabel || "script",
        format: "raw",
        stopRequiresToken: true,
      });
      if (!result.ok) {
        throw new Error(result.error || "Failed to start script log");
      }
      scriptLogTokens.set(sid, result.token);
    },
    stopSessionLog: async (sid) => {
      const token = scriptLogTokens.get(sid);
      if (token) {
        sessionLogStreamManager.stopStream(sid, token);
        scriptLogTokens.delete(sid);
      }
    },
    isPaused: () => Boolean(runs.get(runId)?.paused),
    isAborted: () => Boolean(runs.get(runId)?.aborted),
    permissionMode,
    startedAt: run.startedAt,
    onStatusChange: (id, patch) => {
      const entry = runs.get(id);
      if (!entry) return;
      Object.assign(entry, patch);
      broadcastRuns();
    },
  });

  try {
    await syncOutputBufferFromSnapshot(sessionId);
    await runtime.execute(content);
    if (run.aborted) {
      run.status = "failed";
      run.error = run.error || "Stopped by user";
    } else {
      run.status = "completed";
    }
    run.endedAt = Date.now();
    run.progressMode = "activity";
    run.progressLabel = undefined;
    run.progressCurrent = undefined;
    run.progressTotal = undefined;
  } catch (err) {
    run.status = "failed";
    run.endedAt = Date.now();
    run.progressMode = "activity";
    run.progressLabel = undefined;
    run.progressCurrent = undefined;
    run.progressTotal = undefined;
    run.error = err?.message || String(err);
    run.logs.push({ at: Date.now(), message: run.error });
  } finally {
    broadcastRuns();
  }
}

async function handleScriptRun(_event, payload = {}) {
  const {
    scriptId,
    scriptLabel,
    content,
    sessionId,
    sessionIds,
    mode = "parallel",
    permissionMode = "auto",
  } = payload;
  const targets = Array.isArray(sessionIds) && sessionIds.length > 0
    ? sessionIds
    : sessionId
      ? [sessionId]
      : [];
  if (targets.length === 0) {
    throw new Error("No target session for script run");
  }
  if (!content || !String(content).trim()) {
    throw new Error("Script content is empty");
  }

  const runIds = [];
  const queueRun = (sid) => {
    const runId = randomUUID();
    runIds.push(runId);
    return enqueueSessionRun(sid, () => runScriptOnSession({
      runId,
      scriptId,
      scriptLabel,
      sessionId: sid,
      content,
      permissionMode,
      sessionMeta: payload.sessionMeta,
    }));
  };

  if (mode === "sequential") {
    for (const sid of targets) {
      await queueRun(sid);
    }
  } else {
    await Promise.all(targets.map((sid) => queueRun(sid)));
  }

  return { runIds, runId: runIds[0] };
}

function handleScriptStop(_event, payload = {}) {
  const run = runs.get(payload.runId);
  if (!run) return { ok: false };
  run.aborted = true;
  run.paused = false;
  run.status = "failed";
  run.error = "Stopped by user";
  run.endedAt = Date.now();
  run.waitingFor = undefined;
  getOrCreateBuffer(run.sessionId).abortWaiters("Stopped by user");
  broadcastRuns();
  return { ok: true };
}

function handleScriptPause(_event, payload = {}) {
  const run = runs.get(payload.runId);
  if (!run) return { ok: false };
  run.paused = true;
  run.status = "paused";
  broadcastRuns();
  return { ok: true };
}

function handleScriptResume(_event, payload = {}) {
  const run = runs.get(payload.runId);
  if (!run) return { ok: false };
  run.paused = false;
  run.status = "running";
  broadcastRuns();
  return { ok: true };
}

function handleScriptGetRuns(_event, payload = {}) {
  const all = Array.from(runs.values()).map(serializeRun);
  if (payload.sessionId) {
    return all.filter((run) => run.sessionId === payload.sessionId);
  }
  return all;
}

function handleScriptDialogResponse(_event, payload = {}) {
  const pending = pendingDialogs.get(payload.requestId);
  if (!pending) return { ok: false };
  pendingDialogs.delete(payload.requestId);
  if (payload.cancelled) {
    pending.reject(new Error("Dialog cancelled"));
    return { ok: true };
  }
  if (pending.type === "confirm") {
    pending.resolve(Boolean(payload.value));
  } else if (pending.type === "prompt") {
    pending.resolve(typeof payload.value === "string" ? payload.value : "");
  } else if (pending.type === "form") {
    pending.resolve(payload.value && typeof payload.value === "object" ? payload.value : {});
  } else if (pending.type === "waitForTimeout") {
    pending.resolve(typeof payload.value === "string" ? payload.value : "abort");
  } else {
    pending.resolve(undefined);
  }
  return { ok: true };
}

function handleScriptScreenSnapshotResponse(_event, payload = {}) {
  const pending = pendingScreenSnapshots.get(payload.requestId);
  if (!pending) return { ok: false };
  pendingScreenSnapshots.delete(payload.requestId);
  pending.resolve(payload.snapshot || {
    rows: 24,
    cols: 80,
    currentRow: 0,
    lines: getOrCreateBuffer(pending.sessionId).getText().split("\n"),
  });
  return { ok: true };
}

function handleRecordingStart(_event, payload = {}) {
  const { sessionId } = payload;
  if (!sessionId) throw new Error("sessionId required");
  recordings.set(sessionId, {
    sessionId,
    startedAt: Date.now(),
    steps: [],
    lastTimestamp: Date.now(),
  });
  return { ok: true };
}

function handleRecordingStop(_event, payload = {}) {
  const { sessionId } = payload;
  const recording = recordings.get(sessionId);
  if (!recording) {
    return { steps: [], code: "" };
  }
  recordings.delete(sessionId);
  const code = stepsToJavaScript(recording.steps, new Date(recording.startedAt).toISOString());
  return { steps: recording.steps, code };
}

function handleRecordingAppendStep(_event, payload = {}) {
  const { sessionId, step } = payload;
  const recording = recordings.get(sessionId);
  if (!recording || !step) return { ok: false };
  const now = Date.now();
  const gap = now - recording.lastTimestamp;
  if (gap > 1000 && step.type === "send") {
    recording.steps.push({ type: "sleep", value: gap });
  }
  recording.steps.push(step);
  recording.lastTimestamp = now;
  return { ok: true };
}

function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:script:run", handleScriptRun);
  ipcMain.handle("netcatty:script:stop", handleScriptStop);
  ipcMain.handle("netcatty:script:pause", handleScriptPause);
  ipcMain.handle("netcatty:script:resume", handleScriptResume);
  ipcMain.handle("netcatty:script:get-runs", handleScriptGetRuns);
  ipcMain.handle("netcatty:script:dialog-response", handleScriptDialogResponse);
  ipcMain.handle("netcatty:script:screen-snapshot-response", handleScriptScreenSnapshotResponse);
  ipcMain.handle("netcatty:script:recording:start", handleRecordingStart);
  ipcMain.handle("netcatty:script:recording:stop", handleRecordingStop);
  ipcMain.handle("netcatty:script:recording:append-step", handleRecordingAppendStep);
}

module.exports = {
  init,
  registerHandlers,
  appendSessionOutput,
  removeSessionBuffer,
};
