/**
 * Session Logs Bridge - Handles session log export and auto-save operations
 * Provides functionality to export terminal logs to files and manage auto-save settings
 */

const fs = require("node:fs");
const path = require("node:path");
const { dialog } = require("electron");
const {
  terminalDataToHtmlContent,
  terminalDataToPlainText,
} = require("./terminalLogSanitizer.cjs");

const FILE_NAME_UNSAFE_CHARS = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);
const WINDOWS_RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const manualSessionLogTokens = new Map();

function isControlCharacter(char) {
  const code = char.codePointAt(0);
  return code !== undefined && ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f));
}

/**
 * Get current Date to a local ISO-like string (YYYY-MM-DDTHH-MM-SS)
 */
function toLocalISOString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

function safePathSegment(value, fallback = "unknown") {
  const raw = String(value || "");
  let safe = Array.from(raw, (char) => {
    return FILE_NAME_UNSAFE_CHARS.has(char) || isControlCharacter(char) ? "_" : char;
  }).join("").trim();

  if (!safe || safe === "." || safe === "..") {
    return fallback;
  }

  safe = safe.replace(/\.+$/g, (match) => "_".repeat(match.length));

  if (WINDOWS_RESERVED_DEVICE_NAME.test(safe)) {
    safe = `${safe}_`;
  }

  return safe;
}

/**
 * Escape HTML special characters to prevent XSS
 * Must be applied before converting ANSI codes to HTML spans
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function terminalPlainTextToHtml(plainText, hostLabel, timestamp) {
  const htmlContent = escapeHtml(plainText || "");
  return wrapTerminalHtmlContent(htmlContent, hostLabel, timestamp);
}

function wrapTerminalHtmlContent(htmlContent, hostLabel, timestamp) {
  const dateStr = new Date(timestamp).toLocaleString();
  const safeHostLabel = escapeHtml(hostLabel || "Unknown");
  const safeDateStr = escapeHtml(dateStr);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Session Log - ${safeHostLabel}</title>
  <style>
    body {
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: 'JetBrains Mono', 'SF Mono', Monaco, Menlo, monospace;
      font-size: 13px;
      line-height: 1.4;
      padding: 20px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .header {
      border-bottom: 1px solid #444;
      padding-bottom: 10px;
      margin-bottom: 20px;
      color: #888;
    }
  </style>
</head>
<body>
  <div class="header">
    Host: ${safeHostLabel}<br>
    Date: ${safeDateStr}
  </div>
  <div class="content">${htmlContent || ""}</div>
</body>
</html>`;
}

/**
 * Convert terminal data to HTML after applying terminal text controls while
 * preserving SGR styles such as color, bold, italic, and underline.
 */
function terminalDataToHtml(terminalData, hostLabel, timestamp) {
  return wrapTerminalHtmlContent(terminalDataToHtmlContent(terminalData), hostLabel, timestamp);
}

/**
 * Export a session log to a file (manual export via save dialog)
 */
async function exportSessionLog(event, payload) {
  const { terminalData, hostLabel, hostname, startTime, format } = payload;

  if (!terminalData) {
    throw new Error("No terminal data to export");
  }

  // Generate default filename
  const date = new Date(startTime);
  const dateStr = toLocalISOString(date);
  const safeHostLabel = safePathSegment(hostLabel || hostname, "session");
  const ext = format === "html" ? "html" : format === "raw" ? "log" : "txt";
  const defaultPath = `${safeHostLabel}_${dateStr}.${ext}`;

  // Show save dialog
  const result = await dialog.showSaveDialog({
    defaultPath,
    filters: [
      { name: "Text Files", extensions: ["txt"] },
      { name: "Log Files", extensions: ["log"] },
      { name: "HTML Files", extensions: ["html"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  // Prepare content based on format
  let content;
  const actualFormat = path.extname(result.filePath).slice(1) || format;

  if (actualFormat === "html") {
    content = terminalDataToHtml(terminalData, hostLabel, startTime);
  } else if (actualFormat === "log" || actualFormat === "raw") {
    // Raw format preserves ANSI codes
    content = terminalData;
  } else {
    // Plain text - apply terminal text controls and remove escape sequences
    content = terminalDataToPlainText(terminalData);
  }

  await fs.promises.writeFile(result.filePath, content, "utf8");

  return { success: true, filePath: result.filePath };
}

/**
 * Select a directory for session logs storage
 */
async function selectSessionLogsDir(event) {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Select Session Logs Directory",
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  return { success: true, directory: result.filePaths[0] };
}

/**
 * Auto-save a session log to the configured directory
 * Called when a terminal session ends
 */
async function autoSaveSessionLog(event, payload) {
  const { terminalData, hostLabel, hostname, hostId, startTime, format, directory } = payload;

  if (!terminalData || !directory) {
    return { success: false, error: "Missing terminal data or directory" };
  }

  try {
    // Create host subdirectory
    const safeHostLabel = safePathSegment(hostLabel || hostname || hostId, "unknown");
    const hostDir = path.join(directory, safeHostLabel);

    await fs.promises.mkdir(hostDir, { recursive: true });

    // Generate filename with timestamp
    const date = new Date(startTime);
    const dateStr = toLocalISOString(date);
    const ext = format === "html" ? "html" : format === "raw" ? "log" : "txt";
    const fileName = `${dateStr}.${ext}`;
    const filePath = path.join(hostDir, fileName);

    // Prepare content based on format
    let content;
    if (format === "html") {
      content = terminalDataToHtml(terminalData, hostLabel, startTime);
    } else if (format === "raw") {
      content = terminalData;
    } else {
      content = terminalDataToPlainText(terminalData);
    }

    await fs.promises.writeFile(filePath, content, "utf8");

    return { success: true, filePath };
  } catch (err) {
    console.error("Failed to auto-save session log:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Open the session logs directory in the system file explorer
 */
async function openSessionLogsDir(event, payload) {
  const { shell } = require("electron");
  const { directory } = payload;

  if (!directory) {
    return { success: false, error: "No directory specified" };
  }

  try {
    // Check if directory exists
    await fs.promises.access(directory);
    await shell.openPath(directory);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function startManualSessionLog(event, payload = {}) {
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
  const { sessionId, sessionName, preferredDirectory, initialLine } = payload;
  if (!sessionId) {
    return { success: false, started: false, error: "Missing sessionId" };
  }

  if (sessionLogStreamManager.hasStream(sessionId)) {
    return { success: false, started: false, error: "Session log is already active" };
  }

  const targetDirectory = typeof preferredDirectory === "string" && preferredDirectory.trim()
    ? preferredDirectory.trim()
    : require("node:os").homedir();
  const safeSessionName = safePathSegment(sessionName || sessionId, "session");
  const defaultPath = path.join(targetDirectory, `${safeSessionName}_${toLocalISOString(new Date())}.log`);

  try {
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [
        { name: "Log Files", extensions: ["log"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: true, started: false, canceled: true };
    }

    const filePath = normalizeManualSessionLogFilePath(result.filePath);
    if (filePath !== result.filePath && !(await confirmManualSessionLogOverwrite(filePath))) {
      return { success: true, started: false, canceled: true };
    }

    const startResult = sessionLogStreamManager.startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: safeSessionName,
      startTime: Date.now(),
      initialLine: typeof initialLine === "string" ? initialLine : "",
      separateInitialLineBeforeLeadingCarriageReturn: true,
      stopRequiresToken: true,
    });

    if (!startResult.ok) {
      return { success: false, started: false, error: startResult.error || "Failed to start session log" };
    }

    manualSessionLogTokens.set(sessionId, startResult.token);
    return { success: true, started: true, filePath };
  } catch (err) {
    return { success: false, started: false, error: err?.message || String(err) };
  }
}

function normalizeManualSessionLogFilePath(filePath) {
  return path.extname(filePath).toLowerCase() === ".log" ? filePath : `${filePath}.log`;
}

async function confirmManualSessionLogOverwrite(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    throw err;
  }

  const result = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Overwrite", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Overwrite session log?",
    message: `"${path.basename(filePath)}" already exists.`,
    detail: "Choose Overwrite to replace it, or Cancel to keep the existing file.",
  });

  return result.response === 0;
}

async function stopManualSessionLog(event, payload = {}) {
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
  const { sessionId } = payload;
  if (!sessionId) {
    return { success: false, stopped: false, error: "Missing sessionId" };
  }

  try {
    const token = manualSessionLogTokens.get(sessionId);
    if (!token) {
      return { success: true, stopped: false };
    }

    const filePath = await sessionLogStreamManager.stopStream(sessionId, token);
    if (!filePath) {
      if (!sessionLogStreamManager.hasStream(sessionId)) {
        manualSessionLogTokens.delete(sessionId);
      }
      return { success: true, stopped: false };
    }
    manualSessionLogTokens.delete(sessionId);
    return { success: true, stopped: true, filePath };
  } catch (err) {
    return { success: false, stopped: false, error: err?.message || String(err) };
  }
}

async function getManualSessionLogStatus(event, payload = {}) {
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
  const { sessionId } = payload;
  if (!sessionId) {
    return { success: false, isLogging: false, error: "Missing sessionId" };
  }
  return { success: true, isLogging: sessionLogStreamManager.hasStream(sessionId) };
}

/**
 * Register IPC handlers for session logs operations
 */
function registerHandlers(ipcMain, options = {}) {
  ipcMain.handle("netcatty:sessionLogs:export", exportSessionLog);
  ipcMain.handle("netcatty:sessionLogs:selectDir", selectSessionLogsDir);
  ipcMain.handle("netcatty:sessionLogs:autoSave", autoSaveSessionLog);
  ipcMain.handle("netcatty:sessionLogs:openDir", openSessionLogsDir);
  ipcMain.handle("netcatty:sessionLog:manualStart", startManualSessionLog);
  ipcMain.handle("netcatty:sessionLog:manualStop", stopManualSessionLog);
  ipcMain.handle("netcatty:sessionLog:manualStatus", getManualSessionLogStatus);

  // In the default terminal-worker runtime, sessions run in a utilityProcess
  // and call appendData() on the worker's own sessionLogStreamManager module
  // instance. Manual session logs (and script session logs) are started in
  // the *main* process, so without this tap their streams never receive any
  // terminal output — the saved file would only contain the initial prompt
  // line captured from the renderer buffer (issue #1938). The worker already
  // mirrors every output chunk to the main process for script output buffers;
  // feed that same stream into the main-process log streams. appendData() is
  // a no-op for sessions without an active main-process stream.
  options.terminalWorkerManager?.addOutputTap?.((sessionId, data) => {
    if (typeof data !== "string" || data.length === 0) return;
    require("./sessionLogStreamManager.cjs").appendData(sessionId, data);
  });
}

module.exports = {
  registerHandlers,
  exportSessionLog,
  selectSessionLogsDir,
  autoSaveSessionLog,
  openSessionLogsDir,
  startManualSessionLog,
  stopManualSessionLog,
  getManualSessionLogStatus,
  toLocalISOString,
  terminalDataToHtml,
  terminalPlainTextToHtml,
  wrapTerminalHtmlContent,
  safePathSegment,
};
