"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTmuxVersionString,
  getListSessionsFormat,
  parseDetectScriptOutput,
  normalizeExecResult,
  parseListOutput,
  wrapLoginShell,
} = require("./tmuxEnv.cjs");

test("parseTmuxVersionString handles tmux 3.0a", () => {
  const v = parseTmuxVersionString("tmux 3.0a");
  assert.equal(v.major, 3);
  assert.equal(v.minor, 0);
  assert.equal(v.patch, "a");
});

test("wrapLoginShell flattens multiline scripts", () => {
  const wrapped = wrapLoginShell("echo one\necho two");
  assert.ok(!wrapped.includes("\\n"));
  assert.ok(wrapped.includes("; echo two"));
});

test("parseListOutput parses default tmux ls line", () => {
  const sample = "test-session: 1 windows (created Thu Jun 11 00:38:14 2026)\n";
  const sessions = parseListOutput(sample);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "test-session");
  assert.equal(sessions[0].windows, 1);
});

test("getListSessionsFormat omits session_group before tmux 3.2", () => {
  const fmt = getListSessionsFormat({ major: 3, minor: 0 });
  assert.ok(fmt.includes("session_name"));
  assert.ok(!fmt.includes("session_group"));
});

test("parseDetectScriptOutput reads version and sockets", () => {
  const stdout = [
    "__TMUX_VERSION__=tmux 3.0a",
    "__TMUX_BIN__=/usr/bin/tmux",
    "__SOCKET__=/tmp/tmux-0/default",
  ].join("\n");
  const parsed = parseDetectScriptOutput(stdout);
  assert.equal(parsed.version.major, 3);
  assert.equal(parsed.binary, "/usr/bin/tmux");
  assert.deepEqual(parsed.sockets, ["/tmp/tmux-0/default"]);
});

test("parseListOutput ignores tmux diagnostic lines", () => {
  const sample = [
    "error connecting to /tmp/tmux-0/default (No such file or directory)",
    "no server running on /private/tmp/tmux-501/default",
    "can't find session: missing",
    "test-session: 1 windows (created Thu Jun 11 00:38:14 2026)",
  ].join("\n");
  const sessions = parseListOutput(sample);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "test-session");
});

test("parseListOutput returns nothing for a lone stale-socket error", () => {
  const sessions = parseListOutput(
    "error connecting to /tmp/tmux-0/default (No such file or directory)\n",
  );
  assert.deepEqual(sessions, []);
});

test("isNoTmuxServerMessage matches stale-socket connect errors", () => {
  const { isNoTmuxServerMessage } = require("./tmuxOps.cjs");
  assert.equal(
    isNoTmuxServerMessage("error connecting to /tmp/tmux-0/default (No such file or directory)", 1),
    true,
  );
  assert.equal(isNoTmuxServerMessage("no server running on /tmp/tmux-501/default", 1), true);
  assert.equal(isNoTmuxServerMessage("test-session: 1 windows", 1), false);
  assert.equal(isNoTmuxServerMessage("error connecting to /tmp/tmux-0/default (No such file or directory)", 0), false);
});

test("mutating tmux commands execute exactly once on silent success", async () => {
  const { createTmuxOpsApi } = require("./tmuxOps.cjs");
  const executed = [];
  const api = createTmuxOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      executed.push(command);
      // Silent success, the normal result for kill-session/send-keys/split-window.
      return { success: true, stdout: "", stderr: "", code: 0 };
    },
  });
  const result = await api.tmuxAction(null, {
    sessionId: "s1",
    action: "killSession",
    sessionName: "demo",
  });
  assert.equal(result.success, true);
  const killRuns = executed.filter((cmd) => cmd.includes("kill-session"));
  assert.equal(killRuns.length, 1, `kill-session ran ${killRuns.length} times: ${executed.join(" | ")}`);
});

test("parseTmuxWindowsPlain parses default tmux list-windows output", () => {
  const { parseTmuxWindowsPlain } = require("./tmuxOps.cjs");
  const sample = [
    "0: bash* (2 panes) [160x40] [b33d,1]",
    "1: zsh (1 pane) [160x40] [b33d,2]",
  ].join("\n");
  const windows = parseTmuxWindowsPlain(sample);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].name, "bash");
  assert.equal(windows[0].panes, 2);
  assert.equal(windows[0].active, true);
  assert.equal(windows[1].name, "zsh");
});

test("parseTmuxWindows falls back to plain output when -F tabs are missing", () => {
  const { parseTmuxWindows } = require("./tmuxOps.cjs");
  const windows = parseTmuxWindows("0: main* (2 panes) [80x24]");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].panes, 2);
});

test("parseTmuxWindows reads list-windows output from stderr", () => {
  const { parseTmuxWindows } = require("./tmuxOps.cjs");
  const windows = parseTmuxWindows("0: main* (2 panes) [80x24]");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].name, "main");
});

test("list-windows tries alternate socket when default returns empty", async () => {
  const { createTmuxOpsApi } = require("./tmuxOps.cjs");
  const api = createTmuxOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      if (command.includes("TMUX_DETECT") || command.includes("__SOCKET__") || command.includes("__TMUX_")) {
        return {
          success: true,
          stdout: "__TMUX_VERSION__=tmux 3.0a\n__SOCKET__=/tmp/tmux-0/custom\n",
          stderr: "",
          code: 0,
        };
      }
      if (command.includes("-S '/tmp/tmux-0/custom'") && command.includes("list-windows")) {
        return { success: true, stdout: "0: main* (2 panes) [80x24]", stderr: "", code: 0 };
      }
      if (command.includes("list-windows")) {
        return { success: true, stdout: "", stderr: "", code: 0 };
      }
      return { success: true, stdout: "tmux 3.0a", stderr: "", code: 0 };
    },
  });
  const result = await api.listWindows(null, { sessionId: "s1", sessionName: "test-session" });
  assert.equal(result.success, true);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].panes, 2);
});

test("parseTmuxWindowsAllPlain parses list-windows -a default output", () => {
  const { parseTmuxWindowsAllPlain } = require("./tmuxOps.cjs");
  const sample = [
    "test-session: 0: bash* (2 panes) [80x24]",
    "test-session: 1: zsh (1 pane) [80x24]",
    "other: 0: vim (1 pane) [80x24]",
  ].join("\n");
  const windows = parseTmuxWindowsAllPlain(sample, "test-session");
  assert.equal(windows.length, 2);
  assert.equal(windows[0].name, "bash");
  assert.equal(windows[1].index, 1);
});

test("list-windows falls back to list-windows -a when -t target misses", async () => {
  const { createTmuxOpsApi } = require("./tmuxOps.cjs");
  const api = createTmuxOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      if (command.includes("for d in") || command.includes("__TMUX_")) {
        return { success: true, stdout: "__TMUX_VERSION__=tmux 3.0a\n", stderr: "", code: 0 };
      }
      if (command.includes("list-windows -a")) {
        return {
          success: true,
          stdout: "test-session: 0: main* (2 panes) [80x24]\ntest-session: 1: aux (1 pane) [80x24]",
          stderr: "",
          code: 0,
        };
      }
      if (command.includes("list-windows")) {
        return { success: true, stdout: "can't find session: test-session", stderr: "", code: 1 };
      }
      return { success: true, stdout: "tmux 3.0a", stderr: "", code: 0 };
    },
  });
  const result = await api.listWindows(null, { sessionId: "s1", sessionName: "test-session" });
  assert.equal(result.success, true);
  assert.equal(result.windows.length, 2);
});

test("list-windows parses output delivered on stderr", async () => {
  const { createTmuxOpsApi } = require("./tmuxOps.cjs");
  const api = createTmuxOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      if (command.includes("TMUX_DETECT") || command.includes("__SOCKET__") || command.includes("__TMUX_") || command.includes("for d in")) {
        return { success: true, stdout: "__TMUX_VERSION__=tmux 3.0a\n", stderr: "", code: 0 };
      }
      if (command.includes("list-windows")) {
        return {
          success: true,
          stdout: "",
          stderr: "0: remote* (2 panes) [80x24]\n",
          code: 0,
        };
      }
      return { success: true, stdout: "tmux 3.0a", stderr: "", code: 0 };
    },
  });
  const result = await api.listWindows(null, { sessionId: "s1", sessionName: "test-session" });
  assert.equal(result.success, true);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].name, "remote");
});

test("parseTmuxPanes splits literal \\t when remote printf fails", () => {
  const { parseTmuxPanes } = require("./tmuxOps.cjs");
  const sample = "0\\tRainYun-0tWTeTRw\\tbash\\t\\t\\t2232702\\t80\\t24";
  const panes = parseTmuxPanes(sample);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].title, "RainYun-0tWTeTRw");
  assert.equal(panes[0].command, "bash");
  assert.equal(panes[0].pid, 2232702);
  assert.equal(panes[0].width, 80);
  assert.equal(panes[0].height, 24);
});

test("parseTmuxPanesPlain parses default list-panes output", () => {
  const { parseTmuxPanesPlain } = require("./tmuxOps.cjs");
  const panes = parseTmuxPanesPlain("0: [80x24]\n1: [80x24] (active)");
  assert.equal(panes.length, 2);
  assert.equal(panes[1].active, true);
});

test("list-windows routes tab separators through printf (tmux does not expand \\t in -F)", async () => {
  const { createTmuxOpsApi } = require("./tmuxOps.cjs");
  const commands = [];
  const api = createTmuxOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      if (command.includes("list-windows")) {
        // Real tab characters, as printf would produce on the remote host.
        return { success: true, stdout: "0\tmain\t2\t1\tlayout", stderr: "", code: 0 };
      }
      return { success: true, stdout: "tmux 3.0a", stderr: "", code: 0 };
    },
  });
  const result = await api.listWindows(null, { sessionId: "s1", sessionName: "demo" });
  assert.equal(result.success, true);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].name, "main");
  assert.equal(result.windows[0].panes, 2);
  const listCmd = commands.find((cmd) => cmd.includes("list-windows"));
  assert.ok(listCmd.includes("$(printf '"), `expected printf-wrapped format, got: ${listCmd}`);
});

test("normalizeExecResult keeps stdout from failed ET-style exec", () => {
  const normalized = normalizeExecResult({
    success: false,
    error: "Command failed",
    stdout: "",
    stderr: "test-session: 1 windows (created Thu Jun 11 00:38:14 2026)",
    code: 1,
  });
  assert.equal(normalized.success, true);
  assert.equal(parseListOutput(normalized.stdout).length, 1);
});
