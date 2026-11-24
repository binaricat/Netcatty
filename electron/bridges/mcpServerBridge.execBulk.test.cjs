"use strict";

require("./cliDiscoveryTestIsolation.cjs").isolateCliDiscoveryFile();

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Bridge wired to a fake terminal worker that hosts the given sessions.
 * `reply(sessionId)` may return a result or a promise.
 */
function createBridge({ sessionIds = ["ssh-1", "ssh-2", "ssh-3"], reply, chat = "chat-1", mode = "auto" } = {}) {
  const workerRequests = [];
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        workerRequests.push({ channel, payload });
        if (channel !== "netcatty:ai:exec") return Promise.reject(new Error(`unexpected worker request: ${channel}`));
        return Promise.resolve(reply ? reply(payload.sessionId, payload) : { ok: true, stdout: `out-${payload.sessionId}\n`, stderr: "", exitCode: 0 });
      },
    },
  });
  bridge.setPermissionMode(mode);
  bridge.setCommandBlocklist([]);
  bridge.setCommandTimeout(30);
  bridge.updateSessionMetadata(
    sessionIds.map((sessionId, index) => ({
      sessionId,
      hostname: `host${index + 1}.example`,
      label: `web${index + 1}`,
      protocol: "ssh",
      connected: true,
    })),
    chat,
  );
  return { bridge, workerRequests, chat };
}

function captureApprovals(bridge) {
  const requests = [];
  bridge.setMainWindowGetter(() => ({
    isDestroyed: () => false,
    webContents: {
      id: 1,
      isDestroyed: () => false,
      send(channel, payload) {
        if (channel === "netcatty:ai:mcp:approval-request") requests.push(payload);
      },
    },
  }));
  return requests;
}

const bulkParams = (chatSessionId, overrides = {}) => ({
  command: "uptime",
  sessionIds: '["ssh-1","ssh-2","ssh-3"]',
  chatSessionId,
  ...overrides,
});

test("netcatty/execBulk runs one command on every session and groups identical results", async () => {
  const { bridge, workerRequests, chat } = createBridge({
    reply: (sessionId) => ({
      ok: sessionId !== "ssh-3",
      stdout: sessionId === "ssh-3" ? "inactive\n" : "active\n",
      stderr: "",
      exitCode: sessionId === "ssh-3" ? 3 : 0,
    }),
  });

  const result = await bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));

  assert.equal(result.ok, true);
  assert.equal(result.hostCount, 3);
  assert.deepEqual(result.counts, { completed: 3 });
  assert.deepEqual(result.groups, [
    {
      hosts: [{ sessionId: "ssh-1", label: "web1" }, { sessionId: "ssh-2", label: "web2" }],
      status: "completed", exitCode: 0, stdout: "active\n",
    },
    { hosts: [{ sessionId: "ssh-3", label: "web3" }], status: "completed", exitCode: 3, stdout: "inactive\n" },
  ]);
  assert.equal(workerRequests.length, 3);
  for (const request of workerRequests) {
    assert.equal(request.payload.command, "uptime");
    assert.equal(request.payload.commandTimeoutMs, 30000, "every host gets the same timeout");
    assert.equal(request.payload.enforceWallTimeout, true);
  }

  // The per-chat lock is released afterwards.
  const single = await bridge.dispatchBuiltinRpc("netcatty/exec", { sessionId: "ssh-1", command: "pwd", chatSessionId: chat });
  assert.equal(single.ok, true);
});

test("every host is started before any host finishes", async () => {
  const gates = new Map();
  const { bridge, workerRequests, chat } = createBridge({
    reply: (sessionId) => {
      const gate = deferred();
      gates.set(sessionId, gate);
      return gate.promise;
    },
  });
  const running = bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));
  await tick();
  assert.equal(workerRequests.length, 3);
  for (const [sessionId, gate] of gates) gate.resolve({ ok: true, stdout: `${sessionId}\n`, exitCode: 0 });
  const result = await running;
  assert.equal(result.groups.length, 3);
});

test("the per-chat exec lock is held for the whole fan-out", async () => {
  const gate = deferred();
  const { bridge, chat } = createBridge({ sessionIds: ["ssh-1", "ssh-2", "ssh-3", "ssh-4"], reply: () => gate.promise });
  const running = bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));
  await tick();
  const blocked = await bridge.dispatchBuiltinRpc("netcatty/exec", { sessionId: "ssh-4", command: "pwd", chatSessionId: chat });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "COMMAND_ALREADY_RUNNING");
  gate.resolve({ ok: true, stdout: "x\n", exitCode: 0 });
  assert.equal((await running).ok, true);
});

test("an unknown, out-of-scope or busy session cancels the whole call before anything is sent", async () => {
  const { bridge, workerRequests, chat } = createBridge();
  bridge.reserveSessionExecution("ssh-2", "exec");

  const result = await bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat, {
    sessionIds: '["ssh-1","ssh-2","ghost"]',
  }));

  assert.equal(result.ok, false);
  assert.match(result.error, /^nothing was sent\. 2 of 3 targets cannot run this command:/);
  assert.match(result.error, /- ssh-2 \(web2\): Session already has .* in progress/);
  assert.match(result.error, /- ghost: Session "ghost" is not in the current scope\./);
  assert.equal(workerRequests.length, 0);
});

test("the command blocklist applies to the whole fan-out", async () => {
  const { bridge, workerRequests, chat } = createBridge();
  bridge.setCommandBlocklist(["forbidden-word"]);
  const result = await bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat, { command: "echo forbidden-word" }));
  assert.equal(result.ok, false);
  assert.match(result.error, /^nothing was sent\. 3 of 3 targets cannot run this command:/);
  assert.match(result.error, /Command blocked by safety policy/);
  assert.equal(workerRequests.length, 0);
});

test("observer mode refuses and sends nothing", async () => {
  const { bridge, workerRequests, chat } = createBridge({ mode: "observer" });
  const result = await bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));
  assert.equal(result.ok, false);
  assert.match(result.error, /observer/);
  assert.equal(workerRequests.length, 0);
});

test("a chat session is required", async () => {
  const { bridge, workerRequests } = createBridge();
  const result = await bridge.dispatchBuiltinRpc("netcatty/execBulk", { command: "uptime", sessionIds: '["ssh-1","ssh-2"]' });
  assert.equal(result.ok, false);
  assert.equal(workerRequests.length, 0);
});

test("invalid input is rejected", async () => {
  const { bridge, workerRequests, chat } = createBridge();
  for (const sessionIds of ["nope", "[]", '["ssh-1"]', '["ssh-1","ssh-1"]']) {
    const result = await bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat, { sessionIds }));
    assert.equal(result.ok, false, sessionIds);
  }
  assert.equal(workerRequests.length, 0);
});

test("confirm mode asks once for all hosts and runs only after approval", async () => {
  const { bridge, workerRequests, chat } = createBridge({ mode: "confirm" });
  const approvals = captureApprovals(bridge);

  const pending = bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));
  await tick();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, "netcatty/execBulk");
  assert.deepEqual(approvals[0].args, {
    command: "uptime",
    sessions: ["ssh-1 (web1)", "ssh-2 (web2)", "ssh-3 (web3)"],
  });
  assert.equal(approvals[0].allowSession, false);
  assert.equal(workerRequests.length, 0, "nothing runs before approval");

  bridge.resolveApprovalFromRenderer(approvals[0].approvalId, true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(workerRequests.length, 3);
});

test("a denied approval sends nothing and frees the sessions", async () => {
  const { bridge, workerRequests, chat } = createBridge({ mode: "confirm" });
  const approvals = captureApprovals(bridge);
  const pending = bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));
  await tick();
  bridge.resolveApprovalFromRenderer(approvals[0].approvalId, false);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /denied/i);
  assert.equal(workerRequests.length, 0);

  // Claims were released: a normal exec on one of the sessions still works.
  bridge.setPermissionMode("auto");
  const single = await bridge.dispatchBuiltinRpc("netcatty/exec", { sessionId: "ssh-1", command: "pwd", chatSessionId: chat });
  assert.equal(single.ok, true);
});

test("remembered grants cannot approve a fan-out", async () => {
  const { bridge, workerRequests, chat } = createBridge({ mode: "confirm" });
  const approvals = captureApprovals(bridge);
  bridge.setPermissionGrants([
    { id: "g1", capabilityId: "terminal.executeBulk", sessionPattern: "*", createdAt: Date.now() },
    { id: "g2", capabilityId: "terminal.execute", sessionPattern: "ssh-1", createdAt: Date.now() },
  ]);
  const pending = bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));
  await tick();
  assert.equal(approvals.length, 1, "approval is still required");
  assert.equal(workerRequests.length, 0);
  bridge.resolveApprovalFromRenderer(approvals[0].approvalId, true);
  await pending;
});

test("session-wide approval never covers a fan-out, and never sweeps a pending one", async () => {
  const { bridge, workerRequests } = createBridge({
    chat: bridgeExternalChat(),
    sessionIds: ["ssh-1", "ssh-2", "ssh-3", "ssh-4"],
    mode: "confirm",
  });
  const chat = bridge.EXTERNAL_MCP_CHAT_SESSION_ID;
  const socket = new EventEmitter();
  socket.destroyed = false;
  bridge.setExternalMcpHooks({ isEnabled: () => true, recordActivity() {} });
  bridge.attachExternalMcpClient(socket);
  const approvals = captureApprovals(bridge);

  // 1. A bulk request from this external client: no session-wide option is offered.
  const bulk = bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat), { externalSocket: socket });
  await tick();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].allowSession, false);

  // 2. A single exec from the same client is offered session approval and gets it.
  const single = bridge.dispatchBuiltinRpc("netcatty/exec", { sessionId: "ssh-4", command: "pwd", chatSessionId: chat }, { externalSocket: socket });
  await tick();
  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].allowSession, true);
  bridge.resolveApprovalFromRenderer(approvals[1].approvalId, true, "session");
  assert.equal((await single).ok, true);

  // 3. The pending fan-out was not swept into that session approval.
  let bulkSettled = false;
  bulk.then(() => { bulkSettled = true; });
  await tick();
  assert.equal(bulkSettled, false, "fan-out still waits for its own approval");
  assert.equal(workerRequests.filter((request) => request.payload.command === "uptime").length, 0);

  // 4. Even a session-scoped answer to the fan-out itself is treated as one-off.
  bridge.resolveApprovalFromRenderer(approvals[0].approvalId, true, "session");
  assert.equal((await bulk).ok, true);
  const again = bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat), { externalSocket: socket });
  await tick();
  assert.equal(approvals.length, 3, "the next fan-out asks again");
  bridge.resolveApprovalFromRenderer(approvals[2].approvalId, false);
  assert.equal((await again).ok, false);
});

function bridgeExternalChat() {
  return require("../cli/externalMcpDiscoveryPath.cjs").EXTERNAL_MCP_CHAT_SESSION_ID;
}

test("a session that is closing or disconnected is reported, not run", async () => {
  const { bridge, workerRequests, chat } = createBridge();
  bridge.updateSessionMetadata([
    { sessionId: "ssh-1", protocol: "ssh", label: "web1", connected: true },
    { sessionId: "ssh-2", protocol: "ssh", label: "web2", connected: false },
    { sessionId: "ssh-3", protocol: "ssh", label: "web3", connected: true },
  ], chat);
  const result = await bridge.dispatchBuiltinRpc("netcatty/execBulk", bulkParams(chat));
  assert.equal(result.ok, false);
  assert.match(result.error, /- ssh-2 \(web2\): Session "ssh-2" is not connected\./);
  assert.equal(workerRequests.length, 0);
});
