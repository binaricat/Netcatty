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
  mutableDeps.permissionMode = PERMISSION_MODES.AUTONOMOUS;
  await liveDispatch("vault/host/get", { hostId: "host-2" });

  assert.deepEqual(seenModes, [PERMISSION_MODES.CONFIRM, PERMISSION_MODES.AUTONOMOUS]);
});

test("implemented vault capabilities do not return CAPABILITY_NOT_IMPLEMENTED", async () => {
  const dispatch = createTestDispatcher();
  const result = await dispatch("vault/host/get", { hostId: "host-1" });
  assert.notEqual(result.code, "CAPABILITY_NOT_IMPLEMENTED");
});
