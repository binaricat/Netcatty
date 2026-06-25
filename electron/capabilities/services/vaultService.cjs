"use strict";

/**
 * Vault domain service. Read-only metadata and notes/snippets are served from
 * renderer vault state via VaultAgentBridge; credentials never cross the bridge.
 */
function createVaultService(ctx = {}) {
  const { invokeVaultAgent } = ctx;

  function requireBridge() {
    if (typeof invokeVaultAgent !== "function") {
      return { ok: false, error: "Vault agent bridge is unavailable." };
    }
    return null;
  }

  return {
    getHost: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("host.get", { hostId: params.hostId });
    },
    listHosts: async () => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("host.list", {});
    },
    createHosts: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("hosts.create", params);
    },
    importHosts: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("host.import", params);
    },
    getHostNotes: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("host.notes.get", { hostId: params.hostId });
    },
    setHostNotes: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("host.notes.set", {
        hostId: params.hostId,
        notes: params.notes,
      });
    },
    listNotes: async () => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("note.list", {});
    },
    getNote: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("note.get", { noteId: params.noteId });
    },
    createNote: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("note.create", params);
    },
    updateNote: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("note.update", params);
    },
    listSnippets: async () => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("snippets.list", {});
    },
    getSnippet: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("snippets.get", { snippetId: params.snippetId });
    },
    runSnippet: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("snippets.run", {
        snippetId: params.snippetId,
        sessionId: params.sessionId,
        variables: params.variables,
        chatSessionId: params.chatSessionId,
      });
    },
  };
}

module.exports = {
  createVaultService,
};
