"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("packaged application declares every plugin host runtime dependency and resource", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  for (const dependency of [
    "@netcatty/plugin-cli",
    "@netcatty/plugin-contract",
    "@netcatty/plugin-sdk",
  ]) {
    assert.equal(packageJson.dependencies[dependency], "0.1.0-internal");
  }
  const builderSource = fs.readFileSync(path.join(__dirname, "../../electron-builder.config.cjs"), "utf8");
  assert.match(builderSource, /node_modules\/@netcatty\/plugin-cli\/\*\*\/\*/);
  assert.match(builderSource, /node_modules\/@netcatty\/plugin-contract\/\*\*\/\*/);
  assert.match(builderSource, /node_modules\/@netcatty\/plugin-sdk\/\*\*\/\*/);
  assert.match(builderSource, /electron\/plugins\/runtime\/\*\*\/\*/);
  assert.match(builderSource, /!electron\/plugins\/fixtures\/\*\*\/\*/);
});

test("clean-checkout test entrypoints build plugin runtime workspaces first", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["build:plugin-runtime-deps"],
    "npm run build --workspace @netcatty/plugin-contract"
      + " && npm run build --workspace @netcatty/plugin-sdk"
      + " && npm run build --workspace @netcatty/plugin-cli",
  );
  for (const lifecycle of [
    "pretest",
    "pretest:plugin-runtime",
    "pretest:plugin-runtime:electron",
  ]) {
    assert.equal(packageJson.scripts[lifecycle], "npm run build:plugin-runtime-deps");
  }
});
