"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { getCliRpcMethod, listCliCapabilities } = require("./cliAdapter.cjs");
const { CAPABILITY_STATUS } = require("../constants.cjs");

test("getCliRpcMethod resolves implemented cli commands to builtin rpc methods", () => {
  assert.equal(getCliRpcMethod(["exec"]), "netcatty/exec");
  assert.equal(getCliRpcMethod(["sftp", "list"]), "netcatty/sftp/list");
  assert.equal(getCliRpcMethod(["capabilities"]), null);
});

test("listCliCapabilities returns implemented commands by default", () => {
  const entries = listCliCapabilities();
  assert.ok(entries.some((entry) => entry.id === "terminal.execute"));
  assert.ok(entries.every((entry) => entry.status === CAPABILITY_STATUS.IMPLEMENTED));
});

test("listCliCapabilities can include planned commands", () => {
  const entries = listCliCapabilities({ status: CAPABILITY_STATUS.PLANNED });
  assert.ok(entries.some((entry) => entry.id === "vault.host.notes.get"));
});
