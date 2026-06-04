const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../electron-builder.config.cjs");

test("unpacked MCP server includes its shared CommonJS dependencies", () => {
  assert.ok(
    config.asarUnpack.includes("electron/mcp/**/*"),
    "MCP server must stay unpacked so Codex can launch it as a child process",
  );
  assert.ok(
    config.asarUnpack.includes("lib/**/*.cjs"),
    "MCP server requires ../../lib/commandBlocklist.cjs from the unpacked runtime path",
  );
  assert.ok(
    config.asarUnpack.includes("lib/**/*.json"),
    "unpacked lib CommonJS modules require sibling JSON data files at runtime",
  );
});

test("build.files excludes per-platform agent binaries", () => {
  const files = config.files;
  const expectExclusions = [
    "!**/@anthropic-ai/claude-agent-sdk-*/**/*",
    "!node_modules/@anthropic-ai/claude-code-*/**/*",
    "!node_modules/@openai/codex-{darwin,linux,linuxmusl,win32}-*/**/*",
    "!node_modules/@github/copilot-{darwin,linux,linuxmusl,win32}-*/**/*",
    "!node_modules/@github/copilot/**/*",
  ];
  for (const glob of expectExclusions) {
    assert.ok(
      files.includes(glob),
      `build.files must exclude platform binary glob: ${glob}`,
    );
  }
});

test("asarUnpack no longer references removed legacy agent packages", () => {
  const unpack = config.asarUnpack.join("\n");
  for (const stale of [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/sdk",
    "@zed-industries/codex-acp",
  ]) {
    assert.ok(
      !unpack.includes(stale),
      `asarUnpack must not reference removed package: ${stale}`,
    );
  }
});

test("asarUnpack keeps MCP server runtime deps unpacked", () => {
  // @modelcontextprotocol/sdk is now a direct dep and the MCP server hard-requires it.
  assert.ok(config.asarUnpack.includes("node_modules/@modelcontextprotocol/sdk/**/*"));
});
