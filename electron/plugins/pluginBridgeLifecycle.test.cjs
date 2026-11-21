"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CHANNELS, createTrustedPluginBridgeSender, registerPluginBridge } = require("./pluginBridge.cjs");
const { PluginAITrustedHostAdapter } = require("./ai/trustedHostAdapter.cjs");

const lifecycleCalls = [
  [CHANNELS.interactionReady, { ready: true }],
  [CHANNELS.permissionReady, { ready: true }],
  [CHANNELS.terminalTarget, { sessionId: "session-1" }],
  ["netcatty:plugins:ai-host-ready", true],
  ["netcatty:plugins:agent-host-ready", true],
];

function fixture() {
  const handlers = new Map();
  const mainFrame = { url: "app://netcatty/index.html" };
  const sender = { mainFrame, isDestroyed: () => false };
  const event = { sender, senderFrame: mainFrame };
  const ipcMain = {
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) { handlers.delete(channel); },
    on() {},
  };
  return { handlers, event, ipcMain, isTrustedSender: createTrustedPluginBridgeSender() };
}

for (const [channel, payload] of lifecycleCalls) {
  test(`disabled runtime acknowledges trusted lifecycle without side effects: ${channel}`, async () => {
    for (const manager of [null, undefined]) {
      const f = fixture();
      const unexpected = () => assert.fail("disabled lifecycle invoked a service");
      registerPluginBridge(f.ipcMain, {
        manager, isTrustedSender: f.isTrustedSender,
        interactionService: { setReady: unexpected, setTerminalTarget: unexpected },
        permissionDecisionHost: { setReady: unexpected },
      });
      const handler = f.handlers.get(channel);
      assert.equal(typeof handler, "function");
      const inactive = typeof payload === "boolean" ? false
        : channel === CHANNELS.terminalTarget ? null : { ready: false };
      for (const value of [payload, inactive]) {
        assert.equal(await handler(f.event, value), false);
      }
    }
  });

  test(`disabled lifecycle still rejects untrusted senders and embedded frames: ${channel}`, async () => {
    const f = fixture();
    registerPluginBridge(f.ipcMain, { manager: null, isTrustedSender: f.isTrustedSender });
    const handler = f.handlers.get(channel);
    assert.equal(typeof handler, "function");
    const untrusted = [
      { senderFrame: { url: "netcatty-plugin://runtime/index.html" } },
      { senderFrame: { url: "https://attacker.invalid/" } },
      { sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } },
      { sender: f.event.sender, senderFrame: null },
    ];
    for (const event of untrusted) await assert.rejects(handler(event, payload), /Untrusted/);
  });
}

test("enabled lifecycle forwards to the original services after initialization", async () => {
  const f = fixture(); const calls = []; let initialized = 0;
  const record = (kind) => (...args) => { calls.push([kind, ...args]); return kind; };
  registerPluginBridge(f.ipcMain, {
    manager: { initialize: async () => { initialized++; } }, isTrustedSender: f.isTrustedSender,
    interactionService: { setReady: record("interaction"), setTerminalTarget: record("terminal") },
    permissionDecisionHost: { setReady: record("permission") },
  });
  const kinds = ["interaction", "permission", "terminal"];
  for (const [index, [channel, payload]] of lifecycleCalls.slice(0, 3).entries()) {
    assert.equal(await f.handlers.get(channel)(f.event, payload), kinds[index]);
  }
  assert.equal(initialized, 3);
  assert.deepEqual(calls, [
    ["interaction", f.event.sender, true], ["permission", f.event.sender, true],
    ["terminal", f.event.sender, lifecycleCalls[2][1]],
  ]);
  for (const [channel, payload] of lifecycleCalls.slice(0, 3)) {
    await assert.rejects(f.handlers.get(channel)({ senderFrame: { url: "https://attacker.invalid/" } }, payload), /Untrusted/);
  }
  assert.equal(initialized, 3);
});

test("enabled lifecycle propagates initialization and service failures", async () => {
  for (const initializationFails of [true, false]) {
    const f = fixture(); let initialized = 0; let serviceCalls = 0;
    const failure = new Error("synthetic initialization or service failure");
    const failService = () => { serviceCalls++; throw failure; };
    registerPluginBridge(f.ipcMain, {
      manager: { initialize: async () => { initialized++; if (initializationFails) throw failure; } },
      isTrustedSender: f.isTrustedSender,
      interactionService: { setReady: failService, setTerminalTarget: failService },
      permissionDecisionHost: { setReady: failService },
    });
    for (const [channel, payload] of lifecycleCalls.slice(0, 3)) {
      await assert.rejects(f.handlers.get(channel)(f.event, payload), (error) => (
        initializationFails ? error.cause === failure : error === failure
      ));
    }
    assert.equal(initialized, 3);
    assert.equal(serviceCalls, initializationFails ? 0 : 3);
  }
});

test("enabled AI and Agent readiness remains owned by the original adapters", async (t) => {
  const f = fixture(); const adapters = [];
  for (const kind of ["ai", "agent"]) {
    const channels = {
      ready: `netcatty:plugins:${kind}-host-ready`,
      request: `netcatty:plugins:${kind}-host-request`,
      response: `netcatty:plugins:${kind}-host-response`,
    };
    const adapter = new PluginAITrustedHostAdapter({
      channels, getWindow: () => ({ webContents: f.event.sender }), cancelProviderStreams: () => {},
      validateRequest: () => true, validateResponse: () => true,
    });
    adapter.registerIpc(f.ipcMain);
    t.after(() => adapter.shutdown());
    adapters.push(adapter);
  }
  const originalHandlers = new Map(f.handlers);
  registerPluginBridge(f.ipcMain, {
    manager: { initialize: async () => { throw new Error("initialization failed"); } },
    isTrustedSender: f.isTrustedSender,
  });
  for (const adapter of adapters) {
    const handler = f.handlers.get(adapter.channels.ready);
    assert.equal(handler, originalHandlers.get(adapter.channels.ready));
    assert.equal(await handler(f.event, true), true);
    assert.equal(adapter.owner, f.event.sender);
    assert.throws(() => handler({ sender: {} }, true), /sender is not the main window/);
    assert.equal(await handler(f.event, false), true);
    assert.equal(adapter.owner, null);
    adapter.closed = true;
    assert.throws(() => handler(f.event, true), /host is closed/);
  }
});
