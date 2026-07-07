"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEBUG_ENV_KEYS = [
  "NETCATTY_TERMINAL_PERF_DEBUG",
  "NETCATTY_TERMINAL_DEBUG",
];

let nextPerfId = 0;
let perfLogDir = null;
let configuredUserDataPath = null;

function isTerminalPerformanceDebugEnabled() {
  return DEBUG_ENV_KEYS.some((key) => process.env[key] === "1");
}

function countLineFeeds(data) {
  let count = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === "\n") count += 1;
  }
  return count;
}

function safeJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return nested.toString();
    if (typeof nested === "function") return "[function]";
    return nested;
  });
}

function getUserDataPathFromArgv() {
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith("--user-data-dir=")) {
      return arg.slice("--user-data-dir=".length) || null;
    }
    if (arg === "--user-data-dir") {
      return process.argv[index + 1] || null;
    }
  }
  return null;
}

function getPerfLogDir() {
  if (perfLogDir) return perfLogDir;
  try {
    const explicitLogDir = process.env.NETCATTY_TERMINAL_PERF_LOG_DIR;
    if (explicitLogDir) {
      perfLogDir = explicitLogDir;
      fs.mkdirSync(perfLogDir, { recursive: true });
      return perfLogDir;
    }

    let userDataPath = configuredUserDataPath || getUserDataPathFromArgv();
    if (!userDataPath) {
      const { app } = require("electron");
      userDataPath = app?.getPath?.("userData") || null;
    }
    if (!userDataPath) return null;
    perfLogDir = path.join(userDataPath, "terminal-perf");
    fs.mkdirSync(perfLogDir, { recursive: true });
    return perfLogDir;
  } catch {
    return null;
  }
}

function todayFileName() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `terminal-perf-${ymd}.log`;
}

function configureTerminalPerformanceDiagnostics(options = {}) {
  if (typeof options.userDataPath === "string" && options.userDataPath.trim()) {
    configuredUserDataPath = options.userDataPath;
    perfLogDir = null;
  }
}

function appendTerminalPerfLogLine(message) {
  try {
    const dir = getPerfLogDir();
    if (!dir) return;
    fs.appendFileSync(path.join(dir, todayFileName()), message + "\n", "utf-8");
  } catch {
    // Diagnostics must never affect terminal output.
  }
}

function createTerminalOutputPerfMeta(sessionId, data) {
  if (!isTerminalPerformanceDebugEnabled() || !data) return undefined;
  nextPerfId += 1;
  return {
    id: `termout-${Date.now().toString(36)}-${nextPerfId.toString(36)}`,
    emittedAt: Date.now(),
    sessionId,
    chars: typeof data === "string" ? data.length : 0,
    lineFeeds: typeof data === "string" ? countLineFeeds(data) : 0,
  };
}

function attachTerminalOutputPerfMeta(meta, terminalPerf) {
  if (!terminalPerf) return meta;
  return {
    ...(meta || {}),
    terminalPerf,
  };
}

function logTerminalOutputPerf(event, details = {}) {
  if (!isTerminalPerformanceDebugEnabled()) return;
  const payload = {
    event,
    at: Date.now(),
    ...details,
  };
  try {
    const message = `[Netcatty Terminal Perf] ${safeJson(payload)}`;
    console.info(message);
    appendTerminalPerfLogLine(message);
  } catch {
    // Diagnostics must never affect terminal output.
  }
}

module.exports = {
  appendTerminalPerfLogLine,
  attachTerminalOutputPerfMeta,
  configureTerminalPerformanceDiagnostics,
  createTerminalOutputPerfMeta,
  isTerminalPerformanceDebugEnabled,
  logTerminalOutputPerf,
};
