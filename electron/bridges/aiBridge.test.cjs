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

test("preserves recovered ACP session when user cancels then immediately sends the next prompt", async () => {
  // Regression: after a user-cancel of a recovered turn, the existingRun
  // path in the next stream handler used to call cleanupAcpProvider
  // unconditionally — destroying the fresh ACP session the cancel IPC
  // had just promised to preserve. Combined with historyReplayFallback
  // still being true at that moment, the follow-up turn then recreated
  // a bare new provider via shouldResetProviderForHistoryReplay and
  // the user lost all recovered conversation context.
  //
  // With the fix: (a) the cancel IPC synchronously clears the replay
  // flag on the preserved provider, and (b) the existingRun path skips
  // cleanupAcpProvider when the prior run was already cancelled via
  // the cancel IPC. The next stream then reuses the recovered session
  // and sends only the latest prompt.

  let releaseRead;
  const readReleased = new Promise((resolve) => {
    releaseRead = resolve;
  });

  const { bridge, streamCalls, providerCreationArgs, restore } = loadBridgeWithMocks({
    streamText({ streamCalls: callsRef }) {
      // Turn 1: block in read() so the test can fire cancel, then
      // immediately fire the next stream request while the aborted
      // stream is still unwinding.
      if (callsRef.length === 1) {
        return {
          fullStream: {
            getReader: () => ({
              async read() {
                await readReleased;
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

  const historyMessages = [{ role: "user", content: "prior recovered context" }];
  const event = { sender: { id: 1 } };

  try {
    // Turn 1 starts and blocks in read().
    const firstTurn = streamHandler(event, {
      requestId: "req-cancel-1",
      chatSessionId: "chat-race",
      acpCommand: "fake-acp",
      acpArgs: [],
      prompt: "first turn",
      providerId: undefined,
      model: undefined,
      existingSessionId: "stale-session",
      historyMessages,
      images: undefined,
      toolIntegrationMode: "mcp",
      defaultTargetSession: undefined,
      userSkillsContext: undefined,
    });

    // Yield so the handler reaches the streamText/read phase.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // User clicks Stop.
    await cancelHandler(event, {
      requestId: "req-cancel-1",
      chatSessionId: "chat-race",
    });

    // User immediately sends the next prompt BEFORE releasing the read
    // — i.e. before the first stream handler's post-stream code can
    // run. This is the exact timing window codex flagged.
    const secondTurn = streamHandler(event, {
      requestId: "req-cancel-2",
      chatSessionId: "chat-race",
      acpCommand: "fake-acp",
      acpArgs: [],
      prompt: "immediate follow-up",
      providerId: undefined,
      model: undefined,
      existingSessionId: "fresh-session",
      historyMessages,
      images: undefined,
      toolIntegrationMode: "mcp",
      defaultTargetSession: undefined,
      userSkillsContext: undefined,
    });

    // Let the first turn unwind now.
    releaseRead();
    await firstTurn;
    await secondTurn;
  } finally {
    restore();
  }

  // 2 provider creations: the stale attempt + fallback recovery.
  // If the regression is back, there would be a 3rd creation (the
  // existingRun cleanup + reset-for-replay path discarding the
  // recovered session).
  assert.equal(
    providerCreationArgs.length,
    2,
    "expected recovered fresh session to be preserved across cancel+immediate-send",
  );

  // Second turn must NOT re-replay compact history — the preserved
  // session already has that context.
  assert.equal(
    streamCalls[1].length,
    1,
    "follow-up after cancel must not re-replay compact history",
  );
});

test("preserves history-replay across provider recreation caused by permission-mode / MCP / auth change", async () => {
  // Regression: after a stale-session recovery left historyReplayFallback=true
  // (e.g. the recovered turn returned empty), an orthogonal change that
  // flips shouldReuseProvider to false (permission mode, MCP scope, auth
  // fingerprint) used to recreate the provider with historyReplayFallback:
  // false. The next turn then sent only the latest prompt and dropped the
  // recovered conversation context. We now preserve the flag on any
  // recreation where a history-replay is still pending.

  // Use permission mode as the orthogonal change — auth fingerprint would
  // drag in Codex-specific auth validation we can't stub cleanly.
  let permissionMode = "default";
  function createStreamResult(chunks) {
    let idx = 0;
    return {
      fullStream: {
        getReader: () => ({
          async read() {
            if (idx < chunks.length) {
              return { done: false, value: chunks[idx++] };
            }
            return { done: true, value: undefined };
          },
          releaseLock() {},
        }),
      },
    };
  }

  const { bridge, streamCalls, providerCreationArgs, restore } = loadBridgeWithMocks({
    getPermissionMode: () => permissionMode,
    streamText({ streamCalls: callsRef }) {
      // Turn 1: empty stream — the recovered turn returned no content, so
      // the empty-non-aborted branch keeps historyReplayFallback=true.
      if (callsRef.length === 1) return createEmptyStreamResult();
      // Turn 2: content streams — confirms the replay actually reached
      // the recreated provider.
      return createStreamResult([{ type: "text-delta", text: "ok" }]);
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
  const historyMessages = [{ role: "user", content: "prior recovered context" }];
  const event = { sender: { id: 1 } };

  try {
    // Turn 1: stale-session recovery + empty response (flag stays set).
    await streamHandler(event, {
      requestId: "req-1",
      chatSessionId: "chat-preserve",
      acpCommand: "fake-acp",
      acpArgs: [],
      prompt: "first turn",
      providerId: undefined,
      model: undefined,
      existingSessionId: "stale-session",
      historyMessages,
      images: undefined,
      toolIntegrationMode: "mcp",
      defaultTargetSession: undefined,
      userSkillsContext: undefined,
    });

    // Simulate the user toggling the MCP permission mode between turns.
    // This flips shouldReuseProvider to false and forces recreation via
    // the non-reset branch — exactly where the preserve-flag gap lived.
    permissionMode = "auto";

    await streamHandler(event, {
      requestId: "req-2",
      chatSessionId: "chat-preserve",
      acpCommand: "fake-acp",
      acpArgs: [],
      prompt: "second turn after permission change",
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
  // Turn 2 must include history + latest; regression would make it just 1.
  assert.equal(
    streamCalls[1].length,
    2,
    "second turn must re-replay compact history onto the recreated provider",
  );
  assert.deepEqual(streamCalls[1][0], historyMessages[0]);

  // 3 provider creations: stale attempt + first fallback + permission-change recreation.
  assert.equal(providerCreationArgs.length, 3);
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
