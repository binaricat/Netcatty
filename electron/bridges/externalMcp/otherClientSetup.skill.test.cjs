"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createExternalMcpClaudeSetup } = require("./claudeSetup.cjs");
const { createExternalMcpGrokSetup } = require("./grokSetup.cjs");
const { getUserNetcattySkillPath } = require("./netcattySkillInstaller.cjs");

const LAUNCHER_PATH = "/opt/netcatty/netcatty-external-mcp";
const DISCOVERY_ENV = { NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: "/tmp/netcatty.json" };

async function withClaudeSetup(initiallyConfigured, run, customConfig = false) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-claude-setup-"));
  const claudeConfigDir = customConfig ? path.join(homeDir, "custom claude") : undefined;
  let mcpConfigured = initiallyConfigured;
  const calls = [];
  try {
    const setup = createExternalMcpClaudeSetup({
      launcherPath: LAUNCHER_PATH,
      discoveryEnv: DISCOVERY_ENV,
      getShellEnv: async () => ({ HOME: homeDir, CLAUDE_CONFIG_DIR: claudeConfigDir }),
      resolveCliFromPath: () => "/usr/bin/claude",
      resolveDesktopManagedCli: () => null,
      runClaudeCommand: async (_claudePath, _shellEnv, args) => {
        calls.push(args);
        if (args[0] === "mcp" && args[1] === "add") {
          mcpConfigured = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "mcp" && args[1] === "get") {
          if (!mcpConfigured) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: 'No MCP server found with name: "netcatty-external"',
            };
          }
          return {
            exitCode: 0,
            stdout: [
              `Command: ${LAUNCHER_PATH}`,
              "Environment:",
              `  NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE=${DISCOVERY_ENV.NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE}`,
              "Scope: User config (available in all your projects)",
            ].join("\n"),
            stderr: "",
          };
        }
        throw new Error(`Unexpected Claude args: ${args.join(" ")}`);
      },
    });
    await run({ setup, calls, homeDir, claudeConfigDir });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function withGrokSetup(initiallyConfigured, run) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-grok-setup-"));
  const grokHomeDir = path.join(homeDir, "custom-grok-home");
  let mcpConfigured = initiallyConfigured;
  const calls = [];
  try {
    const setup = createExternalMcpGrokSetup({
      launcherPath: LAUNCHER_PATH,
      discoveryEnv: DISCOVERY_ENV,
      getShellEnv: async () => ({ HOME: homeDir, GROK_HOME: grokHomeDir }),
      resolveCliFromPath: () => "/usr/bin/grok",
      runGrokCommand: async (_grokPath, _shellEnv, args) => {
        calls.push(args);
        if (args[0] === "mcp" && args[1] === "add") {
          mcpConfigured = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "mcp" && args[1] === "list") {
          const entries = mcpConfigured ? [{
            name: "netcatty-external",
            enabled: true,
            transport: {
              type: "stdio",
              command: LAUNCHER_PATH,
              args: [],
              env: DISCOVERY_ENV,
            },
          }] : [];
          return { exitCode: 0, stdout: JSON.stringify(entries), stderr: "" };
        }
        throw new Error(`Unexpected Grok args: ${args.join(" ")}`);
      },
    });
    await run({ setup, calls, homeDir, grokHomeDir });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("Add to Claude Code installs both the MCP entry and Netcatty skill", async () => {
  await withClaudeSetup(false, async ({ setup, calls, homeDir }) => {
    const result = await setup.addToClaude();

    assert.equal(result.state, "configured");
    assert.equal(result.mcpConfigured, true);
    assert.equal(result.skillInstalled, true);
    assert.equal(calls.some(args => args[1] === "add"), true);
    assert.match(await fs.readFile(getUserNetcattySkillPath("claude", { homeDir }), "utf8"), /name: netcatty-mcp/);
  });
});

test("Add to Claude Code only installs the skill when MCP already exists", async () => {
  await withClaudeSetup(true, async ({ setup, calls, homeDir }) => {
    const before = await setup.getStatus();
    assert.equal(before.state, "not_configured");
    assert.equal(before.mcpConfigured, true);

    const result = await setup.addToClaude();
    assert.equal(result.state, "configured");
    assert.equal(result.skillInstalled, true);
    assert.equal(calls.some(args => args[1] === "add" || args[1] === "remove"), false);
    assert.match(await fs.readFile(getUserNetcattySkillPath("claude", { homeDir }), "utf8"), /name: netcatty-mcp/);
  });
});

test("Add to Grok installs both the MCP entry and Netcatty skill under GROK_HOME", async () => {
  await withGrokSetup(false, async ({ setup, calls, homeDir, grokHomeDir }) => {
    const result = await setup.addToGrok();

    assert.equal(result.state, "configured");
    assert.equal(result.mcpConfigured, true);
    assert.equal(result.skillInstalled, true);
    assert.equal(calls.some(args => args[1] === "add"), true);
    const skillPath = getUserNetcattySkillPath("grok", { homeDir, grokHomeDir });
    assert.match(await fs.readFile(skillPath, "utf8"), /name: netcatty-mcp/);
  });
});

test("Add to Grok only installs the skill when MCP already exists", async () => {
  await withGrokSetup(true, async ({ setup, calls, homeDir, grokHomeDir }) => {
    const before = await setup.getStatus();
    assert.equal(before.state, "not_configured");
    assert.equal(before.mcpConfigured, true);

    const result = await setup.addToGrok();
    assert.equal(result.state, "configured");
    assert.equal(result.skillInstalled, true);
    assert.equal(calls.some(args => args[1] === "add" || args[1] === "remove"), false);
    const skillPath = getUserNetcattySkillPath("grok", { homeDir, grokHomeDir });
    assert.match(await fs.readFile(skillPath, "utf8"), /name: netcatty-mcp/);
  });
});

for (const initiallyConfigured of [false, true]) {
  test(`Claude custom config directory is used for skill setup and status (MCP exists: ${initiallyConfigured})`, async () => {
    await withClaudeSetup(initiallyConfigured, async ({ setup, homeDir, claudeConfigDir }) => {
      const defaultSkillPath = getUserNetcattySkillPath("claude", { homeDir });
      await fs.mkdir(path.dirname(defaultSkillPath), { recursive: true });
      const { getBundledNetcattySkillPath } = require("./netcattySkillInstaller.cjs");
      await fs.copyFile(getBundledNetcattySkillPath(), defaultSkillPath);
      const before = await setup.getStatus();
      assert.equal(before.state, "not_configured");

      const result = await setup.addToClaude();
      const expectedPath = path.join(claudeConfigDir, "skills", "netcatty-mcp", "SKILL.md");
      assert.equal(result.state, "configured");
      assert.equal(result.skillPath, expectedPath);
      assert.match(await fs.readFile(expectedPath, "utf8"), /name: netcatty-mcp/);
      await fs.rm(expectedPath);
      assert.equal((await setup.getStatus()).state, "not_configured");
    }, true);
  });
}
