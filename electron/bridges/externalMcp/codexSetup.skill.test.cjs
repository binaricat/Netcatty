"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createExternalMcpCodexSetup } = require("./codexSetup.cjs");
const { getUserNetcattySkillPath } = require("./netcattySkillInstaller.cjs");

const LAUNCHER_PATH = "/opt/netcatty/netcatty-external-mcp";
const DISCOVERY_ENV = { NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: "/tmp/netcatty.json" };

async function withSetup({ initiallyConfigured = false, prepareHome } = {}, run) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-codex-setup-"));
  let mcpConfigured = initiallyConfigured;
  const calls = [];

  try {
    if (prepareHome) await prepareHome(homeDir);
    const setup = createExternalMcpCodexSetup({
      launcherPath: LAUNCHER_PATH,
      discoveryEnv: DISCOVERY_ENV,
      getShellEnv: async () => ({ HOME: homeDir }),
      resolveCliFromPath: () => "/usr/bin/codex",
      resolveDesktopManagedCli: () => null,
      runCodexCommand: async (_codexPath, _shellEnv, args) => {
        calls.push(args);
        if (args[0] === "mcp" && args[1] === "add") {
          mcpConfigured = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "mcp" && args[1] === "remove") {
          mcpConfigured = false;
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
        throw new Error(`Unexpected Codex args: ${args.join(" ")}`);
      },
    });
    await run({ setup, calls, homeDir });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("Add to Codex installs both the MCP entry and Netcatty skill", async () => {
  await withSetup({}, async ({ setup, calls, homeDir }) => {
    const result = await setup.addToCodex();

    assert.equal(result.state, "configured");
    assert.equal(result.mcpConfigured, true);
    assert.equal(result.skillInstalled, true);
    assert.equal(calls.some(args => args[1] === "add"), true);
    assert.match(await fs.readFile(getUserNetcattySkillPath("codex", { homeDir }), "utf8"), /name: netcatty-mcp/);
  });
});

test("Add to Codex only installs the skill when the MCP entry already exists", async () => {
  await withSetup({ initiallyConfigured: true }, async ({ setup, calls, homeDir }) => {
    const before = await setup.getStatus();
    assert.equal(before.state, "not_configured");
    assert.equal(before.mcpConfigured, true);
    assert.equal(before.skillInstalled, false);

    const result = await setup.addToCodex();
    assert.equal(result.state, "configured");
    assert.equal(result.skillInstalled, true);
    assert.equal(calls.some(args => args[1] === "add" || args[1] === "remove"), false);
    assert.match(await fs.readFile(getUserNetcattySkillPath("codex", { homeDir }), "utf8"), /name: netcatty-mcp/);
  });
});

test("Add to Codex preserves an unmanaged skill and reports the conflict", async () => {
  const customContent = "---\nname: netcatty-mcp\ndescription: custom\n---\ncustom\n";
  await withSetup({
    initiallyConfigured: true,
    prepareHome: async (homeDir) => {
      const skillPath = getUserNetcattySkillPath("codex", { homeDir });
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, customContent);
    },
  }, async ({ setup, calls, homeDir }) => {
    const result = await setup.addToCodex();

    assert.equal(result.state, "error");
    assert.equal(result.mcpConfigured, true);
    assert.match(result.error, /unmanaged skill already exists/i);
    assert.equal(calls.some(args => args[1] === "add" || args[1] === "remove"), false);
    assert.equal(await fs.readFile(getUserNetcattySkillPath("codex", { homeDir }), "utf8"), customContent);
  });
});

test("reports the MCP as configured when a fresh install reaches a skill conflict", async () => {
  const customContent = "---\nname: netcatty-mcp\ndescription: custom\n---\ncustom\n";
  await withSetup({
    prepareHome: async (homeDir) => {
      const skillPath = getUserNetcattySkillPath("codex", { homeDir });
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, customContent);
    },
  }, async ({ setup, calls, homeDir }) => {
    const result = await setup.addToCodex();

    assert.equal(result.state, "error");
    assert.equal(result.mcpConfigured, true);
    assert.equal(calls.some(args => args[1] === "add"), true);
    assert.equal(await fs.readFile(getUserNetcattySkillPath("codex", { homeDir }), "utf8"), customContent);
  });
});
