"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

test("netcatty-tool-cli capabilities runs from unpacked CLI runtime without app services", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-runtime-"));
  try {
    const electronDir = path.join(tmpDir, "electron");
    const cliDir = path.join(electronDir, "cli");
    const capabilitiesDir = path.join(electronDir, "capabilities");

    fs.mkdirSync(electronDir, { recursive: true });
    fs.cpSync(path.join(__dirname), cliDir, { recursive: true });
    fs.cpSync(path.join(__dirname, "..", "capabilities"), capabilitiesDir, { recursive: true });
    fs.rmSync(path.join(capabilitiesDir, "index.cjs"));
    fs.rmSync(path.join(capabilitiesDir, "services"), { recursive: true });

    const result = spawnSync(process.execPath, [
      path.join(cliDir, "netcatty-tool-cli.cjs"),
      "capabilities",
      "--json",
    ], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.capabilities.some((entry) => entry.id === "terminal.execute"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
