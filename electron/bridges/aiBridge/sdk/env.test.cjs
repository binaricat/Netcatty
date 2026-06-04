const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSdkAgentEnv, DANGEROUS_ENV_KEYS, isDangerousEnvKey } = require("./env.cjs");

test("merges shellEnv + requestedAgentEnv (requested wins)", () => {
  const env = buildSdkAgentEnv({
    shellEnv: { PATH: "/usr/bin", FOO: "shell" },
    requestedAgentEnv: { FOO: "req", BAR: "req" },
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.FOO, "req");
  assert.equal(env.BAR, "req");
});

test("filters dangerous env keys from requestedAgentEnv", () => {
  const env = buildSdkAgentEnv({
    shellEnv: { PATH: "/usr/bin" },
    requestedAgentEnv: { LD_PRELOAD: "/evil.so", NODE_OPTIONS: "--x", BASH_FUNC_foo: "y", SAFE: "ok" },
  });
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.BASH_FUNC_foo, undefined);
  assert.equal(env.SAFE, "ok");
});

test("filters dangerous env keys from shellEnv", () => {
  const env = buildSdkAgentEnv({
    shellEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require /evil.js", BASH_FUNC_x: "() { :; }", SAFE: "ok" },
    requestedAgentEnv: {},
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.BASH_FUNC_x, undefined);
  assert.equal(env.SAFE, "ok");
});

test("isDangerousEnvKey flags blocklist and BASH_FUNC_ prefix", () => {
  assert.equal(isDangerousEnvKey("DYLD_INSERT_LIBRARIES"), true);
  assert.equal(isDangerousEnvKey("dyld_insert_libraries"), true);
  assert.equal(isDangerousEnvKey("node_options"), true);
  assert.equal(isDangerousEnvKey("BASH_FUNC_x%%"), true);
  assert.equal(isDangerousEnvKey("bash_func_x%%"), true);
  assert.equal(isDangerousEnvKey("PATH"), false);
});

test("applies withCliDiscoveryEnv hook", () => {
  const env = buildSdkAgentEnv({
    shellEnv: { PATH: "/usr/bin" },
    requestedAgentEnv: {},
    withCliDiscoveryEnv: (e) => ({ ...e, NETCATTY_TOOL_CLI_DISCOVERY: "/tmp/x.json" }),
  });
  assert.equal(env.NETCATTY_TOOL_CLI_DISCOVERY, "/tmp/x.json");
});

test("normalizes CLAUDE_CODE_EXECUTABLE via injected normalizer", () => {
  const env = buildSdkAgentEnv({
    shellEnv: { PATH: "/usr/bin" },
    requestedAgentEnv: { CLAUDE_CODE_EXECUTABLE: "/old/claude" },
    normalizeClaudeCodeExecutableEnv: (e) => ({ ...e, CLAUDE_CODE_EXECUTABLE: "/new/claude" }),
  });
  assert.equal(env.CLAUDE_CODE_EXECUTABLE, "/new/claude");
});
