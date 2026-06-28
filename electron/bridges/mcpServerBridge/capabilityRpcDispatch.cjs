"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../../capabilities/constants.cjs");
const { getCapabilityByRpcMethod } = require("../../capabilities/registry.cjs");
const { getMcpToolNameForRpcMethod } = require("../../capabilities/adapters/mcpAdapter.cjs");
const { createVaultService } = require("../../capabilities/services/vaultService.cjs");
const { createPortForwardService } = require("../../capabilities/services/portforwardService.cjs");

const UNROUTED = Symbol("capability-rpc-unrouted");

const SERVICE_BINDINGS = Object.freeze({
  "vault.host.get": { domain: "vault", method: "getHost" },
  "vault.host.list": { domain: "vault", method: "listHosts" },
  "vault.hosts.create": { domain: "vault", method: "createHosts" },
  "vault.host.import": { domain: "vault", method: "importHosts" },
  "vault.host.notes.get": { domain: "vault", method: "getHostNotes" },
  "vault.host.notes.set": { domain: "vault", method: "setHostNotes" },
  "vault.note.list": { domain: "vault", method: "listNotes" },
  "vault.note.get": { domain: "vault", method: "getNote" },
  "vault.note.create": { domain: "vault", method: "createNote" },
  "vault.note.update": { domain: "vault", method: "updateNote" },
  "vault.snippets.list": { domain: "vault", method: "listSnippets" },
  "vault.snippets.get": { domain: "vault", method: "getSnippet" },
  "vault.snippets.run": { domain: "vault", method: "runSnippet" },
  "vault.snippets.create": { domain: "vault", method: "createSnippet" },
  "vault.snippets.update": { domain: "vault", method: "updateSnippet" },
  "vault.snippets.delete": { domain: "vault", method: "deleteSnippet" },
  "vault.scripts.list": { domain: "vault", method: "listScripts" },
  "vault.scripts.get": { domain: "vault", method: "getScript" },
  "vault.scripts.create": { domain: "vault", method: "createScript" },
  "vault.scripts.update": { domain: "vault", method: "updateScript" },
  "vault.scripts.delete": { domain: "vault", method: "deleteScript" },
  "vault.scripts.run": { domain: "vault", method: "runScript" },
  "vault.scripts.reference": { domain: "vault", method: "getScriptReference" },
  "vault.scripts.runs.list": { domain: "vault", method: "listScriptRuns" },
  "vault.scripts.run.stop": { domain: "vault", method: "stopScriptRun" },
  "vault.scripts.run.pause": { domain: "vault", method: "pauseScriptRun" },
  "vault.scripts.run.resume": { domain: "vault", method: "resumeScriptRun" },
  "vault.scripts.targets.set": { domain: "vault", method: "setScriptTargets" },
  "vault.host.connectScripts.list": { domain: "vault", method: "listHostConnectScripts" },
  "vault.host.connectScripts.set": { domain: "vault", method: "setHostConnectScripts" },
  "portforward.rules.list": { domain: "portforward", method: "listRules" },
  "portforward.tunnels.list": { domain: "portforward", method: "listTunnels" },
  "portforward.start": { domain: "portforward", method: "start" },
  "portforward.stop": { domain: "portforward", method: "stop" },
});

function resolveCapabilitySurface(rpcMethod) {
  for (const surface of [
    CAPABILITY_SURFACES.PUBLIC,
    CAPABILITY_SURFACES.GLOBAL,
    CAPABILITY_SURFACES.BUILTIN,
  ]) {
    if (rpcMethod.startsWith("netcatty/") && surface !== CAPABILITY_SURFACES.BUILTIN) {
      continue;
    }
    const capability = getCapabilityByRpcMethod(rpcMethod, surface);
    if (capability) {
      return { capability, surface };
    }
  }
  return null;
}

function createCapabilityRpcDispatcher(deps) {
  const {
    invokeVaultAgent,
    evaluatePermissionWithGrants,
    isChatSessionCancelled,
    requestApprovalFromRenderer,
    USER_DENIED_MESSAGE,
  } = deps;

  const vaultService = createVaultService({ invokeVaultAgent });
  const portforwardService = createPortForwardService({ invokeVaultAgent });
  const services = {
    vault: vaultService,
    portforward: portforwardService,
  };

  return async function dispatchCapabilityRpc(rpcMethod, params = {}) {
    if (typeof rpcMethod !== "string" || rpcMethod.startsWith("netcatty/")) {
      return UNROUTED;
    }

    const resolved = resolveCapabilitySurface(rpcMethod);
    if (!resolved) {
      return UNROUTED;
    }

    const { capability, surface } = resolved;
    if (capability.status !== CAPABILITY_STATUS.IMPLEMENTED) {
      return {
        ok: false,
        code: "CAPABILITY_NOT_IMPLEMENTED",
        error: `Capability "${capability.id}" is not implemented yet.`,
      };
    }

    const binding = SERVICE_BINDINGS[capability.id];
    if (!binding) {
      return UNROUTED;
    }

    const permission = evaluatePermissionWithGrants({
      rpcMethod,
      surface,
      permissionMode: deps.permissionMode,
      params,
      context: {
        chatSessionCancelled: isChatSessionCancelled(params?.chatSessionId),
      },
    }, deps.permissionGrantsSnapshot);

    if (!permission.allowed) {
      return { ok: false, error: permission.error };
    }

    if (permission.requiresApproval) {
      const { chatSessionId, ...toolArgs } = params || {};
      const toolName = getMcpToolNameForRpcMethod(rpcMethod, surface) || capability.id;
      const approved = await requestApprovalFromRenderer(toolName, toolArgs, chatSessionId);
      if (!approved) {
        return { ok: false, error: USER_DENIED_MESSAGE };
      }
    }

    const service = services[binding.domain];
    const handler = service?.[binding.method];
    if (typeof handler !== "function") {
      return {
        ok: false,
        error: `Capability handler "${capability.id}" is unavailable.`,
      };
    }

    return handler(params);
  };
}

module.exports = {
  UNROUTED,
  createCapabilityRpcDispatcher,
  SERVICE_BINDINGS,
};
