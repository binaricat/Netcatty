"use strict";

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
