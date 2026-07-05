const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const TEMP_ROOT = path.join(__dirname, ".tmp-session-logs-bridge-tests");

function loadBridgeWithDialog(dialogMock) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return { dialog: dialogMock };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const bridgePath = require.resolve("./sessionLogsBridge.cjs");
    delete require.cache[bridgePath];
    return require("./sessionLogsBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

test("manual export default filename preserves valid Unicode host labels and replaces dangerous characters", async () => {
  let defaultPath = "";
  const dialogMock = {
    showSaveDialog: async (options) => {
      defaultPath = options.defaultPath;
      return { canceled: true };
    },
  };
  const { exportSessionLog } = loadBridgeWithDialog(dialogMock);

  const result = await exportSessionLog(null, {
    terminalData: "hello\n",
    hostLabel: "生产/服务器:东京*?<>|\0",
    hostname: "fallback.example",
    startTime: new Date(2026, 0, 2, 3, 4, 5).getTime(),
    format: "txt",
  });

  assert.deepEqual(result, { success: false, canceled: true });
  assert.equal(defaultPath, "生产_服务器_东京_______2026-01-02T03-04-05.txt");
  assert.equal(defaultPath.includes("/"), false);
  assert.equal(defaultPath.includes(":"), false);
  assert.equal(defaultPath.includes("\0"), false);
});

test("safe path segments replace invisible control characters and protected names", () => {
  const { safePathSegment } = loadBridgeWithDialog({});

  assert.equal(safePathSegment("\t生产服务器\n", "fallback"), "_生产服务器_");
  assert.equal(safePathSegment("生产\u0085服务器\u009b", "fallback"), "生产_服务器_");
  assert.equal(safePathSegment("../name", "fallback"), ".._name");
  assert.equal(safePathSegment("CON", "fallback"), "CON_");
  assert.equal(safePathSegment("COM¹", "fallback"), "COM¹_");
  assert.equal(safePathSegment("LPT².txt", "fallback"), "LPT².txt_");
  assert.equal(safePathSegment("prod.", "fallback"), "prod_");
  assert.equal(safePathSegment("prod..", "fallback"), "prod__");
});

test("auto-save host directory preserves valid Unicode labels and replaces path-unsafe characters", async () => {
  const directory = path.join(TEMP_ROOT, `auto-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { autoSaveSessionLog } = loadBridgeWithDialog({});

  try {
    const result = await autoSaveSessionLog(null, {
      terminalData: "hello\n",
      hostLabel: "生产/服务器:东京*?<>|\0",
      hostname: "fallback.example",
      hostId: "host-id",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      format: "raw",
      directory,
    });

    assert.equal(result.success, true);
    assert.equal(path.basename(path.dirname(result.filePath)), "生产_服务器_东京______");
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "hello\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("auto-save host directory falls back when the sanitized host label is empty", async () => {
  const directory = path.join(TEMP_ROOT, `auto-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { autoSaveSessionLog } = loadBridgeWithDialog({});

  try {
    const result = await autoSaveSessionLog(null, {
      terminalData: "hello\n",
      hostLabel: "   ",
      hostname: "",
      hostId: "",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      format: "txt",
      directory,
    });

    assert.equal(result.success, true);
    assert.equal(path.basename(path.dirname(result.filePath)), "unknown");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual session logs survive tokenless stale stops and stop through the bridge", async () => {
  const directory = path.join(TEMP_ROOT, `manual-token-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dialogMock = {
    showSaveDialog: async () => ({ canceled: false, filePath }),
  };
  const {
    startManualSessionLog,
    stopManualSessionLog,
  } = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    const startResult = await startManualSessionLog(null, {
      sessionId,
      sessionName: "H3C switch",
      preferredDirectory: directory,
      initialLine: "started\n",
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.started, true);

    sessionLogStreamManager.appendData(sessionId, "before-stale\n");
    const staleResult = await sessionLogStreamManager.stopStream(sessionId);
    assert.equal(staleResult, null);
    assert.equal(sessionLogStreamManager.hasStream(sessionId), true);

    sessionLogStreamManager.appendData(sessionId, "after-stale\n");
    const stopResult = await stopManualSessionLog(null, { sessionId });
    assert.equal(stopResult.success, true);
    assert.equal(stopResult.stopped, true);
    assert.equal(stopResult.filePath, filePath);
    assert.equal(sessionLogStreamManager.hasStream(sessionId), false);

    const content = fs.readFileSync(filePath, "utf8");
    assert.match(content, /started/);
    assert.match(content, /before-stale/);
    assert.match(content, /after-stale/);
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual session logs preserve carriage-return output as a raw session stream", async () => {
  const directory = path.join(TEMP_ROOT, `manual-raw-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dialogMock = {
    showSaveDialog: async () => ({ canceled: false, filePath }),
  };
  const {
    startManualSessionLog,
    stopManualSessionLog,
  } = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    const startResult = await startManualSessionLog(null, {
      sessionId,
      sessionName: "H3C switch",
      preferredDirectory: directory,
      initialLine: "H3C>",
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.started, true);

    sessionLogStreamManager.appendData(sessionId, "\rdisplay version\r\nComware Software\r\nH3C>");
    const stopResult = await stopManualSessionLog(null, { sessionId });

    assert.equal(stopResult.success, true);
    assert.equal(stopResult.stopped, true);
    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "H3C>\n\rdisplay version\r\nComware Software\r\nH3C>",
    );
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual session logs keep prompt and normal command echo on one line", async () => {
  const directory = path.join(TEMP_ROOT, `manual-normal-echo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dialogMock = {
    showSaveDialog: async () => ({ canceled: false, filePath }),
  };
  const {
    startManualSessionLog,
    stopManualSessionLog,
  } = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    const startResult = await startManualSessionLog(null, {
      sessionId,
      sessionName: "Linux host",
      preferredDirectory: directory,
      initialLine: "root@host:~# ",
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.started, true);

    sessionLogStreamManager.appendData(sessionId, "ls\r\nfile\r\nroot@host:~# ");
    const stopResult = await stopManualSessionLog(null, { sessionId });

    assert.equal(stopResult.success, true);
    assert.equal(stopResult.stopped, true);
    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "root@host:~# ls\r\nfile\r\nroot@host:~# ",
    );
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual session log save dialog only offers log files and normalizes extension", async () => {
  const directory = path.join(TEMP_ROOT, `manual-log-ext-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const selectedPath = path.join(directory, "manual.txt");
  const expectedPath = `${selectedPath}.log`;
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let dialogOptions;
  const dialogMock = {
    showSaveDialog: async (options) => {
      dialogOptions = options;
      return { canceled: false, filePath: selectedPath };
    },
  };
  const {
    startManualSessionLog,
    stopManualSessionLog,
  } = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    const startResult = await startManualSessionLog(null, {
      sessionId,
      sessionName: "H3C switch",
      preferredDirectory: directory,
      initialLine: "",
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.started, true);
    assert.equal(startResult.filePath, expectedPath);
    assert.deepEqual(
      dialogOptions.filters.map((filter) => filter.name),
      ["Log Files", "All Files"],
    );

    sessionLogStreamManager.appendData(sessionId, "body\r\n");
    const stopResult = await stopManualSessionLog(null, { sessionId });

    assert.equal(stopResult.filePath, expectedPath);
    assert.equal(fs.readFileSync(expectedPath, "utf8"), "body\r\n");
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("registerHandlers taps terminal worker output into main-process manual session logs", async () => {
  const directory = path.join(TEMP_ROOT, `manual-worker-tap-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dialogMock = {
    showSaveDialog: async () => ({ canceled: false, filePath }),
  };
  const bridge = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  const handlers = new Map();
  const ipcMainMock = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  let outputTap = null;
  bridge.registerHandlers(ipcMainMock, {
    terminalWorkerManager: {
      addOutputTap(listener) {
        outputTap = listener;
        return () => {};
      },
    },
  });
  assert.equal(typeof outputTap, "function");

  try {
    const startResult = await handlers.get("netcatty:sessionLog:manualStart")(null, {
      sessionId,
      sessionName: "worker host",
      preferredDirectory: directory,
      initialLine: "root@host:~# ",
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.started, true);

    // Terminal output produced in the worker process reaches the main
    // process only through the output tap.
    outputTap(sessionId, "ls\r\nfile\r\n");
    outputTap("other-session", "ignored\r\n");
    outputTap(sessionId, undefined);

    const stopResult = await handlers.get("netcatty:sessionLog:manualStop")(null, { sessionId });
    assert.equal(stopResult.success, true);
    assert.equal(stopResult.stopped, true);
    assert.equal(fs.readFileSync(filePath, "utf8"), "root@host:~# ls\r\nfile\r\n");
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual session log canceling normalized overwrite keeps existing file", async () => {
  const directory = path.join(TEMP_ROOT, `manual-log-overwrite-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const selectedPath = path.join(directory, "manual.txt");
  const expectedPath = `${selectedPath}.log`;
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let messageOptions;
  const dialogMock = {
    showSaveDialog: async () => ({ canceled: false, filePath: selectedPath }),
    showMessageBox: async (options) => {
      messageOptions = options;
      return { response: 1 };
    },
  };
  const { startManualSessionLog } = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(expectedPath, "old body", "utf8");

    const startResult = await startManualSessionLog(null, {
      sessionId,
      sessionName: "H3C switch",
      preferredDirectory: directory,
      initialLine: "",
    });

    assert.deepEqual(startResult, { success: true, started: false, canceled: true });
    assert.equal(sessionLogStreamManager.hasStream(sessionId), false);
    assert.equal(fs.readFileSync(expectedPath, "utf8"), "old body");
    assert.deepEqual(messageOptions.buttons, ["Overwrite", "Cancel"]);
    assert.equal(messageOptions.cancelId, 1);
    assert.match(messageOptions.message, /manual\.txt\.log/);
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual session log confirmed normalized overwrite replaces existing file", async () => {
  const directory = path.join(TEMP_ROOT, `manual-log-overwrite-confirm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const selectedPath = path.join(directory, "manual.txt");
  const expectedPath = `${selectedPath}.log`;
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let messageShown = false;
  const dialogMock = {
    showSaveDialog: async () => ({ canceled: false, filePath: selectedPath }),
    showMessageBox: async () => {
      messageShown = true;
      return { response: 0 };
    },
  };
  const {
    startManualSessionLog,
    stopManualSessionLog,
  } = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(expectedPath, "old body", "utf8");

    const startResult = await startManualSessionLog(null, {
      sessionId,
      sessionName: "H3C switch",
      preferredDirectory: directory,
      initialLine: "",
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.started, true);
    assert.equal(startResult.filePath, expectedPath);
    assert.equal(messageShown, true);

    sessionLogStreamManager.appendData(sessionId, "new body\r\n");
    const stopResult = await stopManualSessionLog(null, { sessionId });

    assert.equal(stopResult.filePath, expectedPath);
    assert.equal(fs.readFileSync(expectedPath, "utf8"), "new body\r\n");
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
