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

function createEmptyStreamResult() {
  return {
    fullStream: {
      getReader() {
        return {
          async read() {
            return { done: true, value: undefined };
          },
          releaseLock() {},
        };
      },
    },
  };
}

function writeFakeCodexAcpUsage(filePath) {
  if (process.platform === "win32") {
    fs.writeFileSync(
      filePath,
      "@echo off\r\necho error: unexpected argument '--version' found\r\necho.\r\necho Usage: codex-acp [OPTIONS]\r\nexit /b 2\r\n",
      "utf8",
    );
    return;
  }
  fs.writeFileSync(
    filePath,
    "#!/bin/sh\necho \"error: unexpected argument '--version' found\"\necho\necho 'Usage: codex-acp [OPTIONS]'\nexit 2\n",
    "utf8",
  );
  fs.chmodSync(filePath, 0o755);
}

function writeFakeCodexAcpLoaderError(filePath) {
  if (process.platform === "win32") {
    fs.writeFileSync(
      filePath,
      "@echo off\r\necho codex-acp: error while loading shared libraries: libssl.so: cannot open shared object file\r\nexit /b 127\r\n",
      "utf8",
    );
    return;
  }
  fs.writeFileSync(
    filePath,
    "#!/bin/sh\necho 'codex-acp: error while loading shared libraries: libssl.so: cannot open shared object file'\nexit 127\n",
    "utf8",
  );
  fs.chmodSync(filePath, 0o755);
}

function writeFakeBrokenClaudeCli(filePath) {
  if (process.platform === "win32") {
    fs.writeFileSync(
      filePath,
      "@echo off\r\necho file:///opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:95\r\nexit /b 1\r\n",
      "utf8",
    );
    return;
  }
  fs.writeFileSync(
    filePath,
    "#!/bin/sh\necho 'file:///opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:95'\nexit 1\n",
    "utf8",
  );
  fs.chmodSync(filePath, 0o755);
}

function writeFakeClaudeVersion(filePath, version = "2.1.145 (Claude Code)") {
  if (process.platform === "win32") {
    fs.writeFileSync(filePath, `@echo off\r\necho ${version}\r\n`, "utf8");
    return;
  }
  fs.writeFileSync(filePath, `#!/bin/sh\necho '${version}'\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function loadBridgeWithMocks(options = {}) {
  const streamCalls = [];
  const safeSendCalls = [];
  let providerCreationCount = 0;
  const providerCreationArgs = [];

  const fallbackProvider = {
    tools: {},
    languageModel() {
      return { id: "fake-model" };
    },
    async initSession() {},
    getSessionId() {
      return "fresh-session";
    },
    cleanup() {},
  };

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
      normalizeClaudeCodeExecutableEnvForAcp: (env) =>
        typeof options.normalizeClaudeCodeExecutableEnvForAcp === "function"
          ? options.normalizeClaudeCodeExecutableEnvForAcp(env)
          : env,
      isPlausibleCliVersionOutput: (value) =>
        typeof options.isPlausibleCliVersionOutput === "function"
          ? options.isPlausibleCliVersionOutput(value)
          : true,
      resolveCliFromPath: (...args) =>
        typeof options.resolveCliFromPath === "function"
          ? options.resolveCliFromPath(...args)
          : null,
      resolveClaudeAcpBinaryPath: (...args) =>
        typeof options.resolveClaudeAcpBinaryPath === "function"
          ? options.resolveClaudeAcpBinaryPath(...args)
          : null,
      getShellEnv: async () => ({}),
      invalidateShellEnvCache() {},
      serializeStreamChunk: (chunk) => chunk,
      toUnpackedAsarPath: (value) => value,
    },
    "./ai/codexHelpers.cjs": {
      codexLoginSessions: new Map(),
      resolveCodexAcpBinaryPath: (...args) =>
        typeof options.resolveCodexAcpBinaryPath === "function"
          ? options.resolveCodexAcpBinaryPath(...args)
          : null,
      appendCodexLoginOutput() {},
      toCodexLoginSessionResponse: () => ({}),
      getActiveCodexLoginSession: () => null,
      normalizeCodexIntegrationState: () => ({}),
      readCodexCustomProviderConfig: () => null,
      getCodexAuthOverride: () => ({}),
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
    "./ai/ptyExec.cjs": {
      execViaPty: async () => {
        throw new Error("execViaPty should not be called in this test");
      },
    },
    "./ipcUtils.cjs": {
      safeSend(sender, channel, payload) {
        safeSendCalls.push({ sender, channel, payload });
      },
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
    "@mcpc-tech/acp-ai-provider": {
      createACPProvider(args) {
        providerCreationCount += 1;
        providerCreationArgs.push(args);
        if (typeof options.createACPProvider === "function") {
          return options.createACPProvider({ args, providerCreationCount, fallbackProvider });
        }
        if (providerCreationCount === 1) {
          return {
            tools: {},
            languageModel() {
              return { id: "fake-model" };
            },
            async initSession() {
              throw new Error("Resource not found: session not found");
            },
            getSessionId() {
              return "stale-session";
            },
            cleanup() {},
          };
        }
        return fallbackProvider;
      },
    },
    ai: {
      stepCountIs: () => Symbol("stopWhen"),
      streamText(args) {
        const { messages } = args;
        streamCalls.push(messages);
        if (typeof options.streamText === "function") {
          return options.streamText({ ...args, streamCalls });
        }
        if (streamCalls.length === 1) {
          throw new Error("transport failed before replayed turn completed");
        }
        return createEmptyStreamResult();
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
      streamCalls,
      safeSendCalls,
      providerCreationArgs,
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

test("discovers bundled Codex ACP fallback when --version prints usage", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  writeFakeCodexAcpUsage(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const discoverHandler = ipcMain.handlers.get("netcatty:ai:agents:discover");
    assert.equal(typeof discoverHandler, "function");

    const agents = await discoverHandler({ sender: { id: 1 } });

    assert.equal(agents.length, 1);
    assert.equal(agents[0].command, "codex");
    assert.equal(agents[0].path, codexAcpPath);
    assert.equal(agents[0].version, "Bundled ACP");
    assert.equal(agents[0].available, true);
  } finally {
    restore();
  }
});
test("discovers bundled Codex ACP fallback when PATH Codex shim is broken", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-broken-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  if (process.platform === "win32") {
    fs.writeFileSync(codexPath, "@echo off\r\necho TypeError: Cannot read properties of undefined\r\n", "utf8");
    writeFakeCodexAcpUsage(codexAcpPath);
  } else {
    fs.writeFileSync(codexPath, "#!/bin/sh\necho 'TypeError: Cannot read properties of undefined'\n", "utf8");
    fs.chmodSync(codexPath, 0o755);
    writeFakeCodexAcpUsage(codexAcpPath);
  }

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCliFromPath: (command) => (command === "codex" ? codexPath : null),
    resolveCodexAcpBinaryPath: () => codexAcpPath,
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const discoverHandler = ipcMain.handlers.get("netcatty:ai:agents:discover");
    assert.equal(typeof discoverHandler, "function");

    const agents = await discoverHandler({ sender: { id: 1 } });

    assert.equal(agents.length, 1);
    assert.equal(agents[0].command, "codex");
    assert.equal(agents[0].path, codexAcpPath);
    assert.equal(agents[0].version, "Bundled ACP");
    assert.equal(agents[0].available, true);
  } finally {
    restore();
  }
});

test("discovers bundled Codex ACP fallback when PATH Codex exits nonzero", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-exit-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  if (process.platform === "win32") {
    fs.writeFileSync(codexPath, "@echo off\r\necho codex-cli 1.0.0\r\nexit /b 1\r\n", "utf8");
    writeFakeCodexAcpUsage(codexAcpPath);
  } else {
    fs.writeFileSync(codexPath, "#!/bin/sh\necho 'codex-cli 1.0.0'\nexit 1\n", "utf8");
    fs.chmodSync(codexPath, 0o755);
    writeFakeCodexAcpUsage(codexAcpPath);
  }

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: (value) => String(value).startsWith("codex-cli"),
    resolveCliFromPath: (command) => (command === "codex" ? codexPath : null),
    resolveCodexAcpBinaryPath: () => codexAcpPath,
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const discoverHandler = ipcMain.handlers.get("netcatty:ai:agents:discover");
    assert.equal(typeof discoverHandler, "function");

    const agents = await discoverHandler({ sender: { id: 1 } });

    assert.equal(agents.length, 1);
    assert.equal(agents[0].command, "codex");
    assert.equal(agents[0].path, codexAcpPath);
    assert.equal(agents[0].version, "Bundled ACP");
    assert.equal(agents[0].available, true);
  } finally {
    restore();
  }
});

test("does not discover bundled Codex ACP fallback when the fallback cannot run", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-bad-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  fs.mkdirSync(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const discoverHandler = ipcMain.handlers.get("netcatty:ai:agents:discover");
    assert.equal(typeof discoverHandler, "function");

    const agents = await discoverHandler({ sender: { id: 1 } });

    assert.equal(agents.length, 0);
  } finally {
    restore();
  }
});

test("does not discover bundled Codex ACP fallback when the fallback prints a loader error", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-loader-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  writeFakeCodexAcpLoaderError(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const discoverHandler = ipcMain.handlers.get("netcatty:ai:agents:discover");
    assert.equal(typeof discoverHandler, "function");

    const agents = await discoverHandler({ sender: { id: 1 } });

    assert.equal(agents.length, 0);
  } finally {
    restore();
  }
});

test("resolve-cli accepts bundled Codex ACP fallback when --version prints usage", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-resolve-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  writeFakeCodexAcpUsage(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
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
      path: codexAcpPath,
      version: "Bundled ACP",
      available: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli accepts stored bundled Codex ACP path", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-stored-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  writeFakeCodexAcpUsage(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    normalizeCliPathForPlatform: () => codexAcpPath,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
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

    const result = await resolveHandler(
      { sender: { id: 1 } },
      { command: "codex", customPath: codexAcpPath },
    );

    assert.deepEqual(result, {
      path: codexAcpPath,
      version: "Bundled ACP",
      available: true,
    });
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
      version: "codex-cli 1.2.3",
      available: true,
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
      version: "2.1.123 (Claude Code)",
      available: true,
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
      version: process.version,
      available: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli falls back to bundled Codex ACP when a stored path is stale", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-stale-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  writeFakeCodexAcpUsage(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    normalizeCliPathForPlatform: () => null,
    resolveCliFromPath: () => null,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
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

    const result = await resolveHandler(
      { sender: { id: 1 } },
      { command: "codex", customPath: "/stale/bin/codex" },
    );

    assert.deepEqual(result, {
      path: codexAcpPath,
      version: "Bundled ACP",
      available: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli falls back to bundled Codex ACP when PATH Codex shim is broken", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-resolve-broken-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  if (process.platform === "win32") {
    fs.writeFileSync(codexPath, "@echo off\r\necho TypeError: Cannot read properties of undefined\r\n", "utf8");
    writeFakeCodexAcpUsage(codexAcpPath);
  } else {
    fs.writeFileSync(codexPath, "#!/bin/sh\necho 'TypeError: Cannot read properties of undefined'\n", "utf8");
    fs.chmodSync(codexPath, 0o755);
    writeFakeCodexAcpUsage(codexAcpPath);
  }

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCliFromPath: (command) => (command === "codex" ? codexPath : null),
    resolveCodexAcpBinaryPath: () => codexAcpPath,
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
      path: codexAcpPath,
      version: "Bundled ACP",
      available: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli falls back to bundled Codex ACP when PATH Codex exits nonzero", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-resolve-exit-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, process.platform === "win32" ? "codex.cmd" : "codex");
  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  if (process.platform === "win32") {
    fs.writeFileSync(codexPath, "@echo off\r\necho codex-cli 1.0.0\r\nexit /b 1\r\n", "utf8");
    writeFakeCodexAcpUsage(codexAcpPath);
  } else {
    fs.writeFileSync(codexPath, "#!/bin/sh\necho 'codex-cli 1.0.0'\nexit 1\n", "utf8");
    fs.chmodSync(codexPath, 0o755);
    writeFakeCodexAcpUsage(codexAcpPath);
  }

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: (value) => String(value).startsWith("codex-cli"),
    resolveCliFromPath: (command) => (command === "codex" ? codexPath : null),
    resolveCodexAcpBinaryPath: () => codexAcpPath,
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
      path: codexAcpPath,
      version: "Bundled ACP",
      available: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli rejects bundled Codex ACP fallback when the fallback cannot run", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-resolve-bad-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  fs.mkdirSync(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
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
      path: codexAcpPath,
      version: null,
      available: false,
    });
  } finally {
    restore();
  }
});

test("resolve-cli rejects bundled Codex ACP fallback when the fallback prints a loader error", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-acp-resolve-loader-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexAcpPath = path.join(tempDir, process.platform === "win32" ? "codex-acp.cmd" : "codex-acp");
  writeFakeCodexAcpLoaderError(codexAcpPath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCodexAcpBinaryPath: () => codexAcpPath,
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
      path: codexAcpPath,
      version: null,
      available: false,
    });
  } finally {
    restore();
  }
});
