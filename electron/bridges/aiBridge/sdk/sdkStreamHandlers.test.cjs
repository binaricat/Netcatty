const test = require("node:test");
const assert = require("node:assert/strict");
const {
  registerSdkStreamHandlers,
  MODEL_LIST_TIMEOUT_OVERRIDES_MS,
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
function registerWithStubbedCtx(overrides = {}) {
  const handlers = new Map();
  const ctx = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    electronModule: undefined,
    validateSender: () => true,
    aiPrivacyService: {
      isEnabled: () => false,
      checkSession: () => false,
      redact: (_chatId, value) => value,
      restore: (_chatId, value) => value,
      clearSession: () => {},
    },
    mcpServerBridge: {
      setChatSessionCancelled: () => {},
      cancelPtyExecsForSession: () => {},
      cancelWorkerBackgroundJobsForSession: () => {},
      cleanupScopedMetadata: async () => {},
    },
    ...overrides,
  };
  registerSdkStreamHandlers(ctx);
  return { handlers, ctx };
}

function createTestPrivacy(enabled = true) {
  const sessions = new Map();
  const cleared = new Set();
  const checkSession = (chatId) => {
    if (cleared.has(chatId)) throw new Error("AI privacy session was cleared. Start a new conversation.");
    const prior = sessions.get(chatId);
    if (prior && prior.enabled !== enabled) throw new Error("AI privacy settings changed. Start a new conversation.");
    if (!prior) sessions.set(chatId, { enabled, values: new Map(), tokens: new Map() });
    return enabled;
  };
  const mapValues = (value, fn) => {
    if (typeof value === "string") return fn(value);
    if (Array.isArray(value)) return value.map((entry) => mapValues(entry, fn));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapValues(entry, fn)]));
    }
    return value;
  };
  return {
    isEnabled: () => enabled,
    hasSession: (chatId) => sessions.has(chatId),
    setEnabled: (value) => { enabled = value; },
    checkSession,
    clearSession(chatId) { sessions.delete(chatId); cleared.add(chatId); },
    redact(chatId, value) {
      if (!checkSession(chatId)) return value;
      const state = sessions.get(chatId);
      return mapValues(value, (text) => text.replace(/secret-[a-z]+/g, (original) => {
        if (!state.values.has(original)) {
          const token = `[NC_${chatId}_SECRET_${state.values.size + 1}]`;
          state.values.set(original, token);
          state.tokens.set(token, original);
        }
        return state.values.get(original);
      }));
    },
    restore(chatId, value) {
      if (!checkSession(chatId)) return value;
      const state = sessions.get(chatId);
      return mapValues(value, (text) => text.replace(/\[NC_[^\]]*(?:\]|$)/g, (token) => {
        if (!state.tokens.has(token)) throw new Error("Unknown AI privacy token.");
        return state.tokens.get(token);
      }));
    },
  };
}

function createPrivacyStreamHarness(privacy = createTestPrivacy(), runTurn) {
  const turns = [];
  const messages = [];
  const driver = {
    async runTurn(context) {
      turns.push(context);
      if (runTurn) return runTurn(context);
      context.emitter.sessionId("native-1");
      context.emitter.text(context.prompt);
      context.emitter.emitDone();
      return { sessionId: "native-1" };
    },
  };
  const registered = registerWithStubbedCtx({
    aiPrivacyService: privacy,
    safeSend: (_sender, channel, payload) => messages.push({ channel, payload }),
    getShellEnv: async () => ({}),
    normalizeToolIntegrationMode: (mode) => mode || "mcp",
    setToolIntegrationMode: () => {},
    normalizeAgentEnv: (env) => ({ ...env }),
    normalizeClaudeCodeExecutableEnvForSdk: (env) => env,
    resolveCliFromPath: (backend) => `/bin/${backend}`,
    normalizeCliPathForPlatform: (value) => value,
    resolveSdkBinPath: (backend) => `/bin/${backend}`,
    resolveClaudeCodeExecutableForSdk: (value) => value,
    resolveCodexExecutableForSdk: (value) => value,
    resolveCodebuddyExecutableForSdk: (value) => value,
    addCodexExecutableEnvForSdk: (env) => env,
    buildExternalAgentSystemContext: ({ userSkillsContext, defaultTargetSession }) => (
      `System ${userSkillsContext || ""} ${defaultTargetSession?.hostname || ""}`
    ),
    buildExternalAgentContextualPrompt: ({ prompt, userSkillsContext, defaultTargetSession }) => (
      `System ${userSkillsContext || ""} ${defaultTargetSession?.hostname || ""}\n\n${prompt}`
    ),
    getDriver: () => driver,
    mcpServerBridge: {
      setChatSessionCancelled: () => {},
      cancelPtyExecsForSession: () => {},
      cancelWorkerBackgroundJobsForSession: () => {},
      clearPendingApprovals: () => {},
      cleanupScopedMetadata: async () => {},
      getOrCreateHost: async () => 1234,
      getScopedSessionIds: () => ["terminal-1"],
      buildMcpServerConfig: (_port, _ids, chatId) => ({
        name: "netcatty", command: "/bin/node", env: [{ name: "CHAT_ID", value: chatId }],
      }),
      updateAttachmentMetadata: () => {},
    },
  });
  const stream = (overrides = {}) => registered.handlers.get("netcatty:ai:sdk-agent:stream")(
    { sender: {} },
    {
      requestId: `request-${turns.length + 1}`,
      chatSessionId: "chat-1",
      sdkBackend: "claude",
      prompt: "Use secret-user",
      cwd: "/secret-runtime",
      agentEnv: { RUNTIME_AUTH: "secret-auth" },
      userSkillsContext: "secret-skill",
      defaultTargetSession: { hostname: "secret-host" },
      historyMessages: [{ role: "user", content: "Previous secret-history" }],
      ...overrides,
    },
  );
  return { ...registered, stream, turns, messages, privacy };
}

test("SDK privacy protects assembled prompt/history/system content across drivers without touching runtime routing", async () => {
  for (const backend of ["claude", "codex", "copilot", "cursor", "codebuddy", "opencode", "grok", "mimo"]) {
    const h = createPrivacyStreamHarness();
    const result = await h.stream({ sdkBackend: backend });
    assert.equal(result.ok, true, `${backend}: ${result.error}`);
    assert.equal(h.turns.length, 1);
    const turn = h.turns[0];
    assert.doesNotMatch(turn.prompt, /secret-/);
    assert.doesNotMatch(turn.systemPrompt || "", /secret-/);
    assert.equal(turn.cwd, "/secret-runtime");
    assert.equal(turn.env.RUNTIME_AUTH, "secret-auth");
    assert.equal(turn.chatSessionId, "chat-1");
    assert.match(JSON.stringify(h.messages), /secret-user/, "local human output is restored");
    assert.doesNotMatch(JSON.stringify(h.messages), /\[NC_/, "aliases do not escape into local display");
  }
});

test("SDK privacy preserves aliases and safe native resume across turns, including Grok history fallback", async () => {
  const h = createPrivacyStreamHarness();
  assert.equal((await h.stream({ sdkBackend: "grok" })).ok, true);
  assert.equal((await h.stream({ sdkBackend: "grok" })).ok, true);
  assert.equal(h.turns[1].resumeSessionId, "native-1");
  const token = h.privacy.redact("chat-1", "secret-user");
  assert.ok(h.turns[0].prompt.includes(token));
  assert.ok(h.turns[1].prompt.includes(token));
  assert.doesNotMatch(h.turns[1].historySeed, /secret-history/);
  assert.match(h.turns[1].historySeed, /\[NC_/);
});

test("SDK adapters round trip through the real shared privacy service", async () => {
  const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
  const privacy = createAiPrivacyService();
  privacy.configure({ enabled: true, patterns: ["secret-[a-z]+"] });
  const h = createPrivacyStreamHarness(privacy);
  assert.equal((await h.stream()).ok, true);
  assert.equal((await h.stream()).ok, true);
  assert.equal(h.turns[1].resumeSessionId, "native-1");
  assert.doesNotMatch(h.turns[0].prompt, /secret-/);
  assert.match(JSON.stringify(h.messages), /secret-user/);
  assert.doesNotMatch(JSON.stringify(h.messages), /\[NC_/);
});

test("CodeBuddy nested agent prompts are protected without changing agent names, tools or model IDs", async () => {
  const h = createPrivacyStreamHarness();
  const agents = {
    "secret-agent": {
      prompt: "Use secret-user",
      description: "Access secret-host",
      tools: ["secret-tool"],
      model: "secret-model",
    },
  };
  assert.equal((await h.stream({ sdkBackend: "codebuddy", agents })).ok, true);
  const definition = h.turns[0].agents["secret-agent"];
  assert.doesNotMatch(definition.prompt, /secret-user/);
  assert.doesNotMatch(definition.description, /secret-host/);
  assert.deepEqual(definition.tools, ["secret-tool"]);
  assert.equal(definition.model, "secret-model");
});

test("real privacy discovers system and custom-agent secrets before masking any prompt surface", async () => {
  const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
  for (const source of ["system", "custom-agent"]) {
    const service = createAiPrivacyService();
    service.configure({ enabled: true });
    const batches = [];
    const privacy = {
      ...service,
      redact(chatId, value) { batches.push(value); return service.redact(chatId, value); },
    };
    const h = createPrivacyStreamHarness(privacy);
    const result = await h.stream({
      sdkBackend: source === "system" ? "opencode" : "codebuddy",
      prompt: "Use synthetic-secret",
      historyMessages: [{ role: "user", content: "Earlier synthetic-secret" }],
      userSkillsContext: source === "system" ? "password=synthetic-secret" : "",
      agents: {
        helper: {
          prompt: "Check synthetic-secret",
          description: source === "custom-agent" ? "password=synthetic-secret" : "Helper",
        },
      },
    });
    assert.equal(result.ok, true, result.error);
    const turn = h.turns[0];
    assert.doesNotMatch(turn.prompt, /synthetic-secret/);
    assert.doesNotMatch(turn.systemPrompt, /synthetic-secret/);
    assert.doesNotMatch(turn.agents.helper.prompt, /synthetic-secret/);
    assert.doesNotMatch(turn.agents.helper.description, /synthetic-secret/);
    assert.equal(batches.length, 1, "all semantic prompt surfaces share one discovery pass");
    assert.ok(Array.isArray(batches[0]));
  }
});

test("real privacy retains mapping and native resume provenance through runtime-only cleanup", async () => {
  const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
  const privacy = createAiPrivacyService();
  privacy.configure({ enabled: true, patterns: ["secret-[a-z]+"] });
  const h = createPrivacyStreamHarness(privacy);
  assert.equal((await h.stream()).ok, true);
  const token = privacy.redact("chat-1", "secret-user");
  await h.handlers.get("netcatty:ai:sdk-agent:cleanup")({}, { chatSessionId: "chat-1" });
  assert.equal(privacy.hasSession("chat-1"), true);
  assert.equal(privacy.restore("chat-1", token), "secret-user");
  const resumed = await h.stream({ existingSessionId: "native-1" });
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(h.turns[1].resumeSessionId, "native-1");
  assert.ok(h.turns[1].prompt.includes(token));
  privacy.clearSession("chat-1");
  const deleted = await h.stream({ existingSessionId: "native-1" });
  assert.equal(deleted.ok, false);
  assert.match(deleted.error, /new chat|new conversation/i);
  assert.equal(h.turns.length, 2);
});

test("privacy policy change while environment initialization awaits blocks the provider call", async () => {
  const h = createPrivacyStreamHarness(createTestPrivacy(false));
  let release;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  h.ctx.getShellEnv = async () => { notifyStarted(); await gate; return {}; };
  const run = h.stream();
  await started;
  h.privacy.setEnabled(true);
  release();
  const result = await run;
  assert.equal(result.ok, false);
  assert.match(result.error, /settings changed/);
  assert.equal(h.turns.length, 0);
  assert.equal(h.ctx.sdkActiveStreams.size, 0);
});

test("native session emitted before a stopped turn remains eligible for private resume", async () => {
  let count = 0;
  const h = createPrivacyStreamHarness(createTestPrivacy(), async (context) => {
    context.emitter.sessionId("native-stopped");
    if (++count === 1) throw new Error("Stopped");
    context.emitter.emitDone();
    return { sessionId: "native-stopped" };
  });
  assert.equal((await h.stream()).ok, false);
  assert.equal((await h.stream()).ok, true);
  assert.equal(h.turns[1].resumeSessionId, "native-stopped");
});

test("SDK privacy refuses cold native resumes even if Catty already established a chat mapping", async () => {
  const privacy = createTestPrivacy();
  privacy.redact("chat-1", "secret-user");
  const h = createPrivacyStreamHarness(privacy);
  const result = await h.stream({ existingSessionId: "persisted-native-thread" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Start a new conversation/);
  assert.equal(h.turns.length, 0);
});

test("SDK privacy blocks direct image and file attachments before driver or staging", async () => {
  for (const image of [
    { mediaType: "image/png", base64Data: "c2VjcmV0", filename: "image.png" },
    { mediaType: "text/plain", base64Data: "c2VjcmV0", filename: "notes.txt" },
    { filePath: "/private/image.png", mediaType: "image/png" },
  ]) {
    const h = createPrivacyStreamHarness();
    const result = await h.stream({ images: [image] });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not support direct agent attachments/);
    assert.equal(h.turns.length, 0);
  }
});

test("SDK privacy changes require a new chat and cancellation preserves the existing map", async () => {
  const h = createPrivacyStreamHarness();
  assert.equal((await h.stream()).ok, true);
  await h.handlers.get("netcatty:ai:sdk-agent:cancel")({}, { requestId: "missing", chatSessionId: "chat-1" });
  assert.equal(h.privacy.hasSession("chat-1"), true);
  h.privacy.setEnabled(false);
  const result = await h.stream();
  assert.equal(result.ok, false);
  assert.match(result.error, /settings changed/);
  assert.equal(h.turns.length, 1);
  await h.handlers.get("netcatty:ai:sdk-agent:cleanup")({}, { chatSessionId: "chat-1" });
  assert.equal(h.privacy.hasSession("chat-1"), true, "runtime cleanup is not chat deletion");
});

test("disabled SDK privacy leaves prompts, native resumes, and output untouched", async () => {
  const h = createPrivacyStreamHarness(createTestPrivacy(false));
  const result = await h.stream({ existingSessionId: "existing-native-thread", prompt: "literal [NC_" });
  assert.equal(result.ok, true);
  assert.equal(h.turns[0].resumeSessionId, "existing-native-thread");
  assert.match(h.turns[0].prompt, /secret-skill/);
  assert.match(JSON.stringify(h.messages), /literal \[NC_/);
});

test("Codex app-server start and steering use the same privacy scope", async () => {
  const h = createPrivacyStreamHarness();
  h.ctx.codexAppServerRuntime.runTurn = async (context) => {
    h.turns.push(context);
    context.emitter.sessionId("app-native-1");
    return { threadId: "app-native-1" };
  };
  assert.equal((await h.stream({ sdkBackend: "codex", codexRuntime: "app-server" })).ok, true);
  const token = h.privacy.redact("chat-1", "secret-user");
  assert.ok(h.turns[0].prompt.includes(token));
  h.ctx.sdkRequestSessions.set("active-request", "chat-1");
  h.ctx.sdkRequestRuntimes.set("active-request", {
    backendKey: "codex", codexRuntime: "app-server", toolIntegrationMode: "mcp",
  });
  let steered;
  h.ctx.codexAppServerRuntime.steerTurn = async (_requestId, input) => {
    steered = input;
    return { status: "accepted" };
  };
  const steer = h.handlers.get("netcatty:ai:sdk-agent:steer");
  const result = await steer({}, {
    requestId: "active-request", chatSessionId: "chat-1",
    clientUserMessageId: "user-1", prompt: "Also secret-user",
  });
  assert.equal(result.status, "accepted");
  assert.equal(steered.prompt, `Also ${token}`);
  assert.equal(steered.clientUserMessageId, "user-1");
  const blocked = await steer({}, {
    requestId: "active-request", chatSessionId: "chat-1", clientUserMessageId: "user-2",
    prompt: "image", images: [{ mediaType: "image/png", base64Data: "aA==" }],
  });
  assert.equal(blocked.status, "failed");
});

test("Codex and CodeBuddy user answers are masked using the pending chat without rewriting field IDs", async () => {
  const h = createPrivacyStreamHarness();
  h.privacy.checkSession("chat-1");
  const content = { "secret-question": { answers: ["secret-user"] } };
  const answers = h.ctx.codexAppServerRuntime.transformUserInputAnswers(content, { chatSessionId: "chat-1" });
  assert.deepEqual(Object.keys(answers), ["secret-question"]);
  assert.equal(answers["secret-question"].answers[0], h.privacy.redact("chat-1", "secret-user"));
  let response;
  h.ctx.codebuddySessionManager.elicitationPending.set("elicit-private", {
    chatSessionId: "chat-1",
    resolve: (value) => { response = value; },
  });
  const result = await h.handlers.get("netcatty:ai:sdk-agent:elicitation-response")({}, {
    elicitationId: "elicit-private", action: "accept", content,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(response.content, answers);
});

test("real privacy batches user answers with secret ancestry and preserves all question IDs", async () => {
  const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
  for (const route of ["codex", "codebuddy"]) {
    for (const content of [
      { echo: "synthetic-secret", password: "synthetic-secret" },
      { echo: "synthetic-secret", credentials: { value: "synthetic-secret" } },
      {
        "synthetic-secret": { answers: ["synthetic-secret"] },
        credentials: { value: "synthetic-secret" },
      },
    ]) {
      const service = createAiPrivacyService();
      service.configure({ enabled: true });
      let batches = 0;
      const privacy = {
        ...service,
        redact(chatId, value) { batches += 1; return service.redact(chatId, value); },
      };
      const h = createPrivacyStreamHarness(privacy);
      let protectedContent;
      if (route === "codex") {
        protectedContent = h.ctx.codexAppServerRuntime.transformUserInputAnswers(content, { chatSessionId: "chat-1" });
      } else {
        h.ctx.codebuddySessionManager.elicitationPending.set("batch-private", {
          chatSessionId: "chat-1",
          resolve(response) { protectedContent = response.content; },
        });
        const result = await h.handlers.get("netcatty:ai:sdk-agent:elicitation-response")({}, {
          elicitationId: "batch-private", action: "accept", content,
        });
        assert.equal(result.ok, true, result.error);
      }
      const compare = (original, masked) => {
        if (typeof original === "string") {
          assert.notEqual(masked, original);
          assert.equal(service.restore("chat-1", masked), original);
        } else if (Array.isArray(original)) {
          original.forEach((entry, index) => compare(entry, masked[index]));
        } else {
          assert.deepEqual(Object.keys(masked), Object.keys(original));
          Object.entries(original).forEach(([key, entry]) => compare(entry, masked[key]));
        }
      };
      compare(content, protectedContent);
      assert.equal(batches, 1, "answer values share a single secret-discovery pass");
    }
  }
});

test("Codex native approval arguments remain exact while question display restores content and preserves IDs", () => {
  const h = createPrivacyStreamHarness();
  const token = h.privacy.redact("chat-1", "secret-user");
  const nativeArgs = {
    command: `echo ${token}`,
    cwd: `/work/${token}`,
    commandActions: [{ type: "read", path: token }],
    itemId: token,
  };
  h.ctx.codexAppServerRuntime.sendInteractionRequest({
    interactionId: token,
    args: nativeArgs,
    questions: [{
      id: token, header: token, question: token,
      options: [{ label: token, description: token }],
    }],
  }, { chatSessionId: "chat-1", sender: {} });
  const displayed = h.messages.at(-1).payload;
  assert.equal(displayed.interactionId, token);
  assert.strictEqual(displayed.args, nativeArgs);
  assert.equal(displayed.args.itemId, token);
  assert.equal(displayed.args.command, `echo ${token}`);
  assert.equal(displayed.questions[0].id, token);
  assert.equal(displayed.questions[0].question, "secret-user");
  assert.equal(displayed.questions[0].options[0].label, "secret-user");
});

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

test("MiMo model catalog cache changes with its config roots", () => {
  const base = buildSdkModelCacheKey("mimo", "/usr/bin/mimo", { MIMOCODE_HOME: "/one" });
  assert.notEqual(base, buildSdkModelCacheKey("mimo", "/usr/bin/mimo", { MIMOCODE_HOME: "/two" }));
  assert.notEqual(base, buildSdkModelCacheKey("mimo", "/usr/bin/mimo", { MIMOCODE_HOME: "/one", MIMOCODE_CONFIG_DIR: "/extra" }));
  assert.notEqual(base, buildSdkModelCacheKey("mimo", "/usr/bin/mimo", { MIMOCODE_HOME: "/one", MIMOCODE_BIN: "/another/mimo" }));
  assert.notEqual(base, buildSdkModelCacheKey("mimo", "/usr/bin/mimo", { MIMOCODE_HOME: "/one", MIMOCODE_BIN_PATH: "/another/mimo" }));
  assert.notEqual(base, buildSdkModelCacheKey("mimo", "/usr/bin/mimo", { MIMOCODE_HOME: "/one", MIMOCODE_CONFIG: "/another/config.json" }));
});

test("CodeBuddy model catalog cache changes with its auth and network env", () => {
  // Two profiles sharing the binary but not credentials must not share one
  // cache key: that served user A's catalog (and current id) to user B.
  const base = buildSdkModelCacheKey("codebuddy", "/usr/bin/codebuddy", { CODEBUDDY_API_KEY: "key-a" });
  assert.notEqual(base, buildSdkModelCacheKey("codebuddy", "/usr/bin/codebuddy", { CODEBUDDY_API_KEY: "key-b" }));
  assert.notEqual(base, buildSdkModelCacheKey("codebuddy", "/usr/bin/codebuddy", { CODEBUDDY_API_KEY: "key-a", CODEBUDDY_AUTH_TOKEN: "tok-b" }));
  assert.notEqual(base, buildSdkModelCacheKey("codebuddy", "/usr/bin/codebuddy", { CODEBUDDY_API_KEY: "key-a", CODEBUDDY_INTERNET_ENVIRONMENT: "ioa" }));
  // Same env fingerprint still yields the same key (no false isolation).
  assert.equal(base, buildSdkModelCacheKey("codebuddy", "/usr/bin/codebuddy", { CODEBUDDY_API_KEY: "key-a" }));
});

test("Grok model catalog cache changes with XAI_API_KEY", () => {
  // Two Grok profiles sharing one binary but not credentials must not share
  // one cache key: `grok login` tokens and env XAI_API_KEY coexist on the
  // same machine, so the catalog (and current id) of one account must never
  // be served to the other.
  const base = buildSdkModelCacheKey("grok", "/usr/bin/grok", { XAI_API_KEY: "key-a" });
  assert.notEqual(base, buildSdkModelCacheKey("grok", "/usr/bin/grok", { XAI_API_KEY: "key-b" }));
  assert.notEqual(base, buildSdkModelCacheKey("grok", "/usr/bin/grok", {}));
  // Same env fingerprint still yields the same key (no false isolation), and
  // the key never leaks the credential value.
  assert.equal(base, buildSdkModelCacheKey("grok", "/usr/bin/grok", { XAI_API_KEY: "key-a" }));
  assert.doesNotMatch(base, /key-a/);
});

test("Grok model catalog cache changes with the CLI-login config directory", () => {
  // `grok login` credentials live under GROK_CONFIG_DIR: two login profiles that
  // share HOME and the binary must not share a catalog or a current id.
  const base = buildSdkModelCacheKey("grok", "/usr/bin/grok", { GROK_CONFIG_DIR: "/profiles/a" });
  assert.notEqual(base, buildSdkModelCacheKey("grok", "/usr/bin/grok", { GROK_CONFIG_DIR: "/profiles/b" }));
  assert.notEqual(base, buildSdkModelCacheKey("grok", "/usr/bin/grok", {}));
  assert.equal(base, buildSdkModelCacheKey("grok", "/usr/bin/grok", { GROK_CONFIG_DIR: "/profiles/a" }));
});

test("Claude model catalog cache changes with the API endpoint", () => {
  // Another endpoint serves another model list: a failed live load after a
  // restart must not fall back to the previous endpoint's persisted catalog.
  const base = buildSdkModelCacheKey("claude", "/usr/bin/claude", { ANTHROPIC_BASE_URL: "https://a.example" });
  assert.notEqual(base, buildSdkModelCacheKey("claude", "/usr/bin/claude", { ANTHROPIC_BASE_URL: "https://b.example" }));
  assert.notEqual(base, buildSdkModelCacheKey("claude", "/usr/bin/claude", {}));
  assert.equal(base, buildSdkModelCacheKey("claude", "/usr/bin/claude", { ANTHROPIC_BASE_URL: "https://a.example" }));
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

test("CodeBuddy, OpenCode and MiMo keep Netcatty context in the system prompt only", () => {
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
    backendKey: "mimo",
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

test("resolveSdkBackendBinPath prefers the MiMo environment path over PATH", () => {
  const out = resolveSdkBackendBinPath({
    backendKey: "mimo",
    shellEnv: { PATH: "/usr/bin" },
    env: { MIMOCODE_BIN: "/opt/mimo/bin/mimo" },
    normalizeCliPathForPlatform: (value) => value,
    resolveCliFromPath: () => "/usr/bin/mimo",
    resolveSdkBinPath: () => "/usr/bin/mimo",
    realpath: (value) => value,
  });
  assert.equal(out, "/opt/mimo/bin/mimo");
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


test("OpenCode catalog IPC allows cold startup past 10s and still aborts a stalled load", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { OPENCODE_SERVER_START_TIMEOUT_MS } = require("./opencodeDriver.cjs");
  const { handlers } = registerWithStubbedCtx({
    getShellEnv: async () => ({}),
    normalizeAgentEnv: (env) => env || {},
    withCliDiscoveryEnv: (env) => env,
    normalizeClaudeCodeExecutableEnvForSdk: (env) => env,
    resolveCliFromPath: () => undefined,
    normalizeCliPathForPlatform: (value) => value,
    resolveSdkBinPath: () => undefined,
    resolveClaudeCodeExecutableForSdk: undefined,
    resolveCodexExecutableForSdk: undefined,
    resolveCodebuddyExecutableForSdk: undefined,
  });
  const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
  const catalog = { models: [{ id: "test/cold-start" }], currentModelId: "test/cold-start" };
  let signal;
  let complete;
  let started;
  let entered = new Promise((resolve) => { started = resolve; });
  t.mock.method(getDriver("opencode"), "listModels", ({ abortController }) => {
    signal = abortController.signal;
    started();
    return new Promise((resolve) => { complete = resolve; });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const slow = listModels({ sender: {} }, { sdkBackend: "opencode", agentCommand: "/test/cold-start" });
  await entered;
  t.mock.timers.tick(10001);
  assert.equal(signal.aborted, false, "the old outer 10s deadline must not cancel OpenCode startup");
  complete(catalog);
  const coldResult = await slow;
  // Live successes carry the source provenance + fetch timestamp (R1).
  assert.deepEqual(coldResult, { ok: true, source: "live", fetchedAt: coldResult.fetchedAt, ...catalog });
  assert.match(coldResult.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);

  entered = new Promise((resolve) => { started = resolve; });
  const stalled = listModels({ sender: {} }, { sdkBackend: "opencode", agentCommand: "/test/stalled-start" });
  await entered;
  t.mock.timers.tick(OPENCODE_SERVER_START_TIMEOUT_MS + 10000);
  const result = await stalled;
  assert.equal(signal.aborted, true, "the bounded catalog deadline must abort the driver");
  assert.match(result.warning, /list-models timed out/);
  assert.deepEqual(result.models, []);
  // A timeout must leave neither an in-flight entry nor a cached failure.
  entered = new Promise((resolve) => { started = resolve; });
  const retried = listModels({ sender: {} }, { sdkBackend: "opencode", agentCommand: "/test/stalled-start" });
  await entered;
  complete(catalog);
  const retriedResult = await retried;
  assert.deepEqual(retriedResult, { ok: true, source: "live", fetchedAt: retriedResult.fetchedAt, ...catalog });
});

test("model catalog timeout override widens the budget only for mimo", () => {
  assert.deepEqual(MODEL_LIST_TIMEOUT_OVERRIDES_MS, { mimo: 30_000 });
});

// --- Last-known-good catalog persistence ---

const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");
const {
  LAST_KNOWN_MAX_MODELS,
  LAST_KNOWN_MAX_ENTRIES,
  buildLastKnownCatalogPath,
  readLastKnownCatalogEntry,
  readLastKnownCatalogStore,
  refreshLastKnownCatalogCurrentId,
  writeLastKnownCatalogEntry,
} = require("./modelCatalogLastKnown.cjs");

function makeLastKnownCtx(overrides = {}) {
  const userDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "netcatty-lkg-"));
  const { handlers, ctx } = registerWithStubbedCtx({
    // Mirror the real bootstrap: electronModule is require("electron"), so
    // userData lives behind .app.
    electronModule: { app: { getPath: (name) => (name === "userData" ? userDataDir : undefined) } },
    getShellEnv: async () => ({}),
    normalizeAgentEnv: (env) => env || {},
    withCliDiscoveryEnv: (env) => env,
    normalizeClaudeCodeExecutableEnvForSdk: (env) => env,
    resolveCliFromPath: () => undefined,
    normalizeCliPathForPlatform: (value) => value,
    resolveSdkBinPath: () => undefined,
    resolveClaudeCodeExecutableForSdk: undefined,
    resolveCodexExecutableForSdk: undefined,
    resolveCodebuddyExecutableForSdk: undefined,
    ...overrides,
  });
  return {
    handlers,
    ctx,
    userDataDir,
    catalogFile: buildLastKnownCatalogPath(userDataDir),
    cleanup() {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

test("modelCatalogLastKnown caps models, never stores empty catalogs, and keeps keys isolated", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "netcatty-lkg-unit-"));
  const file = buildLastKnownCatalogPath(dir);
  try {
    const oversized = Array.from({ length: 300 }, (_, index) => ({ id: `m-${index}` }));
    assert.equal(writeLastKnownCatalogEntry(file, "k1", { backend: "claude", models: oversized }), true);
    const stored = readLastKnownCatalogEntry(file, "k1");
    assert.equal(stored.models.length, LAST_KNOWN_MAX_MODELS);
    assert.equal(stored.backend, "claude");
    assert.match(stored.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);

    // A current model beyond the cap is retained in the capped set, so the
    // persisted current id always has a picker row.
    const currentBeyondCap = Array.from(
      { length: LAST_KNOWN_MAX_MODELS + 5 },
      (_, index) => ({ id: `beyond-${index}` }),
    );
    assert.equal(writeLastKnownCatalogEntry(file, "k-cap", {
      backend: "claude",
      models: currentBeyondCap,
      currentModelId: `beyond-${LAST_KNOWN_MAX_MODELS + 4}`,
    }), true);
    const capped = readLastKnownCatalogEntry(file, "k-cap");
    assert.equal(capped.models.length, LAST_KNOWN_MAX_MODELS);
    assert.equal(
      capped.models.some((model) => model.id === `beyond-${LAST_KNOWN_MAX_MODELS + 4}`),
      true,
    );

    assert.equal(writeLastKnownCatalogEntry(file, "k2", { backend: "claude", models: [] }), false);
    assert.equal(writeLastKnownCatalogEntry(file, "k3", { backend: "claude", models: [{ name: "no id" }] }), false);
    assert.equal(readLastKnownCatalogEntry(file, "k2"), null);

    assert.equal(writeLastKnownCatalogEntry(file, "k4", {
      backend: "mimo",
      models: [{ id: "xiaomi/mimo-v2.6-flash" }],
      currentModelId: "xiaomi/mimo-v2.6-flash",
    }), true);
    assert.equal(readLastKnownCatalogEntry(file, "k1").backend, "claude");
    assert.equal(readLastKnownCatalogEntry(file, "k4").currentModelId, "xiaomi/mimo-v2.6-flash");
    assert.equal(readLastKnownCatalogEntry(file, "missing"), null);
    assert.equal(writeLastKnownCatalogEntry(null, "k5", { backend: "claude", models: [{ id: "x" }] }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("modelCatalogLastKnown evicts the oldest entries beyond the store cap", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "netcatty-lkg-cap-"));
  const file = buildLastKnownCatalogPath(dir);
  try {
    // Fill the store to the cap with staggered timestamps.
    for (let index = 0; index < LAST_KNOWN_MAX_ENTRIES; index += 1) {
      assert.equal(writeLastKnownCatalogEntry(
        file,
        `k-${index}`,
        { backend: "claude", models: [{ id: "m" }] },
        { now: Date.parse("2026-01-01T00:00:00Z") + index * 1000 },
      ), true);
    }
    // Writing one more evicts the oldest entry, not the newest.
    assert.equal(writeLastKnownCatalogEntry(
      file,
      "k-new",
      { backend: "claude", models: [{ id: "m" }] },
      { now: Date.parse("2026-02-01T00:00:00Z") },
    ), true);
    const store = readLastKnownCatalogStore(file);
    assert.equal(Object.keys(store).length, LAST_KNOWN_MAX_ENTRIES);
    assert.equal("k-new" in store, true);
    assert.equal(`k-0` in store, false);
    assert.equal(`k-${LAST_KNOWN_MAX_ENTRIES - 1}` in store, true);
    // Re-writing an existing key refreshes it and keeps it in the store.
    assert.equal(writeLastKnownCatalogEntry(
      file,
      "k-1",
      { backend: "claude", models: [{ id: "m" }] },
      { now: Date.parse("2026-03-01T00:00:00Z") },
    ), true);
    assert.equal("k-1" in readLastKnownCatalogStore(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("modelCatalogLastKnown degrades gracefully on corrupt stores", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "netcatty-lkg-corrupt-"));
  const file = buildLastKnownCatalogPath(dir);
  try {
    fs.writeFileSync(file, "{corrupt json");
    assert.deepEqual(readLastKnownCatalogStore(file), {});
    assert.equal(readLastKnownCatalogEntry(file, "k1"), null);
    // A later successful fetch repairs the store.
    assert.equal(writeLastKnownCatalogEntry(file, "k1", { backend: "claude", models: [{ id: "m" }] }), true);
    assert.deepEqual(readLastKnownCatalogEntry(file, "k1").models, [{ id: "m" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("modelCatalogLastKnown refreshes the current id without clobbering the models list", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "netcatty-lkg-refresh-"));
  const file = buildLastKnownCatalogPath(dir);
  try {
    // No persisted entry: a current-only catalog has nothing to refresh.
    assert.equal(refreshLastKnownCatalogCurrentId(file, "k1", "m-2"), false);
    assert.equal(fs.existsSync(file), false);

    assert.equal(writeLastKnownCatalogEntry(file, "k1", {
      backend: "claude",
      models: [{ id: "m-1" }, { id: "m-2" }],
      currentModelId: "m-1",
    }), true);

    // Current-only catalog: the selection is updated, the models list and the
    // fetch timestamp (when the models were fetched) stay untouched.
    assert.equal(refreshLastKnownCatalogCurrentId(file, "k1", "m-2"), true);
    const refreshed = readLastKnownCatalogEntry(file, "k1");
    assert.equal(refreshed.currentModelId, "m-2");
    assert.deepEqual(refreshed.models, [{ id: "m-1" }, { id: "m-2" }]);

    // Same id and missing inputs are no-ops; other keys are untouched.
    assert.equal(refreshLastKnownCatalogCurrentId(file, "k1", "m-2"), false);
    assert.equal(refreshLastKnownCatalogCurrentId(file, "k1", null), false);
    assert.equal(refreshLastKnownCatalogCurrentId(null, "k1", "m-1"), false);
    assert.equal(readLastKnownCatalogEntry(file, "k1").currentModelId, "m-2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current-only refresh to an unpersisted id keeps read-back row and current id consistent", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "netcatty-lkg-current-only-"));
  const file = buildLastKnownCatalogPath(dir);
  try {
    // 1. A prior full catalog persisted {m-1} with current m-1.
    assert.equal(writeLastKnownCatalogEntry(file, "k1", {
      backend: "mimo",
      models: [{ id: "m-1", name: "M1" }],
      currentModelId: "m-1",
    }), true);

    // 2. A later current-only catalog (zero visible models, e.g. mimo's
    // filtered auto channel) adopts a new id the persisted list lacks.
    assert.equal(refreshLastKnownCatalogCurrentId(file, "k1", "m-new"), true);

    // 3. The next live failure reads the store back: the persisted list must
    // contain the current row, so the picker and the send preflight agree.
    const readBack = readLastKnownCatalogEntry(file, "k1");
    assert.equal(readBack.currentModelId, "m-new");
    const synthesized = readBack.models.find((model) => model.id === "m-new");
    assert.ok(synthesized, "read-back models must contain the refreshed current id");
    assert.deepEqual(synthesized, { id: "m-new", name: "m-new" });
    // The previous selection survives alongside the synthesized row.
    assert.ok(readBack.models.some((model) => model.id === "m-1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("list-models serves a visible current id from last-known-good when the persisted one has no row", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("opencode");
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
    // listOpenCodeModels derives the current id and the rows independently, so
    // a default from an unavailable provider can coexist with another provider's rows.
    t.mock.method(driver, "listModels", async () => ({
      currentModelId: "gone/m-9",
      models: [{ id: "a/m-1", name: "M1" }],
    }));
    const seeded = await listModels({ sender: {} }, { sdkBackend: "opencode", agentCommand: "/test/lkg-dangling" });
    assert.equal(seeded.ok, true);

    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => []);
    const failed = await listModels({ sender: {} }, { sdkBackend: "opencode", agentCommand: "/test/lkg-dangling", force: true });
    assert.equal(failed.source, "last-known-good");
    assert.equal(failed.currentModelId, "a/m-1", "the served current id must be one the picker shows");
    assert.equal(failed.models.some((model) => model.id === failed.currentModelId), true);
  } finally {
    cleanup();
  }
});

test("list-models keeps an effort-decorated current id from last-known-good when its base row exists", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("grok");
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
    t.mock.method(driver, "listModels", async () => ({
      currentModelId: "grok-4.6/high",
      models: [{ id: "grok-4.5", name: "G45" }, { id: "grok-4.6", name: "G46", thinkingLevels: ["high"] }],
    }));
    const seeded = await listModels({ sender: {} }, { sdkBackend: "grok", agentCommand: "/test/lkg-grok-effort" });
    assert.equal(seeded.ok, true);

    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => []);
    const failed = await listModels({ sender: {} }, { sdkBackend: "grok", agentCommand: "/test/lkg-grok-effort", force: true });
    assert.equal(failed.source, "last-known-good");
    assert.equal(failed.currentModelId, "grok-4.6/high", "the effort must survive when the base row is listed");
  } finally {
    cleanup();
  }
});

test("list-models does not keep a nested current id that is not an advertised thinking level", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("opencode");
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
    // `openrouter` is a row, but `openrouter/openai/gpt-5` is not one of its levels.
    t.mock.method(driver, "listModels", async () => ({
      currentModelId: "openrouter/openai/gpt-5",
      models: [{ id: "a/m-1", name: "M1" }, { id: "openrouter", name: "OR", thinkingLevels: ["high"] }],
    }));
    const seeded = await listModels({ sender: {} }, { sdkBackend: "opencode", agentCommand: "/test/lkg-nested" });
    assert.equal(seeded.ok, true);

    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => []);
    const failed = await listModels({ sender: {} }, { sdkBackend: "opencode", agentCommand: "/test/lkg-nested", force: true });
    assert.equal(failed.source, "last-known-good");
    assert.equal(failed.currentModelId, "a/m-1");
  } finally {
    cleanup();
  }
});

test("list-models persists a successful live catalog and serves it as last-known-good after failures", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, catalogFile, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("claude");
    const liveCatalog = [{ id: "claude-opus-5-5", name: "Opus 5.5" }];
    t.mock.method(driver, "listModels", async () => liveCatalog);
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");

    // 1. Live success → written to the store, response extended with the
    // live provenance marker (R1).
    const success = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-success" });
    assert.deepEqual(success, {
      ok: true,
      currentModelId: null,
      models: liveCatalog,
      source: "live",
      fetchedAt: success.fetchedAt,
    });
    assert.match(success.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    const entries = Object.values(readLastKnownCatalogStore(catalogFile));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].backend, "claude");
    assert.deepEqual(entries[0].models, liveCatalog);
    assert.match(entries[0].fetchedAt, /^\d{4}-\d{2}-\d{2}T/);

    // 2. Forced live failure after that success → the persisted catalog is
    // served with its warning even while the in-memory cache is warm.
    assert.equal(ctx.sdkModelCache.size > 0, true);
    driver.listModels.mock.mockImplementation(async () => []);
    const failed = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-success", force: true });
    assert.equal(driver.listModels.mock.callCount(), 2, "force must attempt live despite the warm cache");
    assert.equal(failed.ok, true);
    assert.deepEqual(failed.models, liveCatalog);
    assert.equal(failed.currentModelId, null);
    assert.equal(failed.source, "last-known-good");
    assert.equal(failed.fetchedAt, entries[0].fetchedAt);
    assert.match(failed.warning, /returned no models/);
    assert.match(failed.warning, /last-known-good/);
  } finally {
    cleanup();
  }
});

test("list-models serves the persisted catalog without a live fetch on a non-force load (LKG-first)", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("claude");
    const liveCatalog = [{ id: "claude-opus-5-5", name: "Opus 5.5" }];
    t.mock.method(driver, "listModels", async () => liveCatalog);
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");

    // Seed a prior success so the store holds an entry for this cache key.
    const seeded = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-first" });
    assert.equal(seeded.source, "live");

    // A later non-force load must hydrate from the store and never reach the
    // driver: no live-fetch budget spent, and no warning — plain panel-open
    // stays silent even when the CLI would fail or stall today.
    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => {
      throw new Error("the live driver must not run for a non-force load once an LKG entry exists");
    });
    const hydrated = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-first" });
    assert.equal(driver.listModels.mock.callCount(), 1, "only the seeding call may reach the driver");
    assert.deepEqual(hydrated, {
      ok: true,
      currentModelId: null,
      models: liveCatalog,
      source: "last-known-good",
      fetchedAt: hydrated.fetchedAt,
    });
    assert.equal(hydrated.warning, undefined);
    assert.match(hydrated.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test("list-models force refresh bypasses warm memory and last-known-good and updates both caches", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, catalogFile, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("claude");
    t.mock.method(driver, "listModels", async () => [{ id: "claude-opus-5-5", name: "Opus 5.5" }]);
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");

    // Keep the prior success warm: force must bypass both cache layers.
    await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-force" });
    assert.equal(ctx.sdkModelCache.size > 0, true);
    const nextCatalog = [{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-opus-6-1", name: "Opus 6.1" }];
    driver.listModels.mock.mockImplementation(async () => nextCatalog);

    const forced = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-force", force: true });
    assert.equal(driver.listModels.mock.callCount(), 2);
    assert.deepEqual(forced, {
      ok: true,
      currentModelId: null,
      models: nextCatalog,
      source: "live",
      fetchedAt: forced.fetchedAt,
    });
    assert.equal(forced.warning, undefined);

    // The forced success replaces the persisted entry, so future non-force
    // loads and failure fallbacks serve the refreshed list.
    const entries = Object.values(readLastKnownCatalogStore(catalogFile));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].models, nextCatalog);
    const cached = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-force" });
    assert.deepEqual(cached, forced);
    assert.equal(driver.listModels.mock.callCount(), 2, "ordinary loads still reuse the refreshed memory cache");
  } finally {
    cleanup();
  }
});

test("list-models coalesces force refreshes with an existing live fetch", async (t) => {
  for (const warmCache of [false, true]) {
    await t.test(warmCache ? "warm memory cache" : "cold cache", async (t) => {
      const { getDriver } = require("./index.cjs");
      const { handlers, cleanup } = makeLastKnownCtx();
      try {
        const driver = getDriver("claude");
        t.mock.method(driver, "listModels", async () => [{ id: "old-model" }]);
        const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
        const request = { sdkBackend: "claude", agentCommand: `/test/force-coalesce-${warmCache}` };
        if (warmCache) await listModels({ sender: {} }, request);

        let complete;
        let started;
        const entered = new Promise((resolve) => { started = resolve; });
        driver.listModels.mock.mockImplementation(() => {
          started();
          return new Promise((resolve) => { complete = resolve; });
        });
        const first = listModels({ sender: {} }, { ...request, force: warmCache });
        await entered;
        const second = listModels({ sender: {} }, { ...request, force: true });
        await Promise.resolve();
        assert.equal(driver.listModels.mock.callCount(), warmCache ? 2 : 1);

        const nextCatalog = [{ id: "new-model" }];
        complete(nextCatalog);
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.deepEqual(firstResult.models, nextCatalog);
        assert.deepEqual(secondResult, firstResult);
        assert.equal(firstResult.source, "live");
        assert.equal(driver.listModels.mock.callCount(), warmCache ? 2 : 1);
      } finally {
        cleanup();
      }
    });
  }
});

test("list-models cache hit replays the live provenance (source + fetchedAt)", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("claude");
    let calls = 0;
    t.mock.method(driver, "listModels", async () => {
      calls += 1;
      return [{ id: "claude-opus-5-5", name: "Opus 5.5" }];
    });
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
    const first = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/cache-hit" });
    assert.equal(first.source, "live");
    assert.match(first.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    // Second call is a pre-flight cache hit: same provenance, no re-fetch.
    const second = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/cache-hit" });
    assert.equal(calls, 1);
    assert.equal(second.source, "live");
    assert.equal(second.fetchedAt, first.fetchedAt);
  } finally {
    cleanup();
  }
});

test("list-models admits a current-only catalog by refreshing the persisted current id", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, catalogFile, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("claude");
    const liveCatalog = [{ id: "claude-opus-5-5", name: "Opus 5.5" }];
    t.mock.method(driver, "listModels", async () => liveCatalog);
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");

    // 1. Live success with models seeds the store (no current id yet).
    await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-current-only" });

    // 2. A current-only success (zero visible models, valid selection) must
    // refresh the persisted current id without losing the models list. A
    // non-force load now hydrates from the persisted entry (LKG-first), so
    // only the forced refresh reaches the live current-only result.
    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => ({
      currentModelId: "claude-opus-5-5",
      models: [],
    }));
    const currentOnly = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-current-only", force: true });
    assert.deepEqual(currentOnly, {
      ok: true,
      currentModelId: "claude-opus-5-5",
      models: [],
      source: "live",
      fetchedAt: currentOnly.fetchedAt,
    });
    const persisted = readLastKnownCatalogEntry(catalogFile, Object.keys(readLastKnownCatalogStore(catalogFile))[0]);
    assert.deepEqual(persisted.models, liveCatalog);
    assert.equal(persisted.currentModelId, "claude-opus-5-5");

    // 3. A later live failure serves the persisted selection and models.
    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => []);
    const failed = await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-current-only" });
    assert.equal(failed.ok, true);
    assert.equal(failed.source, "last-known-good");
    assert.equal(failed.currentModelId, "claude-opus-5-5");
    assert.deepEqual(failed.models, liveCatalog);
  } finally {
    cleanup();
  }
});

test("list-models normalizes a pre-filter current id when serving a mimo last-known-good catalog", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("mimo");
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
    // 1. Seed a success captured before the auto-channel normalization: the
    // persisted current id sits on the filtered `mimo` provider while the
    // model list does not.
    const preFilterCatalog = {
      currentModelId: "mimo/134qwerawdf",
      models: [
        { id: "xiaomi/mimo-v2.6-pro-ultraspeed", name: "MiMo-V2.6-Pro-UltraSpeed" },
        { id: "xiaomi/mimo-v2.6-flash", name: "MiMo-V2.6-Flash" },
      ],
    };
    t.mock.method(driver, "listModels", async () => preFilterCatalog);
    const seeded = await listModels({ sender: {} }, { sdkBackend: "mimo", agentCommand: "/test/lkg-mimo" });
    assert.equal(seeded.ok, true);
    assert.equal(seeded.currentModelId, "mimo/134qwerawdf");

    // 2. Live failure → the persisted catalog is served with the current id
    // normalized off the filtered channel.
    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => []);
    const failed = await listModels({ sender: {} }, { sdkBackend: "mimo", agentCommand: "/test/lkg-mimo" });
    assert.equal(failed.ok, true);
    assert.equal(failed.source, "last-known-good");
    assert.equal(failed.currentModelId, "xiaomi/mimo-v2.6-pro-ultraspeed");
    assert.equal(failed.models.some((model) => model.id === "mimo/134qwerawdf"), false);
  } finally {
    cleanup();
  }
});

test("list-models without a prior success keeps presets and never persists empty or corrupt stores", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, catalogFile, cleanup } = makeLastKnownCtx();
  try {
    t.mock.method(getDriver("claude"), "listModels", async () => []);
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
    const degraded = {
      ok: true,
      currentModelId: null,
      models: [],
      warning: "The live model catalog returned no models",
    };

    // No store file yet: plain presets fallback, and an empty live catalog
    // must not create the file.
    assert.deepEqual(
      await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-no-persist" }),
      degraded,
    );
    assert.equal(fs.existsSync(catalogFile), false);

    // A corrupt store must never crash the bridge: presets again.
    fs.writeFileSync(catalogFile, "{corrupt json");
    assert.deepEqual(
      await listModels({ sender: {} }, { sdkBackend: "claude", agentCommand: "/test/lkg-corrupt" }),
      degraded,
    );
  } finally {
    cleanup();
  }
});


test("Copilot catalogs separate supported GitHub credentials and profiles", () => {
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"]) {
    const key = buildSdkModelCacheKey("copilot", "/same/copilot", { [name]: "fixture-profile-a" });
    assert.notEqual(key, buildSdkModelCacheKey("copilot", "/same/copilot", { [name]: "fixture-profile-b" }), name);
    assert.doesNotMatch(key, /fixture-profile-a/);
  }
});


test("list-models persists a first current-only success for later failures", async (t) => {
  const { getDriver } = require("./index.cjs");
  const { handlers, ctx, cleanup } = makeLastKnownCtx();
  try {
    const driver = getDriver("opencode");
    t.mock.method(driver, "listModels", async () => ({ currentModelId: "custom/configured", models: [] }));
    const listModels = handlers.get("netcatty:ai:sdk-agent:list-models");
    const request = { sdkBackend: "opencode", agentCommand: "/test/first-current-only" };
    const live = await listModels({ sender: {} }, request);
    assert.deepEqual(live, {
      ok: true, currentModelId: "custom/configured", models: [], source: "live", fetchedAt: live.fetchedAt,
    });
    assert.ok(Number.isFinite(Date.parse(live.fetchedAt)));
    ctx.sdkModelCache.clear();
    driver.listModels.mock.mockImplementation(async () => []);
    const failed = await listModels({ sender: {} }, request);
    assert.equal(failed.source, "last-known-good");
    assert.equal(failed.currentModelId, "custom/configured");
    assert.deepEqual(failed.models, [{ id: "custom/configured", name: "custom/configured" }]);
  } finally {
    cleanup();
  }
});

test("SDK adapter passes a live privacy guard through asynchronous driver startup even when initially disabled", async () => {
  const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
  const privacy = createAiPrivacyService();
  let notifyReady;
  let release;
  let sent = false;
  const ready = new Promise((resolve) => { notifyReady = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createPrivacyStreamHarness(privacy, async (context) => {
    notifyReady();
    await gate;
    context.assertSessionValid();
    sent = true;
  });
  const run = h.stream();
  await ready;
  privacy.configure({ enabled: true });
  release();
  const result = await run;
  assert.equal(result.ok, false);
  assert.match(result.error, /start a new chat/);
  assert.equal(sent, false);
  assert.equal(h.ctx.sdkActiveStreams.size, 0);
});

test("delegated Agent entry rejects unverified runtimes and Skills before native/environment work", async () => {
  let validated = 0;
  const { handlers } = registerWithStubbedCtx({
    mcpServerBridge: {
      isPluginAgentConversation: () => true,
      assertPluginAgentCaller: () => {},
      getPluginAgentMcpConfiguration: () => { validated++; throw Error("No current delegation"); },
    },
  });
  const handler = handlers.get("netcatty:ai:sdk-agent:stream");
  for (const sdkBackend of ["codex", "copilot", "cursor", "codebuddy", "opencode", "grok", "mimo", "arbitrary-cli"]) {
    await assert.rejects(handler({ sender: { id: 7 } }, {
      requestId: "synthetic", chatSessionId: "plugin-agent:synthetic", sdkBackend, toolIntegrationMode: "mcp",
    }), /not eligible/);
  }
  await assert.rejects(handler({ sender: { id: 7 } }, {
    requestId: "synthetic", chatSessionId: "plugin-agent:synthetic", sdkBackend: "claude", toolIntegrationMode: "skills",
  }), /not eligible/);
  assert.equal(validated, 0);
  await assert.rejects(handler({ sender: { id: 7 } }, {
    requestId: "synthetic", chatSessionId: "plugin-agent:synthetic", sdkBackend: "claude", toolIntegrationMode: "mcp",
  }), /No current delegation/);
  assert.equal(validated, 1);
});

test("actual SDK entry derives delegated mode from main authority, ignoring caller flag spoofing", async (t) => {
  const { PluginAgentMcpDelegations } = require("../../../plugins/agent/mcpDelegation.cjs");
  const registry = new PluginAgentMcpDelegations(); t.after(() => registry.shutdown());
  const chat = "plugin-agent:11111111-1111-4111-8111-111111111111";
  const tag = "22222222-2222-4222-8222-222222222222";
  registry.register(chat, { turnTag: tag, senderId: 7, tools: [], assertCurrent() {}, dispatch() {} });
  const h = createPrivacyStreamHarness(createTestPrivacy(false));
  const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "netcatty-claude-flag-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  h.ctx.tempDirBridge = { getTempDir: () => directory };
  Object.assign(h.ctx.mcpServerBridge, {
    isPluginAgentConversation: (id) => registry.isReserved(id),
    assertPluginAgentCaller: (...args) => registry.assertCaller(...args),
    getPluginAgentMcpConfiguration: (...args) => registry.configuration(...args),
    onPluginAgentRelease: (...args) => registry.onRelease(...args),
  });
  const handler = h.handlers.get("netcatty:ai:sdk-agent:stream");
  const payload = { requestId: `plugin-agent_${tag}_fixture`, chatSessionId: chat, sdkBackend: "claude", toolIntegrationMode: "mcp", prompt: "Synthetic", delegatedAgent: false };
  assert.equal((await handler({ sender: { id: 7 } }, payload)).ok, true);
  assert.equal(h.turns[0].delegatedAgent, true, "caller cannot turn off delegated protection");
  assert.equal((await h.stream({ delegatedAgent: true })).ok, true);
  assert.equal(h.turns[1].delegatedAgent, false, "builtin caller cannot opt into the delegated branch");
  await assert.rejects(handler({ sender: { id: 99 } }, { ...payload, requestId: `plugin-agent_${tag}_foreign`, delegatedAgent: true }));
  assert.equal(h.turns.length, 2, "a spoofed flag cannot replace current sender/turn authority");
});

test("delegated native cancellation is exact-request and cannot mark replacement chat work cancelled", async () => {
  const broad = [];
  const { handlers, ctx } = registerWithStubbedCtx({ mcpServerBridge: {
    isPluginAgentConversation: () => true,
    assertPluginAgentCaller: () => {},
    setChatSessionCancelled: () => broad.push('chat'), cancelPtyExecsForSession: () => broad.push('pty'),
    clearPendingApprovals: () => broad.push('approval'), cancelWorkerBackgroundJobsForSession: () => broad.push('worker'),
  } });
  const first = new AbortController(); const second = new AbortController();
  const chat = 'plugin-agent:synthetic';
  ctx.sdkActiveStreams.set('native-a', first); ctx.sdkRequestSessions.set('native-a', chat);
  ctx.sdkRequestRuntimes.set('native-a', { delegationTag: 'tag-a', senderId: 7 });
  ctx.sdkActiveStreams.set('native-b', second); ctx.sdkRequestSessions.set('native-b', chat);
  ctx.sdkRequestRuntimes.set('native-b', { delegationTag: 'tag-b', senderId: 7 });
  const cancel = handlers.get('netcatty:ai:sdk-agent:cancel');
  assert.equal((await cancel({ sender: { id: 7 } }, { requestId: 'native-a', chatSessionId: chat })).ok, true);
  assert.equal(first.signal.aborted, true); assert.equal(second.signal.aborted, false);
  assert.equal((await cancel({ sender: { id: 7 } }, { requestId: '', chatSessionId: chat })).ok, false);
  assert.equal((await cancel({ sender: { id: 99 } }, { requestId: 'native-b', chatSessionId: chat })).ok, false);
  assert.equal(second.signal.aborted, false); assert.deepEqual(broad, []);
});

test("legacy chat-wide cleanup cannot abort replacement delegated turn B or remove its metadata", async () => {
  const effects = [];
  const { handlers, ctx } = registerWithStubbedCtx({ mcpServerBridge: {
    isPluginAgentConversation: (id) => id?.startsWith('plugin-agent:'),
    setChatSessionCancelled: () => effects.push('cancelled'), cancelPtyExecsForSession: () => effects.push('pty'),
    cancelWorkerBackgroundJobsForSession: () => effects.push('worker'), cleanupScopedMetadata: async () => effects.push('metadata'),
  } });
  const chat = 'plugin-agent:11111111-1111-4111-8111-111111111111';
  const replacement = new AbortController();
  ctx.sdkActiveStreams.set('native-b', replacement); ctx.sdkRequestSessions.set('native-b', chat);
  ctx.sdkRequestRuntimes.set('native-b', { backendKey: 'claude', delegationTag: 'turn-b', senderId: 7 });
  const result = await handlers.get('netcatty:ai:sdk-agent:cleanup')({ sender: { id: 7 } }, { chatSessionId: chat, delegationTag: 'turn-a' });
  assert.equal(replacement.signal.aborted, false); assert.equal(ctx.sdkActiveStreams.has('native-b'), true);
  assert.equal(ctx.sdkRequestSessions.get('native-b'), chat); assert.equal(ctx.sdkRequestRuntimes.get('native-b').delegationTag, 'turn-b');
  assert.deepEqual(effects, []); assert.equal(result.ok, false);
});

test("caller-supplied builtin chat cannot downgrade cancellation of a main-owned delegated request", async () => {
  const effects = []; const chat = 'plugin-agent:11111111-1111-4111-8111-111111111111';
  const { handlers, ctx } = registerWithStubbedCtx({ mcpServerBridge: {
    isPluginAgentConversation: (id) => id?.startsWith('plugin-agent:'),
    assertPluginAgentCaller: (id, sender, tag) => { if (id !== chat || sender !== 7 || tag !== 'turn-b') throw Error('Unavailable'); },
    setChatSessionCancelled: () => effects.push('cancelled'), cancelPtyExecsForSession: () => effects.push('pty'),
    clearPendingApprovals: () => effects.push('approval'), cancelWorkerBackgroundJobsForSession: () => effects.push('worker'),
  } });
  const replacement = new AbortController();
  ctx.sdkActiveStreams.set('native-b', replacement); ctx.sdkRequestSessions.set('native-b', chat);
  ctx.sdkRequestRuntimes.set('native-b', { backendKey: 'claude', delegationTag: 'turn-b', senderId: 7 });
  const cancel = handlers.get('netcatty:ai:sdk-agent:cancel');
  const result = await cancel({ sender: { id: 99 } }, { requestId: 'native-b', chatSessionId: 'builtin-chat' });
  assert.equal(replacement.signal.aborted, false); assert.equal(result.ok, false); assert.deepEqual(effects, []);
  assert.equal((await cancel({ sender: { id: 7 } }, { requestId: 'native-b', chatSessionId: chat })).ok, true);
  assert.equal(replacement.signal.aborted, true);
});
