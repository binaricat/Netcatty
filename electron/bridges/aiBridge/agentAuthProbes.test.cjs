const test = require("node:test");
const assert = require("node:assert/strict");
const {
  probeClaudeAuth, probeCopilotAuth, probeCodexAuth, probeCodebuddyAuth, probeCursorCliAuth, probeGrokAuth,
  parseCursorStatusJson, resolveCursorCliSpawnSpec,
} = require("./agentAuthProbes.cjs");
const { prepareCommandForSpawn } = require("../ai/shellUtils.cjs");
const { resolveCursorCliSpawnSpec: resolveSharedCursorCliSpawnSpec } = require("./cursorCliSpawn.cjs");

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

// ── CodeBuddy ──
test("probeCodebuddyAuth: CODEBUDDY_API_KEY env -> authenticated api-key", () => {
  const r = probeCodebuddyAuth({
    env: { CODEBUDDY_API_KEY: "cb-key-123" },
    readFile: () => null,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "api-key");
});

test("probeCodebuddyAuth: CODEBUDDY_AUTH_TOKEN env -> authenticated auth-token", () => {
  const r = probeCodebuddyAuth({
    env: { CODEBUDDY_AUTH_TOKEN: "oauth-token-xyz" },
    readFile: () => null,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "auth-token");
});

test("probeCodebuddyAuth: settings.json with authToken -> authenticated settings-file", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => '{"authToken":"real-token"}',
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "settings-file");
});

test("probeCodebuddyAuth: settings.json with apiKeyHelper -> authenticated settings-file", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => '{"apiKeyHelper":"/usr/local/bin/helper"}',
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "settings-file");
});

test("probeCodebuddyAuth: empty settings.json -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => "",
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: malformed JSON in settings.json -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => "{not valid json",
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: settings.json without auth fields -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => '{"theme":"dark","language":"en"}',
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: no env, no settings file -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => null,
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: CODEBUDDY_API_KEY takes precedence over settings.json", () => {
  const r = probeCodebuddyAuth({
    env: { CODEBUDDY_API_KEY: "cb-key" },
    readFile: () => '{"authToken":"token"}',
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "api-key");
});

// ── Cursor CLI login ──
test("probeCursorCliAuth: prefers cursor-agent and parses authenticated JSON", () => {
  const calls = [];
  const r = probeCursorCliAuth({
    env: { CURSOR_API_KEY: "should-be-stripped" },
    resolveBinary: (name) => {
      calls.push(name);
      return name === "cursor-agent" ? "/bin/cursor-agent" : null;
    },
    runStatus: (bin) => {
      assert.equal(bin, "/bin/cursor-agent");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "authenticated",
          isAuthenticated: true,
          userInfo: { email: "user@example.com" },
        }),
      };
    },
  });
  assert.deepEqual(calls, ["cursor-agent"]);
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "cli-login");
  assert.equal(r.email, "user@example.com");
  assert.equal(r.binPath, "/bin/cursor-agent");
});

test("probeCursorCliAuth: does not fall back to bare agent binary", () => {
  const statusCalls = [];
  const resolveCalls = [];
  const r = probeCursorCliAuth({
    resolveBinary: (name) => {
      resolveCalls.push(name);
      return name === "agent" ? "/bin/agent" : null;
    },
    runStatus: (bin) => {
      statusCalls.push(bin);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ isAuthenticated: true, userInfo: { email: "a@b.c" } }),
      };
    },
  });
  assert.deepEqual(resolveCalls, ["cursor-agent"]);
  assert.deepEqual(statusCalls, []);
  assert.equal(r.authenticated, false);
  assert.equal(r.binPath, null);
});

// ── Grok Build ──
test("probeGrokAuth: env XAI_API_KEY -> authenticated env", () => {
  const r = probeGrokAuth({
    env: { XAI_API_KEY: "xai-test" },
    fileExists: () => false,
    homeDir: "/home/user",
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "env");
});

test("probeGrokAuth: auth.json fallback -> authenticated auth-file", () => {
  const path = require("node:path");
  const homeDir = path.join("home", "user");
  const authPath = path.join(homeDir, ".grok", "auth.json");
  const r = probeGrokAuth({
    env: {},
    homeDir,
    fileExists: (p) => p === authPath,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "auth-file");
});

test("probeGrokAuth: nothing -> not authenticated", () => {
  const r = probeGrokAuth({
    env: {},
    homeDir: "/home/user",
    fileExists: () => false,
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCursorCliAuth: unauthenticated JSON -> not authenticated but keeps binPath", () => {
  const r = probeCursorCliAuth({
    resolveBinary: (name) => (name === "cursor-agent" ? "/bin/cursor-agent" : null),
    runStatus: () => ({
      exitCode: 0,
      stdout: JSON.stringify({ isAuthenticated: false }),
    }),
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
  assert.equal(r.binPath, "/bin/cursor-agent");
});

test("probeCursorCliAuth: missing binary -> not authenticated", () => {
  const r = probeCursorCliAuth({
    resolveBinary: () => null,
    runStatus: () => { throw new Error("should not run"); },
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.binPath, null);
});

test("probeCursorCliAuth: status command failure -> not authenticated", () => {
  const r = probeCursorCliAuth({
    resolveBinary: () => "/bin/cursor-agent",
    runStatus: () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.binPath, "/bin/cursor-agent");
});

test("probeCursorCliAuth: unrecognized status stdout keeps resolved binPath", () => {
  const r = probeCursorCliAuth({
    resolveBinary: () => "/bin/cursor-agent",
    runStatus: () => ({ exitCode: 0, stdout: "cursor-agent 1.2.3\nnot json" }),
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
  assert.equal(r.binPath, "/bin/cursor-agent");
});

test("probeCursorCliAuth: thrown status probe keeps resolved binPath", () => {
  const r = probeCursorCliAuth({
    resolveBinary: () => "/bin/cursor-agent",
    runStatus: () => { throw new Error("timeout"); },
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
  assert.equal(r.binPath, "/bin/cursor-agent");
});

test("probeCursorCliAuth: extracts authenticated JSON wrapped in cmd noise", () => {
  const r = probeCursorCliAuth({
    resolveBinary: () => "C:\\Users\\me\\AppData\\Local\\cursor-agent\\cursor-agent.cmd",
    runStatus: () => ({
      exitCode: 0,
      stdout: "Starting...\r\n{\"status\":\"authenticated\",\"isAuthenticated\":true,\"userInfo\":{\"email\":\"user@example.com\"}}\r\n",
    }),
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "cli-login");
  assert.equal(r.email, "user@example.com");
});

test("parseCursorStatusJson accepts BOM and surrounding text", () => {
  const parsed = parseCursorStatusJson(
    "\uFEFFnoise\n{\"isAuthenticated\":true,\"status\":\"authenticated\"}\n",
  );
  assert.equal(parsed.isAuthenticated, true);
  assert.equal(parsed.status, "authenticated");
});

test("resolveCursorCliSpawnSpec re-exports the shared native launch helper", () => {
  const shim = "C:\\Users\\me\\AppData\\Local\\cursor-agent\\cursor-agent.cmd";
  const args = ["status", "--format", "json"];
  assert.deepEqual(
    resolveCursorCliSpawnSpec(shim, args),
    resolveSharedCursorCliSpawnSpec(shim, args),
  );
  assert.deepEqual(
    resolveSharedCursorCliSpawnSpec(shim, args, {
      exists: () => false,
      readFile: () => { throw new Error("missing"); },
    }),
    prepareCommandForSpawn(shim, args, { unwrapNativeExe: false }),
  );
});
