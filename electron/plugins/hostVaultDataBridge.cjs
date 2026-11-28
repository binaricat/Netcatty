"use strict";

const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);

const DEFAULT_CHANNELS = Object.freeze({
  request: "netcatty:plugins:vault-data-request",
  ready: "netcatty:plugins:vault-data-ready",
  response: "netcatty:plugins:vault-data-response",
});

const MAX_PENDING = 64;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_KINDS = new Set([
  "resolveMetadata",
  "prepareConnection",
  "prepareProbeTarget",
  "listGroups",
  "updateHostNotes",
  "updateHostTags",
  "portForward.list",
  "portForward.create",
  "portForward.start",
  "portForward.stop",
  "portForward.delete",
  "snippets.list",
  "snippets.get",
  "snippets.save",
  "snippets.delete",
  "terminals.listSessions",
  "terminals.readScreen",
  "terminals.sendInput",
  "terminals.openLocal",
  "workspace.listTabs",
  "workspace.focusTab",
]);

/**
 * Trusted main-window data link for non-interactive Vault reads needed by
 * host services (host metadata refresh for bound tokens and SSH connection
 * preparation). Never exposed to plugin runtimes; enforces main-window sender,
 * App Lock, one-use actionToken, and bounded concurrency.
 */
class PluginHostVaultDataBridge {
  constructor(options = {}) {
    this.channels = options.channels ?? DEFAULT_CHANNELS;
    this.getWindow = options.getWindow ?? (() => null);
    this.isLocked = options.isLocked ?? (() => true);
    this.timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000);
    this.pending = new Map();
    this.owner = null;
    this.ownerCleanup = null;
    this.closed = false;
    this.unsubscribeLock = options.subscribeLock?.((state) => {
      if (state?.locked) this.invalidate();
    }) ?? null;
  }

  #activeOwner() {
    const win = this.getWindow?.();
    if (
      this.closed
      || this.isLocked()
      || !this.owner
      || win?.webContents !== this.owner
      || win.isDestroyed?.()
      || this.owner.isDestroyed?.()
    ) {
      throw fail("unavailable", "Vault data host is unavailable");
    }
    return this.owner;
  }

  setReady(sender, ready) {
    if (typeof ready !== "boolean" || sender !== this.getWindow?.()?.webContents || sender.isDestroyed?.()) {
      throw fail("permissionDenied", "Vault data host sender is not the main window");
    }
    if (!ready) {
      if (this.owner === sender) this.invalidate(true);
      return true;
    }
    if (this.closed) throw fail("unavailable", "Vault data host is closed");
    if (this.owner === sender) return true;
    this.invalidate(true);
    this.owner = sender;
    const release = () => this.invalidate(true);
    const navigate = (details, _url, inPlace, mainFrame) => {
      if ((details?.isMainFrame ?? mainFrame) !== false && (details?.isSameDocument ?? inPlace) !== true) {
        release();
      }
    };
    sender.on?.("destroyed", release);
    sender.on?.("render-process-gone", release);
    sender.on?.("did-start-navigation", navigate);
    this.ownerCleanup = () => {
      sender.removeListener?.("destroyed", release);
      sender.removeListener?.("render-process-gone", release);
      sender.removeListener?.("did-start-navigation", navigate);
    };
    return true;
  }

  request(kind, payload, signal) {
    if (!ALLOWED_KINDS.has(kind)) {
      return Promise.reject(fail("invalidArgument", "Unsupported Vault data request"));
    }
    let sender;
    try {
      sender = this.#activeOwner();
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) {
      return Promise.reject(fail("cancelled", "Vault data request was cancelled"));
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(fail("resourceExhausted", "Too many pending Vault data requests"));
    }
    const requestId = randomUUID();
    const actionToken = randomBytes(24).toString("base64url");
    return new Promise((resolve, reject) => {
      const entry = {
        requestId,
        actionToken,
        sender,
        resolve,
        reject,
        timer: null,
        onAbort: null,
      };
      const finish = (err, value) => {
        if (!this.pending.delete(requestId)) return;
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onAbort) signal?.removeEventListener("abort", entry.onAbort);
        if (err) reject(err);
        else resolve(value);
      };
      entry.finish = finish;
      entry.onAbort = () => finish(fail("cancelled", "Vault data request was cancelled"));
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      entry.timer = setTimeout(() => {
        finish(fail("deadlineExceeded", "Vault data request timed out"));
      }, this.timeoutMs);
      entry.timer.unref?.();
      this.pending.set(requestId, entry);
      try {
        sender.send(this.channels.request, { requestId, actionToken, kind, payload });
      } catch {
        finish(fail("unavailable", "Vault data host is unavailable"));
      }
    });
  }

  respond(sender, response) {
    if (
      !response
      || typeof response !== "object"
      || typeof response.requestId !== "string"
      || typeof response.actionToken !== "string"
    ) {
      throw fail("invalidArgument", "Vault data response is invalid");
    }
    const entry = this.pending.get(response.requestId);
    if (!entry || entry.sender !== sender) return false;
    const expected = Buffer.from(entry.actionToken);
    const supplied = Buffer.from(response.actionToken);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return false;
    }
    if (response.ok === true) {
      entry.finish(null, response.data);
    } else {
      const message = typeof response.error === "string" && response.error.length > 0
        ? response.error.slice(0, 256)
        : "Vault data request failed";
      entry.finish(fail("unavailable", message));
    }
    return true;
  }

  resolveMetadata(hostIds, signal) {
    return this.request("resolveMetadata", { hostIds }, signal);
  }

  prepareConnection(hostId, signal) {
    return this.request("prepareConnection", { hostId }, signal);
  }

  invalidate(clearOwner = false) {
    for (const entry of [...this.pending.values()]) {
      entry.finish(fail("unavailable", "Vault data host was reset"));
    }
    this.pending.clear();
    if (clearOwner) {
      this.ownerCleanup?.();
      this.ownerCleanup = null;
      this.owner = null;
    }
  }

  shutdown() {
    this.closed = true;
    try { this.unsubscribeLock?.(); } catch { /* ignore */ }
    this.unsubscribeLock = null;
    this.invalidate(true);
  }
}

module.exports = { PluginHostVaultDataBridge, DEFAULT_CHANNELS, MAX_PENDING };
