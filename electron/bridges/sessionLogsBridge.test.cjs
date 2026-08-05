const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const TEMP_ROOT = path.join(__dirname, ".tmp-session-logs-bridge-tests");

async function waitForPath(targetPath, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(targetPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for path: ${targetPath}`);
}

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

test("isSessionLogArtifactName matches auto-save and labeled export filenames", () => {
  const { isSessionLogArtifactName } = loadBridgeWithDialog({});

  assert.equal(isSessionLogArtifactName("2026-01-01T00-00-00.txt"), true);
  assert.equal(isSessionLogArtifactName("2026-01-01T00-00-00.log"), true);
  assert.equal(isSessionLogArtifactName("2026-01-01T00-00-00.html"), true);
  assert.equal(isSessionLogArtifactName("my-host_2026-01-01T00-00-00.txt"), true);
  assert.equal(isSessionLogArtifactName("生产_服务器_2026-08-05T15-33-00.log"), true);
  assert.equal(isSessionLogArtifactName("stray.log"), false);
  assert.equal(isSessionLogArtifactName("notes.txt"), false);
  assert.equal(isSessionLogArtifactName("2026-01-01.txt"), false);
  assert.equal(isSessionLogArtifactName("readme.md"), false);
});

test("clearSessionLogsDir deletes host log folders and labeled exports only", async () => {
  const directory = path.join(TEMP_ROOT, `clear-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { clearSessionLogsDir } = loadBridgeWithDialog({});

  try {
    const hostDir = path.join(directory, "my-host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "2026-01-01T00-00-00.txt"), "hello\n");
    fs.writeFileSync(path.join(hostDir, "2026-01-02T12-30-00.log"), "raw\n");
    // Labeled export-style artifact at the save-dir root (manual export / continuous log).
    fs.writeFileSync(path.join(directory, "my-host_2026-01-03T01-02-03.txt"), "export\n");
    // Unrelated user content in a shared save directory must survive clear-all.
    fs.writeFileSync(path.join(directory, "stray.log"), "stray\n");
    fs.writeFileSync(path.join(directory, "notes.txt"), "keep me\n");
    fs.mkdirSync(path.join(directory, "Photos"), { recursive: true });
    fs.writeFileSync(path.join(directory, "Photos", "vacation.jpg"), "jpeg");

    const result = await clearSessionLogsDir(null, { directory });

    assert.equal(result.success, true);
    assert.equal(result.deletedCount, 2); // pure host folder + labeled export file
    assert.equal(result.failedCount, 0);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["Photos", "notes.txt", "stray.log"]);
    assert.equal(fs.readFileSync(path.join(directory, "stray.log"), "utf8"), "stray\n");
    assert.equal(fs.readFileSync(path.join(directory, "Photos", "vacation.jpg"), "utf8"), "jpeg");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearSessionLogsDir only removes log files inside mixed host directories", async () => {
  const directory = path.join(TEMP_ROOT, `clear-mixed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { clearSessionLogsDir } = loadBridgeWithDialog({});

  try {
    const hostDir = path.join(directory, "shared-host-folder");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "2026-01-01T00-00-00.txt"), "log\n");
    fs.writeFileSync(path.join(hostDir, "user-notes.md"), "do not delete\n");

    const result = await clearSessionLogsDir(null, { directory });

    assert.equal(result.success, true);
    assert.equal(result.deletedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(fs.readdirSync(directory), ["shared-host-folder"]);
    assert.deepEqual(fs.readdirSync(hostDir), ["user-notes.md"]);
    assert.equal(fs.readFileSync(path.join(hostDir, "user-notes.md"), "utf8"), "do not delete\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearSessionLogsDir preserves active auto-save stream files and host dirs", async () => {
  const directory = path.join(TEMP_ROOT, `clear-active-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-active-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { clearSessionLogsDir } = loadBridgeWithDialog({});
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    const startToken = sessionLogStreamManager.startStream(sessionId, {
      hostLabel: "live-host",
      hostname: "live.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    assert.ok(startToken);
    sessionLogStreamManager.appendData(sessionId, "live body\n");

    // Prefer stream manager paths: createWriteStream open is async, so the
    // file may not appear in readdir until the open/write settles.
    const activePaths = sessionLogStreamManager.getActiveLogPaths();
    assert.equal(activePaths.length, 1);
    const activePath = activePaths[0];
    const hostDir = path.dirname(activePath);
    assert.equal(path.basename(hostDir), "live-host");

    // Wait for the live target to materialize on disk (async open).
    await waitForPath(activePath);
    // Stale sibling log in the same host folder should still be cleared.
    fs.writeFileSync(path.join(hostDir, "2026-01-01T00-00-00.log"), "stale\n");
    // Inactive pure host folder should still be removed.
    const staleHostDir = path.join(directory, "stale-host");
    fs.mkdirSync(staleHostDir, { recursive: true });
    fs.writeFileSync(path.join(staleHostDir, "2026-01-03T00-00-00.txt"), "old\n");

    const result = await clearSessionLogsDir(null, { directory });

    assert.equal(result.success, true);
    assert.equal(result.failedCount, 0);
    assert.equal(result.deletedCount, 2); // stale sibling log + pure stale-host folder
    assert.deepEqual(fs.readdirSync(directory).sort(), ["live-host"]);
    assert.ok(fs.existsSync(activePath), "active stream path must survive clear-all");
    assert.deepEqual(fs.readdirSync(hostDir), [path.basename(activePath)]);

    // Stream must still accept writes after clear-all (not unlinked/orphaned).
    sessionLogStreamManager.appendData(sessionId, "after clear\n");
    assert.equal(sessionLogStreamManager.hasStream(sessionId), true);
    const stoppedPath = await sessionLogStreamManager.stopStream(sessionId, startToken);
    assert.equal(path.resolve(stoppedPath), path.resolve(activePath));
    const content = fs.readFileSync(activePath, "utf8");
    assert.match(content, /live body/);
    assert.match(content, /after clear/);
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearSessionLogsDir unions worker-owned active paths with main-process streams", async () => {
  const directory = path.join(TEMP_ROOT, `clear-worker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { clearSessionLogsDir } = loadBridgeWithDialog({});

  try {
    const hostDir = path.join(directory, "worker-host");
    fs.mkdirSync(hostDir, { recursive: true });
    // Simulate a live worker-owned auto-save file (invisible to main manager).
    const workerLivePath = path.join(hostDir, "2026-01-05T06-07-08.log");
    fs.writeFileSync(workerLivePath, "worker live body\n");
    // Stale sibling in the same host dir should still be cleared.
    fs.writeFileSync(path.join(hostDir, "2026-01-01T00-00-00.log"), "stale\n");
    // Unrelated pure host folder still cleared.
    const staleHostDir = path.join(directory, "stale-worker-host");
    fs.mkdirSync(staleHostDir, { recursive: true });
    fs.writeFileSync(path.join(staleHostDir, "2026-01-03T00-00-00.txt"), "old\n");

    let requestedChannel = null;
    const terminalWorkerManager = {
      isRunning: () => true,
      request: async (channel) => {
        requestedChannel = channel;
        return [workerLivePath];
      },
    };

    const result = await clearSessionLogsDir(null, { directory }, terminalWorkerManager);

    assert.equal(requestedChannel, "netcatty:sessionLogs:getActivePaths");
    assert.equal(result.success, true);
    assert.equal(result.failedCount, 0);
    assert.equal(result.deletedCount, 2); // stale sibling + pure stale host
    assert.deepEqual(fs.readdirSync(directory).sort(), ["worker-host"]);
    assert.ok(fs.existsSync(workerLivePath), "worker-owned active stream must survive clear-all");
    assert.deepEqual(fs.readdirSync(hostDir), [path.basename(workerLivePath)]);
    assert.equal(fs.readFileSync(workerLivePath, "utf8"), "worker live body\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearSessionLogsDir does not cold-start a stopped terminal worker", async () => {
  const directory = path.join(TEMP_ROOT, `clear-no-worker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { clearSessionLogsDir } = loadBridgeWithDialog({});

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "host_2026-01-01T00-00-00.txt"), "export\n");

    let requestCalls = 0;
    const terminalWorkerManager = {
      isRunning: () => false,
      request: async () => {
        requestCalls += 1;
        return [];
      },
    };

    const result = await clearSessionLogsDir(null, { directory }, terminalWorkerManager);

    assert.equal(requestCalls, 0, "must not request worker paths when worker is stopped");
    assert.equal(result.success, true);
    assert.equal(result.deletedCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearSessionLogsDir preserves snapshot-only host dirs before the first file exists", async () => {
  const directory = path.join(TEMP_ROOT, `clear-snap-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-snap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { clearSessionLogsDir } = loadBridgeWithDialog({});
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

  try {
    // txt streams keep renderer state in memory and only materialize the file
    // on snapshot flush — clear-all must still treat the registered path as live.
    const startToken = sessionLogStreamManager.startStream(sessionId, {
      hostLabel: "snap-host",
      hostname: "snap.example",
      directory,
      format: "txt",
      startTime: Date.UTC(2026, 0, 4, 5, 6, 7),
    });
    assert.ok(startToken);

    const activePaths = sessionLogStreamManager.getActiveLogPaths();
    assert.equal(activePaths.length, 1);
    const activePath = activePaths[0];
    const hostDir = path.dirname(activePath);
    assert.equal(path.basename(hostDir), "snap-host");
    assert.equal(fs.existsSync(activePath), false, "snapshot file must not exist yet");

    // Sibling inactive log would make the host dir look like a pure log folder
    // if we only inspected readdir and missed the not-yet-created active path.
    fs.writeFileSync(path.join(hostDir, "2026-01-01T00-00-00.txt"), "stale\n");
    const staleHostDir = path.join(directory, "stale-snap-host");
    fs.mkdirSync(staleHostDir, { recursive: true });
    fs.writeFileSync(path.join(staleHostDir, "2026-01-03T00-00-00.txt"), "old\n");

    const result = await clearSessionLogsDir(null, { directory });

    assert.equal(result.success, true);
    assert.equal(result.failedCount, 0);
    assert.equal(result.deletedCount, 2); // stale sibling + pure stale host
    assert.deepEqual(fs.readdirSync(directory).sort(), ["snap-host"]);
    assert.ok(fs.existsSync(hostDir), "active snapshot host dir must survive clear-all");
    assert.deepEqual(fs.readdirSync(hostDir), []);

    // Stream must still be able to write its first snapshot after clear-all.
    sessionLogStreamManager.appendData(sessionId, "first snapshot body\n");
    const stoppedPath = await sessionLogStreamManager.stopStream(sessionId, startToken);
    assert.equal(path.resolve(stoppedPath), path.resolve(activePath));
    await waitForPath(activePath);
    assert.match(fs.readFileSync(activePath, "utf8"), /first snapshot body/);
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearSessionLogsDir leaves unrelated empty or non-log folders alone", async () => {
  const directory = path.join(TEMP_ROOT, `clear-unrelated-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { clearSessionLogsDir } = loadBridgeWithDialog({});

  try {
    fs.mkdirSync(path.join(directory, "empty-folder"), { recursive: true });
    fs.mkdirSync(path.join(directory, "docs"), { recursive: true });
    fs.writeFileSync(path.join(directory, "docs", "readme.md"), "hi\n");

    const result = await clearSessionLogsDir(null, { directory });

    assert.equal(result.success, true);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["docs", "empty-folder"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clearSessionLogsDir is a no-op when the directory does not exist", async () => {
  const directory = path.join(TEMP_ROOT, `clear-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { clearSessionLogsDir } = loadBridgeWithDialog({});

  const result = await clearSessionLogsDir(null, { directory });

  assert.deepEqual(result, { success: true, deletedCount: 0, failedCount: 0 });
});

test("clearSessionLogsDir reports an error when no directory is specified", async () => {
  const { clearSessionLogsDir } = loadBridgeWithDialog({});

  const result = await clearSessionLogsDir(null, {});

  assert.equal(result.success, false);
  assert.equal(result.deletedCount, 0);
  assert.equal(result.failedCount, 0);
  assert.ok(result.error);
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

test("manual session logs honor the configured plain-text format", async () => {
  const directory = path.join(TEMP_ROOT, `manual-txt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const selectedPath = path.join(directory, "manual");
  const expectedPath = `${selectedPath}.txt`;
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
      sessionName: "Linux host",
      preferredDirectory: directory,
      format: "txt",
      initialLine: "root@host:~# ",
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.filePath, expectedPath);
    assert.match(dialogOptions.defaultPath, /\.txt$/);
    assert.deepEqual(dialogOptions.filters[0], { name: "Text Files", extensions: ["txt"] });

    sessionLogStreamManager.appendData(
      sessionId,
      "\u001b[31mdisplay\u001b[0m\r\npage 1\r\n--More--\r        \rpage 2\r\n",
    );
    const stopResult = await stopManualSessionLog(null, { sessionId });

    assert.equal(stopResult.filePath, expectedPath);
    assert.equal(fs.readFileSync(expectedPath, "utf8"), "root@host:~# display\npage 1\npage 2");
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual session logs honor HTML format and timestamps", async () => {
  const directory = path.join(TEMP_ROOT, `manual-html-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.html");
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
      sessionName: "HTML / host:22",
      preferredDirectory: directory,
      format: "html",
      timestampsEnabled: true,
      initialLine: "",
    });
    assert.equal(startResult.success, true);

    sessionLogStreamManager.appendData(sessionId, "ready\r\n");
    await stopManualSessionLog(null, { sessionId });

    const content = fs.readFileSync(filePath, "utf8");
    assert.match(content, /<!DOCTYPE html>/);
    assert.match(content, /HTML \/ host:22/);
    assert.doesNotMatch(content, /HTML _ host_22/);
    assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ready/);
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual rendered logs report final write failures", async () => {
  const directory = path.join(TEMP_ROOT, `manual-write-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.txt");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dialogMock = {
    showSaveDialog: async () => ({ canceled: false, filePath }),
  };
  const {
    startManualSessionLog,
    stopManualSessionLog,
  } = loadBridgeWithDialog(dialogMock);
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
  const originalWriteFile = fs.promises.writeFile;

  try {
    const startResult = await startManualSessionLog(null, {
      sessionId,
      sessionName: "failing host",
      preferredDirectory: directory,
      format: "txt",
      initialLine: "",
    });
    assert.equal(startResult.success, true);
    sessionLogStreamManager.appendData(sessionId, "body\r\n");

    fs.promises.writeFile = async () => {
      throw new Error("disk full");
    };
    const stopResult = await stopManualSessionLog(null, { sessionId });

    assert.deepEqual(stopResult, {
      success: false,
      stopped: true,
      error: "Failed to finalize session log",
    });
  } finally {
    fs.promises.writeFile = originalWriteFile;
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
