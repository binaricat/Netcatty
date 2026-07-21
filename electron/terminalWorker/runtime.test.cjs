const assert = require("node:assert/strict");
const test = require("node:test");

const { createTerminalWorkerRuntime } = require("./runtime.cjs");

class FakePort {
  constructor() {
    this.messages = [];
    this.closed = false;
    this.started = false;
    this.listeners = new Map();
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

  on(channel, callback) {
    this.listeners.set(channel, callback);
  }

  emitMessage(message) {
    const callback = this.listeners.get("message");
    if (callback) {
      callback({ data: message });
      return;
    }
    this.onmessage?.({ data: message });
  }
}

function createParentPort() {
  const messages = [];
  const listeners = new Map();
  return {
    messages,
    on(channel, cb) {
      listeners.set(channel, cb);
    },
    postMessage(message) {
      messages.push(message);
    },
    emitMessage(message) {
      listeners.get("message")?.(message);
    },
  };
}

test("runtime invokes registered request handlers and posts responses", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", async (_event, payload) => ({ ok: true, payload }));
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: { value: 1 },
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parentPort.messages, [
    {
      kind: "response",
      requestId: "req-1",
      result: { ok: true, payload: { value: 1 } },
    },
  ]);
});

test("runtime invokes fire-and-forget listeners", () => {
  const parentPort = createParentPort();
  const calls = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.on("netcatty:write", (_event, payload) => calls.push(payload));
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "send",
    channel: "netcatty:write",
    payload: { sessionId: "s1", data: "x" },
    webContentsId: 7,
  });

  assert.deepEqual(calls, [{ sessionId: "s1", data: "x" }]);
});

test("runtime sends output drain markers through the session output port", () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({ parentPort, registerBridges() {} });
  runtime.start();

  parentPort.emitMessage({
    data: { kind: "output-port", sessionId: "s1" },
    ports: [outputPort],
  });
  parentPort.emitMessage({ kind: "output-drain", sessionId: "s1", requestId: "drain-1" });

  assert.deepEqual(outputPort.messages, [
    { kind: "drain", requestId: "drain-1", sessionId: "s1" },
  ]);
});

test("runtime closes an urgent input port when its renderer is destroyed", () => {
  const parentPort = createParentPort();
  const urgentPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({ parentPort, registerBridges() {} });
  runtime.start();
  parentPort.emitMessage({
    data: { kind: "urgent-input-port", webContentsId: 7 },
    ports: [urgentPort],
  });

  parentPort.emitMessage({ kind: "close-urgent-input-port", webContentsId: 7 });

  assert.equal(urgentPort.closed, true);
});

test("runtime routes urgent input port interrupts to the interrupt listener", () => {
  const parentPort = createParentPort();
  const urgentPort = new FakePort();
  const calls = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.on("netcatty:interrupt", (event, payload) => {
        calls.push({ senderId: event.sender.id, payload });
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "urgent-input-port",
      webContentsId: 7,
    },
    ports: [urgentPort],
  });
  urgentPort.emitMessage({
    kind: "interrupt",
    sessionId: "s1",
    trace: { traceId: "trace-1" },
  });

  assert.equal(urgentPort.started, true);
  assert.deepEqual(calls, [
    {
      senderId: 7,
      payload: {
        sessionId: "s1",
        trace: { traceId: "trace-1" },
        urgentInputPort: true,
      },
    },
  ]);
});

test("runtime routes terminal data over output messages", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        return { done: true };
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parentPort.messages[0], {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
  });
  assert.deepEqual(parentPort.messages[1], {
    kind: "output",
    sessionId: "s1",
    data: "hello",
    tapped: true,
  });
});

test("runtime routes terminal data over a transferred output port", async () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        return { done: true };
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "output-port",
      sessionId: "s1",
      bufferedOutput: ["early"],
    },
    ports: [outputPort],
  });
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(outputPort.started, true);
  assert.deepEqual(outputPort.messages, [
    { sessionId: "s1", data: "early" },
    { sessionId: "s1", data: "hello" },
  ]);
  assert.equal(parentPort.messages[0].kind, "output-port-ready");
  assert.deepEqual(parentPort.messages[1], {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
  });
  assert.equal(parentPort.messages.some((message) => message.kind === "output"), false);
});

test("runtime.createSender uses the transferred output port", () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges() {},
  });
  runtime.start();

  parentPort.emitMessage({
    data: { kind: "output-port", sessionId: "s1" },
    ports: [outputPort],
  });
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "hello" });

  assert.deepEqual(outputPort.messages, [{ sessionId: "s1", data: "hello" }]);
  assert.deepEqual(parentPort.messages.at(-1), {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
  });
});

test("runtime forwards non-output renderer events to the parent", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:exit", { sessionId: "s1", reason: "closed" });
        return { done: true };
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parentPort.messages[0], {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "s1", reason: "closed" },
  });
});
