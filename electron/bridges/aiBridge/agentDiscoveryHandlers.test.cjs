"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeCursorInstallState } = require("./agentDiscoveryHandlers.cjs");

test("computeCursorInstallState: bundled SDK is not a user Cursor install", () => {
  const state = computeCursorInstallState({
    sdkInstalled: true,
    cliBinPath: null,
    cliLoginOk: false,
  });
  assert.equal(state.sdkInstalled, true);
  assert.equal(state.installed, false);
});

test("computeCursorInstallState: Agent CLI on PATH is a user Cursor install", () => {
  const state = computeCursorInstallState({
    sdkInstalled: true,
    cliBinPath: "/usr/local/bin/cursor-agent",
    cliLoginOk: false,
  });
  assert.equal(state.sdkInstalled, true);
  assert.equal(state.installed, true);
});

test("computeCursorInstallState: logged-out CLI path is installed without cliLoginOk", () => {
  const state = computeCursorInstallState({
    sdkInstalled: true,
    cliBinPath: "/bin/cursor-agent",
    cliLoginOk: false,
  });
  assert.equal(state.installed, true);
  assert.equal(state.sdkInstalled, true);
});

test("computeCursorInstallState: proven CLI login is a user Cursor install", () => {
  const state = computeCursorInstallState({
    sdkInstalled: false,
    cliBinPath: null,
    cliLoginOk: true,
  });
  assert.equal(state.sdkInstalled, false);
  assert.equal(state.installed, true);
});
