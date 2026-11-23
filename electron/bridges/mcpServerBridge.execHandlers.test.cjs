"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createBackgroundJobApi } = require("./mcpServerBridge/backgroundJobs.cjs");
const { createExecHandlerApi } = require("./mcpServerBridge/execHandlers.cjs");
const { PROBE_OUTPUT_MARKER } = require("./ai/sessionShellKind.cjs");
const { createAiPrivacyService } = require("../shared/aiPrivacyService.cjs");
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

for (const route of ["pty", "channel", "job"]) {
  test(`MCP ${route} rechecks privacy after shell probing before command handoff`, async () => {
    const privacy = createAiPrivacyService();
    privacy.checkSession("chat");
    const deferred = createDeferredShellProbeConn();
    const session = { protocol: "ssh", conn: deferred.conn };
    if (route !== "channel") session.stream = new FakePty();
    const ctx = createExecHandlerTestContext({
      sessions: new Map([["ssh", session]]),
      backgroundJobs: new Map(),
    });
    const effects = [];
    ctx.execViaPty = (...args) => { effects.push(args); return { ok: true }; };
    ctx.execViaChannel = (...args) => { effects.push(args); return { ok: true }; };
    ctx.startPtyJob = (...args) => { effects.push(args); return { resultPromise: Promise.resolve({}) }; };
    const api = createExecHandlerApi(ctx);
    const handler = route === "job" ? api.handleJobStart : api.handleExec;
    const pending = handler({
      sessionId: "ssh", command: "echo synthetic", chatSessionId: "chat",
    }, { beforeExecute: () => privacy.restore("chat", []) });
    await nextTick();
    privacy.configure({ enabled: true });
    deferred.release();
    const result = await Promise.resolve(pending).catch((error) => ({ ok: false, error: error.message }));
    assert.equal(result.ok, false);
    assert.match(result.error, /start a new chat/);
    assert.deepEqual(effects, []);
    assert.equal(ctx.activeSessionExecutions.size, 0);
  });
}


test("expired local and unknown jobs do not claim a lost worker route", (t) => {
  const original = process.env.NETCATTY_JOB_DIAG;
  process.env.NETCATTY_JOB_DIAG = "1";
  t.after(() => {
    if (original === undefined) delete process.env.NETCATTY_JOB_DIAG;
    else process.env.NETCATTY_JOB_DIAG = original;
  });
  const events = [];
  t.mock.method(console, "info", (line) => {
    events.push(JSON.parse(line.slice("[Netcatty JobDiag] ".length)));
  });
  const jobs = new Map([["local-expired", {
    status: "completed", updatedAt: Date.now() - 20 * 60 * 1000,
    chatSessionId: "owner",
  }], ["local-scoped", { status: "running", chatSessionId: "owner" }]]);
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: jobs });
  const api = createExecHandlerApi(ctx);
  ctx.pruneCompletedBackgroundJobs();
  assert.equal(jobs.has("local-expired"), false);
  for (const jobId of ["local-expired", "unknown"]) {
    assert.equal(api.handleJobPoll({ jobId }).ok, false);
    assert.equal(api.handleJobStop({ jobId }).ok, false);
  }
  api.handleJobPoll({ jobId: "local-scoped", chatSessionId: "other" });
  assert.deepEqual(events.map(({ reason }) => reason), [
    "job-missing", "job-missing", "job-missing", "job-missing", "scope-mismatch",
  ]);
});


test("MCP exec sends on an idle PowerShell prompt hidden by a CSI erase", async () => {
  const pty = new FakePty();
  pty.write = (data) => {
    pty.writes.push(String(data));
    const marker = String(data).match(/(__NCMCP_[0-9a-z]+_[0-9a-f]+__)/i)?.[1];
    if (!marker) return;
    queueMicrotask(() => pty.emit("data", `${marker}_S\r\nok\r\n${marker}_E:0\r\n`));
  };
  const { trackSessionIdlePrompt } = require("./ai/shellUtils.cjs");
  const session = {
    protocol: "ssh",
    pty,
    shellKind: "powershell",
    _promptTrackTail: "",
    lastIdlePrompt: "",
  };
  trackSessionIdlePrompt(session, "PS C:\\Users\\alice> ggd2147483647d\x1b[20G\x1b[0J");
  const ctx = createExecHandlerTestContext({
    sessions: new Map([["ps", session]]),
    backgroundJobs: new Map(),
  });
  ctx.commandTimeoutMs = 200;
  ctx.startPtyJob = require("./ai/ptyExec.cjs").startPtyJob;
  ctx.execViaPty = require("./ai/ptyExec.cjs").execViaPty;
  ctx.getFreshIdlePrompt = require("./ai/shellUtils.cjs").getFreshIdlePrompt;
  const api = createExecHandlerApi(ctx);
  const result = await api.handleExec({
    sessionId: "ps",
    chatSessionId: "ps-chat",
    command: "Write-Output ok",
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "ok");
  assert.equal(pty.writes.length, 1);
  assert.match(pty.writes[0], /\$__NCMCP_/);
});

test("MCP background readiness timeout survives job polling without PTY writes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pty = new FakePty();
  const session = { protocol: "local", pty, shellKind: "posix", _promptTrackTail: "" };
  const ctx = createExecHandlerTestContext({
    sessions: new Map([["not-ready", session]]), backgroundJobs: new Map(),
  });
  ctx.startPtyJob = require("./ai/ptyExec.cjs").startPtyJob;
  const api = createExecHandlerApi(ctx);
  const started = await api.handleJobStart({
    sessionId: "not-ready", chatSessionId: "readiness-chat", command: "echo must-not-run",
  });
  assert.equal(started.ok, true);
  t.mock.timers.tick(30001);
  await nextTick();
  const polled = api.handleJobPoll({ jobId: started.jobId, chatSessionId: "readiness-chat" });
  assert.equal(polled.status, "failed");
  assert.equal(polled.completed, true);
  // #4195: a live shell whose prompt was never recognized is an actionable
  // unknown, not a terminal SHELL_NOT_READY. The command is still never sent.
  assert.equal(polled.code, "SHELL_READINESS_UNKNOWN");
  assert.equal(ctx.activeSessionExecutions.size, 0);
  assert.deepEqual(pty.writes, []);
  ctx.getFreshIdlePrompt = () => "user@host:~$ ";
  t.mock.timers.tick(1000);
  assert.deepEqual(pty.writes, [], "late readiness must not deliver the failed job");
});

for (const route of ['exec', 'job']) {
  test(`MCP ${route} revalidates privacy when the awaited prompt becomes ready`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const privacy = createAiPrivacyService();
    privacy.checkSession('readiness-chat');
    const pty = new FakePty();
    const session = { protocol: 'local', pty, shellKind: 'posix', _promptTrackTail: '' };
    const ctx = createExecHandlerTestContext({
      sessions: new Map([['waiting', session]]), backgroundJobs: new Map(),
    });
    let prompt = '';
    ctx.getFreshIdlePrompt = () => prompt;
    Object.assign(ctx, require('./ai/ptyExec.cjs'));
    const api = createExecHandlerApi(ctx);
    const pending = (route === 'job' ? api.handleJobStart : api.handleExec)({
      sessionId: 'waiting', chatSessionId: 'readiness-chat', command: 'echo forbidden',
    }, { beforeExecute: () => privacy.restore('readiness-chat', []) });
    await nextTick();
    assert.deepEqual(pty.writes, []);
    privacy.configure({ enabled: true });
    prompt = 'user@host:~$ ';
    t.mock.timers.tick(50);
    await nextTick();
    // Also clean up on the old implementation, where a probe was already sent.
    pty.emit('close');
    const startedOrFinished = await pending;
    const result = route === 'job'
      ? api.handleJobPoll({ jobId: startedOrFinished.jobId, chatSessionId: 'readiness-chat' })
      : startedOrFinished;
    assert.deepEqual(pty.writes, [], 'retired privacy session must not send even probe/control bytes');
    assert.match(result.error, /start a new chat/);
    assert.equal(ctx.activeSessionExecutions.size, 0);
  });
}
