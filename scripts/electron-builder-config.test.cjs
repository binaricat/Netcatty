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
