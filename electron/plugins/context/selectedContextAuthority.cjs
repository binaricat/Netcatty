"use strict";

const { randomUUID } = require("node:crypto");
const { PluginRpcError, RPC_ERRORS } = require("../rpcRouter.cjs");
const { assertPluginJsonValue } = require("../jsonBoundary.cjs");
const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);
const SCOPES = new Set(["workspace", "tab", "session", "host", "note"]);
const LIMITS = Object.freeze({ handles: 128, perRuntime: 8, contentBytes: 16_384, ttlMs: 300_000, readMs: 5_000 });

// Internal host authority. Only trusted selection/review UI may call share().
// A menu id, plugin supplied entity id or global inventory is never accepted.
class SelectedContextAuthority {
  constructor({ resolveDataOwner, clock = Date.now, limits = {} }) {
    if (typeof resolveDataOwner !== "function") throw new TypeError("Host data-owner resolver required");
    this.resolveDataOwner = resolveDataOwner;
    this.clock = clock;
    this.limits = Object.freeze(Object.fromEntries(Object.entries(LIMITS).map(([key, max]) => {
      const value = limits[key] ?? max;
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${key} limit`);
      return [key, value];
    })));
    this.handles = new Map();
    this.closed = false;
    this.listeners = new Set();
  }

  async binding(context) {
    context.signal?.throwIfAborted();
    await context.assertActive();
    const owner = await this.resolveDataOwner(context);
    await context.assertActive();
    if (!owner || (typeof owner !== "object" && typeof owner !== "string")) {
      throw fail("permissionDenied", "Host data owner is unavailable");
    }
    context.signal?.throwIfAborted();
    return { owner, runtimeId: context.runtimeId, pluginVersion: context.pluginVersion };
  }

  async #check(entry, context) {
    const binding = await this.binding(context);
    if (this.closed || this.handles.get(entry.handle) !== entry || entry.expiresAt <= this.clock()
      || binding.owner !== entry.owner || binding.runtimeId !== entry.runtimeId
      || binding.pluginVersion !== entry.pluginVersion) throw fail("permissionDenied", "Selected context is unavailable");
    context.signal?.throwIfAborted();
    // The trusted reader checks the current window/resource generation and owner.
    // Recheck our map after awaiting it: close/revoke/version changes can race.
    const current = await entry.isCurrent();
    const currentOwner = await this.resolveDataOwner(context);
    await context.assertActive();
    context.signal?.throwIfAborted();
    if (!current || currentOwner !== entry.owner || this.handles.get(entry.handle) !== entry || this.closed || entry.expiresAt <= this.clock()) {
      throw fail("permissionDenied", "Selected context changed");
    }
  }

  #prune() {
    for (const [handle, entry] of this.handles) if (entry.expiresAt <= this.clock()) this.release(handle);
  }

  async share(selection, context) {
    if (this.closed) throw fail("unavailable", "Selected context is closed");
    assertPluginJsonValue({ scope: selection.scope, title: selection.title, version: selection.version }, { maxBytes: 1024 });
    if (!SCOPES.has(selection.scope) || typeof selection.title !== "string" || selection.title.length > 160
      || typeof selection.version !== "string" || !selection.version || selection.version.length > 128
      || typeof selection.readText !== "function" || typeof selection.isCurrent !== "function") {
      throw fail("invalidArgument", "Invalid selected context");
    }
    // This API accepts a curated text reader, never a Host/Vault DTO. Passwords,
    // private keys and arbitrary entity fields have no place in the descriptor.
    if (Object.keys(selection).some((key) => !["scope", "title", "version", "readText", "isCurrent"].includes(key))) {
      throw fail("invalidArgument", "Selected context contains unsupported fields");
    }
    const binding = await this.binding(context);
    if (!await selection.isCurrent()) throw fail("permissionDenied", "Selection is no longer current");
    await context.assertActive();
    this.#prune();
    if (this.closed || this.handles.size >= this.limits.handles
      || [...this.handles.values()].filter((entry) => entry.runtimeId === context.runtimeId).length >= this.limits.perRuntime) {
      throw fail("resourceExhausted", "Selected context handle limit reached");
    }
    const entry = { ...binding, ...selection, handle: randomUUID(), expiresAt: this.clock() + this.limits.ttlMs };
    this.handles.set(entry.handle, entry);
    return this.#summary(entry);
  }

  #summary(entry) {
    return { handle: entry.handle, scope: entry.scope, title: entry.title, version: entry.version, expiresAt: entry.expiresAt };
  }

  async summaries(context) {
    const binding = await this.binding(context);
    this.#prune();
    const summaries = [];
    for (const entry of [...this.handles.values()]) {
      if (entry.owner !== binding.owner || entry.runtimeId !== binding.runtimeId || entry.pluginVersion !== binding.pluginVersion) continue;
      try { await this.#check(entry, context); summaries.push(this.#summary(entry)); }
      catch (error) { if (context.signal?.aborted) throw error; this.release(entry.handle); }
    }
    await context.assertActive();
    return summaries;
  }

  async #read({ handle, version }, context) {
    const entry = this.handles.get(handle);
    if (!entry || entry.version !== version) throw fail("permissionDenied", "Selected context is unavailable");
    await this.#check(entry, context);
    let text;
    try { text = await entry.readText({ signal: context.signal, maxBytes: this.limits.contentBytes }); }
    catch { throw fail("unavailable", "Selected context reader failed"); }
    await this.#check(entry, context);
    if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > this.limits.contentBytes) {
      throw fail("resourceExhausted", "Selected context exceeds its text limit");
    }
    // Do not disclose private key material even if a curated text reader errs.
    if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)) {
      throw fail("permissionDenied", "Private key material cannot be shared");
    }
    return { ...this.#summary(entry), text };
  }

  async read(reference, context) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(fail("deadlineExceeded", "Selected context read timed out")), this.limits.readMs);
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    let abort;
    try {
      signal.throwIfAborted();
      return await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        this.#read(reference, { ...context, signal }).then(resolve, reject);
      });
    } finally {
      clearTimeout(timeout);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  async assertCurrent({ handle, version }, context) {
    const entry = this.handles.get(handle);
    if (!entry || entry.version !== version) throw fail("permissionDenied", "Selected context is unavailable");
    await this.#check(entry, context);
  }
  onDidInvalidate(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  release(handle) {
    if (!this.handles.delete(handle)) return;
    for (const listener of [...this.listeners]) {
      // Revocation must finish even when an observer fails. Never log selected
      // text or let an observer exception retain another runtime handle.
      try { listener(handle); } catch {}
    }
  }
  releaseRuntime(runtimeId) {
    for (const [handle, entry] of this.handles) if (entry.runtimeId === runtimeId) this.release(handle);
  }
  releaseOwner(owner) {
    for (const [handle, entry] of this.handles) if (entry.owner === owner) this.release(handle);
  }
  shutdown() { this.closed = true; for (const handle of [...this.handles.keys()]) this.release(handle); this.listeners.clear(); }
}

module.exports = { SelectedContextAuthority, SELECTED_CONTEXT_LIMITS: LIMITS };
