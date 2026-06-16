/* eslint-disable no-undef */

function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\"'\"'`)}'`;
}

function wrapLoginShell(command) {
  const oneLine = String(command || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");
  return `bash -lc ${JSON.stringify(oneLine)}`;
}

function wrapShExec(command) {
  const oneLine = String(command || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");
  return `exec sh -c ${JSON.stringify(oneLine)}`;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function parseTmuxVersionString(text) {
  const match = stripAnsi(text).match(/tmux\s+(\d+)\.(\d+)([a-z0-9]*)/i);
  if (!match) {
    return { raw: stripAnsi(text).trim(), major: 0, minor: 0, patch: "" };
  }
  return {
    raw: match[0],
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
    patch: match[3] || "",
  };
}

function getListSessionsFormat(version) {
  const major = version?.major ?? 0;
  const minor = version?.minor ?? 0;

  if (major < 2) return null;

  const fields = ["#{session_name}", "#{session_windows}", "#{session_attached}"];

  if (major >= 3 || (major === 2 && minor >= 1)) {
    fields.push("#{session_created}", "#{session_activity}");
  }

  if (major > 3 || (major === 3 && minor >= 2)) {
    fields.push("#{session_group}");
  }

  return fields.join("\\t");
}

// Single-line script — multiline strings break when passed through bash -lc JSON quoting.
const TMUX_DETECT_SCRIPT = [
  "uid=$(id -u 2>/dev/null || echo 0)",
  "echo \"__TMUX_VERSION__=$(tmux -V 2>/dev/null || true)\"",
  "echo \"__TMUX_BIN__=$(command -v tmux 2>/dev/null || which tmux 2>/dev/null || true)\"",
  "for d in \"${TMUX_TMPDIR:-/tmp}/tmux-$uid\" \"/tmp/tmux-$uid\"; do",
  "[ -d \"$d\" ] || continue",
  "for s in \"$d\"/*; do [ -S \"$s\" ] && echo \"__SOCKET__=$s\"; done",
  "done",
].join("; ");

function parseDetectScriptOutput(stdout) {
  const info = {
    version: { raw: "", major: 0, minor: 0, patch: "" },
    binary: "",
    sockets: [],
  };

  for (const line of stripAnsi(stdout).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("__TMUX_VERSION__=")) {
      info.version = parseTmuxVersionString(trimmed.slice("__TMUX_VERSION__=".length));
      continue;
    }
    if (trimmed.startsWith("__TMUX_BIN__=")) {
      info.binary = trimmed.slice("__TMUX_BIN__=".length).trim();
      continue;
    }
    if (trimmed.startsWith("__SOCKET__=")) {
      info.sockets.push(trimmed.slice("__SOCKET__=".length).trim());
    }
  }

  info.sockets = [...new Set(info.sockets.filter(Boolean))];
  return info;
}

function normalizeExecResult(result) {
  if (!result) return { success: false, error: "No exec result" };
  const stdout = stripAnsi(result.stdout || "");
  const stderr = stripAnsi(result.stderr || "");
  const combined = [stderr, stdout].filter(Boolean).join("\n").trim();
  if (!result.success && combined) {
    return {
      ...result,
      success: true,
      stdout: combined,
      stderr,
      code: result.code ?? 1,
    };
  }
  return { ...result, stdout: combined || stdout, stderr };
}

function buildTmuxInvocation(binary, socketPath, args) {
  const bin = binary || "tmux";
  const socketFlag = socketPath ? `-S ${shQuote(socketPath)} ` : "";
  return `${bin} ${socketFlag}${args}`.replace(/\s+/g, " ").trim();
}

// tmux diagnostics that must never be mistaken for session names — a stale
// socket makes `tmux ls 2>&1` print "error connecting to /tmp/tmux-0/default
// (No such file or directory)", which the bare-name fallback below would
// otherwise turn into a phantom session row.
const TMUX_DIAGNOSTIC_LINE = /^(error connecting to|no server running|no current client|can't find|lost server|server exited|failed to connect|protocol version mismatch|open terminal failed|invalid option|usage:|unknown command)/i;

function isTmuxDiagnosticLine(line) {
  return TMUX_DIAGNOSTIC_LINE.test(String(line || "").trim());
}

function parseListOutput(stdout) {
  const text = stripAnsi(stdout);
  const plain = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isTmuxDiagnosticLine(trimmed)) continue;
    const match = trimmed.match(/^([^:]+):\s*(\d+)\s+windows?\b/i);
    if (match) {
      plain.push({
        name: match[1].trim(),
        windows: Number(match[2]) || 0,
        attached: /\battached\b/i.test(trimmed),
        created: 0,
        activity: "",
        group: "",
      });
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length >= 4) {
      plain.push({
        name: parts[0].trim(),
        windows: Number(parts[1]) || 0,
        attached: parts[2] === "1",
        created: Number(parts[3]) || 0,
        activity: parts[4] || "",
        group: parts[5] || "",
      });
      continue;
    }
    if (parts.length === 1 && !trimmed.includes(":")) {
      plain.push({
        name: trimmed,
        windows: 0,
        attached: false,
        created: 0,
        activity: "",
        group: "",
      });
    }
  }
  return plain;
}

module.exports = {
  shQuote,
  wrapLoginShell,
  wrapShExec,
  stripAnsi,
  parseTmuxVersionString,
  getListSessionsFormat,
  TMUX_DETECT_SCRIPT,
  parseDetectScriptOutput,
  normalizeExecResult,
  buildTmuxInvocation,
  parseListOutput,
  isTmuxDiagnosticLine,
  TMUX_DIAGNOSTIC_LINE,
};
