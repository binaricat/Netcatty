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
