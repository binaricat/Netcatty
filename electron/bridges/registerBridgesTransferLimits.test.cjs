const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const EventEmitter = require("node:events");

const { createBridgeRegistrar } = require("../main/registerBridges.cjs");
const sftpBridge = require("./sftpBridge.cjs");

function createNoopBridge() {
  return {
    init() {},
    registerHandlers() {},
  };
}

function createIpcMainStub() {
  return {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on() {},
  };
}

class FakeWorkerChild extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  postMessage(message) {
    this.messages.push(message);
  }
}

function createBridgeRegistrarForTest({
  ipcMain,
  tempDir,
  sftpClients = new Map(),
  transferBridge = createNoopBridge(),
  sshBridge = null,
  terminalBridge = null,
  electronModuleOverrides = {},
}) {
  const noopBridge = createNoopBridge();
  const tempDirBridge = {
    ensureTempDir() {},
    registerHandlers() {},
    getTempDir: () => tempDir,
    getCustomTempDir: () => null,
    getTempFilePath: (fileName) => Promise.resolve(path.join(tempDir, fileName)),
  };

  return createBridgeRegistrar({
    electronModule: {
      ipcMain,
      safeStorage: {
        isEncryptionAvailable: () => false,
      },
      dialog: {},
      ...electronModuleOverrides,
    },
    app: {
      getPath: () => tempDir,
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
    appIcon: null,
    isMac: false,
    electronDir: __dirname,
    sessions: new Map(),
    sftpClients,
    CLOUD_SYNC_PASSWORD_FILE: "cloud-sync-password",
    getCliDiscoveryFilePath: () => path.join(tempDir, "cli-discovery.json"),
    sshBridge: sshBridge || { ...noopBridge, ensureMoshStatsConnection() {} },
    sftpBridge,
    localFsBridge: noopBridge,
    transferBridge,
    portForwardingBridge: noopBridge,
    terminalBridge: terminalBridge || { ...noopBridge, execOnEtSession() {} },
    crashLogBridge: noopBridge,
    ptyProcessTree: { getChildProcesses: () => [] },
    getOauthBridge: () => ({ setupOAuthBridge() {} }),
    getGithubAuthBridge: () => noopBridge,
    getGoogleAuthBridge: () => noopBridge,
    getOnedriveAuthBridge: () => noopBridge,
    getCloudSyncBridge: () => noopBridge,
    getFileWatcherBridge: () => noopBridge,
    getTempDirBridge: () => tempDirBridge,
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
}

test("the single temp-download entry routes direct downloads through the shared transfer bridge", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-download-temp-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const ipcMain = createIpcMainStub();
  const observed = {};
  const transferBridge = {
    ...createNoopBridge(),
    async startTransfer(event, payload) {
      observed.event = event;
      observed.payload = payload;
      await fs.promises.writeFile(payload.targetPath, "downloaded");
      return {};
    },
  };
  const registerBridges = createBridgeRegistrarForTest({
    ipcMain,
    tempDir,
    transferBridge,
  });

  registerBridges({});

  const handler = ipcMain.handlers.get("netcatty:sftp:downloadToTempWithProgress");
  assert.equal(typeof handler, "function");

  const result = await handler(
    { sender: { id: 1 } },
    {
      sftpId: "sftp-1",
      remotePath: "/remote/report.bin",
      fileName: "report.bin",
      encoding: "utf-8",
      transferId: "editor-download-1",
    },
  );

  assert.deepEqual(result, {
    localPath: path.join(tempDir, "report.bin"),
    cancelled: false,
  });
  assert.equal(observed.event.sender.id, 1);
  // Omit totalBytes so transferBridge discovers remote size. Explicit 0 means
  // a planned empty snapshot and would skip the remote body (#2787).
  assert.deepEqual(observed.payload, {
    transferId: "editor-download-1",
    sourcePath: "/remote/report.bin",
    targetPath: path.join(tempDir, "report.bin"),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId: "sftp-1",
    sourceEncoding: "utf-8",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(observed.payload, "totalBytes"),
    false,
    "downloadToTempWithProgress must not send totalBytes (especially not 0)",
  );
});

test("the retired no-progress temp-download IPC is not registered", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-download-worker-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const ipcMain = createIpcMainStub();
  const registerBridges = createBridgeRegistrarForTest({
    ipcMain,
    tempDir,
  });

  registerBridges({});
  assert.equal(ipcMain.handlers.has("netcatty:sftp:downloadToTemp"), false);
  assert.equal(typeof ipcMain.handlers.get("netcatty:sftp:downloadToTempWithProgress"), "function");
});

test("downloadToTempWithProgress proxies transfer work to the terminal worker in worker mode", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-download-worker-progress-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const ipcMain = createIpcMainStub();
  const child = new FakeWorkerChild();
  const registerBridges = createBridgeRegistrarForTest({
    ipcMain,
    tempDir,
    electronModuleOverrides: {
      utilityProcess: {
        fork() {
          return child;
        },
      },
    },
  });

  registerBridges({});

  const handler = ipcMain.handlers.get("netcatty:sftp:downloadToTempWithProgress");
  const promise = handler(
    { sender: { id: 13 } },
    {
      sftpId: "worker-sftp-1",
      remotePath: "/remote/report.bin",
      fileName: "report.bin",
      encoding: "utf-8",
      transferId: "transfer-1",
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(child.messages[0].channel, "netcatty:transfer:start");
  assert.equal(child.messages[0].webContentsId, 13);
  assert.deepEqual(child.messages[0].payload, {
    transferId: "transfer-1",
    sourcePath: "/remote/report.bin",
    targetPath: path.join(tempDir, "report.bin"),
    sourceType: "sftp",
    targetType: "local",
    sourceSftpId: "worker-sftp-1",
    sourceEncoding: "utf-8",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(child.messages[0].payload, "totalBytes"),
    false,
    "worker-mode downloadToTempWithProgress must not send totalBytes",
  );
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: {},
  });

  assert.deepEqual(await promise, {
    localPath: path.join(tempDir, "report.bin"),
    cancelled: false,
  });
});

for (const mode of ["disabled", "unavailable", "worker"]) {
  test(`registrar enables saved-log restart guards only for main fallback (${mode})`, async (t) => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-log-fallback-test-"));
    const previousWorkerSetting = process.env.NETCATTY_TERMINAL_WORKER;
    process.env.NETCATTY_TERMINAL_WORKER = mode === "disabled" ? "0" : "1";
    t.after(async () => {
      if (previousWorkerSetting === undefined) delete process.env.NETCATTY_TERMINAL_WORKER;
      else process.env.NETCATTY_TERMINAL_WORKER = previousWorkerSetting;
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });
    const observed = {};
    const bridgeSpy = (name) => ({
      ...createNoopBridge(),
      registerHandlers(_ipcMain, options) { observed[name] = options; },
    });
    const registerBridges = createBridgeRegistrarForTest({
      ipcMain: createIpcMainStub(), tempDir,
      sshBridge: bridgeSpy("ssh"), terminalBridge: bridgeSpy("terminal"),
      electronModuleOverrides: mode === "unavailable" ? {} : {
        utilityProcess: { fork() { throw new Error("registration must not cold-start the worker"); } },
      },
    });
    registerBridges({});
    for (const name of ["ssh", "terminal"]) {
      assert.equal(observed[name].manageSessionLogRestart, mode !== "worker");
      assert.equal(Boolean(observed[name].terminalWorkerManager), mode === "worker");
    }
  });
}
