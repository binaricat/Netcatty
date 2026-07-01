const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appendCodexChatGptValidationFailure,
  extractCodexError,
  isCodexAuthError,
  normalizeCodexIntegrationState,
} = require("./codexHelpers.cjs");

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
