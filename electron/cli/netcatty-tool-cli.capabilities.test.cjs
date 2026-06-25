"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("netcatty-tool-cli capabilities lists implemented commands without app connection", () => {
  const cliPath = path.join(__dirname, "..", "cli", "netcatty-tool-cli.cjs");
  const result = spawnSync(process.execPath, [cliPath, "capabilities", "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.capabilities.some((entry) => entry.id === "terminal.execute"));
  assert.ok(payload.capabilities.some((entry) => entry.id === "vault.host.get"));
  assert.ok(payload.capabilities.some((entry) => entry.id === "portforward.rules.list"));
});
