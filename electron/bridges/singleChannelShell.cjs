"use strict";

const { getFreshIdlePrompt, stripAnsi } = require("./ai/shellUtils.cjs");

let sessions = null;

function escapeShellArg(arg) {
  return "'" + String(arg == null ? "" : arg).replace(/'/g, "'\\''") + "'";
}
function isShellIdleForInjection(session) {
  if (getFreshIdlePrompt(session)) return true;
  const tail = stripAnsi(String(session && session._promptTrackTail || "")).replace(/\r/g, "\n");
  if (!tail || tail.endsWith("\n")) return false;
  const lastLine = tail.split("\n").pop() || "";
  // 标准提示符认不出时（例如 [user@host ~]$），只在行尾停在提示符、没有后续输入时注入。
  return lastLine.length <= 180 && /[#$%]\s*$/.test(lastLine);
}

function listSingleChannelShells(client) {
  if (!sessions || typeof sessions.values !== "function") return [];
  const endpointKey = client && client.__netcattyEndpointKey || "";
  const shells = [];
  for (const session of sessions.values()) {
    if (!session || !session.stream || session.stream.writable === false) continue;
    if (typeof session.stream.write !== "function") continue;
    if (session.singleChannelSsh !== true) continue;
    shells.push(session);
  }
  if (endpointKey) {
    return shells.filter((session) => session.connRef && session.connRef.endpointKey === endpointKey);
  }
  return shells.length === 1 ? shells : [];
}

function findIdleInteractiveShellSession(client) {
  return listSingleChannelShells(client).find((session) => isShellIdleForInjection(session)) || null;
}

function delayForInteractiveShell(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Upload cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal && signal.removeEventListener) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (timer.unref) timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Upload cancelled"));
    };
    if (signal && signal.addEventListener) signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForIdleInteractiveShell(client, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const session = findIdleInteractiveShellSession(client);
    if (session) return session;
    if (Date.now() >= deadline) return null;
    await delayForInteractiveShell(Math.min(200, Math.max(0, deadline - Date.now())), signal);
  }
}

function runInteractiveShellCommand(session, command, timeoutMs, signal) {
  const marker = "NETCATTY_EXTRACT_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  // 只发普通按键和回车。单通道堡垒机会把 Ctrl-U / 额外 exec 当成踢线条件。
  const script = String(command || "").replace(/\s+$/, "");
  const line = script + "\nprintf '%s %s\\n' " + escapeShellArg(marker) + " \"$?\"\r";
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const markerPattern = new RegExp("" + marker + " (\\d+)", "g");
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && signal.removeEventListener) signal.removeEventListener("abort", onAbort);
      try { session.stream.removeListener("data", onData); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve({ code: code, output: buffer });
    };
    const onData = (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (buffer.length > 65536) buffer = buffer.slice(-32768);
      markerPattern.lastIndex = 0;
      let match = null;
      let found = null;
      while ((match = markerPattern.exec(buffer))) found = match;
      if (!found) return;
      finish(null, Number(found[1]));
    };
    const onAbort = () => finish(signal && signal.reason instanceof Error ? signal.reason : new Error("Upload cancelled"));
    const timer = setTimeout(() => {
      finish(new Error("Remote extraction timed out after " + Math.round(timeoutMs / 1000) + " seconds"));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    if (signal && signal.addEventListener) signal.addEventListener("abort", onAbort, { once: true });
    session.stream.on("data", onData);
    try {
      session.stream.write(line);
    } catch (error) {
      finish(error);
    }
  });
}

function isInteractivePwdLine(line) {
  if (!line || line.charAt(0) !== "/" || line.length > 4096) return false;
  // 提示符（/root #）以及和 pwd 回显混在同一行的内容都不是目录。
  if (/[#$%>]\s*$/.test(line)) return false;
  if (/\s/.test(line) && /\bpwd\b/.test(line)) return false;
  return true;
}

function isPromptLikeLine(line) {
  const trimmed = String(line || "").replace(/\s+$/, "");
  return trimmed.length > 0 && trimmed.length <= 180 && /[#$%>]\s*$/.test(trimmed);
}

function lastOpenPromptLine(tail) {
  const text = stripAnsi(String(tail || "")).replace(/\r/g, "\n");
  if (!text || text.endsWith("\n")) return "";
  const line = text.split("\n").pop() || "";
  return line.length <= 180 ? line : "";
}

function markInteractiveCommandBaseline(session) {
  if (!session || session.singleChannelSsh !== true) return;
  session.interactiveCommandBaseline = {
    at: Number(session.lastIdlePromptAt) || 0,
    tail: String(session._promptTrackTail || ""),
  };
}

function hasConfirmedIdlePromptAfterCommand(session, baseline) {
  if (!session || !baseline) return false;
  const at = Number(session.lastIdlePromptAt) || 0;
  if (at > (Number(baseline.at) || 0) && getFreshIdlePrompt(session)) return true;
  const tail = String(session._promptTrackTail || "");
  if (tail === String(baseline.tail || "")) return false;
  return isPromptLikeLine(lastOpenPromptLine(tail));
}

function classifyInteractivePwd(buffer) {
  const text = stripAnsi(String(buffer || "")).replace(/\r/g, "\n");
  const parts = text.split("\n");
  const incomplete = text.endsWith("\n") ? "" : (parts.pop() || "");
  let path = null;
  const consume = (line) => {
    if (!line) return "skip";
    if (!path && line === "pwd") return "skip";
    if (!path && isInteractivePwdLine(line)) {
      path = line;
      return "skip";
    }
    if (path && isPromptLikeLine(line)) return "done";
    return "reject";
  };
  for (const raw of parts) {
    const result = consume(raw.trim());
    if (result === "done") return { status: "done", path: path };
    if (result === "reject") return { status: "reject", path: null };
  }
  const tailLine = incomplete.trim();
  const tailResult = tailLine ? consume(tailLine) : "skip";
  if (tailResult === "done") return { status: "done", path: path };
  if (tailResult === "reject") return { status: "pending", path: null };
  return { status: "pending", path: null };
}

function extractInteractivePwd(buffer) {
  const parsed = classifyInteractivePwd(buffer);
  return parsed.status === "done" ? parsed.path : null;
}

function runInteractivePwd(session, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error, cwd) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && signal.removeEventListener) signal.removeEventListener("abort", onAbort);
      try { session.stream.removeListener("data", onData); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(cwd);
    };
    const onData = (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (buffer.length > 65536) buffer = buffer.slice(-32768);
      const parsed = classifyInteractivePwd(buffer);
      if (parsed.status === "done") finish(null, parsed.path);
      else if (parsed.status === "reject") finish(null, null);
    };
    const onAbort = () => finish(signal && signal.reason instanceof Error ? signal.reason : new Error("pwd cancelled"));
    const timer = setTimeout(() => finish(new Error("pwd timed out")), timeoutMs);
    if (timer.unref) timer.unref();
    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    if (signal && signal.addEventListener) signal.addEventListener("abort", onAbort, { once: true });
    session.stream.on("data", onData);
    try {
      session.stream.write("pwd\r");
    } catch (error) {
      finish(error);
    }
  });
}

async function readInteractivePwd(session, options = {}) {
  if (!session || !session.stream || session.stream.writable === false) return null;
  if (typeof session.stream.write !== "function") return null;
  const baseline = session.interactiveCommandBaseline;
  if (!baseline) return null;
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 0;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
  const deadline = Date.now() + waitMs;
  while (!hasConfirmedIdlePromptAfterCommand(session, baseline)) {
    if (Date.now() >= deadline) return null;
    await delayForInteractiveShell(Math.min(200, Math.max(0, deadline - Date.now())), options.signal);
  }
  return runInteractivePwd(session, timeoutMs, options.signal);
}

function writeInteractiveShellCommand(session, command, timeoutMs, signal) {
  return runInteractiveShellCommand(session, command, timeoutMs, signal).then((result) => result.code);
}

async function runIdleShellCommand(client, command, options = {}) {
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 0;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000;
  const session = waitMs > 0
    ? await waitForIdleInteractiveShell(client, waitMs, options.signal)
    : findIdleInteractiveShellSession(client);
  if (!session) return null;
  return runInteractiveShellCommand(session, command, timeoutMs, options.signal);
}

async function runOnShellSession(session, command, options = {}) {
  if (!session || !session.stream || session.stream.writable === false) return null;
  if (typeof session.stream.write !== "function") return null;
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 0;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000;
  const deadline = Date.now() + waitMs;
  while (!isShellIdleForInjection(session)) {
    if (Date.now() >= deadline) return null;
    await delayForInteractiveShell(Math.min(200, Math.max(0, deadline - Date.now())), options.signal);
  }
  return runInteractiveShellCommand(session, command, timeoutMs, options.signal);
}

function init(nextSessions) {
  if (nextSessions) sessions = nextSessions;
}

module.exports = {
  init,
  findIdleInteractiveShellSession,
  waitForIdleInteractiveShell,
  writeInteractiveShellCommand,
  runIdleShellCommand,
  runOnShellSession,
  readInteractivePwd,
  extractInteractivePwd,
  markInteractiveCommandBaseline,
};
