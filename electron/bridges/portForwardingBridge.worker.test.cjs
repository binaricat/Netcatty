const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const test = require("node:test");

const { registerHandlers } = require("./portForwardingBridge.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

function createSender(id) {
  const sender = new EventEmitter();
  sender.id = id;
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (channel, payload) => sender.sent.push({ channel, payload });
  return sender;
}

test("worker mode routes every port-forward operation through the terminal worker", async () => {
  const ipcMain = createIpcMain();
  const requests = [];
  const terminalWorkerManager = {
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      if (channel === "netcatty:portforward:start") {
        return Promise.resolve({ tunnelId: payload.tunnelId, success: true });
      }
      if (channel === "netcatty:portforward:subscribe") {
        return Promise.resolve({ tunnelId: payload.tunnelId, status: "active" });
      }
      return Promise.resolve(null);
    },
    onWorkerExit() {
      return { dispose() {} };
    },
  };
  registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = createSender(17);
  const event = { sender };
  const channels = [
    "netcatty:portforward:start",
    "netcatty:portforward:stop",
    "netcatty:portforward:status",
    "netcatty:portforward:subscribe",
    "netcatty:portforward:list",
    "netcatty:portforward:snapshot",
    "netcatty:portforward:subscribeRuntime",
    "netcatty:portforward:unsubscribeRuntime",
    "netcatty:portforward:stopAll",
    "netcatty:portforward:stopByRuleId",
  ];

  for (const channel of channels) {
    await ipcMain.handlers.get(channel)(event, { tunnelId: "pf-worker", ruleId: "rule-worker" });
  }

  assert.deepEqual(requests.map((entry) => entry.channel), channels);
  assert.ok(requests.every((entry) => entry.options.webContentsId === 17));
});

test("legacy mode keeps port-forward handlers in the main process", async () => {
  const ipcMain = createIpcMain();
  registerHandlers(ipcMain);

  assert.deepEqual(
    await ipcMain.handlers.get("netcatty:portforward:status")(
      { sender: createSender(19) },
      { tunnelId: "pf-legacy-missing" },
    ),
    { tunnelId: "pf-legacy-missing", status: "inactive" },
  );
  assert.deepEqual(await ipcMain.handlers.get("netcatty:portforward:list")(), []);
});

test("worker mode drops renderer subscriptions when their window is destroyed", async () => {
  const ipcMain = createIpcMain();
  const requests = [];
  const terminalWorkerManager = {
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve({ tunnelId: payload.tunnelId, status: "active" });
    },
    onWorkerExit() {
      return { dispose() {} };
    },
  };
  registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = createSender(23);

  await ipcMain.handlers.get("netcatty:portforward:subscribe")(
    { sender },
    { tunnelId: "pf-destroyed" },
  );
  sender.emit("destroyed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.at(-1).channel, "netcatty:portforward:unsubscribeSender");
  assert.deepEqual(requests.at(-1).payload, { webContentsId: 23 });
});

test("worker mode drops a renderer destroyed while its start request is pending", async () => {
  const ipcMain = createIpcMain();
  const requests = [];
  let finishStart;
  const startResult = new Promise((resolve) => { finishStart = resolve; });
  const terminalWorkerManager = {
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      if (channel === "netcatty:portforward:start") return startResult;
      return Promise.resolve({ removed: 1 });
    },
    onWorkerExit() {
      return { dispose() {} };
    },
  };
  registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = createSender(29);
  let destroyed = false;
  sender.isDestroyed = () => destroyed;
  const pending = ipcMain.handlers.get("netcatty:portforward:start")(
    { sender },
    { tunnelId: "pf-pending-destroy", ruleId: "rule-pending-destroy" },
  );

  destroyed = true;
  sender.emit("destroyed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).channel, "netcatty:portforward:unsubscribeSender");
  finishStart({ tunnelId: "pf-pending-destroy", success: true });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).channel, "netcatty:portforward:unsubscribeSender");
});

test("worker mode does not retain renderer lifecycle after a failed start", async () => {
  const ipcMain = createIpcMain();
  const terminalWorkerManager = {
    request(_channel, payload) {
      return Promise.resolve({
        tunnelId: payload.tunnelId,
        success: false,
        error: "bind failed",
      });
    },
    onWorkerExit() {
      return { dispose() {} };
    },
  };
  registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = createSender(30);

  await ipcMain.handlers.get("netcatty:portforward:start")(
    { sender },
    { tunnelId: "pf-failed", ruleId: "rule-failed" },
  );

  assert.equal(sender.listenerCount("destroyed"), 0);
});

test("worker error terminal status releases the renderer subscription", async () => {
  const ipcMain = createIpcMain();
  let workerRendererEventListener;
  const terminalWorkerManager = {
    request(_channel, payload) {
      return Promise.resolve({ tunnelId: payload.tunnelId, success: true });
    },
    onWorkerRendererEvent(listener) {
      workerRendererEventListener = listener;
      return { dispose() {} };
    },
    onWorkerExit() {
      return { dispose() {} };
    },
  };
  registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = createSender(32);

  await ipcMain.handlers.get("netcatty:portforward:start")(
    { sender },
    { tunnelId: "pf-error", ruleId: "rule-error" },
  );
  assert.equal(sender.listenerCount("destroyed"), 1);

  workerRendererEventListener({
    channel: "netcatty:portforward:status",
    payload: { tunnelId: "pf-error", status: "error", error: "remote closed" },
  });

  assert.equal(sender.listenerCount("destroyed"), 0);
});

test("worker crashes notify subscribed renderers and permit a replacement worker start", async () => {
  const ipcMain = createIpcMain();
  let workerExitListener;
  let starts = 0;
  const terminalWorkerManager = {
    request(channel, payload) {
      if (channel === "netcatty:portforward:start") {
        starts += 1;
        return Promise.resolve({ tunnelId: payload.tunnelId, success: true });
      }
      return Promise.resolve({ tunnelId: payload.tunnelId, status: "active" });
    },
    onWorkerExit(listener) {
      workerExitListener = listener;
      return { dispose() {} };
    },
  };
  registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = createSender(31);
  const event = { sender };

  await ipcMain.handlers.get("netcatty:portforward:start")(
    event,
    { tunnelId: "pf-crash", ruleId: "rule-crash" },
  );
  workerExitListener(new Error("Terminal worker exited with code 9"));

  assert.deepEqual(sender.sent, [{
    channel: "netcatty:portforward:status",
    payload: {
      tunnelId: "pf-crash",
      status: "error",
      error: "Terminal worker exited with code 9",
    },
  }]);

  await ipcMain.handlers.get("netcatty:portforward:start")(
    event,
    { tunnelId: "pf-recovered", ruleId: "rule-crash" },
  );
  assert.equal(starts, 2);
});
