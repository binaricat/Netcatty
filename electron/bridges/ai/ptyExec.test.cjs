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

test("recognizes a PowerShell prompt that has trailing whitespace", () => {
  assert.equal(
    resolveEffectiveShellKind("posix", "PS C:\\Users\\alice>   "),
    "powershell",
  );
});

test("recognizes a bare PowerShell prompt without a working directory", () => {
  assert.equal(
    resolveEffectiveShellKind("posix", "PS>"),
    "powershell",
  );
});

test("ignores ANSI-coloured PowerShell prompts when detecting the shell", () => {
  assert.equal(
    resolveEffectiveShellKind("posix", "[32mPS C:\\Users\\alice>[0m"),
    "powershell",
  );
});

test("keeps the configured shell kind when the prompt is not PowerShell", () => {
  assert.equal(
    resolveEffectiveShellKind("fish", "alice@macbook ~ %"),
    "fish",
  );
});

test("falls back to posix when neither shell kind nor prompt is informative", () => {
  assert.equal(resolveEffectiveShellKind(undefined, ""), "posix");
  assert.equal(resolveEffectiveShellKind(null, undefined), "posix");
});

test("does not misclassify command output that happens to contain 'PS'", () => {
  assert.equal(resolveEffectiveShellKind("posix", "PSO>"), "posix");
  assert.equal(resolveEffectiveShellKind("posix", "ZIPS>"), "posix");
});
