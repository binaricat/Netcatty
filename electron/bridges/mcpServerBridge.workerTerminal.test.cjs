"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

test("MCP/Catty capability context uses scoped metadata when terminal sessions live in worker", async () => {
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request() {
        throw new Error("getContext should not need a worker round trip");
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
      },
      options: {},
    },
  ]);
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
  });
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
