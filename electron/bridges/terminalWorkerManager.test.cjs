const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const test = require("node:test");

const {
  createTerminalWorkerManager,
  isTerminalWorkerEnabled,
} = require("./terminalWorkerManager.cjs");
const { createTerminalWorkerRuntime } = require("../terminalWorker/runtime.cjs");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.transferLists = [];
    this.killed = false;
  }

  postMessage(message, transferList) {
    this.messages.push(message);
    this.transferLists.push(transferList || []);
  }

  kill() {
    this.killed = true;
  }
}

class LinkedRuntimeChild extends FakeChild {
  connectRuntime(registerBridges) {
    let workerMessageListener = null;
    const parentPort = {
      on(event, listener) {
        if (event === "message") workerMessageListener = listener;
      },
      postMessage: (message) => {
        queueMicrotask(() => this.emit("message", message));
      },
    };
    const runtime = createTerminalWorkerRuntime({ parentPort, registerBridges });
    runtime.start();
    this.workerMessageListener = (message) => workerMessageListener?.(message);
    return runtime;
  }

  postMessage(message, transferList) {
    super.postMessage(message, transferList);
    queueMicrotask(() => this.workerMessageListener?.(message));
  }
}

function emitOutputPortReady(child, sessionId) {
  const openMessage = [...child.messages].reverse().find((message) => (
    message.kind === "output-port" && message.sessionId === sessionId
  ));
  assert.ok(openMessage);
  child.emit("message", {
    kind: "output-port-ready",
    sessionId,
    sessionGeneration: openMessage.sessionGeneration,
    outputPortRequestId: openMessage.outputPortRequestId,
  });
}

class FakePort extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
    this.messages = [];
    this.closed = false;
    this.started = false;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  start() {
    this.started = true;
  }

  close() {
    this.closed = true;
  }
}

class FakeMessageChannelMain {
  constructor() {
    this.port1 = new FakePort("port1");
    this.port2 = new FakePort("port2");
  }
}

test("isTerminalWorkerEnabled defaults on and honors NETCATTY_TERMINAL_WORKER=0", () => {
  assert.equal(isTerminalWorkerEnabled({ env: {} }), true);
  assert.equal(isTerminalWorkerEnabled({ env: { NETCATTY_TERMINAL_WORKER: "0" } }), false);
});

test("request sends a worker command and resolves matching response", async () => {
  const child = new FakeChild();
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", { shell: "/bin/zsh" }, { webContentsId: 7 });
  assert.equal(child.messages.length, 1);
  assert.equal(child.messages[0].kind, "request");
  assert.equal(child.messages[0].channel, "netcatty:local:start");
  assert.deepEqual(child.messages[0].payload, { shell: "/bin/zsh" });
  assert.equal(child.messages[0].webContentsId, 7);

  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });

  assert.deepEqual(await promise, { sessionId: "local-1" });
});

test("session ownership listeners finish before buffered output is released", async () => {
  const child = new FakeChild();
  const routed = [];
  let releaseOwnership;
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() { outputOpen = true; },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(() => new Promise((resolve) => { releaseOwnership = resolve; }));

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("message", { kind: "output", sessionId: "local-1", data: "banner" });
  assert.deepEqual(routed, []);

  releaseOwnership();
  assert.deepEqual(await promise, { sessionId: "local-1" });
  assert.deepEqual(routed, [{ sessionId: "local-1", data: "banner" }]);
});

test("destroying a renderer immediately cancels its pending session ownership", async () => {
  const child = new FakeChild();
  const contents = new EventEmitter();
  contents.id = 7;
  contents.destroyed = false;
  contents.isDestroyed = () => contents.destroyed;
  let releaseOwnership;
  let outputOpened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() { outputOpened = true; },
    },
    electronModule: { webContents: { fromId: () => contents } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(() => new Promise((resolve) => { releaseOwnership = resolve; }));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  while (!releaseOwnership) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.ownsSession("local-1", 7), true);

  contents.destroyed = true;
  contents.emit("destroyed");
  assert.equal(manager.ownsSession("local-1", 7), false);
  assert.equal(manager.getSessionOwnerWebContentsId("local-1"), null);
  releaseOwnership();

  await assert.rejects(start, /output route opened/u);
  assert.equal(outputOpened, false);
});

test("worker exit after renderer loss still closes a session with pending ownership", async () => {
  const child = new FakeChild();
  const contents = new EventEmitter();
  contents.id = 7;
  contents.destroyed = false;
  contents.isDestroyed = () => contents.destroyed;
  const closed = [];
  let releaseOwnership;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession() {} },
    electronModule: { webContents: { fromId: () => contents } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(() => new Promise((resolve) => { releaseOwnership = resolve; }));
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  while (!releaseOwnership) await new Promise((resolve) => setImmediate(resolve));

  contents.destroyed = true;
  contents.emit("destroyed");
  releaseOwnership();
  await assert.rejects(start, /output route opened/u);
  assert.deepEqual(closed, []);

  child.emit("exit", 1);
  assert.deepEqual(closed, [{ sessionId: "local-1", reason: "worker-exit" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, [{ sessionId: "local-1", reason: "worker-exit" }]);
});

test("a start closed while ownership is pending rejects instead of creating a ghost session", async () => {
  const child = new FakeChild();
  let releaseOwnership;
  let outputOpened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() {
        outputOpened = true;
      },
    },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(() => new Promise((resolve) => { releaseOwnership = resolve; }));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  manager.send("netcatty:close", { sessionId: "local-1" }, { webContentsId: 7 });
  releaseOwnership();

  await assert.rejects(start, /closed before its output route opened/u);
  assert.equal(outputOpened, false);
  assert.equal(manager.hasOpenSession("local-1"), false);
});

test("a worker exit while ownership is pending rejects instead of creating a ghost session", async () => {
  const child = new FakeChild();
  const closed = [];
  let releaseOwnership;
  let outputOpened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() {
        outputOpened = true;
      },
    },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(() => new Promise((resolve) => { releaseOwnership = resolve; }));
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  child.emit("exit", 1);
  await assert.rejects(start, /Terminal worker exited with code 1/u);
  assert.deepEqual(closed, [{ sessionId: "local-1", reason: "worker-exit" }]);
  releaseOwnership();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(outputOpened, false);
  assert.equal(manager.hasOpenSession("local-1"), false);
});

test("an older ownership waiter cannot release a newer output route", async () => {
  const child = new FakeChild();
  const routed = [];
  const releaseOwnership = [];
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() { outputOpen = true; },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(() => new Promise((resolve) => { releaseOwnership.push(resolve); }));

  const first = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const second = manager.request("netcatty:local:reconnect", { sessionId: "local-1" }, {
    webContentsId: 7,
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[1].requestId,
    result: { sessionId: "local-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releaseOwnership.length, 2);

  child.emit("message", { kind: "output", sessionId: "local-1", data: "new-banner" });
  releaseOwnership[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outputOpen, false);
  assert.deepEqual(routed, []);

  releaseOwnership[1]();
  assert.deepEqual(await first, { sessionId: "local-1" });
  assert.deepEqual(await second, { sessionId: "local-1" });
  assert.deepEqual(routed, [{ sessionId: "local-1", data: "new-banner" }]);
});

test("terminal interceptor ports transfer directly to the worker and warnings stay host-owned", () => {
  const child = new FakeChild();
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    workerScriptPath: "/worker.cjs",
  });
  const port = new FakePort("interceptor");
  const warnings = [];
  manager.onTerminalInterceptorWarning((warning) => warnings.push(warning));
  manager.attachTerminalInterceptor({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.input",
  }, port);
  assert.equal(child.messages[0].kind, "terminal-interceptor-port");
  assert.deepEqual(child.transferLists[0], [port]);
  child.emit("message", {
    kind: "terminal-interceptor-warning",
    warning: { sessionId: "session-1", direction: "input", code: "timeout" },
  });
  assert.equal(warnings[0].code, "timeout");
  manager.detachTerminalInterceptor("session-1", "input");
  assert.equal(child.messages[1].kind, "terminal-interceptor-detach");
  child.emit("exit", 9);
  assert.deepEqual(warnings[1], {
    code: "worker-exit",
    message: "Terminal worker exited with code 9",
  });
});

test("request opens a terminal output port when a session starts", async () => {
  const child = new FakeChild();
  const opened = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession(sessionId, webContents) {
        opened.push({ sessionId, webContentsId: webContents.id });
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;

  assert.deepEqual(opened, [{ sessionId: "local-1", webContentsId: 7 }]);
});

test("worker ZMODEM upload dialog request opens picker from the owning webContents", async () => {
  const child = new FakeChild();
  const shown = [];
  const contents = { id: 7 };
  const window = { id: "main-window" };
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          assert.equal(id, 7);
          return contents;
        },
      },
      BrowserWindow: {
        fromWebContents(value) {
          assert.equal(value, contents);
          return window;
        },
      },
      dialog: {
        async showOpenDialog(owner, options) {
          shown.push({ owner, options });
          return { canceled: false, filePaths: ["/tmp/upload.txt"] };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.ensureStarted();
  child.emit("message", {
    kind: "zmodem-upload-dialog",
    requestId: "dialog-1",
    webContentsId: 7,
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(shown, [{
    owner: window,
    options: {
      properties: ["openFile", "multiSelections"],
      title: "Select files to upload (ZMODEM)",
    },
  }]);
  assert.deepEqual(child.messages.at(-1), {
    kind: "zmodem-upload-dialog-result",
    requestId: "dialog-1",
    result: { canceled: false, filePaths: ["/tmp/upload.txt"] },
  });
});

test("worker ZMODEM download dialog request opens directory picker from the owning webContents", async () => {
  const child = new FakeChild();
  const shown = [];
  const contents = { id: 7 };
  const window = { id: "main-window" };
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          assert.equal(id, 7);
          return contents;
        },
      },
      BrowserWindow: {
        fromWebContents(value) {
          assert.equal(value, contents);
          return window;
        },
      },
      dialog: {
        async showOpenDialog(owner, options) {
          shown.push({ owner, options });
          return { canceled: false, filePaths: ["/tmp/downloads"] };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.ensureStarted();
  child.emit("message", {
    kind: "zmodem-download-dialog",
    requestId: "download-dialog-1",
    webContentsId: 7,
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(shown, [{
    owner: window,
    options: {
      properties: ["openDirectory", "createDirectory"],
      title: "Select download directory (ZMODEM)",
    },
  }]);
  assert.deepEqual(child.messages.at(-1), {
    kind: "zmodem-download-dialog-result",
    requestId: "download-dialog-1",
    result: { canceled: false, filePaths: ["/tmp/downloads"] },
  });
});

test("request transfers the output port to the worker when available", async () => {
  const child = new FakeChild();
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession(sessionId, webContents, options) {
        assert.equal(sessionId, "local-1");
        assert.equal(webContents.id, 7);
        assert.deepEqual(options, { transferToWorker: true });
        return outputPort;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "early",
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;

  assert.equal(child.messages[1].kind, "output-port");
  assert.equal(child.messages[1].sessionId, "local-1");
  assert.equal(child.messages[1].sessionGeneration, 0);
  assert.equal(typeof child.messages[1].outputPortRequestId, "string");
  assert.deepEqual(child.messages[1].bufferedOutput, ["early"]);
  assert.deepEqual(child.transferLists[1], [outputPort]);
});

test("request transfers a dedicated urgent input port to the worker and renderer", async () => {
  const child = new FakeChild();
  const rendererMessages = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    MessageChannelMain: FakeMessageChannelMain,
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            id,
            postMessage(channel, payload, transferList) {
              rendererMessages.push({ id, channel, payload, transferList });
            },
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;

  assert.equal(child.messages[1].kind, "urgent-input-port");
  assert.equal(child.messages[1].webContentsId, 7);
  assert.deepEqual(child.transferLists[1].map((port) => port.label), ["port1"]);
  assert.equal(rendererMessages[0].channel, "netcatty:terminal-urgent-input-port");
  assert.deepEqual(rendererMessages[0].transferList.map((port) => port.label), ["port2"]);
});

test("destroying a renderer closes its dedicated urgent input port", async () => {
  const child = new FakeChild();
  const contents = new EventEmitter();
  contents.id = 7;
  contents.postMessage = () => {};
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    MessageChannelMain: FakeMessageChannelMain,
    electronModule: { webContents: { fromId: () => contents } },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  contents.emit("destroyed");

  assert.ok(child.messages.some((message) => (
    message.kind === "close-urgent-input-port" && message.webContentsId === 7
  )));
});

test("failed renderer urgent-input transfer closes the worker port", async () => {
  const child = new FakeChild();
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    MessageChannelMain: FakeMessageChannelMain,
    electronModule: {
      webContents: {
        fromId: () => ({ id: 7, postMessage() { throw new Error("destroyed"); } }),
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;

  assert.ok(child.messages.some((message) => (
    message.kind === "close-urgent-input-port" && message.webContentsId === 7
  )));
});

test("output-port-ready flushes output that arrived during port transfer", async () => {
  const child = new FakeChild();
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        return outputPort;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "during-transfer",
  });
  emitOutputPortReady(child, "local-1");

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: ["during-transfer"],
  });
});

test("a stale output-port-ready cannot release a reused session route", async () => {
  const child = new FakeChild();
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    MessageChannelMain: FakeMessageChannelMain,
    terminalOutputChannel: {
      openSession() {
        return new FakePort("worker-output");
      },
      closeSession() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await first;
  const oldOpen = child.messages.find((message) => message.kind === "output-port");

  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });
  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });
  await second;
  const newOpen = [...child.messages].reverse().find((message) => message.kind === "output-port");
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "NEW-PENDING",
    sessionGeneration: 1,
    originRequestId: secondRequest.requestId,
  });

  child.emit("message", {
    kind: "output-port-ready",
    sessionId: "session-1",
    sessionGeneration: oldOpen.sessionGeneration,
    outputPortRequestId: oldOpen.outputPortRequestId,
  });
  assert.equal(
    child.messages.some((message) => message.kind === "output-flush"),
    false,
  );

  child.emit("message", {
    kind: "output-port-ready",
    sessionId: "session-1",
    sessionGeneration: newOpen.sessionGeneration,
    outputPortRequestId: newOpen.outputPortRequestId,
  });
  assert.deepEqual(child.messages.at(-1), {
    kind: "output-flush",
    sessionId: "session-1",
    chunks: ["NEW-PENDING"],
  });

  assert.equal((await manager.rebindOutputSession("session-1", 9)).success, true);
  assert.equal(manager.drainOutputSession("session-1", "too-early"), false);
  const reboundOpen = [...child.messages].reverse().find((message) => (
    message.kind === "output-port"
  ));
  child.emit("message", {
    kind: "output-port-ready",
    sessionId: "session-1",
    sessionGeneration: reboundOpen.sessionGeneration,
    outputPortRequestId: reboundOpen.outputPortRequestId,
  });
  assert.equal(manager.drainOutputSession("session-1", "after-ready"), true);
  assert.deepEqual(child.messages.at(-1), {
    kind: "output-drain",
    sessionId: "session-1",
    requestId: "after-ready",
  });
});

test("worker buffered output byte cap preserves split alternate-screen metadata", async () => {
  const child = new FakeChild();
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        return outputPort;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    maxPendingOutputBytes: "hREADY".length,
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "\x1b[?1049hREADY",
  });
  emitOutputPortReady(child, "local-1");

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: [{
      data: "hREADY",
      meta: {
        droppedOutputMayAffectTerminalState: true,
        droppedOutputAlternateScreenAction: "enter",
      },
    }],
  });
});

test("worker buffered output chunk cap carries dropped metadata to retained output", async () => {
  const child = new FakeChild();
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        return outputPort;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    maxPendingOutputChunks: 1,
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "old",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "READY",
  });
  emitOutputPortReady(child, "local-1");

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: [{
      data: "READY",
      meta: { droppedOutputMayAffectTerminalState: true },
    }],
  });
});

test("metadata-only interceptor output obeys the pending chunk cap", async () => {
  const child = new FakeChild();
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork() { return child; } },
    terminalOutputChannel: { openSession() { return outputPort; } },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    maxPendingOutputChunks: 1,
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  for (let index = 0; index < 3; index += 1) {
    child.emit("message", {
      kind: "output",
      sessionId: "local-1",
      data: "",
      meta: { pluginPipelineIngressBytes: 1 },
    });
  }
  emitOutputPortReady(child, "local-1");

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: [{ data: "", meta: { pluginPipelineIngressBytes: 3 } }],
  });
});

test("pending output merge keeps state and provenance from only the latest raw chunk", async () => {
  const child = new FakeChild();
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork() { return child; } },
    terminalOutputChannel: { openSession() { return outputPort; } },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    maxPendingOutputChunks: 1,
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "Password: ",
    meta: {
      pluginPipelineIngressBytes: 10,
      pluginPipelineProcessed: true,
      pluginPipelineSensitiveInput: true,
    },
  });
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "READY",
  });
  emitOutputPortReady(child, "local-1");

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: [{ data: "READY", meta: { pluginPipelineIngressBytes: 10 } }],
  });
});

test("partial trimming carries sliced raw ingress into inherited flow accounting", async () => {
  const child = new FakeChild();
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork() { return child; } },
    terminalOutputChannel: { openSession() { return outputPort; } },
    electronModule: { webContents: { fromId(id) { return { id }; } } },
    maxPendingOutputBytes: 5,
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "",
    meta: { pluginPipelineIngressBytes: 10, pluginPipelineProcessed: true },
  });
  child.emit("message", { kind: "output", sessionId: "local-1", data: "abcde" });
  child.emit("message", { kind: "output", sessionId: "local-1", data: "Z" });
  emitOutputPortReady(child, "local-1");

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: [
      { data: "bcde", meta: { pluginPipelineIngressBytes: 11 } },
      "Z",
    ],
  });
});

test("worker fallback output after a ready output port is delivered over legacy IPC", async () => {
  const child = new FakeChild();
  const sent = [];
  const closed = [];
  const outputPort = { label: "worker-output-port" };
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        return outputPort;
      },
      closeSession(sessionId) {
        closed.push(sessionId);
      },
      send() {
        throw new Error("ready worker fallback output should not be sent back through main output channel");
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            id,
            send(channel, payload) {
              sent.push({ id, channel, payload });
            },
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;
  emitOutputPortReady(child, "local-1");

  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "fallback",
  });

  assert.deepEqual(sent, [
    {
      id: 7,
      channel: "netcatty:data",
      payload: { sessionId: "local-1", data: "fallback" },
    },
  ]);
  assert.deepEqual(closed, ["local-1"]);
  assert.equal(child.messages.some((message) => message.kind === "output-flush" && message.chunks?.includes("fallback")), false);
});

test("falls back to netcatty:data when no output port is available", async () => {
  const child = new FakeChild();
  const sent = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        return false;
      },
      send() {
        return false;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            id,
            send(channel, payload) {
              sent.push({ id, channel, payload });
            },
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "output",
    sessionId: "local-1",
    data: "early",
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;

  assert.deepEqual(sent, [
    {
      id: 7,
      channel: "netcatty:data",
      payload: { sessionId: "local-1", data: "early" },
    },
  ]);
});

test("send posts fire-and-forget control commands to the worker", () => {
  const child = new FakeChild();
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.send("netcatty:interrupt", { sessionId: "session-1" }, { webContentsId: 7 });

  assert.deepEqual(child.messages, [
    {
      kind: "send",
      channel: "netcatty:interrupt",
      payload: { sessionId: "session-1" },
      webContentsId: 7,
    },
  ]);
});

test("worker output is routed through the dedicated terminal output channel", () => {
  const child = new FakeChild();
  const routed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      send(sessionId, data) {
        routed.push({ sessionId, data });
        return true;
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.ensureStarted();
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "hello",
  });

  assert.deepEqual(routed, [{ sessionId: "session-1", data: "hello" }]);
});

test("worker output notifies output taps before renderer routing", () => {
  const child = new FakeChild();
  const routed = [];
  const tapped = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      send(sessionId, data) {
        routed.push({ sessionId, data });
        return true;
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.addOutputTap((sessionId, data) => tapped.push({ sessionId, data }));
  manager.ensureStarted();
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "hello",
  });

  assert.deepEqual(tapped, [{ sessionId: "session-1", data: "hello" }]);
  assert.deepEqual(routed, [{ sessionId: "session-1", data: "hello" }]);
});

test("worker fallback output already announced via output-tap does not notify taps twice", () => {
  const child = new FakeChild();
  const routed = [];
  const tapped = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      send(sessionId, data) {
        routed.push({ sessionId, data });
        return true;
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.addOutputTap((sessionId, data) => tapped.push({ sessionId, data }));
  manager.ensureStarted();
  // The runtime sender emits an output-tap message, then falls back to a
  // plain output message for the same chunk when the output port is not
  // usable. Taps must fire exactly once for that chunk.
  child.emit("message", {
    kind: "output-tap",
    sessionId: "session-1",
    data: "hello",
  });
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "hello",
    tapped: true,
  });

  assert.deepEqual(tapped, [{ sessionId: "session-1", data: "hello" }]);
  assert.deepEqual(routed, [{ sessionId: "session-1", data: "hello" }]);
});

test("worker output-tap messages notify taps without duplicate renderer routing", () => {
  const child = new FakeChild();
  const routed = [];
  const tapped = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      send(sessionId, data) {
        routed.push({ sessionId, data });
        return true;
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.addOutputTap((sessionId, data) => tapped.push({ sessionId, data }));
  manager.ensureStarted();
  child.emit("message", {
    kind: "output-tap",
    sessionId: "session-1",
    data: "direct-port-output",
  });

  assert.deepEqual(tapped, [{ sessionId: "session-1", data: "direct-port-output" }]);
  assert.deepEqual(routed, []);
});

test("worker buffers early output until the output port is opened", async () => {
  const child = new FakeChild();
  const routed = [];
  let opened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        opened = true;
      },
      send(sessionId, data) {
        if (!opened) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "hello",
  });
  assert.deepEqual(routed, []);

  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await promise;

  assert.deepEqual(routed, [{ sessionId: "session-1", data: "hello" }]);
});

test("close immediately clears the output route and drops pending output", async () => {
  const child = new FakeChild();
  const closed = [];
  const routed = [];
  let opened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        opened = true;
      },
      send(sessionId, data) {
        if (!opened) return false;
        routed.push({ sessionId, data });
        return true;
      },
      closeSession(sessionId) {
        closed.push(sessionId);
        opened = false;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "old",
  });
  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await assert.rejects(promise, /closed before its output route opened/u);
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "late",
  });

  assert.deepEqual(closed, ["session-1"]);
  assert.deepEqual(routed, []);
});

test("await close immediately clears the output route and drops pending output", async () => {
  const child = new FakeChild();
  const closed = [];
  const routed = [];
  let opened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        opened = true;
      },
      send(sessionId, data) {
        if (!opened) return false;
        routed.push({ sessionId, data });
        return true;
      },
      closeSession(sessionId) {
        closed.push(sessionId);
        opened = false;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const startPromise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await startPromise;
  assert.equal(manager.hasOpenSession("session-1"), true);

  const closePromise = manager.request("netcatty:close:await", { sessionId: "session-1" }, { webContentsId: 7 });
  assert.equal(manager.hasOpenSession("session-1"), false);
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "late",
  });
  const closeRequest = child.messages.find((message) => message.channel === "netcatty:close:await");
  child.emit("message", {
    kind: "response",
    requestId: closeRequest.requestId,
    result: { sessionId: "session-1" },
  });
  await closePromise;

  assert.deepEqual(closed, ["session-1"]);
  assert.deepEqual(routed, []);
  assert.equal(manager.hasOpenSession("session-1"), false);
});

test("worker renderer events are forwarded to their original webContents", () => {
  const child = new FakeChild();
  const forwarded = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            send(channel, payload) {
              forwarded.push({ id, channel, payload });
            },
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.ensureStarted();
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1" },
  });

  assert.deepEqual(forwarded, [
    { id: 7, channel: "netcatty:exit", payload: { sessionId: "session-1" } },
  ]);
});

test("worker renderer events wrapped in MessageEvent data are forwarded", () => {
  const child = new FakeChild();
  const forwarded = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            send(channel, payload) {
              forwarded.push({ id, channel, payload });
            },
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.ensureStarted();
  child.emit("message", {
    data: {
      kind: "renderer-event",
      webContentsId: 7,
      channel: "netcatty:zmodem:progress",
      payload: {
        sessionId: "session-1",
        filename: "large.bin",
        transferred: 1024,
        total: 2048,
        transferType: "download",
      },
    },
  });

  assert.deepEqual(forwarded, [
    {
      id: 7,
      channel: "netcatty:zmodem:progress",
      payload: {
        sessionId: "session-1",
        filename: "large.bin",
        transferred: 1024,
        total: 2048,
        transferType: "download",
      },
    },
  ]);
});

test("worker terminal exit notifies host session lifecycle listeners", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));
  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await start;

  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "exited" },
  });

  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "exited" }]);
});

test("explicit close notifies host session lifecycle exactly once before the worker exit", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));
  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await start;

  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "exited" },
  });
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
});

test("a duplicate exit from an old session generation cannot close a reconnected session", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const first = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await first;
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "error" },
    sessionGeneration: 0,
  });

  const reconnect = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages.at(-1).requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });
  await reconnect;
  assert.equal(manager.hasOpenSession("session-1"), true);

  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "close" },
    sessionGeneration: 0,
  });

  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "error" }]);
});

test("a duplicate old-generation exit cannot cancel a pending same-id reconnect", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const first = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await first;
  const oldExit = {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "error" },
    sessionGeneration: 0,
  };
  child.emit("message", oldExit);

  const reconnect = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  child.emit("message", oldExit);
  child.emit("message", {
    kind: "response",
    requestId: child.messages.at(-1).requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await reconnect;
  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "error" }]);
});

test("an old-generation exit after explicit close cannot cancel a pending reconnect", async () => {
  const child = new FakeChild();
  const closed = [];
  const routed = [];
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() {
        outputOpen = true;
        return true;
      },
      closeSession() {
        outputOpen = false;
      },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const first = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const firstRequestId = child.messages[0].requestId;
  child.emit("message", {
    kind: "response",
    requestId: firstRequestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await first;
  const staleReplacement = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const staleRequest = child.messages.at(-1);
  const staleRejected = assert.rejects(staleReplacement, /close failed/u);
  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });

  const reconnect = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 9,
  });
  const reconnectRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "session-superseding",
    sessionId: "session-1",
    sessionGeneration: 0,
    replacementRequestId: staleRequest.requestId,
  });
  child.emit("message", {
    kind: "response",
    requestId: staleRequest.requestId,
    error: "close failed",
  });
  await staleRejected;
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "STALE-OLD",
    sessionGeneration: 0,
    originRequestId: firstRequestId,
  });
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "NEW-EARLY",
    sessionGeneration: 1,
    originRequestId: reconnectRequest.requestId,
  });
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "closed" },
    sessionGeneration: 0,
  });
  child.emit("message", {
    kind: "response",
    requestId: reconnectRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await reconnect;
  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
  assert.deepEqual(routed, [{ sessionId: "session-1", data: "NEW-EARLY" }]);
});

test("a closed pending start response records its generation before a later reconnect", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const first = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  const firstRequest = child.messages.at(-1);
  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await assert.rejects(first, /closed before its output route opened/u);

  const second = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "closed" },
    sessionGeneration: 0,
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages.at(-1).requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await second;
  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
});

test("a much older exit cannot cancel a reconnect after multiple generations", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: { webContents: { fromId: (id) => ({ id, isDestroyed: () => false, send() {} }) } },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await start;
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "gen-0" },
    sessionGeneration: 0,
  });

  const second = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages.at(-1).requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });
  await second;
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "gen-1" },
    sessionGeneration: 1,
  });

  const third = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "late-gen-0" },
    sessionGeneration: 0,
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages.at(-1).requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 2,
  });

  await third;
  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.deepEqual(closed, [
    { sessionId: "session-1", reason: "gen-0" },
    { sessionId: "session-1", reason: "gen-1" },
  ]);
});

test("rebound interactive events target only the popup while exit also reaches home", async () => {
  const child = new FakeChild();
  const forwarded = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork() { return child; } },
    terminalOutputChannel: {
      openSession() { return true; },
      closeSession() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            id,
            isDestroyed() { return false; },
            send(channel, payload) { forwarded.push({ id, channel, payload }); },
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const started = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await started;
  assert.equal((await manager.rebindOutputSession("session-1", 9)).success, true);

  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:zmodem:overwrite-request",
    payload: { sessionId: "session-1", requestId: "request-1" },
  });
  assert.deepEqual(forwarded, [{
    id: 9,
    channel: "netcatty:zmodem:overwrite-request",
    payload: { sessionId: "session-1", requestId: "request-1" },
  }]);

  forwarded.length = 0;
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "exited" },
  });
  assert.deepEqual(forwarded, [
    { id: 9, channel: "netcatty:exit", payload: { sessionId: "session-1", reason: "exited" } },
    { id: 7, channel: "netcatty:exit", payload: { sessionId: "session-1", reason: "exited" } },
  ]);
});

test("rebind waits for ownership and routes interactive events to the pending renderer", async () => {
  const child = new FakeChild();
  const forwarded = [];
  const dialogOwners = [];
  let releaseRebind;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork() { return child; } },
    terminalOutputChannel: { openSession() { return true; }, closeSession() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            id,
            isDestroyed() { return false; },
            send(channel, payload) { forwarded.push({ id, channel, payload }); },
          };
        },
      },
      BrowserWindow: {
        fromWebContents(contents) { return { webContentsId: contents.id }; },
      },
      dialog: {
        async showOpenDialog(owner) {
          dialogOwners.push(owner?.webContentsId ?? null);
          return { canceled: true, filePaths: [] };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(({ webContentsId }) => (
    webContentsId === 9
      ? new Promise((resolve) => { releaseRebind = resolve; })
      : undefined
  ));

  const started = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await started;

  let settled = false;
  const rebound = manager.rebindOutputSession("session-1", 9).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(manager.getSessionWebContentsId("session-1"), 7);
  assert.equal(manager.getSessionOwnerWebContentsId("session-1"), 9);

  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:zmodem:overwrite-request",
    payload: { sessionId: "session-1", requestId: "request-1" },
  });
  assert.deepEqual(forwarded, [{
    id: 9,
    channel: "netcatty:zmodem:overwrite-request",
    payload: { sessionId: "session-1", requestId: "request-1" },
  }]);

  child.emit("message", {
    kind: "zmodem-upload-dialog",
    requestId: "upload-dialog-1",
    sessionId: "session-1",
    webContentsId: 7,
  });
  child.emit("message", {
    kind: "zmodem-download-dialog",
    requestId: "download-dialog-1",
    sessionId: "session-1",
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dialogOwners, [9, 9]);

  releaseRebind();
  assert.equal((await rebound).success, true);
  assert.equal(manager.getSessionWebContentsId("session-1"), 9);
  assert.equal(manager.getSessionOwnerWebContentsId("session-1"), 9);
});

test("failed output-port transfer retires the dead worker before the next start", async () => {
  const children = [];
  const child = new FakeChild();
  children.push(child);
  const postMessage = child.postMessage.bind(child);
  child.postMessage = (message, transferList) => {
    if (message?.kind === "output-port") {
      throw new Error("worker transfer failed");
    }
    postMessage(message, transferList);
  };
  const closed = [];
  let openCount = 0;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        if (children.length === 1) return child;
        return children.at(-1);
      },
    },
    terminalOutputChannel: {
      openSession() {
        openCount += 1;
        return openCount === 1 ? true : { label: "worker-output-port" };
      },
      send() { return false; },
      closeSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            id,
            isDestroyed() { return false; },
            send() {},
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const started = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await started;

  const rebound = manager.rebindOutputSession("session-1", 9);
  child.emit("message", { kind: "output", sessionId: "session-1", data: "buffered" });
  assert.deepEqual(await rebound, {
    success: false,
    error: "Failed to rebind session output",
  });
  assert.equal(manager.hasOpenSession("session-1"), false);
  assert.equal(child.killed, true);
  assert.equal(manager.getSessionWebContentsId("session-1"), null);
  assert.equal(manager.getAttachHomeWebContentsId("session-1"), null);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "worker-exit" }]);

  const replacement = new FakeChild();
  children.push(replacement);
  const restarted = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 9,
  });
  replacement.emit("message", {
    kind: "response",
    requestId: replacement.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await restarted;
  child.emit("exit", 1);
  assert.equal(manager.hasOpenSession("session-1"), true);
});

test("explicit close notifies both a rebound popup and its home renderer", async () => {
  const child = new FakeChild();
  const forwarded = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession: () => true, closeSession() {} },
    electronModule: {
      webContents: {
        fromId: (id) => ({
          id,
          isDestroyed: () => false,
          send: (channel, payload) => forwarded.push({ id, channel, payload }),
        }),
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const started = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await started;
  assert.equal((await manager.rebindOutputSession("session-1", 9)).success, true);

  const closing = manager.request(
    "netcatty:close:await",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const closeRequest = child.messages.at(-1);
  child.emit("message", { kind: "response", requestId: closeRequest.requestId, result: undefined });
  await closing;

  assert.deepEqual(forwarded, [
    { id: 9, channel: "netcatty:exit", payload: { sessionId: "session-1", exitCode: 0, reason: "closed" } },
    { id: 7, channel: "netcatty:exit", payload: { sessionId: "session-1", exitCode: 0, reason: "closed" } },
  ]);
  assert.equal(manager.getAttachHomeWebContentsId("session-1"), null);
  assert.equal(manager.hasOpenSession("session-1"), false);

  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "closed" },
  });
  assert.equal(forwarded.length, 2, "worker transport close is not forwarded twice");

  const lateFlow = manager.request(
    "netcatty:terminal:setFlowPausedAndWait",
    { sessionId: "session-1", paused: true },
    { webContentsId: 9 },
  );
  const flowRequest = child.messages.at(-1);
  child.emit("message", { kind: "response", requestId: flowRequest.requestId, result: { success: false } });
  await lateFlow;
  assert.equal(manager.hasOpenSession("session-1"), false, "late control requests cannot reopen a closed session");
});

test("worker exit events close the session output route", () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      closeSession(sessionId) {
        closed.push(sessionId);
      },
    },
    electronModule: {
      webContents: {
        fromId() {
          return { send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  manager.ensureStarted();
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1" },
  });

  assert.deepEqual(closed, ["session-1"]);
});

test("worker exit rejects pending requests and closes output routes", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      closeAll() {
        closed.push("all");
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });

  child.emit("exit", 1);

  await assert.rejects(promise, /Terminal worker exited/);
  assert.deepEqual(closed, ["all"]);
});

test("worker exit closes a session identified by output before its start response", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { closeAll() {} },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", { kind: "output", sessionId: "session-1", data: "banner" });
  child.emit("exit", 1);

  await assert.rejects(start, /Terminal worker exited/u);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "worker-exit" }]);
});

test("worker exit closes a session identified only by an output tap before its start response", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { closeAll() {} },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", { kind: "output-tap", sessionId: "session-1", data: "banner" });
  child.emit("exit", 1);

  await assert.rejects(start, /Terminal worker exited/u);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "worker-exit" }]);
});

test("worker stop clears buffered output byte accounting before session id reuse", async () => {
  const children = [];
  const routed = [];
  let opened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        opened = true;
      },
      send(sessionId, data) {
        if (!opened) return false;
        routed.push({ sessionId, data });
        return true;
      },
      closeAll() {
        opened = false;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id };
        },
      },
    },
    maxPendingOutputBytes: "READY".length,
    workerScriptPath: "/worker.cjs",
  });

  const firstChild = manager.ensureStarted();
  firstChild.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "oldold",
  });
  manager.stop();

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "READY",
  });
  secondChild.emit("message", {
    kind: "response",
    requestId: secondChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await promise;

  assert.deepEqual(routed, [{ sessionId: "session-1", data: "READY" }]);
});

test("a replacement worker can deliver generation-zero early output after a crash", async () => {
  const children = [];
  const routed = [];
  let opened = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {
        opened = true;
      },
      send(sessionId, data) {
        if (!opened) return false;
        routed.push({ sessionId, data });
        return true;
      },
      closeAll() {
        opened = false;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstChild = children[0];
  const firstRequest = firstChild.messages.at(-1);
  firstChild.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await first;
  firstChild.emit("exit", 1);

  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondChild = children[1];
  const secondRequest = secondChild.messages.at(-1);
  secondChild.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "NEW-WORKER-EARLY",
    sessionGeneration: 0,
    originRequestId: secondRequest.requestId,
  });
  secondChild.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await second;

  assert.deepEqual(routed, [{ sessionId: "session-1", data: "NEW-WORKER-EARLY" }]);
});

test("a stale worker exit cannot close sessions owned by its replacement", async () => {
  const children = [];
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const firstChild = manager.ensureStarted();
  manager.stop();
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "response",
    requestId: secondChild.messages[0].requestId,
    result: { sessionId: "session-2" },
  });
  await start;

  firstChild.emit("exit", 1);
  assert.deepEqual(closed, []);
  assert.equal(manager.hasOpenSession("session-2"), true);

  secondChild.emit("exit", 1);
  assert.deepEqual(closed, [{ sessionId: "session-2", reason: "worker-exit" }]);
  assert.equal(manager.hasOpenSession("session-2"), false);
});

test("closing a crashed session is idempotent until a new worker reuses its id", async () => {
  const children = [];
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const firstStart = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const firstChild = children[0];
  firstChild.emit("message", {
    kind: "response",
    requestId: firstChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await firstStart;
  firstChild.emit("exit", 1);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "worker-exit" }]);

  const close = manager.request("netcatty:close:await", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  if (children[1]) {
    const closeRequest = children[1].messages.at(-1);
    children[1].emit("message", {
      kind: "response",
      requestId: closeRequest.requestId,
      result: { sessionId: "session-1" },
    });
  }
  await close;
  assert.equal(children.length, 1);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "worker-exit" }]);

  const secondStart = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "response",
    requestId: secondChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await secondStart;
  secondChild.emit("exit", 1);
  assert.deepEqual(closed, [
    { sessionId: "session-1", reason: "worker-exit" },
    { sessionId: "session-1", reason: "worker-exit" },
  ]);
});

test("an old start response cannot reopen a session claimed by a later same-id start", async () => {
  const child = new FakeChild();
  const routed = [];
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() { outputOpen = true; },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const first = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  const firstRequest = child.messages.at(-1);
  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });
  const second = manager.request("netcatty:local:reconnect", { sessionId: "session-1" }, {
    webContentsId: 7,
  });
  const secondRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "new-banner",
    sessionGeneration: 1,
    originRequestId: secondRequest.requestId,
  });

  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await assert.rejects(first, /superseded by a newer start request/u);
  assert.equal(manager.hasOpenSession("session-1"), false);

  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });
  await second;
  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.deepEqual(routed, [{ sessionId: "session-1", data: "new-banner" }]);
});

test("a later same-id start response cannot be overwritten by an older response", async () => {
  const child = new FakeChild();
  const owners = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned((event) => owners.push(event));

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);

  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 2,
  });
  await second;
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await assert.rejects(first, /superseded by a newer start request/u);
  assert.deepEqual(owners, [{ sessionId: "session-1", webContentsId: 8 }]);
});

test("a later same-id start does not inherit ambiguous output from an older pending start", async () => {
  const child = new FakeChild();
  const routed = [];
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() { outputOpen = true; },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  void first.catch(() => {});
  const firstRequest = child.messages.at(-1);
  child.emit("message", { kind: "output", sessionId: "session-1", data: "OLD" });

  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);
  child.emit("message", { kind: "output", sessionId: "session-1", data: "AMBIGUOUS" });
  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
  });
  await second;
  child.emit("message", { kind: "output", sessionId: "session-1", data: "NEW" });

  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
  });
  await assert.rejects(first, /superseded by a newer start request/u);
  assert.deepEqual(routed, [{ sessionId: "session-1", data: "NEW" }]);
});

test("a serialized same-id restart keeps its generation-bound early output", async () => {
  const child = new FakeChild();
  const routed = [];
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() { outputOpen = true; },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);

  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await assert.rejects(first, /superseded by a newer start request/u);
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "NEW-EARLY",
    sessionGeneration: 1,
  });
  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await second;
  assert.deepEqual(routed, [{ sessionId: "session-1", data: "NEW-EARLY" }]);
});

test("an internal same-id replacement exit retires only the old generation", async () => {
  const child = new FakeChild();
  const routed = [];
  const closed = [];
  let outputOpen = false;
  let outputWebContentsId = null;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession(_sessionId, contents) {
        outputOpen = true;
        outputWebContentsId = contents.id;
      },
      closeSession() {
        outputOpen = false;
        outputWebContentsId = null;
      },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data, webContentsId: outputWebContentsId });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await first;

  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "session-superseding",
    sessionId: "session-1",
    sessionGeneration: 0,
    replacementRequestId: secondRequest.requestId,
  });
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", exitCode: 0, reason: "closed" },
    sessionGeneration: 0,
  });
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "NEW-EARLY",
    sessionGeneration: 1,
    originRequestId: secondRequest.requestId,
  });
  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await second;
  assert.deepEqual(routed, [{
    sessionId: "session-1",
    data: "NEW-EARLY",
    webContentsId: 8,
  }]);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
  assert.equal(outputOpen, true);
  assert.equal(
    child.messages.some((message) => (
      message.kind === "close-output-port" && message.sessionId === "session-1"
    )),
    false,
  );
});

test("a failed replacement is not reported closed again when the worker exits", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession() {}, closeSession() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await first;

  const replacement = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const replacementRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "session-superseding",
    sessionId: "session-1",
    sessionGeneration: 0,
    replacementRequestId: replacementRequest.requestId,
  });
  child.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "closed" },
    sessionGeneration: 0,
  });
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "FAILED-EARLY",
    sessionGeneration: 1,
    originRequestId: replacementRequest.requestId,
  });
  child.emit("message", {
    kind: "response",
    requestId: replacementRequest.requestId,
    error: "start failed",
  });
  await assert.rejects(replacement, /start failed/u);
  child.emit("exit", 1);

  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
});

test("manager and runtime preserve a completed same-id replacement end to end", async () => {
  const child = new LinkedRuntimeChild();
  const order = [];
  const routed = [];
  const closed = [];
  let active = null;
  let outputWebContentsId = null;
  child.connectRuntime((ipcMain) => {
    ipcMain.handle("netcatty:local:reconnect", (event, payload) => {
      const generation = event.sender.claimSessionGeneration(payload.sessionId);
      order.push(`start:${payload.attempt}:g${generation}`);
      active = { attempt: payload.attempt, generation, sender: event.sender };
      event.sender.send("netcatty:data", {
        sessionId: payload.sessionId,
        data: payload.attempt === "second" ? "NEW-EARLY" : "OLD",
        _terminalSessionGeneration: generation,
      });
      return { sessionId: payload.sessionId };
    });
    ipcMain.handle("netcatty:close:await", (_event, payload) => {
      order.push(`close:${active.attempt}:g${active.generation}`);
      active.sender.send("netcatty:exit", {
        sessionId: payload.sessionId,
        exitCode: 0,
        reason: "closed",
        _terminalSessionGeneration: active.generation,
      });
      active = null;
    });
  });
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession(_sessionId, contents) {
        outputWebContentsId = contents.id;
        return true;
      },
      closeSession() {
        outputWebContentsId = null;
      },
      send(sessionId, data) {
        if (outputWebContentsId == null) return false;
        routed.push({ sessionId, data, webContentsId: outputWebContentsId });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  await manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1", attempt: "first" },
    { webContentsId: 7 },
  );
  await manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1", attempt: "second" },
    { webContentsId: 8 },
  );

  assert.deepEqual(order, [
    "start:first:g0",
    "close:first:g0",
    "start:second:g1",
  ]);
  assert.deepEqual(routed, [
    { sessionId: "session-1", data: "OLD", webContentsId: 7 },
    { sessionId: "session-1", data: "NEW-EARLY", webContentsId: 8 },
  ]);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
  assert.equal(outputWebContentsId, 8);
  assert.equal(
    child.messages.some((message) => (
      message.kind === "close-output-port" && message.sessionId === "session-1"
    )),
    false,
  );
});

test("a failed replacement close cannot let the old exit cancel the next start", async () => {
  const child = new LinkedRuntimeChild();
  const order = [];
  const routed = [];
  let active = null;
  let closeAttempts = 0;
  let outputWebContentsId = null;
  child.connectRuntime((ipcMain) => {
    ipcMain.handle("netcatty:local:reconnect", (event, payload) => {
      const generation = event.sender.claimSessionGeneration(payload.sessionId);
      order.push(`start:${payload.attempt}:g${generation}`);
      active = { attempt: payload.attempt, generation, sender: event.sender };
      event.sender.send("netcatty:data", {
        sessionId: payload.sessionId,
        data: payload.attempt,
        _terminalSessionGeneration: generation,
      });
      return { sessionId: payload.sessionId };
    });
    ipcMain.handle("netcatty:close:await", (_event, payload) => {
      closeAttempts += 1;
      order.push(`close:${active.attempt}:g${active.generation}`);
      if (closeAttempts === 1) throw new Error("close failed");
      active.sender.send("netcatty:exit", {
        sessionId: payload.sessionId,
        exitCode: 0,
        reason: "closed",
        _terminalSessionGeneration: active.generation,
      });
      active = null;
    });
  });
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession(_sessionId, contents) {
        outputWebContentsId = contents.id;
        return true;
      },
      closeSession() {
        outputWebContentsId = null;
      },
      send(sessionId, data) {
        if (outputWebContentsId == null) return false;
        routed.push({ sessionId, data, webContentsId: outputWebContentsId });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  await manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1", attempt: "R1" },
    { webContentsId: 7 },
  );
  await assert.rejects(
    manager.request(
      "netcatty:local:reconnect",
      { sessionId: "session-1", attempt: "R2" },
      { webContentsId: 8 },
    ),
    /close failed/u,
  );
  await manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1", attempt: "R3" },
    { webContentsId: 9 },
  );

  assert.deepEqual(order, [
    "start:R1:g0",
    "close:R1:g0",
    "close:R1:g0",
    "start:R3:g2",
  ]);
  assert.deepEqual(routed, [
    { sessionId: "session-1", data: "R1", webContentsId: 7 },
    { sessionId: "session-1", data: "R3", webContentsId: 9 },
  ]);
  assert.equal(outputWebContentsId, 9);
  assert.equal(
    child.messages.some((message) => (
      message.kind === "close-output-port" && message.sessionId === "session-1"
    )),
    false,
  );
});

test("a failed replacement start cannot leak its early output into the next start", async () => {
  const child = new LinkedRuntimeChild();
  const routed = [];
  let active = null;
  let outputWebContentsId = null;
  child.connectRuntime((ipcMain) => {
    ipcMain.handle("netcatty:local:reconnect", (event, payload) => {
      const generation = event.sender.claimSessionGeneration(payload.sessionId);
      event.sender.send("netcatty:data", {
        sessionId: payload.sessionId,
        data: `${payload.attempt}-EARLY`,
        _terminalSessionGeneration: generation,
      });
      if (payload.attempt === "R2") throw new Error("start failed");
      active = { generation, sender: event.sender };
      return { sessionId: payload.sessionId };
    });
    ipcMain.handle("netcatty:close:await", (_event, payload) => {
      if (!active) return;
      active.sender.send("netcatty:exit", {
        sessionId: payload.sessionId,
        exitCode: 0,
        reason: "closed",
        _terminalSessionGeneration: active.generation,
      });
      active = null;
    });
  });
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession(_sessionId, contents) {
        outputWebContentsId = contents.id;
        return true;
      },
      closeSession() {
        outputWebContentsId = null;
      },
      send(sessionId, data) {
        if (outputWebContentsId == null) return false;
        routed.push({ sessionId, data, webContentsId: outputWebContentsId });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  await manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1", attempt: "R1" },
    { webContentsId: 7 },
  );
  await assert.rejects(
    manager.request(
      "netcatty:local:reconnect",
      { sessionId: "session-1", attempt: "R2" },
      { webContentsId: 8 },
    ),
    /start failed/u,
  );
  await manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1", attempt: "R3" },
    { webContentsId: 9 },
  );

  assert.deepEqual(routed, [
    { sessionId: "session-1", data: "R1-EARLY", webContentsId: 7 },
    { sessionId: "session-1", data: "R3-EARLY", webContentsId: 9 },
  ]);
  assert.equal(outputWebContentsId, 9);
});

test("overlapping same-id reconnects keep only the latest request's early output", async () => {
  const child = new FakeChild();
  const routed = [];
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() { outputOpen = true; },
      closeSession() { outputOpen = false; },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const initial = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await initial;
  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);

  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "OLD-FIRST",
    sessionGeneration: 1,
    originRequestId: firstRequest.requestId,
  });
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });
  await assert.rejects(first, /superseded by a newer start request/u);
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "NEW-SECOND",
    sessionGeneration: 2,
    originRequestId: secondRequest.requestId,
  });
  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 2,
  });

  await second;
  assert.deepEqual(routed, [{ sessionId: "session-1", data: "NEW-SECOND" }]);
});

test("a superseded ownership waiter cannot flush the latest reconnect output to its old renderer", async () => {
  const child = new FakeChild();
  const routed = [];
  let currentOwner = null;
  let releaseFirstOwnership;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession(_sessionId, contents) { currentOwner = contents.id; },
      closeSession() { currentOwner = null; },
      send(sessionId, data) {
        if (currentOwner == null) return false;
        routed.push({ sessionId, data, webContentsId: currentOwner });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionOwned(({ webContentsId }) => {
    if (webContentsId !== 7) return undefined;
    return new Promise((resolve) => { releaseFirstOwnership = resolve; });
  });

  const initial = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 6 },
  );
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await initial;
  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 6 });

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });
  while (!releaseFirstOwnership) await new Promise((resolve) => setImmediate(resolve));

  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);
  child.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "LATEST-EARLY",
    sessionGeneration: 2,
    originRequestId: secondRequest.requestId,
  });

  releaseFirstOwnership();
  await assert.rejects(first, /superseded by a newer start request/u);
  assert.deepEqual(routed, []);

  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 2,
  });
  await second;
  assert.deepEqual(routed, [{
    sessionId: "session-1",
    data: "LATEST-EARLY",
    webContentsId: 8,
  }]);
});

test("a superseded start failure cannot cancel the queued same-id restart", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const first = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstRequest = child.messages.at(-1);
  const second = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 8 },
  );
  const secondRequest = child.messages.at(-1);

  child.emit("message", {
    kind: "renderer-event",
    originRequestId: firstRequest.requestId,
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "failed" },
    sessionGeneration: 0,
  });
  await assert.rejects(first, /superseded by a newer start request/u);
  child.emit("message", {
    kind: "response",
    requestId: firstRequest.requestId,
    error: "first failed",
  });
  child.emit("message", {
    kind: "response",
    requestId: secondRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await second;
  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "failed" }]);
});

test("a failed reconnect after worker exit keeps later close cleanup idempotent", async () => {
  const children = [];
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const firstChild = children[0];
  firstChild.emit("message", {
    kind: "response",
    requestId: firstChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await start;
  firstChild.emit("exit", 1);

  const reconnect = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "response",
    requestId: secondChild.messages[0].requestId,
    error: "reconnect failed",
  });
  await assert.rejects(reconnect, /reconnect failed/u);

  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });
  assert.equal(children.length, 2);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "worker-exit" }]);
});

test("a same-id reconnect that outputs before another worker exit closes its new lifecycle", async () => {
  const children = [];
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const firstChild = children[0];
  firstChild.emit("message", {
    kind: "response",
    requestId: firstChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await start;
  firstChild.emit("exit", 1);

  const reconnect = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "reconnected banner",
  });
  secondChild.emit("exit", 1);

  await assert.rejects(reconnect, /Terminal worker exited/u);
  assert.deepEqual(closed, [
    { sessionId: "session-1", reason: "worker-exit" },
    { sessionId: "session-1", reason: "worker-exit" },
  ]);
});

test("closing a same-id reconnect before its response closes the new lifecycle once", async () => {
  const children = [];
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const firstChild = children[0];
  firstChild.emit("message", {
    kind: "response",
    requestId: firstChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await start;
  firstChild.emit("exit", 1);

  const reconnect = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  void reconnect.catch(() => {});
  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "reconnected banner",
  });
  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });

  const closeMessage = secondChild.messages.at(-1);
  assert.equal(closeMessage.channel, "netcatty:close");
  assert.deepEqual(closed, [
    { sessionId: "session-1", reason: "worker-exit" },
    { sessionId: "session-1", reason: "closed" },
  ]);

  secondChild.emit("message", {
    kind: "response",
    requestId: secondChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await assert.rejects(reconnect, /closed before its output route opened/u);
  secondChild.emit("message", { kind: "session-exit", sessionId: "session-1", exitCode: 0 });
  assert.deepEqual(closed, [
    { sessionId: "session-1", reason: "worker-exit" },
    { sessionId: "session-1", reason: "closed" },
  ]);
});

test("a pending reconnect exit drops late output before another same-id restart", async () => {
  const children = [];
  const closed = [];
  const routed = [];
  let outputOpen = false;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() { outputOpen = true; },
      closeSession() { outputOpen = false; },
      closeAll() { outputOpen = false; },
      send(sessionId, data) {
        if (!outputOpen) return false;
        routed.push({ sessionId, data });
        return true;
      },
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const firstChild = children[0];
  firstChild.emit("message", {
    kind: "response",
    requestId: firstChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await start;
  firstChild.emit("exit", 1);

  const reconnect = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const secondChild = children[1];
  const reconnectRequest = secondChild.messages[0];
  secondChild.emit("message", {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "session-1", reason: "exited" },
    sessionGeneration: 0,
  });
  secondChild.emit("message", {
    kind: "output",
    sessionId: "session-1",
    data: "STALE",
  });
  secondChild.emit("message", {
    kind: "response",
    requestId: reconnectRequest.requestId,
    error: "reconnect failed",
  });
  await assert.rejects(reconnect, /reconnect failed/u);

  const restart = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const restartRequest = secondChild.messages.at(-1);
  secondChild.emit("message", {
    kind: "response",
    requestId: restartRequest.requestId,
    result: { sessionId: "session-1" },
  });
  await restart;

  assert.deepEqual(routed, []);
  assert.deepEqual(closed, [
    { sessionId: "session-1", reason: "worker-exit" },
    { sessionId: "session-1", reason: "exited" },
  ]);
});

test("a worker-exit close listener can start a replacement without later cleanup removing it", async () => {
  const children = [];
  let replacementStart;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => {
    if (event.reason !== "worker-exit") return;
    replacementStart = manager.request("netcatty:local:start", {}, { webContentsId: 8 });
    void replacementStart.catch(() => {});
  });

  const firstStart = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  const firstChild = children[0];
  firstChild.emit("message", {
    kind: "response",
    requestId: firstChild.messages[0].requestId,
    result: { sessionId: "session-1" },
  });
  await firstStart;

  firstChild.emit("exit", 1);
  assert.equal(children.length, 2);

  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "response",
    requestId: secondChild.messages[0].requestId,
    result: { sessionId: "session-2" },
  });
  await replacementStart;
  assert.equal(manager.hasOpenSession("session-2"), true);
});

test("an explicit-close listener can restart the same id without later cleanup removing it", async () => {
  const child = new FakeChild();
  let replacementStart;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession() {}, closeSession() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => {
    if (event.reason !== "closed") return;
    replacementStart = manager.request(
      "netcatty:local:reconnect",
      { sessionId: event.sessionId },
      { webContentsId: 8 },
    );
    void replacementStart.catch(() => {});
  });

  const firstStart = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await firstStart;

  manager.send("netcatty:close", { sessionId: "session-1" }, { webContentsId: 7 });
  const replacementRequest = child.messages.find((message) => (
    message.kind === "request"
    && message.channel === "netcatty:local:reconnect"
    && message.requestId !== child.messages[0].requestId
  ));
  const workerCloseIndex = child.messages.findIndex((message) => (
    message.kind === "send" && message.channel === "netcatty:close"
  ));
  const replacementIndex = child.messages.indexOf(replacementRequest);
  assert.equal(workerCloseIndex < replacementIndex, true);
  child.emit("message", {
    kind: "response",
    requestId: replacementRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });

  await replacementStart;
  assert.equal(manager.hasOpenSession("session-1"), true);
});

test("an awaited close reaches the worker before its listener can restart the same id", async () => {
  const child = new FakeChild();
  let replacementStart;
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession() {}, closeSession() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => {
    if (event.reason !== "closed") return;
    replacementStart = manager.request(
      "netcatty:local:reconnect",
      { sessionId: event.sessionId },
      { webContentsId: 8 },
    );
    void replacementStart.catch(() => {});
  });

  const firstStart = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await firstStart;

  const close = manager.request(
    "netcatty:close:await",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const closeRequest = child.messages.find((message) => (
    message.kind === "request" && message.channel === "netcatty:close:await"
  ));
  const replacementRequest = child.messages.find((message) => (
    message.kind === "request"
    && message.channel === "netcatty:local:reconnect"
    && message.requestId !== child.messages[0].requestId
  ));
  assert.equal(child.messages.indexOf(closeRequest) < child.messages.indexOf(replacementRequest), true);

  child.emit("message", {
    kind: "response",
    requestId: closeRequest.requestId,
    result: undefined,
  });
  child.emit("message", {
    kind: "response",
    requestId: replacementRequest.requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 1,
  });
  await close;
  await replacementStart;
  assert.equal(manager.hasOpenSession("session-1"), true);
});

test("an awaited close still notifies lifecycle cleanup when worker IPC is already dead", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: { openSession() {}, closeSession() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => closed.push(event));

  const start = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await start;

  child.postMessage = () => { throw new Error("IPC closed"); };
  const close = manager.request(
    "netcatty:close:await",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );

  await assert.rejects(close, /IPC closed/u);
  assert.deepEqual(closed, [{ sessionId: "session-1", reason: "closed" }]);
  assert.equal(manager.hasOpenSession("session-1"), false);
});

test("a dead worker is replaced when close cleanup immediately restarts the same id", async () => {
  const children = [];
  let replacementStart;
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    terminalOutputChannel: { openSession() {}, closeSession() {}, closeAll() {} },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => {
    if (event.reason !== "closed") return;
    replacementStart = manager.request(
      "netcatty:local:reconnect",
      { sessionId: event.sessionId },
      { webContentsId: 8 },
    );
    void replacementStart.catch(() => {});
  });

  const start = manager.request(
    "netcatty:local:reconnect",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  const firstChild = children[0];
  firstChild.emit("message", {
    kind: "response",
    requestId: firstChild.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await start;

  firstChild.postMessage = () => { throw new Error("IPC closed"); };
  const close = manager.request(
    "netcatty:close:await",
    { sessionId: "session-1" },
    { webContentsId: 7 },
  );
  await assert.rejects(close, /IPC closed/u);
  assert.equal(firstChild.killed, true);
  assert.equal(children.length, 2);

  const secondChild = children[1];
  secondChild.emit("message", {
    kind: "response",
    requestId: secondChild.messages[0].requestId,
    result: { sessionId: "session-1" },
    sessionGeneration: 0,
  });
  await replacementStart;
  firstChild.emit("exit", 1);

  assert.equal(manager.hasOpenSession("session-1"), true);
  assert.equal(children.length, 2);
});

test("worker exit notifies renderers for active worker sessions", async () => {
  const child = new FakeChild();
  const sent = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: {
      fork() {
        return child;
      },
    },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return {
            id,
            send(channel, payload) {
              sent.push({ id, channel, payload });
            },
          };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });

  const promise = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await promise;

  child.emit("exit", 1);

  assert.deepEqual(sent, [
    {
      id: 7,
      channel: "netcatty:exit",
      payload: {
        sessionId: "local-1",
        exitCode: 1,
        error: "Terminal worker exited with code 1",
        reason: "error",
      },
    },
  ]);
});

test("worker exit notifies host lifecycle listeners for every active session", async () => {
  const child = new FakeChild();
  const closed = [];
  const manager = createTerminalWorkerManager({
    utilityProcess: { fork: () => child },
    terminalOutputChannel: {
      openSession() {},
      closeAll() {},
    },
    electronModule: {
      webContents: {
        fromId(id) {
          return { id, send() {} };
        },
      },
    },
    workerScriptPath: "/worker.cjs",
  });
  manager.onSessionClosed((event) => {
    manager.detachTerminalInterceptor(event.sessionId, "input");
    closed.push(event);
  });

  const first = manager.request("netcatty:local:start", {}, { webContentsId: 7 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { sessionId: "local-1" },
  });
  await first;

  const second = manager.request("netcatty:local:start", {}, { webContentsId: 8 });
  child.emit("message", {
    kind: "response",
    requestId: child.messages.at(-1).requestId,
    result: { sessionId: "local-2" },
  });
  await second;

  child.postMessage = () => {
    throw new Error("worker IPC channel is closed");
  };
  child.emit("exit", 1);

  assert.deepEqual(closed, [
    { sessionId: "local-1", reason: "worker-exit" },
    { sessionId: "local-2", reason: "worker-exit" },
  ]);
});
