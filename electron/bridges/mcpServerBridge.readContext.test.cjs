"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");

function setup(t, mode = "confirm") {
  const path = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[path];
  const bridge = require(path);
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode(mode);
  bridge.updateSessionMetadata([{ sessionId: "a" }, { sessionId: "b" }], "chat");
  t.after(() => bridge.cleanup());
  return bridge;
}
for (const mode of ["observer", "confirm", "auto"]) {
  test(`screen reads work without approval in ${mode} mode`, async (t) => {
    const bridge = setup(t, mode);
    const calls = [];
    bridge.setVaultAgentInvoker(async (op, params) => {
      calls.push({ op, params });
      return { ok: true, content: "existing output" };
    });
    const tool = listMcpTools().find((tool) => tool.mcpTool === "terminal_read_context");
    const result = await bridge.dispatchBuiltinRpc(tool.rpcMethod, {
      chatSessionId: "chat", sessionId: "b", range: "tail", maxLines: 10,
    });
    assert.equal(result.content, "existing output");
    assert.deepEqual(calls, [{ op: "terminal.readContext", params: {
      sessionId: "b", range: "tail", startLine: undefined, maxLines: 10,
    } }]);
  });
}
test("missing, ambiguous, empty and foreign scopes never reach the renderer", async (t) => {
  const bridge = setup(t);
  bridge.setVaultAgentInvoker(() => assert.fail("must not read"));
  for (const params of [
    {}, { sessionId: "a" }, { chatSessionId: "chat" },
    { chatSessionId: "chat", sessionId: "foreign" },
    { chatSessionId: "chat", sessionId: "a", scopedSessionIds: [] },
    { chatSessionId: "chat", sessionId: "foreign", scopedSessionIds: ["foreign"] },
  ]) assert.equal((await bridge.dispatchBuiltinRpc("netcatty/readContext", params)).ok, false);
});
test("one allowed terminal is inferred and revoked scope suppresses the result", async (t) => {
  const bridge = setup(t);
  bridge.setVaultAgentInvoker(async (_op, params) => ({ ok: true, sessionId: params.sessionId }));
  const result = await bridge.dispatchBuiltinRpc("netcatty/readContext", {
    chatSessionId: "chat", scopedSessionIds: ["b"],
  });
  assert.equal(result.sessionId, "b");
  bridge.setVaultAgentInvoker(async () => {
    bridge.updateSessionMetadata([], "chat");
    return { ok: true, content: "do not disclose" };
  });
  const revoked = await bridge.dispatchBuiltinRpc("netcatty/readContext", {
    chatSessionId: "chat", sessionId: "a",
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.content, undefined);
});

test("read dispatch resolves the owning popup for legacy and worker sessions", async (t) => {
  const bridge = setup(t);
  const popup = { id: 22, isDestroyed: () => false };
  for (const worker of [false, true]) {
    bridge.init({
      sessions: new Map(worker ? [] : [["a", { webContentsId: 22 }]]),
      electronModule: { webContents: { fromId: (id) => id === 22 ? popup : null } },
      terminalWorkerManager: worker ? { getSessionOwnerWebContentsId: () => 22 } : null,
    });
    bridge.setVaultAgentInvoker(async (_op, params, options) => {
      assert.equal(options.webContents, popup);
      return { ok: true, sessionId: params.sessionId };
    });
    assert.equal((await bridge.dispatchBuiltinRpc("netcatty/readContext", {
      sessionId: "a", chatSessionId: "chat",
    })).ok, true);
  }
});
