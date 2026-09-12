import assert from "node:assert/strict";
import test from "node:test";

import { isCursorAvailableForMode, isCursorRuntimeInstalled } from "./types";

test("isCursorRuntimeInstalled ignores bundled SDK flags", () => {
  assert.equal(isCursorRuntimeInstalled({
    path: "cursor",
    version: "Cursor SDK",
    available: true,
    installed: true,
    sdkInstalled: true,
  }), false);
  assert.equal(isCursorRuntimeInstalled({
    path: "cursor",
    version: "Cursor SDK",
    available: false,
    installed: false,
    sdkInstalled: true,
    cliBinPath: null,
    cliLoginOk: false,
  }), false);
});

test("isCursorRuntimeInstalled is true for Agent CLI path or CLI login", () => {
  assert.equal(isCursorRuntimeInstalled({
    path: "/usr/local/bin/cursor-agent",
    version: "Cursor Agent CLI",
    available: false,
    sdkInstalled: true,
    cliBinPath: "/usr/local/bin/cursor-agent",
    cliLoginOk: false,
  }), true);
  assert.equal(isCursorRuntimeInstalled({
    path: "cursor",
    version: "Cursor Agent CLI",
    available: true,
    sdkInstalled: true,
    cliLoginOk: true,
  }), true);
});

test("isCursorAvailableForMode still allows API-key mode from bundled SDK", () => {
  assert.equal(isCursorAvailableForMode({
    path: "cursor",
    version: "Cursor SDK",
    available: true,
    installed: false,
    sdkInstalled: true,
    apiKeyOk: true,
  }, "api-key"), true);
  assert.equal(isCursorAvailableForMode({
    path: "cursor",
    version: "Cursor SDK",
    available: true,
    installed: false,
    apiKeyOk: true,
  }, "api-key"), true);
  assert.equal(isCursorAvailableForMode({
    path: "cursor",
    version: "Cursor SDK",
    available: false,
    installed: false,
    sdkInstalled: true,
    cliLoginOk: false,
  }, "cli-login"), false);
});
