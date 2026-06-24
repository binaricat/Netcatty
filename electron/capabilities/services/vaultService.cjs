"use strict";

const { createNotImplementedHandler } = require("./notImplemented.cjs");

/**
 * Vault domain service skeleton. Handlers will be wired to a VaultFacade bridge
 * in a follow-up PR; registry entries already describe the public contract.
 */
function createVaultService(_ctx = {}) {
  return {
    getHost: createNotImplementedHandler("vault.host.get"),
    getHostNotes: createNotImplementedHandler("vault.host.notes.get"),
    setHostNotes: createNotImplementedHandler("vault.host.notes.set"),
    listSnippets: createNotImplementedHandler("vault.snippets.list"),
    getSnippet: createNotImplementedHandler("vault.snippets.get"),
    runSnippet: createNotImplementedHandler("vault.snippets.run"),
  };
}

module.exports = {
  createVaultService,
};
