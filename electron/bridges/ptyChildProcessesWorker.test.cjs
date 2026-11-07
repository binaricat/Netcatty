const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const EventEmitter = require("node:events");

const { createBridgeRegistrar } = require("../main/registerBridges.cjs");
const ptyProcessTree = require("./ptyProcessTree.cjs");

const channel = "netcatty:pty:childProcesses";
const event = { sender: { id: 42 } };
const children = [{ pid: 2001, command: "node server.js" }];

function createIpcMain() {
  return {
    handlers: new Map(),
    handle(name, handler) { this.handlers.set(name, handler); },
    on() {},
  };
}

function createMainHandler(t, { mode = "worker" } = {}) {
  const previousWorkerSetting = process.env.NETCATTY_TERMINAL_WORKER;
  process.env.NETCATTY_TERMINAL_WORKER = mode === "disabled" ? "0" : "1";
  t.after(() => {
    if (previousWorkerSetting === undefined) delete process.env.NETCATTY_TERMINAL_WORKER;
    else process.env.NETCATTY_TERMINAL_WORKER = previousWorkerSetting;
  });
  // Keep unrelated plugin initialization and persistence outside this IPC test.
  t.mock.method(require("../plugins/hostBootstrap.cjs"), "startPluginHost", () => null);

  const ipcMain = createIpcMain();
  const noopBridge = { init() {}, registerHandlers() {} };
  const localCalls = [];
  const localChildren = [{ pid: 3001, command: "sleep 100" }];
  let terminalWorkerManager;
  const registerBridges = createBridgeRegistrar({
    electronModule: {
      ipcMain,
      safeStorage: { isEncryptionAvailable: () => false },
      dialog: {},
      nativeTheme: new EventEmitter(),
      ...(mode === "unavailable" ? {} : {
        utilityProcess: { fork() { throw new Error("test must not start a real worker"); } },
      }),
    },
    app: {
      getPath: () => __dirname,
      getVersion: () => "0.0.0",
      getName: () => "Netcatty",
    },
    BrowserWindow: { getAllWindows: () => [] },
    shell: { openExternal() {}, openPath() {} },
    clipboard: { readText: () => "", writeText() {} },
    path,
    fs,
    os,
    preload: "",
    effectiveDevServerUrl: null,
    isDev: false,
    isMac: false,
    electronDir: __dirname,
    sessions: new Map(),
    sftpClients: new Map(),
    CLOUD_SYNC_PASSWORD_FILE: "cloud-sync-password",
    getCliDiscoveryFilePath: () => path.join(__dirname, "cli-discovery.json"),
    sshBridge: { ...noopBridge, ensureMoshStatsConnection() {} },
    sftpBridge: noopBridge,
    localFsBridge: noopBridge,
    transferBridge: noopBridge,
    portForwardingBridge: noopBridge,
    terminalBridge: {
      ...noopBridge,
      execOnEtSession() {},
      registerHandlers(_ipcMain, options) { terminalWorkerManager = options.terminalWorkerManager; },
    },
    crashLogBridge: noopBridge,
    ptyProcessTree: {
      getChildProcesses(sessionId) {
        localCalls.push(sessionId);
        return Promise.resolve(localChildren);
      },
    },
    getOauthBridge: () => ({ setupOAuthBridge() {} }),
    getGithubAuthBridge: () => noopBridge,
    getGoogleAuthBridge: () => noopBridge,
    getOnedriveAuthBridge: () => noopBridge,
    getCloudSyncBridge: () => noopBridge,
    getFileWatcherBridge: () => noopBridge,
    getTempDirBridge: () => ({
      ...noopBridge,
      ensureTempDir() {},
      getCustomTempDir: () => null,
    }),
    getSessionLogsBridge: () => noopBridge,
    getCompressUploadBridge: () => noopBridge,
    getGlobalShortcutBridge: () => noopBridge,
    getCredentialBridge: () => noopBridge,
    getAutoUpdateBridge: () => noopBridge,
    getAiBridge: () => noopBridge,
    getHttpNetworkProxyBridge: () => noopBridge,
    getWindowManager: () => ({}),
    getVaultBackupBridge: () => noopBridge,
    isPathInside: () => true,
  });
  registerBridges({});
  return {
    handler: ipcMain.handlers.get(channel),
    terminalWorkerManager,
    localCalls,
    localChildren,
  };
}

for (const [name, result] of [
  ["array", children],
  ["wrapped array", { children }],
  ["empty array", []],
]) {
  test(`main child-process handler forwards the session and sender and returns worker ${name}`, async (t) => {
    const { handler, terminalWorkerManager, localCalls } = createMainHandler(t);
    const request = t.mock.method(terminalWorkerManager, "request", async () => result);

    assert.deepEqual(await handler(event, "session-1"), name === "empty array" ? [] : children);
    assert.equal(request.mock.callCount(), 1);
    assert.deepEqual(request.mock.calls[0].arguments, [channel, { sessionId: "session-1" }, { webContentsId: 42 }]);
    assert.deepEqual(localCalls, []);
  });
}

for (const [name, request] of [
  ["throws", async () => { throw new Error("worker unavailable"); }],
  ["returns null", async () => null],
  ["returns a non-array", async () => ({ children: "invalid" })],
]) {
  test(`main child-process handler falls back locally when worker ${name}`, async (t) => {
    const { handler, terminalWorkerManager, localCalls, localChildren } = createMainHandler(t);
    t.mock.method(terminalWorkerManager, "request", request);

    assert.deepEqual(await handler(event, "session-1"), localChildren);
    assert.deepEqual(localCalls, ["session-1"]);
  });
}

for (const mode of ["unavailable", "disabled"]) {
  test(`main child-process handler falls back locally when worker is ${mode}`, async (t) => {
    const { handler, terminalWorkerManager, localCalls, localChildren } = createMainHandler(t, { mode });
    assert.equal(terminalWorkerManager, null);
    assert.deepEqual(await handler(event, "session-1"), localChildren);
    assert.deepEqual(localCalls, ["session-1"]);
  });
}

test("main child-process handler rejects non-string session IDs before querying either process", async (t) => {
  const { handler, terminalWorkerManager, localCalls } = createMainHandler(t);
  const request = t.mock.method(terminalWorkerManager, "request", async () => children);
  for (const payload of [undefined, null, 123, { sessionId: "session-1" }]) {
    assert.deepEqual(await handler(event, payload), []);
  }
  assert.equal(request.mock.callCount(), 0);
  assert.deepEqual(localCalls, []);
});

test("worker child-process handler accepts string and object payloads using its local process tree", async (t) => {
  const ipcMain = createIpcMain();
  const getChildProcesses = t.mock.method(ptyProcessTree.processTree, "getChildProcesses", async () => children);
  ptyProcessTree.registerWorkerHandlers(ipcMain);
  const handler = ipcMain.handlers.get(channel);

  assert.deepEqual(await handler(event, "session-1"), children);
  assert.deepEqual(await handler(event, { sessionId: "session-2" }), children);
  assert.deepEqual(getChildProcesses.mock.calls.map((call) => call.arguments), [["session-1"], ["session-2"]]);
});

test("worker child-process handler ignores invalid session IDs", async (t) => {
  const ipcMain = createIpcMain();
  const getChildProcesses = t.mock.method(ptyProcessTree.processTree, "getChildProcesses", async () => children);
  ptyProcessTree.registerWorkerHandlers(ipcMain);
  const handler = ipcMain.handlers.get(channel);

  for (const payload of [undefined, null, 123, {}, { sessionId: 123 }]) {
    assert.deepEqual(await handler(event, payload), []);
  }
  assert.equal(getChildProcesses.mock.callCount(), 0);
});
