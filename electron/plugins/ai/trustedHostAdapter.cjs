"use strict";

const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { createDefinitionValidator } = require("../contractValidator.cjs");
const { assertPluginJsonValue } = require("../jsonBoundary.cjs");
const { PluginRpcError, RPC_ERRORS } = require("../rpcRouter.cjs");
const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);
const CHANNELS = Object.freeze({ request: "netcatty:plugins:ai-host-request", ready: "netcatty:plugins:ai-host-ready", response: "netcatty:plugins:ai-host-response" });

// Trusted main-window link, never a plugin IPC surface. Canonical envelopes are
// supplied by the shared contract task; no provider config or key crosses it.
class PluginAITrustedHostAdapter {
  constructor(options) {
    // Separate trusted Agent transport instances reuse the same sender/nonce
    // guards. These construction options never come from a plugin request.
    this.channels = options.channels ?? CHANNELS;
    this.requestDefinition = options.requestDefinition ?? "PluginAIHostRequest";
    this.responseDefinition = options.responseDefinition ?? "PluginAIHostResponse";
    this.maxEnvelopeBytes = Math.min(options.maxEnvelopeBytes ?? 24_576, 1_048_576);
    this.getWindow = options.getWindow;
    this.isLocked = options.isLocked ?? (() => true);
    this.dialog = options.dialog;
    this.cancelProviderStreams = options.cancelProviderStreams ?? ((sender, runtimeId) => require("../../bridges/aiBridge.cjs").cancelPluginAIStreamsForSender(sender, runtimeId));
    this.pending = new Map(); this.listeners = new Set(); this.reviewControllers = new Map();
    this.owner = null; this.ownerCleanup = null; this.generation = 0; this.closed = false;
    this.timeoutMs = Math.min(options.timeoutMs ?? 60_000, 60_000);
    this.validateRequest = options.validateRequest ?? null;
    this.validateResponse = options.validateResponse ?? null;
    this.unsubscribeLock = options.subscribeLock?.((state) => { if (state.locked) this.invalidate(); });
  }

  registerIpc(ipcMain) {
    if (this.ipcRegistration) throw new Error("Trusted AI host IPC is already registered");
    this.validateRequest ??= createDefinitionValidator(this.requestDefinition);
    this.validateResponse ??= createDefinitionValidator(this.responseDefinition);
    ipcMain.handle(this.channels.ready, (event, ready) => this.setReady(event.sender, ready));
    ipcMain.handle(this.channels.response, (event, response) => this.respond(event.sender, response));
    this.ipcRegistration = { dispose: () => { ipcMain.removeHandler(this.channels.ready); ipcMain.removeHandler(this.channels.response); } };
    return this.ipcRegistration;
  }

  #owner() {
    const window = this.getWindow?.();
    if (this.closed || this.isLocked() || !this.owner || window?.webContents !== this.owner || window.isDestroyed?.()
      || this.owner.isDestroyed?.() || window.isVisible?.() !== true) throw fail("unavailable", "Trusted AI host is unavailable");
    return this.owner;
  }

  async assertActive(context) {
    await context.assertActive(); context.signal?.throwIfAborted(); this.#owner();
  }

  setReady(sender, ready) {
    if (typeof ready !== "boolean" || sender !== this.getWindow?.()?.webContents || sender.isDestroyed?.()) {
      throw fail("permissionDenied", "AI host sender is not the main window");
    }
    if (!ready) { if (this.owner === sender) this.invalidate(true); return true; }
    if (this.closed) throw fail("unavailable", "AI host is closed");
    if (this.owner === sender) return true;
    this.invalidate(true); this.owner = sender;
    const window = this.getWindow();
    const release = () => this.invalidate(true);
    const hide = () => this.invalidate();
    const navigate = (details, _url, inPlace, mainFrame) => {
      if ((details?.isMainFrame ?? mainFrame) !== false && (details?.isSameDocument ?? inPlace) !== true) release();
    };
    sender.on?.("destroyed", release); sender.on?.("render-process-gone", release); sender.on?.("did-start-navigation", navigate); window.on?.("hide", hide);
    this.ownerCleanup = () => {
      sender.removeListener?.("destroyed", release); sender.removeListener?.("render-process-gone", release);
      sender.removeListener?.("did-start-navigation", navigate); window.removeListener?.("hide", hide);
    };
    return true;
  }

  #envelope(kind, payload, runtimeId) {
    const request = { requestId: randomUUID(), actionToken: randomBytes(24).toString("base64url"), kind, payload, runtimeId };
    assertPluginJsonValue(request, { maxBytes: this.maxEnvelopeBytes });
    if (!this.validateRequest?.(request)) throw fail("internal", "Trusted AI host request is invalid");
    return request;
  }

  #send(kind, payload, runtimeId) {
    const request = this.#envelope(kind, payload, runtimeId);
    return { request, sender: this.#owner(), generation: this.generation };
  }

  #cleanup(kind, payload, runtimeId, sender = this.owner) {
    if (!sender || sender !== this.getWindow?.()?.webContents || sender.isDestroyed?.()) return;
    try { sender.send(this.channels.request, this.#envelope(kind, payload, runtimeId)); } catch {}
  }

  async #request(kind, payload, context) {
    await this.assertActive(context);
    if (this.pending.size >= 64) throw fail("resourceExhausted", "Trusted AI host request limit reached");
    const { request, sender, generation } = this.#send(kind, payload, context.runtimeId);
    return new Promise((resolve, reject) => {
      const entry = { request, sender, generation, context, resolve, reject };
      entry.finish = (result, error) => {
        if (!this.pending.delete(request.requestId)) return;
        clearTimeout(entry.timer); context.signal?.removeEventListener("abort", entry.abort);
        if (error) {
          this.#cleanup("request.cancel", { requestId: request.requestId }, context.runtimeId, sender);
          reject(error);
        } else resolve(result);
      };
      entry.abort = () => entry.finish(null, fail("cancelled", "Trusted AI host request cancelled"));
      entry.timer = setTimeout(() => entry.finish(null, fail("deadlineExceeded", "Trusted AI host request timed out")), this.timeoutMs);
      this.pending.set(request.requestId, entry);
      context.signal?.addEventListener("abort", entry.abort, { once: true });
      if (context.signal?.aborted) { entry.abort(); return; }
      try { sender.send(this.channels.request, request); }
      catch { entry.finish(null, fail("unavailable", "Trusted AI host disconnected")); }
    });
  }

  async respond(sender, response) {
    if (sender !== this.#owner()) throw fail("permissionDenied", "AI host response sender is invalid");
    assertPluginJsonValue(response, { maxBytes: this.maxEnvelopeBytes });
    if (!this.validateResponse?.(response)) throw fail("invalidArgument", "AI host response is invalid");
    const entry = this.pending.get(response.requestId);
    if (!entry || entry.sender !== sender || entry.generation !== this.generation) return false;
    const expected = Buffer.from(entry.request.actionToken); const actual = Buffer.from(response.actionToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    // Consume the nonce before awaiting authentication to prevent replay races.
    entry.request.actionToken = "";
    try {
      await this.assertActive(entry.context);
      if (entry.generation !== this.generation || this.pending.get(response.requestId) !== entry) return false;
      if (response.error === true) entry.finish(null, fail("unavailable", "Trusted AI host operation failed"));
      else entry.finish(response.result);
      return true;
    } catch { entry.finish(null, fail("cancelled", "Trusted AI host response became stale")); return false; }
  }

  // Host-only, canonical typed request path for a separate Agent instance.
  requestAgent(kind, payload, context) {
    if (this.requestDefinition !== "PluginAgentHostRequest" || !kind.startsWith("agent.")) throw fail("unsupported", "Agent host route unavailable");
    return this.#request(kind, payload, context);
  }

  getSenderId() { return this.#owner().id; }
  releaseAgentChat(chatSessionId, runtimeId) {
    if (this.requestDefinition !== "PluginAgentHostRequest" || !/^plugin-agent:[0-9a-f-]{36}$/u.test(chatSessionId)) throw fail("invalidArgument", "Agent conversation unavailable");
    this.#cleanup("agent.close", { chatSessionId }, runtimeId);
  }

  async selectModel(context) {
    const selected = await this.#request("model.select", {}, context);
    if (typeof selected?.hostHandle !== "string" || typeof selected.label !== "string" || selected.label.length > 160) throw fail("internal", "Selected model is invalid");
    const generation = this.generation;
    return {
      label: selected.label,
      dispose: async () => { try { await this.#request("model.release", { hostHandle: selected.hostHandle }, { ...context, signal: undefined }); } catch {} },
      isCurrent: async () => generation === this.generation && (await this.#request("model.current", { hostHandle: selected.hostHandle }, context)).current === true,
      invoke: async (input) => {
        const activeContext = { ...context, signal: input.signal };
        const turn = await this.#request("model.start", { hostHandle: selected.hostHandle, prompt: input.prompt,
          contexts: input.contexts, maxOutputTokens: input.maxOutputTokens, maxChunkBytes: input.maxChunkBytes }, activeContext);
        if (typeof turn?.hostHandle !== "string") throw fail("internal", "Model turn is invalid");
        return {
          next: async () => {
            const result = await this.#request("model.next", { hostHandle: turn.hostHandle }, activeContext);
            if (result.done === true) return { done: true };
            if (result.done !== false || !result.event) throw fail("internal", "Model stream event is invalid");
            return { done: false, value: result.event };
          },
          return: async () => {
            // Cleanup must remain possible after the turn signal is aborted.
            try { await this.#request("model.stop", { hostHandle: turn.hostHandle }, { ...context, signal: undefined }); } catch {}
            return { done: true };
          },
        };
      },
    };
  }

  async listSelected(context) {
    const result = await this.#request("context.select", {}, context);
    if (!Array.isArray(result?.items) || result.items.length > 5) throw fail("internal", "Selected context list is invalid");
    const generation = this.generation;
    return result.items.map((item) => ({ key: item.hostHandle, scope: item.scope, title: item.title, version: item.version,
      isCurrent: async () => generation === this.generation && (await this.#request("context.current", { hostHandle: item.hostHandle, version: item.version }, context)).current === true,
      readText: async ({ signal } = {}) => {
        const read = await this.#request("context.read", { hostHandle: item.hostHandle, version: item.version }, { ...context, signal: signal ?? context.signal });
        return read.text;
      },
    }));
  }

  async reviewText(selected, context) {
    await this.assertActive(context);
    const window = this.getWindow(); const generation = this.generation;
    if (typeof this.dialog?.showMessageBox !== "function") return false;
    // A native permission dialog can resolve just before its parent regains
    // focus. Wait briefly for this exact owner, without focusing it ourselves.
    const focusDeadline = Date.now() + 1_000;
    while (window.isFocused?.() !== true) {
      await this.assertActive(context);
      if (generation !== this.generation || Date.now() >= focusDeadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    this.reviewControllers.set(controller, context.runtimeId);
    try {
      const result = await this.dialog.showMessageBox(window, {
        type: "question", title: "Share selected context", message: `Share "${selected.title}" with ${selected.pluginId}?`,
        detail: `Scope: ${selected.scope}\nVersion: ${selected.version}\n\n${selected.text}`,
        buttons: ["Share this text", "Cancel"], defaultId: 1, cancelId: 1, noLink: true, signal,
      });
      await this.assertActive(context);
      return !signal.aborted && generation === this.generation && result.response === 0;
    } finally { this.reviewControllers.delete(controller); }
  }

  onDidInvalidate(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  releaseRuntime(runtimeId) {
    try { if (this.owner) this.cancelProviderStreams(this.owner, runtimeId); } catch {}
    for (const entry of [...this.pending.values()]) if (entry.context.runtimeId === runtimeId) entry.abort();
    for (const [controller, owner] of this.reviewControllers) if (owner === runtimeId) controller.abort();
    this.#cleanup("runtime.release", {}, runtimeId);
  }
  invalidate(releaseOwner = false) {
    this.generation++;
    try { if (this.owner) this.cancelProviderStreams(this.owner); } catch {}
    for (const entry of [...this.pending.values()]) entry.finish(null, fail("cancelled", "Trusted AI host lifecycle changed"));
    for (const controller of this.reviewControllers.keys()) controller.abort();
    for (const listener of [...this.listeners]) { try { listener(); } catch {} }
    if (releaseOwner) { this.ownerCleanup?.(); this.ownerCleanup = null; this.owner = null; }
  }
  shutdown() { this.ipcRegistration?.dispose(); this.ipcRegistration = null; this.closed = true; this.invalidate(true); this.unsubscribeLock?.(); this.listeners.clear(); }
}

module.exports = { PluginAITrustedHostAdapter, PLUGIN_AI_HOST_CHANNELS: CHANNELS };
