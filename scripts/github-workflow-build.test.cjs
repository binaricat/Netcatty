const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const buildWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "build.yml"),
  "utf8",
);

test("build workflow no longer installs removed ACP agent binaries", () => {
  for (const stale of [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/sdk",
    "@zed-industries/codex-acp",
    "codex-acp",
  ]) {
    assert.equal(
      buildWorkflow.includes(stale),
      false,
      `build workflow must not reference removed ACP package: ${stale}`,
    );
  }
});
