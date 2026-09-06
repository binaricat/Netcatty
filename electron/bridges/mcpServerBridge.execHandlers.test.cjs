"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createBackgroundJobApi } = require("./mcpServerBridge/backgroundJobs.cjs");
const { createExecHandlerApi } = require("./mcpServerBridge/execHandlers.cjs");
const { PROBE_OUTPUT_MARKER } = require("./ai/sessionShellKind.cjs");
const {
  checkBlocklistForShell,
  resolveSessionBlocklistShellKind,
} = require("./ai/commandSafety.cjs");

class FakePty extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(data) {
    this.writes.push(String(data));
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferredShellProbeConn(stdout = `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`) {
  let execCallback = null;
  const conn = {
    exec(_command, callback) {
      execCallback = callback;
    },
  };
  return {
    conn,
    release() {
      assert.equal(typeof execCallback, "function", "probe should be waiting for ssh exec callback");
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => stream.emit("close");
      execCallback(null, stream);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from(stdout));
        stream.emit("close");
      });
    },
  };
}

function createExecHandlerTestContext({ sessions, backgroundJobs }) {
  const ctx = {
    sessions,
    backgroundJobs,
    activeSessionSftpOps: new Map(),
    closingTerminalSessions: new Map(),
    activeSessionExecutions: new Map(),
    activePtyExecs: new Map(),
    crypto,
    sftpBridge: {},
    BACKGROUND_JOB_RETENTION_MS: 10 * 60 * 1000,
    DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS: 30 * 1000,
    MAX_BACKGROUND_JOB_OUTPUT_CHARS: 256 * 1024,
    SESSION_CLOSE_CLEANUP_TIMEOUT_MS: 20,
    DEFAULT_BACKGROUND_JOB_TIMEOUT_MS: 60 * 60 * 1000,
    commandTimeoutMs: 5000,
    activeSftpOpSeq: 0,
    debugLog() {},
    getSessionMeta() {
      return {};
    },
    checkCommandSafetyForShell() {
      return { blocked: false };
    },
    resolveSessionBlocklistShellKind() {
      return "";
    },
    beginChatExecution() {
      return { ok: true, release() {} };
    },
    getFreshIdlePrompt() {
      return "";
    },
    echoCommandToSession() {},
    validateSessionScope() {
      return null;
    },
  };
  Object.assign(ctx, createBackgroundJobApi(ctx));
  return ctx;
}

test("SFTP cancellation targets one terminal session and waits for cleanup", async () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  const events = [];
  ctx.registerSftpOp("chat-1", "session-1", async () => {
    await nextTick();
    events.push("session-1-clean");
  });
  ctx.registerSftpOp("chat-2", "session-1", () => {
    events.push("session-1-other-scope-clean");
  });
  ctx.registerSftpOp("chat-1", "session-2", () => {
    events.push("session-2-clean");
  });

  await ctx.cancelSftpOpsForTerminalSession("session-1");

  assert.deepEqual(events, ["session-1-other-scope-clean", "session-1-clean"]);
  assert.equal(ctx.activeSessionSftpOps.size, 1);
});

test("terminal close does not hang on stalled SFTP cleanup", async () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  ctx.activeSessionSftpOps.set("sftp-stalled", {
    chatSessionId: "chat-1",
    sessionId: "session-1",
    cancel: () => new Promise(() => {}),
  });

  const startedAt = Date.now();
  await ctx.cancelSftpOpsForTerminalSession("session-1");

  assert.ok(Date.now() - startedAt < 200, "session close cleanup should be bounded");
  assert.equal(ctx.activeSessionSftpOps.size, 0);
});

test("SFTP operations that start while a terminal is closing are cancelled immediately", () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  let cancelled = false;
  ctx.beginTerminalSessionClose("session-1");

  ctx.registerSftpOp("chat-1", "session-1", () => {
    cancelled = true;
  });

  assert.equal(cancelled, true);
  assert.equal(ctx.activeSessionSftpOps.size, 0);
  ctx.endTerminalSessionClose("session-1");
});

test("overlapping closes keep SFTP blocked until the last close finishes", () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  ctx.beginTerminalSessionClose("session-1");
  ctx.beginTerminalSessionClose("session-1");
  ctx.endTerminalSessionClose("session-1");

  let cancelled = false;
  ctx.registerSftpOp("chat-1", "session-1", () => {
    cancelled = true;
  });
  assert.equal(cancelled, true);

  ctx.endTerminalSessionClose("session-1");
  ctx.registerSftpOp("chat-1", "session-1", () => {});
  assert.equal(ctx.activeSessionSftpOps.size, 1);
});

test("terminal close cancels and removes background jobs for that terminal", async () => {
  let cancelCount = 0;
  let settleJob;
  const resultPromise = new Promise((resolve) => {
    settleJob = resolve;
  });
  const backgroundJobs = new Map([
    ["job-1", {
      sessionId: "session-1",
      status: "running",
      handle: {
        cancel: () => { cancelCount += 1; },
        resultPromise,
      },
    }],
    ["job-2", { sessionId: "session-2", status: "running", handle: {} }],
  ]);
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs });
  ctx.activeSessionExecutions.set("session-1", { kind: "job", token: "token-1" });

  ctx.cancelBackgroundJobsForTerminalSession("session-1");
  assert.equal(cancelCount, 1);
  assert.equal(backgroundJobs.get("job-1").status, "stopping");

  const settling = ctx.settleBackgroundJobsForTerminalSession("session-1");
  assert.equal(backgroundJobs.has("job-1"), true);
  settleJob({ error: "Cancelled" });
  await settling;

  assert.equal(backgroundJobs.has("job-1"), false);
  assert.equal(backgroundJobs.has("job-2"), true);
  assert.equal(ctx.activeSessionExecutions.has("session-1"), false);
});

test("MCP terminal_start chat cancel during shellKind probe aborts before PTY write", async () => {
  const pty = new FakePty();
  const deferred = createDeferredShellProbeConn();
  const sessions = new Map([
    ["ssh-fish", {
      protocol: "ssh",
      stream: pty,
      conn: deferred.conn,
    }],
  ]);
  const backgroundJobs = new Map();
  const ctx = createExecHandlerTestContext({ sessions, backgroundJobs });
  const api = createExecHandlerApi(ctx);

  const pendingStart = api.handleJobStart({
    sessionId: "ssh-fish",
    command: "sleep 999",
    chatSessionId: "chat-cancel-probe",
  });
  await nextTick();

  assert.equal(backgroundJobs.size, 1, "job should be registered while probe is pending");
  ctx.cancelBackgroundJobsForSession("chat-cancel-probe");

  deferred.release();
  const started = await pendingStart;

  assert.equal(started.ok, false);
  assert.equal(started.error, "Cancelled");
  assert.equal(started.status, "cancelled");
  assert.equal(
    pty.writes.filter((entry) => entry.includes("__NCMCP_")).length,
    0,
    "cancelled pending start must not type a wrapper into the PTY",
  );
  const [job] = backgroundJobs.values();
  assert.equal(job.status, "cancelled");
  assert.equal(job.pendingShellProbe, false);
  assert.equal(ctx.activeSessionExecutions.size, 0);
});

test("MCP exec probes an unclassified PowerShell session before the authoritative check", async () => {
  const pty = new FakePty();
  const session = {
    protocol: "ssh",
    stream: pty,
    shellKind: "",
    remoteSshVersion: "OpenSSH_for_Windows_9.5",
    lastIdlePrompt: "custom% ",
    _promptTrackTail: "custom prompt\r\ncustom% ",
    _shellKindExecProbe: async () => (
      "DefaultShell    REG_SZ    C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n"
    ),
  };
  const ctx = createExecHandlerTestContext({
    sessions: new Map([["ssh-powershell", session]]),
    backgroundJobs: new Map(),
  });
  ctx.checkCommandSafetyForShell = checkBlocklistForShell;
  ctx.resolveSessionBlocklistShellKind = resolveSessionBlocklistShellKind;
  ctx.execViaPty = async () => ({ ok: true, stdout: "ok", stderr: "", exitCode: 0 });
  const api = createExecHandlerApi(ctx);

  const result = await api.handleExec({
    sessionId: "ssh-powershell",
    command: 'Write-Host "now: $(Get-Date)"',
    chatSessionId: "chat-powershell",
  });

  assert.equal(result.ok, true);
  assert.equal(session._loginShellKind, "powershell");
});
