const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSdkTurnPrompt,
  buildSdkModelCacheKey,
  buildSdkSessionKey,
  normalizeSdkListModelsResult,
  resolveSdkResumeSessionId,
  expireSiblingCursorCliModeSessions,
  resolveBackendKey,
  resolveSdkBackendBinPath,
  resolveSdkToolIntegrationMode,
  shouldCacheSdkRuntimeModels,
  shouldReplaySdkHistory,
} = require("./sdkStreamHandlers.cjs");

test("resolveBackendKey maps backend command/value to registry key", () => {
  assert.equal(resolveBackendKey("antigravity"), "antigravity");
  assert.equal(resolveBackendKey("claude"), "claude");
  assert.equal(resolveBackendKey("codex"), "codex");
  assert.equal(resolveBackendKey("copilot"), "copilot");
  assert.equal(resolveBackendKey("codebuddy"), "codebuddy");
  assert.equal(resolveBackendKey("opencode"), "opencode");
});

test("Antigravity always uses the scoped MCP tool path", () => {
  assert.equal(resolveSdkToolIntegrationMode("antigravity", "skills"), "mcp");
  assert.equal(resolveSdkToolIntegrationMode("antigravity", "mcp"), "mcp");
  assert.equal(resolveSdkToolIntegrationMode("claude", "skills"), "skills");
});

test("Antigravity does not replay history when a persisted SDK session resumes", () => {
  assert.equal(shouldReplaySdkHistory({
    backendKey: "antigravity",
    runtime: "sdk",
    resumeSessionId: "persisted-session",
    hasInMemorySession: false,
  }), false);
  assert.equal(shouldReplaySdkHistory({
    backendKey: "antigravity",
    runtime: "sdk",
    resumeSessionId: undefined,
    hasInMemorySession: false,
  }), true);
  assert.equal(shouldReplaySdkHistory({
    backendKey: "claude",
    runtime: "sdk",
    resumeSessionId: "persisted-session",
    hasInMemorySession: false,
  }), true);
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
