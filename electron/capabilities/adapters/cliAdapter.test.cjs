"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCliRpcMethod,
  listCliCapabilities,
  buildCatalogCliParams,
} = require("./cliAdapter.cjs");
const { CAPABILITY_STATUS } = require("../constants.cjs");

function fakeCreateError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

test("getCliRpcMethod resolves implemented cli commands to rpc methods", () => {
  assert.equal(getCliRpcMethod(["exec"]), "netcatty/exec");
  assert.equal(getCliRpcMethod(["sftp", "list"]), "netcatty/sftp/list");
  assert.equal(getCliRpcMethod(["vault", "host", "get"]), "vault/host/get");
  assert.equal(getCliRpcMethod(["portforward", "rules", "list"]), "portforward/rules/list");
  assert.equal(getCliRpcMethod(["capabilities"]), null);
});

test("listCliCapabilities returns implemented commands by default", () => {
  const entries = listCliCapabilities();
  assert.ok(entries.some((entry) => entry.id === "terminal.execute"));
  assert.ok(entries.some((entry) => entry.id === "vault.host.get"));
  assert.ok(entries.every((entry) => entry.status === CAPABILITY_STATUS.IMPLEMENTED));
  assert.ok(entries.every((entry) => entry.rpcMethod));
});

test("listCliCapabilities can include planned commands", () => {
  const entries = listCliCapabilities({ status: CAPABILITY_STATUS.PLANNED });
  assert.ok(entries.length >= 0);
});

test("buildCatalogCliParams maps vault host get flags", () => {
  const params = buildCatalogCliParams("vault.host.get", { hostId: "host-1" }, fakeCreateError);
  assert.deepEqual(params, { hostId: "host-1" });
});

test("buildCatalogCliParams parses snippet variables JSON", () => {
  const params = buildCatalogCliParams("vault.snippets.run", {
    snippetId: "snip-1",
    sessionId: "sess-1",
    variables: "{\"name\":\"prod\"}",
  }, fakeCreateError);
  assert.equal(params.snippetId, "snip-1");
  assert.equal(params.sessionId, "sess-1");
  assert.deepEqual(params.variables, { name: "prod" });
});

test("buildCatalogCliParams maps snippet multi-line run mode", () => {
  const params = buildCatalogCliParams("vault.snippets.create", {
    label: "login",
    content: "user\npass",
    multiLineRunMode: "lineDelay",
  }, fakeCreateError);
  assert.equal(params.multiLineRunMode, "lineDelay");
});

test("buildCatalogCliParams throws for missing required fields", () => {
  assert.throws(
    () => buildCatalogCliParams("vault.host.get", {}, fakeCreateError),
    /Missing required --host-id/,
  );
});
