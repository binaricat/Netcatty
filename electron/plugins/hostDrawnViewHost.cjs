"use strict";

const { createHash } = require("node:crypto");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { validatePluginMutationBatch } = require("../../domain/pluginRemoteTreePolicy.cjs");
const { validatePluginStylesheet } = require("../../domain/pluginViewStylePolicy.cjs");
const validateMessage = createDefinitionValidator("HostDrawnViewMessage");
const validateOpen = createDefinitionValidator("HostDrawnViewOpenRequest");
const validateEvent = createDefinitionValidator("HostDrawnViewEvent");

/** Owns logical views only: never creates a native view or exposes plugin code to the host. */
class HostDrawnViewHost {
  constructor({ electron, contributionService, resources, isLocked = () => false, subscribeLock }) {
    this.resources = resources;
    this.electron = electron; this.contributions = contributionService; this.isLocked = isLocked;
    this.instances = new Map(); this.opening = new Map(); this.closed = false;
    this.messageSubscription = contributionService.onDidPostViewMessage((event) => this.receive(event));
    this.changeSubscription = contributionService.onDidChange?.((event) => {
      for (const instance of [...this.instances.values()]) {
        if (["plugin-disabled", "runtime-stopped", "runtime-error", "runtime-quarantined"].includes(event.reason) && event.pluginId === instance.pluginId) {
          void this.close(instance.id, undefined, event.reason);
        } else {
          try { this.contributions.assertViewActivationCurrent(instance.activation, { context: instance.context }); }
          catch { void this.close(instance.id, undefined, "contribution-unavailable"); }
        }
      }
    });
    this.unsubscribeLock = subscribeLock?.((state) => {
      if (!state.locked) return;
      for (const opening of this.opening.values()) opening.cancelled = true;
      for (const id of [...this.instances.keys()]) void this.close(id, undefined, "app-locked");
    });
  }
  owned(id, sender) {
    const instance = this.instances.get(id);
    if (!instance) throw new Error("Plugin view was not found");
    if (sender && instance.sender !== sender) throw new Error("Plugin view belongs to another window");
    return instance;
  }
  async open(payload, sender) {
    if (!validateOpen(payload)) throw new TypeError("Invalid plugin view request");
    const owner = this.electron.BrowserWindow.fromWebContents(sender);
    if (this.closed || this.isLocked() || !owner || owner.isDestroyed() || owner.webContents !== sender) throw new Error("Plugin view owner unavailable");
    const id = payload.instanceId;
    if (this.instances.has(id) || this.opening.has(id)) throw new Error("Plugin view already exists");
    const ownedCount = [...this.instances.values()].filter((instance) => instance.sender === sender).length
      + [...this.opening.values()].filter((pending) => pending.sender === sender).length;
    if (ownedCount >= 32 || this.instances.size + this.opening.size >= 128) throw new Error("Plugin view limit exceeded");
    if (typeof payload.scopeId !== "string" || payload.scopeId.length < 1 || payload.scopeId.length > 256) throw new TypeError("Invalid plugin view scope");
    const opening = { cancelled: false, owner, sender };
    const cancel = () => { opening.cancelled = true; };
    const navigating = (details, _url, isInPlace, isMainFrame) => {
      if ((details?.isMainFrame ?? isMainFrame) !== false && (details?.isSameDocument ?? isInPlace) !== true) cancel();
    };
    owner.once("closed", cancel); sender.on("render-process-gone", cancel); sender.on("did-start-navigation", navigating);
    this.opening.set(id, opening);
    const ensure = () => {
      if (opening.cancelled || this.closed || this.isLocked() || owner.isDestroyed() || sender.isDestroyed?.()) throw new Error("Plugin view opening was cancelled");
    };
    try {
      const { plugin, view, identity } = await this.contributions.activateView(payload.viewId, { context: payload.context });
      ensure();
      if (!identity?.runtimeId) throw new Error("Plugin view is not host-drawn");
      const activation = { pluginId: plugin.id, pluginVersion: plugin.activeVersion, viewId: view.id, runtimeId: identity.runtimeId };
      this.contributions.assertViewActivationCurrent(activation, { context: payload.context });
      const instance = { id, sender, owner, pluginId: plugin.id, viewId: view.id, activation,
        context: structuredClone(payload.context ?? {}), identity, sequence: 0, rateStart: Date.now(), rateCount: 0, ownerClosed: () => { void this.close(id, undefined, "owner-closed"); },
        rendererGone: () => { void this.close(id, undefined, "renderer-gone"); }, navigating: null };
      instance.navigating = (details, _url, isInPlace, isMainFrame) => {
        if ((details?.isMainFrame ?? isMainFrame) !== false && (details?.isSameDocument ?? isInPlace) !== true) instance.rendererGone();
      };
      this.instances.set(id, instance);
      owner.once("closed", instance.ownerClosed); sender.on("render-process-gone", instance.rendererGone); sender.on("did-start-navigation", instance.navigating);
      instance.startPromise = this.contributions.runtimeSupervisor.notify(plugin.id, "plugin.view.message", { viewId: view.id, message: { kind: "host-ui.open", instanceId: id, stateScope: createHash("sha256").update(payload.scopeId).digest("hex") } }, { expectedIdentity: identity });
      await instance.startPromise;
      ensure();
      this.contributions.assertViewActivationCurrent(activation, { context: payload.context });
      if (this.instances.get(id) !== instance) throw new Error("Plugin view opening was cancelled");
      return { instanceId: id };
    } catch (error) {
      await this.close(id, undefined, "open-failed");
      throw error;
    } finally {
      this.opening.delete(id); owner.removeListener("closed", cancel); sender.removeListener("render-process-gone", cancel); sender.removeListener("did-start-navigation", navigating);
    }
  }
  receive(event) {
    if (!event) return;
    const message = event.message;
    if (!validateMessage(message) || message.kind !== "host-ui.update") return;
    const instance = this.instances.get(message.instanceId);
    if (!instance || instance.pluginId !== event.pluginId || instance.viewId !== event.viewId || this.isLocked()) return;
    try {
      this.contributions.assertViewActivationCurrent(instance.activation, { context: instance.context });
      if (message.sequence !== instance.sequence + 1) throw new Error("Invalid view update sequence");
      const now = Date.now();
      if (now - instance.rateStart >= 1000) { instance.rateStart = now; instance.rateCount = 0; }
      if (++instance.rateCount > 120) throw new Error("Plugin view update rate exceeded");
      validatePluginMutationBatch(message.mutations); validatePluginStylesheet(message.css);
      instance.sequence = message.sequence;
      if (!instance.sender.isDestroyed?.()) instance.sender.send("netcatty:plugins:host-ui-update", { viewId: instance.viewId, ...message });
    } catch { void this.close(instance.id, undefined, "invalid-update"); }
  }
  async resource(id, resource, sender) {
    const instance = this.owned(id, sender);
    if (this.isLocked() || !this.resources) throw new Error("Plugin images unavailable");
    const { plugin } = this.contributions.assertViewActivationCurrent(instance.activation, { context: instance.context });
    instance.resources ??= new Map();
    if (instance.resources.has(resource)) return instance.resources.get(resource);
    if (instance.resources.size >= 32) throw new Error("Plugin image limit exceeded");
    const pending = this.resources.image(plugin, resource).then((result) => {
      if (this.isLocked() || this.instances.get(id) !== instance) throw new Error("Plugin view closed");
      this.contributions.assertViewActivationCurrent(instance.activation, { context: instance.context });
      instance.resourceBytes = (instance.resourceBytes ?? 0) + result.url.length;
      if (instance.resourceBytes > 8 * 1024 * 1024) throw new Error("Plugin image budget exceeded");
      return result;
    });
    instance.resources.set(resource, pending);
    return pending;
  }
  async event(id, event, sender) {
    const instance = this.owned(id, sender);
    if (this.isLocked() || !validateEvent(event)) throw new TypeError("Invalid plugin view event");
    this.contributions.assertViewActivationCurrent(instance.activation, { context: instance.context });
    await this.contributions.runtimeSupervisor.notify(instance.pluginId, "plugin.view.message", { viewId: instance.viewId,
      message: { kind: "host-ui.event", instanceId: id, event } }, { expectedIdentity: instance.identity });
  }
  async close(id, sender, reason = sender ? "renderer-requested" : "host-requested") {
    const opening = this.opening.get(id);
    if (opening) { if (sender && opening.sender !== sender) throw new Error("Plugin view belongs to another window"); opening.cancelled = true; }
    const instance = this.instances.get(id); if (!instance) return;
    if (sender && instance.sender !== sender) throw new Error("Plugin view belongs to another window");
    this.instances.delete(id);
    instance.owner.removeListener("closed", instance.ownerClosed); instance.sender.removeListener("render-process-gone", instance.rendererGone);
    instance.sender.removeListener("did-start-navigation", instance.navigating);
    if (!instance.sender.isDestroyed?.()) instance.sender.send("netcatty:plugins:view-closed", { instanceId: id, pluginId: instance.pluginId, viewId: instance.viewId, reason });
    try {
      await instance.startPromise?.catch(() => {});
      await this.contributions.runtimeSupervisor.notify(instance.pluginId, "plugin.view.message", { viewId: instance.viewId,
      message: { kind: "host-ui.close", instanceId: id } }, { expectedIdentity: instance.identity });
    } catch { /* runtime may already have stopped */ }
  }
  async shutdown() {
    this.closed = true; for (const opening of this.opening.values()) opening.cancelled = true;
    await Promise.all([...this.instances.keys()].map((id) => this.close(id, undefined, "shutdown")));
    this.messageSubscription?.dispose(); this.changeSubscription?.dispose(); this.unsubscribeLock?.();
  }
}
module.exports = { HostDrawnViewHost };
