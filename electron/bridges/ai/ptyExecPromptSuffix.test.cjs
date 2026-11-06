"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hasExpectedPromptSuffix } = require("./ptyExecHelpers.cjs");
const { extractTrailingIdlePrompt, stripAnsi } = require("./shellUtils.cjs");

// The behaviour before the tail window was introduced: normalise the whole
// text, then compare its end.
function referenceHasExpectedPromptSuffix(text, expectedPrompt) {
  if (!expectedPrompt) return false;
  const normalizedText = stripAnsi(String(text || "")).replace(/\r/g, "");
  const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
  return !!normalizedPrompt && normalizedText.endsWith(normalizedPrompt);
}

const COLORED_PROMPT = "\x1b[01;32mroot@3160T\x1b[00m:\x1b[01;34m~\x1b[00m# ";

const CASES = [
  ["plain prompt at the end", "output\r\nroot@3160T:~# ", "root@3160T:~# "],
  ["prompt not at the end", "root@3160T:~# ls\r\nfile\r\n", "root@3160T:~# "],
  ["colored prompt in the text, plain expected", `out\r\n${COLORED_PROMPT}`, "root@3160T:~# "],
  ["colored prompt on both sides", `out\r\n${COLORED_PROMPT}`, COLORED_PROMPT],
  ["carriage returns inside the prompt", "out\r\nroot@3160T:~\r# ", "root@3160T:~# "],
  ["empty text", "", "root@3160T:~# "],
  ["empty expected prompt", "root@3160T:~# ", ""],
  ["null inputs", null, null],
  ["text shorter than the prompt", "~# ", "root@3160T:~# "],
];

for (const [name, text, prompt] of CASES) {
  test(`prompt suffix matches the full-text result: ${name}`, () => {
    assert.equal(hasExpectedPromptSuffix(text, prompt), referenceHasExpectedPromptSuffix(text, prompt));
  });
}

test("prompt suffix is found after a very large flood of CRLF output", () => {
  const flood = "y\r\n".repeat(700_000);
  assert.equal(hasExpectedPromptSuffix(`${flood}root@3160T:~# `, "root@3160T:~# "), true);
  assert.equal(hasExpectedPromptSuffix(`${flood}root@3160T:~# x`, "root@3160T:~# "), false);
  assert.equal(hasExpectedPromptSuffix(`${flood}${COLORED_PROMPT}`, "root@3160T:~# "), true);
});

test("macOS zsh default prompt suffix matches only when the prompt is idle", () => {
  const prompt = "hexiao@JosephdeMacBook-Pro-2 ~ % ";
  assert.equal(hasExpectedPromptSuffix(`Last login\r\n${prompt}`, prompt), true);
  assert.equal(hasExpectedPromptSuffix(`Last login\r\n${prompt}echo hello`, prompt), false);
  assert.equal(
    hasExpectedPromptSuffix(`Last login\r\n${prompt}`, "hexiao@JosephdeMacBook-Pro-2 ~ %"),
    false,
  );
});

test("live PTY CR bytes match a cached two-line idle prompt", () => {
  // Bash writes the PS1 newline as CR and ONLCR adds another, so the bytes
  // are `\r\r\n`. The idle-prompt cache keeps those as blank lines. Suffix
  // matching has to accept that form; stripping CR down to one LF does not.
  const live = "user@host: /workspace\r\r\n$ ";
  const cached = extractTrailingIdlePrompt(`welcome\r\n${live}`);
  assert.equal(cached, "user@host: /workspace\n\n\n$ ");
  const matchLive = hasExpectedPromptSuffix(live, cached);
  assert.equal(matchLive, true);
  assert.equal(hasExpectedPromptSuffix(`hostname\r\nbox\r\n${live}`, cached), true);
  assert.equal(
    hasExpectedPromptSuffix("\x1b[?2004huser@host: /workspace\r\r\n$ ", cached),
    true,
  );

  const rootLive = "user@host: /root\r\r\n# ";
  const rootCached = extractTrailingIdlePrompt(rootLive);
  assert.equal(rootCached, "user@host: /root\n\n\n# ");
  assert.equal(hasExpectedPromptSuffix(rootLive, rootCached), true);

  // Readiness for a real LF two-line prompt still matches, and a bare
  // `$`/`#` is neither this prompt nor a POSIX prompt on its own.
  const lfCached = extractTrailingIdlePrompt("welcome\r\nuser@host: /workspace\n$ ");
  assert.equal(lfCached, "user@host: /workspace\n$ ");
  assert.equal(hasExpectedPromptSuffix("user@host: /workspace\n$ ", lfCached), true);
  assert.equal(hasExpectedPromptSuffix("output\r\n$ ", cached), false);
  assert.equal(hasExpectedPromptSuffix("$ ", cached), false);
  assert.equal(hasExpectedPromptSuffix("# ", rootCached), false);
  assert.equal(extractTrailingIdlePrompt("$ "), "");
  assert.equal(extractTrailingIdlePrompt("# "), "");
});

test("prompt suffix check does not scan the whole buffer on every call", () => {
  // 2M characters of CRLF output used to cost seconds per call because every
  // call stripped ANSI and carriage returns over the entire text.
  const flood = "y\r\n".repeat(700_000);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50; i += 1) hasExpectedPromptSuffix(flood, "root@3160T:~# ");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `50 checks took ${elapsedMs.toFixed(0)} ms`);
});
