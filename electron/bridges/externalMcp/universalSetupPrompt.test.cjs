"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUniversalSetupPrompt } = require("./universalSetupPrompt.cjs");

test("builds a portable MCP and Skill installation prompt", () => {
  const prompt = buildUniversalSetupPrompt({
    launcherPath: "/Applications/Netcatty App/netcatty-external-mcp",
    discoveryPath: "/Users/test/Library/Application Support/Netcatty/discovery.json",
    skillContent: "---\nname: netcatty-mcp\nmetadata:\n  managed-by: netcatty\n---\nUse get_environment first.\n",
  });

  assert.match(prompt, /Install the Netcatty integration/);
  assert.match(prompt, /Agent Skills are unsupported/);
  assert.match(prompt, /managed-by: netcatty/);
  assert.match(prompt, /call `get_environment`/);

  const jsonBlock = prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(jsonBlock);
  assert.deepEqual(JSON.parse(jsonBlock), {
    mcpServers: {
      "netcatty-external": {
        command: "/Applications/Netcatty App/netcatty-external-mcp",
        args: [],
        env: {
          NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: "/Users/test/Library/Application Support/Netcatty/discovery.json",
        },
      },
    },
  });
});

test("requires all runtime-specific installation values", () => {
  assert.throws(
    () => buildUniversalSetupPrompt({ launcherPath: "", discoveryPath: "/tmp/d", skillContent: "skill" }),
    /launcher path is unavailable/i,
  );
  assert.throws(
    () => buildUniversalSetupPrompt({ launcherPath: "/bin/mcp", discoveryPath: "", skillContent: "skill" }),
    /discovery path is unavailable/i,
  );
  assert.throws(
    () => buildUniversalSetupPrompt({ launcherPath: "/bin/mcp", discoveryPath: "/tmp/d", skillContent: "" }),
    /skill content is unavailable/i,
  );
});
