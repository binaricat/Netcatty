const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractTrailingIdlePrompt,
  trackSessionIdlePrompt,
} = require("./shellUtils.cjs");

test("extracts a trailing PowerShell idle prompt", () => {
  assert.equal(
    extractTrailingIdlePrompt("Microsoft Windows...\r\nPS C:\\Users\\alice>"),
    "PS C:\\Users\\alice>",
  );
});

test("preserves trailing whitespace on a captured PowerShell prompt", () => {
  // The wrapper-selection logic trims this, but the suffix-match logic in
  // hasExpectedPromptSuffix() compares against raw PTY bytes, so the trailing
  // space PowerShell emits after `>` must round-trip unchanged.
  assert.equal(
    extractTrailingIdlePrompt("Microsoft Windows...\r\nPS C:\\Users\\alice> "),
    "PS C:\\Users\\alice> ",
  );
});

test("extracts a bare PowerShell prompt with no working directory", () => {
  assert.equal(extractTrailingIdlePrompt("welcome\r\nPS>"), "PS>");
});

test("does not extract content that merely looks PowerShell-ish", () => {
  // Any non-prompt output ending in `PSO>` or `ZIPS>` would have produced a
  // trailing newline before the next prompt; this guards against the regex
  // accidentally matching command output that just happens to contain "PS".
  assert.equal(extractTrailingIdlePrompt("nope\r\nPSO>"), "");
  assert.equal(extractTrailingIdlePrompt("nope\r\nZIPS>"), "");
});

test("tracks PowerShell idle prompt after SSH output", () => {
  const session = {};

  const prompt = trackSessionIdlePrompt(session, "Last login...\r\nPS C:\\Windows\\System32>");

  assert.equal(prompt, "PS C:\\Windows\\System32>");
  assert.equal(session.lastIdlePrompt, "PS C:\\Windows\\System32>");
  assert.equal(typeof session.lastIdlePromptAt, "number");
});
