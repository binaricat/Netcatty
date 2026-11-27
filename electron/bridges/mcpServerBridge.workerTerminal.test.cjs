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

test("terminal_execute rehydrates worker readiness from visible context before sending", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      getSessionOwnerWebContentsId: () => null,
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:ai:shellReadiness") {
          return Promise.resolve({
            ok: true,
            found: true,
            trackedShell: true,
            freshIdlePrompt: "",
            visibleIdlePrompt: "",
            readiness: "unknown",
            generation: 7,
          });
        }
        if (channel === "netcatty:ai:seedIdlePrompt") {
          return Promise.resolve({
            ok: true,
            found: true,
            ready: true,
            prompt: "[root@k8s-10-1-64-1 ~] br0 = 10.1.64.1\n#",
            generation: 8,
          });
        }
        return Promise.resolve({ ok: true, stdout: "ok\n", stderr: "", exitCode: 0 });
      },
    },
  });
  const visibleContext = "Last login\r\n[root@k8s-10-1-64-1 ~] br0 = 10.1.64.1\n#";
  bridge.setVaultAgentInvoker(async (op, params) => {
    assert.equal(op, "terminal.readContext");
    assert.equal(params.sessionId, "ssh-1");
    return { ok: true, content: visibleContext, alternateScreen: false };
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "jumpssh.riverbegin.cn",
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
  assert.deepEqual(
    requests.map(({ channel }) => channel),
    ["netcatty:ai:shellReadiness", "netcatty:ai:seedIdlePrompt", "netcatty:ai:exec"],
  );
  assert.equal(requests[1].payload.context, visibleContext);
  assert.equal(requests[1].payload.expectedGeneration, 7);
});

test("worker exec and jobStart abort without sending when scope disappears during readiness rehydration", async () => {
  for (const method of ["netcatty/exec", "netcatty/jobStart"]) {
    const requests = [];
    const bridge = loadFreshBridge();
    bridge.init({
      sessions: new Map(),
      electronModule: null,
      terminalWorkerManager: {
        getSessionOwnerWebContentsId: () => null,
        request(channel, payload, options) {
          requests.push({ channel, payload, options });
          if (channel === "netcatty:ai:shellReadiness") {
            return Promise.resolve({
              ok: true,
              found: true,
              trackedShell: true,
              freshIdlePrompt: "",
              visibleIdlePrompt: "",
              readiness: "unknown",
              generation: 3,
            });
          }
          return Promise.resolve({ ok: true, stdout: "unexpected\n", exitCode: 0, jobId: "job-1" });
        },
      },
    });
    bridge.setVaultAgentInvoker(async (op) => {
      assert.equal(op, "terminal.readContext");
      // Session is removed from chat scope while renderer read is in flight.
      bridge.updateSessionMetadata([], "chat-scope-drop");
      return { ok: true, content: "[root@target ~]# ", alternateScreen: false };
    });
    bridge.setPermissionMode("auto");
    bridge.setCommandBlocklist([]);
    bridge.updateSessionMetadata([
      {
        sessionId: "ssh-1",
        hostname: "jumpssh.riverbegin.cn",
        protocol: "ssh",
        connected: true,
      },
    ], "chat-scope-drop");

    const result = await bridge.dispatchBuiltinRpc(method, {
      sessionId: "ssh-1",
      command: "pwd",
      chatSessionId: "chat-scope-drop",
    });

    assert.equal(result.ok, false, method);
    assert.match(result.error, /scope/i, method);
    assert.deepEqual(
      requests.map(({ channel }) => channel),
      ["netcatty:ai:shellReadiness"],
      method,
    );
  }
});

test("worker exec and jobStart honor stop received while readiness rehydration is pending", async () => {
  for (const method of ["netcatty/exec", "netcatty/jobStart"]) {
    const requests = [];
    let releaseReadContext;
    const bridge = loadFreshBridge();
    bridge.init({
      sessions: new Map(),
      electronModule: null,
      terminalWorkerManager: {
        getSessionOwnerWebContentsId: () => null,
        send() {},
        request(channel, payload, options) {
          requests.push({ channel, payload, options });
          if (channel === "netcatty:ai:shellReadiness") {
            return Promise.resolve({
              ok: true,
              found: true,
              trackedShell: true,
              freshIdlePrompt: "",
              visibleIdlePrompt: "",
              readiness: "unknown",
              generation: 11,
            });
          }
          return Promise.resolve({ ok: true, stdout: "unexpected\n", exitCode: 0, jobId: "job-1" });
        },
      },
    });
    let readStarted;
    const readStartedPromise = new Promise((resolve) => {
      readStarted = resolve;
    });
    bridge.setVaultAgentInvoker(async (op) => {
      assert.equal(op, "terminal.readContext");
      readStarted();
      return await new Promise((resolve) => {
        releaseReadContext = resolve;
      });
    });
    bridge.setPermissionMode("auto");
    bridge.setCommandBlocklist([]);
    bridge.updateSessionMetadata([
      {
        sessionId: "ssh-1",
        hostname: "jumpssh.riverbegin.cn",
        protocol: "ssh",
        connected: true,
      },
    ], "chat-stop");

    const pending = bridge.dispatchBuiltinRpc(method, {
      sessionId: "ssh-1",
      command: "pwd",
      chatSessionId: "chat-stop",
    });

    await readStartedPromise;
    await bridge.dispatchBuiltinRpc("netcatty/setCancelled", {
      chatSessionId: "chat-stop",
      cancelled: true,
    });

    const result = await pending;
    releaseReadContext?.({ ok: true, content: "[root@target ~]# ", alternateScreen: false });

    assert.equal(result.ok, false, method);
    assert.match(result.error, /cancel/i, method);
    assert.deepEqual(
      requests.map(({ channel }) => channel),
      ["netcatty:ai:shellReadiness"],
      method,
    );
  }
});

test("terminal_execute does not rehydrate readiness when the worker reports busy", async () => {
  const requests = [];
  let contextReads = 0;
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      getSessionOwnerWebContentsId: () => null,
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:ai:shellReadiness") {
          return Promise.resolve({
            ok: true,
            found: true,
            trackedShell: true,
            freshIdlePrompt: "",
            visibleIdlePrompt: "",
            readiness: "busy",
          });
        }
        return Promise.resolve({ ok: true, stdout: "ok\n", stderr: "", exitCode: 0 });
      },
    },
  });
  bridge.setVaultAgentInvoker(async () => {
    contextReads += 1;
    return { ok: true, content: "[root@target ~]# ", alternateScreen: false };
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "jumpssh.riverbegin.cn",
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
  assert.equal(contextReads, 0);
  assert.deepEqual(
    requests.map(({ channel }) => channel),
    ["netcatty:ai:shellReadiness", "netcatty:ai:exec"],
  );
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

test("job diagnostics tell a scope mismatch from a lost route and log chat cancellation", async (t) => {
  process.env.NETCATTY_JOB_DIAG = "1";
  const lines = [];
  t.mock.method(console, "info", (...args) => { lines.push(args.join(" ")); });
  t.after(() => { delete process.env.NETCATTY_JOB_DIAG; });
  const events = () => lines
    .filter((line) => line.startsWith("[Netcatty JobDiag] "))
    .map((line) => JSON.parse(line.slice("[Netcatty JobDiag] ".length)));

  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({ ok: true, jobId: "worker-job-1", sessionId: payload.sessionId, status: "running" });
        }
        return Promise.resolve({ ok: true, jobId: payload.jobId, status: "running", completed: false });
      },
      send() {},
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-1", hostname: "host.example", protocol: "ssh", shellType: "bash", connected: true },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("netcatty/jobStart", { sessionId: "ssh-1", command: "sleep 1", chatSessionId: "chat-1" });

  // The route exists but belongs to another chat session: not a lost route.
  await bridge.dispatchBuiltinRpc("netcatty/jobPoll", { jobId: "worker-job-1", chatSessionId: "chat-2" });
  bridge.cancelWorkerBackgroundJobsForSession("chat-1");
  // The worker route is gone now, so these fall through to the main-process
  // handlers; the miss must still be logged and explained.
  await bridge.dispatchBuiltinRpc("netcatty/jobPoll", { jobId: "worker-job-1", chatSessionId: "chat-1" });
  await bridge.dispatchBuiltinRpc("netcatty/jobStop", { jobId: "worker-job-1", chatSessionId: "chat-1" });

  const misses = events().filter((event) => event.event === "job-stop-miss");
  assert.deepEqual(misses.map((event) => [event.op, event.reason]), [
    ["poll", "scope-mismatch"],
    ["poll", "job-missing"],
    ["stop", "job-missing"],
  ]);
  const removed = events().filter((event) => event.event === "route-removed");
  assert.deepEqual(removed.map((event) => [event.jobId, event.via]), [["worker-job-1", "chat-session-cancel"]]);
});

test("route-removed is emitted once when a concurrent cancel removes the route during terminal cleanup", async (t) => {
  process.env.NETCATTY_JOB_DIAG = "1";
  const lines = [];
  t.mock.method(console, "info", (...args) => { lines.push(args.join(" ")); });
  t.after(() => { delete process.env.NETCATTY_JOB_DIAG; });
  const removedEvents = () => lines
    .filter((line) => line.startsWith("[Netcatty JobDiag] "))
    .map((line) => JSON.parse(line.slice("[Netcatty JobDiag] ".length)))
    .filter((event) => event.event === "route-removed");

  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({ ok: true, jobId: "worker-job-1", sessionId: payload.sessionId, status: "running" });
        }
        if (channel === "netcatty:ai:jobStop") return stopGate.then(() => ({ ok: true }));
        return Promise.resolve({ ok: true });
      },
      send() {},
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-1", hostname: "host.example", protocol: "ssh", shellType: "bash", connected: true },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("netcatty/jobStart", { sessionId: "ssh-1", command: "sleep 1", chatSessionId: "chat-1" });

  const cleanup = bridge.cancelWorkerBackgroundJobsForTerminalSession("ssh-1");
  bridge.cancelWorkerBackgroundJobsForSession("chat-1");
  releaseStop();
  await cleanup;

  assert.deepEqual(removedEvents().map((event) => [event.jobId, event.via]), [["worker-job-1", "chat-session-cancel"]]);
});

test("job diagnostics log a worker-side miss while the main-process route still exists", async (t) => {
  process.env.NETCATTY_JOB_DIAG = "1";
  const lines = [];
  t.mock.method(console, "info", (...args) => { lines.push(args.join(" ")); });
  t.after(() => { delete process.env.NETCATTY_JOB_DIAG; });
  const misses = () => lines
    .filter((line) => line.startsWith("[Netcatty JobDiag] "))
    .map((line) => JSON.parse(line.slice("[Netcatty JobDiag] ".length)))
    .filter((event) => event.event === "job-stop-miss");

  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({ ok: true, jobId: "worker-job-1", sessionId: payload.sessionId, status: "running" });
        }
        // The worker evicted the job (pruned or restarted) but the route stays.
        return Promise.resolve({ ok: false, error: "Background job not found" });
      },
      send() {},
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-1", hostname: "host.example", protocol: "ssh", shellType: "bash", connected: true },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("netcatty/jobStart", { sessionId: "ssh-1", command: "sleep 1", chatSessionId: "chat-1" });
  await bridge.dispatchBuiltinRpc("netcatty/jobPoll", { jobId: "worker-job-1", chatSessionId: "chat-1" });
  await bridge.dispatchBuiltinRpc("netcatty/jobStop", { jobId: "worker-job-1", chatSessionId: "chat-1" });

  assert.deepEqual(misses().map((event) => [event.op, event.reason]), [
    ["poll", "worker-job-missing"],
    ["stop", "worker-job-missing"],
  ]);
});

test("completed worker job routes stay retained for idempotent stop and poll", async () => {
  const requests = [];
  const bridge = loadFreshBridge();
  const terminalState = {
    ok: true,
    jobId: "worker-job-timeout",
    sessionId: "ssh-1",
    command: "sleep 30",
    status: "failed",
    completed: true,
    error: "Command startup timed out",
    output: "",
    nextOffset: 0,
  };
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        requests.push({ channel, payload });
        if (channel === "netcatty:ai:jobStart") {
          return Promise.resolve({
            ok: true,
            jobId: "worker-job-timeout",
            sessionId: payload.sessionId,
            command: payload.command,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobPoll" || channel === "netcatty:ai:jobStop") {
          return Promise.resolve({ ...terminalState });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-1", hostname: "host.example", protocol: "ssh", shellType: "bash", connected: true },
  ], "chat-1");

  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-1",
    command: "sleep 30",
    chatSessionId: "chat-1",
  });
  assert.equal(started.ok, true);

  const firstPoll = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-timeout",
    offset: 0,
    chatSessionId: "chat-1",
  });
  assert.equal(firstPoll.ok, true);
  assert.equal(firstPoll.completed, true);
  assert.equal(firstPoll.status, "failed");

  const stopAfterComplete = await bridge.dispatchBuiltinRpc("netcatty/jobStop", {
    jobId: "worker-job-timeout",
    chatSessionId: "chat-1",
  });
  assert.equal(stopAfterComplete.ok, true);
  assert.equal(stopAfterComplete.completed, true);
  assert.equal(stopAfterComplete.status, "failed");

  const secondPoll = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-timeout",
    offset: 0,
    chatSessionId: "chat-1",
  });
  assert.equal(secondPoll.ok, true);
  assert.equal(secondPoll.completed, true);
  assert.equal(secondPoll.status, "failed");

  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:ai:jobStart",
    "netcatty:ai:jobPoll",
    "netcatty:ai:jobStop",
    "netcatty:ai:jobPoll",
  ]);
});

test("retained completed worker route does not block idle checks and still cleans up on terminal close", async () => {
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
            jobId: "worker-job-done",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobPoll" || channel === "netcatty:ai:jobStop") {
          return Promise.resolve({
            ok: true,
            jobId: payload.jobId,
            sessionId: "ssh-idle",
            status: "completed",
            completed: true,
            exitCode: 0,
          });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-idle", protocol: "ssh", connected: true },
  ], "chat-idle");

  await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-idle",
    command: "echo ok",
    chatSessionId: "chat-idle",
  });
  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-done",
    chatSessionId: "chat-idle",
  });
  assert.equal(polled.ok, true);
  assert.equal(polled.completed, true);

  // Completed route must not report the session as busy or issue another worker poll.
  assert.equal(await bridge.hasActiveWorkerJobForTerminalSession("ssh-idle"), false);
  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:ai:jobStart",
    "netcatty:ai:jobPoll",
  ]);

  // Retained route remains usable for idempotent stop before terminal close.
  const stopped = await bridge.dispatchBuiltinRpc("netcatty/jobStop", {
    jobId: "worker-job-done",
    chatSessionId: "chat-idle",
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.completed, true);

  // Explicit terminal close still removes the retained route without sending another stop.
  await bridge.cancelWorkerBackgroundJobsForTerminalSession("ssh-idle");
  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:ai:jobStart",
    "netcatty:ai:jobPoll",
    "netcatty:ai:jobStop",
  ]);
  const pollAfterClose = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-done",
    chatSessionId: "chat-idle",
  });
  assert.deepEqual(pollAfterClose, { ok: false, error: "Background job not found" });
});

test("retained completed worker route is pruned after BACKGROUND_JOB_RETENTION_MS expires", async (t) => {
  process.env.NETCATTY_JOB_DIAG = "1";
  const lines = [];
  t.mock.method(console, "info", (...args) => { lines.push(args.join(" ")); });
  t.after(() => { delete process.env.NETCATTY_JOB_DIAG; });

  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);

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
            jobId: "worker-job-expire",
            sessionId: payload.sessionId,
            status: "running",
          });
        }
        if (channel === "netcatty:ai:jobPoll" || channel === "netcatty:ai:jobStop") {
          return Promise.resolve({
            ok: true,
            jobId: payload.jobId,
            sessionId: "ssh-expire",
            status: "completed",
            completed: true,
            exitCode: 0,
          });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-expire", protocol: "ssh", connected: true },
  ], "chat-expire");

  await bridge.dispatchBuiltinRpc("netcatty/jobStart", {
    sessionId: "ssh-expire",
    command: "echo ok",
    chatSessionId: "chat-expire",
  });
  const firstPoll = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-expire",
    chatSessionId: "chat-expire",
  });
  assert.equal(firstPoll.ok, true);
  assert.equal(firstPoll.completed, true);

  // Still retained right at the 10-minute boundary; repeated polls must not extend completedAt.
  now += 10 * 60 * 1000;
  const boundaryStop = await bridge.dispatchBuiltinRpc("netcatty/jobStop", {
    jobId: "worker-job-expire",
    chatSessionId: "chat-expire",
  });
  assert.equal(boundaryStop.ok, true);
  assert.equal(boundaryStop.completed, true);

  // One millisecond past the 10-minute retention window, the route is pruned before worker dispatch.
  now += 1;
  const expiredPoll = await bridge.dispatchBuiltinRpc("netcatty/jobPoll", {
    jobId: "worker-job-expire",
    chatSessionId: "chat-expire",
  });
  assert.deepEqual(expiredPoll, { ok: false, error: "Background job not found" });
  assert.deepEqual(requests.map((entry) => entry.channel), [
    "netcatty:ai:jobStart",
    "netcatty:ai:jobPoll",
    "netcatty:ai:jobStop",
  ]);

  const removedEvents = lines
    .filter((line) => line.startsWith("[Netcatty JobDiag] "))
    .map((line) => JSON.parse(line.slice("[Netcatty JobDiag] ".length)))
    .filter((event) => event.event === "route-removed");
  assert.deepEqual(
    removedEvents.map((event) => [event.jobId, event.via]),
    [["worker-job-expire", "retention-expired"]],
  );
});
