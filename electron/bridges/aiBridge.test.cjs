const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { prepareCommandForSpawn } = require("./ai/shellUtils.cjs");
const {
  isCodexAuthError: realIsCodexAuthError,
  normalizeCodexIntegrationState: realNormalizeCodexIntegrationState,
} = require("./ai/codexHelpers.cjs");

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
      setVaultAgentInvoker() {},
      getOrCreateHost: async () => 4010,
      getScopedSessionIds: () => [],
      buildMcpServerConfig: () => ({ name: "netcatty-remote-hosts", type: "http", url: "http://127.0.0.1:4010" }),
      getPermissionMode: () =>
        typeof options.getPermissionMode === "function"
          ? options.getPermissionMode()
          : "default",
      getMaxIterations: () => 20,
      setCommandTimeout: (...args) => {
        if (typeof options.setCommandTimeout === "function") options.setCommandTimeout(...args);
      },
      updateAttachmentMetadata: (...args) => {
        if (typeof options.updateAttachmentMetadata === "function") options.updateAttachmentMetadata(...args);
      },
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
      resolveCliFromPathAsync: async (...args) =>
        typeof options.resolveCliFromPathAsync === "function"
          ? options.resolveCliFromPathAsync(...args)
          : typeof options.resolveCliFromPath === "function"
            ? options.resolveCliFromPath(...args)
            : null,
      resolveSdkBinPath: (...args) =>
        typeof options.resolveSdkBinPath === "function"
          ? options.resolveSdkBinPath(...args)
          : null,
      resolveSdkBinPathAsync: async (...args) =>
        typeof options.resolveSdkBinPathAsync === "function"
          ? options.resolveSdkBinPathAsync(...args)
          : typeof options.resolveSdkBinPath === "function"
            ? options.resolveSdkBinPath(...args)
            : null,
      getShellEnv: async () => (
        typeof options.shellEnv === "function"
          ? options.shellEnv()
          : options.shellEnv || {}
      ),
      invalidateShellEnvCache: () => {
        if (typeof options.invalidateShellEnvCache === "function") options.invalidateShellEnvCache();
      },
      toUnpackedAsarPath: (value) => value,
    },
    "./ai/codexHelpers.cjs": {
      codexLoginSessions: new Map(),
      appendCodexLoginOutput() {},
      toCodexLoginSessionResponse: (session) => ({ sessionId: session.id, codexPath: session.codexPath }),
      getActiveCodexLoginSession: () =>
        typeof options.getActiveCodexLoginSession === "function"
          ? options.getActiveCodexLoginSession()
          : null,
      normalizeCodexIntegrationState: (...args) =>
        typeof options.normalizeCodexIntegrationState === "function"
          ? options.normalizeCodexIntegrationState(...args)
          : realNormalizeCodexIntegrationState(...args),
      appendCodexChatGptValidationFailure: (rawOutput, validationError) =>
        `${rawOutput}\n\nChatGPT auth validation failed:\n${validationError}`.trim(),
      readCodexCustomProviderConfig: () => null,
      getCodexCustomConfigPreflightError: () => null,
      extractCodexError: (err) => ({ message: err?.message || String(err) }),
      isCodexAuthError: (...args) =>
        typeof options.isCodexAuthError === "function"
          ? options.isCodexAuthError(...args)
          : realIsCodexAuthError(...args),
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

test("mcp attachment update handler forwards current chat attachments", async () => {
  const calls = [];
  const { bridge, restore } = loadBridgeWithMocks({
    updateAttachmentMetadata: (attachments, chatSessionId) => calls.push({ attachments, chatSessionId }),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const updateAttachments = ipcMain.handlers.get("netcatty:ai:mcp:update-attachments");
    assert.equal(typeof updateAttachments, "function");
    const attachments = [{
      filename: "hosts_export_2026-06-25.csv",
      mediaType: "text/csv",
      base64Data: Buffer.from("label,hostname\nprod,prod.example.com\n").toString("base64"),
      filePath: "/tmp/hosts_export_2026-06-25.csv",
    }];

    const result = await updateAttachments({ sender: { id: 1 } }, {
      attachments,
      chatSessionId: "chat-1",
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [{ attachments, chatSessionId: "chat-1" }]);
  } finally {
    restore();
  }
});

test("command timeout handler accepts one-day timeout values", async () => {
  const calls = [];
  const { bridge, restore } = loadBridgeWithMocks({
    setCommandTimeout: (value) => calls.push(value),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const setCommandTimeout = ipcMain.handlers.get("netcatty:ai:mcp:set-command-timeout");
    assert.equal(typeof setCommandTimeout, "function");

    const result = await setCommandTimeout({ sender: { id: 1 } }, { timeout: 86_400 });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [86_400]);
  } finally {
    restore();
  }
});

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
    const claude = agents.find((agent) => agent.command === "claude");
    assert.ok(claude);
    assert.equal(claude.sdkBackend, "claude");
    assert.equal(claude.binPath, claudePath);
    assert.equal(claude.path, claudePath);
    assert.equal(claude.installed, true);
    assert.equal(claude.available, true);
    assert.equal(claude.authenticated, true);
    assert.equal(claude.authSource, "env");
  } finally {
    restore();
  }
});

test("resolve-cli does not fall back to PATH when a custom path is invalid", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: () => null,
    resolveCliFromPath: (command) => (command === "codex" ? "/usr/local/bin/codex" : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, {
      command: "codex",
      customPath: "/missing/codex",
      refreshShellEnv: true,
    });

    assert.equal(result.path, null);
    assert.equal(result.available, false);
    assert.equal(result.installed, false);
  } finally {
    restore();
  }
});

test("codex login does not reuse an active session from a different resolved path", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPathAsync: (command) => (command === "codex" ? "/usr/bin/codex" : null),
    getActiveCodexLoginSession: () => ({
      id: "codex_login_custom",
      state: "running",
      process: { killed: false },
      codexPath: "/custom/codex",
    }),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const startLogin = ipcMain.handlers.get("netcatty:ai:codex:start-login");
    const result = await startLogin({ sender: { id: 1 } }, {});

    assert.equal(result.ok, false);
    assert.match(result.error, /different CLI path/);
  } finally {
    restore();
  }
});

test("codex integration keeps ChatGPT connected when the SDK validation probe fails", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-integration-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, "codex");
  fs.writeFileSync(
    codexPath,
    `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`,
    { mode: 0o755 },
  );

  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: (value) => value,
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const handler = ipcMain.handlers.get("netcatty:ai:codex:get-integration");
    assert.equal(typeof handler, "function");

    const result = await handler({ sender: { id: 1 } }, {
      codexPath,
      validateChatGptAuth: true,
    });

    assert.equal(result.state, "connected_chatgpt", JSON.stringify(result));
    assert.equal(result.isConnected, true);
    assert.match(result.rawOutput, /Logged in using ChatGPT/);
    assert.match(result.rawOutput, /ChatGPT auth validation failed:/);
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

test("resolve-cli reports Cursor SDK installed but unavailable without an API key", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, { command: "cursor", customPath: "" });
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: false,
      installed: true,
      authenticated: false,
      authSource: null,
    });
  } finally {
    restore();
  }
});

test("resolve-cli separates Cursor SDK installation from API key availability", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: () => "/Applications/Cursor.app/Contents/MacOS/Cursor",
    resolveCliFromPath: () => null,
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
    );
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: false,
      installed: true,
      authenticated: false,
      authSource: null,
    });
  } finally {
    restore();
  }
});

test("resolve-cli ignores custom Cursor paths and stores the SDK sentinel path", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: () => "/tmp/not-cursor",
    resolveCliFromPath: () => null,
    shellEnv: { CURSOR_API_KEY: "cur-key" },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "/tmp/not-cursor" },
    );
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: true,
      installed: true,
      authenticated: true,
      authSource: "CURSOR_API_KEY",
    });
  } finally {
    restore();
  }
});

test("resolve-cli exposes Cursor SDK support when installed and authenticated", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    shellEnv: { CURSOR_API_KEY: "cur-key" },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, { command: "cursor", customPath: "" });
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: true,
      installed: true,
      authenticated: true,
      authSource: "CURSOR_API_KEY",
    });
  } finally {
    restore();
  }
});

test("resolve-cli exposes Cursor SDK support when API key is saved in settings", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => "/usr/local/bin/cursor",
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "", apiKeyPresent: true },
    );
    assert.deepEqual(result, {
      path: "/usr/local/bin/cursor",
      binPath: "/usr/local/bin/cursor",
      version: "Cursor SDK",
      available: true,
      installed: true,
      authenticated: true,
      authSource: "settings",
    });
  } finally {
    restore();
  }
});

test("resolve-cli reports settings as Cursor auth source when settings and env keys both exist", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => "/usr/local/bin/cursor",
    shellEnv: { CURSOR_API_KEY: "env-key" },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "", apiKeyPresent: true },
    );

    assert.equal(result.available, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.authSource, "settings");
  } finally {
    restore();
  }
});

test("resolve-cli can refresh shell env before resolving Cursor", async () => {
  let refreshed = false;
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    shellEnv: { CURSOR_API_KEY: "cur-key" },
    invalidateShellEnvCache: () => { refreshed = true; },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "", refreshShellEnv: true },
    );

    assert.equal(refreshed, true);
    assert.equal(result.available, true);
  } finally {
    restore();
  }
});

test("discover exposes Cursor SDK support when API key is saved in settings", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const discover = ipcMain.handlers.get("netcatty:ai:agents:discover");
    const agents = await discover({ sender: { id: 1 } }, { apiKeyPresent: true });
    const cursor = agents.find((agent) => agent.command === "cursor");

    assert.equal(cursor?.path, "cursor");
    assert.equal(cursor?.available, true);
    assert.equal(cursor?.authenticated, true);
    assert.equal(cursor?.authSource, "settings");
  } finally {
    restore();
  }
});

test("discover can refresh shell env before scanning Cursor", async () => {
  let refreshed = false;
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    shellEnv: () => (refreshed ? { CURSOR_API_KEY: "cur-key" } : {}),
    invalidateShellEnvCache: () => { refreshed = true; },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const discover = ipcMain.handlers.get("netcatty:ai:agents:discover");
    const agents = await discover({ sender: { id: 1 } }, { refreshShellEnv: true });
    const cursor = agents.find((agent) => agent.command === "cursor");

    assert.equal(refreshed, true);
    assert.equal(cursor?.path, "cursor");
    assert.equal(cursor?.available, true);
  } finally {
    restore();
  }
});
