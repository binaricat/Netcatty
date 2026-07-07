/**
 * Crash Log Bridge - Captures main-process errors and writes them to local log files.
 *
 * Log files are stored as JSONL (one JSON object per line) under
 * {userData}/crash-logs/crash-YYYY-MM-DD.log so that appending is cheap and
 * atomic.  Files older than 30 days are pruned on startup.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  appendTerminalPerfLogLine,
  configureTerminalPerformanceDiagnostics,
} = require("./terminalPerformanceDiagnostics.cjs");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let logDir = null;
let electronApp = null;
let electronShell = null;
let sessionsMap = null;

const LOG_RETENTION_DAYS = 30;
const TERMINAL_PERF_DEBUG_ENV_KEYS = [
  "NETCATTY_TERMINAL_PERF_DEBUG",
  "NETCATTY_TERMINAL_DEBUG",
];
const TERMINAL_PERF_LOG_PREFIX = "[Netcatty Terminal Perf]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureLogDir() {
  if (logDir) return logDir;

  try {
    // Try the stored app reference first, then fall back to requiring electron
    // directly so crash logging works even before init() is called.
    let userDataPath = null;
    if (electronApp) {
      userDataPath = electronApp.getPath("userData");
    } else {
      try {
        const { app } = require("node:electron");
        userDataPath = app?.getPath?.("userData") ?? null;
      } catch {
        try {
          const { app } = require("electron");
          userDataPath = app?.getPath?.("userData") ?? null;
        } catch {
          // Electron not available yet
        }
      }
    }
    if (!userDataPath) return null;

    logDir = path.join(userDataPath, "crash-logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    return logDir;
  } catch {
    return null;
  }
}

function todayFileName() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `crash-${ymd}.log`;
}

function buildEntry(source, err, extra) {
  const error = err instanceof Error ? err : new Error(String(err ?? "unknown"));

  let mem;
  try {
    const m = process.memoryUsage();
    mem = {
      rss: Math.round(m.rss / 1048576),
      heapUsed: Math.round(m.heapUsed / 1048576),
      heapTotal: Math.round(m.heapTotal / 1048576),
    };
  } catch {
    // ignore
  }

  // Extract extra properties from the error object (code, errno, syscall, etc.)
  const errorMeta = {};
  for (const key of ["code", "errno", "syscall", "hostname", "port", "signal", "level"]) {
    if (error[key] !== undefined) {
      errorMeta[key] = error[key];
    }
  }

  return {
    timestamp: new Date().toISOString(),
    source,
    message: error.message || String(err),
    stack: error.stack || undefined,
    errorMeta: Object.keys(errorMeta).length > 0 ? errorMeta : undefined,
    extra: extra || undefined,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    version: electronApp?.getVersion?.() ?? "unknown",
    electronVersion: process.versions?.electron ?? "unknown",
    osVersion: os.release(),
    memoryMB: mem,
    activeSessionCount: sessionsMap?.size ?? -1,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a crash/error entry to today's log file (sync, safe for use in
 * uncaughtException handlers).
 */
function captureError(source, err, extra) {
  try {
    const dir = ensureLogDir();
    if (!dir) return;

    const entry = buildEntry(source, err, extra);
    const filePath = path.join(dir, todayFileName());
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Never throw from the crash logger itself.
  }
}

function captureDiagnostic(source, message, extra) {
  captureError(source, new Error(String(message || "diagnostic")), extra);
}

function shouldMirrorTerminalPerfDiagnostics() {
  return TERMINAL_PERF_DEBUG_ENV_KEYS.some((key) => process.env[key] === "1");
}

/**
 * Delete log files older than LOG_RETENTION_DAYS.
 */
function pruneOldLogs() {
  try {
    const dir = ensureLogDir();
    if (!dir) return;

    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (!file.startsWith("crash-") || !file.endsWith(".log")) continue;
      try {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          console.log(`[CrashLog] Pruned old log: ${file}`);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

/**
 * Count newlines in a file by streaming instead of reading entire content.
 */
async function countLines(filePath) {
  return new Promise((resolve) => {
    let count = 0;
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    stream.on("data", (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === "\n") count++;
      }
    });
    stream.on("end", () => resolve(count));
    stream.on("error", () => resolve(0));
  });
}

async function listLogs() {
  const dir = ensureLogDir();
  if (!dir) return [];

  try {
    const files = await fs.promises.readdir(dir);
    const results = [];

    for (const file of files) {
      if (!file.startsWith("crash-") || !file.endsWith(".log")) continue;
      try {
        const filePath = path.join(dir, file);
        const stat = await fs.promises.stat(filePath);
        const entryCount = await countLines(filePath);
        results.push({
          fileName: file,
          date: file.replace("crash-", "").replace(".log", ""),
          size: stat.size,
          entryCount,
        });
      } catch {
        // skip unreadable files
      }
    }

    // Sort newest first
    results.sort((a, b) => b.date.localeCompare(a.date));
    return results;
  } catch {
    return [];
  }
}

const MAX_READ_ENTRIES = 500;
// Read up to ~256KB from the tail of the file to cap memory/CPU usage
const MAX_TAIL_BYTES = 256 * 1024;

async function readLog(fileName) {
  const dir = ensureLogDir();
  if (!dir) return [];

  // Validate fileName to prevent path traversal
  if (!/^crash-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) return [];

  try {
    const filePath = path.join(dir, fileName);
    const stat = await fs.promises.stat(filePath);

    let content;
    if (stat.size > MAX_TAIL_BYTES) {
      // Only read the tail of the file
      const buf = Buffer.alloc(MAX_TAIL_BYTES);
      const fd = await fs.promises.open(filePath, "r");
      try {
        await fd.read(buf, 0, MAX_TAIL_BYTES, stat.size - MAX_TAIL_BYTES);
      } finally {
        await fd.close();
      }
      const raw = buf.toString("utf-8");
      // Drop the first partial line
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = await fs.promises.readFile(filePath, "utf-8");
    }

    const lines = content.split("\n").filter(Boolean);
    // Only parse the last MAX_READ_ENTRIES lines
    const tail = lines.slice(-MAX_READ_ENTRIES);
    const entries = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function clearLogs() {
  const dir = ensureLogDir();
  if (!dir) return { deletedCount: 0 };

  let deletedCount = 0;
  try {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      if (!file.startsWith("crash-") || !file.endsWith(".log")) continue;
      try {
        await fs.promises.unlink(path.join(dir, file));
        deletedCount++;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return { deletedCount };
}

async function openDir() {
  const dir = ensureLogDir();
  if (!dir || !electronShell?.openPath) return { success: false };
  try {
    const errorMessage = await electronShell.openPath(dir);
    // shell.openPath resolves to an error string on failure, empty string on success
    return { success: !errorMessage };
  } catch {
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function init(deps) {
  const { electronModule, sessions } = deps;
  const { app, shell } = electronModule || {};
  electronApp = app;
  electronShell = shell;
  sessionsMap = sessions || null;

  ensureLogDir();
  try {
    const userDataPath = electronApp?.getPath?.("userData");
    configureTerminalPerformanceDiagnostics({ userDataPath });
  } catch {
    // ignore
  }
  pruneOldLogs();

  console.log(`[CrashLog] Crash log directory: ${logDir}`);
}

function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:crashLogs:list", async () => listLogs());
  ipcMain.handle("netcatty:crashLogs:read", async (_event, { fileName }) => readLog(fileName));
  ipcMain.handle("netcatty:crashLogs:clear", async () => clearLogs());
  ipcMain.handle("netcatty:crashLogs:openDir", async () => openDir());
  ipcMain.handle("netcatty:diagnostics:log", async (_event, payload) => {
    const source = typeof payload?.source === "string" && payload.source.trim()
      ? payload.source.trim()
      : "renderer-diagnostic";
    const message = typeof payload?.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "diagnostic";
    if (source === "terminal-perf" && message.startsWith(TERMINAL_PERF_LOG_PREFIX)) {
      appendTerminalPerfLogLine(message);
      if (shouldMirrorTerminalPerfDiagnostics()) {
        console.info(message);
      }
      return { success: true };
    }
    captureDiagnostic(source, message, payload?.extra);
    return { success: true };
  });
}

module.exports = {
  init,
  captureError,
  captureDiagnostic,
  registerHandlers,
};
