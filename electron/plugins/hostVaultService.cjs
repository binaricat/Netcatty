"use strict";

const { createHmac, randomBytes } = require("node:crypto");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);
const METHODS = ["vault.selectHosts", "vault.requestHostDraft", "vault.requestConnect"];
const MAX_SELECTED = 50;
const MAX_REFERENCES = 500;
const TARGET_LIFETIME_MS = 5 * 60_000;

/** Typed host selection only. Selection references identify a reviewed target;
 * the interaction service owns separate operation-specific commit authority. */
class PluginHostVaultService {
  constructor({ sourceBinding, interactionService, clock = Date.now }) {
    this.sourceBinding = sourceBinding;
    this.interactionService = interactionService;
    this.clock = clock;
    this.key = randomBytes(32);
    this.targets = new Map();
    this.admissions = new WeakMap();
    this.validators = Object.fromEntries([
      "VaultSelectHostsParams", "VaultHostDraftParams", "VaultHostConnectParams",
      "VaultHostSelectedResources", "VaultHostCreateFields", "VaultHostEditFields",
    ].map((name) => [name, createDefinitionValidator(name)]));
    interactionService.vaultService = this;
  }

  isRequest(params) { return METHODS.includes(params?.kind); }

  #validate(name, value) {
    if (!this.validators[name](value)) throw fail("invalidArgument", "Host action parameters are invalid");
    if (Buffer.byteLength(JSON.stringify(value)) > 65_536) throw fail("resourceExhausted", "Host action exceeds its size limit");
    return structuredClone(value);
  }

  registerRpcCapabilities(registry) {
    const definitions = ["VaultSelectHostsParams", "VaultHostDraftParams", "VaultHostConnectParams"];
    for (const [index, method] of METHODS.entries()) {
      registry.registerRequest(method, (params, context) => this.request(params, context), {
        metadata: { capability: "vault", mutating: method !== "vault.selectHosts" },
        validateParams: (params) => Object.freeze({ ...this.#validate(definitions[index], params), kind: method }),
        authorization: async (params, context) => {
          const binding = await this.sourceBinding.resolve(context);
          if (params.target) this.#resolveTarget(params.target, params.expectedRevision, binding);
          this.interactionService.admitRequest(params, context);
          this.admissions.set(params, binding);
          return {
            permission: method === "vault.requestHostDraft" ? "vault.write" : method === "vault.selectHosts" ? "vault.metadata" : "ui.interact",
            resources: ["*"], allowedScopes: ["once"], deferDecision: true,
            reason: method === "vault.selectHosts" ? "Choose the current host metadata to share" : method === "vault.requestHostDraft" ? "Review a host draft before saving" : "Review a saved host connection and its script disclosure",
            operationId: method,
          };
        },
      });
    }
  }

  async request(params, originalContext) {
    const binding = await this.sourceBinding.resolve(originalContext);
    if (this.admissions.get(params) !== binding) throw fail("permissionDenied", "Host action admission is unavailable");
    this.admissions.delete(params);
    const assertActive = async () => {
      await originalContext.assertActive();
      if (await this.sourceBinding.resolve(originalContext) !== binding) throw fail("permissionDenied", "Host action source changed");
      if (params.target) this.#resolveTarget(params.target, params.expectedRevision, binding);
    };
    await assertActive();
    return this.interactionService.request(params, Object.freeze({ ...originalContext, assertActive, vaultBinding: binding }));
  }

  #resolveTarget(ref, expectedRevision, binding) {
    const entry = this.targets.get(ref?.handle);
    if (!entry || ref.kind !== "host.selection" || ref.scope !== "metadata" || entry.binding !== binding
      || ref.revision !== entry.revision || expectedRevision !== entry.revision || ref.expiresAt !== entry.expiresAt
      || this.clock() >= entry.expiresAt || entry.owner !== this.interactionService.owner
      || entry.generation !== this.interactionService.ownerGeneration) {
      throw fail("permissionDenied", "Host selection expired or changed; select the host again");
    }
    return entry;
  }

  #issueTarget(resource, context) {
    const entry = {
      binding: context.vaultBinding, resourceId: resource.resourceId, revision: resource.revision,
      owner: this.interactionService.owner, generation: this.interactionService.ownerGeneration,
      expiresAt: this.clock() + TARGET_LIFETIME_MS,
    };
    const nonce = randomBytes(24).toString("base64url");
    const signature = createHmac("sha256", this.key).update(JSON.stringify([
      nonce, entry.binding, entry.owner.id, entry.generation, entry.resourceId,
      entry.revision, entry.expiresAt, "host.selection", "metadata",
    ])).digest("base64url");
    const handle = `${nonce}.${signature}`;
    this.targets.set(handle, entry);
    return { kind: "host.selection", scope: "metadata", handle, revision: entry.revision, expiresAt: entry.expiresAt };
  }

  describePrompt(entry) {
    if (!entry.params.target) return {};
    const target = this.#resolveTarget(entry.params.target, entry.params.expectedRevision, entry.context.vaultBinding);
    return { vaultTarget: { resourceId: target.resourceId, revision: target.revision } };
  }

  async respond(entry, response) {
    await entry.context.assertActive();
    if (response.action === "fail") throw fail("cancelled", "Host resource changed or the action could not complete");
    if (entry.phase === "request" && response.action === "submit") {
      if (entry.params.kind === "vault.selectHosts") {
        const resources = this.#validate("VaultHostSelectedResources", response.resources);
        if (resources.length > MAX_SELECTED || new Set(resources.map((resource) => resource.resourceId)).size !== resources.length) {
          throw fail("invalidArgument", "Host selection is invalid");
        }
        this.releaseSelections(entry.context.vaultBinding);
        this.pruneExpired();
        if (this.targets.size + resources.length > MAX_REFERENCES) throw fail("resourceExhausted", "Too many host selections");
        const hosts = resources.map(({ resourceId, revision, ...metadata }) => ({
          target: this.#issueTarget({ resourceId, revision }, entry.context), metadata,
        }));
        const groups = [...new Set(hosts.map((host) => host.metadata.group).filter(Boolean))].map((path) => ({
          path, members: hosts.filter((host) => host.metadata.group === path).map((host) => host.target),
        }));
        return { result: { cancelled: false, hosts, groups } };
      }
      if (entry.params.kind === "vault.requestHostDraft") {
        const draft = this.#validate(entry.params.target ? "VaultHostEditFields" : "VaultHostCreateFields", response.draft);
        return { phase: "commit", reviewedDraft: draft };
      }
      if (typeof response.scriptsRun !== "boolean") throw fail("invalidArgument", "Connection script disclosure is required");
      return { phase: "commit" };
    }
    if (entry.phase === "commit" && response.action === "commit") return { phase: "executing" };
    if (entry.phase === "executing" && response.action === "complete") {
      return { result: { cancelled: false, status: entry.params.kind === "vault.requestConnect" ? "requested" : "saved" } };
    }
    throw fail("invalidArgument", "Host action phase is invalid");
  }

  pruneExpired() { for (const [handle, entry] of this.targets) if (this.clock() >= entry.expiresAt) this.targets.delete(handle); }
  releaseSelections(binding) { for (const [handle, entry] of this.targets) if (entry.binding === binding) this.targets.delete(handle); }
  releaseRuntime(runtimeId) {
    for (const [handle, entry] of this.targets) if (entry.binding.runtimeId === runtimeId) this.targets.delete(handle);
    this.sourceBinding.releaseRuntime(runtimeId);
  }
  releasePlugin(pluginId) {
    for (const [handle, entry] of this.targets) if (entry.binding.pluginId === pluginId) this.targets.delete(handle);
    // Keep the source helper's pinned runtime binding until runtime stop. A
    // revoked old runtime must never rebind itself to a replacement source.
  }
  clearSelections() { this.targets.clear(); }
  shutdown() { this.targets.clear(); this.sourceBinding.shutdown(); this.key.fill(0); }
}

module.exports = { PluginHostVaultService, METHODS, MAX_SELECTED, TARGET_LIFETIME_MS };
