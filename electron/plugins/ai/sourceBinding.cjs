"use strict";

const { PluginRpcError, RPC_ERRORS } = require("../rpcRouter.cjs");
const denied = () => new PluginRpcError(RPC_ERRORS.permissionDenied, "Plugin source binding is unavailable");

// Consume the market task's host-owned API. No source or owner is read from RPC
// parameters, and a missing API/retained source fails closed.
class PluginAISourceBinding {
  constructor({ database, getRuntimeIdentity }) {
    for (const method of ["getActivePlugin", "getRetainedPluginSource", "privateOwner", "publicPluginId"]) {
      if (typeof database?.[method] !== "function") throw new TypeError(`Source database ${method} is required`);
    }
    if (typeof getRuntimeIdentity !== "function") throw new TypeError("Runtime identity resolver required");
    this.database = database;
    this.getRuntimeIdentity = getRuntimeIdentity;
    this.bindings = new Map();
  }

  #snapshot(context) {
    const identity = this.getRuntimeIdentity(context.pluginId);
    if (!identity || identity.pluginId !== context.pluginId || identity.runtimeId !== context.runtimeId
      || identity.pluginVersion !== context.pluginVersion || identity.runtimeKind !== "browser") throw denied();
    const plugin = this.database.getActivePlugin(identity.pluginId);
    const source = plugin?.source;
    const retained = this.database.getRetainedPluginSource(identity.pluginId);
    if (!plugin?.enabled || plugin.activeVersion !== identity.pluginVersion || !source || !retained
      || !["starting", "running"].includes(plugin.runtime?.status)
      || typeof source.id !== "string" || typeof source.kind !== "string"
      || source.id !== retained.id || source.kind !== retained.kind || source.origin !== retained.origin) throw denied();
    const privateOwner = this.database.privateOwner(identity.pluginId);
    if (typeof privateOwner !== "string" || !privateOwner || this.database.publicPluginId(privateOwner) !== identity.pluginId) throw denied();
    return { runtimeId: identity.runtimeId, pluginId: identity.pluginId, pluginVersion: identity.pluginVersion,
      sourceKey: JSON.stringify([source.id, source.kind, source.origin ?? null]), privateOwner };
  }

  async resolve(context) {
    // Authenticate first. Even the database source lookup follows this guard.
    await context.assertActive();
    context.signal?.throwIfAborted();
    const snapshot = this.#snapshot(context);
    const previous = this.bindings.get(snapshot.runtimeId);
    if (previous && (previous.sourceKey !== snapshot.sourceKey || previous.privateOwner !== snapshot.privateOwner
      || previous.pluginId !== snapshot.pluginId || previous.pluginVersion !== snapshot.pluginVersion)) throw denied();
    await context.assertActive();
    context.signal?.throwIfAborted();
    const current = this.#snapshot(context);
    if (current.sourceKey !== snapshot.sourceKey || current.privateOwner !== snapshot.privateOwner) throw denied();
    if (previous) return previous;
    const binding = Object.freeze(snapshot);
    this.bindings.set(binding.runtimeId, binding);
    return binding;
  }

  // Main-owned final dispatch guard. Only a previously authenticated binding
  // object can reach this path; it is never reconstructed from plugin fields.
  assertCurrent(binding) {
    if (!binding || this.bindings.get(binding.runtimeId) !== binding) throw denied();
    const current = this.#snapshot(binding);
    if (current.sourceKey !== binding.sourceKey || current.privateOwner !== binding.privateOwner
      || current.pluginId !== binding.pluginId || current.pluginVersion !== binding.pluginVersion) throw denied();
  }

  releaseRuntime(runtimeId) { this.bindings.delete(runtimeId); }
  releasePlugin(pluginId) {
    for (const [runtimeId, binding] of this.bindings) if (binding.pluginId === pluginId) this.bindings.delete(runtimeId);
  }
  shutdown() { this.bindings.clear(); }
}

module.exports = { PluginAISourceBinding };
