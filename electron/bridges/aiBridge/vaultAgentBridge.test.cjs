"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVaultAgentBridge } = require("./vaultAgentBridge.cjs");

test("terminal reads target their owning window and accept only its response", async () => {
  const sent = [];
  const main = { id: 1, send: (...args) => sent.push({ window: 1, args }) };
  const popup = { id: 2, send: (...args) => sent.push({ window: 2, args }) };
  let respond;
  const bridge = createVaultAgentBridge({
    getMainWindowFn: () => ({ isDestroyed: () => false, webContents: main }),
    validateSender: (event) => event.sender.id === 1,
  });
  bridge.registerHandlers({ handle: (_channel, handler) => { respond = handler; } });
  const pending = bridge.invokeVaultAgent("terminal.readContext", { sessionId: "popup" }, { webContents: popup });
  assert.equal(sent[0].window, 2);
  const requestId = sent[0].args[1].requestId;
  assert.equal(respond({ sender: main }, { requestId, result: { ok: true, content: "wrong" } }).ok, false);
  assert.equal(respond({ sender: popup }, { requestId, result: { ok: true, content: "popup screen" } }).ok, true);
  assert.equal((await pending).content, "popup screen");

  // A requested alternate window never redirects ordinary vault operations.
  const vault = bridge.invokeVaultAgent("host.list", {}, { webContents: popup });
  assert.equal(sent[1].window, 1);
  const vaultId = sent[1].args[1].requestId;
  assert.equal(respond({ sender: popup }, { requestId: vaultId, result: { ok: true } }).ok, false);
  respond({ sender: main }, { requestId: vaultId, result: { ok: true } });
  assert.equal((await vault).ok, true);
});
