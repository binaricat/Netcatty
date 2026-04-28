const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractTrailingIdlePrompt,
  isDefaultPowerShellPromptLine,
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

test("rejects `PS >` (literal `PS` + space + `>`) so spoofed scripts can't masquerade as a default prompt", () => {
  // Default PowerShell never emits this shape; rejecting it makes the
  // override harder to coerce via printed output.
  assert.equal(extractTrailingIdlePrompt("welcome\r\nPS >"), "");
});

test("treats CR repaints as line breaks so only the redrawn line is captured", () => {
  // PSReadLine / ConPTY emit bare `\r` to repaint the current line. The
  // captured prompt must equal the visible last line, not the
  // concatenation of every overwritten frame, so hasExpectedPromptSuffix
  // can still match the live PTY tail later.
  assert.equal(
    extractTrailingIdlePrompt("PS C:\\old>\rPS C:\\new>"),
    "PS C:\\new>",
  );
});

test("isDefaultPowerShellPromptLine matches default shapes and rejects look-alikes", () => {
  assert.equal(isDefaultPowerShellPromptLine("PS C:\\Users\\alice>"), true);
  assert.equal(isDefaultPowerShellPromptLine("PS /home/alice>"), true);
  assert.equal(isDefaultPowerShellPromptLine("PS>"), true);
  assert.equal(isDefaultPowerShellPromptLine("PS >"), false);
  assert.equal(isDefaultPowerShellPromptLine("PSO>"), false);
  assert.equal(isDefaultPowerShellPromptLine("ZIPS>"), false);
  assert.equal(isDefaultPowerShellPromptLine(""), false);
  assert.equal(isDefaultPowerShellPromptLine(null), false);
});

test("tracks PowerShell idle prompt after SSH output", () => {
  const session = {};

  const prompt = trackSessionIdlePrompt(session, "Last login...\r\nPS C:\\Windows\\System32>");

  assert.equal(prompt, "PS C:\\Windows\\System32>");
  assert.equal(session.lastIdlePrompt, "PS C:\\Windows\\System32>");
  assert.equal(typeof session.lastIdlePromptAt, "number");
});
