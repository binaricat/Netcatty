"use strict";

const { randomUUID } = require("node:crypto");
const { PluginRpcError, RPC_ERRORS } = require("../rpcRouter.cjs");

const fail = (code) => new PluginRpcError(RPC_ERRORS[code], "Delegated Agent scope is unavailable");
const key = (target) => JSON.stringify([target.kind, target.id]);
const isRequestCancellation = (error, context) => context.signal?.aborted === true
  && (error === context.signal.reason || error?.name === "AbortError" || error?.name === "TimeoutError"
    || error?.code === RPC_ERRORS.cancelled || error?.code === RPC_ERRORS.deadlineExceeded);

// Host-only authority, not a plugin RPC interface or an Agent engine. The host
// supplies snapshots after resolving configured backends and choosing targets.
// Plugins never supply owner, revision, capability policy or executable adapters.
class DelegatedAgentScopes {
  constructor({ resolveOwner, assertHostActive, authorizeAction, clock = Date.now }) {
    for (const fn of [resolveOwner, assertHostActive, authorizeAction, clock]) {
      if (typeof fn !== "function") throw new TypeError("Host scope adapters are required");
    }
    this.resolveOwner = resolveOwner;
    this.assertHostActive = assertHostActive;
    this.authorizeAction = authorizeAction;
    this.clock = clock;
    this.scopes = new Map();
    this.closed = false;
  }

  async #owner(context) {
    if (this.closed) throw fail("unavailable");
    const owner = await this.resolveOwner(context);
    await this.assertHostActive(context);
    context.signal?.throwIfAborted();
    if (this.closed || await this.resolveOwner(context) !== owner) throw fail("permissionDenied");
    return owner;
  }

  // The snapshot is host-owned. A public schema must only accept returned handles.
  async issue(context, { backend, targets, capabilities }) {
    const owner = await this.#owner(context);
    if (!backend || typeof backend.key !== "string" || typeof backend.revision !== "string"
      || typeof backend.isCurrent !== "function" || !Array.isArray(targets) || targets.length > 32
      || !Array.isArray(capabilities) || capabilities.length > 128
      || capabilities.some((id) => typeof id !== "string" || !id || id.length > 160)) throw fail("invalidArgument");
    const captured = new Map();
    for (const target of targets) {
      if (!target || !["terminal", "host", "note"].includes(target.kind)
        || typeof target.id !== "string" || !target.id || target.id.length > 256
        || typeof target.revision !== "string" || !target.revision
        || typeof target.owner !== "string" || !target.owner
        || typeof target.isCurrent !== "function" || captured.has(key(target))) throw fail("invalidArgument");
      captured.set(key(target), Object.freeze({ ...target }));
    }
    const scope = { handle: randomUUID(), owner, backend: Object.freeze({ ...backend }), targets: captured,
      capabilities: new Set(capabilities), expiresAt: this.clock() + 300_000, activeTurn: null };
    this.#assertSnapshots(scope);
    if (await this.#owner(context) !== owner) throw fail("permissionDenied");
    this.#assertSnapshots(scope);
    for (const entry of this.scopes.values()) if (entry.expiresAt <= this.clock()) this.#revoke(entry);
    const existing = [...this.scopes.values()].filter((entry) => entry.owner === owner);
    if (existing.length >= 8 || this.scopes.size >= 64) throw fail("resourceExhausted");
    this.scopes.set(scope.handle, scope);
    return Object.freeze({ handle: scope.handle, expiresAt: scope.expiresAt });
  }

  #assertSnapshots(scope) {
    // Current-owner/revision checks are synchronous registry lookups, so the
    // final dispatch check and native call have no asynchronous focus gap.
    if (scope.backend.isCurrent(scope.backend) !== true) throw fail("failedPrecondition");
    for (const target of scope.targets.values()) {
      if (target.isCurrent(target) !== true) throw fail("failedPrecondition");
    }
  }

  async #resolve(handle, context) {
    const scope = this.scopes.get(handle);
    let owner;
    try { owner = await this.#owner(context); }
    catch (error) {
      // Context identity comes from the authenticated host transport. Revoke
      // only its own captured scope, never a victim referenced by another caller.
      if (!isRequestCancellation(error, context) && scope && scope.owner.runtimeId === context.runtimeId && scope.owner.pluginId === context.pluginId
        && scope.owner.pluginVersion === context.pluginVersion) this.#revoke(scope);
      throw error;
    }
    if (!scope || scope.owner !== owner) throw fail("permissionDenied");
    if (scope.expiresAt <= this.clock()) { this.#revoke(scope); throw fail("permissionDenied"); }
    try {
      if (await this.#owner(context) !== owner || this.scopes.get(handle) !== scope
        || scope.expiresAt <= this.clock()) throw fail("permissionDenied");
      this.#assertSnapshots(scope);
    } catch (error) {
      // A failed individual RPC has no authority to revoke another turn. Real
      // owner/target failure still invalidates the scope, even if a request also
      // happens to be cancelled at that time.
      if (!isRequestCancellation(error, context)) this.#revoke(scope);
      throw error;
    }
    return scope;
  }

  async begin(handle, context) {
    const scope = await this.#resolve(handle, context);
    if (scope.activeTurn) throw fail("alreadyExists");
    const ticket = Object.freeze({ scope, controller: new AbortController(), id: randomUUID() });
    scope.activeTurn = ticket;
    return ticket;
  }

  async assertTurn(ticket, context) {
    if (!ticket?.scope || ticket.controller.signal.aborted) throw fail("cancelled");
    const scope = await this.#resolve(ticket.scope.handle, context);
    if (scope.activeTurn !== ticket) throw fail("cancelled");
    ticket.controller.signal.throwIfAborted();
    return scope;
  }

  // Called inside the actual tool dispatcher, after canonical argument/target
  // resolution. It must not be used merely when displaying the model tool list.
  async dispatch(ticket, context, action, execute) {
    const scope = await this.assertTurn(ticket, context);
    if (!action || !scope.capabilities.has(action.capabilityId) || !Array.isArray(action.targets)
      || action.targets.length > 32 || typeof execute !== "function") throw fail("permissionDenied");
    const targets = action.targets.map((target) => {
      const captured = target && scope.targets.get(key(target));
      if (!captured || target.revision !== captured.revision || target.owner !== captured.owner) throw fail("permissionDenied");
      return captured;
    });
    const request = Object.freeze({ capabilityId: action.capabilityId, targets: Object.freeze(targets) });
    // The adapter combines plugin policy and native Agent restrictions once.
    // No caller can select a process-global permission mode through this API.
    await this.authorizeAction(context, scope.owner, request, ticket.controller.signal);
    await this.assertTurn(ticket, context);
    this.#assertSnapshots(scope);
    ticket.controller.signal.throwIfAborted();
    const result = await execute(Object.freeze({ signal: ticket.controller.signal,
      assertCurrent: () => this.assertTurn(ticket, context) }));
    await this.assertTurn(ticket, context);
    return result;
  }

  finish(ticket) {
    if (!ticket || ticket.scope?.activeTurn !== ticket) return false;
    ticket.scope.activeTurn = null;
    ticket.controller.abort();
    return true;
  }

  async stop(handle, context) {
    // Capture before the first await. A prior Stop cannot acquire authority over
    // a turn that replaces the one the caller intended to stop.
    const candidate = this.scopes.get(handle);
    const ticket = candidate?.activeTurn;
    const scope = await this.#resolve(handle, context);
    return scope === candidate ? this.finish(ticket) : false;
  }

  #revoke(scope) {
    this.finish(scope.activeTurn);
    this.scopes.delete(scope.handle);
  }

  releaseRuntime(runtimeId) {
    for (const scope of this.scopes.values()) if (scope.owner.runtimeId === runtimeId) this.#revoke(scope);
  }

  // Main-owned cleanup after a pending operation loses its lease. Exact owner
  // object matching prevents old cleanup from deleting a replacement source.
  discard(handle, owner) {
    const scope = this.scopes.get(handle);
    if (!scope || scope.owner !== owner) return false;
    this.#revoke(scope);
    return true;
  }

  releasePlugin(pluginId) {
    for (const scope of this.scopes.values()) if (scope.owner.pluginId === pluginId) this.#revoke(scope);
  }

  releaseAll() {
    for (const scope of this.scopes.values()) this.#revoke(scope);
  }

  shutdown() {
    this.closed = true;
    this.releaseAll();
  }
}

module.exports = { DelegatedAgentScopes, isRequestCancellation };
