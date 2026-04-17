const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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
      getPermissionMode: () => "default",
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
      normalizeCliPathForPlatform: (value) => value,
      shouldUseShellForCommand: () => false,
      resolveCliFromPath: () => null,
      resolveClaudeAcpBinaryPath: () => null,
      getShellEnv: async () => ({}),
      invalidateShellEnvCache() {},
      serializeStreamChunk: (chunk) => chunk,
      toUnpackedAsarPath: (value) => value,
    },
    "./ai/codexHelpers.cjs": {
      codexLoginSessions: new Map(),
      resolveCodexAcpBinaryPath: () => null,
      appendCodexLoginOutput() {},
      toCodexLoginSessionResponse: () => ({}),
      getActiveCodexLoginSession: () => null,
      normalizeCodexIntegrationState: () => ({}),
      readCodexCustomProviderConfig: () => null,
      getCodexAuthOverride: () => ({}),
      getCodexCustomConfigPreflightError: () => null,
      extractCodexError: (err) => ({ message: err?.message || String(err) }),
      isCodexAuthError: () => false,
      getCodexAuthFingerprint: () => "auth-fingerprint",
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
      streamText({ messages }) {
        streamCalls.push(messages);
        if (typeof options.streamText === "function") {
          return options.streamText({ messages, streamCalls });
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

test("keeps replay fallback enabled after an empty recovered turn by retrying in a fresh ACP session", async () => {
  const { bridge, streamCalls, providerCreationArgs, restore } = loadBridgeWithMocks({
    streamText() {
      return createEmptyStreamResult();
    },
  });
  const ipcMain = createIpcMainStub();

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
      prompt: "retry after empty response",
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
