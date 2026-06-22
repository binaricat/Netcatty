const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSdkTurnPrompt,
  buildSdkModelCacheKey,
  buildSdkSessionKey,
  resolveSdkResumeSessionId,
  resolveBackendKey,
  resolveSdkBackendBinPath,
} = require("./sdkStreamHandlers.cjs");

test("resolveBackendKey maps backend command/value to registry key", () => {
  assert.equal(resolveBackendKey("claude"), "claude");
  assert.equal(resolveBackendKey("codex"), "codex");
  assert.equal(resolveBackendKey("copilot"), "copilot");
  assert.equal(resolveBackendKey("codebuddy"), "codebuddy");
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

test("SDK model cache keys include resolved CLI path", () => {
  assert.notEqual(
    buildSdkModelCacheKey("claude", "/usr/local/bin/claude"),
    buildSdkModelCacheKey("claude", "/opt/homebrew/bin/claude"),
  );
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
