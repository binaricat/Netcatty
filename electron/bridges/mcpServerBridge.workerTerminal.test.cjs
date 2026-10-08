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
          savedHostId: "",
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
      savedHostId: "",
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

test("chat inheritor accepted for worker job control only after undo registers the jobs", async () => {
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
            jobId: "worker-job-inh",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-inh",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-source");
  // A live branch keeps the inherited terminal in its own per-turn scope sync.
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-inh",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-branch");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-inh",
    command: "sleep 30",
    chatSessionId: "chat-source",
  });
  assert.equal(started.ok, true);

  // Before registration: the branch's own chat id is rejected like any other.
  const rejected = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-inh",
    chatSessionId: "chat-branch",
  });
  assert.deepEqual(rejected, { ok: false, error: "Background job not found" });

  assert.equal(
    bridge.registerInheritedBackgroundJobs("chat-branch", "chat-source", ["worker-job-inh"]).registered,
    1,
  );

  const pollRequests = requests.filter((entry) => entry.channel === "netcatty:ai:jobPoll");
  assert.equal(pollRequests.length, 0);
  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-inh",
    chatSessionId: "chat-branch",
  });
  assert.equal(polled.ok, true);
  const forwarded = requests.findLast?.((entry) => entry.channel === "netcatty:ai:jobPoll")
    ?? requests.filter((entry) => entry.channel === "netcatty:ai:jobPoll").at(-1);
  assert.equal(forwarded.payload.chatSessionId, "chat-source");

  // Foreign chat sessions still cannot reach the job.
  const foreign = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-inh",
    chatSessionId: "chat-stranger",
  });
  assert.deepEqual(foreign, { ok: false, error: "Background job not found" });
});

test("cancelling the source chat keeps worker jobs inherited by a live branch", async () => {
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
            jobId: "worker-job-src",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
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
      sessionId: "ssh-src",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-source");
  // A live branch keeps the inherited terminal in its own per-turn scope sync.
  bridge.updateSessionMetadata([{
    sessionId: "ssh-src",
    hostname: "host.example",
    protocol: "ssh",
    connected: true,
  }], "chat-branch");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-src",
    command: "sleep 30",
    chatSessionId: "chat-source",
  });
  assert.equal(started.ok, true);

  bridge.registerInheritedBackgroundJobs("chat-branch", "chat-source", ["worker-job-src"]);

  const cancelled = await bridge.applyChatSessionCancelled("chat-source", true);
  assert.equal(cancelled.ok, true);
  assert.deepEqual(sends, [
    {
      channel: "netcatty:ai:catty:cancel",
      payload: {
        chatSessionId: "chat-source",
        preserveJobIds: ["worker-job-src"],
      },
      options: {},
    },
  ]);

  // The branch can still poll (and stop) the inherited job after the source
  // chat was torn down.
  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-src",
    chatSessionId: "chat-branch",
  });
  assert.equal(polled.ok, true);
});

test("cancelling an inherit chat drops its registration; un-inherited jobs cancel normally", async () => {
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
          const jobIndex = requests.filter((entry) => entry.channel === "netcatty:ai:jobStart").length;
          return Promise.resolve({
            ok: true,
            jobId: jobIndex === 2 ? "worker-job-drop" : "worker-job-keep",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
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
      sessionId: "ssh-drop",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-keep");

  for (const jobId of ["worker-job-keep", "worker-job-drop"]) {
    const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
      sessionId: "ssh-drop",
      command: "sleep 30",
      chatSessionId: "chat-keep",
    });
    assert.equal(started.ok, true);
    assert.equal(started.jobId, jobId);
  }

  bridge.registerInheritedBackgroundJobs("chat-child", "chat-keep", ["worker-job-drop"]);

  // Inherited job (owned by chat-keep, inherited by chat-child) is preserved
  // even when chat-child itself is torn down; the remaining branch (none)
  // means the job is no longer preserved afterwards.
  await bridge.applyChatSessionCancelled("chat-child", true);
  const pollAfterChildCancel = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-drop",
    chatSessionId: "chat-keep",
  });
  assert.equal(pollAfterChildCancel.ok, true);

  assert.equal(
    bridge.registerInheritedBackgroundJobs("chat-child-2", "chat-keep", ["worker-job-drop"]).registered,
    1,
  );
  await bridge.applyChatSessionCancelled("chat-keep", true);
  assert.deepEqual(sends, [
    {
      channel: "netcatty:ai:catty:cancel",
      payload: {
        chatSessionId: "chat-child",
      },
      options: {},
    },
    {
      channel: "netcatty:ai:catty:cancel",
      payload: {
        chatSessionId: "chat-keep",
        preserveJobIds: ["worker-job-drop"],
      },
      options: {},
    },
  ]);
});

test("after the source chat is deleted a live branch keeps polling the inherited job", async () => {
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
            jobId: "worker-job-del",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
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
      sessionId: "ssh-del",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-src");
  // A live branch keeps the inherited terminal in its own per-turn scope sync.
  bridge.updateSessionMetadata([{
    sessionId: "ssh-del",
    hostname: "host.example",
    protocol: "ssh",
    connected: true,
  }], "chat-branch");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-del",
    command: "sleep 30",
    chatSessionId: "chat-src",
  });
  assert.equal(started.ok, true);

  bridge.registerInheritedBackgroundJobs("chat-branch", "chat-src", ["worker-job-del"]);

  // Deleting the source chat (renderer SDK cleanup path).
  await bridge.cleanupScopedMetadata("chat-src");

  // Catty-branch poll presenting the owner id (renderer-side remap).
  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-del",
    chatSessionId: "chat-src",
  });
  assert.equal(polled.ok, true);

  // External-branch poll presenting its own chat id.
  const polledAsBranch = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-del",
    chatSessionId: "chat-branch",
  });
  assert.equal(polledAsBranch.ok, true);

  // Deleting the branch later drops its registration: the source-owned job's
  // teardown is no longer deferred once no live branch inherits it, and with
  // the source chat gone the orphaned job is finally cancelled in the worker.
  await bridge.cleanupScopedMetadata("chat-branch");
  const orphanStop = requests.find((entry) => entry.channel === "netcatty:ai:jobStop");
  assert.deepEqual(orphanStop, {
    channel: "netcatty:ai:jobStop",
    payload: { jobId: "worker-job-del", sessionId: "ssh-del", chatSessionId: "chat-src" },
    options: {},
  });
  const orphanedPoll = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-del",
    chatSessionId: "chat-branch",
  });
  assert.deepEqual(orphanedPoll, { ok: false, error: "Background job not found" });
});

test("a sibling branch keeps polling an inherited job after another branch is deleted", async () => {
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
            jobId: "worker-job-branchy",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
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
      sessionId: "ssh-branchy",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-src");
  bridge.updateSessionMetadata([{
    sessionId: "ssh-branchy",
    hostname: "host.example",
    protocol: "ssh",
    connected: true,
  }], "chat-branch-a");
  bridge.updateSessionMetadata([{
    sessionId: "ssh-branchy",
    hostname: "host.example",
    protocol: "ssh",
    connected: true,
  }], "chat-branch-b");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-branchy",
    command: "sleep 30",
    chatSessionId: "chat-src",
  });
  assert.equal(started.ok, true);

  bridge.registerInheritedBackgroundJobs("chat-branch-a", "chat-src", ["worker-job-branchy"]);
  bridge.registerInheritedBackgroundJobs("chat-branch-b", "chat-src", ["worker-job-branchy"]);

  // The source chat is deleted first while both branches stay live: job
  // cancellation must stay deferred until the last inheritor disappears.
  await bridge.cleanupScopedMetadata("chat-src");

  // Deleting one branch leaves the sibling inheriting: no cancellation and
  // the sibling can still poll the inherited job.
  await bridge.cleanupScopedMetadata("chat-branch-a");
  assert.equal(requests.some((entry) => entry.channel === "netcatty:ai:jobStop"), false);
  const polledBySibling = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-branchy",
    chatSessionId: "chat-branch-b",
  });
  assert.equal(polledBySibling.ok, true);

  // Deleting the last branch removes the final inheritor: the now-orphaned
  // job is cancelled with the owner chat id it was started with.
  await bridge.cleanupScopedMetadata("chat-branch-b");
  const orphanStop = requests.find((entry) => entry.channel === "netcatty:ai:jobStop");
  assert.deepEqual(orphanStop, {
    channel: "netcatty:ai:jobStop",
    payload: { jobId: "worker-job-branchy", sessionId: "ssh-branchy", chatSessionId: "chat-src" },
    options: {},
  });
  const orphanedPoll = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-branchy",
    chatSessionId: "chat-branch-b",
  });
  assert.deepEqual(orphanedPoll, { ok: false, error: "Background job not found" });
});

test("deleting the last inheritor of a job owned by a live chat does not cancel the job", async () => {
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
            jobId: "worker-job-live",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
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
      sessionId: "ssh-live",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-owner");
  bridge.updateSessionMetadata([{
    sessionId: "ssh-live",
    hostname: "host.example",
    protocol: "ssh",
    connected: true,
  }], "chat-branch");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-live",
    command: "sleep 30",
    chatSessionId: "chat-owner",
  });
  assert.equal(started.ok, true);
  bridge.registerInheritedBackgroundJobs("chat-branch", "chat-owner", ["worker-job-live"]);

  // Deleting the branch drops its registration, but the owner chat is still
  // live: the owner keeps polling the job that it still owns.
  await bridge.cleanupScopedMetadata("chat-branch");
  assert.equal(requests.some((entry) => entry.channel === "netcatty:ai:jobStop"), false);
  const polledByOwner = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-live",
    chatSessionId: "chat-owner",
  });
  assert.equal(polledByOwner.ok, true);
  // Only the branch's own catty-cancel teardown fired, without any
  // preserved-job ids and without stopping the owner's still-live job.
  assert.deepEqual(sends, [{
    channel: "netcatty:ai:catty:cancel",
    payload: { chatSessionId: "chat-branch" },
    options: {},
  }]);
});

test("a failed orphan stop retries via the idle path until the job stops", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  let stopAttempts = 0;
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({
            ok: true,
            jobId: "worker-job-orphan-retry",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobStop") {
          stopAttempts += 1;
          // The first orphan cancellation fails transiently (worker busy);
          // the retry on the idle path's poll must succeed.
          if (stopAttempts === 1) return Promise.reject(new Error("worker busy"));
          return Promise.resolve({ ok: true, jobId: payload.jobId, completed: true });
        }
        if (channel === "netcatty:ai:jobPoll") {
          return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
      send(channel, payload, options) {
        requests.push({ channel, payload, options });
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-orphan-retry",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-src");
  bridge.updateSessionMetadata([{
    sessionId: "ssh-orphan-retry",
    hostname: "host.example",
    protocol: "ssh",
    connected: true,
  }], "chat-branch");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-orphan-retry",
    command: "sleep 30",
    chatSessionId: "chat-src",
  });
  assert.equal(started.ok, true);

  bridge.registerInheritedBackgroundJobs("chat-branch", "chat-src", ["worker-job-orphan-retry"]);
  // Deleting the source chat preserves the job for the live branch; deleting
  // the last branch then triggers the orphan cancellation, whose worker stop
  // rejects. No live chat can poll or stop the job any more.
  await bridge.cleanupScopedMetadata("chat-src");
  await bridge.cleanupScopedMetadata("chat-branch");
  assert.deepEqual(requests.find((entry) => entry.channel === "netcatty:ai:jobStop"), {
    channel: "netcatty:ai:jobStop",
    payload: { jobId: "worker-job-orphan-retry", sessionId: "ssh-orphan-retry", chatSessionId: "chat-src" },
    options: {},
  });

  const stillActive = await bridge.hasActiveWorkerJobForTerminalSession("ssh-orphan-retry");
  assert.equal(stillActive, true);
  // The rejection must be retried, not merely retained: the idle path's next
  // poll sends the stop again with the job's owner chat id.
  const retryStop = requests.filter((entry) => entry.channel === "netcatty:ai:jobStop")[1];
  assert.deepEqual(retryStop, {
    channel: "netcatty:ai:jobStop",
    payload: { jobId: "worker-job-orphan-retry", sessionId: "ssh-orphan-retry", chatSessionId: "chat-src" },
    options: {},
  });
  // The confirmed retry deletes the registry entry (and its inheritor
  // bookkeeping): nothing keeps polling the stopped job afterwards.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopAttempts, 2);
  assert.equal(await bridge.hasActiveWorkerJobForTerminalSession("ssh-orphan-retry"), false);
  const afterStop = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-orphan-retry",
    chatSessionId: "chat-branch",
  });
  assert.deepEqual(afterStop, { ok: false, error: "Background job not found" });
});

test("an in-flight orphan stop rejects inheritance registration for its job", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  let resolveStop;
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({
            ok: true,
            jobId: "worker-job-stopflight",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobStop") {
          // Keep the orphan stop in flight: the main process retains the
          // registry entry until the stop is confirmed.
          return new Promise((resolve) => { resolveStop = resolve; });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
      },
      send() {},
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-stopflight",
      hostname: "host.example",
      protocol: "ssh",
      connected: true,
    },
  ], "chat-src");
  bridge.updateSessionMetadata([{
    sessionId: "ssh-stopflight",
    hostname: "host.example",
    protocol: "ssh",
    connected: true,
  }], "chat-branch");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-stopflight",
    command: "sleep 30",
    chatSessionId: "chat-src",
  });
  assert.equal(started.ok, true);

  bridge.registerInheritedBackgroundJobs("chat-branch", "chat-src", ["worker-job-stopflight"]);
  // Removing the source preserves the job for the live branch; removing the
  // last branch then starts the orphan stop, which stays in flight below.
  await bridge.cleanupScopedMetadata("chat-src");
  await bridge.cleanupScopedMetadata("chat-branch");

  // While the stop is in flight, a new branch's undo must not register the
  // job as inherited: the stop's completion deletes the entry regardless.
  let flight = bridge.registerInheritedBackgroundJobs("chat-new-branch", "chat-src", ["worker-job-stopflight"]);
  assert.equal(flight.ok, true);
  assert.equal(flight.registered, 0);
  // No inheritor may have been granted while stop is in flight: the new
  // branch cannot poll the job.
  const pollDuringFlight = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-stopflight",
    chatSessionId: "chat-new-branch",
  });
  assert.deepEqual(pollDuringFlight, { ok: false, error: "Background job not found" });

  // The worker stop handler resolves as soon as cancellation is requested
  // (status "stopping"), not when the job is finished: settling the promise
  // clears the in-flight guard but leaves the stop unconfirmed, so the entry
  // (with the orphan-stop retry marker) is retained.
  resolveStop({
    ok: true,
    jobId: "worker-job-stopflight",
    sessionId: "ssh-stopflight",
    status: "stopping",
    error: "Cancellation requested",
  });
  await new Promise((resolve) => setImmediate(resolve));
  // Registration must stay rejected after the promise settled: the job is
  // irreversibly stopping and will soon poll as completed or missing.
  flight = bridge.registerInheritedBackgroundJobs("chat-new-branch", "chat-src", ["worker-job-stopflight"]);
  assert.equal(flight.ok, true);
  assert.equal(flight.registered, 0);
  assert.deepEqual(flight.unownedJobIds, ["worker-job-stopflight"]);

  // Confirming the stop deletes the registry entry; afterwards the job stays
  // unregistered (the undo's short count aborts/retries, never publishes a
  // branch polling "Background job not found").
  await bridge.hasActiveWorkerJobForTerminalSession("ssh-stopflight");
  const confirmStop = requests.filter((entry) => entry.channel === "netcatty:ai:jobStop").pop();
  assert.deepEqual(confirmStop, {
    channel: "netcatty:ai:jobStop",
    payload: { jobId: "worker-job-stopflight", sessionId: "ssh-stopflight", chatSessionId: "chat-src" },
    options: {},
  });
  resolveStop({ ok: true, jobId: "worker-job-stopflight", completed: true });
  await new Promise((resolve) => setImmediate(resolve));
  flight = bridge.registerInheritedBackgroundJobs("chat-new-branch", "chat-src", ["worker-job-stopflight"]);
  assert.equal(flight.registered, 0);
});

test("registration classifies unregistered ids as unknown (gone) or unowned (still known)", async () => {
  // A job that completes without being polled is removed from the registry by
  // the idle close poll; inheritor registration can never succeed for it. The
  // undo flow reconciles such ids out of the copied state, so registration
  // must label them distinctly from jobs the main process still knows but
  // cannot register under the claimed owner (owner mismatch) — the latter
  // keep the strict retry/abort behavior.
  const requests = [];
  const bridge = loadFreshBridge();
  let nextJobId = 0;
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        requests.push({ channel, payload });
        if (channel === "netcatty:ai:jobStart") {
          nextJobId += 1;
          return Promise.resolve({
            ok: true,
            jobId: `worker-job-cls-${nextJobId}`,
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobPoll" && payload.jobId === "worker-job-cls-1") {
          return Promise.resolve({ ok: true, jobId: payload.jobId, completed: true });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, completed: false });
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-cls", hostname: "host.example", protocol: "ssh", connected: true },
  ], "chat-src");
  bridge.updateSessionMetadata([
    { sessionId: "ssh-cls", hostname: "host.example", protocol: "ssh", connected: true },
  ], "chat-other");
  bridge.updateSessionMetadata([
    { sessionId: "ssh-cls", hostname: "host.example", protocol: "ssh", connected: true },
  ], "chat-branch");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-cls",
    command: "sleep 30",
    chatSessionId: "chat-src",
  });
  assert.equal(started.ok, true);
  const otherStarted = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-cls",
    command: "sleep 30",
    chatSessionId: "chat-other",
  });
  assert.equal(otherStarted.ok, true);

  // Completing the source's job deletes its registry entry even though the
  // model never polled it (same removal the idle close poll performs).
  const completed = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-cls-1",
    chatSessionId: "chat-src",
  });
  assert.equal(completed.completed, true);

  const registration = bridge.registerInheritedBackgroundJobs("chat-branch", "chat-src", [
    "worker-job-cls-1",
    "worker-never-started",
    "worker-job-cls-2",
  ]);
  assert.equal(registration.ok, true);
  assert.equal(registration.registered, 0);
  // The completed job and the never-seen id are both unknown to this main
  // process (no side effect left to inherit); the still-running job owned by
  // another chat stays in the `unownedJobIds` bucket instead.
  assert.deepEqual(new Set(registration.unknownJobIds), new Set([
    "worker-job-cls-1",
    "worker-never-started",
  ]));
  assert.deepEqual(registration.unownedJobIds, ["worker-job-cls-2"]);
});
