/**
 * Terminal Bridge - Handles local shell, telnet/mosh, and serial port sessions
 * Extracted from main.cjs for single responsibility
 */

const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const { StringDecoder } = require("node:string_decoder");
const { ensureNodePtySpawnHelperExecutable } = require("./nodePtySpawnHelperPermissions.cjs");

ensureNodePtySpawnHelperExecutable();

const pty = require("node-pty");
const { SerialPort } = require("serialport");
const {
  configureTerminalSessionDataEmitter,
  emitTerminalSessionData,
} = require("./emitTerminalSessionData.cjs");
const {
  getRecentInterruptTrace,
  getSessionSnapshot,
  logTerminalFlowAckSample,
  logTerminalFlowPauseSample,
  logTerminalInterruptDebug,
  normalizeTrace,
  rememberInterruptTrace,
  resetTerminalFlowAckSample,
} = require("./terminalInterruptDiagnostics.cjs");
const {
  clearSessionFlowState,
  setBufferedOutputBytes,
  setRendererFlowPaused,
  shouldAcceptSessionOutput,
  shouldProcessSessionOutput,
  trackAck,
} = require("./terminalFlowAck.cjs");
const {
  armTerminalInterruptOutputGate,
  disarmTerminalInterruptOutputGate,
  filterTerminalInterruptOutput,
  shouldArmTerminalInterruptOutputGate,
  stashPendingInterruptOutputMeta,
  takePendingInterruptOutputMeta,
} = require("./terminalInterruptOutputGate.cjs");
const iconv = require("iconv-lite");
const ptyProcessTree = require("./ptyProcessTree.cjs");

const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
const { detectShellKind } = require("./ai/ptyExec.cjs");
const { stripAnsi, trackSessionIdlePrompt } = require("./ai/shellUtils.cjs");
const { createZmodemSentry } = require("./zmodemHelper.cjs");
const { discoverShells } = require("./shellDiscovery.cjs");
const moshHandshake = require("./moshHandshake.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const { createTelnetAutoLogin } = require("./telnetAutoLogin.cjs");
const telnetProtocol = require("./telnetProtocol.cjs");
const { createPtyOutputBuffer } = require("./ptyOutputBuffer.cjs");
const { enableTcpNoDelay } = require("./tcpNoDelay.cjs");
const { releaseConnectionRef } = require("./sshConnectionPool.cjs");
const { normalizeTerminalEncoding, encodeTerminalInput } = require("./terminalEncoding.cjs");
const { isTerminalReportSequence } = require("./terminalReportSequence.cjs");
const { receiveYmodemFiles, sendYmodemCancel, sendYmodemFile } = require("./ymodemTransfer.cjs");
const {
  getNativeOpenSshAgentSocket,
  prepareSystemSshAgentForAuth,
} = require("./sshAuthHelper.cjs");

const execFileAsync = promisify(execFile);

// Shared references
let sessions = null;
let electronModule = null;
let terminalOutputChannel = null;
let selectZmodemUploadFiles = null;
let selectZmodemDownloadDirectory = null;
let reportOpenedSessionActivity = null;
let terminalDataPipeline = null;
const terminalInputPipelineBarriers = new Map();

const DEFAULT_UTF8_LOCALE = "en_US.UTF-8";
const LOGIN_SHELLS = new Set(["bash", "zsh", "fish", "ksh"]);
const POWERSHELL_SHELLS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

function expandHomePath(targetPath) {
  if (!targetPath) return targetPath;
  if (targetPath === "~") return os.homedir();
  if (targetPath.startsWith("~/")) return path.join(os.homedir(), targetPath.slice(2));
  return targetPath;
}

function normalizeExecutablePath(targetPath) {
  const expanded = expandHomePath(targetPath);
  if (!expanded) return expanded;
  if (expanded.includes(path.sep) || expanded.startsWith(".")) {
    return path.resolve(expanded);
  }
  return expanded;
}

const getLoginShellArgs = (shellPath) => {
  if (!shellPath || process.platform === "win32") return [];
  const shellName = path.basename(shellPath);
  return LOGIN_SHELLS.has(shellName) ? ["-l"] : [];
};

/**
 * Initialize the terminal bridge with dependencies
 */
function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule;
  terminalOutputChannel = deps.terminalOutputChannel || null;
  selectZmodemUploadFiles = deps.selectZmodemUploadFiles || null;
  selectZmodemDownloadDirectory = deps.selectZmodemDownloadDirectory || null;
  reportOpenedSessionActivity = typeof deps.reportOpenedSessionActivity === "function"
    ? deps.reportOpenedSessionActivity
    : null;
  terminalDataPipeline = deps.terminalDataPipeline || null;
  terminalInputPipelineBarriers.clear();
  configureTerminalSessionDataEmitter({
    getSession: (sessionId) => sessions?.get(sessionId),
    outputChannel: terminalOutputChannel,
    onSessionActivity: reportOpenedSessionActivity,
  });
  cleanupStaleEtTempDirs();
}

function openTerminalOutputSession(sessionId, webContents) {
  const generation = webContents?.claimSessionGeneration?.(sessionId);
  const session = sessions?.get?.(sessionId);
  if (session && Number.isSafeInteger(generation)) {
    session._terminalSessionGeneration = generation;
  }
  terminalOutputChannel?.openSession?.(sessionId, webContents);
}

function closeTerminalOutputSession(sessionId) {
  terminalOutputChannel?.closeSession?.(sessionId);
}

/** @type {Map<string, { resolve: (value: any) => void, timeout: NodeJS.Timeout }>} */
const pendingTerminalSnapshots = new Map();
const pendingTerminalSnapshotApplies = new Map();
const pendingTerminalOutputDrains = new Map();
const TERMINAL_SNAPSHOT_TIMEOUT_MS = 2000;
/** In-process (non-worker) attach home mapping: sessionId -> webContentsId */
const attachHomeWebContentsIds = new Map();
const {
  markAttachPopupClosePrepared,
  retryPendingAttachedSessionOutput,
  setRestoreAttachedSessionOutput,
  setAttachHomeLookup,
  setFanoutSessionExit,
  validateAttachPopupAuthorization,
} = require("./terminalAttachRestore.cjs");

function isAuthorizedAttachIpc(event, payload, sessionId) {
  return validateAttachPopupAuthorization(
    payload?.authorization,
    sessionId,
    event?.sender?.id,
  );
}

function resolveSessionHomeWebContentsId(sessionId, terminalWorkerManager = null) {
  if (!sessionId) return null;
  if (terminalWorkerManager?.getSessionWebContentsId) {
    const id = terminalWorkerManager.getSessionWebContentsId(sessionId);
    if (typeof id === "number") return id;
  }
  const session = sessions?.get?.(sessionId);
  if (typeof session?.webContentsId === "number") return session.webContentsId;
  return null;
}

function normalizeKittyKeyboardModeState(value) {
  if (!value || typeof value !== "object") return undefined;
  const flags = (input) => Number.isFinite(input) ? Math.max(0, Math.floor(input)) & 31 : 0;
  const stack = (input) => Array.isArray(input) ? input.slice(-32).map(flags) : [];
  return {
    mainFlags: flags(value.mainFlags),
    alternateFlags: flags(value.alternateFlags),
    mainStack: stack(value.mainStack),
    alternateStack: stack(value.alternateStack),
    alternateScreenActive: value.alternateScreenActive === true,
  };
}

/**
 * Capture a serialize snapshot from the home renderer before rebinding output
 * to an observe popup, so the popup is not an empty shell.
 */
function requestTerminalSessionSnapshot(event, payload, terminalWorkerManager = null) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  if (!sessionId) {
    return Promise.resolve({ success: false, snapshot: "", error: "Missing sessionId" });
  }
  if (!isAuthorizedAttachIpc(event, payload, sessionId)) {
    return Promise.resolve({ success: false, snapshot: "", error: "Unauthorized attach request" });
  }
  const homeId = resolveSessionHomeWebContentsId(sessionId, terminalWorkerManager);
  if (typeof homeId !== "number" || !electronModule?.webContents?.fromId) {
    return Promise.resolve({ success: false, snapshot: "", error: "Home renderer not found" });
  }
  let home;
  try {
    home = electronModule.webContents.fromId(homeId);
  } catch {
    home = null;
  }
  if (!home || home.isDestroyed?.()) {
    return Promise.resolve({ success: false, snapshot: "", error: "Home renderer destroyed" });
  }

  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingTerminalSnapshots.delete(requestId);
      resolve({ success: false, snapshot: "", error: "timeout" });
    }, TERMINAL_SNAPSHOT_TIMEOUT_MS);
    pendingTerminalSnapshots.set(requestId, { resolve, timeout, webContentsId: home.id });
    try {
      home.send("netcatty:terminal:snapshot-request", { sessionId, requestId });
    } catch (err) {
      clearTimeout(timeout);
      pendingTerminalSnapshots.delete(requestId);
      resolve({ success: false, snapshot: "", error: err?.message || String(err) });
    }
  });
}

function handleTerminalSessionSnapshotResponse(event, payload) {
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
  if (!requestId) return;
  const pending = pendingTerminalSnapshots.get(requestId);
  if (!pending) return;
  if (pending.webContentsId !== event?.sender?.id) return;
  clearTimeout(pending.timeout);
  pendingTerminalSnapshots.delete(requestId);
  pending.resolve({
    success: true,
    snapshot: typeof payload?.snapshot === "string" ? payload.snapshot : "",
    kittyKeyboardModeState: normalizeKittyKeyboardModeState(payload?.kittyKeyboardModeState),
    kittyKeyboardProtocolEnabled: typeof payload?.kittyKeyboardProtocolEnabled === "boolean"
      ? payload.kittyKeyboardProtocolEnabled
      : undefined,
    passwordPromptActive: typeof payload?.passwordPromptActive === "boolean"
      ? payload.passwordPromptActive
      : undefined,
    cwd: payload?.cwd === null ? null : typeof payload?.cwd === "string" ? payload.cwd : undefined,
    title: payload?.title === null ? null : typeof payload?.title === "string" ? payload.title : undefined,
  });
}

function requestTerminalOutputDrain(sessionId, terminalWorkerManager = null) {
  const targetId = resolveSessionHomeWebContentsId(sessionId, terminalWorkerManager);
  if (typeof targetId !== "number") {
    return Promise.resolve({ success: false, error: "Display renderer not found" });
  }
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingTerminalOutputDrains.delete(requestId);
      resolve({ success: false, error: "timeout" });
    }, TERMINAL_SNAPSHOT_TIMEOUT_MS);
    pendingTerminalOutputDrains.set(requestId, { resolve, timeout, webContentsId: targetId });
    const sent = terminalWorkerManager
      ? terminalWorkerManager.drainOutputSession?.(sessionId, requestId)
      : terminalOutputChannel?.drainSession?.(sessionId, requestId);
    if (!sent) {
      clearTimeout(timeout);
      pendingTerminalOutputDrains.delete(requestId);
      resolve({ success: false, error: "Output drain unavailable" });
    }
  });
}

function handleTerminalOutputDrainResponse(event, payload) {
  const pending = pendingTerminalOutputDrains.get(payload?.requestId);
  if (!pending || pending.webContentsId !== event?.sender?.id) return;
  clearTimeout(pending.timeout);
  pendingTerminalOutputDrains.delete(payload.requestId);
  pending.resolve({ success: true });
}

/**
 * Push the observe-popup terminal state back to the home renderer before
 * restoring the display route, so reopen/attach doesn't show a stale view.
 */
function applyTerminalSessionSnapshot(event, payload, terminalWorkerManager = null) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const hasSnapshot = typeof payload?.snapshot === "string";
  const snapshot = hasSnapshot ? payload.snapshot : "";
  const hasContextSnapshot = typeof payload?.contextSnapshot === "string";
  const contextSnapshot = hasContextSnapshot ? payload.contextSnapshot : "";
  const hasContextViewportSnapshot = typeof payload?.contextViewportSnapshot === "string";
  const contextViewportSnapshot = hasContextViewportSnapshot ? payload.contextViewportSnapshot : "";
  const hasContextScrollbackSnapshot = typeof payload?.contextScrollbackSnapshot === "string";
  const contextScrollbackSnapshot = hasContextScrollbackSnapshot ? payload.contextScrollbackSnapshot : "";
  const hasAlternateScreen = typeof payload?.alternateScreen === "boolean";
  const alternateScreen = payload?.alternateScreen === true;
  const kittyKeyboardModeState = normalizeKittyKeyboardModeState(payload?.kittyKeyboardModeState);
  const kittyKeyboardProtocolEnabled = typeof payload?.kittyKeyboardProtocolEnabled === "boolean"
    ? payload.kittyKeyboardProtocolEnabled
    : undefined;
  const passwordPromptActive = typeof payload?.passwordPromptActive === "boolean"
    ? payload.passwordPromptActive
    : undefined;
  const cwd = payload?.cwd === null ? null : typeof payload?.cwd === "string" ? payload.cwd : undefined;
  const title = payload?.title === null ? null : typeof payload?.title === "string" ? payload.title : undefined;
  if (
    !sessionId
    || !hasSnapshot
    || !hasContextSnapshot
    || !hasContextViewportSnapshot
    || !hasContextScrollbackSnapshot
    || !hasAlternateScreen
  ) {
    return Promise.resolve({ success: false, error: "Missing sessionId or snapshot" });
  }
  if (!isAuthorizedAttachIpc(event, payload, sessionId)) {
    return Promise.resolve({ success: false, error: "Unauthorized attach request" });
  }
  let homeId = null;
  if (terminalWorkerManager?.getAttachHomeWebContentsId) {
    homeId = terminalWorkerManager.getAttachHomeWebContentsId(sessionId);
  }
  if (homeId == null) {
    homeId = attachHomeWebContentsIds.get(sessionId) ?? null;
  }
  if (typeof homeId !== "number") {
    return Promise.resolve({ success: false, error: "Home renderer not found" });
  }
  try {
    const home = findRegisteredMainWebContents(homeId);
    if (!home) {
      return Promise.resolve({ success: false, error: "Home renderer unavailable" });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingTerminalSnapshotApplies.delete(requestId);
        resolve({ success: false, error: "timeout" });
      }, TERMINAL_SNAPSHOT_TIMEOUT_MS);
      pendingTerminalSnapshotApplies.set(requestId, { resolve, timeout, webContentsId: home.id });
      try {
        home.send("netcatty:terminal:apply-snapshot", {
          sessionId,
          snapshot,
          contextSnapshot,
          contextViewportSnapshot,
          contextScrollbackSnapshot,
          alternateScreen,
          kittyKeyboardModeState,
          kittyKeyboardProtocolEnabled,
          passwordPromptActive,
          cwd,
          title,
          requestId,
        });
      } catch (err) {
        clearTimeout(timeout);
        pendingTerminalSnapshotApplies.delete(requestId);
        resolve({ success: false, error: err?.message || String(err) });
      }
    });
  } catch (err) {
    return Promise.resolve({ success: false, error: err?.message || String(err) });
  }
}

function handleTerminalSessionApplySnapshotResponse(event, payload) {
  const pending = pendingTerminalSnapshotApplies.get(payload?.requestId);
  if (!pending || pending.webContentsId !== event?.sender?.id) return;
  clearTimeout(pending.timeout);
  pendingTerminalSnapshotApplies.delete(payload.requestId);
  pending.resolve(payload?.success === false
    ? { success: false, error: payload?.error || "Snapshot apply failed" }
    : { success: true });
}

/**
 * Rebind a live session's output MessagePort to another renderer (e.g. AI
 * silent-session observe popup). Keeps the same PTY/stream; only the display
 * route moves. Returns the previous webContentsId so the caller can restore.
 *
 * Worker mode: sessions live in the utilityProcess; display routing is owned
 * by terminalWorkerManager (sessionWebContentsIds + output ports).
 * In-process mode: sessions Map in this bridge owns webContentsId.
 */
async function rebindTerminalSessionOutput(event, payload, terminalWorkerManager = null) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  if (!sessionId) {
    return { success: false, error: "Missing sessionId" };
  }
  const sender = event?.sender;
  if (!sender || sender.isDestroyed?.()) {
    return { success: false, error: "Invalid sender" };
  }
  if (!isAuthorizedAttachIpc(event, payload, sessionId)) {
    return { success: false, error: "Unauthorized attach request" };
  }

  if (terminalWorkerManager) {
    try {
      const result = await terminalWorkerManager.rebindOutputSession(sessionId, sender.id);
      if (result?.success && sender.isDestroyed?.()) {
        await restoreAttachedSessionOutput(sessionId, terminalWorkerManager);
        return { success: false, error: "Attach window closed during rebind" };
      }
      return result;
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  const session = sessions?.get?.(sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }
  const previousWebContentsId =
    typeof session.webContentsId === "number" ? session.webContentsId : null;
  try {
    if (
      previousWebContentsId != null
      && previousWebContentsId !== sender.id
      && !attachHomeWebContentsIds.has(sessionId)
    ) {
      attachHomeWebContentsIds.set(sessionId, previousWebContentsId);
    }
    openTerminalOutputSession(sessionId, sender);
    session.webContentsId = sender.id;
    if (sender.isDestroyed?.()) {
      await restoreAttachedSessionOutput(sessionId, terminalWorkerManager);
      return { success: false, error: "Attach window closed during rebind" };
    }
    return {
      success: true,
      previousWebContentsId,
      webContentsId: sender.id,
    };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

function resumeSessionOutputFlow(sessionId, terminalWorkerManager = null) {
  if (!sessionId) return;
  if (terminalWorkerManager?.send) {
    try {
      terminalWorkerManager.send("netcatty:flow", { sessionId, paused: false }, {});
    } catch {
      // ignore
    }
    return;
  }
  const session = sessions?.get?.(sessionId);
  if (!session) return;
  try {
    setRendererFlowPaused(session, false);
    session.flushPendingData?.();
  } catch {
    // ignore
  }
}

function pauseSessionOutputFlow(sessionId, terminalWorkerManager = null) {
  if (!sessionId) return;
  if (terminalWorkerManager?.send) {
    try { terminalWorkerManager.send("netcatty:flow", { sessionId, paused: true }, {}); } catch {}
    return;
  }
  const session = sessions?.get?.(sessionId);
  if (!session) return;
  try { setRendererFlowPaused(session, true); } catch {}
}

function fanoutSessionLifecycleEvent(
  sessionId,
  primaryWebContentsId,
  channel,
  payload,
  terminalSessionGeneration,
) {
  const targets = new Set();
  if (typeof primaryWebContentsId === "number") targets.add(primaryWebContentsId);
  const homeId = attachHomeWebContentsIds.get(sessionId);
  if (typeof homeId === "number") targets.add(homeId);
  for (const id of targets) {
    try {
      const contents = electronModule?.webContents?.fromId?.(id);
      contents?.send?.(channel, Number.isSafeInteger(terminalSessionGeneration)
        ? { ...payload, _terminalSessionGeneration: terminalSessionGeneration }
        : payload);
    } catch {
      // ignore destroyed renderers
    }
  }
  attachHomeWebContentsIds.delete(sessionId);
}

function findRegisteredMainWebContents(preferredId) {
  try {
    const wm = require("./windowManager.cjs");
    const mains = typeof wm.getMainWindows === "function"
      ? wm.getMainWindows()
      : (typeof wm.getMainWindow === "function" ? [wm.getMainWindow()].filter(Boolean) : []);
    const liveContents = [];
    for (const win of mains) {
      const contents = win?.webContents;
      if (contents && !contents.isDestroyed?.()) liveContents.push(contents);
    }
    if (typeof preferredId === "number") {
      const preferred = liveContents.find((contents) => contents.id === preferredId);
      if (preferred) return preferred;
    }
    return liveContents[0] || null;
  } catch {
    // ignore unavailable window manager during isolated tests/startup
  }
  return null;
}

async function restoreAttachedSessionOutput(
  sessionId,
  terminalWorkerManager = null,
  preferredHomeWebContentsId = null,
) {
  if (!sessionId) return { success: false, restored: false };
  pauseSessionOutputFlow(sessionId, terminalWorkerManager);
  let result;
  if (terminalWorkerManager?.restoreAttachHome) {
    result = await terminalWorkerManager.restoreAttachHome(sessionId, preferredHomeWebContentsId);
  } else {
    const homeId = attachHomeWebContentsIds.get(sessionId);
    if (homeId == null) {
      result = { success: true, restored: false };
    } else {
      const session = sessions?.get?.(sessionId);
      if (!session) {
        attachHomeWebContentsIds.delete(sessionId);
        result = { success: true, restored: false };
      } else {
        try {
          const home = findRegisteredMainWebContents(preferredHomeWebContentsId ?? homeId);
          if (!home) {
            result = { success: false, restored: false, error: "Home renderer unavailable" };
          } else {
            openTerminalOutputSession(sessionId, home);
            session.webContentsId = home.id;
            attachHomeWebContentsIds.delete(sessionId);
            result = { success: true, restored: true, webContentsId: home.id };
          }
        } catch (err) {
          result = { success: false, restored: false, error: err?.message || String(err) };
        }
      }
    }
  }

  // Resume only after output has a live destination. If no main renderer is
  // currently available, keep the source paused and the home mapping intact so
  // a later attach/recovery can safely reclaim the session.
  if (result?.success) {
    resumeSessionOutputFlow(sessionId, terminalWorkerManager);
  }
  return result;
}

/**
 * Restore output to a previous renderer after an attach popup closes.
 * Falls back to the first live main-ish window if the home webContents is gone.
 */
async function restoreTerminalSessionOutput(event, payload, terminalWorkerManager = null) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  if (!sessionId) {
    return { success: false, error: "Missing sessionId" };
  }
  if (!isAuthorizedAttachIpc(event, payload, sessionId)) {
    return { success: false, error: "Unauthorized attach request" };
  }

  const homeId = payload?.webContentsId;
  const target = findRegisteredMainWebContents(homeId);
  if (!target) {
    return { success: false, error: "No live renderer to restore output to" };
  }

  if (terminalWorkerManager) {
    if (!terminalWorkerManager.hasOpenSession?.(sessionId)) {
      // Session already closed — nothing to restore.
      return { success: true, restored: false };
    }
    try {
      const result = await terminalWorkerManager.rebindOutputSession(sessionId, target.id);
      if (!result?.success) {
        return { success: false, error: result?.error || "Failed to restore session output" };
      }
      terminalWorkerManager.clearAttachHome?.(sessionId);
      return { success: true, restored: true, webContentsId: target.id };
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  const session = sessions?.get?.(sessionId);
  if (!session) {
    // Session already closed — nothing to restore.
    return { success: true, restored: false };
  }
  try {
    openTerminalOutputSession(sessionId, target);
    session.webContentsId = target.id;
    attachHomeWebContentsIds.delete(sessionId);
    return { success: true, restored: true, webContentsId: target.id };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Locate an executable on POSIX systems by name.
 *
 * macOS GUI Electron apps inherit launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), missing Homebrew and other common
 * package-manager directories. `pty.spawn(name)` then either fails
 * synchronously with ENOENT or spawns a child that immediately exits
 * with no useful error surfaced to the renderer (see issue #842 for the
 * Mosh case).
 *
 * Returns the absolute path on success, or null when the binary cannot
 * be located anywhere we know to look. Win32 callers should keep using
 * findExecutable() which handles `where.exe` + Windows-specific paths.
 */
const POSIX_EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/local/bin",
  "/opt/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function isExecutableFile(candidate) {
  try {
    const st = fs.statSync(candidate);
    if (!st.isFile()) return false;
    // Windows has no POSIX execute bit — Node returns mode 0o100666 even for
    // .exe / .bat / .cmd files, so 0o111 is unreliable there. Treat any
    // regular file as executable on Win32 and let spawn-time PATHEXT /
    // extension handling reject non-executables.
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolvePosixExecutable(name, opts = {}) {
  if (process.platform === "win32") return null;
  if (!name || typeof name !== "string") return null;

  // Already an absolute or relative path: validate as-is.
  if (name.includes("/")) {
    return isExecutableFile(name) ? name : null;
  }
  if (!/^[a-zA-Z0-9._+-]+$/.test(name)) return null;

  const seen = new Set();
  const dirs = [];

  // 1. Honor the caller-supplied PATH first so callers that have already
  //    merged a host-level environmentVariables.PATH override don't see the
  //    fallback decline a binary that the spawned process would have found.
  //    Falls back to the main process PATH when no override is provided.
  const pathOverride = Object.prototype.hasOwnProperty.call(opts, "pathOverride")
    ? opts.pathOverride
    : process.env.PATH;
  for (const dir of (pathOverride || "").split(":")) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }

  // 2. Add directories the GUI launcher's PATH typically misses on macOS/Linux.
  for (const dir of POSIX_EXTRA_PATH_DIRS) {
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }

  // 3. User-scoped install locations (nix-profile, cargo, ~/.local).
  const home = process.env.HOME;
  if (home) {
    for (const sub of [".nix-profile/bin", ".cargo/bin", ".local/bin"]) {
      const dir = path.join(home, sub);
      if (!seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
    }
  }

  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Find executable path on Windows
 */
function isWindowsAppExecutionAlias(filePath) {
  if (!filePath || process.platform !== "win32") return false;

  const normalizedPath = path.normalize(filePath).toLowerCase();
  const windowsAppsDir = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "WindowsApps",
  ).toLowerCase();

  return !!windowsAppsDir && normalizedPath.startsWith(`${windowsAppsDir}${path.sep}`);
}

function findExecutable(name, opts = {}) {
  if (process.platform !== "win32") return name;
  
  const { execFileSync } = require("child_process");
  try {
    const pathOverride = Object.prototype.hasOwnProperty.call(opts, "pathOverride")
      ? opts.pathOverride
      : process.env.PATH;
    const env = { ...process.env, PATH: pathOverride || "" };
    const whereExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
    const result = execFileSync(fs.existsSync(whereExe) ? whereExe : "where.exe", [name], { encoding: "utf8", env });
    const candidates = result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      if (name === "pwsh" && isWindowsAppExecutionAlias(candidate)) continue;
      return candidate;
    }
  } catch (err) {
    console.warn(`Could not find ${name} via where.exe:`, err.message);
  }
  
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return name;

  const commonPaths = [];

  if (name === "pwsh") {
    commonPaths.push(
      path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
      path.join(process.env.ProgramW6432 || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    );
  }

  if (name === "powershell") {
    commonPaths.push(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    );
  }

  commonPaths.push(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSH", `${name}.exe`),
  );
  
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  
  return name;
}

function getDefaultLocalShell() {
  if (process.platform !== "win32") {
    return process.env.SHELL || "/bin/bash";
  }

  const pwsh = findExecutable("pwsh");
  if (pwsh && pwsh.toLowerCase() !== "pwsh") {
    return pwsh;
  }

  const powershell = findExecutable("powershell");
  if (powershell && powershell.toLowerCase() !== "powershell") {
    return powershell;
  }

  return "powershell.exe";
}

function getLocalShellArgs(shellPath) {
  if (!shellPath) return [];

  if (process.platform !== "win32") {
    return getLoginShellArgs(shellPath);
  }

  const shellName = path.basename(shellPath).toLowerCase();
  if (POWERSHELL_SHELLS.has(shellName)) {
    return ["-NoLogo"];
  }

  return [];
}

const isUtf8Locale = (value) => typeof value === "string" && /utf-?8/i.test(value);

const isEmptyLocale = (value) => {
  if (value === undefined || value === null) return true;
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  return trimmed === "C" || trimmed === "POSIX";
};

const applyLocaleDefaults = (env) => {
  const hasUtf8 =
    isUtf8Locale(env.LC_ALL) || isUtf8Locale(env.LC_CTYPE) || isUtf8Locale(env.LANG);
  if (hasUtf8) return env;

  const hasAnyLocale =
    !isEmptyLocale(env.LC_ALL) || !isEmptyLocale(env.LC_CTYPE) || !isEmptyLocale(env.LANG);
  if (hasAnyLocale) return env;

  return {
    ...env,
    LANG: DEFAULT_UTF8_LOCALE,
    LC_CTYPE: DEFAULT_UTF8_LOCALE,
    LC_ALL: DEFAULT_UTF8_LOCALE,
  };
};

/**
 * Start a local terminal session
 */
function startLocalSession(event, payload) {
  const sessionId = payload?.sessionId || randomUUID();
  const defaultShell = getDefaultLocalShell();
  // payload.shell may be a discovered shell ID (e.g., "wsl-ubuntu") — resolve it
  let resolvedShell = payload?.shell;
  let resolvedArgs = payload?.shellArgs;
  if (resolvedShell && !/[/\\]/.test(resolvedShell)) {
    // Looks like a shell ID, not a path — try to resolve from discovery cache
    const shells = discoverShells();
    const match = shells.find((s) => s.id === resolvedShell);
    if (match) {
      resolvedShell = match.command;
      resolvedArgs = resolvedArgs ?? match.args;
    }
  }
  const shell = normalizeExecutablePath(resolvedShell) || defaultShell;
  const shellArgs = resolvedArgs ?? getLocalShellArgs(shell);
  const shellKind = detectShellKind(shell);
  const { buildTerminalProcessEnv } = require("./httpNetworkProxyBridge.cjs");
  const env = applyLocaleDefaults({
    ...buildTerminalProcessEnv(process.env),
    ...(payload?.env || {}),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
  
  // Determine the starting directory
  // Default to home directory if not specified or if specified path is invalid
  const defaultCwd = os.homedir();
  let cwd = defaultCwd;
  
  if (payload?.cwd) {
    try {
      // Resolve to absolute path and check if it exists and is a directory
      const resolvedPath = path.resolve(expandHomePath(payload.cwd));
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
        cwd = resolvedPath;
      } else {
        console.warn(`[Terminal] Specified cwd "${payload.cwd}" is not a valid directory, using home directory`);
      }
    } catch (err) {
      console.warn(`[Terminal] Error validating cwd "${payload.cwd}":`, err.message);
    }
  }
  
  const proc = pty.spawn(shell, shellArgs, {
    name: env.TERM || "xterm-256color",
    cols: payload?.cols || 80,
    rows: payload?.rows || 24,
    env,
    cwd,
    encoding: null, // Return Buffer for ZMODEM binary support
    // node-pty can only clear ConPTY through its bundled conpty.dll.
    useConptyDll: process.platform === "win32",
  });
  
  const session = {
    proc,
    pty: proc,
    type: "local",
    protocol: "local",
    webContentsId: event.sender.id,
    hostname: "localhost",
    username: (() => {
      try {
        return os.userInfo().username || "local";
      } catch {
        return "local";
      }
    })(),
    label: "Local Terminal",
    shellExecutable: shell,
    shellKind,
    flushPendingData: null,
    lastIdlePrompt: "",
    lastIdlePromptAt: 0,
    _promptTrackTail: "",
  };
  sessions.set(sessionId, session);
  openTerminalOutputSession(sessionId, event.sender);
  ptyProcessTree.registerPid(sessionId, proc.pid);

  // Start real-time session log stream if configured. The token returned
  // by startStream is captured so the corresponding stopStream below only
  // tears down THIS stream — a stale exit event from a previous session
  // that reused this sessionId would no-op instead of killing a freshly
  // started stream after a "Restart" reconnect (issue #916).
  let logStreamToken = null;
  if (payload?.sessionLog?.enabled && payload?.sessionLog?.directory) {
    logStreamToken = sessionLogStreamManager.startStream(sessionId, {
      hostLabel: "Local",
      hostname: "localhost",
      directory: payload.sessionLog.directory,
      format: payload.sessionLog.format || "txt",
      timestampsEnabled: Boolean(payload.sessionLog.timestampsEnabled),
      startTime: Date.now(),
    });
  }

  const {
    bufferData: bufferLocalData,
    flushPaced: flushLocalPaced,
    takePendingEntry: takePendingLocal,
    discard: discardLocal,
  } = createPtyOutputBuffer((data, meta) => {
    const contents = electronModule.webContents.fromId(session.webContentsId);
    emitTerminalSessionData(contents, sessionId, data, {
      session,
      cols: session.cols,
      rows: session.rows,
      meta,
    });
  }, {
    onPendingBytesChange: (bytes) => setBufferedOutputBytes(session, bytes),
    shouldAcceptOutput: () => shouldAcceptSessionOutput(session),
  });
  session.flushPendingData = flushLocalPaced;
  session.takePendingData = takePendingLocal;
  session.discardPendingData = discardLocal;

  // On Windows, node-pty ignores encoding: null and still emits UTF-8
  // strings, making raw-byte ZMODEM impossible for local PTY sessions.
  // Only wire up the sentry on platforms where encoding: null works.
  if (process.platform !== "win32") {
    const localDecoder = new StringDecoder("utf8");
    const zmodemSentry = createZmodemSentry({
      sessionId,
      onData(buf) {
        const str = localDecoder.write(buf);
        if (!str) return;
        trackSessionIdlePrompt(session, str);
        bufferLocalData(str);
        sessionLogStreamManager.appendData(sessionId, str);
      },
      writeToRemote(buf) {
        try { return proc.write(buf); } catch { return true; }
      },
      getWebContents() {
        return electronModule.webContents.fromId(session.webContentsId);
      },
      selectUploadFiles: selectZmodemUploadFiles
        ? () => selectZmodemUploadFiles(session.webContentsId, sessionId)
        : undefined,
      selectDownloadDirectory: selectZmodemDownloadDirectory
        ? () => selectZmodemDownloadDirectory(session.webContentsId, sessionId)
        : undefined,
      label: "Local",
    });
    session.zmodemSentry = zmodemSentry;

    proc.onData((data) => {
      if (sessions.get(sessionId) !== session) return;
      if (!shouldProcessSessionOutput(session, zmodemSentry)) return;
      zmodemSentry.consume(data);
    });
  } else {
    proc.onData((data) => {
      if (sessions.get(sessionId) !== session) return;
      if (!shouldProcessSessionOutput(session)) return;
      trackSessionIdlePrompt(session, data);
      bufferLocalData(data);
      sessionLogStreamManager.appendData(sessionId, data);
    });
  }

  let localExitFinalized = false;
  proc.onExit((evt) => {
    const finalizeExit = () => {
      if (localExitFinalized) return;
      localExitFinalized = true;
      sessionLogStreamManager.stopStream(sessionId, logStreamToken);
      if (sessions.get(sessionId) !== session) return;
      ptyProcessTree.unregisterPid(sessionId);
      sessions.delete(sessionId);
      if (session.closed) return;
      // Signal present = killed externally (show disconnected UI).
      // No signal = the process exited and the renderer decides whether to
      // auto-close based on the reported exit code.
      const reason = evt.signal ? "error" : "exited";
      fanoutSessionLifecycleEvent(
        sessionId,
        session.webContentsId,
        "netcatty:exit",
        { sessionId, ...evt, reason },
        session._terminalSessionGeneration,
      );
    };
    flushLocalPaced(finalizeExit);
  });

  return { sessionId };
}

/**
 * Start a Telnet session using native Node.js net module
 */
const { createTelnetSessionApi } = require("./terminalBridge/telnetSession.cjs");
const telnetSessionApi = createTelnetSessionApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  net, randomUUID, StringDecoder, iconv, Buffer, console, setTimeout, clearTimeout,
  normalizeTerminalEncoding, encodeTerminalInput, createTelnetAutoLogin, telnetProtocol,
  createPtyOutputBuffer, sessionLogStreamManager, createZmodemSentry, ptyProcessTree,
  enableTcpNoDelay, trackSessionIdlePrompt, stripAnsi, clearPendingAutomatedWrites,
  openTerminalOutputSession, closeTerminalOutputSession,
  get selectZmodemUploadFiles() { return selectZmodemUploadFiles; },
  get selectZmodemDownloadDirectory() { return selectZmodemDownloadDirectory; },
});
const { startTelnetSession } = telnetSessionApi;

/**
 * Resolve Netcatty's bundled bare `mosh-client` binary.
 *
 * Returns the absolute path or null.
 */
const { createMoshSessionApi } = require("./terminalBridge/moshSession.cjs");
const moshSessionApi = createMoshSessionApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  os, fs, net, path, pty, iconv, Buffer, StringDecoder, process, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  randomUUID, execFileAsync, ptyProcessTree, sessionLogStreamManager,
  stripAnsi, trackSessionIdlePrompt, createZmodemSentry, moshHandshake, tempDirBridge,
  createPtyOutputBuffer, enableTcpNoDelay, normalizeTerminalEncoding,
  resolvePosixExecutable, findExecutable, isExecutableFile,
  openTerminalOutputSession, closeTerminalOutputSession,
  get selectZmodemUploadFiles() { return selectZmodemUploadFiles; },
  get selectZmodemDownloadDirectory() { return selectZmodemDownloadDirectory; },
  ensureMoshStatsConnection: (...args) => require("./sshBridge.cjs").ensureMoshStatsConnection(...args),
  getAvailableAgentSocket: getNativeOpenSshAgentSocket,
  prepareSystemSshAgentForAuth,
  bundledMoshClient: (...args) => bundledMoshClient(...args),
});
const {
  resolveBareMoshClient,
  addBundledMoshRuntimeEnv,
  createMoshUtf8Decoder,
  buildMoshSshAuthArgs,
  cleanupMoshAuthTempFiles,
  startMoshSessionViaHandshake,
  swapToMoshClient,
  resolveLangFromCharsetForMosh,
  startMoshSession,
} = moshSessionApi;

/**
 * EternalTerminal session API. `et` is a self-contained client that performs
 * its own SSH bootstrap + ET protocol handshake, so Netcatty just spawns the
 * bundled `et` binary as a PTY (no Node handshake wrapper like Mosh needs).
 */
const { createEtSessionApi } = require("./terminalBridge/etSession.cjs");
const etSessionApi = createEtSessionApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  os, fs, path, pty, process, console,
  randomUUID, execFile, execFileSync, StringDecoder,
  sessionLogStreamManager, tempDirBridge,
  createZmodemSentry, trackSessionIdlePrompt, createPtyOutputBuffer,
  findExecutable,
  openTerminalOutputSession, closeTerminalOutputSession,
  getAvailableAgentSocket: getNativeOpenSshAgentSocket,
  prepareSystemSshAgentForAuth,
  get selectZmodemUploadFiles() { return selectZmodemUploadFiles; },
  get selectZmodemDownloadDirectory() { return selectZmodemDownloadDirectory; },
  bundledEtClient: (...args) => bundledEtClient(...args),
});
const {
  startEtSession,
  execOnEtSession,
  cleanupStaleEtTempDirs,
  cleanupSessionExternalAuthArtifacts,
} = etSessionApi;

/**
 * List available serial ports (hardware only)
 */
async function listSerialPorts() {
  try {
    const ports = await SerialPort.list();
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer || '',
      serialNumber: port.serialNumber || '',
      vendorId: port.vendorId || '',
      productId: port.productId || '',
      pnpId: port.pnpId || '',
      type: 'hardware',
    }));
  } catch (err) {
    console.error("[Serial] Failed to list ports:", err.message);
    return [];
  }
}

/**
 * Start a serial port session (supports both hardware serial ports and PTY devices)
 * Note: SerialPort library can open PTY devices directly, they just won't appear in list()
 */
async function startSerialSession(event, options) {
  const sessionId = options.sessionId || randomUUID();

  const portPath = options.path;
  const baudRate = options.baudRate || 115200;
  const dataBits = options.dataBits || 8;
  const stopBits = options.stopBits || 1;
  const parity = options.parity || 'none';
  const flowControl = options.flowControl || 'none';

  console.log(`[Serial] Starting connection to ${portPath} at ${baudRate} baud`);

  return new Promise((resolve, reject) => {
    // Token for the log stream we open on this connection. Captured here so
    // the close/error handlers can pass it to stopStream and avoid
    // tearing down a freshly started stream after a "Restart" reconnect on
    // the same sessionId (issue #916).
    let logStreamToken = null;
    try {
      const serialPort = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        dataBits: dataBits,
        stopBits: stopBits,
        parity: parity,
        rtscts: flowControl === 'rts/cts',
        xon: flowControl === 'xon/xoff',
        xoff: flowControl === 'xon/xoff',
        autoOpen: false,
      });

      serialPort.open((err) => {
        if (err) {
          console.error(`[Serial] Failed to open port ${portPath}:`, err.message);
          reject(new Error(`Failed to open serial port: ${err.message}`));
          return;
        }

        console.log(`[Serial] Connected to ${portPath}`);

        const initialSerialEncoding = normalizeTerminalEncoding(options.charset);
        const serialDecoderRef = { current: iconv.getDecoder(initialSerialEncoding) };

        const session = {
          serialPort,
          type: 'serial',
          protocol: 'serial',
          shellKind: 'raw',
          encoding: initialSerialEncoding,
          // Kept for backward compatibility with aiBridge / mcpServerBridge
          // which read session.serialEncoding for exec calls.
          serialEncoding: initialSerialEncoding,
          decoderRef: serialDecoderRef,
          webContentsId: event.sender.id,
        };
        sessions.set(sessionId, session);
        openTerminalOutputSession(sessionId, event.sender);

        // Start real-time session log stream if configured
        if (options.sessionLog?.enabled && options.sessionLog?.directory) {
          logStreamToken = sessionLogStreamManager.startStream(sessionId, {
            hostLabel: options.label || portPath,
            hostname: portPath,
            directory: options.sessionLog.directory,
            format: options.sessionLog.format || "txt",
            timestampsEnabled: Boolean(options.sessionLog.timestampsEnabled),
            startTime: Date.now(),
          });
        }

        const serialZmodemSentry = createZmodemSentry({
          sessionId,
          onData(buf) {
            const decoded = serialDecoderRef.current.write(buf);
            if (!decoded) return;
            const contents = electronModule.webContents.fromId(session.webContentsId);
            emitTerminalSessionData(contents, sessionId, decoded, {
              session,
              cols: session.cols,
              rows: session.rows,
            });
            sessionLogStreamManager.appendData(sessionId, decoded);
          },
          writeToRemote(buf) {
            try { return serialPort.write(buf); } catch { return true; }
          },
          getWebContents() {
            return electronModule.webContents.fromId(session.webContentsId);
          },
          selectUploadFiles: selectZmodemUploadFiles
            ? () => selectZmodemUploadFiles(session.webContentsId, sessionId)
            : undefined,
          selectDownloadDirectory: selectZmodemDownloadDirectory
            ? () => selectZmodemDownloadDirectory(session.webContentsId, sessionId)
            : undefined,
          label: "Serial",
        });
        session.zmodemSentry = serialZmodemSentry;

        serialPort.on('data', (data) => {
          if (sessions.get(sessionId) !== session) return;
          if (session.ymodemActive) return;
          if (!shouldProcessSessionOutput(session, serialZmodemSentry)) return;
          // data is already Buffer from serialport — feed to sentry
          serialZmodemSentry.consume(data);
        });

        let serialExitFinalized = false;
        const finalizeSerialExit = ({ exitCode, error, reason }) => {
          if (serialExitFinalized || sessions.get(sessionId) !== session) return;
          serialExitFinalized = true;
          session.zmodemSentry?.cancel();
          session.ymodemAbortController?.abort();
          sessionLogStreamManager.stopStream(sessionId, logStreamToken);
          const primaryId = session.webContentsId;
          ptyProcessTree.unregisterPid(sessionId);
          sessions.delete(sessionId);
          if (session.closed) return;
          fanoutSessionLifecycleEvent(
            sessionId,
            primaryId,
            "netcatty:exit",
            { sessionId, exitCode, ...(error ? { error } : {}), reason },
            session._terminalSessionGeneration,
          );
        };

        serialPort.on('error', (err) => {
          console.error(`[Serial] Port error: ${err.message}`);
          finalizeSerialExit({ exitCode: 1, error: err.message, reason: "error" });
        });

        serialPort.on('close', () => {
          console.log(`[Serial] Port closed`);
          finalizeSerialExit({ exitCode: 0, reason: "closed" });
        });

        resolve({ sessionId });
      });
    } catch (err) {
      console.error("[Serial] Failed to start serial session:", err.message);
      reject(err);
    }
  });
}

/**
 * Write data to a session
 */
function cancelActiveYmodemSession(session) {
  if (!session?.ymodemActive) return;
  void sendYmodemCancel(session.serialPort);
  session.ymodemAbortController?.abort();
}

function pauseSshOutputForInterrupt(session, trace) {
  const stream = session?.stream;
  if (!stream || typeof stream.pause !== "function") return false;
  const flowState = session.flowState;
  let alreadyPaused = Boolean(flowState?.appliedPause || flowState?.rendererPaused);
  try {
    if (typeof stream.isPaused === "function") {
      alreadyPaused = alreadyPaused || stream.isPaused();
    }
  } catch {
    // Treat unreadable pause state as not paused; a best-effort pause is fine.
  }
  if (alreadyPaused) return false;
  logTerminalInterruptDebug("interrupt-output-pause-before-write-start", {
    session: getSessionSnapshot(session),
  }, trace);
  try {
    stream.pause();
    logTerminalInterruptDebug("interrupt-output-pause-before-write-done", {
      session: getSessionSnapshot(session),
    }, trace);
    return true;
  } catch (err) {
    logTerminalInterruptDebug("interrupt-output-pause-before-write-failed", {
      error: err?.message || String(err),
      code: err?.code,
      session: getSessionSnapshot(session),
    }, trace);
    return false;
  }
}

function clearPendingAutomatedWrites(session) {
  const timers = session?.pendingAutomatedWriteTimers;
  if (!Array.isArray(timers) || timers.length === 0) return;
  for (const timer of timers) clearTimeout(timer);
  session.pendingAutomatedWriteTimers = [];
}

function splitTerminalInputIntoLineWrites(data) {
  if (typeof data !== "string") return [data];
  const chunks = [];
  let line = "";

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char === "\r" || char === "\n") {
      if (char === "\r" && data[index + 1] === "\n") index += 1;
      chunks.push(`${line}\r`);
      line = "";
      continue;
    }
    line += char;
  }

  if (line.length > 0) chunks.push(line);
  return chunks.length > 0 ? chunks : [data];
}

function getAutomatedLineDelayMs(payload) {
  if (!payload?.automated) return 0;
  const lineDelayMs = Number(payload.lineDelayMs);
  return Number.isFinite(lineDelayMs) && lineDelayMs > 0 ? Math.min(lineDelayMs, 2000) : 0;
}

function shouldBlockSessionInput(session, data) {
  if (session.ymodemActive) {
    if (data === '\x03') {
      cancelActiveYmodemSession(session);
    }
    return true;
  }

  // During ZMODEM transfer, block terminal input (Ctrl+C cancels the transfer)
  if (session.zmodemSentry?.isActive()) {
    if (data === '\x03') {
      session.zmodemSentry.cancel();
    }
    return true;
  }

  return false;
}

function writeToSessionNow(payload, data, logRewrite = payload.logRewrite) {
  const session = sessions.get(payload.sessionId);
  const trace = payload.interruptTrace || null;
  if (!session) {
    logTerminalInterruptDebug("write-session-missing", {
      sessionId: payload.sessionId,
      dataCode: data === "\x03" ? "ETX" : undefined,
    }, trace);
    return;
  }
  if (shouldBlockSessionInput(session, data)) {
    logTerminalInterruptDebug("write-session-blocked-by-transfer", {
      sessionId: payload.sessionId,
      dataCode: data === "\x03" ? "ETX" : undefined,
      session: getSessionSnapshot(session),
    }, trace);
    return;
  }
  if (data !== "\x03" && !payload.automated && !isTerminalReportSequence(data)) {
    disarmTerminalInterruptOutputGate(session);
  }

  try {
    if (session.type === 'telnet-native' && !payload.automated) {
      session.autoLogin?.handleUserInput();
    }

    // Encode keystrokes with the SAME charset the output path decodes with so
    // input and output stay symmetric on non-UTF-8 devices (issue #1216).
    // session.encoding is the normalized iconv identifier; it is only set on
    // sessions whose output is iconv-decoded (SSH / telnet / serial). Mosh and
    // local PTY leave it unset, so encodeTerminalInput returns the original
    // UTF-8 string for them. For UTF-8 it also returns the string unchanged, so
    // the transport's native string serialization keeps handling that case.
    sessionLogStreamManager.registerSudoAutofillInput(payload.sessionId, data);
    sessionLogStreamManager.registerProgrammaticCommandLogRewrite(payload.sessionId, logRewrite);
    const inputData = session.type === 'telnet-native'
      ? telnetProtocol.normalizeNvtNewlines(data)
      : data;
    const outgoing = encodeTerminalInput(inputData, session.encoding);

    if (session.stream) {
      const shouldLogInterruptWrite = data === "\x03" || trace;
      if (shouldLogInterruptWrite) {
        logTerminalInterruptDebug("ssh-stream-write-start", {
          outgoingBytes: Buffer.isBuffer(outgoing) ? outgoing.length : Buffer.byteLength(String(outgoing)),
          dataCode: data === "\x03" ? "ETX" : undefined,
          session: getSessionSnapshot(session),
        }, trace);
      }
      const writeResult = session.stream.write(outgoing);
      if (shouldLogInterruptWrite) {
        logTerminalInterruptDebug("ssh-stream-write-done", {
          writeResult,
          session: getSessionSnapshot(session),
        }, trace);
      }
    } else if (session.proc) {
      session.proc.write(outgoing);
    } else if (session.socket) {
      // Telnet only: any 0xFF byte going out the wire must be doubled, or
      // the peer will treat it as the start of an IAC command sequence and
      // eat the next byte (RFC 854 §"Data Stream"). UTF-8 keyboard input
      // never produces 0xFF, but paste of binary content and some legacy
      // encodings do. Cheap no-op when there is no 0xFF.
      let wireData = outgoing;
      if (session.type === 'telnet-native' && session.telnetProtocolActive) {
        if (typeof wireData === 'string') {
          wireData = Buffer.from(wireData, 'utf8');
        }
        wireData = telnetProtocol.escapeIacForWire(wireData);
      }
      session.socket.write(wireData);
    } else if (session.serialPort) {
      session.serialPort.write(outgoing);
    }
  } catch (err) {
    logTerminalInterruptDebug("write-session-error", {
      sessionId: payload.sessionId,
      error: err?.message || String(err),
      code: err?.code,
      session: getSessionSnapshot(session),
    }, trace);
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
      console.warn("Write failed", err);
    }
  }
}

function writeToSessionWithInterception(
  payload,
  data,
  logRewrite = payload.logRewrite,
  expectedSession = sessions.get(payload.sessionId),
) {
  const bypass = payload?.sensitive === true || isTerminalReportSequence(data);
  const hasInterceptor = Boolean(
    terminalDataPipeline?.interceptInput
    && terminalDataPipeline.has?.(payload.sessionId, "input"),
  );
  const previous = terminalInputPipelineBarriers.get(payload.sessionId);
  if (!hasInterceptor && !previous) {
    writeToSessionNow(payload, data, logRewrite);
    return;
  }
  const writeIfCurrent = (nextData) => {
    const current = sessions.get(payload.sessionId);
    if (!current || current !== expectedSession || current.closed) return;
    writeToSessionNow(payload, nextData, logRewrite);
  };
  const write = async () => {
    if (!hasInterceptor) {
      writeIfCurrent(data);
      return;
    }
    try {
      const transformed = await terminalDataPipeline.interceptInput(payload.sessionId, data, {
        sensitive: payload?.sensitive === true,
        bypass,
      });
      writeIfCurrent(transformed);
    } catch {
      writeIfCurrent(data);
    }
  };
  const operation = previous ? previous.then(write, write) : Promise.resolve().then(write);
  terminalInputPipelineBarriers.set(payload.sessionId, operation);
  void operation.finally(() => {
    if (terminalInputPipelineBarriers.get(payload.sessionId) === operation) {
      terminalInputPipelineBarriers.delete(payload.sessionId);
    }
  });
}

function writeToSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;

  try {
    reportOpenedSessionActivity?.({ sessionId: payload.sessionId, phase: "touch" });
  } catch {
    // Activity tracking must not interfere with terminal input.
  }

  if (!payload.automated && !isTerminalReportSequence(payload.data)) {
    clearPendingAutomatedWrites(session);
  }
  if (shouldBlockSessionInput(session, payload.data)) {
    return;
  }

  const lineDelayMs = getAutomatedLineDelayMs(payload);
  const lineChunks = lineDelayMs > 0 ? splitTerminalInputIntoLineWrites(payload.data) : [payload.data];
  if (lineDelayMs > 0 && lineChunks.length > 1) {
    clearPendingAutomatedWrites(session);
    session.pendingAutomatedWriteTimers = [];
    lineChunks.forEach((chunk, index) => {
      const sendChunk = () => {
        const current = sessions.get(payload.sessionId);
        if (!current) return;
        writeToSessionWithInterception(
          { ...payload, lineDelayMs: undefined },
          chunk,
          index === 0 ? payload.logRewrite : undefined,
          current,
        );
      };
      if (index === 0) {
        sendChunk();
        return;
      }
      const timer = setTimeout(sendChunk, index * lineDelayMs);
      session.pendingAutomatedWriteTimers.push(timer);
    });
    return;
  }

  writeToSessionWithInterception(payload, payload.data, payload.logRewrite, session);
}

function drainPendingOutputForInterrupt(sessionId, session, trace) {
  if (typeof session?.takePendingData !== "function") return;
  const pendingEntry = session.takePendingData();
  const pending = typeof pendingEntry === "string" ? pendingEntry : pendingEntry?.data;
  const pendingMeta = typeof pendingEntry === "string" ? undefined : pendingEntry?.meta;
  if (!pending) return;
  const output = filterTerminalInterruptOutput(session, pending);
  if (!output.accepted || output.droppedBytes > 0) {
    logTerminalInterruptDebug("interrupt-pending-output-filtered", {
      session: getSessionSnapshot(session),
      droppedBytes: output.droppedBytes,
      reason: output.reason,
      accepted: output.accepted,
    }, trace);
  }
  if (!output.accepted || !output.data) {
    stashPendingInterruptOutputMeta(session, pendingMeta);
    return;
  }
  const outputMeta = takePendingInterruptOutputMeta(session, pendingMeta);
  const contents = electronModule.webContents.fromId(session.webContentsId);
  emitTerminalSessionData(contents, sessionId, output.data, {
    session,
    cols: session.cols,
    rows: session.rows,
    meta: outputMeta,
  });
}

function interruptSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  const trace = normalizeTrace(payload);
  if (!session) {
    logTerminalInterruptDebug("interrupt-session-missing", {
      sessionId: payload.sessionId,
      senderId: event?.sender?.id,
    }, trace);
    return;
  }
  rememberInterruptTrace(session, trace);
  resetTerminalFlowAckSample(session);
  logTerminalInterruptDebug("interrupt-session-received", {
    sessionId: payload.sessionId,
    senderId: event?.sender?.id,
    rendererPriority: trace?.rendererPriority,
    session: getSessionSnapshot(session),
  }, trace);

  clearPendingAutomatedWrites(session);
  const shouldDrainOldOutput = shouldArmTerminalInterruptOutputGate(session);
  const pausedForInterrupt = shouldDrainOldOutput
    ? pauseSshOutputForInterrupt(session, trace)
    : false;
  if (shouldDrainOldOutput) {
    armTerminalInterruptOutputGate(session);
    logTerminalInterruptDebug("interrupt-output-drain-armed", {
      session: getSessionSnapshot(session),
    }, trace);
    drainPendingOutputForInterrupt(payload.sessionId, session, trace);
  }
  logTerminalInterruptDebug("interrupt-clear-flow-start", {
    session: getSessionSnapshot(session),
  }, trace);
  clearSessionFlowState(session, { resume: !shouldDrainOldOutput });
  logTerminalInterruptDebug("interrupt-clear-flow-done", {
    session: getSessionSnapshot(session),
  }, trace);
  writeToSessionNow({ sessionId: payload.sessionId, interruptTrace: trace }, "\x03");
  if (shouldDrainOldOutput || pausedForInterrupt) {
    queueMicrotask(() => {
      if (sessions.get(payload.sessionId) !== session) return;
      try {
        session.stream?.resume?.();
        logTerminalInterruptDebug("interrupt-output-resumed-after-write", {
          session: getSessionSnapshot(session),
        }, trace);
      } catch (err) {
        logTerminalInterruptDebug("interrupt-output-resume-after-write-failed", {
          error: err?.message || String(err),
          code: err?.code,
          session: getSessionSnapshot(session),
        }, trace);
      }
    });
  }
}

async function sendSerialYmodem(_event, payload) {
  const session = sessions.get(payload?.sessionId);
  if (!session || !session.serialPort || session.type !== 'serial') {
    return { success: false, error: "YMODEM send requires an active serial session" };
  }
  if (session.ymodemActive) {
    return { success: false, error: "A YMODEM transfer is already in progress" };
  }
  if (session.zmodemSentry?.isActive()) {
    return { success: false, error: "Another serial file transfer is already in progress" };
  }
  if (!payload?.filePath || typeof payload.filePath !== "string") {
    return { success: false, error: "No file selected" };
  }

  const abortController = new AbortController();
  session.ymodemActive = true;
  session.ymodemAbortController = abortController;

  try {
    const result = await sendYmodemFile(session.serialPort, payload.filePath, {
      abortSignal: abortController.signal,
      timeoutMs: Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : undefined,
    });
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code,
    };
  } finally {
    session.ymodemActive = false;
    session.ymodemAbortController = null;
  }
}

async function receiveSerialYmodem(_event, payload) {
  const session = sessions.get(payload?.sessionId);
  if (!session || !session.serialPort || session.type !== 'serial') {
    return { success: false, error: "YMODEM receive requires an active serial session" };
  }
  if (session.ymodemActive) {
    return { success: false, error: "A YMODEM transfer is already in progress" };
  }
  if (session.zmodemSentry?.isActive()) {
    return { success: false, error: "Another serial file transfer is already in progress" };
  }
  if (!payload?.destinationDir || typeof payload.destinationDir !== "string") {
    return { success: false, error: "No destination directory selected" };
  }

  const abortController = new AbortController();
  session.ymodemActive = true;
  session.ymodemAbortController = abortController;

  try {
    const result = await receiveYmodemFiles(session.serialPort, {
      destinationDir: payload.destinationDir,
      abortSignal: abortController.signal,
      timeoutMs: Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : undefined,
    });
    return { success: true, ...result };
  } catch (error) {
    if (error?.code !== "YMODEM_CANCELLED" && error?.code !== "YMODEM_REMOTE_CANCELLED") {
      await sendYmodemCancel(session.serialPort);
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code,
    };
  } finally {
    session.ymodemActive = false;
    session.ymodemAbortController = null;
  }
}

/**
 * Pause or resume a session's source stream for output back-pressure.
 * The renderer asks for this when its write backlog crosses a watermark, so a
 * flooding source can't outrun the terminal renderer. Works across session
 * kinds: ssh2 channel (stream), node-pty (proc), telnet socket, serial port —
 * all expose pause()/resume().
 */
function setSessionFlowPaused(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) {
    logTerminalInterruptDebug("flow-paused-session-missing", {
      sessionId: payload.sessionId,
      paused: Boolean(payload.paused),
      senderId: event?.sender?.id,
    }, normalizeTrace(payload));
    return;
  }
  const trace = getRecentInterruptTrace(session);
  setRendererFlowPaused(session, payload.paused);
  if (!payload.paused) {
    session.flushPendingData?.();
  }
  if (trace) {
    logTerminalFlowPauseSample(session, {
      sessionId: payload.sessionId,
      paused: Boolean(payload.paused),
      senderId: event?.sender?.id,
    });
  }
}

function ackSessionFlow(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  logTerminalFlowAckSample(session, {
    sessionId: payload.sessionId,
    bytes: Number(payload.bytes),
    senderId: event?.sender?.id,
  });
  trackAck(session, Number(payload.bytes), payload.sessionId);
  session.flushPendingData?.();
}

/**
 * Resize a session terminal
 */
function resizeSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  if (Number.isFinite(payload.cols)) session.cols = payload.cols;
  if (Number.isFinite(payload.rows)) session.rows = payload.rows;
  
  try {
    if (session.stream) {
      session.stream.setWindow(payload.rows, payload.cols, 0, 0);
    } else if (session.proc) {
      session.proc.resize(payload.cols, payload.rows);
    } else if (session.socket && session.type === 'telnet-native') {
      session.cols = payload.cols;
      session.rows = payload.rows;
      // Only push a NAWS update once Telnet is active and the peer has enabled
      // NAWS with DO NAWS; partial console wrappers may leak SB payload bytes.
      if (session.telnetProtocolActive) {
        session.sendTelnetWindowSize?.();
      }
    }
  } catch (err) {
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
      console.warn("Resize failed", err);
    }
  }
}

/**
 * Sync ConPTY's internal buffer after the renderer clears the xterm viewport.
 * Without this, Windows shells (especially PowerShell) keep the old cursor
 * row and the next Enter reprints a tall blank gap. No-op on SSH/Unix PTYs.
 */
function clearSessionPtyBuffer(event, payload) {
  const session = sessions.get(payload?.sessionId);
  if (!session?.proc || typeof session.proc.clear !== "function") return;
  try {
    session.proc.clear();
  } catch (err) {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn("PTY clear failed", err);
    }
  }
}

/**
 * Close a session
 */
function closeSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  session.closed = true;
  fanoutSessionLifecycleEvent(
    payload.sessionId,
    session.webContentsId,
    "netcatty:exit",
    { sessionId: payload.sessionId, exitCode: 0, reason: "closed" },
    session._terminalSessionGeneration,
  );
  terminalInputPipelineBarriers.delete(payload.sessionId);
  closeTerminalOutputSession(payload.sessionId);

  try {
    clearSessionFlowState(session, { resume: false });
    cancelActiveYmodemSession(session);
    clearPendingAutomatedWrites(session);
    session.zmodemSentry?.cancel();
    session.discardPendingData?.();
    cleanupSessionExternalAuthArtifacts(session);
    session.releaseTelnetGeneration?.();
    if (session.stream) {
      // Snapshot multiplexing state *before* closing the channel: closing the
      // stream can synchronously fire its "close" handler, which nulls
      // session.connRef (and may already release the shared connection). Reading
      // session.connRef afterwards would then wrongly fall into the legacy path
      // and end the shared connection a second time.
      const isMultiplexed = !!session.connRef;
      // Always close this session's own shell channel.
      session.stream.close();
      if (isMultiplexed) {
        // Multiplexed SSH shell (issue #1204): several tabs may share one
        // authenticated connection. Closing this tab must only tear the shared
        // transport (and jump-host chain) down once the last channel is gone,
        // so route teardown through the reference-counted descriptor instead of
        // ending the connection directly. releaseConnectionRef is idempotent and
        // ends the chain connections itself when the count reaches zero — so it
        // is safe even if the stream "close" handler above already released.
        releaseConnectionRef(session);
      } else {
        // Legacy / non-multiplexed path: this session owns its connection.
        session.conn?.end();
        if (session.chainConnections) {
          for (const c of session.chainConnections) {
            try { c.end(); } catch {}
          }
        }
      }
    } else if (session.proc) {
      session.proc.kill();
      // Mosh sessions may also carry a companion ssh2 connection opened
      // lazily for host-info stats (issue #1198). ET can use the same pattern.
      // Close companions here to avoid leaking them.
      try { session.moshStatsConn?.end(); } catch { /* ignore */ }
      try { session.etStatsConn?.end(); } catch { /* ignore */ }
    } else if (session.socket) {
      session.socket.destroy();
    } else if (session.serialPort) {
      session.serialPort.close();
    } else if (session.chainConnections) {
      // Non-stream session still carrying a jump-host chain (defensive).
      for (const c of session.chainConnections) {
        try { c.end(); } catch {}
      }
    }
  } catch (err) {
    console.warn("Close failed", err);
  } finally {
    cleanupMoshAuthTempFiles(session.moshAuthTempFiles);
  }
  ptyProcessTree.unregisterPid(payload.sessionId);
  sessions.delete(payload.sessionId);
}

/**
 * Set terminal decoder encoding for an active telnet or serial session.
 * SSH sessions are handled by sshBridge's own setEncoding IPC — this one
 * only responds to sessions that carry a decoderRef (telnet + serial).
 */
function setSessionEncoding(_event, { sessionId, encoding }) {
  const session = sessions?.get(sessionId);
  if (!session || !session.decoderRef) {
    return { ok: false, encoding: encoding || 'utf-8' };
  }
  const enc = normalizeTerminalEncoding(encoding);
  if (!iconv.encodingExists(enc)) {
    return { ok: false, encoding: enc };
  }
  session.encoding = enc;
  // Keep serialEncoding mirror in sync so aiBridge / mcpServerBridge exec
  // calls pick up the new encoding too.
  if (session.type === 'serial') {
    session.serialEncoding = enc;
  }
  // iconv stateful decoders carry partial-byte state from the previous
  // encoding, so swap in a fresh decoder rather than reconfiguring.
  session.decoderRef.current = iconv.getDecoder(enc);
  return { ok: true, encoding: enc };
}

function getTelnetEchoMode(_event, { sessionId }) {
  const mode = sessions?.get(sessionId)?.telnetEchoMode;
  return mode
    ? { success: true, ...mode }
    : { success: false, error: "Telnet echo mode unavailable" };
}

/**
 * Register IPC handlers for terminal operations
 */
function registerWorkerHandle(ipcMain, terminalWorkerManager, channel) {
  ipcMain.handle(channel, (event, payload) => {
    return terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    });
  });
}

function registerWorkerSend(ipcMain, terminalWorkerManager, channel) {
  ipcMain.on(channel, (event, payload) => {
    terminalWorkerManager.send(channel, payload, {
      webContentsId: event?.sender?.id,
    });
  });
}

function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;
  // Attach/observe popups rebind display routing in the main process even when
  // PTY I/O is owned by the terminal worker. Always register these handlers.
  ipcMain.handle("netcatty:terminal:rebindOutput", (event, payload) =>
    rebindTerminalSessionOutput(event, payload, terminalWorkerManager));
  ipcMain.handle("netcatty:terminal:restoreOutput", (event, payload) =>
    restoreTerminalSessionOutput(event, payload, terminalWorkerManager));
  ipcMain.handle("netcatty:terminal:requestSnapshot", (event, payload) =>
    requestTerminalSessionSnapshot(event, payload, terminalWorkerManager));
  ipcMain.handle("netcatty:terminal:applySnapshot", (event, payload) =>
    applyTerminalSessionSnapshot(event, payload, terminalWorkerManager));
  ipcMain.handle("netcatty:terminal:setFlowPausedAndWait", async (event, payload) => {
    if (terminalWorkerManager) {
      await terminalWorkerManager.request("netcatty:terminal:setFlowPausedAndWait", payload, {
        webContentsId: event?.sender?.id,
      });
    } else {
      setSessionFlowPaused(event, payload);
    }
    if (!payload?.paused) return { success: true };
    return requestTerminalOutputDrain(payload?.sessionId, terminalWorkerManager);
  });
  ipcMain.handle("netcatty:terminal:markAttachClosePrepared", (event, payload) => {
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const success = markAttachPopupClosePrepared(
      payload?.authorization,
      sessionId,
      event?.sender?.id,
    );
    return success
      ? { success: true }
      : { success: false, error: "Unauthorized attach request" };
  });
  ipcMain.on("netcatty:terminal:snapshot-response", handleTerminalSessionSnapshotResponse);
  ipcMain.on("netcatty:terminal:output-drain-response", handleTerminalOutputDrainResponse);
  ipcMain.on("netcatty:terminal:apply-snapshot-response", handleTerminalSessionApplySnapshotResponse);
  ipcMain.on("netcatty:terminal:display-ready", (event, payload) => {
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const readyMain = findRegisteredMainWebContents(event?.sender?.id);
    if (!sessionId || readyMain?.id !== event?.sender?.id) return;
    retryPendingAttachedSessionOutput(sessionId, event.sender.id);
  });
  setRestoreAttachedSessionOutput((sessionId, preferredHomeWebContentsId) =>
    restoreAttachedSessionOutput(sessionId, terminalWorkerManager, preferredHomeWebContentsId));
  setAttachHomeLookup((sessionId) => {
    if (terminalWorkerManager?.getAttachHomeWebContentsId) {
      return terminalWorkerManager.getAttachHomeWebContentsId(sessionId);
    }
    return attachHomeWebContentsIds.get(sessionId) ?? null;
  });
  setFanoutSessionExit((sessionId, primaryWebContentsId, payload) => {
    fanoutSessionLifecycleEvent(sessionId, primaryWebContentsId, "netcatty:exit", payload);
  });

  if (terminalWorkerManager) {
    [
      "netcatty:local:start",
      "netcatty:telnet:start",
      "netcatty:mosh:start",
      "netcatty:et:start",
      "netcatty:serial:start",
      "netcatty:serial:list",
      "netcatty:serial:ymodem-send",
      "netcatty:serial:ymodem-receive",
      "netcatty:local:defaultShell",
      "netcatty:local:validatePath",
      "netcatty:shells:discover",
      "netcatty:terminal:setEncoding",
      "netcatty:telnet:getEchoMode",
      "netcatty:close:await",
    ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel));
    ipcMain.on("netcatty:write", (event, payload) => {
      // Session log streams started in the main process (manual/script logs)
      // sanitize sudo-autofill markers and programmatic command echoes based
      // on the *input* that produced them. In worker mode the real write
      // handler runs in the utilityProcess, so mirror the rewrite
      // registrations into the main-process stream manager before
      // forwarding. Both calls are no-ops without an active main-process
      // stream for the session.
      sessionLogStreamManager.registerSudoAutofillInput(payload?.sessionId, payload?.data);
      sessionLogStreamManager.registerProgrammaticCommandLogRewrite(payload?.sessionId, payload?.logRewrite);
      try {
        reportOpenedSessionActivity?.({ sessionId: payload?.sessionId, phase: "touch" });
      } catch {
        // Activity tracking must not interfere with terminal input.
      }
      terminalWorkerManager.send("netcatty:write", payload, {
        webContentsId: event?.sender?.id,
      });
    });
    [
      "netcatty:interrupt",
      "netcatty:resize",
      "netcatty:pty:clear",
      "netcatty:flow",
      "netcatty:flow:ack",
      "netcatty:close",
    ].forEach((channel) => registerWorkerSend(ipcMain, terminalWorkerManager, channel));
    return;
  }
  ipcMain.handle("netcatty:local:start", startLocalSession);
  ipcMain.handle("netcatty:telnet:start", startTelnetSession);
  ipcMain.handle("netcatty:mosh:start", startMoshSession);
  ipcMain.handle("netcatty:et:start", startEtSession);
  ipcMain.handle("netcatty:serial:start", startSerialSession);
  ipcMain.handle("netcatty:serial:list", listSerialPorts);
  ipcMain.handle("netcatty:serial:ymodem-send", sendSerialYmodem);
  ipcMain.handle("netcatty:serial:ymodem-receive", receiveSerialYmodem);
  ipcMain.handle("netcatty:local:defaultShell", getDefaultShell);
  ipcMain.handle("netcatty:local:validatePath", validatePath);
  ipcMain.handle("netcatty:shells:discover", () => discoverShells());
  ipcMain.handle("netcatty:terminal:setEncoding", setSessionEncoding);
  ipcMain.handle("netcatty:telnet:getEchoMode", getTelnetEchoMode);
  ipcMain.on("netcatty:write", writeToSession);
  ipcMain.on("netcatty:interrupt", interruptSession);
  ipcMain.on("netcatty:resize", resizeSession);
  ipcMain.on("netcatty:pty:clear", clearSessionPtyBuffer);
  ipcMain.on("netcatty:flow", setSessionFlowPaused);
  ipcMain.on("netcatty:flow:ack", ackSessionFlow);
  ipcMain.on("netcatty:close", closeSession);
  ipcMain.handle("netcatty:close:await", closeSession);
}

/**
 * Get the default shell for the current platform
 */
const { createPathValidationApi } = require("./terminalBridge/pathValidation.cjs");
const pathValidationApi = createPathValidationApi({
  getDefaultLocalShell, expandHomePath, path, fs, process, console, findExecutable,
});
const { getDefaultShell, validatePath } = pathValidationApi;

/**
 * Locate the mosh-client binary bundled by electron-builder via
 * `extraResources` (see electron-builder.config.cjs and
 * binaricat/MoshCatty releases).
 *
 * Returns an absolute path when the binary is on disk, otherwise null.
 * In dev / non-packaged runs the path is computed against the project
 * root so the helper is testable without packaging the app.
 *
 * Note this returns the network-protocol `mosh-client`, not the `mosh`
 * wrapper script. Netcatty drives the SSH bootstrap itself and then
 * launches this bundled client directly.
 */
function bundledMoshClient(opts = {}) {
  const isWin = (opts.platform || process.platform) === "win32";
  const basename = isWin ? "mosh-client.exe" : "mosh-client";

  // Packaged: <Resources>/mosh/mosh-client[.exe]
  const resourcesPath = opts.resourcesPath || process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "mosh", basename);
    if (fs.existsSync(packaged) && isExecutableFile(packaged)) return packaged;
  }

  // Dev fallback: resources/mosh/<platform-arch>/mosh-client[.exe] under
  // the project root. Useful for `npm run start` after running
  // `npm run fetch:mosh` locally.
  const projectRoot = opts.projectRoot || path.resolve(__dirname, "..", "..");
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(path.join(projectRoot, "resources", "mosh", "darwin-universal", basename));
  } else {
    candidates.push(path.join(projectRoot, "resources", "mosh", `${platform}-${arch}`, basename));
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && isExecutableFile(c)) return c;
  }
  return null;
}

/**
 * Locate the EternalTerminal `et` client bundled by electron-builder via
 * `extraResources` (see electron-builder.config.cjs and
 * .github/workflows/build-et-binaries.yml).
 *
 * Returns an absolute path when the binary is on disk, otherwise null. In
 * dev / non-packaged runs the path is computed against the project root so
 * the helper is testable without packaging the app.
 *
 * `et` is a self-contained client that performs its own SSH bootstrap and
 * EternalTerminal protocol handshake; Netcatty just spawns it as a PTY.
 */
function bundledEtClient(opts = {}) {
  const isWin = (opts.platform || process.platform) === "win32";
  const basename = isWin ? "et.exe" : "et";

  // Packaged: <Resources>/et/et[.exe]
  const resourcesPath = opts.resourcesPath || process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "et", basename);
    if (fs.existsSync(packaged) && isExecutableFile(packaged)) return packaged;
  }

  // Dev fallback: resources/et/<platform-arch>/et[.exe] under the project
  // root. Useful for `npm run start` after running `npm run fetch:et` locally.
  const projectRoot = opts.projectRoot || path.resolve(__dirname, "..", "..");
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(path.join(projectRoot, "resources", "et", "darwin-universal", basename));
  } else {
    candidates.push(path.join(projectRoot, "resources", "et", `${platform}-${arch}`, basename));
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && isExecutableFile(c)) return c;
  }
  return null;
}

/**
 * Cleanup all sessions - call before app quit
 */
function cleanupAllSessions() {
  console.log(`[Terminal] Cleaning up ${sessions.size} sessions before quit`);
  for (const [sessionId, session] of sessions) {
    try {
      session.zmodemSentry?.cancel();
      cancelActiveYmodemSession(session);
      clearPendingAutomatedWrites(session);
      clearSessionFlowState(session, { resume: false });
      session.discardPendingData?.();
      closeTerminalOutputSession(sessionId);
      cleanupSessionExternalAuthArtifacts(session);
      session.releaseTelnetGeneration?.();
      if (session.stream) {
        session.stream.close();
        session.conn?.end();
      } else if (session.proc) {
        // For node-pty on Windows, we need to kill more gracefully
        try {
          session.proc.kill();
        } catch (e) {
          // Ignore errors during cleanup
        }
        // Tear down a Mosh stats companion ssh2 connection if one was opened
        // (issue #1198), and the equivalent ET companion when present.
        try { session.moshStatsConn?.end(); } catch (e) { /* ignore */ }
        try { session.etStatsConn?.end(); } catch (e) { /* ignore */ }
      } else if (session.socket) {
        session.socket.destroy();
      } else if (session.serialPort) {
        try {
          session.serialPort.close();
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
      if (session.chainConnections) {
        for (const c of session.chainConnections) {
          try { c.end(); } catch {}
        }
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
  for (const [sessionId] of sessions) {
    ptyProcessTree.unregisterPid(sessionId);
  }
  sessions.clear();
  terminalOutputChannel?.closeAll?.();
}

module.exports = {
  init,
  registerHandlers,
  findExecutable,
  startLocalSession,
  startTelnetSession,
  startMoshSession,
  bundledMoshClient,
  resolveBareMoshClient,
  addBundledMoshRuntimeEnv,
  createMoshUtf8Decoder,
  startEtSession,
  execOnEtSession,
  bundledEtClient,
  startSerialSession,
  sendSerialYmodem,
  receiveSerialYmodem,
  listSerialPorts,
  writeToSession,
  setSessionEncoding,
  resizeSession,
  clearSessionPtyBuffer,
  setSessionFlowPaused,
  ackSessionFlow,
  closeSession,
  interruptSession,
  cleanupAllSessions,
  getDefaultShell,
  validatePath,
};
