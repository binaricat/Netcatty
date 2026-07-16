const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const test = require("node:test");

const {
  createTerminalWorkerManager,
  isTerminalWorkerEnabled,
} = require("./terminalWorkerManager.cjs");

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

  assert.deepEqual(child.messages[1], {
    kind: "output-port",
    sessionId: "local-1",
    bufferedOutput: ["early"],
  });
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
  child.emit("message", {
    kind: "output-port-ready",
    sessionId: "local-1",
  });

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: ["during-transfer"],
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
  child.emit("message", {
    kind: "output-port-ready",
    sessionId: "local-1",
  });

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
  child.emit("message", {
    kind: "output-port-ready",
    sessionId: "local-1",
  });

  assert.deepEqual(child.messages[2], {
    kind: "output-flush",
    sessionId: "local-1",
    chunks: [{
      data: "READY",
      meta: { droppedOutputMayAffectTerminalState: true },
    }],
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
  child.emit("message", {
    kind: "output-port-ready",
    sessionId: "local-1",
  });

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
  await promise;
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
