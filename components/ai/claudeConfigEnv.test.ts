import test from "node:test";
import assert from "node:assert/strict";

import {
  splitClaudeEnv,
  buildClaudeEnv,
  parseEnvLines,
  serializeEnvLines,
} from "../settings/tabs/ai/claudeConfigEnv";

test("splitClaudeEnv pulls out config dir and hides CLAUDE_CODE_EXECUTABLE", () => {
  const result = splitClaudeEnv({
    CLAUDE_CONFIG_DIR: "/cfg",
    CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude",
    ANTHROPIC_API_KEY: "sk-x",
  });
  assert.equal(result.configDir, "/cfg");
  assert.equal(result.settingsPath, "");
  assert.equal(result.envText, "ANTHROPIC_API_KEY=sk-x");
});

test("splitClaudeEnv handles undefined env", () => {
  assert.deepEqual(splitClaudeEnv(undefined), { configDir: "", settingsPath: "", envText: "" });
});

test("parseEnvLines parses KEY=VALUE, trims keys, keeps value as-is, skips blanks/comments", () => {
  assert.deepEqual(
    parseEnvLines("ANTHROPIC_API_KEY = sk-x\n# comment\n\nANTHROPIC_BASE_URL=https://h/?a=b"),
    { ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "https://h/?a=b" },
  );
});

test("serializeEnvLines is the inverse for simple entries", () => {
  assert.equal(serializeEnvLines({ A: "1", B: "2" }), "A=1\nB=2");
});

test("buildClaudeEnv merges config dir + parsed env, preserves CLAUDE_CODE_EXECUTABLE, drops empties", () => {
  const prev = { CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude", OLD: "x" };
  const next = buildClaudeEnv(prev, "/cfg", "", "ANTHROPIC_API_KEY=sk-x");
  assert.deepEqual(next, {
    CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude",
    CLAUDE_CONFIG_DIR: "/cfg",
    ANTHROPIC_API_KEY: "sk-x",
  });
});

test("buildClaudeEnv omits config dir when blank and returns undefined when empty", () => {
  assert.equal(buildClaudeEnv(undefined, "  ", "  ", ""), undefined);
});

test("buildClaudeEnv ignores managed keys typed into the env editor", () => {
  const next = buildClaudeEnv(
    { CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude" },
    "/cfg",
    "",
    "CLAUDE_CODE_EXECUTABLE=/evil/claude\nCLAUDE_CONFIG_DIR=/evil/dir\nNETCATTY_CLAUDE_SETTINGS=/evil/settings.json\nANTHROPIC_API_KEY=sk-x",
  );
  assert.deepEqual(next, {
    CLAUDE_CODE_EXECUTABLE: "/usr/bin/claude",
    CLAUDE_CONFIG_DIR: "/cfg",
    ANTHROPIC_API_KEY: "sk-x",
  });
});

test("splitClaudeEnv + buildClaudeEnv round-trip the settings marker (NETCATTY_CLAUDE_SETTINGS)", () => {
  const split = splitClaudeEnv({
    CLAUDE_CONFIG_DIR: "/cfg",
    NETCATTY_CLAUDE_SETTINGS: "/team/settings.json",
    ANTHROPIC_API_KEY: "sk-x",
  });
  assert.equal(split.settingsPath, "/team/settings.json");
  assert.equal(split.configDir, "/cfg");
  // the marker is kept out of the free-text env editor
  assert.equal(split.envText, "ANTHROPIC_API_KEY=sk-x");

  // config dir + settings coexist (settings is additive, not a replacement for CLAUDE_CONFIG_DIR)
  const rebuilt = buildClaudeEnv(undefined, "/cfg", "/team/settings.json", "ANTHROPIC_API_KEY=sk-x");
  assert.deepEqual(rebuilt, {
    CLAUDE_CONFIG_DIR: "/cfg",
    NETCATTY_CLAUDE_SETTINGS: "/team/settings.json",
    ANTHROPIC_API_KEY: "sk-x",
  });

  // settings alone (no config dir) is allowed
  assert.deepEqual(buildClaudeEnv(undefined, "", "/only/settings.json", ""), {
    NETCATTY_CLAUDE_SETTINGS: "/only/settings.json",
  });
});
