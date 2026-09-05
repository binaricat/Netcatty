"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

test("MCP/Catty capability context uses scoped metadata when terminal sessions live in worker", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:portforward:list") {
          return Promise.resolve([{ tunnelId: "worker-pf-1", status: "active" }]);
        }
        throw new Error(`unexpected worker request: ${channel}`);
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "host.example",
      label: "Prod",
      username: "root",
      protocol: "ssh",
      shellType: "bash",
      connected: true,
    },
  ], "chat-1");

  const result = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-1",
  });

  assert.equal(result.hostCount, 1);
  assert.equal(result.tools.terminal.execute, "terminal_execute");
  assert.equal(result.tools.terminal.start, "terminal_start");
  assert.match(result.description, /terminal_execute/);
  assert.deepEqual(result.activePortForwardTunnels, [
    { tunnelId: "worker-pf-1", status: "active" },
  ]);
  assert.deepEqual(requests, [{
    channel: "netcatty:portforward:list",
    payload: {},
    options: {},
  }]);
  assert.deepEqual(result.hosts[0], {
    sessionId: "ssh-1",
    hostname: "host.example",
    label: "Prod",
    os: "",
    username: "root",
    protocol: "ssh",
    shellType: "bash",
    deviceType: "",
    connected: true,
    hostId: "",
    hostChain: [],
    activePortForwards: [],
  });
});

test("MCP/Catty terminal_execute proxies to worker when terminal sessions live in worker", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        return Promise.resolve({ ok: true, stdout: "ok\n", stderr: "", exitCode: 0 });
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.setCommandTimeout(23);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-1");

  const result = await bridge.dispatchBuiltinRpc("netcatty/exec", {
    sessionId: "ssh-1",
    command: "pwd",
    chatSessionId: "chat-1",
  });

  assert.deepEqual(result, { ok: true, stdout: "ok\n", stderr: "", exitCode: 0 });
  assert.deepEqual(requests, [
    {
      channel: "netcatty:ai:exec",
      payload: {
        sessionId: "ssh-1",
        command: "pwd",
        chatSessionId: "chat-1",
        commandTimeoutMs: 23000,
        sessionMeta: {
          hostname: "host.example",
          label: "",
          os: "",
          username: "",
          protocol: "ssh",
          shellType: "",
          deviceType: "",
          connected: true,
          hostId: "",
          hostChain: [],
          activePortForwards: [],
        },
        enforceWallTimeout: true,
        commandBlocklist: [],
      },
      options: {},
    },
  ]);
});

test("approved worker command is rejected when its session scope disappeared while waiting", async () => {
  let approvalId = null;
  let workerRequestCount = 0;
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request() {
        workerRequestCount += 1;
        return Promise.resolve({ ok: true, stdout: "unexpected" });
      },
    },
  });
  bridge.setMainWindowGetter(() => ({
    isDestroyed: () => false,
    webContents: {
      id: 1,
      send(channel, payload) {
        if (channel === "netcatty:ai:mcp:approval-request") approvalId = payload.approvalId;
      },
    },
  }));
  bridge.setPermissionMode("confirm");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-approval", protocol: "ssh", connected: true },
  ], "chat-approval");

  const pending = bridge.dispatchBuiltinRpc("netcatty/exec", {
    sessionId: "ssh-approval",
    command: "pwd",
    chatSessionId: "chat-approval",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(approvalId);

  bridge.updateSessionMetadata([], "chat-approval");
  bridge.resolveApprovalFromRenderer(approvalId, true);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.match(result.error, /scope/);
  assert.equal(workerRequestCount, 0);
});

test("MCP/Catty SFTP tools proxy to worker when terminal sessions live in worker", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:sftp:openForSession") {
          return Promise.resolve({ ok: true, sftpId: "worker-sftp-1" });
        }
        if (channel === "netcatty:sftp:list") {
          return Promise.resolve([
            { name: "app.log", type: "file", size: "12 bytes" },
          ]);
        }
        if (channel === "netcatty:sftp:close") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandTimeout(23);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-1");

  const result = await bridge.dispatchBuiltinRpc("netcatty/sftp/list", {
    sessionId: "ssh-1",
    path: "/var/log",
    chatSessionId: "chat-1",
  });

  assert.deepEqual(result, {
    ok: true,
    entries: [{ name: "app.log", type: "file", size: "12 bytes" }],
  });
  assert.deepEqual(requests, [
    {
      channel: "netcatty:sftp:openForSession",
      payload: {
        sessionId: "ssh-1",
        encodingStateKey: "chat:chat-1:session:ssh-1",
        timeoutMs: 23000,
      },
      options: {},
    },
    {
      channel: "netcatty:sftp:list",
      payload: {
        sessionId: "ssh-1",
        path: "/var/log",
        chatSessionId: "chat-1",
        sftpId: "worker-sftp-1",
        timeoutMs: 23000,
      },
      options: {},
    },
    {
      channel: "netcatty:sftp:close",
      payload: {
        sftpId: "worker-sftp-1",
        encodingStateKey: "chat:chat-1:session:ssh-1",
      },
      options: {},
    },
  ]);
});

test("worker SFTP cancellation waits for a pending open and closes its late handle", async () => {
  let resolveOpen;
  const openPromise = new Promise((resolve) => {
    resolveOpen = resolve;
  });
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:sftp:openForSession") return openPromise;
        if (channel === "netcatty:sftp:close") return Promise.resolve({ ok: true });
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandTimeout(23);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-pending", hostname: "host.example", protocol: "ssh", connected: true },
  ], "chat-pending");

  const operation = bridge.dispatchBuiltinRpc("netcatty/sftp/list", {
    sessionId: "ssh-pending",
    path: "/var/log",
    chatSessionId: "chat-pending",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const cancellation = bridge.cancelSftpOpsForSession("chat-pending");

  resolveOpen({ ok: true, sftpId: "worker-sftp-late" });
  await cancellation;
  await assert.rejects(operation, /Cancelled/);

  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:sftp:openForSession",
    "netcatty:sftp:close",
  ]);
  assert.equal(requests[1].payload.sftpId, "worker-sftp-late");
});

test("worker SFTP cancellation stays bounded when open never responds", async () => {
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:sftp:openForSession") return new Promise(() => {});
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandTimeout(0.01);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-stalled", hostname: "host.example", protocol: "ssh", connected: true },
  ], "chat-stalled");

  const operation = bridge.dispatchBuiltinRpc("netcatty/sftp/list", {
    sessionId: "ssh-stalled",
    path: "/var/log",
    chatSessionId: "chat-stalled",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  const cancellation = bridge.cancelSftpOpsForSession("chat-stalled");

  await assert.rejects(operation, /timed out/);
  await cancellation;
  assert.ok(Date.now() - startedAt < 2000, "cancellation should honor the bounded open timeout");
});

test("MCP/Catty terminal_start, poll, and stop proxy worker background jobs", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({
            ok: true,
            jobId: "worker-job-1",
            sessionId: payload.sessionId,
            command: payload.command,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobPoll") {
          return Promise.resolve({
            ok: true,
            jobId: payload.jobId,
            sessionId: "ssh-1",
            command: "npm test",
            status: "running",
            completed: false,
            output: "done\n",
            nextOffset: 5,
          });
        }
        if (channel === "netcatty:ai:jobStop") {
          return Promise.resolve({
            ok: true,
            jobId: payload.jobId,
            sessionId: "ssh-1",
            status: "stopping",
            completed: false,
          });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.setCommandTimeout(23);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "host.example",
      protocol: "ssh",
      shellType: "bash",
      connected: true,
    },
  ], "chat-1");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-1",
    command: "npm test",
    chatSessionId: "chat-1",
  });
  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-1",
    offset: 0,
    chatSessionId: "chat-1",
  });
  const stopped = await bridge.dispatchBuiltinRpc("netcatty/jobStop", {
    jobId: "worker-job-1",
    chatSessionId: "chat-1",
  });
  const polledAfterStop = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-1",
    offset: 5,
    chatSessionId: "chat-1",
  });

  assert.equal(started.ok, true);
  assert.equal(polled.output, "done\n");
  assert.equal(stopped.status, "stopping");
  assert.equal(polledAfterStop.ok, true);
  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:ai:jobStart",
    "netcatty:ai:jobPoll",
    "netcatty:ai:jobStop",
    "netcatty:ai:jobPoll",
  ]);
  assert.deepEqual(requests[0].payload, {
    sessionId: "ssh-1",
    command: "npm test",
    chatSessionId: "chat-1",
    commandTimeoutMs: 23000,
    sessionMeta: {
      hostname: "host.example",
      label: "",
      os: "",
      username: "",
      protocol: "ssh",
      shellType: "bash",
      deviceType: "",
      connected: true,
      hostId: "",
      hostChain: [],
      activePortForwards: [],
    },
    commandBlocklist: [],
  });
});

test("idle cleanup drops completed worker jobs even when the agent never polled them", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        requests.push({ channel, payload });
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({
            ok: true,
            jobId: "worker-job-unpolled",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobPoll") {
          return Promise.resolve({
            ok: true,
            jobId: payload.jobId,
            sessionId: payload.sessionId,
            status: "completed",
            completed: true,
          });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-unpolled", protocol: "ssh", connected: true },
  ], "chat-unpolled");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-unpolled",
    command: "sleep 1",
    chatSessionId: "chat-unpolled",
  });
  assert.equal(started.ok, true);

  assert.equal(await bridge.hasActiveWorkerJobForTerminalSession("ssh-unpolled"), false);
  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:ai:jobStart",
    "netcatty:ai:jobPoll",
  ]);

  const stalePoll = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-unpolled",
    chatSessionId: "chat-unpolled",
  });
  assert.equal(stalePoll.ok, false);
  assert.match(stalePoll.error, /not found/i);
});

test("MCP/Catty chat cancellation forwards to worker background jobs", async () => {
  const requests = [];
  const sends = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({
            ok: true,
            jobId: "worker-job-1",
            sessionId: payload.sessionId,
            command: payload.command,
            status: "running",
          });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
      send(channel, payload, options) {
        sends.push({ channel, payload, options });
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-1");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-1",
    command: "sleep 30",
    chatSessionId: "chat-1",
  });
  assert.equal(started.ok, true);

  const cancelled = await bridge.applyChatSessionCancelled("chat-1", true);
  assert.deepEqual(cancelled, {
    ok: true,
    chatSessionId: "chat-1",
    cancelled: true,
  });
  assert.deepEqual(sends, [
    {
      channel: "netcatty:ai:catty:cancel",
      payload: { chatSessionId: "chat-1" },
      options: {},
    },
  ]);

  const pollAfterCancel = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-1",
    chatSessionId: "chat-1",
  });
  assert.deepEqual(pollAfterCancel, {
    ok: false,
    error: "Background job not found",
  });
});

test("terminal close stops and forgets worker background jobs for that terminal", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({ ok: true, jobId: "worker-job-close", status: "running" });
        }
        if (channel === "netcatty:ai:jobStop") {
          return Promise.resolve({ ok: true, jobId: payload.jobId, completed: true });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([{ sessionId: "ssh-close", protocol: "ssh", connected: true }], "chat-close");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-close",
    command: "sleep 30",
    chatSessionId: "chat-close",
  });
  assert.equal(started.ok, true);

  await bridge.cancelWorkerBackgroundJobsForTerminalSession("ssh-close");

  assert.equal(requests.at(-1).channel, "netcatty:ai:jobStop");
  assert.equal(requests.at(-1).payload.jobId, "worker-job-close");
  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-close",
    chatSessionId: "chat-close",
  });
  assert.deepEqual(polled, { ok: false, error: "Background job not found" });
});

test("terminal close stays bounded when worker job stop never responds", async () => {
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({ ok: true, jobId: "worker-job-stalled", status: "running" });
        }
        if (channel === "netcatty:ai:jobStop") return new Promise(() => {});
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.setCommandTimeout(0.01);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-stalled-job", protocol: "ssh", connected: true },
  ], "chat-stalled-job");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-stalled-job",
    command: "sleep 30",
    chatSessionId: "chat-stalled-job",
  });
  assert.equal(started.ok, true);

  const startedAt = Date.now();
  await bridge.cancelWorkerBackgroundJobsForTerminalSession("ssh-stalled-job");
  assert.ok(Date.now() - startedAt < 2000, "job cleanup should honor the bounded stop timeout");

  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-stalled",
    chatSessionId: "chat-stalled-job",
  });
  assert.deepEqual(polled, { ok: false, error: "Background job not found" });
});

test("terminal close cancels a worker job start that finishes late", async () => {
  let resolveStart;
  const pendingStart = new Promise((resolve) => {
    resolveStart = resolve;
  });
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        requests.push({ channel, payload });
        if (channel === "netcatty:ai:jobStart") return pendingStart;
        if (channel === "netcatty:ai:jobStop") {
          return Promise.resolve({ ok: true, jobId: payload.jobId, completed: true });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-late-job", protocol: "ssh", connected: true },
  ], "chat-late-job");

  const starting = bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-late-job",
    command: "sleep 30",
    chatSessionId: "chat-late-job",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.cancelWorkerBackgroundJobsForTerminalSession("ssh-late-job");
  resolveStart({ ok: true, jobId: "worker-job-late", status: "running" });

  const result = await starting;
  assert.equal(result.ok, false);
  assert.match(result.error, /closing/i);
  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:ai:jobStart",
    "netcatty:ai:jobStop",
  ]);
});
