const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractTrailingIdlePrompt,
  getFreshIdlePrompt,
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

test("getFreshIdlePrompt returns the cached prompt when the live tail still ends with it", () => {
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "Microsoft Windows...\r\nPS C:\\Users\\alice>",
  };
  assert.equal(getFreshIdlePrompt(session), "PS C:\\Users\\alice>");
});

test("getFreshIdlePrompt drops a stale prompt when the live tail has moved on (e.g. exited PowerShell)", () => {
  // Simulates: SSH session entered PowerShell, captured `PS C:\>`, then
  // user `exit`-ed back into a shell with a custom prompt the regex
  // doesn't recognize. lastIdlePrompt is still the old PS line, but the
  // visible tail now shows the new prompt — we must NOT keep handing
  // the stale value to resolveEffectiveShellKind.
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "PS C:\\Users\\alice>\r\nexit\r\nlogout\r\n❯ ",
  };
  assert.equal(getFreshIdlePrompt(session), "");
});

test("getFreshIdlePrompt drops a stale prompt when the live tail switched to cmd.exe", () => {
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "PS C:\\Users\\alice>\r\ncmd\r\nMicrosoft Windows...\r\nC:\\Users\\alice>",
  };
  assert.equal(getFreshIdlePrompt(session), "");
});

test("getFreshIdlePrompt tolerates ANSI colour codes that wrap the prompt in either side", () => {
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "stuff\r\n[32mPS C:\\Users\\alice>[0m",
  };
  assert.equal(getFreshIdlePrompt(session), "PS C:\\Users\\alice>");
});

test("getFreshIdlePrompt returns empty string when the session has no cached prompt or tail", () => {
  assert.equal(getFreshIdlePrompt(null), "");
  assert.equal(getFreshIdlePrompt(undefined), "");
  assert.equal(getFreshIdlePrompt({}), "");
  assert.equal(getFreshIdlePrompt({ lastIdlePrompt: "PS C:\\>" }), "");
  assert.equal(
    getFreshIdlePrompt({ lastIdlePrompt: "", _promptTrackTail: "anything" }),
    "",
  );
});

test("getFreshIdlePrompt and trackSessionIdlePrompt round-trip through a real PTY-like flow", () => {
  // (1) Remote PowerShell prompt arrives — lastIdlePrompt is captured.
  const session = {};
  trackSessionIdlePrompt(session, "Microsoft Windows...\r\nPS C:\\Users\\alice>");
  assert.equal(getFreshIdlePrompt(session), "PS C:\\Users\\alice>");

  // (2) User runs `exit` and the shell now shows an unrecognized prompt.
  // trackSessionIdlePrompt does not update lastIdlePrompt (the new shape
  // doesn't match POSIX or PowerShell regexes), so the cache is stale.
  trackSessionIdlePrompt(session, "\r\nexit\r\nlogout\r\n❯ ");
  assert.equal(session.lastIdlePrompt, "PS C:\\Users\\alice>"); // unchanged
  // The freshness check rescues us: the visible tail no longer ends
  // with the cached PS line, so downstream wrapper selection sees "".
  assert.equal(getFreshIdlePrompt(session), "");
});
