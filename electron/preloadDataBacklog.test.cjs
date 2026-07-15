const assert = require("node:assert/strict");
const test = require("node:test");

const { createPreloadApi } = require("./preload/api.cjs");
const {
  clearTerminalDataBacklog,
  clearTerminalDataSession,
  createTerminalDataBacklog,
  createTerminalDataDispatcher,
} = require("./preload/terminalDataBacklog.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createTerminalPerfMeta = (id = "perf-1") => ({
  id,
  emittedAt: 1234,
  sessionId: "session-1",
  chars: 5,
  lineFeeds: 0,
});

function createFakePort() {
  return {
    onmessage: null,
    close() {},
    emit(data) {
      this.onmessage?.({ data });
    },
  };
}

function loadPreloadWithFakeElectron() {
  const handlers = new Map();
  let exposedApi = null;
  const fakeElectron = {
    ipcRenderer: {
      on(channel, handler) {
        handlers.set(channel, handler);
      },
      send() {},
      async invoke(channel, payload) {
        if (channel === "netcatty:local:start") {
          return { sessionId: payload?.sessionId };
        }
        return null;
      },
    },
    contextBridge: {
      exposeInMainWorld(_name, value) {
        exposedApi = value;
      },
    },
    webUtils: {
      getPathForFile(file) {
        return file?.path ?? "";
      },
    },
  };

  const electronPath = require.resolve("electron");
  const preloadPath = require.resolve("./preload.cjs");
  const previousElectron = require.cache[electronPath];
  const previousWindow = global.window;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: fakeElectron,
  };
  delete require.cache[preloadPath];
  global.window = {
    location: { origin: "app://netcatty" },
    netcatty: undefined,
  };

  require(preloadPath);

  return {
    api: exposedApi,
    handlers,
    cleanup() {
      delete require.cache[preloadPath];
      if (previousElectron) {
        require.cache[electronPath] = previousElectron;
      } else {
        delete require.cache[electronPath];
      }
      if (previousWindow === undefined) {
        delete global.window;
      } else {
        global.window = previousWindow;
      }
    },
  };
}

test("stores early terminal data until the listener is registered", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "Linux banner\r\n");
  backlog.append("session-1", "root@host:~# ");

  assert.equal(backlog.take("session-1"), "Linux banner\r\nroot@host:~# ");
  assert.equal(backlog.take("session-1"), "");
});

test("keeps each session backlog isolated", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "one");
  backlog.append("session-2", "two");

  assert.equal(backlog.take("session-2"), "two");
  assert.equal(backlog.take("session-1"), "one");
});

test("trims old data when the per-session limit is exceeded", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 5 });

  backlog.append("session-1", "hello");
  backlog.append("session-1", " world");

  assert.equal(backlog.take("session-1"), "world");
});

test("keeps terminal output metadata while trimming backlog data", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 5 });

  backlog.append("session-1", "hello", { droppedOutputMayAffectTerminalState: true });
  backlog.append("session-1", " world");

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "world",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("keeps terminal perf metadata for a single backlog chunk", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 64 });
  const terminalPerf = createTerminalPerfMeta();

  backlog.append("session-1", "hello", { terminalPerf });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "hello",
    meta: { terminalPerf },
  });
});

test("drops terminal perf metadata after backlog data is merged or trimmed", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 8 });

  backlog.append("session-1", "hello", { terminalPerf: createTerminalPerfMeta("perf-1") });
  backlog.append("session-1", " world", {
    terminalPerf: createTerminalPerfMeta("perf-2"),
    droppedOutputMayAffectTerminalState: true,
  });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "lo world",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("keeps latest alternate-screen metadata while trimming backlog data", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 5 });

  backlog.append("session-1", "hello", {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "enter",
  });
  backlog.append("session-1", " world", {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "leave",
  });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "world",
    meta: {
      droppedOutputMayAffectTerminalState: true,
      droppedOutputAlternateScreenAction: "leave",
    },
  });
});

test("new unknown terminal-state metadata clears stale alternate-screen action in backlog", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 64 });

  backlog.append("session-1", "first", {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "leave",
  });
  backlog.append("session-1", "second", {
    droppedOutputMayAffectTerminalState: true,
  });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "firstsecond",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("dispatcher writes terminal output metadata into backlog", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliver = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliver("session-1", "early output", { droppedOutputMayAffectTerminalState: true });

  assert.deepEqual(terminalDataBacklog.takeEntry("session-1"), {
    data: "early output",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("clear drops pending data for a closed session", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "pending");
  backlog.clear("session-1");

  assert.equal(backlog.size("session-1"), 0);
  assert.equal(backlog.take("session-1"), "");
});

test("onSessionData flushes pending terminal data on subscribe", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "early MOTD\r\n");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const received = [];
  const unsubscribe = api.onSessionData("session-1", (chunk) => {
    received.push(chunk);
  }, { replayBacklog: true });

  assert.deepEqual(received, ["early MOTD\r\n"]);
  assert.equal(terminalDataBacklog.size("session-1"), 0);
  assert.equal(displayDataListeners.get("session-1").size, 1);

  unsubscribe();
  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
});

test("onSessionData replays pending terminal data metadata on subscribe", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const terminalPerf = createTerminalPerfMeta();
  terminalDataBacklog.append("session-1", "early output", {
    droppedOutputMayAffectTerminalState: true,
    terminalPerf,
  });

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const received = [];
  api.onSessionData("session-1", (chunk, meta) => {
    received.push({ chunk, meta });
  }, { replayBacklog: true });

  assert.deepEqual(received, [{
    chunk: "early output",
    meta: { droppedOutputMayAffectTerminalState: true, terminalPerf },
  }]);
});

test("legacy terminal data delivery preserves terminal perf metadata", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const terminalPerf = createTerminalPerfMeta();
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "hello",
      meta: { terminalPerf },
    });

    assert.deepEqual(received, [{
      chunk: "hello",
      meta: { terminalPerf },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("terminal output port delivery preserves terminal perf metadata", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const terminalPerf = createTerminalPerfMeta();
    const received = [];
    const port = createFakePort();
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:terminal-output-port")?.({ ports: [port] }, { sessionId: "session-1" });
    port.emit({
      sessionId: "session-1",
      data: "hello",
      meta: { terminalPerf },
    });

    assert.deepEqual(received, [{
      chunk: "hello",
      meta: { terminalPerf },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered terminal perf metadata is not carried to later output", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: { terminalPerf: createTerminalPerfMeta() },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: undefined,
    }]);
  } finally {
    preload.cleanup();
  }
});

test("delayed MCP terminal data flush preserves metadata", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "prompt __NCM",
      meta: { droppedOutputMayAffectTerminalState: true },
    });

    assert.deepEqual(received, []);
    await sleep(100);

    assert.deepEqual(received, [{
      chunk: "prompt __NCM",
      meta: { droppedOutputMayAffectTerminalState: true },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered empty terminal data carries metadata to next visible output", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP metadata merge clears stale alternate-screen action on later unknown risk", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: {
        droppedOutputMayAffectTerminalState: true,
        droppedOutputAlternateScreenAction: "leave",
      },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered empty terminal metadata is cleared on session exit", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    }, { replayBacklog: true });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed",
    });
    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: undefined,
    }]);
  } finally {
    preload.cleanup();
  }
});

test("non-display listeners do not drain pending terminal data", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "early prompt");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const observerReceived = [];
  const displayReceived = [];

  api.onSessionData("session-1", (chunk) => {
    observerReceived.push(chunk);
  });
  assert.deepEqual(observerReceived, []);
  assert.equal(terminalDataBacklog.size("session-1"), "early prompt".length);

  api.onSessionData("session-1", (chunk) => {
    displayReceived.push(chunk);
  }, { replayBacklog: true });

  assert.deepEqual(observerReceived, []);
  assert.deepEqual(displayReceived, ["early prompt"]);
  assert.equal(terminalDataBacklog.size("session-1"), 0);
});

test("keeps early data for display replay while only observer listeners exist", () => {
  const observed = [];
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk)])],
  ]);
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliverToListeners("session-1", "Linux banner\r\n");

  assert.deepEqual(observed, ["Linux banner\r\n"]);
  assert.equal(terminalDataBacklog.take("session-1"), "Linux banner\r\n");
});

test("does not backlog data once the display listener is registered", () => {
  const observed = [];
  const displayed = [];
  const displayListener = (chunk) => displayed.push(chunk);
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk), displayListener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([displayListener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliverToListeners("session-1", "live output");

  assert.deepEqual(observed, ["live output"]);
  assert.deepEqual(displayed, ["live output"]);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("drops terminal data for sessions marked closed", () => {
  const observed = [];
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk)])],
  ]);
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const closedSessions = new Set(["session-1"]);
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
    shouldDropSession: (sessionId) => closedSessions.has(sessionId),
  });

  deliverToListeners("session-1", "late output");

  assert.deepEqual(observed, []);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("clearTerminalDataSession drops listener and backlog state together", () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "pending");

  clearTerminalDataSession({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  }, "session-1");

  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("clearTerminalDataBacklog preserves live display listeners for reconnect", () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "pending");

  clearTerminalDataBacklog({ terminalDataBacklog }, "session-1");

  assert.equal(dataListeners.get("session-1")?.has(listener), true);
  assert.equal(displayDataListeners.get("session-1")?.has(listener), true);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("backend exit preserves live listeners for same-id reconnect", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    const exits = [];
    preload.api.onSessionData("session-1", (chunk) => {
      received.push(chunk);
    }, { replayBacklog: true });
    preload.api.onSessionExit("session-1", (evt) => {
      exits.push(evt.reason);
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "before exit",
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed",
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "duplicate-closed",
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "dropped while closed",
    });
    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "after reconnect",
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed-again",
    });

    assert.deepEqual(received, ["before exit", "after reconnect"]);
    assert.deepEqual(exits, ["closed", "closed-again"]);
  } finally {
    preload.cleanup();
  }
});

test("zmodem events after explicit close and backend exit are gated", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const zmodemEvents = [];
    const overwriteRequests = [];
    preload.api.onZmodemEvent("session-1", (evt) => {
      zmodemEvents.push(evt.type);
    });
    preload.api.onZmodemOverwriteRequest("session-1", (payload) => {
      overwriteRequests.push(payload.sessionId);
    });

    preload.api.closeSession("session-1");
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed",
    });
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    preload.handlers.get("netcatty:zmodem:overwrite-request")?.({}, {
      sessionId: "session-1",
    });

    assert.deepEqual(zmodemEvents, []);
    assert.deepEqual(overwriteRequests, []);
  } finally {
    preload.cleanup();
  }
});

test("zmodem listeners survive backend exit and fire after same-session reconnect", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const zmodemEvents = [];
    const overwriteRequests = [];
    preload.api.onZmodemEvent("session-1", (evt) => {
      zmodemEvents.push(evt.type);
    });
    preload.api.onZmodemOverwriteRequest("session-1", (payload) => {
      overwriteRequests.push(payload);
    });

    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "error",
    });
    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    preload.handlers.get("netcatty:zmodem:overwrite-request")?.({}, {
      sessionId: "session-1",
      requestId: "r1",
      filename: "f",
    });

    assert.deepEqual(zmodemEvents, ["detect"]);
    assert.deepEqual(overwriteRequests, [{
      sessionId: "session-1",
      requestId: "r1",
      filename: "f",
    }]);
  } finally {
    preload.cleanup();
  }
});

test("zmodem listeners survive reconnect-style closeSession and resume after restart", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const zmodemEvents = [];
    const overwriteRequests = [];
    preload.api.onZmodemEvent("session-1", (evt) => {
      zmodemEvents.push(evt.type);
    });
    preload.api.onZmodemOverwriteRequest("session-1", (payload) => {
      overwriteRequests.push(payload.requestId);
    });

    // Reconnect path: closeSession is called while the terminal component
    // stays mounted, then the session restarts with the same id.
    preload.api.closeSession("session-1");
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    assert.deepEqual(zmodemEvents, []);

    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    preload.handlers.get("netcatty:zmodem:overwrite-request")?.({}, {
      sessionId: "session-1",
      requestId: "r1",
      filename: "f",
    });

    assert.deepEqual(zmodemEvents, ["detect"]);
    assert.deepEqual(overwriteRequests, ["r1"]);
  } finally {
    preload.cleanup();
  }
});

test("onWindowFocusRequested is wired to the focus-requested IPC", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const calls = [];
    const unsubscribe = preload.api.onWindowFocusRequested(() => {
      calls.push("focus");
    });

    preload.handlers.get("netcatty:window:focus-requested")?.();

    assert.deepEqual(calls, ["focus"]);

    unsubscribe();
    preload.handlers.get("netcatty:window:focus-requested")?.();

    assert.deepEqual(calls, ["focus"]);
  } finally {
    preload.cleanup();
  }
});

test("onZmodemEvent unsubscribe removes empty listener set", () => {
  const zmodemListeners = new Map();
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    zmodemListeners,
  });

  const off = api.onZmodemEvent("session-1", () => {});
  assert.equal(zmodemListeners.has("session-1"), true);

  off();

  assert.equal(zmodemListeners.has("session-1"), false);
});

test("onSessionExit unsubscribe removes empty listener set", () => {
  const exitListeners = new Map();
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    exitListeners,
  });

  const off = api.onSessionExit("session-1", () => {});
  assert.equal(exitListeners.has("session-1"), true);

  off();

  assert.equal(exitListeners.has("session-1"), false);
});

test("closeSession clears terminal data state and waits for close acknowledgement", async () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  const closedTerminalDataSessions = new Set();
  const telnetEchoModeListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const zmodemListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const zmodemOverwriteListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const invoked = [];
  const closedPorts = [];
  terminalDataBacklog.append("session-1", "pending");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke(channel, payload) {
        invoked.push({ channel, payload });
        return Promise.resolve();
      },
      send(channel, payload) {
        throw new Error(`unexpected send ${channel}`);
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
    closedTerminalDataSessions,
    telnetEchoModeListeners,
    zmodemListeners,
    zmodemOverwriteListeners,
    terminalOutputPorts: {
      closeSession(sessionId) {
        closedPorts.push(sessionId);
      },
    },
  });

  await api.closeSession("session-1");

  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
  assert.equal(terminalDataBacklog.take("session-1"), "");
  assert.equal(closedTerminalDataSessions.has("session-1"), true);
  assert.equal(telnetEchoModeListeners.has("session-1"), false);
  // Zmodem listeners are preserved: reconnect closes the session without
  // unmounting the subscriber, so cleanup is left to subscriber dispose.
  assert.equal(zmodemListeners.has("session-1"), true);
  assert.equal(zmodemOverwriteListeners.has("session-1"), true);
  assert.deepEqual(closedPorts, ["session-1"]);
  assert.deepEqual(invoked, [
    { channel: "netcatty:close:await", payload: { sessionId: "session-1" } },
  ]);
});

test("closeSession falls back to fire-and-forget close when acknowledgement is unavailable", async () => {
  const sent = [];
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {
        return Promise.reject(new Error("missing handler"));
      },
      send(channel, payload) {
        sent.push({ channel, payload });
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    closedTerminalDataSessions: new Set(),
    telnetEchoModeListeners: new Map(),
  });

  await api.closeSession("session-1");

  assert.deepEqual(sent, [
    { channel: "netcatty:close", payload: { sessionId: "session-1" } },
  ]);
});

test("interruptSession uses the urgent input port before falling back to IPC", () => {
  const sent = [];
  const urgent = [];
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send(channel, payload) {
        sent.push({ channel, payload });
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    terminalUrgentInputPorts: {
      postInterrupt(sessionId, trace) {
        urgent.push({ sessionId, trace });
        return true;
      },
    },
  });

  api.interruptSession("session-1", {
    traceId: "trace-1",
    rendererKeyAt: 123,
  });

  assert.deepEqual(urgent, [
    {
      sessionId: "session-1",
      trace: {
        traceId: "trace-1",
        rendererKeyAt: 123,
        rendererHasSelection: false,
        debug: false,
        rendererPriority: undefined,
        rendererSendAt: undefined,
        rendererStatus: undefined,
        sessionId: undefined,
        source: undefined,
      },
    },
  ]);
  assert.deepEqual(sent, []);
});

test("startLocalSession reopens a previously closed terminal data session", async () => {
  const closedTerminalDataSessions = new Set(["session-1"]);
  const invoked = [];
  const api = createPreloadApi({
    ipcRenderer: {
      async invoke(channel, payload) {
        invoked.push({ channel, payload, wasClosed: closedTerminalDataSessions.has("session-1") });
        return { sessionId: "session-1" };
      },
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    closedTerminalDataSessions,
    telnetEchoModeListeners: new Map(),
  });

  const sessionId = await api.startLocalSession({ sessionId: "session-1" });

  assert.equal(sessionId, "session-1");
  assert.deepEqual(invoked, [
    {
      channel: "netcatty:local:start",
      payload: { sessionId: "session-1" },
      wasClosed: false,
    },
  ]);
  assert.equal(closedTerminalDataSessions.has("session-1"), false);
});
