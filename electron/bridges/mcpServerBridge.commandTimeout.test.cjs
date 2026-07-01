const test = require("node:test");
const assert = require("node:assert/strict");
const mcpServerBridge = require("./mcpServerBridge.cjs");

test("setCommandTimeout honors one-day command timeout", (t) => {
  t.after(() => mcpServerBridge.setCommandTimeout(60));

  mcpServerBridge.setCommandTimeout(86_400);

  assert.equal(mcpServerBridge.getCommandTimeoutMs(), 86_400_000);
});
