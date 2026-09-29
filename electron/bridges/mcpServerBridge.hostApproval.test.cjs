"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createNdjsonRpcClient } = require("../capabilities/rpcTransport.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const bridge = require("./mcpServerBridge.cjs");

test("external MCP approval names the host and isolates connection and host grants", async (t) => {
  const dir = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("host-approval")}-`);
  const clients = [];
  t.after(() => {
    for (const client of clients) client.close();
    bridge.disconnectExternalMcpClients();
    bridge.setMainWindowGetter(() => null);
    bridge.setVaultAgentInvoker(null);
    bridge.setExternalMcpHooks(null);
    bridge.setPermissionGrants([]);
    bridge.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const approvals = [];
  const waiters = [];
  const nextApproval = () => new Promise((resolve) => waiters.push(resolve));
  bridge.init({
    sessions: new Map(),
    cliDiscoveryFilePath: path.join(dir, "discovery.json"),
    terminalWorkerManager: {
      request: async () => ({ ok: true, stdout: "done", stderr: "", exitCode: 0 }),
    },
  });
  bridge.setMainWindowGetter(() => ({
    isDestroyed: () => false,
    webContents: {
      id: 42,
      send(channel, payload) {
        if (channel !== "netcatty:ai:mcp:approval-request") return;
        approvals.push(payload);
        waiters.shift()?.(payload);
      },
    },
  }));
  let externalEnabled = true;
  bridge.setExternalMcpHooks({ isEnabled: () => externalEnabled, recordActivity: () => {} });
  bridge.setPermissionMode("confirm");
  bridge.setCommandBlocklist([]);
  bridge.setVaultAgentInvoker(async () => ({ ok: true }));
  const token = bridge.issueExternalMcpAuthToken();
  const port = await bridge.getOrCreateHost();
  bridge.updateSessionMetadata([
    { sessionId: "ssh-test", hostId: "host-test", savedHostId: "host-test", label: "Test server", hostname: "test.local", protocol: "ssh", connected: true },
    { sessionId: "ssh-prod", hostId: "host-prod", savedHostId: "host-prod", label: "Production", hostname: "prod.local", protocol: "ssh", connected: true },
  ], bridge.EXTERNAL_MCP_CHAT_SESSION_ID);

  async function connect() {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = createNdjsonRpcClient({ socket });
    clients.push(client);
    assert.equal((await client.call("auth/verify", { token })).ok, true);
    return client;
  }

  const clientA = await connect();
  const clientB = await connect();
  const exec = (client, sessionId) => client.call("netcatty/exec", {
    sessionId,
    chatSessionId: bridge.EXTERNAL_MCP_CHAT_SESSION_ID,
    command: "date",
  });

  const firstApproval = nextApproval();
  const firstCall = exec(clientA, "ssh-test");
  const request = await firstApproval;
  assert.deepEqual(request.target, {
    sessionId: "ssh-test", hostId: "host-test", label: "Test server", hostname: "test.local",
  });
  assert.equal(request.allowSession, true);
  bridge.resolveApprovalFromRenderer(request.approvalId, true, "session");
  assert.equal((await firstCall).ok, true);

  assert.equal((await exec(clientA, "ssh-prod")).ok, true);
  assert.equal(approvals.length, 1, "session approval stays on the first connection");

  const secondApproval = nextApproval();
  const secondCall = exec(clientB, "ssh-prod");
  const prodRequest = await secondApproval;
  assert.equal(prodRequest.target.label, "Production");
  bridge.resolveApprovalFromRenderer(prodRequest.approvalId, false);
  assert.equal((await secondCall).ok, false);

  bridge.setPermissionGrants([{
    id: "allow-test-host", capabilityId: "*", sessionPattern: "host:host-test", createdAt: Date.now(),
  }]);
  assert.equal((await exec(clientB, "ssh-test")).ok, true);
  assert.equal(approvals.length, 2, "host grant applies to the second connection without approving production");

  bridge.setPermissionGrants([]);
  clientA.close();
  const clientC = await connect();
  const thirdApproval = nextApproval();
  const thirdCall = exec(clientC, "ssh-test");
  const reconnectRequest = await thirdApproval;
  assert.equal(reconnectRequest.target.label, "Test server");
  bridge.resolveApprovalFromRenderer(reconnectRequest.approvalId, false);
  assert.equal((await thirdCall).ok, false, "a new connection does not inherit temporary approval");

  const pendingA = nextApproval();
  const pendingB = nextApproval();
  const callA = clientB.call("public/vault/hosts/delete", { hostId: "missing-a" });
  const callB = clientB.call("public/vault/hosts/update", { hostId: "missing-b", label: "test" });
  const [approvalA, approvalB] = await Promise.all([pendingA, pendingB]);
  assert.equal(bridge.resolveApprovalFromRenderer(approvalA.approvalId, true, "session"), true);
  assert.equal((await callA).ok, true);
  assert.equal((await callB).ok, true, "connection approval clears other pending requests on that socket");
  assert.equal(bridge.resolveApprovalFromRenderer(approvalB.approvalId, true), false);

  bridge.revokeExternalMcpAuthToken();
  const afterRevoke = nextApproval();
  const afterRevokeCall = exec(clientB, "ssh-test");
  const revokeRequest = await afterRevoke;
  bridge.resolveApprovalFromRenderer(revokeRequest.approvalId, false);
  assert.equal((await afterRevokeCall).ok, false, "re-enabling requires fresh approval");

  bridge.updateSessionMetadata([
    { sessionId: "local-test", hostId: "local-1", savedHostId: "", label: "Local Terminal", hostname: "localhost", protocol: "local", connected: true },
  ], bridge.EXTERNAL_MCP_CHAT_SESSION_ID);
  const localApproval = nextApproval();
  const localCall = exec(clientB, "local-test");
  const localRequest = await localApproval;
  assert.equal(localRequest.target.label, "Local Terminal");
  assert.equal(localRequest.target.hostname, "localhost");
  assert.equal(localRequest.target.hostId, "", "local sessions cannot get a persistent host grant");
  bridge.resolveApprovalFromRenderer(localRequest.approvalId, false);
  assert.equal((await localCall).ok, false);

  const staleApproval = nextApproval();
  const staleCall = exec(clientC, "local-test");
  const staleRequest = await staleApproval;
  externalEnabled = false;
  assert.equal(bridge.resolveApprovalFromRenderer(staleRequest.approvalId, true), false);
  assert.equal((await staleCall).ok, false);
});
