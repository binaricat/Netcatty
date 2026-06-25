"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ALL_CAPABILITIES } = require("../index.cjs");
const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const { getCliRpcMethod } = require("../adapters/cliAdapter.cjs");

const IMPLEMENTED_CLI_COMMANDS = [
  ["status"],
  ["env"],
  ["session"],
  ["exec"],
  ["job-start"],
  ["job-poll"],
  ["job-stop"],
  ["sftp", "list"],
  ["sftp", "read"],
  ["sftp", "write"],
  ["sftp", "download"],
  ["sftp", "upload"],
  ["sftp", "mkdir"],
  ["sftp", "delete"],
  ["sftp", "rename"],
  ["sftp", "stat"],
  ["sftp", "chmod"],
  ["sftp", "home"],
  ["cancel"],
  ["resume"],
  ["vault", "host", "get"],
  ["vault", "host-notes", "get"],
  ["vault", "host-notes", "set"],
  ["snippets", "list"],
  ["snippets", "get"],
  ["snippets", "run"],
  ["portforward", "rules", "list"],
  ["portforward", "tunnels", "list"],
  ["portforward", "start"],
  ["portforward", "stop"],
];

test("every implemented cli command maps to an rpc method", () => {
  for (const command of IMPLEMENTED_CLI_COMMANDS) {
    const rpcMethod = getCliRpcMethod(command);
    assert.ok(rpcMethod, `missing rpc mapping for ${command.join(" ")}`);
  }
});

test("implemented capabilities expose at least one surface binding", () => {
  for (const capability of ALL_CAPABILITIES) {
    if (capability.status !== CAPABILITY_STATUS.IMPLEMENTED) continue;
    const surfaces = Object.keys(capability.surfaces || {});
    assert.ok(surfaces.length > 0, `${capability.id} has no surfaces`);
    const hasRpc = surfaces.some((surface) => capability.surfaces[surface]?.rpcMethod);
    const hasCli = surfaces.some((surface) => capability.surfaces[surface]?.command);
    assert.ok(
      hasRpc || hasCli || capability.surfaces[CAPABILITY_SURFACES.BUILTIN]?.mcpTool,
      `${capability.id} has no rpc/cli/mcp binding`,
    );
  }
});

test("capability ids are unique", () => {
  const ids = ALL_CAPABILITIES.map((capability) => capability.id);
  assert.equal(new Set(ids).size, ids.length);
});
