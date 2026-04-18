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

test("clears replay fallback after a user-cancelled recovered turn so the fresh ACP session is preserved", async () => {
  // Regression: if the user stops the first turn after stale-session
  // recovery, historyReplayFallback must still be cleared. Otherwise the
  // next turn triggers shouldResetProviderForHistoryReplay, which discards
  // the freshly recovered ACP session (resumeSessionId is forced to
  // undefined in that path) and re-spends tokens on another compact
  // replay. That would break the cancel-preserves-session contract.

  // Gate that the test releases AFTER cancel has been dispatched, so the
  // bridge's reader loop wakes up to find signal.aborted=true.
  let releaseRead;
  const readReleased = new Promise((resolve) => {
    releaseRead = resolve;
  });

  const { bridge, streamCalls, providerCreationArgs, restore } = loadBridgeWithMocks({
    streamText({ streamCalls: callsRef }) {
      // First call (the recovered turn) — block in read() so the test can
      // fire cancel before any chunk arrives, simulating "user clicks Stop
      // before the agent emits content". Second call (follow-up) — return
      // an immediately-done empty stream.
      if (callsRef.length === 1) {
        return {
          fullStream: {
            getReader: () => ({
              async read() {
                await readReleased;
                // After cancel, signal.aborted is true; return done so the
                // loop exits cleanly. Never produced a content chunk →
                // hasContent stays false, aborted is true → we hit the
                // else-branch where the fix lives.
                return { done: true, value: undefined };
              },
              releaseLock() {},
            }),
          },
        };
      }
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
  const cancelHandler = ipcMain.handlers.get("netcatty:ai:acp:cancel");
  assert.equal(typeof streamHandler, "function");
  assert.equal(typeof cancelHandler, "function");

  const historyMessages = [{ role: "user", content: "prior recovered context" }];
  const event = { sender: { id: 1 } };

  try {
    // Kick off the first turn; it will block at reader.read().
    const firstTurn = streamHandler(event, {
      requestId: "req-cancel-1",
      chatSessionId: "chat-cancel",
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

    // Yield enough microtasks so the handler reaches the streamText/read
    // path before we cancel.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // Fire cancel — this calls controller.abort() inside the bridge.
    await cancelHandler(event, {
      requestId: "req-cancel-1",
      chatSessionId: "chat-cancel",
    });

    // Now release the blocked read so the loop wakes, sees aborted, and
    // exits. The else-branch should clear historyReplayFallback.
    releaseRead();
    await firstTurn;

    // Second turn — should reuse the recovered fresh-session and send
    // only the latest prompt (no compact replay).
    await streamHandler(event, {
      requestId: "req-cancel-2",
      chatSessionId: "chat-cancel",
      acpCommand: "fake-acp",
      acpArgs: [],
      prompt: "follow-up after cancel",
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

  // Two streamText calls: the cancelled one + the follow-up.
  assert.equal(streamCalls.length, 2);

  // Provider creation count: 1 stale attempt + 1 fallback recovery = 2.
  // If the bug regresses, the follow-up turn would force a 3rd creation
  // (shouldResetProviderForHistoryReplay → cleanupAcpProvider → recreate
  // without existingSessionId).
  assert.equal(
    providerCreationArgs.length,
    2,
    "expected the recovered fresh session to be preserved across user cancel",
  );

  // Follow-up turn should send only the latest prompt — the recovered
  // session has the prior context; replaying compact history again would
  // waste tokens and visually feel like the conversation forgot itself.
  assert.equal(
    streamCalls[1].length,
    1,
    "follow-up after cancel must not re-replay compact history",
  );
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
