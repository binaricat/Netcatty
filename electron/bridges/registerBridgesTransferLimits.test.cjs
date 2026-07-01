const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const EventEmitter = require("node:events");

const { createBridgeRegistrar } = require("../main/registerBridges.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const {
  TRANSFER_CHUNK_SIZE,
  TRANSFER_CONCURRENCY,
} = require("./transferLimits.cjs");

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
  electronModuleOverrides = {},
}) {
  const noopBridge = createNoopBridge();
  const tempDirBridge = {
    ensureTempDir() {},
    registerHandlers() {},
    getTempDir: () => tempDir,
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
    sshBridge: { ...noopBridge, ensureMoshStatsConnection() {} },
    sftpBridge,
    localFsBridge: noopBridge,
    transferBridge,
    portForwardingBridge: noopBridge,
    terminalBridge: { ...noopBridge, execOnEtSession() {} },
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
    publicMcpBridge: noopBridge,
    getWindowManager: () => ({}),
    getVaultBackupBridge: () => noopBridge,
    isPathInside: () => true,
  });
}

test("downloadToTemp applies shared SFTP transfer limits to direct fastGet downloads", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-download-temp-test-"));
  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const ipcMain = createIpcMainStub();
  const observed = {};
  const sftpClients = new Map([
    [
      "sftp-1",
      {
        fastGet(_remotePath, localPath, options) {
          observed.options = options;
          return fs.promises.writeFile(localPath, "downloaded");
        },
      },
    ],
  ]);
  const registerBridges = createBridgeRegistrarForTest({
    ipcMain,
    tempDir,
    sftpClients,
  });

  registerBridges({});

  const handler = ipcMain.handlers.get("netcatty:sftp:downloadToTemp");
  assert.equal(typeof handler, "function");

  const localPath = await handler(
    { sender: { id: 1 } },
    {
      sftpId: "sftp-1",
      remotePath: "/remote/report.bin",
      fileName: "report.bin",
      encoding: "utf-8",
    },
  );

  assert.equal(localPath, path.join(tempDir, "report.bin"));
  assert.deepEqual(observed.options, {
    chunkSize: TRANSFER_CHUNK_SIZE,
    concurrency: TRANSFER_CONCURRENCY,
  });
});

test("downloadToTemp proxies to the terminal worker in worker mode", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "netcatty-download-worker-test-"));
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

  const handler = ipcMain.handlers.get("netcatty:sftp:downloadToTemp");
  const promise = handler(
    { sender: { id: 12 } },
    {
      sftpId: "worker-sftp-1",
      remotePath: "/remote/report.bin",
      fileName: "report.bin",
      encoding: "utf-8",
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(child.messages[0].channel, "netcatty:sftp:downloadToLocal");
  assert.equal(child.messages[0].webContentsId, 12);
  assert.deepEqual(child.messages[0].payload, {
    sftpId: "worker-sftp-1",
    remotePath: "/remote/report.bin",
    localPath: path.join(tempDir, "report.bin"),
    encoding: "utf-8",
  });
  child.emit("message", {
    kind: "response",
    requestId: child.messages[0].requestId,
    result: { success: true },
  });

  assert.equal(await promise, path.join(tempDir, "report.bin"));
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
    totalBytes: 0,
  });
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
