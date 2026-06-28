"use strict";

/** Matches waitForScriptRun default (1h) plus bridge overhead. */
const VAULT_AGENT_SCRIPT_WAIT_TIMEOUT_MS = 3_605_000;

function parseVaultAgentWaitFlag(raw) {
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw === "boolean") return raw;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function vaultAgentInvokeOptions(op, params = {}) {
  if (op !== "snippets.run" && op !== "scripts.run") return undefined;
  if (!parseVaultAgentWaitFlag(params.wait)) return undefined;
  return { timeoutMs: VAULT_AGENT_SCRIPT_WAIT_TIMEOUT_MS };
}

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
        wait: params.wait,
      }, vaultAgentInvokeOptions("snippets.run", params));
    },
    createSnippet: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("snippets.create", params);
    },
    updateSnippet: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("snippets.update", params);
    },
    deleteSnippet: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("snippets.delete", params);
    },
    listScripts: async () => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.list", {});
    },
    getScript: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.get", { scriptId: params.scriptId, snippetId: params.scriptId });
    },
    createScript: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.create", params);
    },
    updateScript: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.update", params);
    },
    deleteScript: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.delete", params);
    },
    runScript: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.run", params, vaultAgentInvokeOptions("scripts.run", params));
    },
    getScriptReference: async () => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.reference", {});
    },
    listScriptRuns: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.runs.list", params);
    },
    stopScriptRun: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.run.stop", params);
    },
    pauseScriptRun: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.run.pause", params);
    },
    resumeScriptRun: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.run.resume", params);
    },
    setScriptTargets: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("scripts.targets.set", params);
    },
    listHostConnectScripts: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("host.connectScripts.list", params);
    },
    setHostConnectScripts: async (params = {}) => {
      const bridgeErr = requireBridge();
      if (bridgeErr) return bridgeErr;
      return invokeVaultAgent("host.connectScripts.set", params);
    },
  };
}

module.exports = {
  createVaultService,
};
