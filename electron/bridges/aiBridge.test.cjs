const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { prepareCommandForSpawn } = require("./ai/shellUtils.cjs");

function createIpcMainStub() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

function loadBridgeWithMocks(options = {}) {
  const mocks = {
    "./mcpServerBridge.cjs": {
      init() {},
      setMainWindowGetter() {},
      getOrCreateHost: async () => 4010,
      getScopedSessionIds: () => [],
      buildMcpServerConfig: () => ({ name: "netcatty-remote-hosts", type: "http", url: "http://127.0.0.1:4010" }),
      getPermissionMode: () =>
        typeof options.getPermissionMode === "function"
          ? options.getPermissionMode()
          : "default",
      getMaxIterations: () => 20,
      setChatSessionCancelled() {},
      cancelPtyExecsForSession() {},
      clearPendingApprovals() {},
      cleanupScopedMetadata: async () => {},
      cleanup() {},
    },
    "../cli/discoveryPath.cjs": {
      getCliLauncherPath: () => "/tmp/netcatty-tool-cli",
      TOOL_CLI_DISCOVERY_ENV_VAR: "NETCATTY_TOOL_CLI_DISCOVERY_FILE",
    },
    "./ai/userSkills.cjs": {
      scanUserSkills: async () => ({ readyCount: 0, warningCount: 0, skills: [], warnings: [] }),
      buildUserSkillsContext: async () => ({ context: "", selectedSkills: [] }),
      toPublicUserSkillsStatus: (value) => value,
    },
    "./ai/shellUtils.cjs": {
      stripAnsi: (value) => value,
      normalizeCliPathForPlatform: (...args) =>
        typeof options.normalizeCliPathForPlatform === "function"
          ? options.normalizeCliPathForPlatform(...args)
          : args[0],
      shouldUseShellForCommand: () => false,
      prepareCommandForSpawn: (...args) =>
        typeof options.prepareCommandForSpawn === "function"
          ? options.prepareCommandForSpawn(...args)
          : prepareCommandForSpawn(...args),
      normalizeClaudeCodeExecutableEnvForSdk: (env) =>
        typeof options.normalizeClaudeCodeExecutableEnvForSdk === "function"
          ? options.normalizeClaudeCodeExecutableEnvForSdk(env)
          : env,
      isPlausibleCliVersionOutput: (value) =>
        typeof options.isPlausibleCliVersionOutput === "function"
          ? options.isPlausibleCliVersionOutput(value)
          : true,
      resolveCliFromPath: (...args) =>
        typeof options.resolveCliFromPath === "function"
          ? options.resolveCliFromPath(...args)
          : null,
      getShellEnv: async () => ({}),
      invalidateShellEnvCache() {},
      toUnpackedAsarPath: (value) => value,
    },
    "./ai/codexHelpers.cjs": {
      codexLoginSessions: new Map(),
      appendCodexLoginOutput() {},
      toCodexLoginSessionResponse: () => ({}),
      getActiveCodexLoginSession: () => null,
      normalizeCodexIntegrationState: () => ({}),
      readCodexCustomProviderConfig: () => null,
      getCodexCustomConfigPreflightError: () => null,
      extractCodexError: (err) => ({ message: err?.message || String(err) }),
      isCodexAuthError: () => false,
      getCodexAuthFingerprint: (...args) =>
        typeof options.getCodexAuthFingerprint === "function"
          ? options.getCodexAuthFingerprint(...args)
          : "auth-fingerprint",
      getCodexMcpFingerprint: () => "mcp-fingerprint",
      invalidateCodexValidationCache() {},
      getCodexValidationCache: () => null,
      setCodexValidationCache() {},
    },
    "./aiBridge/agentAuthProbes.cjs": {
      probeClaudeAuth: (...args) =>
        typeof options.probeClaudeAuth === "function" ? options.probeClaudeAuth(...args) : { authenticated: false, authSource: null },
      probeCopilotAuth: (...args) =>
        typeof options.probeCopilotAuth === "function" ? options.probeCopilotAuth(...args) : { authenticated: false, authSource: null },
      probeCodexAuth: (...args) =>
        typeof options.probeCodexAuth === "function" ? options.probeCodexAuth(...args) : { authenticated: false, authSource: null },
    },
    "./ai/ptyExec.cjs": {
      execViaPty: async () => {
        throw new Error("execViaPty should not be called in this test");
      },
    },
    "./ipcUtils.cjs": {
      safeSend() {},
    },
    "./windowManager.cjs": {
      getMainWindow() {
        return {
          isDestroyed: () => false,
          webContents: { id: 1 },
        };
      },
      getSettingsWindow() {
        return null;
      },
    },
  };

  const bridgePath = require.resolve("./aiBridge.cjs");
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[bridgePath];

  try {
    const bridge = require("./aiBridge.cjs");
    return {
      bridge,
      restore() {
        try {
          bridge.cleanup();
        } finally {
          delete require.cache[bridgePath];
          Module._load = originalLoad;
        }
      },
    };
  } catch (error) {
    delete require.cache[bridgePath];
    Module._load = originalLoad;
    throw error;
  }
}

test("discover returns the 3-layer contract for an installed, authenticated agent", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-discover-contract-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const claudePath = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  fs.writeFileSync(
    claudePath,
    process.platform === "win32" ? "@echo off\r\necho 1.2.3 (Claude Code)\r\n" : "#!/bin/sh\necho '1.2.3 (Claude Code)'\n",
    { mode: 0o755 },
  );

  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: (cmd) => (cmd === "claude" ? claudePath : null),
    isPlausibleCliVersionOutput: () => true,
    probeClaudeAuth: () => ({ authenticated: true, authSource: "env" }),
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const discover = ipcMain.handlers.get("netcatty:ai:agents:discover");
    assert.equal(typeof discover, "function");
    const agents = await discover({ sender: { id: 1 } });
    assert.equal(agents.length, 1);
    assert.equal(agents[0].command, "claude");
    assert.equal(agents[0].sdkBackend, "claude");
    assert.equal(agents[0].binPath, claudePath);
    assert.equal(agents[0].path, claudePath);
    assert.equal(agents[0].installed, true);
    assert.equal(agents[0].available, true);
    assert.equal(agents[0].authenticated, true);
    assert.equal(agents[0].authSource, "env");
  } finally {
    restore();
  }
});

test("resolve-cli probes Windows cmd paths with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty codex resolve "));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, "codex.cmd");
  fs.writeFileSync(
    codexPath,
    "@echo off\r\necho codex-cli 1.2.3\r\n",
    "utf8",
  );

  const { bridge, restore } = loadBridgeWithMocks({
    prepareCommandForSpawn,
    resolveCliFromPath: (command) => (command === "codex" ? codexPath : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveHandler = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    assert.equal(typeof resolveHandler, "function");

    const result = await resolveHandler({ sender: { id: 1 } }, { command: "codex", customPath: "" });

    assert.deepEqual(result, {
      path: codexPath,
      binPath: codexPath,
      version: "codex-cli 1.2.3",
      available: true,
      installed: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli probes Windows Claude cmd paths with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty claude resolve "));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const claudePath = path.join(tempDir, "claude.cmd");
  fs.writeFileSync(
    claudePath,
    "@echo off\r\necho 2.1.123 (Claude Code)\r\n",
    "utf8",
  );

  const { bridge, restore } = loadBridgeWithMocks({
    prepareCommandForSpawn,
    resolveCliFromPath: (command) => (command === "claude" ? claudePath : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveHandler = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    assert.equal(typeof resolveHandler, "function");

    const result = await resolveHandler({ sender: { id: 1 } }, { command: "claude", customPath: "" });

    assert.deepEqual(result, {
      path: claudePath,
      binPath: claudePath,
      version: "2.1.123 (Claude Code)",
      available: true,
      installed: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli probes Windows Claude exe paths with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty claude exe resolve "));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const claudePath = path.join(tempDir, "claude.exe");
  fs.copyFileSync(process.execPath, claudePath);

  const { bridge, restore } = loadBridgeWithMocks({
    prepareCommandForSpawn,
    resolveCliFromPath: (command) => (command === "claude" ? claudePath : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveHandler = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    assert.equal(typeof resolveHandler, "function");

    const result = await resolveHandler({ sender: { id: 1 } }, { command: "claude", customPath: "" });

    assert.deepEqual(result, {
      path: claudePath,
      binPath: claudePath,
      version: process.version,
      available: true,
      installed: true,
    });
  } finally {
    restore();
  }
});
