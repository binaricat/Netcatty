const test = require("node:test");
const assert = require("node:assert/strict");

const { isLocalShellForegroundFromPs } = require("./terminalLocalForeground.cjs");

test("local shell foreground detection rejects active jobs even without job control", () => {
  assert.equal(isLocalShellForegroundFromPs([
    "100 1 Ss+ zsh",
    "101 100 S+ docker",
  ].join("\n"), 100), false);
  assert.equal(isLocalShellForegroundFromPs([
    "100 1 Ss zsh",
    "101 100 S+ docker",
  ].join("\n"), 100), false);
});

test("local shell foreground detection accepts idle and nested interactive shells", () => {
  assert.equal(isLocalShellForegroundFromPs("100 1 Ss+ zsh\n", 100), true);
  assert.equal(isLocalShellForegroundFromPs([
    "100 1 Ss zsh",
    "101 100 S+ bash",
  ].join("\n"), 100), true);
});
