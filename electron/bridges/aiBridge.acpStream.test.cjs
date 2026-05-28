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


test("does not discover Claude without a system Claude CLI", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: (value) => String(value || "").trim().length > 0,
    resolveClaudeAcpBinaryPath: () => {
      throw new Error("Claude ACP resolver should not be used for discovery");
    },
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

test("does not discover Claude when the PATH Claude shim is broken", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-broken-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const claudePath = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFakeBrokenClaudeCli(claudePath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCliFromPath: (command) => (command === "claude" ? claudePath : null),
    resolveClaudeAcpBinaryPath: () => {
      throw new Error("Claude ACP resolver should not be used for discovery");
    },
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

test("resolve-cli detects PATH Claude and reads its version", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-resolve-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const claudePath = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFakeClaudeVersion(claudePath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: (value) => String(value || "").includes("Claude Code"),
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
      version: "2.1.145 (Claude Code)",
      available: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli rejects stored Claude adapter script paths", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-acp-stored-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const scriptPath = path.join(tempDir, "index.js");
  fs.writeFileSync(scriptPath, "process.exit(0);\n", "utf8");

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: (value) => String(value || "").trim().length > 0,
    normalizeCliPathForPlatform: () => scriptPath,
    resolveClaudeAcpBinaryPath: () => {
      throw new Error("Claude ACP resolver should not be used for path resolution");
    },
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

    const result = await resolveHandler({ sender: { id: 1 } }, { command: "claude", customPath: scriptPath });

    assert.deepEqual(result, {
      path: scriptPath,
      version: null,
      available: false,
    });
  } finally {
    restore();
  }
});

test("resolve-cli rejects broken PATH Claude shims", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-resolve-broken-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const claudePath = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFakeBrokenClaudeCli(claudePath);

  const { bridge, restore } = loadBridgeWithMocks({
    isPlausibleCliVersionOutput: () => false,
    resolveCliFromPath: (command) => (command === "claude" ? claudePath : null),
    resolveClaudeAcpBinaryPath: () => {
      throw new Error("Claude ACP resolver should not be used for path resolution");
    },
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
      version: null,
      available: false,
    });
  } finally {
    restore();
  }
});

test("ACP stream passes the configured system Claude executable to claude-agent-acp", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-executable-env-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const scriptPath = path.join(tempDir, "index.js");
  fs.writeFileSync(scriptPath, "process.exit(0);\n", "utf8");

  const { bridge, providerCreationArgs, restore } = loadBridgeWithMocks({
    resolveClaudeAcpBinaryPath: () => ({
      command: process.execPath,
      prependArgs: [scriptPath],
    }),
    createACPProvider: () => ({
      tools: {},
      languageModel() {
        return { id: "fake-model" };
      },
      async initSession() {},
      getSessionId() {
        return "claude-session";
      },
      cleanup() {},
    }),
    streamText: () => createEmptyStreamResult(),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const streamHandler = ipcMain.handlers.get("netcatty:ai:acp:stream");
    assert.equal(typeof streamHandler, "function");

    await streamHandler({ sender: { id: 1 } }, {
      requestId: "req-claude-env",
      chatSessionId: "chat-claude-env",
      acpCommand: "claude-agent-acp",
      acpArgs: [],
      prompt: "hello",
      providerId: undefined,
      model: undefined,
      existingSessionId: undefined,
      historyMessages: [],
      images: undefined,
      toolIntegrationMode: "mcp",
      defaultTargetSession: undefined,
      userSkillsContext: undefined,
      agentEnv: { CLAUDE_CODE_EXECUTABLE: "/opt/homebrew/bin/claude" },
    });

    assert.equal(
      providerCreationArgs[0].env.CLAUDE_CODE_EXECUTABLE,
      "/opt/homebrew/bin/claude",
    );
  } finally {
    restore();
  }
});

test("ACP stream rewrites Windows Claude cmd shim env before creating claude-agent-acp", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-cmd-env-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const acpScriptPath = path.join(tempDir, "acp-index.js");
  fs.writeFileSync(acpScriptPath, "process.exit(0);\n", "utf8");

  const cmdPath = "D:\\ProgramData\\develop-cache\\node-global\\claude.cmd";
  const cliPath = "D:\\ProgramData\\develop-cache\\node-global\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const { bridge, providerCreationArgs, restore } = loadBridgeWithMocks({
    resolveClaudeAcpBinaryPath: () => ({
      command: process.execPath,
      prependArgs: [acpScriptPath],
    }),
    normalizeClaudeCodeExecutableEnvForAcp: (env) => ({
      ...env,
      CLAUDE_CODE_EXECUTABLE: env.CLAUDE_CODE_EXECUTABLE === cmdPath
        ? cliPath
        : env.CLAUDE_CODE_EXECUTABLE,
    }),
    createACPProvider: () => ({
      tools: {},
      languageModel() {
        return { id: "fake-model" };
      },
      async initSession() {},
      getSessionId() {
        return "claude-session";
      },
      cleanup() {},
    }),
    streamText: () => createEmptyStreamResult(),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const streamHandler = ipcMain.handlers.get("netcatty:ai:acp:stream");
    assert.equal(typeof streamHandler, "function");

    await streamHandler({ sender: { id: 1 } }, {
      requestId: "req-claude-cmd-env",
      chatSessionId: "chat-claude-cmd-env",
      acpCommand: "claude-agent-acp",
      acpArgs: [],
      prompt: "hello",
      historyMessages: [],
      toolIntegrationMode: "mcp",
      agentEnv: { CLAUDE_CODE_EXECUTABLE: cmdPath },
    });

    assert.equal(
      providerCreationArgs[0].env.CLAUDE_CODE_EXECUTABLE,
      cliPath,
    );
  } finally {
    restore();
  }
});

test("replays fallback history only after creating a fresh ACP session when the recovered turn fails", async () => {
  const { bridge, streamCalls, providerCreationArgs, restore } = loadBridgeWithMocks();
  const ipcMain = createIpcMainStub();
  const originalConsoleError = console.error;

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  const streamHandler = ipcMain.handlers.get("netcatty:ai:acp:stream");
  assert.equal(typeof streamHandler, "function");

  const historyMessages = [{ role: "user", content: "prior recovered context" }];
  const event = { sender: { id: 1 } };

  try {
    console.error = (...args) => {
      const message = args.map((part) => String(part ?? "")).join(" ");
      if (message.includes("transport failed before replayed turn completed")) {
        return;
      }
      originalConsoleError(...args);
    };

    await streamHandler(event, {
      requestId: "req-1",
      chatSessionId: "chat-1",
      acpCommand: "fake-acp",
      acpArgs: [],
      prompt: "first recovered turn",
      providerId: undefined,
      model: undefined,
      existingSessionId: "stale-session",
      historyMessages,
      images: undefined,
      toolIntegrationMode: "mcp",
      defaultTargetSession: undefined,
      userSkillsContext: undefined,
    });

    await streamHandler(event, {
      requestId: "req-2",
      chatSessionId: "chat-1",
      acpCommand: "fake-acp",
      acpArgs: [],
      prompt: "retry after transport failure",
      providerId: undefined,
      model: undefined,
      existingSessionId: "fresh-session",
      historyMessages,
      images: undefined,
      toolIntegrationMode: "mcp",
      defaultTargetSession: undefined,
      userSkillsContext: undefined,
    });
  } finally {
    console.error = originalConsoleError;
    restore();
  }

  assert.equal(streamCalls.length, 2);
  assert.deepEqual(streamCalls[0][0], historyMessages[0]);
  assert.deepEqual(streamCalls[1][0], historyMessages[0]);
  assert.equal(providerCreationArgs.length, 3);
  assert.equal("existingSessionId" in providerCreationArgs[0], true);
  assert.equal(providerCreationArgs[0].existingSessionId, "stale-session");
  assert.equal("existingSessionId" in providerCreationArgs[1], false);
  assert.equal("existingSessionId" in providerCreationArgs[2], false);
});

