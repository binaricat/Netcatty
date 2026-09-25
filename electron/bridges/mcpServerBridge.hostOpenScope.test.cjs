"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { isolateCliDiscoveryFile } = require("./cliDiscoveryTestIsolation.cjs");
isolateCliDiscoveryFile();

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  // Also clear retain/ownership deps so a fresh bridge gets fresh module state.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${require("node:path").sep}mcpServerBridge${require("node:path").sep}`)) {
      delete require.cache[key];
    }
  }
  return require("./mcpServerBridge.cjs");
}

test("sidebar scope replace keeps host_open-owned sessions in the chat scope", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({
    sessions: new Map(),
    electronModule: null,
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async (op) => {
    if (op === "host.open") {
      return { ok: true, sessionId: "sess-opened", hostId: "host-b", status: "connecting" };
    }
    return { ok: false, error: `unexpected op ${op}` };
  });

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: false,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "chat-1");

  const opened = await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.sessionId, "sess-opened");

  // AIChatSidePanel-style full replace of only the focused tab.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");

  assert.deepEqual(
    bridge.getScopedSessionIds("chat-1").sort(),
    ["sess-opened", "sess-original"],
  );
});

test("authoritative empty scope replace still clears host_open-owned sessions", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({
    sessions: new Map(),
    electronModule: null,
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  bridge.updateSessionMetadata([
    { sessionId: "sess-opened", hostname: "10.0.0.2", label: "server-b", connected: false },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });

  bridge.updateSessionMetadata([], "chat-1");
  assert.deepEqual(bridge.getScopedSessionIds("chat-1"), []);

  // A later non-empty sync must not resurrect the cleared owned session via
  // cross-scope fallback / stale ownership.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
    },
  ], "__external_mcp__");
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");
  assert.deepEqual(bridge.getScopedSessionIds("chat-1"), ["sess-original"]);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-1"), null);
});

test("retained host_open metadata refreshes connected from another scope", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({
    sessions: new Map(),
    electronModule: null,
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: false,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });

  // Another surface (External MCP / opened tab) learns the session connected.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
      protocol: "ssh",
      username: "root",
    },
  ], "__external_mcp__");

  // Original chat sidebar still pushes only the focused tab.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");

  assert.equal(bridge.getSessionMeta("sess-opened", "chat-1")?.connected, true);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-1")?.username, "root");
});

test("retained host_open metadata accepts a later disconnect from another scope", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({
    sessions: new Map(),
    electronModule: null,
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });

  // The focused tab moved away; External MCP later learns the host dropped.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: false,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "__external_mcp__");

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");

  assert.equal(bridge.getSessionMeta("sess-opened", "chat-1")?.connected, false);
});

test("getSessionMeta clears stopped port forwards from another scope while owned session stays connected", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({
    sessions: new Map(),
    electronModule: null,
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  const forwards = [{ ruleId: "fwd-1", localPort: 8080, status: "active" }];
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
      protocol: "ssh",
      activePortForwards: forwards,
    },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });

  // Another surface reports the session still up, but forwards already stopped.
  // chat-1 does not get another metadata replace (focused tab stayed elsewhere).
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
      protocol: "ssh",
      activePortForwards: [],
    },
  ], "__external_mcp__");

  assert.equal(bridge.getSessionMeta("sess-opened", "chat-1")?.connected, true);
  assert.deepEqual(bridge.getSessionMeta("sess-opened", "chat-1")?.activePortForwards, []);
});

test("getSessionMeta does not let another scope clear forwards on a live non-owned session", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({
    sessions: new Map(),
    electronModule: null,
  });

  const forwards = [{ ruleId: "fwd-1", localPort: 8080, status: "active" }];
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-live",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
      activePortForwards: forwards,
    },
  ], "chat-1");
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-live",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
      activePortForwards: [],
    },
  ], "__external_mcp__");

  assert.deepEqual(
    bridge.getSessionMeta("sess-live", "chat-1")?.activePortForwards,
    forwards,
  );
});

test("ordinary tab close forgets host_open ownership so sidebar sync cannot revive ghosts", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  const closedListeners = new Set();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      onSessionClosed(listener) {
        closedListeners.add(listener);
        return {
          dispose: () => closedListeners.delete(listener),
        };
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
    },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });

  // User closes the host_open tab through the normal UI / worker path.
  for (const listener of closedListeners) {
    listener({ sessionId: "sess-opened", reason: "closed", explicit: true });
  }

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");

  assert.deepEqual(bridge.getScopedSessionIds("chat-1"), ["sess-original"]);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-1"), null);
});

test("recoverable worker exits keep host_open ownership for reconnect", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  const closedListeners = new Set();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      onSessionClosed(listener) {
        closedListeners.add(listener);
        return {
          dispose: () => closedListeners.delete(listener),
        };
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
    },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });

  for (const event of [
    { reason: "error" },
    { reason: "worker-exit" },
    { reason: "superseded" },
    { reason: "closed" },
    // Shell exits that leave the tab for reconnect (missing/nonzero exitCode).
    { reason: "exited" },
    { reason: "exited", exitCode: 1 },
  ]) {
    for (const listener of closedListeners) {
      listener({ sessionId: "sess-opened", ...event });
    }
  }

  // After reconnect, sidebar may push only the focused tab; ownership must
  // still retain the host_open session.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");

  assert.deepEqual(
    bridge.getScopedSessionIds("chat-1").sort(),
    ["sess-opened", "sess-original"],
  );
});

test("clean shell exit keeps ownership until the tab is explicitly closed", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  const closedListeners = new Set();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      onSessionClosed(listener) {
        closedListeners.add(listener);
        return {
          dispose: () => closedListeners.delete(listener),
        };
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-opened",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
    },
  ], "chat-1");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-1",
    hostId: "host-b",
  });

  // Worker reports a clean exit; auto-close may still leave the tab briefly,
  // and disabled auto-close keeps it for reconnect — ownership stays.
  for (const listener of closedListeners) {
    listener({ sessionId: "sess-opened", reason: "exited", exitCode: 0 });
  }

  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");
  assert.deepEqual(
    bridge.getScopedSessionIds("chat-1").sort(),
    ["sess-opened", "sess-original"],
  );

  // Renderer tab close is the authoritative ownership drop.
  for (const listener of closedListeners) {
    listener({ sessionId: "sess-opened", reason: "closed", explicit: true });
  }
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-original",
      hostname: "10.0.0.1",
      label: "server-a",
      connected: true,
      hostId: "host-a",
    },
  ], "chat-1");
  assert.deepEqual(bridge.getScopedSessionIds("chat-1"), ["sess-original"]);
});

test("latest metadata revision wins across multiple chat and external scopes", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
  }));

  bridge.updateSessionMetadata([{
    sessionId: "sess-opened",
    connected: true,
    activePortForwards: [{ ruleId: "old-forward" }],
  }], "chat-stale");
  bridge.updateSessionMetadata([{
    sessionId: "sess-opened",
    connected: true,
    activePortForwards: [],
  }], "chat-owner");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-owner",
    hostId: "host-b",
  });

  bridge.updateSessionMetadata([{
    sessionId: "sess-opened",
    connected: false,
    activePortForwards: [],
  }], "__external_mcp__");
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-owner")?.connected, false);
  assert.deepEqual(bridge.getSessionMeta("sess-opened", "chat-owner")?.activePortForwards, []);

  bridge.updateSessionMetadata([{
    sessionId: "sess-opened",
    connected: true,
    username: "reconnected-user",
    activePortForwards: [{ ruleId: "new-forward" }],
  }], "chat-live");
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-owner")?.connected, true);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-owner")?.username, "reconnected-user");
  assert.deepEqual(
    bridge.getSessionMeta("sess-opened", "chat-owner")?.activePortForwards,
    [{ ruleId: "new-forward" }],
  );
});

test("host_open finishing after an empty scope replace restores its returned session", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  let finishOpen;
  bridge.setVaultAgentInvoker(() => new Promise((resolve) => {
    finishOpen = resolve;
  }));

  bridge.updateSessionMetadata([{ sessionId: "sess-original", connected: true }], "chat-race");
  const opening = bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-race",
    hostId: "host-b",
  });
  bridge.updateSessionMetadata([], "chat-race");
  finishOpen({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
    protocol: "ssh",
    host: { id: "host-b", hostname: "10.0.0.2", label: "server-b", username: "root" },
  });

  const opened = await opening;
  assert.equal(opened.ok, true);
  assert.deepEqual(bridge.getScopedSessionIds("chat-race"), ["sess-opened"]);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-race")?.label, "server-b");
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-race")?.connected, false);
});

test("initial external scope seed selects the latest session snapshot", (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: new Map(), electronModule: null });

  bridge.updateSessionMetadata([{
    sessionId: "sess-shared",
    connected: true,
    username: "old-user",
  }], "chat-old");
  bridge.updateSessionMetadata([{
    sessionId: "sess-shared",
    connected: false,
    username: "new-user",
  }], "chat-new");

  const seeded = bridge.syncLiveSessionsToExternalScope();
  assert.equal(seeded.seeded, true);
  assert.equal(bridge.getSessionMeta("sess-shared", "__external_mcp__")?.connected, false);
  assert.equal(bridge.getSessionMeta("sess-shared", "__external_mcp__")?.username, "new-user");
});

test("explicit close before host_open returns cannot revive the closed session", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  let finishOpen;
  bridge.setVaultAgentInvoker(() => new Promise((resolve) => {
    finishOpen = resolve;
  }));

  bridge.updateSessionMetadata([{ sessionId: "sess-original", connected: true }], "chat-close-race");
  const opening = bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-close-race",
    hostId: "host-b",
  });
  // Renderer-side host.open creates and merges the tab before returning its
  // result to the main process. Simulate the user closing that tab immediately.
  bridge.mergeSessionMetadata([{
    sessionId: "sess-opened",
    hostId: "host-b",
    connected: false,
  }], "chat-close-race");
  bridge.forgetClosedTerminalSession("sess-opened");
  finishOpen({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
    protocol: "ssh",
  });

  assert.equal((await opening).ok, true);
  bridge.updateSessionMetadata([{ sessionId: "sess-original", connected: true }], "chat-close-race");
  assert.deepEqual(bridge.getScopedSessionIds("chat-close-race"), ["sess-original"]);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-close-race"), null);
});

test("app live sync makes host_open session usable without External MCP or a second AI panel", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  const requests = [];
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request(channel, payload, options) {
        requests.push({ channel, payload, options });
        if (channel === "netcatty:portforward:list") return Promise.resolve([]);
        if (channel === "netcatty:ai:exec") {
          return Promise.resolve({ ok: true, stdout: "ready\n", stderr: "", exitCode: 0 });
        }
        throw new Error(`unexpected worker request: ${channel}`);
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setVaultAgentInvoker(async () => ({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
    protocol: "ssh",
    host: { id: "host-b", hostname: "10.0.0.2", label: "server-b", username: "root" },
  }));

  bridge.updateSessionMetadata([{ sessionId: "sess-original", connected: true }], "chat-owner");
  await bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-owner",
    hostId: "host-b",
  });

  // The app-level session state observes the connection. No External MCP scope
  // and no AI panel for the opened tab are involved.
  bridge.updateLiveSessionMetadata([{
    sessionId: "sess-opened",
    hostId: "host-b",
    hostname: "10.0.0.2",
    label: "server-b",
    username: "root",
    protocol: "ssh",
    connected: true,
  }]);

  // Returning to the original tab replaces its sidebar payload with only A.
  bridge.updateSessionMetadata([{ sessionId: "sess-original", connected: true }], "chat-owner");
  assert.deepEqual(
    bridge.getScopedSessionIds("chat-owner").sort(),
    ["sess-opened", "sess-original"],
  );
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-owner")?.connected, true);

  const environment = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-owner",
  });
  const openedHost = environment.hosts.find((host) => host.sessionId === "sess-opened");
  assert.equal(openedHost?.connected, true);

  const executed = await bridge.dispatchBuiltinRpc("netcatty/exec", {
    chatSessionId: "chat-owner",
    sessionId: "sess-opened",
    command: "pwd",
  });
  assert.deepEqual(executed, { ok: true, stdout: "ready\n", stderr: "", exitCode: 0 });
  assert.equal(requests.some((entry) => entry.channel === "netcatty:ai:exec"), true);
});

test("chat cleanup during host_open closes the late-created unowned session", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  let finishOpen;
  const calls = [];
  bridge.setVaultAgentInvoker((op, params) => {
    calls.push({ op, params });
    if (op === "host.open") {
      return new Promise((resolve) => {
        finishOpen = resolve;
      });
    }
    if (op === "session.close") return Promise.resolve({ ok: true, sessionId: params.sessionId });
    throw new Error(`unexpected op ${op}`);
  });

  bridge.updateSessionMetadata([{ sessionId: "sess-original", connected: true }], "chat-deleted");
  const opening = bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-deleted",
    hostId: "host-b",
  });
  await bridge.cleanupScopedMetadata("chat-deleted");

  // Renderer host.open can still finish its own merge after chat cleanup.
  bridge.mergeSessionMetadata([{
    sessionId: "sess-opened",
    hostId: "host-b",
    connected: false,
  }], "chat-deleted");
  finishOpen({
    ok: true,
    sessionId: "sess-opened",
    hostId: "host-b",
    status: "connecting",
    protocol: "ssh",
  });

  assert.equal((await opening).ok, true);
  assert.deepEqual(calls.map(({ op }) => op), ["host.open", "session.close"]);
  assert.deepEqual(bridge.getScopedSessionIds("chat-deleted"), []);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-deleted"), null);
});

test("failed compensating close keeps the late-created session tracked for retry", async (t) => {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  let finishOpen;
  bridge.setVaultAgentInvoker((op) => {
    if (op === "host.open") {
      return new Promise((resolve) => {
        finishOpen = resolve;
      });
    }
    if (op === "session.close") {
      return Promise.resolve({ ok: false, error: "renderer unavailable" });
    }
    throw new Error(`unexpected op ${op}`);
  });

  const opening = bridge.dispatchBuiltinRpc("public/vault/hosts/open", {
    chatSessionId: "chat-deleted",
    hostId: "host-b",
  });
  await bridge.cleanupScopedMetadata("chat-deleted");
  bridge.mergeSessionMetadata([{
    sessionId: "sess-opened",
    hostId: "host-b",
    connected: false,
  }], "chat-deleted");
  finishOpen({ ok: true, sessionId: "sess-opened", hostId: "host-b", status: "connecting" });

  assert.equal((await opening).ok, true);
  assert.deepEqual(bridge.getScopedSessionIds("chat-deleted"), []);
  assert.equal(bridge.getSessionMeta("sess-opened", "chat-deleted"), null);
  assert.equal(
    bridge.reportOpenedSessionActivity({ sessionId: "sess-opened", phase: "touch" }),
    true,
  );
});
