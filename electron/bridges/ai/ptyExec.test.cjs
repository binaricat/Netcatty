const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveEffectiveShellKind,
} = require("./ptyExec.cjs");

test("uses PowerShell wrapping when a POSIX session is now at a PowerShell prompt", () => {
  assert.equal(
    resolveEffectiveShellKind("posix", "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("keeps the configured shell kind when the prompt is not PowerShell", () => {
  assert.equal(
    resolveEffectiveShellKind("fish", "alice@macbook ~ %"),
    "fish",
  );
});
