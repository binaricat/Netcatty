"use strict";

const { randomBytes, timingSafeEqual } = require("node:crypto");
const { permissionDenied } = require("./permissionEngine.cjs");
const { describePluginPermission } = require("../../domain/pluginPermissionDescriptions.cjs");
const { escapePermissionText } = require("./nativePermissionDecision.cjs");
const CHANNEL = "netcatty:plugins:permission-prompt";

/** Ask belongs to a ready, focused managed app renderer. Plugin views never
 * own this link. Each token and cancellation lifecycle stays with its window. */
class PluginPermissionDecisionHost {
  constructor(options) {
    this.getWindows = options.getWindows ?? (() => [options.getWindow?.()].filter(Boolean));
    this.isLocked = options.isLocked ?? (() => true);
    this.pending = new Map();
    this.owners = new Map();
    this.closed = false;
    this.unsubscribeLock = options.subscribeLock?.((state) => { if (state.locked) this.cancelAll(); });
  }

  setReady(sender, ready) {
    if (this.closed) throw permissionDenied("Permission UI is closed");
    const window = this.getWindows().find((candidate) => candidate?.webContents === sender);
    if (!window || window.isDestroyed?.() || sender.isDestroyed?.() || typeof ready !== "boolean") {
      throw permissionDenied("Permission UI sender is invalid");
    }
    this.releaseOwner(sender);
    if (ready) {
      const cancel = () => this.cancelOwner(sender);
      const release = () => this.releaseOwner(sender);
      const navigate = (details, _url, inPlace, mainFrame) => {
        if ((details?.isMainFrame ?? mainFrame) !== false && (details?.isSameDocument ?? inPlace) !== true) release();
      };
      sender.on?.("destroyed", release); sender.on?.("render-process-gone", release); sender.on?.("did-start-navigation", navigate);
      window.on?.("hide", cancel); window.on?.("blur", cancel); window.on?.("closed", release);
      this.owners.set(sender, { window, cleanup: () => {
        sender.removeListener?.("destroyed", release); sender.removeListener?.("render-process-gone", release); sender.removeListener?.("did-start-navigation", navigate);
        window.removeListener?.("hide", cancel); window.removeListener?.("blur", cancel); window.removeListener?.("closed", release);
      } });
    }
    return true;
  }

  get owner() {
    return this.getWindows().find((window) => this.owners.has(window?.webContents)
      && !window.isDestroyed?.() && window.isFocused?.() && window.isVisible?.())?.webContents ?? null;
  }

  assertOwner(sender = this.owner) {
    const window = this.owners.get(sender)?.window;
    if (this.closed || !sender || !window || !this.getWindows().includes(window) || window.webContents !== sender || sender.isDestroyed?.()
      || window.isDestroyed?.() || !window.isFocused?.() || !window.isVisible?.() || this.isLocked()) {
      throw permissionDenied("Permission UI requires a focused unlocked app window");
    }
  }

  request(request, { signal } = {}) {
    signal?.throwIfAborted(); this.assertOwner();
    if (!describePluginPermission(request.permission).known || this.pending.size >= 16) {
      throw permissionDenied("Permission prompt is unavailable");
    }
    const sender = this.owner;
    return new Promise((resolve, reject) => {
      const actionToken = randomBytes(32).toString("base64url");
      const finish = (decision, error) => {
        if (!this.pending.delete(request.requestId)) return;
        signal?.removeEventListener("abort", abort);
        try { sender.send(CHANNEL, { requestId: request.requestId, closed: true }); } catch {}
        if (error) reject(error); else resolve({ requestId: request.requestId, decision, ...(decision === "allow" ? { scope: request.allowedScopes && !request.allowedScopes.includes("once") && request.sessionId && request.allowedScopes.includes("session") ? "session" : "once" } : {}) });
      };
      const abort = () => finish(null, permissionDenied("Permission prompt was cancelled"));
      this.pending.set(request.requestId, { sender, actionToken, finish });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        sender.send(CHANNEL, { ...request, actionToken,
          ...(request.pluginName ? { pluginName: escapePermissionText(request.pluginName) } : {}),
          resources: (request.resources ?? []).map((resource) => escapePermissionText(resource)),
          ...(request.displayContext ? { displayContext: {
            ...(request.displayContext.modelLabel ? { modelLabel: escapePermissionText(request.displayContext.modelLabel) } : {}),
            ...(request.displayContext.action ? { action: {
              capabilityId: escapePermissionText(request.displayContext.action.capabilityId, 160),
              text: escapePermissionText(request.displayContext.action.text, 16_384),
            } } : {}),
            selections: (request.displayContext.selections ?? []).map((item) => ({
              scope: item.scope, title: escapePermissionText(item.title), version: escapePermissionText(item.version),
            })),
          } } : {}),
          ...(request.relatedPermissions ? { relatedPermissions: request.relatedPermissions.map((item) => ({
            permission: item.permission, resources: item.resources.map((resource) => escapePermissionText(resource)),
          })) } : {}),
        });
      } catch { abort(); }
    });
  }

  respond(sender, response) {
    this.assertOwner(sender);
    if (!response || Object.keys(response).some((key) => !["requestId", "actionToken", "decision"].includes(key))
      || !["allow", "deny", "cancel"].includes(response.decision) || typeof response.actionToken !== "string") {
      throw permissionDenied("Permission response is invalid");
    }
    const entry = this.pending.get(response.requestId);
    if (!entry || entry.sender !== sender) return false;
    const expected = Buffer.from(entry.actionToken); const actual = Buffer.from(response.actionToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    entry.actionToken = "";
    entry.finish(response.decision);
    return true;
  }

  cancelOwner(sender) { for (const entry of [...this.pending.values()]) if (entry.sender === sender) entry.finish("cancel"); }
  releaseOwner(sender) { this.cancelOwner(sender); this.owners.get(sender)?.cleanup(); this.owners.delete(sender); }
  cancelAll() { for (const entry of [...this.pending.values()]) entry.finish("cancel"); }
  shutdown() { if (this.closed) return; this.closed = true; for (const sender of [...this.owners.keys()]) this.releaseOwner(sender); this.unsubscribeLock?.(); }
}
module.exports = { PluginPermissionDecisionHost, PLUGIN_PERMISSION_PROMPT_CHANNEL: CHANNEL };
