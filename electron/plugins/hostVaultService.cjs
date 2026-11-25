"use strict";

const { createHmac, randomBytes } = require("node:crypto");
const { canonicalizeStreamEndpoint } = require("./byteStreamEndpoint.cjs");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);
const METHODS = ["vault.selectHosts", "vault.requestHostDraft", "vault.requestConnect", "network.stream.connectViaHost"];
const MAX_SELECTED = 50;
const MAX_REFERENCES = 500;
const TARGET_LIFETIME_MS = 5 * 60_000;

/** Typed host selection only. Selection references identify a reviewed target;
 * the interaction service owns separate operation-specific commit authority. */
class PluginHostVaultService {
  constructor({ sourceBinding, interactionService, openStream, clock = Date.now }) {
    this.sourceBinding = sourceBinding;
    this.openStream = openStream;
    this.interactionService = interactionService;
    this.clock = clock;
    this.key = randomBytes(32);
    this.targets = new Map();
    this.streams = new Set();
    this.admissions = new WeakMap();
    this.validators = Object.fromEntries([
      "VaultSelectHostsParams", "VaultHostDraftParams", "VaultHostConnectParams",
      "HostByteStreamConnectRequest", "VaultHostSelectedResources", "VaultHostCreateFields", "VaultHostEditFields",
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
    const definitions = ["VaultSelectHostsParams", "VaultHostDraftParams", "VaultHostConnectParams", "HostByteStreamConnectRequest"];
    for (const [index, method] of METHODS.entries()) {
      registry.registerRequest(method, (params, context) => this.request(params, context), {
        metadata: { capability: "vault", mutating: method !== "vault.selectHosts" },
        validateParams: (params) => {
          const validated = this.#validate(definitions[index], params);
          if (method === "network.stream.connectViaHost") {
            try { validated.endpoint = canonicalizeStreamEndpoint(validated.endpoint).endpoint; }
            catch { throw fail("invalidArgument", "Host stream destination is invalid"); }
          }
          return Object.freeze({ ...validated, kind: method });
        },
        authorization: async (params, context) => {
          if (method === "network.stream.connectViaHost" && (!context.manifest?.features?.required?.includes("network.host-byte-streams") || !context.manifest?.features?.required?.includes("network.byte-streams"))) {
            throw fail("unsupported", "Host byte stream features were not negotiated");
          }
          const binding = await this.sourceBinding.resolve(context);
          if (params.target) this.#resolveTarget(params.target, params.expectedRevision, binding);
          this.interactionService.admitRequest(params, context);
          this.admissions.set(params, binding);
          return {
            permission: method === "network.stream.connectViaHost" ? "network.hostStream" : method === "vault.requestHostDraft" ? "vault.write" : method === "vault.selectHosts" ? "vault.metadata" : "ui.interact",
            resources: ["*"], allowedScopes: ["once"], deferDecision: true,
            reason: method === "network.stream.connectViaHost" ? "Review the selected SSH server and exact data destination" : method === "vault.selectHosts" ? "Choose the current host metadata to share" : method === "vault.requestHostDraft" ? "Review a host draft before saving" : "Review a saved host connection and its script disclosure",
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
    const assertStreamActive = async () => {
      await originalContext.assertActive();
      if (await this.sourceBinding.resolve(originalContext) !== binding) throw fail("permissionDenied", "Host stream source changed");
    };
    const assertActive = async () => {
      await originalContext.assertActive();
      if (await this.sourceBinding.resolve(originalContext) !== binding) throw fail("permissionDenied", "Host action source changed");
      if (params.target) this.#resolveTarget(params.target, params.expectedRevision, binding);
    };
    await assertActive();
    return this.interactionService.request(params, Object.freeze({ ...originalContext, assertActive, assertStreamActive, vaultBinding: binding }));
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

  async respond(entry, response, nativeOptions) {
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
      if (entry.params.kind === "network.stream.connectViaHost") return { phase: "commit" };
      if (typeof response.scriptsRun !== "boolean") throw fail("invalidArgument", "Connection script disclosure is required");
      return { phase: "commit" };
    }
    if (entry.params.kind === "network.stream.connectViaHost" && entry.phase === "commit" && response.action === "commit") {
      const target = this.#resolveTarget(entry.params.target, entry.params.expectedRevision, entry.context.vaultBinding);
      if (!this.openStream || !nativeOptions || nativeOptions.hostId !== target.resourceId) throw fail("permissionDenied", "Reviewed server connection is unavailable");
      const assertActive = async () => {
        entry.controller.signal.throwIfAborted();
        if (entry.streamDelivered) await entry.context.assertStreamActive();
        else await entry.context.assertActive();
        if (!entry.streamDelivered) this.#resolveTarget(entry.params.target, entry.params.expectedRevision, entry.context.vaultBinding);
      };
      const lease = { controller: entry.controller, runtimeId: entry.context.runtimeId, pluginId: entry.context.pluginId };
      this.streams.add(lease);
      entry.controller.signal.addEventListener("abort", () => this.streams.delete(lease), { once: true });
      const handle = await this.openStream(entry.params.endpoint, { ...entry.context, signal: entry.controller.signal, assertActive }, entry.sender, nativeOptions);
      handle.onClose?.(() => { this.streams.delete(lease); });
      entry.disposeResult = () => { this.streams.delete(lease); handle.close(); };
      return { result: handle.descriptor };
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
    for (const lease of this.streams) if (lease.runtimeId === runtimeId) lease.controller.abort();
    for (const [handle, entry] of this.targets) if (entry.binding.runtimeId === runtimeId) this.targets.delete(handle);
    this.sourceBinding.releaseRuntime(runtimeId);
  }
  releasePlugin(pluginId) {
    for (const lease of this.streams) if (lease.pluginId === pluginId) lease.controller.abort();
    for (const [handle, entry] of this.targets) if (entry.binding.pluginId === pluginId) this.targets.delete(handle);
    // Keep the source helper's pinned runtime binding until runtime stop. A
    // revoked old runtime must never rebind itself to a replacement source.
  }
  clearSelections() { this.targets.clear(); for (const lease of this.streams) lease.controller.abort(); }
  shutdown() { this.clearSelections(); this.sourceBinding.shutdown(); this.key.fill(0); }
}

module.exports = { PluginHostVaultService, METHODS, MAX_SELECTED, TARGET_LIFETIME_MS };
