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
    const workspace = JSON.parse(fs.readFileSync(path.join(__dirname, "../../packages", dependency.split("/")[1], "package.json"), "utf8"));
    assert.equal(packageJson.dependencies[dependency], workspace.version);
    assert.equal(workspace.version, require("./constants.cjs").PLUGIN_API_VERSION);
  }
  const builderSource = fs.readFileSync(path.join(__dirname, "../../electron-builder.config.cjs"), "utf8");
  assert.match(builderSource, /node_modules\/@netcatty\/plugin-cli\/\*\*\/\*/);
  assert.match(builderSource, /node_modules\/@netcatty\/plugin-contract\/\*\*\/\*/);
  assert.match(builderSource, /node_modules\/@netcatty\/plugin-sdk\/\*\*\/\*/);
  assert.match(builderSource, /electron\/plugins\/runtime\/\*\*\/\*/);
  assert.match(builderSource, /domain\/pluginRuntimePolicy\.cjs/);
  assert.match(builderSource, /domain\/pluginPermissionDescriptions\.cjs/);
  assert.match(builderSource, /domain\/pluginThemePack\.cjs/);
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
  // main may append check:codebuddy-sdk-contract after build:plugin-runtime-deps.
  assert.match(
    packageJson.scripts.pretest,
    /^npm run build:plugin-runtime-deps(?: && npm run check:codebuddy-sdk-contract)?$/,
  );
  assert.equal(packageJson.scripts["pretest:plugin-runtime"], "npm run build:plugin-runtime-deps && npm run build:plugin-view-examples");
  assert.equal(packageJson.scripts["pretest:plugin-runtime:electron"], "npm run build:plugin-runtime-deps");
});

test("host rendering validators ship beside the main process", () => {
  const config = require('../../electron-builder.config.cjs');
  for (const file of ['domain/pluginRemoteTreePolicy.cjs', 'domain/pluginViewStylePolicy.cjs']) assert.ok(config.files.includes(file));
});
