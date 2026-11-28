"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");

// Keep bridge discovery writes/deletes off the installed app's live file.
const { isolateCliDiscoveryFile } = require("./cliDiscoveryTestIsolation.cjs");
isolateCliDiscoveryFile();

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
test("ordinary readContext never forwards internal includeReadinessContext even if passed in params", async (t) => {
  const bridge = setup(t, "observer");
  const calls = [];
  bridge.setVaultAgentInvoker(async (op, params) => {
    calls.push({ op, params });
    return { ok: true, content: "bounded output" };
  });
  const result = await bridge.dispatchBuiltinRpc("netcatty/readContext", {
    chatSessionId: "chat",
    sessionId: "a",
    range: "tail",
    maxLines: 5,
    includeReadinessContext: true,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal("includeReadinessContext" in calls[0].params, false);
});
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

test("readRemoteScreen enforces scope, protocol, and directs terminal_read_context errors to remote_desktop_read_screen", async (t) => {
  const bridge = setup(t, "observer");
  bridge.updateSessionMetadata([
    { sessionId: "ssh-1", protocol: "ssh", connected: true },
    { sessionId: "rdp-1", protocol: "rdp", connected: true },
  ], "chat");

  const calls = [];
  bridge.setVaultAgentInvoker(async (op, params) => {
    calls.push({ op, params });
    return {
      ok: true,
      captureId: "rdcap-99",
      sessionId: params.sessionId,
      mediaType: "image/jpeg",
      base64Data: "QUJD",
    };
  });

  // terminal_read_context on RDP points to remote_desktop_read_screen
  const wrongTerm = await bridge.dispatchBuiltinRpc("netcatty/readContext", {
    chatSessionId: "chat",
    sessionId: "rdp-1",
  });
  assert.equal(wrongTerm.ok, false);
  assert.match(wrongTerm.error, /remote_desktop_read_screen/);

  // remote_desktop_read_screen on SSH fails with clear hint
  const wrongRd = await bridge.dispatchBuiltinRpc("netcatty/readRemoteScreen", {
    chatSessionId: "chat",
    sessionId: "ssh-1",
  });
  assert.equal(wrongRd.ok, false);
  assert.match(wrongRd.error, /terminal_read_context/);

  // Infers sole remote desktop session when workspace also has SSH
  const okRes = await bridge.dispatchBuiltinRpc("netcatty/readRemoteScreen", {
    chatSessionId: "chat",
    quality: "high",
    cropX: 100,
    cropY: 200,
    cropWidth: 300,
    cropHeight: 200,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.base64Data, "QUJD");
  assert.deepEqual(calls, [{
    op: "remoteDesktop.readScreen",
    params: {
      sessionId: "rdp-1",
      quality: "high",
      cropX: 100,
      cropY: 200,
      cropWidth: 300,
      cropHeight: 200,
    },
  }]);

  // Scope revoked mid-capture suppresses result
  bridge.setVaultAgentInvoker(async () => {
    bridge.updateSessionMetadata([], "chat");
    return { ok: true, base64Data: "SECRET_FRAME" };
  });
  const revoked = await bridge.dispatchBuiltinRpc("netcatty/readRemoteScreen", {
    chatSessionId: "chat",
    sessionId: "rdp-1",
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.base64Data, undefined);
});
