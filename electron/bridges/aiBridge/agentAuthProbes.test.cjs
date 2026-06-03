const test = require("node:test");
const assert = require("node:assert/strict");
const {
  probeClaudeAuth, probeCopilotAuth, probeCodexAuth,
} = require("./agentAuthProbes.cjs");

test("probeClaudeAuth: env ANTHROPIC_API_KEY -> authenticated env", () => {
  const r = probeClaudeAuth({
    env: { ANTHROPIC_API_KEY: "sk-x" },
    platform: "darwin",
    runSecurity: () => { throw new Error("should not be called"); },
    fileExists: () => false,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "env");
});

test("probeClaudeAuth: macOS keychain hit -> authenticated keychain", () => {
  const r = probeClaudeAuth({
    env: {},
    platform: "darwin",
    runSecurity: () => ({ exitCode: 0, stdout: '{"claudeAiOauth":{}}' }),
    fileExists: () => false,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "keychain");
});

test("probeClaudeAuth: linux credentials file -> authenticated credentials-file", () => {
  const r = probeClaudeAuth({
    env: {},
    platform: "linux",
    runSecurity: () => { throw new Error("no keychain on linux"); },
    fileExists: (p) => p.endsWith(".credentials.json"),
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "credentials-file");
});

test("probeClaudeAuth: nothing -> not authenticated", () => {
  const r = probeClaudeAuth({
    env: {}, platform: "darwin",
    runSecurity: () => ({ exitCode: 44, stdout: "" }),
    fileExists: () => false,
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCopilotAuth: gh auth status exit 0 -> authenticated gh", () => {
  const r = probeCopilotAuth({ runGhAuthStatus: () => ({ exitCode: 0, stderr: "Logged in to github.com" }) });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "gh");
});

test("probeCopilotAuth: gh auth status non-zero -> not authenticated", () => {
  const r = probeCopilotAuth({ runGhAuthStatus: () => ({ exitCode: 1, stderr: "not logged in" }) });
  assert.equal(r.authenticated, false);
});

test("probeCodexAuth: 'Logged in using ChatGPT' -> authenticated chatgpt", () => {
  const r = probeCodexAuth({
    runLoginStatus: () => ({ exitCode: 0, stdout: "Logged in using ChatGPT" }),
    fileExists: () => false,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "chatgpt");
});

test("probeCodexAuth: auth.json fallback -> authenticated auth-file", () => {
  const r = probeCodexAuth({
    runLoginStatus: () => ({ exitCode: 1, stdout: "not logged in" }),
    fileExists: (p) => p.endsWith("auth.json"),
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "auth-file");
});
