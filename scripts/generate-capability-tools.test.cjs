"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { listCattyToolSpecs } = require("../electron/capabilities/codegen/toolSurfaces.cjs");

const GENERATED_PATH = path.join(
  __dirname,
  "..",
  "infrastructure",
  "ai",
  "harness",
  "generated",
  "cattyToolSpecs.json",
);

test("committed cattyToolSpecs.json matches listCattyToolSpecs()", () => {
  const committed = JSON.parse(fs.readFileSync(GENERATED_PATH, "utf8"));
  const fresh = listCattyToolSpecs();
  assert.deepEqual(committed, fresh);
});
