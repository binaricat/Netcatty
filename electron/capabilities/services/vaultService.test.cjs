"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createVaultService } = require("./vaultService.cjs");

test("vault service delegates host notes read to vault agent bridge", async () => {
  let invokedOp = null;
  const service = createVaultService({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      return { ok: true, hostId: params.hostId, notes: "hello" };
    },
  });
  const result = await service.getHostNotes({ hostId: "host-1" });
  assert.equal(invokedOp, "host.notes.get");
  assert.equal(result.ok, true);
  assert.equal(result.notes, "hello");
});

test("vault service returns bridge unavailable when renderer bridge missing", async () => {
  const service = createVaultService({});
  const result = await service.listSnippets();
  assert.equal(result.ok, false);
  assert.match(result.error, /unavailable/i);
});

test("vault service delegates host open to vault agent bridge", async () => {
  let invokedOp = null;
  let invokedParams = null;
  const service = createVaultService({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      invokedParams = params;
      return { ok: true, sessionId: "sess-1", hostId: params.hostId, status: "connecting" };
    },
  });
  const result = await service.openHost({ hostId: "host-1", chatSessionId: "chat-1" });
  assert.equal(invokedOp, "host.open");
  assert.equal(invokedParams.hostId, "host-1");
  assert.equal(invokedParams.chatSessionId, "chat-1");
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "sess-1");
});

test("vault service delegates host update and delete to vault agent bridge", async () => {
  const calls = [];
  const service = createVaultService({
    invokeVaultAgent: async (op, params) => {
      calls.push({ op, params });
      return { ok: true, hostId: params.hostId };
    },
  });

  await service.updateHost({ hostId: "host-1", label: "new" });
  await service.deleteHost({ hostId: "host-1", ignored: "value" });

  assert.equal(calls[0].op, "host.update");
  assert.equal(calls[0].params.label, "new");
  assert.equal(calls[1].op, "host.delete");
  assert.deepEqual(calls[1].params, { hostId: "host-1" });
});

test("vault service delegates note import", async () => {
  let invokedOp = null;
  let invokedParams = null;
  const service = createVaultService({
    invokeVaultAgent: async (op, params) => {
      invokedOp = op;
      invokedParams = params;
      return { ok: true, importedCount: 1 };
    },
  });
  const result = await service.importNotes({ content: "# Steps", fileName: "runbook.md" });
  assert.equal(invokedOp, "note.import");
  assert.equal(invokedParams.fileName, "runbook.md");
  assert.equal(result.importedCount, 1);
});

test("vault service delegates identities, groups, proxies, and note deletion", async () => {
  const calls = [];
  const service = createVaultService({
    invokeVaultAgent: async (op, params) => {
      calls.push({ op, params });
      return { ok: true };
    },
  });
  await service.listIdentities();
  await service.listProxyProfiles();
  await service.listGroups();
  await service.createGroup({ path: "prod" });
  await service.updateGroup({ path: "prod", defaults: "{}" });
  await service.deleteGroup({ path: "prod" });
  await service.deleteNote({ noteId: "note-1" });
  assert.deepEqual(calls.map((call) => call.op), [
    "identity.list", "proxyProfile.list", "group.list", "group.create", "group.update", "group.delete", "note.delete",
  ]);
});
