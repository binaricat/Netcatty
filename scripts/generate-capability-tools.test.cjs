"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { AGENT_KINDS, listAgentToolSpecs, listCattyToolSpecs } = require("../electron/capabilities/codegen/toolSurfaces.cjs");

const GENERATED_DIR = path.join(
  __dirname,
  "..",
  "infrastructure",
  "ai",
  "harness",
  "generated",
);

test("committed cattyToolSpecs.json matches listCattyToolSpecs()", () => {
  const committed = JSON.parse(
    fs.readFileSync(path.join(GENERATED_DIR, "cattyToolSpecs.json"), "utf8"),
  );
  const fresh = listCattyToolSpecs();
  assert.deepEqual(committed, fresh);
});

test("committed globalAgentToolSpecs.json matches listAgentToolSpecs(global)", () => {
  const committed = JSON.parse(
    fs.readFileSync(path.join(GENERATED_DIR, "globalAgentToolSpecs.json"), "utf8"),
  );
  const fresh = listAgentToolSpecs(AGENT_KINDS.GLOBAL);
  assert.deepEqual(committed, fresh);
});

test("committed toolNameIndex.json matches sidebar and global capability tool specs", () => {
  const committed = JSON.parse(
    fs.readFileSync(path.join(GENERATED_DIR, "toolNameIndex.json"), "utf8"),
  );
  const globalByCapabilityId = {};
  for (const spec of listAgentToolSpecs(AGENT_KINDS.GLOBAL)) {
    if (spec.capabilityId && spec.toolName && !globalByCapabilityId[spec.capabilityId]) {
      globalByCapabilityId[spec.capabilityId] = spec.toolName;
    }
  }
  const sidebarByRpcMethod = {};
  for (const spec of listCattyToolSpecs()) {
    if (spec.rpcMethod && spec.toolName && !sidebarByRpcMethod[spec.rpcMethod]) {
      sidebarByRpcMethod[spec.rpcMethod] = spec.toolName;
    }
  }
  assert.deepEqual(committed, { globalByCapabilityId, sidebarByRpcMethod });
});

