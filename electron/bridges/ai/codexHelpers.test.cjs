const test = require("node:test");
const assert = require("node:assert/strict");

const { extractCodexError } = require("./codexHelpers.cjs");

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
