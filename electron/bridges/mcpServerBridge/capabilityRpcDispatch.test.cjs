"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCapabilityRpcDispatcher, UNROUTED } = require("./capabilityRpcDispatch.cjs");
const { CAPABILITY_SURFACES, PERMISSION_MODES } = require("../../capabilities/constants.cjs");

function createTestDispatcher(overrides = {}) {
  const invokeVaultAgent = overrides.invokeVaultAgent || (async (op, params) => ({
    ok: true,
    op,
    params,
  }));
  const requestApprovalFromRenderer = overrides.requestApprovalFromRenderer
    || (async () => true);

  return createCapabilityRpcDispatcher({
    invokeVaultAgent,
    evaluatePermissionWithGrants: overrides.evaluatePermissionWithGrants || ((input, grants) => ({
      allowed: true,
      requiresApproval: false,
      grants,
      ...input,
    })),
    permissionMode: overrides.permissionMode || PERMISSION_MODES.CONFIRM,
    permissionGrantsSnapshot: [],
    isChatSessionCancelled: () => false,
    requestApprovalFromRenderer,
    USER_DENIED_MESSAGE: "User denied the operation.",
    ...overrides,
  });
}

test("dispatchCapabilityRpc returns UNROUTED for netcatty builtin methods", async () => {
  const dispatch = createTestDispatcher();
  const result = await dispatch("netcatty/exec", { chatSessionId: "chat-1" });
  assert.equal(result, UNROUTED);
});

test("dispatchCapabilityRpc routes vault host notes get to vault service", async () => {
  let invokedOp = null;
  const dispatch = createTestDispatcher({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      return { ok: true, hostId: params.hostId, notes: "notes" };
    },
  });

  const result = await dispatch("vault/host/notes/get", { hostId: "host-1" });
  assert.equal(invokedOp, "host.notes.get");
  assert.equal(result.ok, true);
  assert.equal(result.notes, "notes");
});

test("dispatchCapabilityRpc routes public vault host notes set through approval", async () => {
  const approvalCalls = [];
  const dispatch = createTestDispatcher({
    evaluatePermissionWithGrants: () => ({
      allowed: true,
      requiresApproval: true,
    }),
    requestApprovalFromRenderer: async (toolName, args, chatSessionId) => {
      approvalCalls.push({ toolName, args, chatSessionId });
      return true;
    },
    invokeVaultAgent: async (op, params) => ({
      ok: true,
      op,
      hostId: params.hostId,
      notes: params.notes,
    }),
  });

  const result = await dispatch("public/vault/hostNotes/set", {
    chatSessionId: "chat-1",
    hostId: "host-1",
    notes: "updated",
  });

  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0].toolName, "host_notes_set");
  assert.equal(result.ok, true);
  assert.equal(result.notes, "updated");
});

test("dispatchCapabilityRpc asks for approval before importing vault notes from the CLI rpc", async () => {
  const approvalCalls = [];
  let invokedOp = null;
  const dispatch = createTestDispatcher({
    evaluatePermissionWithGrants: () => ({
      allowed: true,
      requiresApproval: true,
    }),
    requestApprovalFromRenderer: async (toolName, args, chatSessionId) => {
      approvalCalls.push({ toolName, args, chatSessionId });
      return true;
    },
    invokeVaultAgent: async (op) => {
      invokedOp = op;
      return { ok: true, importedCount: 1, notes: [] };
    },
  });

  const result = await dispatch("vault/notes/import", {
    chatSessionId: "chat-1",
    content: "# Steps",
    fileName: "runbook.md",
  });

  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0].toolName, "vault_notes_import");
  assert.equal(approvalCalls[0].chatSessionId, "chat-1");
  assert.equal(approvalCalls[0].args.content, "# Steps");
  assert.equal(invokedOp, "note.import");
  assert.equal(result.importedCount, 1);
});

test("dispatchCapabilityRpc denies vault note import when the user rejects it", async () => {
  let invoked = false;
  const dispatch = createTestDispatcher({
    evaluatePermissionWithGrants: () => ({
      allowed: true,
      requiresApproval: true,
    }),
    requestApprovalFromRenderer: async () => false,
    invokeVaultAgent: async () => {
      invoked = true;
      return { ok: true };
    },
  });

  const result = await dispatch("vault/notes/import", {
    chatSessionId: "chat-1",
    content: "# Steps",
  });

  assert.equal(invoked, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /denied/i);
});

test("dispatchCapabilityRpc denies public vault host notes set when approval rejected", async () => {
  const dispatch = createTestDispatcher({
    evaluatePermissionWithGrants: () => ({
      allowed: true,
      requiresApproval: true,
    }),
    requestApprovalFromRenderer: async () => false,
  });

  const result = await dispatch("public/vault/hostNotes/set", {
    chatSessionId: "chat-1",
    hostId: "host-1",
    notes: "updated",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /denied/i);
});

test("dispatchCapabilityRpc closes an owned session through the renderer bridge", async () => {
  const calls = [];
  const closed = [];
  const lifecycle = [];
  const dispatch = createTestDispatcher({
    validateSessionClose: (params) => {
      assert.equal(params.chatSessionId, "chat-1");
      assert.equal(params.sessionId, "session-1");
      return { ok: true };
    },
    beforeSessionClose: async () => {
      await Promise.resolve();
      lifecycle.push("sftp-clean");
    },
    afterSessionClose: async () => {
      lifecycle.push("close-finished");
    },
    onSessionClosed: async (sessionId) => {
      await Promise.resolve();
      lifecycle.push("session-jobs-settled");
      closed.push(sessionId);
    },
    invokeVaultAgent: async (op, params) => {
      lifecycle.push("session-close");
      calls.push({ op, params });
      return { ok: true, sessionId: params.sessionId, status: "closed" };
    },
  });

  const result = await dispatch("public/session/close", {
    chatSessionId: "chat-1",
    sessionId: "session-1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ op: "session.close", params: { sessionId: "session-1" } }]);
  assert.deepEqual(closed, ["session-1"]);
  assert.deepEqual(lifecycle, ["sftp-clean", "session-close", "session-jobs-settled", "close-finished"]);
});

test("dispatchCapabilityRpc refuses to close a session outside ownership", async () => {
  let invoked = false;
  const dispatch = createTestDispatcher({
    validateSessionClose: () => ({ ok: false, error: "not owned" }),
    invokeVaultAgent: async () => {
      invoked = true;
      return { ok: true };
    },
  });

  const result = await dispatch("public/session/close", {
    chatSessionId: "chat-1",
    sessionId: "session-2",
  });

  assert.equal(result.ok, false);
  assert.equal(invoked, false);
});

test("dispatchCapabilityRpc preserves the host-open scope generation across the async bridge", async () => {
  const registrations = [];
  const dispatch = createTestDispatcher({
    captureHostOpenScope: (chatSessionId) => {
      assert.equal(chatSessionId, "chat-1");
      return 7;
    },
    onHostOpened: (chatSessionId, sessionId, generation, result) => {
      registrations.push({ chatSessionId, sessionId, generation, result });
    },
    invokeVaultAgent: async () => ({ ok: true, sessionId: "session-1" }),
  });

  await dispatch("public/vault/hosts/open", { chatSessionId: "chat-1", hostId: "host-1" });

  assert.deepEqual(registrations, [{
    chatSessionId: "chat-1",
    sessionId: "session-1",
    generation: 7,
    result: { ok: true, sessionId: "session-1" },
  }]);
});

test("dispatchCapabilityRpc routes vault hosts create to vault service", async () => {
  let invokedOp = null;
  const dispatch = createTestDispatcher({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      return { ok: true, addedCount: 1, previewHosts: [] , params };
    },
  });

  const result = await dispatch("vault/hosts/create", {
    hosts: JSON.stringify([{ hostname: "10.2.0.209", username: "root" }]),
    dryRun: "true",
  });
  assert.equal(invokedOp, "hosts.create");
  assert.equal(result.ok, true);
});

test("dispatchCapabilityRpc routes vault host update to vault service", async () => {
  let invokedOp = null;
  let invokedParams = null;
  const dispatch = createTestDispatcher({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      invokedParams = params;
      return { ok: true, hostId: params.hostId };
    },
  });

  const result = await dispatch("vault/hosts/update", {
    hostId: "host-1",
    label: "updated",
  });
  assert.equal(invokedOp, "host.update");
  assert.equal(invokedParams.label, "updated");
  assert.equal(result.ok, true);
});

test("dispatchCapabilityRpc routes vault host delete to vault service", async () => {
  let invokedOp = null;
  const dispatch = createTestDispatcher({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      return { ok: true, hostId: params.hostId };
    },
  });

  const result = await dispatch("vault/hosts/delete", { hostId: "host-1" });
  assert.equal(invokedOp, "host.delete");
  assert.equal(result.ok, true);
});

test("dispatchCapabilityRpc routes vault hosts import to vault service", async () => {
  let invokedOp = null;
  const dispatch = createTestDispatcher({
    invokeVaultAgent: async (op) => {
      invokedOp = op;
      return { ok: true, addedCount: 0 };
    },
  });

  const result = await dispatch("vault/hosts/import", {
    format: "csv",
    text: "hostname,username\n10.0.0.1,root\n",
    dryRun: "true",
  });
  assert.equal(invokedOp, "host.import");
  assert.equal(result.ok, true);
});

test("dispatchCapabilityRpc routes portforward start to portforward service", async () => {
  let invokedOp = null;
  const dispatch = createTestDispatcher({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      return { ok: true, ruleId: params.ruleId, status: "active" };
    },
  });

  const result = await dispatch("portforward/start", {
    chatSessionId: "chat-1",
    ruleId: "rule-1",
  });
  assert.equal(invokedOp, "portforward.start");
  assert.equal(result.ok, true);
  assert.equal(result.ruleId, "rule-1");
});

test("dispatchCapabilityRpc lists port forwards from the configured runtime", async () => {
  const calls = [];
  const dispatch = createTestDispatcher({
    listPortForwards: async () => {
      calls.push("list");
      return [{ tunnelId: "worker-pf", status: "active" }];
    },
  });

  const result = await dispatch("portforward/tunnels/list", {});
  assert.deepEqual(result, {
    ok: true,
    tunnels: [{ tunnelId: "worker-pf", status: "active" }],
  });
  assert.deepEqual(calls, ["list"]);
});

test("dispatchCapabilityRpc reads permissionMode from deps on each call", async () => {
  const seenModes = [];
  const mutableDeps = { permissionMode: PERMISSION_MODES.CONFIRM };
  const liveDispatch = createCapabilityRpcDispatcher({
    invokeVaultAgent: async () => ({ ok: true }),
    evaluatePermissionWithGrants: (input) => {
      seenModes.push(input.permissionMode);
      return { allowed: true, requiresApproval: false };
    },
    get permissionMode() {
      return mutableDeps.permissionMode;
    },
    permissionGrantsSnapshot: [],
    isChatSessionCancelled: () => false,
    requestApprovalFromRenderer: async () => true,
    USER_DENIED_MESSAGE: "User denied the operation.",
  });

  await liveDispatch("vault/host/get", { hostId: "host-1" });
  mutableDeps.permissionMode = PERMISSION_MODES.AUTO;
  await liveDispatch("vault/host/get", { hostId: "host-2" });

  assert.deepEqual(seenModes, [PERMISSION_MODES.CONFIRM, PERMISSION_MODES.AUTO]);
});

test("implemented vault capabilities do not return CAPABILITY_NOT_IMPLEMENTED", async () => {
  const dispatch = createTestDispatcher();
  const result = await dispatch("vault/host/get", { hostId: "host-1" });
  assert.notEqual(result.code, "CAPABILITY_NOT_IMPLEMENTED");
});
