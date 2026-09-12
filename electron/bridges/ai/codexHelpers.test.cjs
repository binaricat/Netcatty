const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_CODEX_LOGIN_OUTPUT_CHARS,
  MAX_CODEX_LOGIN_OUTPUT_BYTES,
  MAX_CODEX_LOGIN_TERMINAL_SESSIONS,
  CODEX_LOGIN_KILL_GRACE_MS,
  appendCodexLoginOutput,
  createCodexLoginOutputDecoder,
  appendCodexChatGptValidationFailure,
  codexLoginSessions,
  extractCodexError,
  isCodexAuthError,
  normalizeCodexIntegrationState,
  readCodexCustomProviderConfig,
  recordCodexLoginSession,
  stopCodexLoginProcess,
} = require("./codexHelpers.cjs");

test("Codex login output keeps a bounded tail", () => {
  const session = { output: "", url: null };

  appendCodexLoginOutput(session, "a".repeat(MAX_CODEX_LOGIN_OUTPUT_CHARS));
  appendCodexLoginOutput(session, "tail-marker");

  assert.equal(session.output.length, MAX_CODEX_LOGIN_OUTPUT_CHARS);
  assert.match(session.output, /tail-marker$/);
});

test("Codex login output limit is measured in UTF-8 bytes without cutting characters", () => {
  const session = { output: "", url: null };
  appendCodexLoginOutput(session, "中".repeat(MAX_CODEX_LOGIN_OUTPUT_BYTES));

  assert.ok(Buffer.byteLength(session.output, "utf8") <= MAX_CODEX_LOGIN_OUTPUT_BYTES);
  assert.doesNotMatch(session.output, /�/u);
  assert.match(session.output, /^中+$/u);
});

test("Codex login stdout and stderr decode split UTF-8 independently when interleaved", () => {
  const session = { output: "", url: null };
  const stdout = createCodexLoginOutputDecoder(session);
  const stderr = createCodexLoginOutputDecoder(session);
  const outBytes = Buffer.from("中文", "utf8");
  const errBytes = Buffer.from("错误", "utf8");
  stdout.write(outBytes.subarray(0, 2));
  stderr.write(errBytes.subarray(0, 1));
  stdout.write(outBytes.subarray(2));
  stderr.write(errBytes.subarray(1));
  stdout.end();
  stderr.end();

  assert.equal(session.output, "中文错误");
});

test("Codex login history retains only bounded terminal sessions", (t) => {
  t.after(() => codexLoginSessions.clear());
  codexLoginSessions.clear();
  recordCodexLoginSession({ id: "running", state: "running", process: { killed: false } });

  for (let index = 0; index < MAX_CODEX_LOGIN_TERMINAL_SESSIONS + 3; index += 1) {
    recordCodexLoginSession({ id: `done-${index}`, state: "success", process: null });
  }

  assert.equal(codexLoginSessions.has("running"), true);
  assert.equal(codexLoginSessions.has("done-0"), false);
  assert.equal(codexLoginSessions.size, MAX_CODEX_LOGIN_TERMINAL_SESSIONS + 1);
});

test("a newly completed Codex login remains available while older records are pruned", (t) => {
  t.after(() => codexLoginSessions.clear());
  codexLoginSessions.clear();
  for (let index = 0; index < MAX_CODEX_LOGIN_TERMINAL_SESSIONS; index += 1) {
    recordCodexLoginSession({ id: `old-${index}`, state: "success", process: null });
  }
  const current = { id: "current", state: "running", process: { killed: false } };
  recordCodexLoginSession(current);

  current.state = "success";
  current.process = null;
  recordCodexLoginSession(current);

  assert.equal(codexLoginSessions.size, MAX_CODEX_LOGIN_TERMINAL_SESSIONS);
  assert.equal(codexLoginSessions.has("current"), true);
  assert.equal(codexLoginSessions.has("old-0"), false);
});

test("live cancelled login processes stay tracked until they close", (t) => {
  t.after(() => codexLoginSessions.clear());
  codexLoginSessions.clear();
  for (let index = 0; index < MAX_CODEX_LOGIN_TERMINAL_SESSIONS + 2; index += 1) {
    recordCodexLoginSession({
      id: `cancelled-${index}`,
      state: "cancelled",
      process: { kill() {} },
    });
  }

  assert.equal(codexLoginSessions.size, MAX_CODEX_LOGIN_TERMINAL_SESSIONS + 2);
});

test("Codex login cancellation escalates from TERM to KILL", () => {
  const signals = [];
  const scheduled = [];
  let escalate;
  const session = {
    process: { kill: (signal) => signals.push(signal) },
    killTimer: null,
  };
  stopCodexLoginProcess(session, {
    setTimeoutFn: (callback, delay) => {
      scheduled.push(delay);
      escalate = callback;
      return { unref() {} };
    },
  });
  escalate();

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(scheduled, [CODEX_LOGIN_KILL_GRACE_MS]);
});

test("normalizeCodexIntegrationState recognizes ChatGPT login status", () => {
  assert.equal(
    normalizeCodexIntegrationState("Logged in using ChatGPT"),
    "connected_chatgpt",
  );
});

test("appendCodexChatGptValidationFailure preserves the login status output", () => {
  const output = appendCodexChatGptValidationFailure(
    "Logged in using ChatGPT",
    "SDK probe failed",
  );

  assert.match(output, /Logged in using ChatGPT/);
  assert.match(output, /ChatGPT auth validation failed:/);
  assert.match(output, /SDK probe failed/);
  assert.equal(normalizeCodexIntegrationState(output), "connected_chatgpt");
});

test("isCodexAuthError recognizes auth failures stored in error text", () => {
  assert.equal(
    isCodexAuthError({ ok: false, error: "401 Unauthorized: authentication required" }),
    true,
  );
});

test("extractCodexError preserves nested error object messages", () => {
  const normalized = extractCodexError({
    error: {
      code: "model_not_found",
      message: "Model gpt-test is not available",
    },
  });

  assert.deepEqual(normalized, {
    message: "Model gpt-test is not available",
    code: "model_not_found",
  });
});

test("extractCodexError stringifies unknown object errors instead of [object Object]", () => {
  const normalized = extractCodexError({
    status: 400,
    detail: "Bad request",
  });

  assert.equal(normalized.message, '{"status":400,"detail":"Bad request"}');
  assert.equal(normalized.code, undefined);
});

test("extractCodexError handles circular structured errors", () => {
  const error = { status: 500 };
  error.self = error;

  const normalized = extractCodexError(error);

  assert.equal(normalized.message, '{"status":500,"self":"[Circular]"}');
});

test("readCodexCustomProviderConfig parses a switcher-style third-party config.toml", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-config-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tempDir, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, ".codex", "config.toml"),
    [
      'model_provider = "ccs"',
      'model = "glm-5"',
      "",
      "[model_providers.ccs]",
      'name = "Coding Plan"',
      'base_url = "https://example.invalid/v1"',
      'wire_api = "responses"',
      'env_key = "CODING_PLAN_API_KEY"',
      "",
    ].join("\n"),
    "utf8",
  );

  const config = readCodexCustomProviderConfig({
    HOME: tempDir,
    CODING_PLAN_API_KEY: "not-a-real-secret-just-presence",
  });

  assert.equal(config?.providerName, "ccs");
  assert.equal(config?.displayName, "Coding Plan");
  assert.equal(config?.baseUrl, "https://example.invalid/v1");
  assert.equal(config?.model, "glm-5");
  assert.equal(config?.envKey, "CODING_PLAN_API_KEY");
  assert.equal(config?.envKeyPresent, true);
});

test("readCodexCustomProviderConfig returns null for the default openai provider", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-config-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tempDir, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, ".codex", "config.toml"),
    'model_provider = "openai"\n',
    "utf8",
  );

  assert.equal(readCodexCustomProviderConfig({ HOME: tempDir }), null);
});

test("readCodexCustomProviderConfig honors CODEX_HOME over ~/.codex", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-home-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // An unrelated config in the default home must be ignored when CODEX_HOME
  // points elsewhere.
  fs.mkdirSync(path.join(tempDir, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, ".codex", "config.toml"),
    'model_provider = "stale"\n\n[model_providers.stale]\nname = "Stale"\n',
    "utf8",
  );

  const codexHome = path.join(tempDir, "custom-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      'model_provider = "ccs"',
      'model = "glm-5"',
      "",
      "[model_providers.ccs]",
      'name = "Coding Plan"',
      'base_url = "https://example.invalid/v1"',
      'env_key = "CODING_PLAN_API_KEY"',
      "",
    ].join("\n"),
    "utf8",
  );

  const config = readCodexCustomProviderConfig({
    HOME: tempDir,
    CODEX_HOME: codexHome,
    CODING_PLAN_API_KEY: "not-a-real-secret-just-presence",
  });

  assert.equal(config?.providerName, "ccs");
  assert.equal(config?.model, "glm-5");
});
