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

test("runtime serializes overlapping same-id starts and closes the superseded session first", async () => {
  const parentPort = createParentPort();
  const order = [];
  let active = null;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:local:reconnect", async (_event, payload) => {
        order.push(`start:${payload.attempt}`);
        if (payload.attempt === "first") await firstGate;
        active = payload.attempt;
        order.push(`publish:${payload.attempt}`);
        return { sessionId: payload.sessionId };
      });
      ipcMain.handle("netcatty:close:await", (_event, payload) => {
        order.push(`close:${active}:${payload.sessionId}`);
        active = null;
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:local:reconnect",
    payload: { sessionId: "session-1", attempt: "first" },
    webContentsId: 7,
  });
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-2",
    channel: "netcatty:local:reconnect",
    payload: { sessionId: "session-1", attempt: "second" },
    webContentsId: 8,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:first"]);

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, [
    "start:first",
    "publish:first",
    "close:first:session-1",
    "start:second",
    "publish:second",
  ]);
  assert.equal(active, "second");
  assert.deepEqual(
    parentPort.messages.filter((message) => message.kind === "response").map((message) => message.requestId),
    ["req-1", "req-2"],
  );
});

test("runtime closes a completed same-id start before a later request begins", async () => {
  const parentPort = createParentPort();
  const order = [];
  let active = null;
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:local:reconnect", async (_event, payload) => {
        order.push(`start:${payload.attempt}`);
        active = payload.attempt;
        order.push(`publish:${payload.attempt}`);
        return { sessionId: payload.sessionId };
      });
      ipcMain.handle("netcatty:close:await", (_event, payload) => {
        order.push(`close:${active}:${payload.sessionId}`);
        active = null;
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:local:reconnect",
    payload: { sessionId: "session-1", attempt: "first" },
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-2",
    channel: "netcatty:local:reconnect",
    payload: { sessionId: "session-1", attempt: "second" },
    webContentsId: 8,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, [
    "start:first",
    "publish:first",
    "close:first:session-1",
    "start:second",
    "publish:second",
  ]);
  assert.equal(active, "second");
  assert.deepEqual(
    parentPort.messages.filter((message) => message.kind === "session-superseding"),
    [{
      kind: "session-superseding",
      sessionId: "session-1",
      sessionGeneration: 0,
      replacementRequestId: "req-2",
    }],
  );
});

test("runtime records a generated session id so a later same-id start closes it first", async () => {
  const parentPort = createParentPort();
  const order = [];
  let active = null;
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:local:start", async (_event, payload) => {
        order.push(`start:${payload.attempt}`);
        active = payload.attempt;
        return { sessionId: "generated-1" };
      });
      ipcMain.handle("netcatty:close:await", (_event, payload) => {
        order.push(`close:${active}:${payload.sessionId}`);
        active = null;
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:local:start",
    payload: { attempt: "first" },
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-2",
    channel: "netcatty:local:start",
    payload: { sessionId: "generated-1", attempt: "second" },
    webContentsId: 8,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, [
    "start:first",
    "close:first:generated-1",
    "start:second",
  ]);
  assert.equal(active, "second");
  assert.deepEqual(
    parentPort.messages
      .filter((message) => message.kind === "response")
      .map((message) => message.sessionGeneration),
    [0, 1],
  );
});

test("runtime close waits for a pending start and removes the session it publishes", async () => {
  const parentPort = createParentPort();
  const order = [];
  let active = null;
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:local:reconnect", async (_event, payload) => {
        order.push("start");
        await startGate;
        active = payload.sessionId;
        order.push("publish");
        return { sessionId: payload.sessionId };
      });
      ipcMain.on("netcatty:close", (_event, payload) => {
        order.push(`close:${payload.sessionId}`);
        active = null;
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:local:reconnect",
    payload: { sessionId: "session-1" },
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start"]);
  parentPort.emitMessage({
    kind: "send",
    channel: "netcatty:close",
    payload: { sessionId: "session-1" },
    webContentsId: 7,
  });

  releaseStart();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["start", "publish", "close:session-1"]);
  assert.equal(active, null);
});

test("runtime close cancels every same-id start that was queued before it", async () => {
  const parentPort = createParentPort();
  const starts = [];
  let active = null;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:local:reconnect", async (_event, payload) => {
        starts.push(payload.attempt);
        if (payload.attempt === "first") await firstGate;
        active = payload.attempt;
        return { sessionId: payload.sessionId };
      });
      ipcMain.on("netcatty:close", () => { active = null; });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:local:reconnect",
    payload: { sessionId: "session-1", attempt: "first" },
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-2",
    channel: "netcatty:local:reconnect",
    payload: { sessionId: "session-1", attempt: "second" },
    webContentsId: 7,
  });
  parentPort.emitMessage({
    kind: "send",
    channel: "netcatty:close",
    payload: { sessionId: "session-1" },
    webContentsId: 7,
  });
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(starts, ["first"]);
  assert.equal(active, null);
  assert.equal(parentPort.messages.some((message) => (
    message.requestId === "req-2" && /cancelled by close/u.test(message.error)
  )), true);
});

test("runtime tags a failing start exit so its queued replacement can distinguish it", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:local:reconnect", async (event, payload) => {
        if (payload.attempt === "first") {
          event.sender.send("netcatty:exit", {
            sessionId: payload.sessionId,
            reason: "failed",
          });
          throw new Error("first failed");
        }
        return { sessionId: payload.sessionId };
      });
      ipcMain.handle("netcatty:close:await", () => {});
    },
  });
  runtime.start();

  for (const [requestId, attempt] of [["req-1", "first"], ["req-2", "second"]]) {
    parentPort.emitMessage({
      kind: "request",
      requestId,
      channel: "netcatty:local:reconnect",
      payload: { sessionId: "session-1", attempt },
      webContentsId: 7,
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const exit = parentPort.messages.find((message) => message.kind === "renderer-event");
  assert.equal(exit.originRequestId, "req-1");
  assert.equal(parentPort.messages.some((message) => (
    message.requestId === "req-2" && message.result?.sessionId === "session-1"
  )), true);
});

test("runtime routes interceptor ports to the worker-owned data pipeline", () => {
  const parentPort = createParentPort();
  const attached = [];
  const detached = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      attach(message, port) { attached.push({ message, port }); },
      detach(sessionId, direction) { detached.push({ sessionId, direction }); },
    },
    registerBridges() {},
  });
  runtime.start();
  const port = new FakePort();
  parentPort.emitMessage({
    data: { kind: "terminal-interceptor-port", sessionId: "session-1", direction: "output" },
    ports: [port],
  });
  assert.equal(attached[0].port, port);
  parentPort.emitMessage({ kind: "terminal-interceptor-detach", sessionId: "session-1", direction: "output" });
  assert.deepEqual(detached, [{ sessionId: "session-1", direction: "output" }]);
});

test("fresh sender lookups preserve an explicitly bound backend session generation", () => {
  const parentPort = createParentPort();
  const detached = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      detach(sessionId, direction, reason) { detached.push({ sessionId, direction, reason }); },
    },
    registerBridges() {},
  });
  runtime.start();

  const oldGeneration = runtime.createSender(7).claimSessionGeneration("session-1");
  runtime.createSender(7).send("netcatty:exit", {
    sessionId: "session-1",
    reason: "error",
    _terminalSessionGeneration: oldGeneration,
  });
  const newGeneration = runtime.createSender(8).claimSessionGeneration("session-1");
  runtime.createSender(7).send("netcatty:exit", {
    sessionId: "session-1",
    reason: "close",
    _terminalSessionGeneration: oldGeneration,
  });
  runtime.createSender(8).send("netcatty:exit", {
    sessionId: "session-1",
    reason: "exited",
    _terminalSessionGeneration: newGeneration,
  });

  assert.deepEqual(
    parentPort.messages.map((message) => message.sessionGeneration),
    [0, 0, 1],
  );
  assert.equal(parentPort.messages.some((message) => (
    Object.hasOwn(message.payload, "_terminalSessionGeneration")
  )), false);
  assert.deepEqual(detached, [
    { sessionId: "session-1", direction: undefined, reason: "session-closed" },
    { sessionId: "session-1", direction: undefined, reason: "session-closed" },
  ]);
});

test("stale backend output is rejected before taps, observation, or interception", async () => {
  const parentPort = createParentPort();
  const observed = [];
  const intercepted = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 3; },
      observeOutput(sessionId, data) { observed.push({ sessionId, data }); return false; },
      async interceptOutput(sessionId, data) {
        intercepted.push({ sessionId, data });
        return data;
      },
      detach() {},
    },
    registerBridges() {},
  });
  runtime.start();

  const oldSender = runtime.createSender(7);
  const oldGeneration = oldSender.claimSessionGeneration("session-1");
  oldSender.send("netcatty:exit", {
    sessionId: "session-1",
    reason: "error",
    _terminalSessionGeneration: oldGeneration,
  });
  const newSender = runtime.createSender(8);
  const newGeneration = newSender.claimSessionGeneration("session-1");
  parentPort.messages.length = 0;

  runtime.createSender(7).send("netcatty:data", {
    sessionId: "session-1",
    data: "old-secret",
    _terminalSessionGeneration: oldGeneration,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parentPort.messages, []);
  assert.deepEqual(observed, []);
  assert.deepEqual(intercepted, []);

  runtime.createSender(8).send("netcatty:data", {
    sessionId: "session-1",
    data: "new-output",
    _terminalSessionGeneration: newGeneration,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [{ sessionId: "session-1", data: "new-output" }]);
  assert.deepEqual(intercepted, [{ sessionId: "session-1", data: "new-output" }]);
  assert.deepEqual(parentPort.messages.map((message) => message.kind), ["output-tap", "output"]);
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

test("runtime clears host-sensitive input state before dispatching an interrupt", () => {
  const parentPort = createParentPort();
  const order = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      clearSensitiveInput(sessionId) { order.push(`clear:${sessionId}`); },
    },
    registerBridges(ipcMain) {
      ipcMain.on("netcatty:interrupt", (_event, payload) => order.push(`write:${payload.sessionId}`));
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "send",
    channel: "netcatty:interrupt",
    payload: { sessionId: "s1" },
    webContentsId: 7,
  });

  assert.deepEqual(order, ["clear:s1", "write:s1"]);
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
    sessionGeneration: 0,
  });
  assert.deepEqual(parentPort.messages[1], {
    kind: "output",
    sessionId: "s1",
    data: "hello",
    tapped: true,
    sessionGeneration: 0,
  });
});

test("runtime keeps the no-interceptor output path synchronous and allocation-free", async () => {
  const parentPort = createParentPort();
  let interceptCalls = 0;
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 0; },
      async interceptOutput() { interceptCalls += 1; return "changed"; },
    },
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        assert.equal(parentPort.messages[1]?.data, "hello");
        return null;
      });
    },
  });
  runtime.start();
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-no-plugin",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interceptCalls, 0);
});

test("runtime sends transformed output to the renderer while host taps retain original data", async () => {
  const parentPort = createParentPort();
  const observed = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 3; },
      observeOutput(sessionId, data) { observed.push({ sessionId, data }); return true; },
      async interceptOutput(_sessionId, data) { return String(data).toUpperCase(); },
    },
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        return null;
      });
    },
  });
  runtime.start();
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-plugin",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages[0], {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
    sessionGeneration: 0,
  });
  assert.deepEqual(parentPort.messages[1], {
    kind: "output",
    sessionId: "s1",
    data: "HELLO",
    tapped: true,
    sessionGeneration: 0,
    meta: {
      pluginPipelineIngressBytes: 5,
      pluginPipelineProcessed: true,
      pluginPipelineSensitiveInput: true,
    },
  });
  assert.deepEqual(observed, [{ sessionId: "s1", data: "hello" }]);
});

test("runtime classifies original prompts when only an output interceptor is active", async () => {
  const parentPort = createParentPort();
  const observed = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 2; },
      observeOutput(sessionId, data) { observed.push({ sessionId, data }); return true; },
      async interceptOutput() { return "masked> "; },
    },
    registerBridges() {},
  });
  runtime.start();

  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "Password: " });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(observed, [{ sessionId: "s1", data: "Password: " }]);
  assert.deepEqual(parentPort.messages.at(-1), {
    kind: "output",
    sessionId: "s1",
    data: "masked> ",
    tapped: true,
    sessionGeneration: 0,
    meta: {
      pluginPipelineIngressBytes: 10,
      pluginPipelineProcessed: true,
      pluginPipelineSensitiveInput: true,
    },
  });
});

test("runtime publishes an explicit sensitive-state clear from original output", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 3; },
      observeOutput() { return false; },
      async interceptOutput() { return "renamed prompt> "; },
    },
    registerBridges() {},
  });
  runtime.start();

  runtime.createSender(7).send("netcatty:data", {
    sessionId: "s1",
    data: "\r\nAccess denied\r\n$ ",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    parentPort.messages.at(-1).meta.pluginPipelineSensitiveInput,
    false,
  );
});

test("runtime delivers pending intercepted output before closing the session", async () => {
  const parentPort = createParentPort();
  let releaseOutput;
  const detached = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 2; },
      observeOutput() { return false; },
      interceptOutput() {
        return new Promise((resolve) => { releaseOutput = resolve; });
      },
      detach(sessionId, direction, reason) { detached.push({ sessionId, direction, reason }); },
    },
    registerBridges() {},
  });
  runtime.start();
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "final" });
  runtime.createSender(7).send("netcatty:exit", { sessionId: "s1", reason: "closed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages.map((message) => message.kind), ["output-tap"]);

  releaseOutput("FINAL");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages.map((message) => message.kind), [
    "output-tap",
    "output",
    "renderer-event",
  ]);
  assert.equal(parentPort.messages[1].data, "FINAL");
  assert.equal(parentPort.messages[2].channel, "netcatty:exit");
  assert.deepEqual(detached, [{ sessionId: "s1", direction: undefined, reason: "session-closed" }]);
});

test("runtime keeps direct output ordered behind a pending chunk after interceptor disable", async () => {
  const parentPort = createParentPort();
  let mode = 2;
  let releaseOutput;
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return mode; },
      observeOutput() { return false; },
      interceptOutput() {
        mode = 0;
        return new Promise((resolve) => { releaseOutput = resolve; });
      },
    },
    registerBridges() {},
  });
  runtime.start();

  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "first" });
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "second" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages.map((message) => message.kind), ["output-tap", "output-tap"]);

  releaseOutput("FIRST");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    parentPort.messages.filter((message) => message.kind === "output").map((message) => message.data),
    ["FIRST", "second"],
  );
});

test("runtime drops a pending intercepted chunk after the session output route is reused", async () => {
  const parentPort = createParentPort();
  const oldPort = new FakePort();
  const newPort = new FakePort();
  const detached = [];
  let releaseOutput;
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 2; },
      observeOutput() { return false; },
      interceptOutput() {
        return new Promise((resolve) => { releaseOutput = resolve; });
      },
      detach(sessionId, direction, reason) { detached.push({ sessionId, direction, reason }); },
    },
    registerBridges() {},
  });
  runtime.start();
  parentPort.emitMessage({
    data: { kind: "output-port", sessionId: "s1", bufferedOutput: [] },
    ports: [oldPort],
  });
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "old" });
  await new Promise((resolve) => setImmediate(resolve));

  parentPort.emitMessage({ kind: "close-output-port", sessionId: "s1" });
  parentPort.emitMessage({
    data: { kind: "output-port", sessionId: "s1", bufferedOutput: [] },
    ports: [newPort],
  });
  releaseOutput("STALE");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(oldPort.closed, true);
  assert.deepEqual(newPort.messages, []);
  assert.deepEqual(detached, [{
    sessionId: "s1",
    direction: undefined,
    reason: "session-closed",
  }]);
});

test("runtime submits queued output to the bounded pipeline before earlier transforms finish", async () => {
  const parentPort = createParentPort();
  const releases = [];
  const calls = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 2; },
      observeOutput() { return false; },
      interceptOutput(_sessionId, data) {
        calls.push(data);
        return new Promise((resolve) => releases.push(() => resolve(data.toUpperCase())));
      },
    },
    registerBridges() {},
  });
  runtime.start();

  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "first" });
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "second" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first", "second"]);

  releases[0]();
  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    parentPort.messages.filter((message) => message.kind === "output").map((message) => message.data),
    ["FIRST", "SECOND"],
  );
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
    sessionGeneration: 0,
  });
  assert.equal(parentPort.messages.some((message) => message.kind === "output"), false);
});

test("runtime routes buffered startup output through the selected interceptor", async () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const intercepted = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode: () => 2,
      observeOutput: () => false,
      interceptOutput(sessionId, data) {
        intercepted.push({ sessionId, data });
        return Promise.resolve(data.toUpperCase());
      },
    },
    registerBridges() {},
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "output-port",
      sessionId: "s1",
      bufferedOutput: [{ data: "early", meta: { source: "startup" } }],
    },
    ports: [outputPort],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(intercepted, [{ sessionId: "s1", data: "early" }]);
  assert.deepEqual(outputPort.messages, [{
    sessionId: "s1",
    data: "EARLY",
    meta: {
      source: "startup",
      pluginPipelineIngressBytes: 5,
      pluginPipelineProcessed: true,
      pluginPipelineSensitiveInput: false,
    },
  }]);
  assert.deepEqual(parentPort.messages, [{ kind: "output-port-ready", sessionId: "s1" }]);
});

test("runtime does not re-intercept already transformed buffered output", async () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const intercepted = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode: () => 2,
      observeOutput: () => false,
      interceptOutput(sessionId, data) {
        intercepted.push({ sessionId, data });
        return Promise.resolve(`again:${data}`);
      },
    },
    registerBridges() {},
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "output-port",
      sessionId: "s1",
      bufferedOutput: [{
        data: "EARLY",
        meta: {
          pluginPipelineIngressBytes: 5,
          pluginPipelineProcessed: true,
          pluginPipelineSensitiveInput: true,
        },
      }],
    },
    ports: [outputPort],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(intercepted, []);
  assert.deepEqual(outputPort.messages, [{
    sessionId: "s1",
    data: "EARLY",
    meta: {
      pluginPipelineIngressBytes: 5,
      pluginPipelineProcessed: true,
      pluginPipelineSensitiveInput: true,
    },
  }]);
  assert.deepEqual(parentPort.messages, [{ kind: "output-port-ready", sessionId: "s1" }]);
});

test("runtime re-intercepts raw buffered output that only inherited ingress accounting", async () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const intercepted = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode: () => 2,
      observeOutput: () => false,
      interceptOutput(sessionId, data) {
        intercepted.push({ sessionId, data });
        return Promise.resolve(`processed:${data}`);
      },
    },
    registerBridges() {},
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "output-port",
      sessionId: "s1",
      bufferedOutput: [{
        data: "raw",
        meta: { pluginPipelineIngressBytes: 9 },
      }],
    },
    ports: [outputPort],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(intercepted, [{ sessionId: "s1", data: "raw" }]);
  assert.deepEqual(outputPort.messages, [{
    sessionId: "s1",
    data: "processed:raw",
    meta: {
      pluginPipelineIngressBytes: 12,
      pluginPipelineProcessed: true,
      pluginPipelineSensitiveInput: false,
    },
  }]);
  assert.deepEqual(parentPort.messages, [{ kind: "output-port-ready", sessionId: "s1" }]);
});

test("runtime adds retained raw bytes after manager partial-trim accounting", async () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const intercepted = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode: () => 2,
      observeOutput: () => false,
      interceptOutput(sessionId, data) {
        intercepted.push({ sessionId, data });
        return Promise.resolve(`processed:${data}`);
      },
    },
    registerBridges() {},
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "output-port",
      sessionId: "s1",
      bufferedOutput: [{
        data: "bcde",
        meta: { pluginPipelineIngressBytes: 11 },
      }],
    },
    ports: [outputPort],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(intercepted, [{ sessionId: "s1", data: "bcde" }]);
  assert.deepEqual(outputPort.messages, [{
    sessionId: "s1",
    data: "processed:bcde",
    meta: {
      pluginPipelineIngressBytes: 15,
      pluginPipelineProcessed: true,
      pluginPipelineSensitiveInput: false,
    },
  }]);
});

test("runtime counts retained raw bytes when replay continues without an interceptor", async () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode: () => 0,
      observeOutput: () => false,
    },
    registerBridges() {},
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "output-port",
      sessionId: "s1",
      bufferedOutput: [{
        data: "raw",
        meta: { pluginPipelineIngressBytes: 9 },
      }],
    },
    ports: [outputPort],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(outputPort.messages, [{
    sessionId: "s1",
    data: "raw",
    meta: { pluginPipelineIngressBytes: 12 },
  }]);
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
    sessionGeneration: 0,
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
    sessionGeneration: 0,
  });
});
