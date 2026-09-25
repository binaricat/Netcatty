const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDriver,
  listBackends,
  hasCodebuddyQueryOnlyOptions,
} = require("./index.cjs");
const { codebuddySessionManager } = require("./codebuddySessionManager.cjs");

test("registry exposes SDK backends", () => {
  assert.deepEqual(listBackends().sort(), ["claude", "codebuddy", "codex", "copilot", "cursor", "grok", "mimo", "opencode"]);
});

test("getDriver returns a driver with runTurn", () => {
  for (const key of ["claude", "codebuddy", "codex", "copilot", "cursor", "grok", "mimo", "opencode"]) {
    const d = getDriver(key);
    assert.equal(typeof d.runTurn, "function", `${key} must expose runTurn`);
  }
});

test("getDriver throws on unknown backend", () => {
  assert.throws(() => getDriver("gemini"), /No SDK driver registered for backend: gemini/);
});

test("SDK drivers expose listModels; codex returns [] (no catalog)", async () => {
  for (const key of ["claude", "codebuddy", "codex", "copilot", "cursor", "grok", "mimo", "opencode"]) {
    assert.equal(typeof getDriver(key).listModels, "function", `${key} must expose listModels`);
  }
  assert.deepEqual(await getDriver("codex").listModels({}), []);
});

test("CodeBuddy keeps V2 for SessionOptions fields and falls back for query-only fields", () => {
  assert.equal(hasCodebuddyQueryOnlyOptions({
    agents: { reviewer: { description: "Reviews changes", prompt: "Review" } },
    thinking: { type: "adaptive" },
    effort: "high",
  }), false);
  assert.equal(hasCodebuddyQueryOnlyOptions({ maxBudgetUsd: 1 }), true);
  assert.equal(hasCodebuddyQueryOnlyOptions({ sandbox: { enabled: true } }), true);
  assert.equal(hasCodebuddyQueryOnlyOptions({ sandbox: { enabled: false } }), false);
  assert.equal(hasCodebuddyQueryOnlyOptions({ fallbackModel: "fallback" }), true);
  assert.equal(hasCodebuddyQueryOnlyOptions({ enableFileCheckpointing: false }), false);
  assert.equal(hasCodebuddyQueryOnlyOptions({ outputFormat: { type: "json_schema" } }), true);
});

test("CodeBuddy forwards the explicit bypass opt-in to V2 sessions", async () => {
  const originalRunTurn = codebuddySessionManager.runTurn;
  let capturedSessionOptions;
  codebuddySessionManager.runTurn = async ({ sessionOptions }) => {
    capturedSessionOptions = sessionOptions;
    return { sessionId: "v2-session", usedV2: true };
  };

  try {
    const result = await getDriver("codebuddy").runTurn({
      chatSessionId: "chat-1",
      prompt: "hello",
      attachments: [],
      cwd: "/tmp",
      env: {},
      injectedMcpServers: [],
      permissionMode: "auto",
      toolIntegrationMode: "mcp",
      emitter: {},
    });

    assert.deepEqual(capturedSessionOptions.extraArgs, {
      "dangerously-skip-permissions": null,
    });
    assert.equal(capturedSessionOptions.permissionMode, "bypassPermissions");
    assert.deepEqual(capturedSessionOptions.settingSources, []);
    assert.deepEqual(result, { sessionId: "v2-session", usedV2: true });
  } finally {
    codebuddySessionManager.runTurn = originalRunTurn;
  }
});
