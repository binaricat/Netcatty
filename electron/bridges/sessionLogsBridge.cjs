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

/**
 * Register IPC handlers for session logs operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:sessionLogs:export", exportSessionLog);
  ipcMain.handle("netcatty:sessionLogs:selectDir", selectSessionLogsDir);
  ipcMain.handle("netcatty:sessionLogs:autoSave", autoSaveSessionLog);
  ipcMain.handle("netcatty:sessionLogs:openDir", openSessionLogsDir);
}

module.exports = {
  registerHandlers,
  exportSessionLog,
  selectSessionLogsDir,
  autoSaveSessionLog,
  openSessionLogsDir,
  toLocalISOString,
  terminalDataToHtml,
  terminalPlainTextToHtml,
  wrapTerminalHtmlContent,
  safePathSegment,
};
