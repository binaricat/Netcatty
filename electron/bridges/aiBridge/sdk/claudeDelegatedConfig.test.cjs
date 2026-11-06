"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire, wrap } = require("node:module");

// Execute the real driver/registry source with only config repair and SDK
// inference replaced. No user config is read and no SDK process is launched.
function loadSource(name, replacements) {
  const filename = require.resolve(name); const local = createRequire(filename);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(wrap(fs.readFileSync(filename, "utf8")), { filename });
  wrapper(module.exports, (id) => replacements[id] ?? local(id), module, filename, path.dirname(filename));
  return module.exports;
}

function fixture() {
  const repairs = []; const sends = []; const errors = [];
  const driver = loadSource("./claudeDriver.cjs", { "./claudeConfig.cjs": { ensureClaudeConfig: () => repairs.push("repair") } });
  const run = driver.runClaudeTurn;
  driver.runClaudeTurn = (args) => run({ ...args, queryFn: ({ options }) => {
    sends.push(options);
    return (async function* () { yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Synthetic" } } }; })();
  } });
  const registry = loadSource("./index.cjs", { "./claudeDriver.cjs": driver });
  const emitter = new Proxy({ emitError: (error) => errors.push(error) }, { get: (target, key) => target[key] ?? (() => {}) });
  const env = Object.freeze({ CLAUDE_CONFIG_DIR: "/synthetic/selected-profile", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "FIXTURE_ONLY_MARKER" });
  const ctx = { prompt: "Synthetic", env, emitter, toolIntegrationMode: "mcp", cwd: "/synthetic/turn", binPath: "/synthetic/official-claude",
    abortController: new AbortController(), assertSessionValid: () => {}, injectedMcpServers: [{ name: "selected-only", command: "host-managed", args: [], env: [] }] };
  return { repairs, sends, errors, env, ctx, run: (overrides) => registry.getDriver("claude").runTurn({ ...ctx, ...overrides }) };
}

for (const explicitProfile of [true, false]) test(`delegated registry turn skips config repair with ${explicitProfile ? "explicit" : "default"} host profile`, async () => {
  const f = fixture(); const env = explicitProfile ? f.env : { ANTHROPIC_API_KEY: "FIXTURE_ONLY_MARKER" };
  await f.run({ delegatedAgent: true, env });
  assert.deepEqual(f.repairs, []); assert.equal(f.sends.length, 1); assert.deepEqual(f.errors, []);
  const options = f.sends[0]; assert.equal(options.env, env);
  assert.equal(options.cwd, f.ctx.cwd); assert.equal(options.pathToClaudeCodeExecutable, f.ctx.binPath);
  assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true); assert.equal(options.persistSession, false);
  assert.deepEqual(Object.keys(options.mcpServers), ["selected-only"]);
});

for (const delegatedAgent of [undefined, false]) test(`builtin registry turn retains repair when delegated flag is ${String(delegatedAgent)}`, async () => {
  const f = fixture(); await f.run({ delegatedAgent });
  assert.deepEqual(f.repairs, ["repair"]); assert.equal(f.sends.length, 1); assert.deepEqual(f.errors, []);
  assert.equal(f.sends[0].env, f.env); assert.equal(f.sends[0].settingSources, undefined);
});
