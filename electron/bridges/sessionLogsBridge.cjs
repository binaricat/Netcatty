/**
 * Session Logs Bridge - Handles session log export and auto-save operations
 * Provides functionality to export terminal logs to files and manage auto-save settings
 */

const fs = require("node:fs");
const path = require("node:path");
const { dialog } = require("electron");

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

/**
 * Strip ANSI escape codes from text
 * Used for plain text export format
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    // OSC: ESC ] ... BEL or ESC ] ... ESC \
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    // ANSI CSI / ESC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    // Remove remaining control chars except \n \r \t
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
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

/**
 * Convert terminal data to HTML with colors preserved
 */
function terminalDataToHtml(terminalData, hostLabel, timestamp) {
  // Basic ANSI to HTML conversion for common codes
  const ansiToHtml = (text) => {
    const colorMap = {
      "30": "color: #000",
      "31": "color: #c00",
      "32": "color: #0c0",
      "33": "color: #cc0",
      "34": "color: #00c",
      "35": "color: #c0c",
      "36": "color: #0cc",
      "37": "color: #ccc",
      "90": "color: #666",
      "91": "color: #f66",
      "92": "color: #6f6",
      "93": "color: #ff6",
      "94": "color: #66f",
      "95": "color: #f6f",
      "96": "color: #6ff",
      "97": "color: #fff",
      "40": "background: #000",
      "41": "background: #c00",
      "42": "background: #0c0",
      "43": "background: #cc0",
      "44": "background: #00c",
      "45": "background: #c0c",
      "46": "background: #0cc",
      "47": "background: #ccc",
      "1": "font-weight: bold",
      "3": "font-style: italic",
      "4": "text-decoration: underline",
    };

    // First, escape HTML in the text content (not the ANSI codes)
    // We do this by splitting on ANSI sequences, escaping each text part, then rejoining
    // eslint-disable-next-line no-control-regex
    const ansiRegex = /(\x1B\[[0-9;]*m|\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/g;
    const parts = text.split(ansiRegex);

    let result = parts.map((part) => {
      // Check if this part is an ANSI sequence
      // eslint-disable-next-line no-control-regex
      if (/^\x1B/.test(part)) {
        // It's an ANSI sequence, convert to HTML span or remove
        const match = part.match(/^\x1B\[([0-9;]*)m$/);
        if (match) {
          const codes = match[1];
          if (codes === "0" || codes === "") {
            return "</span>";
          }
          const styles = codes.split(";").map((c) => colorMap[c]).filter(Boolean);
          if (styles.length > 0) {
            return `<span style="${styles.join("; ")}">`;
          }
        }
        // Other ANSI sequences are stripped
        return "";
      }
      // It's regular text, escape HTML
      return escapeHtml(part);
    }).join("");

    return result;
  };

  const htmlContent = ansiToHtml(terminalData);
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
  <div class="content">${htmlContent}</div>
</body>
</html>`;
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
  const safeHostLabel = (hostLabel || hostname || "session").replace(/[^a-zA-Z0-9-_]/g, "_");
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
    // Plain text - strip ANSI codes
    content = stripAnsi(terminalData);
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
    const safeHostLabel = (hostLabel || hostname || hostId || "unknown").replace(/[^a-zA-Z0-9-_]/g, "_");
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
      content = stripAnsi(terminalData);
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
  stripAnsi,
  toLocalISOString,
  terminalDataToHtml,
};
