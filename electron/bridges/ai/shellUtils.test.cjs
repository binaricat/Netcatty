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

test("tracks PowerShell idle prompt after SSH output", () => {
  const session = {};

  const prompt = trackSessionIdlePrompt(session, "Last login...\r\nPS C:\\Windows\\System32>");

  assert.equal(prompt, "PS C:\\Windows\\System32>");
  assert.equal(session.lastIdlePrompt, "PS C:\\Windows\\System32>");
  assert.equal(typeof session.lastIdlePromptAt, "number");
});
