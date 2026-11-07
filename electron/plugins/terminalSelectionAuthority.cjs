"use strict";

const { randomBytes, createHmac } = require("node:crypto");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const schema = require("./generated/plugin-contract.schema.json");
const LIMITS = schema.$defs.TerminalSelectionSharingLimits.const;
const FEATURE = schema.$defs.TerminalSelectionSharingFeature.const;
const DRAFT_FEATURE = schema.$defs.TerminalInputDraftFeature.const;
const validateTarget = createDefinitionValidator("HostTerminalTarget");
const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);

/** Host-only references. Selected text is retained only by the pending dialog. */
class TerminalSelectionAuthority {
  constructor(options) {
    this.database = options.database;
    this.getWindow = options.getWindow ?? (() => null);
    this.getManager = options.getManager ?? (() => null);
    this.clock = options.clock ?? Date.now;
    this.key = randomBytes(32);
    this.target = null;
    this.handles = new Map();
    this.listeners = new Set();
    this.observed = null;
    this.disposables = [];
    this.timer = setInterval(() => this.invalidate(), 1_000);
    this.timer.unref?.();
  }

  onDidInvalidate(listener) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  invalidate() {
    this.prune();
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }
  observe(manager) {
    if (this.observed === manager) return;
    for (const item of this.disposables) item?.dispose?.();
    this.disposables = [];
    this.observed = manager;
    for (const method of ["onSessionOwned", "onSessionClosed", "onWorkerExit"]) {
      if (typeof manager?.[method] === "function") this.disposables.push(manager[method](() => this.invalidate()));
    }
  }
  owner(context) {
    // Only the database can encode a source owner. Missing APIs and bare IDs fail closed.
    const owner = this.database?.privateOwner?.(context.pluginId);
    if (typeof owner !== "string" || !/^source:[a-f0-9]{64}:[a-z0-9][a-z0-9.-]{1,127}$/u.test(owner)
      || this.database?.publicPluginId?.(owner) !== context.pluginId) {
      throw fail("permissionDenied", "Terminal sharing source owner is unavailable");
    }
    return owner;
  }
  assertFeature(context, feature) {
    const features = [...(context.manifest?.features?.required ?? []), ...(context.manifest?.features?.optional ?? [])];
    if (!features.includes(feature)) throw fail("unsupported", "Terminal sharing feature was not declared");
  }
  setTarget(sender, payload) {
    if (!validateTarget(payload)) throw fail("invalidArgument", "Invalid selected terminal target");
    if (!sender || this.getWindow()?.webContents !== sender || sender.isDestroyed?.()) {
      throw fail("permissionDenied", "Selected terminal belongs to another window");
    }
    if (this.target?.sender === sender && this.target.sessionId === payload.sessionId
      && this.target.rendererId === payload.rendererId && this.target.label === payload.label) return true;
    this.target = payload.sessionId === null ? null : Object.freeze({ sender, ...payload });
    this.invalidate();
    return true;
  }
  capture(sender, context) {
    this.assertFeature(context, FEATURE);
    const manager = this.getManager();
    this.observe(manager);
    if (!this.target || this.target.sender !== sender) throw fail("failedPrecondition", "Select a live terminal in the main window first");
    const { sessionId, rendererId, label } = this.target;
    const binding = manager?.getPluginSessionBinding?.(sessionId, sender.id);
    if (!binding) throw fail("unavailable", "Selected terminal has no active owned worker connection");
    return Object.freeze({ sender, manager, sessionId, rendererId, label, pluginId: context.pluginId,
      privateOwner: this.owner(context), epoch: binding.epoch, generation: binding.generation,
      resource: `terminal-session:${sessionId}:window:${sender.id}:worker:${binding.epoch}:generation:${binding.generation}:renderer:${rendererId}` });
  }
  isCurrent(target) {
    if (!target || this.getWindow()?.webContents !== target.sender || this.target?.sender !== target.sender
      || this.target?.sessionId !== target.sessionId || this.target?.rendererId !== target.rendererId
      || target.sender.isDestroyed?.() || this.getManager() !== target.manager) return false;
    try { if (this.owner(target) !== target.privateOwner) return false; } catch { return false; }
    try {
      const current = target.manager.getPluginSessionBinding(target.sessionId, target.sender.id);
      return !!current && current.epoch === target.epoch && current.generation === target.generation;
    } catch { return false; }
  }
  assertCurrent(target) { if (!this.isCurrent(target)) throw fail("cancelled", "Selected terminal connection, renderer, source or owner changed"); }
  prune() {
    for (const [token, entry] of this.handles) {
      if (entry.expiresAt <= this.clock() || !this.isCurrent(entry.target)) this.handles.delete(token);
    }
  }
  issue(target, context) {
    this.assertCurrent(target);
    this.prune();
    if (this.handles.size >= LIMITS.handlesTotal
      || [...this.handles.values()].filter((e) => e.runtimeId === context.runtimeId).length >= LIMITS.handlesPerRuntime) {
      throw fail("resourceExhausted", "Terminal selection handle limit reached");
    }
    const expiresAt = this.clock() + LIMITS.handleTtlMs;
    const nonce = randomBytes(24).toString("base64url");
    const signature = createHmac("sha256", this.key).update(JSON.stringify([
      nonce, target.resource, target.privateOwner, context.pluginVersion, context.runtimeId, expiresAt,
    ])).digest("base64url");
    const handle = `${nonce}.${signature}`;
    this.handles.set(handle, { target, expiresAt, pluginVersion: context.pluginVersion, runtimeId: context.runtimeId });
    return { handle, expiresAt };
  }
  resolve(handle, context) {
    this.assertFeature(context, DRAFT_FEATURE);
    this.prune();
    const entry = this.handles.get(handle);
    if (!entry || entry.target.pluginId !== context.pluginId || entry.target.privateOwner !== this.owner(context)
      || entry.pluginVersion !== context.pluginVersion || entry.runtimeId !== context.runtimeId) {
      throw fail("permissionDenied", "Terminal selection handle is unavailable");
    }
    this.assertCurrent(entry.target);
    return entry.target;
  }
  releaseRuntime(runtimeId) { for (const [key, entry] of this.handles) if (entry.runtimeId === runtimeId) this.handles.delete(key); }
  releasePlugin(pluginId) { for (const [key, entry] of this.handles) if (entry.target.pluginId === pluginId) this.handles.delete(key); }
  releaseWindow(sender) { if (this.target?.sender === sender) this.target = null; this.invalidate(); }
  clearHandles() { this.handles.clear(); }
  shutdown() {
    clearInterval(this.timer);
    for (const item of this.disposables) item?.dispose?.();
    this.handles.clear(); this.listeners.clear(); this.target = null; this.key.fill(0);
  }
}
module.exports = { TerminalSelectionAuthority, FEATURE, DRAFT_FEATURE, LIMITS };
