"use strict";

// --- merged from mcpServerBridge.reconnectingSession.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");

const { isolateCliDiscoveryFile } = require("./cliDiscoveryTestIsolation.cjs");
isolateCliDiscoveryFile();

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

function setup(t, { sessions } = {}) {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: sessions || new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  return bridge;
}

test('reusing a user tab adds visibility without ownership or idle tracking', async (t) => {
  const bridge = setup(t);
  bridge.setVaultAgentInvoker(async () => ({ ok: true, reused: true, sessionId: 'user-tab', hostId: 'host-b', status: 'connected' }));
  await bridge.dispatchBuiltinRpc('public/vault/hosts/open', { chatSessionId: 'chat-b', hostId: 'host-b' });
  assert.deepEqual(bridge.getScopedSessionIds('chat-b'), ['user-tab']);
  assert.equal(bridge.reportOpenedSessionActivity({ sessionId: 'user-tab', phase: 'touch' }), false);
  const close = await bridge.dispatchBuiltinRpc('public/session/close', { chatSessionId: 'chat-b', sessionId: 'user-tab' });
  assert.equal(close.ok, false);
  assert.match(close.error, /not opened by the current AI scope/);
});

test('reuse keeps the original chat owner and its idle tracking', async (t) => {
  const bridge = setup(t);
  const calls = [];
  bridge.setVaultAgentInvoker(async (op, params) => {
    calls.push({ op, params });
    if (op === 'session.close') return { ok: true };
    return { ok: true, reused: params.chatSessionId !== 'owner', sessionId: 'shared-tab', hostId: 'host-b', status: 'connected' };
  });
  for (const chatSessionId of ['owner', 'borrower']) {
    await bridge.dispatchBuiltinRpc('public/vault/hosts/open', { chatSessionId, hostId: 'host-b' });
  }
  assert.equal(bridge.reportOpenedSessionActivity({ sessionId: 'shared-tab', phase: 'touch' }), true);
  assert.equal((await bridge.dispatchBuiltinRpc('public/session/close', { chatSessionId: 'borrower', sessionId: 'shared-tab' })).ok, false);
  assert.equal((await bridge.dispatchBuiltinRpc('public/session/close', { chatSessionId: 'owner', sessionId: 'shared-tab' })).ok, true);
  assert.equal(calls.filter(({ op }) => op === 'session.close').length, 1);
});

test('a deleted chat cannot reclaim a reused tab or revive its own scope', async (t) => {
  const bridge = setup(t);
  let finishOpen;
  const calls = [];
  bridge.updateSessionMetadata([{ sessionId: 'user-tab', connected: true }], 'original');
  bridge.setVaultAgentInvoker((op) => {
    calls.push(op);
    return new Promise((resolve) => { finishOpen = resolve; });
  });
  const opening = bridge.dispatchBuiltinRpc('public/vault/hosts/open', { chatSessionId: 'deleted', hostId: 'host-b' });
  await bridge.cleanupScopedMetadata('deleted');
  bridge.mergeSessionMetadata([{ sessionId: 'user-tab', connected: true }], 'deleted');
  finishOpen({ ok: true, reused: true, sessionId: 'user-tab', status: 'connected' });
  const rejected = await opening;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'SESSION_SCOPE_BIND_FAILED');
  assert.equal(rejected.sessionId, 'user-tab');
  assert.deepEqual(calls, ['host.open']);
  assert.deepEqual(bridge.getScopedSessionIds('deleted'), []);
  assert.deepEqual(bridge.getScopedSessionIds('original'), ['user-tab']);
  assert.equal(bridge.reportOpenedSessionActivity({ sessionId: 'user-tab', phase: 'touch' }), false);
});

test("getContext keeps a scoped disconnected session visible with connected:false", async (t) => {
  const bridge = setup(t);
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-reconnecting",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "chat-1");
  // Connection dropped: renderer pushes connected:false while the tab
  // auto-reconnects. The scope keeps the same sessionId.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-reconnecting",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: false,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "chat-1");

  const environment = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-1",
  });
  const host = environment.hosts.find((entry) => entry.sessionId === "sess-reconnecting");
  assert.ok(host, "reconnecting session must stay visible to the agent");
  assert.equal(host.connected, false);
});

test("getContext keeps a live-map session without transport visible when scoped", async (t) => {
  const bridge = setup(t, {
    sessions: new Map([["sess-live", { hostname: "10.0.0.3", label: "server-c" }]]),
  });
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-live",
      hostname: "10.0.0.3",
      label: "server-c",
      connected: false,
      hostId: "host-c",
      protocol: "ssh",
    },
  ], "chat-1");

  const environment = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-1",
  });
  const host = environment.hosts.find((entry) => entry.sessionId === "sess-live");
  assert.ok(host, "reconnecting live-map session must stay visible");
  assert.equal(host.connected, false);
});

test("getContext still hides disconnected sessions outside the agent scope", async (t) => {
  const bridge = setup(t);
  bridge.updateSessionMetadata([
    {
      sessionId: "foreign",
      hostname: "10.0.0.9",
      label: "foreign",
      connected: false,
      hostId: "host-x",
      protocol: "ssh",
    },
  ], "chat-other");

  const environment = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-1",
  });
  assert.equal(environment.hosts.length, 0);
});

test("external context preserves reconnecting metadata beside another live transport", async (t) => {
  const bridge = setup(t, { sessions: new Map([["online", { hostname: "online", stream: { write() {} } }]]) });
  const scope = bridge.EXTERNAL_MCP_CHAT_SESSION_ID;
  bridge.setExternalMcpHooks({ isEnabled: () => true });
  bridge.updateSessionMetadata([
    { sessionId: "online", hostname: "online", connected: true },
    { sessionId: "retrying", hostname: "retrying", connected: false },
  ], scope);
  const context = await bridge.dispatchBuiltinRpc("netcatty/getContext", { chatSessionId: scope });
  assert.equal(context.hostCount, 2);
  assert.equal(context.hosts.find(host => host.sessionId === "retrying")?.connected, false);
  assert.equal(context.hosts.find(host => host.sessionId === "online")?.connected, true);
  // A renderer-authoritative removal must still remove the closed tab.
  bridge.updateSessionMetadata([{ sessionId: "online", connected: true }], scope);
  const afterClose = await bridge.dispatchBuiltinRpc("netcatty/getContext", { chatSessionId: scope });
  assert.deepEqual(afterClose.hosts.map(host => host.sessionId), ["online"]);
});
}

// --- merged from mcpServerBridge.sessionReconnect.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");
const { isolateCliDiscoveryFile } = require("./cliDiscoveryTestIsolation.cjs");
isolateCliDiscoveryFile();

test("live bridge reconnect requires scope, respects cancellation and never grants close ownership", async (t) => {
  require("../shared/aiPrivacyService.cjs").configure({ enabled: false });
  const bridge = require("./mcpServerBridge.cjs");
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  let calls = 0;
  bridge.setVaultAgentInvoker(async (op, params) => {
    assert.equal(op, "session.reconnect");
    assert.equal(params.sessionId, "s");
    calls++;
    return { ok: true, started: true, sessionId: "s", status: "reconnecting" };
  });
  bridge.updateSessionMetadata([{ sessionId: "s", connected: false, protocol: "ssh" }], "chat");
  assert.equal((await bridge.dispatchBuiltinRpc("session/reconnect", { sessionId: "s", chatSessionId: "other" })).ok, false);
  assert.equal(calls, 0);
  const result = await bridge.dispatchBuiltinRpc("session/reconnect", { sessionId: "s", chatSessionId: "chat" });
  assert.equal(result.started, true);
  assert.equal(calls, 1);
  const close = await bridge.dispatchBuiltinRpc("session/close", { sessionId: "s", chatSessionId: "chat" });
  assert.equal(close.ok, false);
  bridge.setChatSessionCancelled("chat", true);
  assert.match((await bridge.dispatchBuiltinRpc("session/reconnect", { sessionId: "s", chatSessionId: "chat" })).error, /cancelled/i);
  assert.equal(calls, 1);
});

test('root recovery observes live prompt readiness without executing commands and stops for auth', async (t) => {
  const bridge = require('./mcpServerBridge.cjs');
  t.after(() => bridge.cleanup());
  const runtime = { protocol: 'ssh', _promptTrackTail: 'root@host:~# ', lastIdlePrompt: 'root@host:~# ' };
  bridge.init({ sessions: new Map([['ready', runtime]]), electronModule: null });
  bridge.setPermissionMode('auto');
  bridge.updateSessionMetadata([{ sessionId: 'ready', protocol: 'ssh', connected: true }], 'recover-chat');
  let inspections = 0;
  let auth = false;
  bridge.setVaultAgentInvoker(async (op, params, options) => {
    assert.equal(op, 'session.inspectRecovery');
    assert.equal(params.sessionId, 'ready');
    assert.ok(options.timeoutMs <= 2000);
    inspections++;
    return { ok: true, status: 'connected', waitingForInput: auth };
  });
  assert.equal((await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'ready', chatSessionId: 'foreign' })).ok, false);
  assert.equal(inspections, 0);
  const result = await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'ready', chatSessionId: 'recover-chat' });
  assert.equal(result.status, 'ready');
  assert.equal(result.shellReady, true);
  auth = true;
  assert.equal((await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'ready', chatSessionId: 'recover-chat' })).status, 'needs_input');
  bridge.setPermissionMode('observer');
  assert.equal((await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'ready', chatSessionId: 'recover-chat' })).ok, false);
  assert.equal(inspections, 2);
});

test('worker-owned SSH sessions resolve prompt readiness through the terminal worker', async (t) => {
  const bridge = require('./mcpServerBridge.cjs');
  t.after(() => bridge.cleanup());
  const readinessRequests = [];
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload) {
        if (channel === 'netcatty:ai:shellReadiness') {
          readinessRequests.push(payload.sessionId);
          if (payload.sessionId === 'worker-ready') {
            return Promise.resolve({
              ok: true,
              found: true,
              trackedShell: true,
              freshIdlePrompt: 'root@host:~# ',
              visibleIdlePrompt: 'root@host:~# ',
            });
          }
          if (payload.sessionId === 'worker-false') {
            return Promise.resolve({ ok: true, found: true, trackedShell: true, freshIdlePrompt: '', visibleIdlePrompt: '' });
          }
          if (payload.sessionId === 'worker-untracked') {
            return Promise.resolve({ ok: true, found: true, trackedShell: false, freshIdlePrompt: '', visibleIdlePrompt: '' });
          }
          return Promise.resolve({ ok: true, found: false });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode('auto');
  bridge.updateSessionMetadata([{ sessionId: 'worker-ready', protocol: 'ssh', connected: true }], 'worker-chat');
  let inspections = 0;
  bridge.setVaultAgentInvoker(async (op, params) => {
    assert.equal(op, 'session.inspectRecovery');
    assert.equal(params.sessionId, 'worker-ready');
    inspections++;
    return { ok: true, status: 'connected' };
  });
  // The SSH runtime exists only in the worker; recovery must consult it and
  // return ready instead of looping on a false shellReady.
  const result = await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'worker-ready', chatSessionId: 'worker-chat' });
  assert.equal(result.status, 'ready');
  assert.equal(result.shellReady, true);
  assert.deepEqual(readinessRequests, ['worker-ready']);
  // A confirmed not-idle prompt stays advisory: recovery completes with a
  // hint instead of looping, since it never writes to the PTY.
  bridge.updateSessionMetadata([{ sessionId: 'worker-false', protocol: 'ssh', connected: true }], 'worker-chat');
  bridge.setVaultAgentInvoker(async (op, params) => {
    assert.equal(op, 'session.inspectRecovery');
    inspections++;
    return { ok: true, status: 'connected' };
  });
  const unconfirmed = await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'worker-false', chatSessionId: 'worker-chat' });
  assert.equal(unconfirmed.status, 'ready');
  assert.equal(unconfirmed.shellReady, false);
  assert.equal(unconfirmed.nextAction, 'inspect_shell');
  // An untracked worker shell stays unknown (null), never falsely ready.
  bridge.updateSessionMetadata([{ sessionId: 'worker-untracked', protocol: 'ssh', connected: true }], 'worker-chat');
  bridge.setVaultAgentInvoker(async (op, params) => {
    assert.equal(op, 'session.inspectRecovery');
    inspections++;
    return { ok: true, status: 'connected' };
  });
  const untracked = await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'worker-untracked', chatSessionId: 'worker-chat' });
  assert.equal(untracked.status, 'ready');
  assert.equal(untracked.shellReady, null);
  assert.equal(untracked.nextAction, 'inspect_shell');
  assert.equal(inspections, 3);
});

test('a hung worker readiness probe times out and recovery completes with an advisory hint', async (t) => {
  const bridge = require('./mcpServerBridge.cjs');
  t.after(() => bridge.cleanup());
  // Synthetic regression for the unresolved P2: a live-but-unresponsive
  // worker left `await terminalWorkerManager.request` pending forever, so
  // recovery hung inside ctx.inspect and never reached its deadline or
  // released the session's running lock. The probe must be bounded instead.
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel) {
        if (channel === 'netcatty:ai:shellReadiness') {
          // Never settles, like a hung-but-live worker process.
          return new Promise(() => {});
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode('auto');
  bridge.updateSessionMetadata([{ sessionId: 'worker-hang', protocol: 'ssh', connected: true }], 'hang-chat');
  let inspections = 0;
  bridge.setVaultAgentInvoker(async (op, params) => {
    assert.equal(op, 'session.inspectRecovery');
    assert.equal(params.sessionId, 'worker-hang');
    inspections++;
    return { ok: true, status: 'connected' };
  });
  const startedAt = Date.now();
  const result = await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'worker-hang', chatSessionId: 'hang-chat' });
  const elapsed = Date.now() - startedAt;
  // The hung probe held for its timeout bound, yielded an unknown state,
  // and recovery completed on the connected transport truth instead of
  // looping: shellReady is an advisory null with an inspect_shell hint.
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.shellReady, null);
  assert.equal(result.nextAction, 'inspect_shell');
  assert.ok(elapsed >= 1900, `recovery settled too early (${elapsed}ms): probe timeout did not engage`);
  assert.ok(elapsed < 15000, `recovery hung for ${elapsed}ms`);
  assert.equal(inspections, 1);
  // The running lock must be released: a follow-up recovery proceeds at once.
  const secondStartedAt = Date.now();
  const second = await bridge.dispatchBuiltinRpc('session/recover', { sessionId: 'worker-hang', chatSessionId: 'hang-chat' });
  assert.equal(second.status, 'ready');
  assert.equal(second.shellReady, null);
  assert.ok(Date.now() - secondStartedAt < 15000, 'running lock was not released after the timeout');
  assert.equal(inspections, 2);
});
}
