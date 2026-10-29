/* eslint-disable no-undef */

const {
  shQuote,
  wrapLoginShell,
  wrapShExec,
  parseTmuxVersionString,
  getListSessionsFormat,
  TMUX_DETECT_SCRIPT,
  parseDetectScriptOutput,
  normalizeExecResult,
  buildTmuxInvocation,
  parseListOutput,
  isTmuxDiagnosticLine,
  MUX_PATH_AUGMENT,
} = require("./tmuxEnv.cjs");
const { execScopedOnSession } = require("./muxScope.cjs");

function shQuoteLocal(str) {
  return shQuote(str);
}

function tmuxTarget(sessionName, windowIndex, paneIndex) {
  const sessionRef = shQuoteLocal(sessionName);
  if (windowIndex === undefined || windowIndex === null) return sessionRef;
  const win = Number(windowIndex);
  if (paneIndex === undefined || paneIndex === null) return `${sessionRef}:${win}`;
  return `${sessionRef}:${win}.${Number(paneIndex)}`;
}

function sanitizeNewSessionName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

function parseTmuxSessions(stdout) {
  const sessions = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 4) continue;
    sessions.push({
      name: parts[0],
      windows: Number(parts[1]) || 0,
      attached: parts[2] === "1",
      created: Number(parts[3]) || 0,
      activity: parts[4] || "",
      group: parts[5] || "",
    });
  }
  return sessions;
}

/** Fallback parser for default `tmux list-sessions` / `tmux ls` output. */
function parseTmuxSessionsPlain(stdout) {
  const sessions = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([^:]+):\s*(\d+)\s+windows?\b/i);
    if (!match) continue;
    sessions.push({
      name: match[1].trim(),
      windows: Number(match[2]) || 0,
      attached: /\battached\b/i.test(trimmed),
      created: 0,
      activity: "",
      group: "",
    });
  }
  return sessions;
}

function parseTmuxSessionNames(stdout) {
  return (stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      windows: 0,
      attached: false,
      created: 0,
      activity: "",
      group: "",
    }));
}

function isNoTmuxServerMessage(text, code) {
  if (code !== 1) return false;
  const msg = String(text || "").toLowerCase();
  if (msg.includes("no server running")) return true;
  // Stale socket file: "error connecting to /tmp/tmux-0/default (No such file or directory)"
  return msg.includes("error connecting to") && msg.includes("no such file or directory");
}

/** Split tmux -F rows on real tabs or literal `\t` when remote printf fails. */
function splitTmuxFields(line) {
  const text = String(line || "");
  if (text.includes("\t")) return text.split("\t");
  if (text.includes("\\t")) return text.split("\\t");
  return [text];
}

/** Default `tmux list-windows` lines, e.g. `0: bash* (2 panes) [80x24]`. */
function parseTmuxWindowsPlain(stdout) {
  const windows = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isTmuxDiagnosticLine(trimmed)) continue;
    let match = trimmed.match(/^(\d+):\s*(.+?)(\*)?\s+\((\d+)\s+panes?\)/i);
    if (match) {
      windows.push({
        index: Number(match[1]),
        name: match[2].trim(),
        panes: Number(match[4]) || 0,
        active: match[3] === "*",
        layout: "",
      });
      continue;
    }
    match = trimmed.match(/^(\d+):\s*(.*?)(\*)?(?:\s+\[[^\]]+\]|\s*$)/);
    if (!match) continue;
    windows.push({
      index: Number(match[1]),
      name: match[2].trim(),
      panes: 0,
      active: match[3] === "*",
      layout: "",
    });
  }
  return windows;
}

function parseTmuxWindows(stdout) {
  const windows = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isTmuxDiagnosticLine(trimmed)) continue;
    const parts = splitTmuxFields(trimmed);
    if (parts.length < 4) continue;
    windows.push({
      index: Number(parts[0]),
      name: parts[1],
      panes: Number(parts[2]) || 0,
      active: parts[3] === "1",
      layout: parts[4] || "",
    });
  }
  if (windows.length > 0) return windows;
  return parseTmuxWindowsPlain(stdout);
}

function parseTmuxWindowsAll(stdout) {
  const windows = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isTmuxDiagnosticLine(trimmed)) continue;
    const parts = splitTmuxFields(trimmed);
    if (parts.length < 5) continue;
    windows.push({
      session: parts[0].trim(),
      index: Number(parts[1]),
      name: parts[2],
      panes: Number(parts[3]) || 0,
      active: parts[4] === "1",
      layout: parts[5] || "",
    });
  }
  return windows;
}

/** Plain `tmux list-windows -a` lines, e.g. `test-session: 0: bash* (2 panes)`. */
function parseTmuxWindowsAllPlain(stdout, sessionName) {
  const name = String(sessionName || "").trim();
  const windows = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isTmuxDiagnosticLine(trimmed)) continue;
    const match = trimmed.match(/^([^:]+):\s*(\d+):\s*(.+)$/);
    if (!match || match[1].trim() !== name) continue;
    const parsed = parseTmuxWindowsPlain(`${match[2]}: ${match[3]}`);
    if (parsed.length > 0) windows.push(parsed[0]);
  }
  return windows;
}

function filterWindowsForSession(rows, sessionName) {
  const name = String(sessionName || "").trim();
  return rows
    .filter((row) => row.session === name)
    .map(({ session, ...window }) => window);
}

function parseTmuxPaneRow(parts) {
  if (parts.length < 5) return null;
  return {
    index: Number(parts[0]),
    title: parts[1] || "",
    command: parts[2] || "",
    active: parts[3] === "1" || (parts.length >= 7 && parts[parts.length - 4] === "1"),
    pid: Number(parts[4]) || (parts.length >= 7 ? Number(parts[parts.length - 3]) : 0) || 0,
    width: Number(parts[parts.length >= 7 ? parts.length - 2 : 5]) || 0,
    height: Number(parts[parts.length >= 7 ? parts.length - 1 : 6]) || 0,
  };
}

/** Default `tmux list-panes` lines, e.g. `0: [80x24]` or `1: [80x24] (active)`. */
function parseTmuxPanesPlain(stdout) {
  const panes = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isTmuxDiagnosticLine(trimmed)) continue;
    const match = trimmed.match(/^(\d+):\s*\[(\d+)x(\d+)\]/);
    if (!match) continue;
    panes.push({
      index: Number(match[1]),
      title: "",
      command: "",
      active: /\bactive\b/i.test(trimmed) || trimmed.includes("*"),
      pid: 0,
      width: Number(match[2]) || 0,
      height: Number(match[3]) || 0,
    });
  }
  return panes;
}

function parseTmuxPanes(stdout) {
  const panes = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isTmuxDiagnosticLine(trimmed)) continue;
    const row = parseTmuxPaneRow(splitTmuxFields(trimmed));
    if (row) panes.push(row);
  }
  if (panes.length > 0) return panes;
  return parseTmuxPanesPlain(stdout);
}

function parseTmuxClients(stdout, sessionName) {
  const clients = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = splitTmuxFields(trimmed);
    if (parts.length < 4) continue;
    if (sessionName && parts[3] !== sessionName) continue;
    clients.push({
      name: parts[0],
      tty: parts[1],
      activity: parts[2],
      session: parts[3],
    });
  }
  return clients;
}

// Legacy export kept for tests — prefer getListSessionsFormat(version).
const TMUX_LIST_SESSIONS_FMT = getListSessionsFormat({ major: 3, minor: 0 });

const TMUX_LIST_WINDOWS_FMT = "#{window_index}\\t#{window_name}\\t#{window_panes}\\t#{window_active}\\t#{window_layout}";
const TMUX_LIST_ALL_WINDOWS_FMT = "#{session_name}\\t#{window_index}\\t#{window_name}\\t#{window_panes}\\t#{window_active}\\t#{window_layout}";
const TMUX_LIST_PANES_FMT = "#{pane_index}\\t#{pane_title}\\t#{pane_current_command}\\t#{pane_active}\\t#{pane_pid}\\t#{pane_width}\\t#{pane_height}";
const TMUX_LIST_CLIENTS_FMT = "#{client_name}\\t#{client_tty}\\t#{client_activity}\\t#{client_session}";

/**
 * tmux does NOT expand \t inside -F format strings — quoting the format
 * directly emits a literal backslash-t and the tab-split parsers see one
 * giant field. Route the format through printf on the remote side so the
 * separators become real tab characters.
 */
function tmuxFormatArg(format) {
  return `"$(printf '${format}')"`;
}

const SNAPSHOT_WINDOWS_MARKER = "__NC_SNAP_WINDOWS__";
const SNAPSHOT_CLIENTS_MARKER = "__NC_SNAP_CLIENTS__";

/**
 * One round trip for the whole tmux panel: sessions + all windows + clients
 * in a single exec, so a scoped (sudo) poll pays PAM auth once per cycle
 * instead of once per session record.
 */
function buildSnapshotScript(binary, socketPath, version) {
  const inv = (args) => buildTmuxInvocation(binary, socketPath, args);
  const sessionsFormat = getListSessionsFormat(version);
  const listSessionsCmd = sessionsFormat
    ? inv(`list-sessions -F ${tmuxFormatArg(sessionsFormat)} 2>&1`)
    : inv("list-sessions 2>&1");
  return [
    listSessionsCmd,
    `printf '%s\\n' '${SNAPSHOT_WINDOWS_MARKER}'`,
    inv(`list-windows -a -F ${tmuxFormatArg(TMUX_LIST_ALL_WINDOWS_FMT)} 2>&1`),
    `printf '%s\\n' '${SNAPSHOT_CLIENTS_MARKER}'`,
    inv(`list-clients -F ${tmuxFormatArg(TMUX_LIST_CLIENTS_FMT)} 2>&1`),
  ].join("; ");
}

function parseTmuxSnapshot(stdout) {
  const text = String(stdout || "");
  const windowsSplit = text.split(SNAPSHOT_WINDOWS_MARKER);
  const sessionsSection = windowsSplit[0] || "";
  const rest = windowsSplit.length > 1 ? windowsSplit.slice(1).join(SNAPSHOT_WINDOWS_MARKER) : "";
  const clientsSplit = rest.split(SNAPSHOT_CLIENTS_MARKER);
  const windowsSection = clientsSplit[0] || "";
  const clientsSection = clientsSplit.length > 1 ? clientsSplit.slice(1).join(SNAPSHOT_CLIENTS_MARKER) : "";

  const sessions = parseListOutput(sessionsSection);
  const windowsBySession = {};
  for (const row of parseTmuxWindowsAll(windowsSection)) {
    const { session, ...windowInfo } = row;
    if (!windowsBySession[session]) windowsBySession[session] = [];
    windowsBySession[session].push(windowInfo);
  }
  return {
    sessions,
    windowsBySession,
    clients: parseTmuxClients(clientsSection),
    // Markers prove the remote script actually ran (vs. a wrapper swallow).
    markersSeen: windowsSplit.length > 1 && clientsSplit.length > 1,
  };
}

function createTmuxOpsApi({ execOnSession }) {
  /** @type {Map<string, { version: object, binary: string, sockets: string[], detectedAt: number }>} */
  const envCache = new Map();
  const ENV_TTL_MS = 60_000;

  async function execShell(event, sessionId, script, timeoutMs = 8000, options = {}) {
    // retryOnEmptyOutput exists for READ commands where empty stdout means the
    // wrapper swallowed the output. Mutating commands (kill-session, send-keys,
    // split-window…) succeed silently — retrying them re-executes the mutation,
    // so they must pass retryOnEmptyOutput: false.
    const { retryOnEmptyOutput = true, scope = null } = options;
    if (scope?.user) {
      if (scope.directAsRoot) {
        // Root opens the target user's tmux socket directly: no sudo wrapper,
        // no PAM round trip per command.
        return normalizeExecResult(await execOnSession(event, sessionId, script, timeoutMs));
      }
      // Scoped (other-user) exec goes through sudo once — no wrapper retries,
      // and sudo auth failures surface their errorCode without being flipped
      // into a "successful" output result by normalizeExecResult.
      const scoped = await execScopedOnSession(execOnSession, event, sessionId, script, timeoutMs, scope);
      if (scoped?.errorCode) return scoped;
      return normalizeExecResult(scoped);
    }
    const attempts = [
      wrapShExec(script),
      wrapLoginShell(script),
      script,
    ];
    let last = { success: false, error: "No exec result", stdout: "", stderr: "" };
    for (const cmd of attempts) {
      last = normalizeExecResult(await execOnSession(event, sessionId, cmd, timeoutMs));
      if (last.success && (!retryOnEmptyOutput || String(last.stdout || "").trim())) return last;
    }
    return last;
  }

  function envCacheKey(sessionId, scope) {
    return scope?.user ? `${sessionId}::${scope.user}` : sessionId;
  }

  async function detectTmuxEnv(event, sessionId, force = false, scope = null) {
    const cacheKey = envCacheKey(sessionId, scope);
    const cached = envCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.detectedAt < ENV_TTL_MS) {
      return cached;
    }

    const env = {
      version: { raw: "", major: 0, minor: 0, patch: "" },
      binary: "tmux",
      sockets: [],
      preferredSocket: cached?.preferredSocket ?? null,
      detectedAt: Date.now(),
    };

    const probeOptions = scope?.user ? { scope } : {};

    const versionResult = await execShell(event, sessionId, `${MUX_PATH_AUGMENT}; tmux -V 2>&1`, 5000, probeOptions);
    if (versionResult.success && versionResult.stdout) {
      env.version = parseTmuxVersionString(versionResult.stdout);
    }

    const binResult = await execShell(event, sessionId, `${MUX_PATH_AUGMENT}; command -v tmux 2>/dev/null || which tmux 2>/dev/null`, 5000, probeOptions);
    if (binResult.success && binResult.stdout) {
      const bin = binResult.stdout.split("\n").map((l) => l.trim()).find(Boolean);
      if (bin) env.binary = bin;
    }

    if (scope?.user) {
      if (scope.directAsRoot && Number.isFinite(scope.targetUid)) {
        // Root fast path: enumerate the target user's live sockets directly.
        const scan = await execShell(
          event,
          sessionId,
          `for _nc_f in /tmp/tmux-${Math.floor(scope.targetUid)}/*; do [ -S "$_nc_f" ] && printf '%s\\n' "$_nc_f"; done; true`,
          5000,
          { scope },
        );
        if (scan.success && scan.stdout) {
          env.sockets = String(scan.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
        }
        envCache.set(cacheKey, env);
        return env;
      }
      // Socket dirs live under /tmp/tmux-<uid of the target user>; when scoped
      // we rely on that user's default socket instead of scanning our own uid.
      envCache.set(cacheKey, env);
      return env;
    }

    const socketResult = await execShell(
      event,
      sessionId,
      TMUX_DETECT_SCRIPT,
      8000,
    );
    if (socketResult.success) {
      const parsed = parseDetectScriptOutput(socketResult.stdout);
      if (parsed.version.raw) env.version = parsed.version;
      if (parsed.binary) env.binary = parsed.binary;
      env.sockets = parsed.sockets;
    }

    envCache.set(cacheKey, env);
    return env;
  }

  function buildSocketOrder(env) {
    const order = [];
    if (env.preferredSocket) order.push(env.preferredSocket);
    order.push(null);
    for (const socket of env.sockets || []) {
      if (socket && !order.includes(socket)) order.push(socket);
    }
    return order;
  }

  /**
   * Socket candidates for a scoped call. The root fast path must NOT include
   * the default (null) socket — that would hit root's own tmux server.
   */
  function scopedSocketOrder(env, scope) {
    if (!scope?.directAsRoot) return buildSocketOrder(env);
    const order = [];
    if (env.preferredSocket) order.push(env.preferredSocket);
    for (const socket of env.sockets || []) {
      if (socket && !order.includes(socket)) order.push(socket);
    }
    return order;
  }

  function rememberPreferredSocket(sessionId, env, socketPath, scope = null) {
    const next = {
      ...env,
      preferredSocket: socketPath ?? env.preferredSocket ?? null,
      detectedAt: Date.now(),
    };
    envCache.set(envCacheKey(sessionId, scope), next);
    return next;
  }

  async function queryTmuxRows(event, sessionId, buildArgVariants, parseRows) {
    const env = await detectTmuxEnv(event, sessionId);
    let lastError = "Cannot read tmux data";
    let lastOutput = "";
    const tried = [];

    for (const socketPath of buildSocketOrder(env)) {
      for (const args of buildArgVariants()) {
        const cmd = buildTmuxInvocation(env.binary, socketPath, args);
        tried.push(cmd);
        const result = await execShell(event, sessionId, cmd, 8000);
        const output = String(result.stdout || result.stderr || "").trim();
        if (output) lastOutput = output.slice(0, 500);
        if (isNoTmuxServerMessage(output, result.code)) continue;
        if (!result.success && !output) {
          lastError = (result.error || result.stderr || lastError).slice(0, 240);
          continue;
        }
        const rows = parseRows(output);
        if (rows.length > 0) {
          rememberPreferredSocket(sessionId, env, socketPath);
          return { success: true, rows };
        }
        if (output) lastError = output.slice(0, 240);
      }
    }

    return {
      success: false,
      error: lastError,
      debug: {
        lastOutput,
        tried: tried.slice(-8),
        sockets: buildSocketOrder(env),
      },
    };
  }

  async function execTmux(event, sessionId, args, timeoutMs = 8000, options = {}) {
    const scope = options.scope ?? null;
    const env = options.env || await detectTmuxEnv(event, sessionId, false, scope);
    const shellOptions = { retryOnEmptyOutput: options.retryOnEmptyOutput ?? true, scope };

    if (Object.prototype.hasOwnProperty.call(options, "socketPath")) {
      const cmd = buildTmuxInvocation(env.binary, options.socketPath, args);
      const result = await execShell(event, sessionId, cmd, timeoutMs, shellOptions);
      return { ...result, socketPath: options.socketPath ?? null, env };
    }

    const attempts = scopedSocketOrder(env, scope);
    if (attempts.length === 0) {
      return { success: false, error: "No tmux server socket for the target user", env };
    }
    let lastResult = null;
    for (const socketPathResolved of attempts) {
      const cmd = buildTmuxInvocation(env.binary, socketPathResolved, args);
      const result = await execShell(event, sessionId, cmd, timeoutMs, shellOptions);
      lastResult = result;
      if (result?.errorCode) return { ...result, env };
      if (!result.success) continue;

      const combined = `${result.stderr || ""}\n${result.stdout || ""}`;
      if (isNoTmuxServerMessage(combined, result.code)) continue;
      const hasOutput = Boolean((result.stdout || "").trim());
      if (hasOutput || result.code === 0) {
        if (hasOutput) rememberPreferredSocket(sessionId, env, socketPathResolved, scope);
        return { ...result, socketPath: socketPathResolved, env };
      }
    }

    return lastResult || { success: false, error: "tmux command failed" };
  }

  async function runTmux(event, sessionId, args, timeoutMs = 8000, scope = null) {
    // No empty-output retry here: runTmux carries every mutating tmux command,
    // and list-* commands routed through it may legitimately print nothing.
    const result = await execTmux(event, sessionId, args, timeoutMs, { retryOnEmptyOutput: false, scope });
    if (!result.success) return result;
    if (result.code !== 0 && result.code !== null && result.code !== undefined) {
      return {
        success: false,
        error: (result.stderr || result.stdout || "").trim() || `tmux exited with code ${result.code}`,
        stderr: result.stderr,
      };
    }
    return result;
  }

  async function listSessions(event, sessionId, scope = null) {
    // Scoped (sudo) execs pay full PAM auth per call — no tty timestamp reuse —
    // so honor the env TTL cache instead of force-probing on every poll.
    const env = await detectTmuxEnv(event, sessionId, !scope?.user, scope);
    const socketPaths = scopedSocketOrder(env, scope);
    if (socketPaths.length === 0) {
      // Root fast path with no live socket directory: the user has no server.
      return { success: true, sessions: [], tmuxVersion: env.version.raw || undefined };
    }
    let lastOutput = "";

    const buildListCommands = (binary, socketPath) => {
      const inv = (args) => buildTmuxInvocation(binary, socketPath, args);
      const cmds = [inv("list-sessions 2>&1"), inv("list-sessions")];
      const format = getListSessionsFormat(env.version);
      if (format) cmds.push(inv(`list-sessions -F ${tmuxFormatArg(format)}`));
      cmds.push(inv("list-sessions -F '#{session_name}'"));
      return cmds;
    };

    for (const socketPath of socketPaths) {
      for (const cmd of buildListCommands(env.binary, socketPath)) {
        const result = await execShell(event, sessionId, cmd, 8000, { scope });
        if (result?.errorCode) {
          return {
            success: false,
            error: result.error || "sudo authentication failed",
            errorCode: result.errorCode,
            tmuxVersion: env.version.raw || undefined,
          };
        }
        const output = String(result.stdout || result.stderr || "").trim();
        if (output) lastOutput = output;
        if (!result.success) continue;
        if (isNoTmuxServerMessage(output, result.code)) continue;

        const sessions = parseListOutput(output);
        if (sessions.length > 0) {
          rememberPreferredSocket(sessionId, env, socketPath, scope);
          return {
            success: true,
            sessions,
            tmuxVersion: env.version.raw || undefined,
          };
        }
      }
    }

    if (isNoTmuxServerMessage(lastOutput, 1)) {
      return { success: true, sessions: [], tmuxVersion: env.version.raw || undefined };
    }

    const diag = [
      env.version.raw || "tmux version unknown",
      env.binary ? `bin=${env.binary}` : null,
      env.sockets.length ? `sockets=${env.sockets.join(",")}` : "sockets=none",
      lastOutput ? `last=${lastOutput.slice(0, 240)}` : "last=empty",
    ].filter(Boolean).join("; ");

    return {
      success: false,
      error: `Cannot list tmux sessions (${diag})`,
      tmuxVersion: env.version.raw || undefined,
    };
  }

  async function createSession(event, payload) {
    const { sessionId, name, command, scope } = payload || {};
    if (!sessionId || !name) return { success: false, error: "Missing sessionId or name" };
    const safeName = sanitizeNewSessionName(name);
    if (!safeName) return { success: false, error: "Invalid session name" };

    envCache.delete(envCacheKey(sessionId, scope));
    const result = await runTmux(event, sessionId, `new-session -d -s ${shQuoteLocal(safeName)}`, 8000, scope);
    if (!result.success) return { success: false, error: result.error || result.stderr, errorCode: result.errorCode };
    const cmd = String(command || "").trim();
    if (cmd) {
      const sendResult = await runTmux(
        event,
        sessionId,
        `send-keys -t ${shQuoteLocal(safeName)} ${shQuoteLocal(cmd)} C-m`,
        8000,
        scope,
      );
      if (!sendResult.success) {
        return { success: false, error: sendResult.error || sendResult.stderr, errorCode: sendResult.errorCode };
      }
    }
    envCache.delete(envCacheKey(sessionId, scope));
    return { success: true, name: safeName };
  }

  async function listWindows(event, payload) {
    const { sessionId, sessionName, scope } = payload || {};
    if (!sessionId || !sessionName) return { success: false, error: "Missing params" };
    const name = String(sessionName).trim();
    const target = tmuxTarget(name);
    const targetExact = tmuxTarget(`=${name}`);

    // Mirror listSessions: honor the env cache for scoped calls (sudo PAM tax)
    // and walk the same socket order.
    const env = await detectTmuxEnv(event, sessionId, !scope?.user, scope);
    const socketPaths = scopedSocketOrder(env, scope);
    if (socketPaths.length === 0) return { success: true, windows: [] };
    let lastOutput = "";
    let lastError = "Cannot list tmux windows";
    const tried = [];

    const buildCommands = (binary, socketPath) => {
      const inv = (args) => buildTmuxInvocation(binary, socketPath, args);
      return [
        inv(`list-windows -t ${target} -F ${tmuxFormatArg(TMUX_LIST_WINDOWS_FMT)} 2>&1`),
        inv(`list-windows -t ${target} 2>&1`),
        inv(`list-windows -t ${targetExact} -F ${tmuxFormatArg(TMUX_LIST_WINDOWS_FMT)} 2>&1`),
        inv(`list-windows -t ${targetExact} 2>&1`),
        inv(`list-windows -a -F ${tmuxFormatArg(TMUX_LIST_ALL_WINDOWS_FMT)} 2>&1`),
        inv(`list-windows -a 2>&1`),
        inv(`list-windows -t ${target} -F ${tmuxFormatArg(TMUX_LIST_WINDOWS_FMT)}`),
        inv(`list-windows -t ${target}`),
      ];
    };

    for (const socketPath of socketPaths) {
      for (const cmd of buildCommands(env.binary, socketPath)) {
        tried.push(cmd);
        const result = await execShell(event, sessionId, cmd, 8000, { scope });
        if (result?.errorCode) {
          return {
            success: false,
            error: result.error || "sudo authentication failed",
            errorCode: result.errorCode,
            debug: { lastOutput, tried: tried.slice(-8), sockets: socketPaths },
          };
        }
        const output = String(result.stdout || result.stderr || "").trim();
        if (output) lastOutput = output.slice(0, 500);
        if (!result.success && !output) {
          lastError = (result.error || result.stderr || lastError).slice(0, 240);
          continue;
        }
        if (isNoTmuxServerMessage(output, result.code)) continue;

        let windows = [];
        if (cmd.includes("list-windows -a")) {
          const formatted = parseTmuxWindowsAll(output);
          windows = formatted.length > 0
            ? filterWindowsForSession(formatted, name)
            : parseTmuxWindowsAllPlain(output, name);
        } else {
          windows = parseTmuxWindows(output);
        }

        if (windows.length > 0) {
          rememberPreferredSocket(sessionId, env, socketPath, scope);
          return { success: true, windows };
        }
        if (output) lastError = output.slice(0, 240);
      }
    }

    return {
      success: false,
      error: lastError,
      debug: { lastOutput, tried: tried.slice(-8), sockets: socketPaths },
    };
  }

  async function listPanes(event, payload) {
    const { sessionId, sessionName, windowIndex, scope } = payload || {};
    if (!sessionId || !sessionName || windowIndex === undefined) {
      return { success: false, error: "Missing params" };
    }
    const name = String(sessionName).trim();
    const target = tmuxTarget(name, windowIndex);

    const env = await detectTmuxEnv(event, sessionId, !scope?.user, scope);
    const socketPaths = scopedSocketOrder(env, scope);
    if (socketPaths.length === 0) return { success: true, panes: [] };
    let lastOutput = "";
    let lastError = "Cannot list tmux panes";
    const tried = [];

    const buildCommands = (binary, socketPath) => {
      const inv = (args) => buildTmuxInvocation(binary, socketPath, args);
      return [
        inv(`list-panes -t ${target} -F ${tmuxFormatArg(TMUX_LIST_PANES_FMT)} 2>&1`),
        inv(`list-panes -t ${target} 2>&1`),
        inv(`list-panes -t ${target} -F ${tmuxFormatArg(TMUX_LIST_PANES_FMT)}`),
        inv(`list-panes -t ${target}`),
      ];
    };

    for (const socketPath of socketPaths) {
      for (const cmd of buildCommands(env.binary, socketPath)) {
        tried.push(cmd);
        const result = await execShell(event, sessionId, cmd, 8000, { scope });
        if (result?.errorCode) {
          return {
            success: false,
            error: result.error || "sudo authentication failed",
            errorCode: result.errorCode,
            debug: { lastOutput, tried: tried.slice(-8), sockets: socketPaths },
          };
        }
        const output = String(result.stdout || result.stderr || "").trim();
        if (output) lastOutput = output.slice(0, 500);
        if (!result.success && !output) {
          lastError = (result.error || result.stderr || lastError).slice(0, 240);
          continue;
        }
        if (isNoTmuxServerMessage(output, result.code)) continue;

        const panes = parseTmuxPanes(output);
        if (panes.length > 0) {
          rememberPreferredSocket(sessionId, env, socketPath, scope);
          return { success: true, panes };
        }
        if (output) lastError = output.slice(0, 240);
      }
    }

    return {
      success: false,
      error: lastError,
      debug: { lastOutput, tried: tried.slice(-8), sockets: socketPaths },
    };
  }

  async function listClients(event, payload) {
    const { sessionId, sessionName, scope } = payload || {};
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const result = await runTmux(
      event,
      sessionId,
      `list-clients -F ${tmuxFormatArg(TMUX_LIST_CLIENTS_FMT)}`,
      8000,
      scope,
    );
    if (!result.success) return { success: false, error: result.error, errorCode: result.errorCode };
    return {
      success: true,
      clients: parseTmuxClients(result.stdout, sessionName || undefined),
    };
  }

  async function listTmuxSnapshot(event, sessionId, scope = null) {
    const env = await detectTmuxEnv(event, sessionId, !scope?.user, scope);
    const socketPaths = scopedSocketOrder(env, scope);
    const empty = {
      success: true,
      sessions: [],
      windowsBySession: {},
      clients: [],
      tmuxVersion: env.version.raw || undefined,
    };
    if (socketPaths.length === 0) return empty;

    let lastOutput = "";
    for (const socketPath of socketPaths) {
      const script = buildSnapshotScript(env.binary, socketPath, env.version);
      const result = await execShell(event, sessionId, script, 10000, { scope });
      if (result?.errorCode) {
        return {
          success: false,
          error: result.error || "sudo authentication failed",
          errorCode: result.errorCode,
          tmuxVersion: env.version.raw || undefined,
        };
      }
      const output = String(result.stdout || result.stderr || "").trim();
      if (output) lastOutput = output;
      if (!result.success && !output) continue;
      // No server on this socket: tmux prints the error before the markers.
      const head = output.split(SNAPSHOT_WINDOWS_MARKER)[0] || "";
      if (isNoTmuxServerMessage(head, result.code) || isNoTmuxServerMessage(head, 1)) {
        return empty;
      }
      const snapshot = parseTmuxSnapshot(result.stdout || "");
      if (!snapshot.markersSeen) continue;
      if (output) rememberPreferredSocket(sessionId, env, socketPath, scope);
      return {
        success: true,
        sessions: snapshot.sessions,
        windowsBySession: snapshot.windowsBySession,
        clients: snapshot.clients,
        tmuxVersion: env.version.raw || undefined,
      };
    }

    return {
      success: false,
      error: `Cannot snapshot tmux sessions (${lastOutput ? lastOutput.slice(0, 240) : "no output"})`,
      tmuxVersion: env.version.raw || undefined,
    };
  }

  async function tmuxAction(event, payload) {
    const { sessionId, action, scope } = payload || {};
    if (!sessionId || !action) return { success: false, error: "Missing sessionId or action" };
    const run = (args) => runTmux(event, sessionId, args, 8000, scope);

    switch (action) {
      case "killSession": {
        const { sessionName } = payload;
        if (!sessionName) return { success: false, error: "Missing sessionName" };
        return run(`kill-session -t ${tmuxTarget(sessionName)}`);
      }
      case "renameSession": {
        const { sessionName, newName } = payload;
        const next = sanitizeNewSessionName(newName);
        if (!sessionName || !next) return { success: false, error: "Missing params" };
        return run(`rename-session -t ${tmuxTarget(sessionName)} ${shQuote(next)}`);
      }
      case "detachSession": {
        const { sessionName } = payload;
        if (!sessionName) return { success: false, error: "Missing sessionName" };
        return run(`detach-client -s ${tmuxTarget(sessionName)}`);
      }
      case "createWindow": {
        const { sessionName, windowName } = payload;
        if (!sessionName) return { success: false, error: "Missing sessionName" };
        const nameArg = windowName && String(windowName).trim()
          ? ` -n ${shQuote(String(windowName).trim().slice(0, 64))}`
          : "";
        return run(`new-window -t ${tmuxTarget(sessionName)}${nameArg}`);
      }
      case "killWindow": {
        const { sessionName, windowIndex } = payload;
        if (!sessionName || windowIndex === undefined) return { success: false, error: "Missing params" };
        return run(`kill-window -t ${tmuxTarget(sessionName, windowIndex)}`);
      }
      case "renameWindow": {
        const { sessionName, windowIndex, newName } = payload;
        const next = String(newName || "").trim().slice(0, 64);
        if (!sessionName || windowIndex === undefined || !next) {
          return { success: false, error: "Missing params" };
        }
        return run(`rename-window -t ${tmuxTarget(sessionName, windowIndex)} ${shQuote(next)}`);
      }
      case "killPane": {
        const { sessionName, windowIndex, paneIndex } = payload;
        if (!sessionName || windowIndex === undefined || paneIndex === undefined) {
          return { success: false, error: "Missing params" };
        }
        return run(`kill-pane -t ${tmuxTarget(sessionName, windowIndex, paneIndex)}`);
      }
      case "splitPane": {
        const { sessionName, windowIndex, paneIndex, direction } = payload;
        if (!sessionName || windowIndex === undefined) {
          return { success: false, error: "Missing params" };
        }
        const flag = direction === "vertical" ? "-v" : "-h";
        const target = paneIndex !== undefined && paneIndex !== null
          ? tmuxTarget(sessionName, windowIndex, paneIndex)
          : tmuxTarget(sessionName, windowIndex);
        return run(`split-window -t ${target} ${flag}`);
      }
      case "sendKeys": {
        const { sessionName, windowIndex, paneIndex, keys, enter } = payload;
        if (!sessionName || windowIndex === undefined || paneIndex === undefined) {
          return { success: false, error: "Missing params" };
        }
        const keyText = String(keys ?? "");
        const enterSuffix = enter !== false ? " C-m" : "";
        return run(
          `send-keys -t ${tmuxTarget(sessionName, windowIndex, paneIndex)} ${shQuote(keyText)}${enterSuffix}`,
        );
      }
      case "selectWindow": {
        const { sessionName, windowIndex } = payload;
        if (!sessionName || windowIndex === undefined) return { success: false, error: "Missing params" };
        return run(`select-window -t ${tmuxTarget(sessionName, windowIndex)}`);
      }
      case "killServer": {
        return run("kill-server");
      }
      default:
        return { success: false, error: `Unknown tmux action: ${action}` };
    }
  }

  return {
    listSessions,
    listTmuxSnapshot,
    createSession,
    listWindows,
    listPanes,
    listClients,
    tmuxAction,
    shQuote,
    tmuxTarget,
  };
}

module.exports = {
  createTmuxOpsApi,
  shQuote,
  tmuxTarget,
  parseTmuxSnapshot,
  parseTmuxSessions,
  parseTmuxSessionsPlain,
  parseTmuxSessionNames,
  parseTmuxWindows,
  parseTmuxWindowsPlain,
  parseTmuxWindowsAll,
  parseTmuxWindowsAllPlain,
  filterWindowsForSession,
  splitTmuxFields,
  parseTmuxPaneRow,
  parseTmuxPanesPlain,
  parseTmuxPanes,
  parseTmuxClients,
  isNoTmuxServerMessage,
};
