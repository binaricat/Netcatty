"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createBackgroundJobApi } = require("./mcpServerBridge/backgroundJobs.cjs");
const { createExecHandlerApi } = require("./mcpServerBridge/execHandlers.cjs");
const { PROBE_OUTPUT_MARKER } = require("./ai/sessionShellKind.cjs");

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
    activeSessionExecutions: new Map(),
    activePtyExecs: new Map(),
    crypto,
    sftpBridge: {},
    BACKGROUND_JOB_RETENTION_MS: 10 * 60 * 1000,
    DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS: 30 * 1000,
    MAX_BACKGROUND_JOB_OUTPUT_CHARS: 256 * 1024,
    DEFAULT_BACKGROUND_JOB_TIMEOUT_MS: 60 * 60 * 1000,
    commandTimeoutMs: 5000,
    activeSftpOpSeq: 0,
    debugLog() {},
    getSessionMeta() {
      return {};
    },
    checkCommandSafety() {
      return { blocked: false };
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
