const test = require("node:test");
const assert = require("node:assert/strict");
const {
  registerSdkStreamHandlers,
  buildSdkTurnPrompt,
  formatSdkHistoryReplaySection,
  buildSdkModelCacheKey,
  getSdkModelCacheEntry,
  setSdkModelCacheEntry,
  buildSdkSessionKey,
  normalizeSdkListModelsResult,
  resolveSdkPromptPlacement,
  resolveSdkResumeSessionId,
  shouldReplaySdkHistory,
  expireSiblingCursorCliModeSessions,
  expireSiblingGrokRuntimeSessions,
  resolveBackendKey,
  resolveSdkBackendBinPath,
  shouldCacheSdkRuntimeModels,
  fetchSdkModelCatalog,
} = require("./sdkStreamHandlers.cjs");

/**
 * Register the real IPC handlers against a stubbed ctx so lifecycle handlers
 * (cleanup) can be invoked directly. registerSdkStreamHandlers exposes its
 * request-scoped maps on ctx for exactly this kind of test.
 */
function registerWithStubbedCtx() {
  const handlers = new Map();
  const ctx = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    electronModule: undefined,
    validateSender: () => true,
    mcpServerBridge: {
      setChatSessionCancelled: () => {},
      cancelPtyExecsForSession: () => {},
      cancelWorkerBackgroundJobsForSession: () => {},
      cleanupScopedMetadata: async () => {},
    },
  };
  registerSdkStreamHandlers(ctx);
  return { handlers, ctx };
}

test("sdk-agent:cleanup aborts and removes request entries for the target chat only", async () => {
  const { handlers, ctx } = registerWithStubbedCtx();

  const targetController = new AbortController();
  const otherController = new AbortController();
  ctx.sdkActiveStreams.set("req-1", targetController);
  ctx.sdkRequestSessions.set("req-1", "chat-1");
  ctx.sdkRequestRuntimes.set("req-1", { backendKey: "codebuddy", codexRuntime: "sdk", binPath: "/bin/cb" });
  ctx.sdkActiveStreams.set("req-2", otherController);
  ctx.sdkRequestSessions.set("req-2", "chat-2");
  ctx.sdkRequestRuntimes.set("req-2", { backendKey: "codex", codexRuntime: "sdk", binPath: "/bin/codex" });

  const cleanup = handlers.get("netcatty:ai:sdk-agent:cleanup");
  assert.equal(typeof cleanup, "function");
  const result = await cleanup({ sender: {} }, { chatSessionId: "chat-1" });
  assert.deepEqual(result, { ok: true });

  // Target chat: controller aborted and every request-scoped entry removed.
  assert.ok(targetController.signal.aborted);
  assert.ok(!ctx.sdkActiveStreams.has("req-1"));
  assert.ok(!ctx.sdkRequestSessions.has("req-1"));
  assert.ok(!ctx.sdkRequestRuntimes.has("req-1"));

  // Other chat: untouched.
  assert.ok(!otherController.signal.aborted);
  assert.equal(ctx.sdkActiveStreams.get("req-2"), otherController);
  assert.equal(ctx.sdkRequestSessions.get("req-2"), "chat-2");
  assert.deepEqual(ctx.sdkRequestRuntimes.get("req-2"), {
    backendKey: "codex",
    codexRuntime: "sdk",
    binPath: "/bin/codex",
  });
});

test("resolveBackendKey maps backend command/value to registry key", () => {
  assert.equal(resolveBackendKey("claude"), "claude");
  assert.equal(resolveBackendKey("codex"), "codex");
  assert.equal(resolveBackendKey("copilot"), "copilot");
  assert.equal(resolveBackendKey("codebuddy"), "codebuddy");
  assert.equal(resolveBackendKey("opencode"), "opencode");
});

test("resolveBackendKey returns null for unknown", () => {
  assert.equal(resolveBackendKey("claude-agent-acp"), null);
  assert.equal(resolveBackendKey(""), null);
  assert.equal(resolveBackendKey(undefined), null);
});

test("SDK session keys include backend and resolved CLI path", () => {
  assert.notEqual(
    buildSdkSessionKey("chat-1", "codex", "/usr/local/bin/codex"),
    buildSdkSessionKey("chat-1", "codex", "/opt/homebrew/bin/codex"),
  );
  assert.notEqual(
    buildSdkSessionKey("chat-1", "codex", "/usr/local/bin/codex"),
    buildSdkSessionKey("chat-1", "claude", "/usr/local/bin/codex"),
  );
});

test("Cursor session keys isolate CLI login from API key auth modes", () => {
  assert.notEqual(
    buildSdkSessionKey("chat-1", "cursor", "/usr/bin/agent", "sdk", "cli-login"),
    buildSdkSessionKey("chat-1", "cursor", "cursor", "sdk", "api-key"),
  );
});

test("SDK model cache keys include resolved CLI path", () => {
  assert.notEqual(
    buildSdkModelCacheKey("claude", "/usr/local/bin/claude"),
    buildSdkModelCacheKey("claude", "/opt/homebrew/bin/claude"),
  );
});

test("SDK model cache keys include catalog-affecting agent environment", () => {
  assert.notEqual(
    buildSdkModelCacheKey("opencode", "/usr/bin/opencode", { HOME: "/Users/a", OPENCODE_CONFIG_DIR: "/a/config" }),
    buildSdkModelCacheKey("opencode", "/usr/bin/opencode", { HOME: "/Users/b", OPENCODE_CONFIG_DIR: "/b/config" }),
  );
  assert.equal(
    buildSdkModelCacheKey("opencode", "/usr/bin/opencode", { HOME: "/Users/a" }),
    buildSdkModelCacheKey("opencode", "/usr/bin/opencode", { HOME: "/Users/a" }),
  );
  assert.doesNotMatch(
    buildSdkModelCacheKey("cursor", "/usr/bin/cursor", { CURSOR_API_KEY: "very-secret-key" }),
    /very-secret-key/,
  );
  assert.notEqual(
    buildSdkModelCacheKey("codex", "/usr/bin/codex", { HOME: "/shared", CODEX_HOME: "/profiles/a" }),
    buildSdkModelCacheKey("codex", "/usr/bin/codex", { HOME: "/shared", CODEX_HOME: "/profiles/b" }),
  );
  assert.notEqual(
    buildSdkModelCacheKey("claude", "/usr/bin/claude", { HOME: "/shared", CLAUDE_CONFIG_DIR: "/profiles/a" }),
    buildSdkModelCacheKey("claude", "/usr/bin/claude", { HOME: "/shared", CLAUDE_CONFIG_DIR: "/profiles/b" }),
  );
});

test("Claude model cache keys separate authentication without exposing values", () => {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const first = buildSdkModelCacheKey("claude", "/usr/bin/claude", { [name]: "secret-one" });
    const second = buildSdkModelCacheKey("claude", "/usr/bin/claude", { [name]: "secret-two" });
    assert.notEqual(first, second, `${name} must separate cache entries`);
    assert.doesNotMatch(first, /secret-one/);
  }
});

test("SDK model cache removes expired entries instead of retaining tombstones", () => {
  const cache = new Map([
    ["expired", { at: 1, currentModelId: null, models: [{ id: "old" }] }],
    ["fresh", { at: 95, currentModelId: null, models: [{ id: "new" }] }],
  ]);

  assert.equal(getSdkModelCacheEntry(cache, "expired", { now: 100, ttlMs: 10, maxEntries: 8 }), null);
  assert.equal(cache.has("expired"), false);
  assert.equal(getSdkModelCacheEntry(cache, "fresh", { now: 100, ttlMs: 10, maxEntries: 8 }).models[0].id, "new");
});

test("SDK model cache evicts the least recently used catalog at its hard limit", () => {
  const cache = new Map();
  setSdkModelCacheEntry(cache, "a", { at: 1, models: [{ id: "a" }] }, { now: 1, ttlMs: 100, maxEntries: 2 });
  setSdkModelCacheEntry(cache, "b", { at: 2, models: [{ id: "b" }] }, { now: 2, ttlMs: 100, maxEntries: 2 });
  assert.ok(getSdkModelCacheEntry(cache, "a", { now: 3, ttlMs: 100, maxEntries: 2 }));
  setSdkModelCacheEntry(cache, "c", { at: 3, models: [{ id: "c" }] }, { now: 3, ttlMs: 100, maxEntries: 2 });

  assert.deepEqual(Array.from(cache.keys()), ["a", "c"]);
});

test("normalizeSdkListModelsResult preserves current model ids from object results", () => {
  assert.deepEqual(normalizeSdkListModelsResult({
    currentModelId: "openai/gpt-5.1",
    models: [{ id: "openai/gpt-5.1" }, null, { name: "missing-id" }],
  }), {
    currentModelId: "openai/gpt-5.1",
    models: [{ id: "openai/gpt-5.1" }],
  });
  assert.deepEqual(normalizeSdkListModelsResult([{ id: "claude-sonnet" }]), {
    currentModelId: null,
    models: [{ id: "claude-sonnet" }],
  });
});

test("fetchSdkModelCatalog falls back to the App Server catalog when codex-sdk returns empty", async () => {
  const appServerCatalog = {
    currentModelId: "gpt-5.6-sol/high",
    models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
  };
  const appServerRuntime = { listModels: async ({ binPath, env }) => ({ calledWith: binPath, profile: env.CODEX_HOME, ...appServerCatalog }) };
  const codexDriver = { listModels: async () => [] };

  // codex sdk runtime: empty catalog triggers the App Server fallback (#3496).
  const codexFallback = await fetchSdkModelCatalog({
    backendKey: "codex",
    codexRuntime: "sdk",
    driver: codexDriver,
    binPath: "/cli/codex",
    env: { CODEX_HOME: "/profiles/b" },
    codexAppServerRuntime: appServerRuntime,
  });
  assert.equal(codexFallback.calledWith, "/cli/codex");
  assert.equal(codexFallback.profile, "/profiles/b");
  assert.deepEqual(normalizeSdkListModelsResult(codexFallback), appServerCatalog);

  // Non-empty sdk catalog or app-server runtime: no fallback round-trip.
  let appServerCalls = 0;
  const countingRuntime = {
    listModels: async () => {
      appServerCalls += 1;
      return appServerCatalog;
    },
  };
  await fetchSdkModelCatalog({
    backendKey: "codex",
    codexRuntime: "sdk",
    driver: { listModels: async () => [{ id: "gpt-5.6-sol" }] },
    binPath: "/cli/codex",
    env: {},
    codexAppServerRuntime: countingRuntime,
  });
  assert.equal(appServerCalls, 0);

  await fetchSdkModelCatalog({
    backendKey: "codex",
    codexRuntime: "app-server",
    driver: codexDriver,
    binPath: "/cli/codex",
    env: {},
    codexAppServerRuntime: countingRuntime,
  });
  assert.equal(appServerCalls, 1);

  // Non-codex backends never touch the App Server runtime.
  let driverCalls = 0;
  await fetchSdkModelCatalog({
    backendKey: "claude",
    codexRuntime: "sdk",
    driver: {
      listModels: async (args) => {
        driverCalls += 1;
        assert.equal(args.cursorAuthMode, undefined);
        return [{ id: "claude-opus-5-5", name: "Opus 5.5" }];
      },
    },
    binPath: "/cli/claude",
    env: {},
    codexAppServerRuntime: countingRuntime,
  });
  assert.equal(driverCalls, 1);
  assert.equal(appServerCalls, 1);
});

test("empty or failed live catalogs surface a failure for the warning path", async () => {
  const base = {
    binPath: "/cli/agent",
    env: {},
    driver: { listModels: async () => [] },
    codexAppServerRuntime: { listModels: async () => [] },
  };
  await assert.rejects(
    fetchSdkModelCatalog({ ...base, backendKey: "claude", codexRuntime: "sdk" }),
    /returned no models/,
  );
  await assert.rejects(
    fetchSdkModelCatalog({ ...base, backendKey: "codex", codexRuntime: "sdk" }),
    /returned no models/,
  );
  await assert.rejects(
    fetchSdkModelCatalog({
      ...base,
      backendKey: "codex",
      codexRuntime: "sdk",
      codexAppServerRuntime: { listModels: async () => { throw new Error("model/list unavailable"); } },
    }),
    /model\/list unavailable/,
  );
});

test("CodeBuddy and OpenCode keep Netcatty context in the system prompt only", () => {
  const input = {
    turnPrompt: "user request",
    contextualPrompt: "netcatty context\n\nuser request",
    systemContext: "netcatty context",
  };
  assert.deepEqual(resolveSdkPromptPlacement({
    ...input,
    backendKey: "codebuddy",
  }), {
    prompt: "user request",
    systemPrompt: "netcatty context",
  });
  assert.deepEqual(resolveSdkPromptPlacement({
    ...input,
    backendKey: "opencode",
  }), {
    prompt: "user request",
    systemPrompt: "netcatty context",
  });
  assert.deepEqual(resolveSdkPromptPlacement({
    ...input,
    backendKey: "claude",
  }), {
    prompt: "netcatty context\n\nuser request",
    systemPrompt: undefined,
  });
});

test("shouldCacheSdkRuntimeModels caches all SDK backends including OpenCode", () => {
  // OpenCode used to skip the cache, which re-spawned opencode servers on every
  // model-catalog probe (#2184). TTL still bounds staleness.
  assert.equal(shouldCacheSdkRuntimeModels("opencode"), true);
  assert.equal(shouldCacheSdkRuntimeModels("claude"), true);
  assert.equal(shouldCacheSdkRuntimeModels("codebuddy"), true);
  assert.equal(shouldCacheSdkRuntimeModels("copilot"), true);
});

test("SDK resume only uses the current backend/path session key", () => {
  const sessions = new Map([
    [buildSdkSessionKey("chat-1", "codex", "/old/codex"), "old-session"],
  ]);

  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: sessions,
      sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/new/codex"),
      backendKey: "codex",
      binPath: "/new/codex",
      hasConfiguredCommand: true,
    }),
    undefined,
  );
  sessions.set(buildSdkSessionKey("chat-1", "codex", "/new/codex"), "new-session");
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: sessions,
      sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/new/codex"),
      backendKey: "codex",
      binPath: "/new/codex",
      hasConfiguredCommand: true,
    }),
    "new-session",
  );
});

test("SDK resume uses persisted session identity only when backend and path match", () => {
  const persisted = `netcatty-sdk-session:${encodeURIComponent(JSON.stringify({
    v: 1,
    id: "persisted-session",
    backend: "codex",
    binPath: "/opt/homebrew/bin/codex",
  }))}`;

  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/opt/homebrew/bin/codex"),
      existingSessionId: persisted,
      backendKey: "codex",
      binPath: "/opt/homebrew/bin/codex",
      hasConfiguredCommand: true,
    }),
    "persisted-session",
  );
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/other/codex"),
      existingSessionId: persisted,
      backendKey: "codex",
      binPath: "/other/codex",
      hasConfiguredCommand: true,
    }),
    undefined,
  );
});

test("Codex sessions never resume across SDK and App Server runtimes", () => {
  const sdkIdentity = `netcatty-sdk-session:${encodeURIComponent(JSON.stringify({
    v: 1,
    id: "sdk-thread",
    backend: "codex",
    binPath: "/usr/bin/codex",
    runtime: "sdk",
  }))}`;
  assert.equal(resolveSdkResumeSessionId({
    sdkSessionIds: new Map(),
    sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/usr/bin/codex", "app-server"),
    existingSessionId: sdkIdentity,
    backendKey: "codex",
    binPath: "/usr/bin/codex",
    runtime: "app-server",
    hasConfiguredCommand: false,
  }), undefined);
  assert.equal(resolveSdkResumeSessionId({
    sdkSessionIds: new Map(),
    sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/usr/bin/codex", "app-server"),
    existingSessionId: "legacy-thread",
    backendKey: "codex",
    binPath: "/usr/bin/codex",
    runtime: "app-server",
    hasConfiguredCommand: false,
  }), undefined);
});

test("SDK resume keeps legacy session ids only when no manual command is configured", () => {
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/usr/bin/codex"),
      existingSessionId: "legacy-session",
      backendKey: "codex",
      binPath: "/usr/bin/codex",
      hasConfiguredCommand: false,
    }),
    "legacy-session",
  );
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "codex", "/manual/codex"),
      existingSessionId: "legacy-session",
      backendKey: "codex",
      binPath: "/manual/codex",
      hasConfiguredCommand: true,
    }),
    undefined,
  );
});

test("Cursor CLI login sessions do not resume on the API key SDK path", () => {
  const cliIdentity = `netcatty-sdk-session:${encodeURIComponent(JSON.stringify({
    v: 1,
    id: "61668441-bfcb-4795-a575-c46d70ad01fe",
    backend: "cursor",
    binPath: "/usr/bin/agent",
    runtime: "sdk",
    authMode: "cli-login",
    cliMode: "agent",
  }))}`;

  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "cursor", "cursor", "sdk", "api-key"),
      existingSessionId: cliIdentity,
      backendKey: "cursor",
      binPath: "cursor",
      runtime: "sdk",
      authMode: "api-key",
      hasConfiguredCommand: false,
    }),
    undefined,
  );
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "cursor", "/usr/bin/agent", "sdk", "cli-login", "agent"),
      existingSessionId: cliIdentity,
      backendKey: "cursor",
      binPath: "/usr/bin/agent",
      runtime: "sdk",
      authMode: "cli-login",
      cliMode: "agent",
      hasConfiguredCommand: false,
    }),
    "61668441-bfcb-4795-a575-c46d70ad01fe",
  );
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "cursor", "/usr/bin/agent", "sdk", "cli-login", "ask"),
      existingSessionId: cliIdentity,
      backendKey: "cursor",
      binPath: "/usr/bin/agent",
      runtime: "sdk",
      authMode: "cli-login",
      cliMode: "ask",
      hasConfiguredCommand: false,
    }),
    undefined,
  );
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: new Map(),
      sdkSessionKey: buildSdkSessionKey("chat-1", "cursor", "cursor", "sdk", "cli-login"),
      existingSessionId: "61668441-bfcb-4795-a575-c46d70ad01fe",
      backendKey: "cursor",
      binPath: "cursor",
      runtime: "sdk",
      authMode: "cli-login",
      hasConfiguredCommand: false,
    }),
    undefined,
  );
});

test("expireSiblingCursorCliModeSessions drops the inactive Cursor CLI mode", () => {
  const askKey = buildSdkSessionKey("chat-1", "cursor", "/bin/cursor-agent", "sdk", "cli-login", "ask");
  const agentKey = buildSdkSessionKey("chat-1", "cursor", "/bin/cursor-agent", "sdk", "cli-login", "agent");
  const otherChatAskKey = buildSdkSessionKey("chat-2", "cursor", "/bin/cursor-agent", "sdk", "cli-login", "ask");
  const sessions = new Map([
    [askKey, "ask-session"],
    [agentKey, "agent-session"],
    [otherChatAskKey, "other-ask"],
  ]);

  // Observer → Confirm: expire Ask so a later switch-back cannot revive it.
  assert.equal(
    expireSiblingCursorCliModeSessions(sessions, {
      chatSessionId: "chat-1",
      backendKey: "cursor",
      binPath: "/bin/cursor-agent",
      runtime: "sdk",
      authMode: "cli-login",
      cliMode: "agent",
    }),
    true,
  );
  assert.equal(sessions.has(askKey), false);
  assert.equal(sessions.get(agentKey), "agent-session");
  assert.equal(sessions.get(otherChatAskKey), "other-ask");

  // Confirm → Observer: expire agent; Ask was already gone, so resume is fresh.
  sessions.set(agentKey, "agent-session-2");
  assert.equal(
    expireSiblingCursorCliModeSessions(sessions, {
      chatSessionId: "chat-1",
      backendKey: "cursor",
      binPath: "/bin/cursor-agent",
      runtime: "sdk",
      authMode: "cli-login",
      cliMode: "ask",
    }),
    true,
  );
  assert.equal(sessions.has(agentKey), false);
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: sessions,
      sdkSessionKey: askKey,
      existingSessionId: `netcatty-sdk-session:${encodeURIComponent(JSON.stringify({
        v: 1,
        id: "agent-session-2",
        backend: "cursor",
        binPath: "/bin/cursor-agent",
        runtime: "sdk",
        authMode: "cli-login",
        cliMode: "agent",
      }))}`,
      backendKey: "cursor",
      binPath: "/bin/cursor-agent",
      runtime: "sdk",
      authMode: "cli-login",
      cliMode: "ask",
      hasConfiguredCommand: false,
    }),
    undefined,
  );
});

test("buildSdkTurnPrompt replays history only when requested", () => {
  const prompt = buildSdkTurnPrompt({
    prompt: "latest question",
    replayHistory: true,
    historyMessages: [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ],
  });

  assert.match(prompt, /Conversation context replay/);
  assert.match(prompt, /USER: previous question/);
  assert.match(prompt, /ASSISTANT: previous answer/);
  assert.match(prompt, /latest question$/);

  const steadyStatePrompt = buildSdkTurnPrompt({
    prompt: "latest question",
    replayHistory: false,
    historyMessages: [{ role: "user", content: "previous question" }],
  });
  assert.equal(steadyStatePrompt, "latest question");
});

test("formatSdkHistoryReplaySection matches buildSdkTurnPrompt history wording", () => {
  const messages = [
    { role: "user", content: "previous question" },
    { role: "assistant", content: "previous answer" },
  ];
  const section = formatSdkHistoryReplaySection(messages);
  assert.match(section, /Conversation context replay/);
  assert.match(section, /USER: previous question/);
  assert.match(section, /ASSISTANT: previous answer/);
  // Same section is embedded when replayHistory is true.
  const full = buildSdkTurnPrompt({
    prompt: "latest",
    replayHistory: true,
    historyMessages: messages,
  });
  assert.ok(full.startsWith(section));
  assert.equal(formatSdkHistoryReplaySection([]), "");
  assert.equal(formatSdkHistoryReplaySection(undefined), "");
});

test("CodeBuddy does not replay renderer history when a persisted session can resume", () => {
  assert.equal(shouldReplaySdkHistory({
    backendKey: "codebuddy",
    codexRuntime: "sdk",
    resumeSessionId: "resumed-codebuddy",
    hasInMemorySession: false,
  }), false);
  assert.equal(shouldReplaySdkHistory({
    backendKey: "codebuddy",
    codexRuntime: "sdk",
    resumeSessionId: undefined,
    hasInMemorySession: false,
  }), true);
  assert.equal(shouldReplaySdkHistory({
    backendKey: "claude",
    codexRuntime: "sdk",
    resumeSessionId: "resumed-claude",
    hasInMemorySession: false,
  }), true);
});

test("Grok does not replay renderer history when an ACP session can resume", () => {
  // Mirrors CodeBuddy: session/load / resume already restores Grok transcript.
  // Applies to both ACP and streaming-json once a resume id is present.
  assert.equal(shouldReplaySdkHistory({
    backendKey: "grok",
    codexRuntime: "sdk",
    resumeSessionId: "resumed-grok",
    hasInMemorySession: false,
  }), false);
  assert.equal(shouldReplaySdkHistory({
    backendKey: "grok",
    codexRuntime: "sdk",
    resumeSessionId: undefined,
    hasInMemorySession: false,
  }), true);
  // Even with an in-memory map miss, resume id alone must suppress replay.
  assert.equal(shouldReplaySdkHistory({
    backendKey: "grok",
    codexRuntime: "sdk",
    resumeSessionId: "s1",
    hasInMemorySession: true,
  }), false);
  // First turn (no resume) still seeds context even if in-memory key exists.
  assert.equal(shouldReplaySdkHistory({
    backendKey: "grok",
    codexRuntime: "sdk",
    resumeSessionId: undefined,
    hasInMemorySession: true,
  }), true);
});

test("expireSiblingGrokRuntimeSessions drops the inactive Grok runtime", () => {
  const acpKey = buildSdkSessionKey("chat-1", "grok", "/usr/bin/grok", "acp");
  const headlessKey = buildSdkSessionKey("chat-1", "grok", "/usr/bin/grok", "streaming-json");
  const otherChatAcpKey = buildSdkSessionKey("chat-2", "grok", "/usr/bin/grok", "acp");
  const sessions = new Map([
    [acpKey, "acp-session"],
    [headlessKey, "json-session"],
    [otherChatAcpKey, "other-acp"],
  ]);

  // Switch to streaming-json: expire ACP so switch-back cannot revive it.
  assert.equal(
    expireSiblingGrokRuntimeSessions(sessions, {
      chatSessionId: "chat-1",
      backendKey: "grok",
      binPath: "/usr/bin/grok",
      runtime: "streaming-json",
    }),
    true,
  );
  assert.equal(sessions.has(acpKey), false);
  assert.equal(sessions.get(headlessKey), "json-session");
  assert.equal(sessions.get(otherChatAcpKey), "other-acp");

  // Switch back to ACP: expire headless; ACP was already gone → fresh resume.
  sessions.set(headlessKey, "json-session-2");
  assert.equal(
    expireSiblingGrokRuntimeSessions(sessions, {
      chatSessionId: "chat-1",
      backendKey: "grok",
      binPath: "/usr/bin/grok",
      runtime: "acp",
    }),
    true,
  );
  assert.equal(sessions.has(headlessKey), false);
  assert.equal(
    resolveSdkResumeSessionId({
      sdkSessionIds: sessions,
      sdkSessionKey: acpKey,
      existingSessionId: `netcatty-sdk-session:${encodeURIComponent(JSON.stringify({
        v: 1,
        id: "json-session-2",
        backend: "grok",
        binPath: "/usr/bin/grok",
        runtime: "streaming-json",
      }))}`,
      backendKey: "grok",
      binPath: "/usr/bin/grok",
      runtime: "acp",
      hasConfiguredCommand: false,
    }),
    undefined,
  );
  // Non-grok backends no-op.
  assert.equal(
    expireSiblingGrokRuntimeSessions(sessions, {
      chatSessionId: "chat-1",
      backendKey: "claude",
      binPath: "/usr/bin/claude",
      runtime: "sdk",
    }),
    false,
  );
});

test("Grok ACP and streaming-json session identities never cross-resume", () => {
  const acpIdentity = `netcatty-sdk-session:${encodeURIComponent(JSON.stringify({
    v: 1,
    id: "grok-acp-thread",
    backend: "grok",
    binPath: "/usr/bin/grok",
    runtime: "acp",
  }))}`;
  const headlessIdentity = `netcatty-sdk-session:${encodeURIComponent(JSON.stringify({
    v: 1,
    id: "grok-headless-thread",
    backend: "grok",
    binPath: "/usr/bin/grok",
    runtime: "streaming-json",
  }))}`;

  // ACP identity must not resume onto streaming-json runtime.
  assert.equal(resolveSdkResumeSessionId({
    sdkSessionIds: new Map(),
    sdkSessionKey: buildSdkSessionKey("chat-1", "grok", "/usr/bin/grok", "streaming-json"),
    existingSessionId: acpIdentity,
    backendKey: "grok",
    binPath: "/usr/bin/grok",
    runtime: "streaming-json",
    hasConfiguredCommand: false,
  }), undefined);

  // streaming-json identity must not resume onto ACP runtime.
  assert.equal(resolveSdkResumeSessionId({
    sdkSessionIds: new Map(),
    sdkSessionKey: buildSdkSessionKey("chat-1", "grok", "/usr/bin/grok", "acp"),
    existingSessionId: headlessIdentity,
    backendKey: "grok",
    binPath: "/usr/bin/grok",
    runtime: "acp",
    hasConfiguredCommand: false,
  }), undefined);

  // Matching runtime resumes.
  assert.equal(resolveSdkResumeSessionId({
    sdkSessionIds: new Map(),
    sdkSessionKey: buildSdkSessionKey("chat-1", "grok", "/usr/bin/grok", "acp"),
    existingSessionId: acpIdentity,
    backendKey: "grok",
    binPath: "/usr/bin/grok",
    runtime: "acp",
    hasConfiguredCommand: false,
  }), "grok-acp-thread");
  assert.equal(resolveSdkResumeSessionId({
    sdkSessionIds: new Map(),
    sdkSessionKey: buildSdkSessionKey("chat-1", "grok", "/usr/bin/grok", "streaming-json"),
    existingSessionId: headlessIdentity,
    backendKey: "grok",
    binPath: "/usr/bin/grok",
    runtime: "streaming-json",
    hasConfiguredCommand: false,
  }), "grok-headless-thread");

  // Bare legacy ids are only safe for runtime "sdk" — not Grok dual runtimes.
  assert.equal(resolveSdkResumeSessionId({
    sdkSessionIds: new Map(),
    sdkSessionKey: buildSdkSessionKey("chat-1", "grok", "/usr/bin/grok", "acp"),
    existingSessionId: "legacy-bare-id",
    backendKey: "grok",
    binPath: "/usr/bin/grok",
    runtime: "acp",
    hasConfiguredCommand: false,
  }), undefined);
});

test("buildSdkTurnPrompt stages attachments as local file hints", () => {
  const staged = [];
  const prompt = buildSdkTurnPrompt({
    prompt: "describe it",
    attachments: [
      { base64Data: Buffer.from("img").toString("base64"), mediaType: "image/png", filename: "screen.png" },
    ],
    writeAttachmentToTemp: (attachment) => `/tmp/${attachment.filename}`,
    onStagedAttachment: (attachment) => staged.push(attachment),
  });

  assert.match(prompt, /Attached files/);
  assert.match(prompt, /read_attachment/);
  assert.match(prompt, /"screen\.png" \(image\/png\)/);
  assert.match(prompt, /\/tmp\/screen\.png/);
  assert.match(prompt, /describe it$/);
  assert.deepEqual(staged, [{
    filename: "screen.png",
    mediaType: "image/png",
    filePath: "/tmp/screen.png",
    base64Data: Buffer.from("img").toString("base64"),
  }]);
});

test("buildSdkTurnPrompt directs Skills-mode attachments to the controlled CLI", () => {
  const prompt = buildSdkTurnPrompt({
    prompt: "read it",
    toolIntegrationMode: "skills",
    attachments: [
      { base64Data: "ZGF0YQ==", mediaType: "text/plain", filename: "notes.txt" },
    ],
    writeAttachmentToTemp: (attachment) => `/tmp/${attachment.filename}`,
  });

  assert.match(prompt, /attachment list\/read CLI commands/);
  assert.doesNotMatch(prompt, /list_attachments|read_attachment/);
});

test("resolveSdkBackendBinPath prefers configured CodeBuddy path", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codebuddy",
    shellEnv: { PATH: "/usr/bin" },
    env: { CODEBUDDY_CODE_PATH: "/shim/bin/codebuddy" },
    resolveCliFromPath: () => "/usr/bin/codebuddy",
    normalizeCliPathForPlatform: (value) => value,
    realpath: () => "/opt/codebuddy/bin/codebuddy",
  });
  assert.equal(out, "/opt/codebuddy/bin/codebuddy");
});

test("resolveSdkBackendBinPath prefers the renderer-configured command path", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codex",
    configuredCommand: "/opt/homebrew/bin/codex",
    shellEnv: { PATH: "/usr/bin" },
    env: {},
    resolveCliFromPath: () => "/usr/bin/codex",
    normalizeCliPathForPlatform: (value) => value,
    resolveSdkBinPath: () => "/usr/bin/codex",
    realpath: () => "/opt/homebrew/bin/codex",
  });
  assert.equal(out, "/opt/homebrew/bin/codex");
});

test("resolveSdkBackendBinPath rejects invalid renderer-configured command paths", () => {
  assert.throws(
    () => resolveSdkBackendBinPath({
      backendKey: "codex",
      configuredCommand: "/missing/codex",
      shellEnv: { PATH: "/usr/bin" },
      env: {},
      resolveCliFromPath: () => "/usr/bin/codex",
      normalizeCliPathForPlatform: () => null,
      resolveSdkBinPath: () => "/usr/bin/codex",
    }),
    /Agent CLI path not found: \/missing\/codex/,
  );
});

test("resolveSdkBackendBinPath applies Codex SDK normalization to configured command paths", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codex",
    configuredCommand: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    shellEnv: { Path: "C:\\Windows\\System32" },
    env: {},
    resolveCliFromPath: () => "C:\\Windows\\System32\\codex.cmd",
    normalizeCliPathForPlatform: (value) => value,
    resolveCodexExecutableForSdk: (p) =>
      p.endsWith("codex.cmd")
        ? "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe"
        : p,
    realpath: (p) => p,
  });
  assert.equal(
    out,
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
  );
});

test("resolveSdkBackendBinPath applies CodeBuddy SDK normalization to configured command paths", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codebuddy",
    configuredCommand: "C:\\Users\\me\\AppData\\Roaming\\npm\\codebuddy.cmd",
    shellEnv: { Path: "C:\\Windows\\System32" },
    env: {},
    resolveCliFromPath: () => "C:\\Windows\\System32\\codebuddy.cmd",
    normalizeCliPathForPlatform: (value) => value,
    resolveCodebuddyExecutableForSdk: (p) =>
      p.endsWith("codebuddy.cmd")
        ? "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy"
        : p,
    realpath: (p) => p,
  });
  assert.equal(
    out,
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy",
  );
});

test("resolveSdkBackendBinPath falls back to PATH when CodeBuddy path is invalid", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codebuddy",
    shellEnv: { PATH: "/usr/bin" },
    env: { CODEBUDDY_CODE_PATH: "/missing/codebuddy" },
    resolveCliFromPath: () => "/usr/bin/codebuddy",
    normalizeCliPathForPlatform: () => null,
  });
  assert.equal(out, "/usr/bin/codebuddy");
});

test("resolveSdkBackendBinPath realpaths CodeBuddy PATH discovery fallback", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codebuddy",
    shellEnv: { PATH: "/usr/bin" },
    env: {},
    resolveCliFromPath: () => "/shim/bin/codebuddy",
    normalizeCliPathForPlatform: () => null,
    realpath: () => "/opt/codebuddy/bin/codebuddy",
  });
  assert.equal(out, "/opt/codebuddy/bin/codebuddy");
});

test("resolveSdkBackendBinPath resolves Windows CodeBuddy shim to the package JS entry", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codebuddy",
    shellEnv: { Path: "C:\\Users\\me\\AppData\\Roaming\\npm" },
    env: {},
    resolveCliFromPath: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\codebuddy.cmd",
    normalizeCliPathForPlatform: () => null,
    realpath: (p) => p,
    resolveCodebuddyExecutableForSdk: (p) =>
      p.endsWith("codebuddy.cmd")
        ? "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy"
        : p,
  });
  assert.equal(
    out,
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy",
  );
});

test("resolveSdkBackendBinPath falls back to bundled CLI when Windows CodeBuddy shim is unresolvable", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codebuddy",
    shellEnv: { Path: "C:\\Users\\me\\AppData\\Roaming\\npm" },
    env: {},
    resolveCliFromPath: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\codebuddy.cmd",
    normalizeCliPathForPlatform: () => null,
    realpath: (p) => p,
    resolveCodebuddyExecutableForSdk: () => null,
  });
  assert.equal(out, undefined);
});

test("resolveSdkBackendBinPath keeps non-CodeBuddy SDK path normalization", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codex",
    shellEnv: { PATH: "C:\\Users\\me\\AppData\\Roaming\\npm" },
    env: {},
    resolveCliFromPath: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    resolveSdkBinPath: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
  });
  assert.equal(out, "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
});

test("resolveSdkBackendBinPath does not fall back to Windows shell shims for non-CodeBuddy", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "codex",
    shellEnv: { PATH: "C:\\Users\\me\\AppData\\Roaming\\npm" },
    env: {},
    resolveCliFromPath: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    resolveSdkBinPath: () => null,
  });
  assert.equal(out, undefined);
});
