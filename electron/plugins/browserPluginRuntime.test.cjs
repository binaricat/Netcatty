"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  BrowserPluginRuntime,
  normalizeConsoleLevel,
  sanitizePluginSource,
} = require("./browserPluginRuntime.cjs");

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.transferLists = [];
  }

  postMessage(message, transfer = []) {
    assert.ok(transfer.every((item) => !(item instanceof ArrayBuffer)), "MessagePortMain transfers ports only");
    this.sent.push(message);
    this.transferLists.push(transfer);
    if (message.method === "plugin.initialize") {
      queueMicrotask(() => this.emit("message", { data: {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          pluginId: "com.example.browser-runtime",
          pluginVersion: "1.0.0",
          apiVersion: "0.1.0-internal",
          enabledFeatures: [],
        },
      } }));
    } else if (message.method === "plugin.activate" || message.method === "plugin.deactivate") {
      queueMicrotask(() => this.emit("message", { data: {
        jsonrpc: "2.0",
        id: message.id,
        result: null,
      } }));
    }
  }

  start() {}
  close() { this.emit("close"); }
}

test("browser host waits for preload and the installed plugin RPC listener", async () => {
  const contents = new EventEmitter();
  let resolveLoading;
  let postedPort = false;
  contents.loadURL = () => new Promise((resolve) => { resolveLoading = resolve; });
  contents.postMessage = (_channel, _message, ports) => { postedPort = ports.length === 1; };
  contents.setWindowOpenHandler = () => {};
  let webRtcPolicy;
  contents.setWebRTCIPHandlingPolicy = (policy) => { webRtcPolicy = policy; };
  const pluginSession = new EventEmitter();
  pluginSession.protocol = { handle() {}, unhandle() {} };
  pluginSession.webRequest = {
    onBeforeRequest() {},
    onCompleted() {},
    onErrorOccurred() {},
  };
  pluginSession.setPermissionCheckHandler = () => {};
  pluginSession.setPermissionRequestHandler = () => {};
  pluginSession.setDevicePermissionHandler = () => {};
  let proxyOptions;
  let networkEmulation;
  pluginSession.setProxy = async (options) => { proxyOptions = options; };
  pluginSession.enableNetworkEmulation = (options) => { networkEmulation = options; };
  let windowOptions;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      windowOptions = options;
      this.webContents = contents;
    }
    isDestroyed() { return false; }
    destroy() {}
  }
  const port1 = new FakePort();
  const port2 = new FakePort();
  const onBeforeMessage = () => {};
  let processReadyCalls = 0;
  let sessionDisposed = false;
  const runtime = new BrowserPluginRuntime({
    electron: {
      BrowserWindow: FakeWindow,
      MessageChannelMain: class { constructor() { this.port1 = port1; this.port2 = port2; } },
      session: { fromPartition: () => pluginSession },
    },
    protocol: {
      registerSession: () => ({ dispose() { sessionDisposed = true; } }),
      registerRuntime: () => ({
        token: "runtime-token",
        url: "netcatty-plugin://runtime-token/index.html",
        dispose() {},
      }),
    },
    plugin: {
      id: "com.example.browser-runtime",
      manifest: { main: { browser: "dist/index.js" } },
    },
    packageRoot: "/plugins/com.example.browser-runtime/1.0.0/package",
    preloadPath: "/runtime/browserPreload.cjs",
    handlers: {},
    onBeforeMessage,
    onProcessReady: () => { processReadyCalls += 1; },
  });

  const started = runtime.start({
    pluginId: "com.example.browser-runtime",
    pluginVersion: "1.0.0",
    netcattyVersion: "0.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
    enabledFeatures: [],
    environment: { locale: "en" },
  }, {
    getActivationEnvironment: () => ({ locale: "zh-CN", theme: "dark" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processReadyCalls, 1);
  contents.emit("ipc-message", {}, "netcatty-plugin:preload-ready");
  resolveLoading();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(postedPort, true);
  assert.equal(port1.sent.length, 0, "initialize must wait until the peer installs its RPC listener");

  contents.emit("ipc-message", {}, "netcatty-plugin:runtime-connected");
  const initialized = await started;
  assert.equal(initialized.pluginId, "com.example.browser-runtime");
  assert.equal(runtime.router.onBeforeMessage, onBeforeMessage);
  assert.deepEqual(port1.sent.map((message) => message.method), ["plugin.initialize", "plugin.activate"]);
  assert.deepEqual(port1.sent.find((message) => message.method === "plugin.activate").params, {
    environment: { locale: "zh-CN", theme: "dark" },
  });
  const transferable = new ArrayBuffer(8);
  runtime.router.send({ type: "transfer-test", transferable }, [transferable]);
  assert.deepEqual(port1.transferLists.at(-1), []);
  assert.equal(port1.sent.at(-1).transferable.byteLength, 8);
  assert.equal(windowOptions.webPreferences.sandbox, true);
  assert.equal(windowOptions.webPreferences.nodeIntegration, false);
  assert.equal(windowOptions.webPreferences.contextIsolation, true);
  assert.equal(proxyOptions.mode, "fixed_servers");
  assert.equal(proxyOptions.proxyBypassRules, "<-loopback>");
  assert.equal(webRtcPolicy, "disable_non_proxied_udp");
  assert.deepEqual(networkEmulation, { offline: true });
  let downloadPrevented = false;
  pluginSession.emit("will-download", { preventDefault() { downloadPrevented = true; } });
  assert.equal(downloadPrevented, true);
  await runtime.stop();
  assert.equal(sessionDisposed, true);
  assert.doesNotThrow(() => port1.emit("message", { data: {
    jsonrpc: "2.0",
    method: "late.notification",
  } }));
});

test("browser console levels and source paths are normalized without runtime tokens", () => {
  assert.equal(normalizeConsoleLevel("error"), "error");
  assert.equal(normalizeConsoleLevel("warning"), "warn");
  assert.equal(normalizeConsoleLevel("debug"), "debug");
  assert.equal(normalizeConsoleLevel(3), "error");
  assert.equal(normalizeConsoleLevel(2), "warn");
  assert.equal(normalizeConsoleLevel(1), "info");
  assert.equal(
    sanitizePluginSource("netcatty-plugin://secret-runtime-token/package/dist/index.js"),
    "/package/dist/index.js",
  );
});

test("aborted browser startup cannot create a window after proxy setup resumes", async () => {
  let releaseProxy;
  const proxyBlocked = new Promise((resolve) => { releaseProxy = resolve; });
  const pluginSession = new EventEmitter();
  pluginSession.protocol = { handle() {}, unhandle() {} };
  pluginSession.setProxy = () => proxyBlocked;
  let windows = 0;
  const runtime = new BrowserPluginRuntime({
    electron: {
      BrowserWindow: class { constructor() { windows += 1; } },
      MessageChannelMain: class {},
      session: { fromPartition: () => pluginSession },
    },
    protocol: {
      registerSession: () => ({ dispose() {} }),
      registerRuntime: () => ({ token: "token", dispose() {} }),
    },
    plugin: {
      id: "com.example.cancelled-browser",
      manifest: { main: { browser: "dist/index.js" } },
    },
    packageRoot: "/plugins/cancelled/package",
    preloadPath: "/runtime/browserPreload.cjs",
    handlers: {},
  });
  const controller = new AbortController();
  const starting = runtime.start({}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));
  await runtime.stop();
  releaseProxy();
  await assert.rejects(starting, /cancelled/);
  assert.equal(windows, 0);
});
