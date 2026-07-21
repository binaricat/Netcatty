const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTerminalOutputPortRegistry,
} = require("./preload/terminalOutputPorts.cjs");
const {
  createTerminalUrgentInputPortRegistry,
} = require("./preload/terminalUrgentInputPorts.cjs");

function createFakeIpcRenderer() {
  const handlers = new Map();
  return {
    on(channel, handler) {
      handlers.set(channel, handler);
    },
    emitPort(sessionId, port) {
      handlers.get("netcatty:terminal-output-port")?.({ ports: [port] }, { sessionId });
    },
    emitUrgentPort(port) {
      handlers.get("netcatty:terminal-urgent-input-port")?.({ ports: [port] }, {});
    },
  };
}

function createFakePort() {
  return {
    messages: [],
    closed: false,
    started: false,
    postMessage(message) {
      this.messages.push(message);
    },
    start() {
      this.started = true;
    },
    close() {
      this.closed = true;
    },
    emit(data) {
      this.onmessage?.({ data });
    },
  };
}

test("register attaches terminal output ports and delivers port messages", () => {
  const delivered = [];
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    deliverToListeners(sessionId, data) {
      delivered.push({ sessionId, data });
    },
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  port.emit({ sessionId: "session-1", data: "hello" });

  assert.deepEqual(delivered, [
    { sessionId: "session-1", data: "hello" },
  ]);
});

test("terminal output ports forward terminal output metadata", () => {
  const delivered = [];
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    deliverToListeners(sessionId, data, meta) {
      delivered.push({ sessionId, data, meta });
    },
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  port.emit({
    sessionId: "session-1",
    data: "hello",
    meta: { droppedOutputMayAffectTerminalState: true },
  });

  assert.deepEqual(delivered, [
    {
      sessionId: "session-1",
      data: "hello",
      meta: { droppedOutputMayAffectTerminalState: true },
    },
  ]);
});

test("terminal output drain marker follows earlier data on the same port", () => {
  const events = [];
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    deliverToListeners(_sessionId, data) {
      events.push(`data:${data}`);
    },
    onDrain(_sessionId, requestId) {
      events.push(`drain:${requestId}`);
    },
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  port.emit({ sessionId: "session-1", data: "tail" });
  port.emit({ kind: "drain", sessionId: "session-1", requestId: "drain-1" });

  assert.deepEqual(events, ["data:tail", "drain:drain-1"]);
});

test("terminal output ports filter data before delivery", () => {
  const delivered = [];
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    filterData(_sessionId, data) {
      return data.replace(/^.*__NCMCP_.*\n?/gm, "");
    },
    deliverToListeners(sessionId, data) {
      delivered.push({ sessionId, data });
    },
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  port.emit({ sessionId: "session-1", data: "before\n__NCMCP_TEST_S\nvisible\n" });

  assert.deepEqual(delivered, [
    { sessionId: "session-1", data: "before\nvisible\n" },
  ]);
});

test("terminal output ports accept filtered data with metadata", () => {
  const delivered = [];
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    filterData(_sessionId, data) {
      return {
        data: data.toUpperCase(),
        meta: { droppedOutputMayAffectTerminalState: true },
      };
    },
    deliverToListeners(sessionId, data, meta) {
      delivered.push({ sessionId, data, meta });
    },
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  port.emit({ sessionId: "session-1", data: "hello" });

  assert.deepEqual(delivered, [
    {
      sessionId: "session-1",
      data: "HELLO",
      meta: { droppedOutputMayAffectTerminalState: true },
    },
  ]);
});

test("terminal output ports do not deliver fully filtered chunks", () => {
  const delivered = [];
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    filterData() {
      return "";
    },
    deliverToListeners(sessionId, data) {
      delivered.push({ sessionId, data });
    },
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  port.emit({ sessionId: "session-1", data: "__NCMCP_TEST_S\n" });

  assert.deepEqual(delivered, []);
});

test("register closes stale replacement ports", () => {
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    deliverToListeners() {},
  });
  const stale = createFakePort();
  const next = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", stale);
  ipcRenderer.emitPort("session-1", next);

  assert.equal(stale.closed, true);
  assert.equal(next.closed, false);
});

test("closed sessions drop terminal output port messages", () => {
  const delivered = [];
  const closedTerminalDataSessions = new Set(["session-1"]);
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    closedTerminalDataSessions,
    deliverToListeners(sessionId, data) {
      delivered.push({ sessionId, data });
    },
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  port.emit({ sessionId: "session-1", data: "late" });

  assert.deepEqual(delivered, []);
});

test("closeSession closes and removes a terminal output port", () => {
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalOutputPortRegistry({
    ipcRenderer,
    deliverToListeners() {},
  });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitPort("session-1", port);
  registry.closeSession("session-1");

  assert.equal(port.closed, true);
  assert.equal(registry.hasSessionForTest("session-1"), false);
});

test("urgent input port posts interrupt messages over the transferred port", () => {
  const ipcRenderer = createFakeIpcRenderer();
  const registry = createTerminalUrgentInputPortRegistry({ ipcRenderer });
  const port = createFakePort();

  registry.register();
  ipcRenderer.emitUrgentPort(port);
  const sent = registry.postInterrupt("session-1", { traceId: "trace-1" });

  assert.equal(sent, true);
  assert.equal(port.started, true);
  assert.deepEqual(port.messages, [
    {
      kind: "interrupt",
      sessionId: "session-1",
      trace: { traceId: "trace-1" },
    },
  ]);
});
