"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const electronPath = require.resolve("electron");
const previousElectron = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { dialog: {}, shell: {} },
};
const { buildExternalAgentSystemContext } = require("./aiBridge.cjs");
if (previousElectron) {
  require.cache[electronPath] = previousElectron;
} else {
  delete require.cache[electronPath];
}

test("buildExternalAgentSystemContext (MCP mode) includes vault host vs notes guidance", () => {
  const context = buildExternalAgentSystemContext({
    mode: "mcp",
    chatSessionId: "chat-1",
  });
  assert.match(context, /vault_hosts_create/i);
  assert.match(context, /NOT vault_notes_create/i);
  assert.match(context, /do not silently create a Vault note/i);
});

test("buildExternalAgentSystemContext (skills mode) routes attachments through Netcatty CLI", () => {
  const context = buildExternalAgentSystemContext({
    mode: "skills",
    chatSessionId: "chat-1",
  });

  assert.match(context, /attachment list --json/i);
  assert.match(context, /attachment read --filename <filename> --json/i);
  assert.match(context, /already bound in this process via the host environment/i);
  assert.doesNotMatch(context, /--chat-session/);
  assert.match(context, /Use the local shell only to invoke Netcatty CLI commands/i);
});
