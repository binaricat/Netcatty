"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function loadFreshBridgeWithDebug() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  process.env.NETCATTY_MCP_DEBUG = "1";
  return require("./mcpServerBridge.cjs");
}

test("MCP debug logging does not expose asset approval secrets", async (t) => {
  const previousDebug = process.env.NETCATTY_MCP_DEBUG;
  const previousError = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args);
  };

  t.after(() => {
    console.error = previousError;
    if (previousDebug === undefined) {
      delete process.env.NETCATTY_MCP_DEBUG;
    } else {
      process.env.NETCATTY_MCP_DEBUG = previousDebug;
    }
    const bridgePath = require.resolve("./mcpServerBridge.cjs");
    delete require.cache[bridgePath];
  });

  const bridge = loadFreshBridgeWithDebug();
  const approved = await bridge.requestApproval("asset_add", {
    hosts: JSON.stringify([
      {
        hostname: "asset.example.com",
        password: "pw-secret",
        notes: "note-secret",
      },
    ]),
  });

  assert.equal(approved, false);
  const serializedLogs = JSON.stringify(calls);
  assert.doesNotMatch(serializedLogs, /pw-secret|note-secret/);
});
