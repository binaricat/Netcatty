"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

const { detectClaudeAuthPresence, getClaudeConfigDir, expandHomePath } = require("./claudeAuth.cjs");

test("getClaudeConfigDir: defaults to ~/.claude", () => {
  assert.equal(getClaudeConfigDir({}), path.join(os.homedir(), ".claude"));
});

test("getClaudeConfigDir: honors CLAUDE_CONFIG_DIR", () => {
  assert.equal(getClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/dir" }), "/custom/dir");
});

test("getClaudeConfigDir: expands a leading ~ in CLAUDE_CONFIG_DIR", () => {
  assert.equal(
    getClaudeConfigDir({ CLAUDE_CONFIG_DIR: "~/.claude-work" }),
    path.join(os.homedir(), ".claude-work"),
  );
});

test("expandHomePath: expands '~' and '~/...', leaves others unchanged", () => {
  assert.equal(expandHomePath("~"), os.homedir());
  assert.equal(expandHomePath("~/x/y"), path.join(os.homedir(), "x/y"));
  assert.equal(expandHomePath("/abs/path"), "/abs/path");
  assert.equal(expandHomePath("~user/x"), "~user/x");
  assert.equal(expandHomePath(""), "");
});

test("detectClaudeAuthPresence: ANTHROPIC_API_KEY in env => 'env'", () => {
  assert.equal(detectClaudeAuthPresence({ ANTHROPIC_API_KEY: "sk-x" }, () => false), "env");
});

test("detectClaudeAuthPresence: ANTHROPIC_AUTH_TOKEN in env => 'env'", () => {
  assert.equal(detectClaudeAuthPresence({ ANTHROPIC_AUTH_TOKEN: "tok" }, () => false), "env");
});

test("detectClaudeAuthPresence: blank env token is ignored", () => {
  assert.equal(detectClaudeAuthPresence({ ANTHROPIC_API_KEY: "   " }, () => false), "none");
});

test("detectClaudeAuthPresence: credentials file under config dir => 'credentials-file'", () => {
  const seen = [];
  const result = detectClaudeAuthPresence(
    { CLAUDE_CONFIG_DIR: "/custom/dir" },
    (p) => { seen.push(p); return p === path.join("/custom/dir", ".credentials.json"); },
  );
  assert.equal(result, "credentials-file");
  assert.ok(seen.includes(path.join("/custom/dir", ".credentials.json")));
});

test("detectClaudeAuthPresence: nothing => 'none'", () => {
  assert.equal(detectClaudeAuthPresence({}, () => false), "none");
});
