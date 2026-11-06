"use strict";

const { randomUUID } = require("node:crypto");
const { PluginRpcError, RPC_ERRORS } = require("../rpcRouter.cjs");
const { createDefinitionValidator } = require("../contractValidator.cjs");
const { normalizePermissionDeclarations } = require("../permissionResources.cjs");
const { PluginAISourceBinding } = require("../ai/sourceBinding.cjs");
const { DelegatedAgentScopes, isRequestCancellation } = require("./delegatedScope.cjs");
const { listMcpTools } = require("../../capabilities/codegen/toolSurfaces.cjs");
const fail = (code) => new PluginRpcError(RPC_ERRORS[code], "Plugin Agent operation unavailable");
const FEATURE = require("../generated/plugin-contract.schema.json").$defs.PluginAgentFeature.const;
const CAPABILITIES = Object.freeze(require("../generated/plugin-contract.schema.json").$defs.PluginAgentCapabilities.const);
const TOOLS = listMcpTools().filter((tool) => CAPABILITIES.includes(tool.capabilityId));
const ROUTES = [
  ["listBackends", "PluginAIEmptyParams", "PluginAgentBackendsResult"],
  ["selectTargets", "PluginAIEmptyParams", "PluginAgentTargetsResult"],
  ["listChats", "PluginAIEmptyParams", "PluginAgentChatsResult"],
  ["openChat", "PluginAgentOpenParams", "PluginAgentChatResult"],
  ["send", "PluginAgentSendParams", "PluginAgentTurnResult"],
  ["read", "PluginAgentTurnRef", "PluginAgentEvent"],
  ["history", "PluginAgentChatRef", "PluginAgentHistoryResult"],
  ["stop", "PluginAgentTurnRef", "PluginAIBooleanResult"],
  ["closeChat", "PluginAgentChatRef", "PluginAIBooleanResult"],
];

class PluginAgentService {
  constructor(options) {
    this.source = new PluginAISourceBinding(options);
    this.database = options.database;
    this.host = options.hostAdapter;
    this.permission = options.permissionEngine;
    this.store = options.conversationStore;
    this.getSessionBinding = options.getSessionBinding;
    this.getMcpBridge = options.getMcpBridge;
    this.getTargetManager = options.getTargetManager ?? (() => null);
    this.clock = options.clock ?? Date.now;
    this.backends = new Map(); this.selections = new Map(); this.chats = new Map(); this.turns = new Map();
    this.budgets = new Map(); this.pendingOpens = new Set(); this.registrations = []; this.closed = false;
    this.pendingSelections = new Map(); this.startupTurns = new Map(); this.targetManager = null; this.targetSubscriptions = [];
    this.eventValidator = createDefinitionValidator("PluginAgentEvent");
    this.sessionValidator = createDefinitionValidator("PluginAgentHostSession");
    this.scopes = new DelegatedAgentScopes({ resolveOwner: (ctx) => this.#guard(ctx),
      assertHostActive: (ctx) => this.host.assertActive(ctx), clock: this.clock,
      authorizeAction: async (ctx, owner, action, signal) => {
        const decisionContext = { ...ctx, signal, permissionOperation: Object.freeze({}), sourceOwner: owner.privateOwner };
        await this.permission.authorize(decisionContext, {
          permission: "ai.agent.actions", resources: action.targets.length
            ? action.targets.map((target) => `agent-target:${target.kind}:${target.id}:${target.owner}:${target.revision}`) : ["*"],
          reason: "Use a delegated Agent tool on selected resources", sessionId: ctx.agentChatId,
          displayContext: { modelLabel: ctx.agentBackendLabel, selections: action.targets.map((target) => ({
            title: ctx.agentTargetLabels.get(target.id) ?? target.id, scope: "session", version: target.revision,
          })), action: { capabilityId: action.capabilityId, text: ctx.agentToolPreview } },
        });
      } });
    this.revocation = this.permission.onDidRevoke((event) => this.releasePlugin(event.pluginId));
    this.hostInvalidation = this.host.onDidInvalidate(() => this.releaseAll());
  }

  async #guard(context) {
    try {
      if (this.closed) throw fail("unavailable");
      const owner = await this.source.resolve(context);
      await this.host.assertActive(context); this.source.assertCurrent(owner);
      return owner;
    } catch (error) {
      const owner = this.source.bindings.get(context.runtimeId);
      if (!isRequestCancellation(error, context) && owner?.pluginId === context.pluginId
        && owner.pluginVersion === context.pluginVersion) this.releaseRuntime(context.runtimeId);
      throw error;
    }
  }

  #assertNow(turn) {
    if (this.closed || turn.done || this.turns.get(turn.handle) !== turn || turn.chat.activeTurn !== turn
      || turn.controller.signal.aborted || turn.chat.expiresAt <= this.clock()
      || turn.ticket?.controller.signal.aborted
      || this.host.generation !== turn.chat.hostGeneration) throw fail("cancelled");
    this.source.assertCurrent(turn.owner);
    if (this.host.getSenderId() !== turn.senderId) throw fail("cancelled");
    if (this.permission.getPolicyRevision(this.database.getActivePlugin(turn.owner.pluginId)) !== turn.policyRevision) throw fail("cancelled");
    for (const target of turn.chat.selection.targets) if (!target.isCurrent(target)) throw fail("cancelled");
  }

  async #chat(params, context) {
    const owner = await this.#guard(context); const chat = this.chats.get(params.chatHandle);
    if (!chat || chat.owner !== owner || chat.expiresAt <= this.clock() || chat.hostGeneration !== this.host.generation) throw fail("permissionDenied");
    return chat;
  }
  async #turn(params, context) {
    const owner = await this.#guard(context); const turn = this.turns.get(params.turnHandle);
    if (!turn || turn.owner !== owner || turn.expiresAt <= this.clock()) throw fail("permissionDenied");
    return turn;
  }
  async #backendCurrent(backend, context) {
    if (backend.expiresAt <= this.clock() || backend.hostGeneration !== this.host.generation
      || !(await this.host.requestAgent("agent.current", { hostHandle: backend.hostHandle }, context)).current) throw fail("failedPrecondition");
  }
  #prune() {
    for (const map of [this.backends, this.selections]) for (const [key, entry] of map) if (entry.expiresAt <= this.clock()) map.delete(key);
    for (const [key, turn] of this.turns) if (turn.expiresAt <= this.clock()) { this.#end(turn); this.turns.delete(key); }
    for (const [key, chat] of this.chats) if (chat.expiresAt <= this.clock()) {
      this.#forgetChat(chat); this.chats.delete(key);
    }
  }
  #observeTargets() {
    const manager = this.getTargetManager();
    if (manager === this.targetManager) return;
    for (const entry of this.targetSubscriptions) entry.dispose(); this.targetSubscriptions = [];
    this.targetManager = manager;
    const invalidate = () => {
      for (const controller of this.pendingSelections.keys()) controller.abort();
      for (const [key, chat] of this.chats) if (chat.selection.targets.some((target) => !target.isCurrent(target))) {
        this.#forgetChat(chat); this.chats.delete(key);
      }
    };
    invalidate();
    for (const method of ["onSessionOwned", "onSessionClosed", "onWorkerExit"]) {
      if (typeof manager?.[method] === "function") this.targetSubscriptions.push(manager[method](invalidate));
    }
  }
  #charge(owner) {
    const key = JSON.stringify([owner.sourceKey, owner.privateOwner]); const now = this.clock();
    for (const [id, entry] of this.budgets) if (now - entry.start >= 60_000) this.budgets.delete(id);
    const budget = this.budgets.get(key) ?? { start: now, requests: 0 };
    if (budget.requests >= 6 || (!this.budgets.has(key) && this.budgets.size >= 256)) throw fail("resourceExhausted");
    budget.requests++; this.budgets.set(key, budget);
  }

  registerRpcCapabilities(registry) {
    const startupLifetime = async (_context, next) => next();
    startupLifetime.prepareAuthorization = (context) => {
      if (context.method !== "agent.send") return undefined;
      // Registry cleanup runs after its final authority check. Until then the
      // caller still owns startup cancellation because no handle was delivered.
      return () => {
        const turn = this.startupTurns.get(context.permissionOperation);
        if (!turn) return;
        try {
          if (!turn.handoffReady || context.signal.aborted) throw fail("cancelled");
          this.#assertNow(turn);
        } catch { this.#end(turn); }
        turn.detachStartup();
      };
    };
    this.registrations.push(registry.use(startupLifetime));
    for (const [operation, paramsType, resultType] of ROUTES) {
      const input = createDefinitionValidator(paramsType); const output = createDefinitionValidator(resultType);
      this.registrations.push(registry.registerRequest(`agent.${operation}`, async (params, context) => {
        const result = await this[operation](params, context); await this.#guard(context);
        if (!output(result)) throw fail("internal");
        if (operation === "send") {
          const turn = this.startupTurns.get(context.permissionOperation);
          if (!turn || turn.handle !== result.turnHandle) throw fail("cancelled");
          turn.handoffReady = true;
        }
        return result;
      }, { metadata: { capability: "plugin-agent", mutating: !["listBackends", "listChats", "history", "read"].includes(operation), permission: "ai.agent.use" },
        validateParams: (params) => { if (!input(params)) throw fail("invalidArgument"); return Object.freeze(structuredClone(params)); },
        authorization: async (params, context) => {
          await this.#guard(context);
          const chat = operation === "send" ? await this.#chat(params, context) : null;
          return { permission: "ai.agent.use", resources: ["*"], reason: "Use this plugin's configured global Agent conversation",
            ...(operation !== "send" ? { deferDecision: true } : {}),
            ...(chat ? { displayContext: { modelLabel: chat.backend.label,
              selections: chat.selection.items.map((item) => ({ title: item.title, scope: "session", version: "selected" })),
              action: { capabilityId: "agent.send", text: params.text } } } : {}),
          };
        },
      }));
    }
  }

  async listBackends(_params, context) {
    const owner = await this.#guard(context); this.#prune();
    const result = await this.host.requestAgent("agent.backends", {}, context); await this.#guard(context);
    const items = [];
    for (const entry of result.backends) {
      let lease = [...this.backends.values()].find((item) => item.owner === owner && item.hostHandle === entry.hostHandle);
      if (!lease) {
        if (this.backends.size >= 256) throw fail("resourceExhausted");
        lease = { ...entry, backendRef: randomUUID(), owner, hostGeneration: this.host.generation, expiresAt: this.clock() + 300_000 };
        this.backends.set(lease.backendRef, lease);
      }
      const eligible = ["catty", "claude"].includes(entry.backend);
      items.push({ backendRef: lease.backendRef, backend: entry.backend, label: entry.label,
        status: eligible ? entry.status : entry.status === "unavailable" ? "unavailable" : "unsupported",
        reason: eligible || entry.status === "unavailable" ? entry.reason : "native-boundary-unverified" });
    }
    return { items };
  }

  async selectTargets(_params, context) {
    const owner = await this.#guard(context); this.#prune();
    this.#observeTargets();
    if (this.selections.size >= 64) throw fail("resourceExhausted");
    const controller = new AbortController(); this.pendingSelections.set(controller, owner);
    let result;
    try {
      result = await this.host.requestAgent("agent.targets", {}, { ...context,
        signal: context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal });
      await this.#guard(context); controller.signal.throwIfAborted();
    } finally { this.pendingSelections.delete(controller); }
    const targets = result.targets.map((item) => {
      const binding = this.getSessionBinding(item.sessionId);
      if (!binding || !binding.isCurrent(binding)) throw fail("failedPrecondition");
      return Object.freeze({ ...binding, kind: "terminal", id: item.sessionId });
    });
    if (new Set(targets.map((target) => target.id)).size !== targets.length) throw fail("invalidArgument");
    const selectionHandle = randomUUID(); const expiresAt = this.clock() + 300_000;
    const items = result.targets.map((item) => ({ kind: "terminal", title: item.label }));
    this.selections.set(selectionHandle, { owner, targets, terminalSessions: structuredClone(result.targets), items, expiresAt });
    return { selectionHandle, expiresAt, items };
  }

  async listChats(_params, context) {
    const owner = await this.#guard(context);
    const rows = await this.store.list(owner, () => this.#guard(context));
    return { items: rows.map((row) => ({ conversationRef: row.conversationRef, title: row.title, backend: row.agentId, updatedAt: row.updatedAt })) };
  }

  async openChat(params, context) {
    const owner = await this.#guard(context); this.#prune();
    const backend = this.backends.get(params.backendRef); const selection = this.selections.get(params.selectionHandle);
    if (!backend || backend.owner !== owner || !["catty", "claude"].includes(backend.backend) || backend.status !== "supported"
      || !selection || selection.owner !== owner || selection.expiresAt <= this.clock()) throw fail("permissionDenied");
    if (this.chats.size + this.pendingOpens.size >= 64 || [...this.chats.values()].filter((chat) => chat.owner === owner).length >= 8) throw fail("resourceExhausted");
    if (params.conversationRef && [...this.pendingOpens].some((item) => item.owner === owner && item.conversationRef === params.conversationRef)) throw fail("alreadyExists");
    const opening = { owner, conversationRef: params.conversationRef, active: true }; this.pendingOpens.add(opening); let scope;
    try {
      await this.#backendCurrent(backend, context);
      let record = params.conversationRef ? await this.store.read(owner, params.conversationRef, () => this.#guard(context)) : null;
      if (params.conversationRef && !record) throw fail("notFound");
      if (record && [...this.chats.values()].some((chat) => chat.owner === owner && chat.record.conversationRef === record.conversationRef)) throw fail("alreadyExists");
      const now = this.clock();
      record ??= { conversationRef: randomUUID(), id: `plugin-agent:${randomUUID()}`, title: "Global Agent chat", agentId: backend.backend,
        scope: { type: "global" }, messages: [], createdAt: now, updatedAt: now };
      // Durable conversation identity is conversationRef. A fresh runtime actor
      // never reuses revoked privacy/native/tool state when history is reopened.
      record.id = `plugin-agent:${randomUUID()}`;
      record.agentId = backend.backend; delete record.externalSessionId;
      const declared = normalizePermissionDeclarations(context.manifest).has("ai.agent.actions");
      const capabilities = declared && this.permission.getMode(context, "ai.agent.actions") !== "deny" ? CAPABILITIES : [];
      scope = await this.scopes.issue(context, { backend: { key: backend.backendRef, revision: backend.hostHandle,
        isCurrent: () => backend.expiresAt > this.clock() && backend.hostGeneration === this.host.generation }, targets: selection.targets, capabilities });
      if (!opening.active || await this.#guard(context) !== owner) throw fail("cancelled");
      await this.store.save(owner, record, async () => { if (!opening.active) throw fail("cancelled"); await this.#guard(context); });
      if (!opening.active || await this.#guard(context) !== owner) throw fail("cancelled");
      const chatHandle = randomUUID();
      this.chats.set(chatHandle, { handle: chatHandle, owner, backend, selection, record, scope, capabilities,
        expiresAt: Math.min(scope.expiresAt, selection.expiresAt, backend.expiresAt), hostGeneration: this.host.generation, activeTurn: null, generation: 0 });
      return { chatHandle, conversationRef: record.conversationRef, backendLabel: backend.label,
        expiresAt: this.chats.get(chatHandle).expiresAt };
    } catch (error) { if (scope) this.scopes.discard(scope.handle, owner); throw error; }
    finally { this.pendingOpens.delete(opening); }
  }

  async #dispatchTool(turn, method, params, execute) {
    this.#assertNow(turn);
    if (++turn.toolCalls > 32) { this.#end(turn, "budget-exceeded"); throw fail("resourceExhausted"); }
    const spec = TOOLS.find((item) => item.rpcMethod === method);
    if (!spec || !turn.chat.capabilities.includes(spec.capabilityId)) throw fail("permissionDenied");
    let ids = [];
    if (spec.capabilityId === "session.environment") ids = turn.chat.selection.targets.map((target) => target.id);
    else if (["terminal.poll", "terminal.stop"].includes(spec.capabilityId)) {
      const id = this.getMcpBridge().getPluginAgentJobTarget(params.jobId, turn.chat.record.id);
      if (!id) throw fail("permissionDenied"); ids = [id];
    } else { if (typeof params.sessionId !== "string") throw fail("invalidArgument"); ids = [params.sessionId]; }
    const targets = ids.map((id) => {
      const target = turn.chat.selection.targets.find((item) => item.id === id);
      if (!target) throw fail("permissionDenied"); return target;
    });
    const preview = JSON.stringify(Object.fromEntries(Object.entries(params).filter(([key]) => !["chatSessionId", "scopedSessionIds"].includes(key))), null, 2);
    if (Buffer.byteLength(preview) > 16_384) throw fail("resourceExhausted");
    const ctx = { ...turn.context, agentChatId: turn.chat.record.id, agentBackendLabel: turn.chat.backend.label,
      agentTargetLabels: new Map(turn.chat.selection.terminalSessions.map((item) => [item.sessionId, item.label])), agentToolPreview: preview };
    try { await this.#backendCurrent(turn.chat.backend, ctx); }
    catch (error) { this.#end(turn, "unavailable"); throw error; }
    return this.scopes.dispatch(turn.ticket, ctx, { capabilityId: spec.capabilityId, targets }, async (execution) => {
      this.#assertNow(turn);
      // Ask may have waited while the configured backend was edited. Check the
      // trusted renderer's current revision again before the selected effect.
      try { await this.#backendCurrent(turn.chat.backend, ctx); }
      catch (error) { this.#end(turn, "unavailable"); throw error; }
      this.#assertNow(turn); const result = await execute(execution); this.#assertNow(turn); return result;
    });
  }

  async send(params, context) {
    const chat = await this.#chat(params, context); const owner = chat.owner;
    this.#prune();
    if (!params.text.trim()) throw fail("invalidArgument");
    if (this.turns.size >= 256 || chat.activeTurn || Buffer.byteLength(params.text) > 16_384 || chat.record.messages.length > 198) throw fail("resourceExhausted");
    const controller = new AbortController(); const turn = { handle: randomUUID(), owner, chat, controller, context: { ...context, signal: controller.signal },
      done: false, reading: false, bytes: 0, toolCalls: 0, generation: ++chat.generation, expiresAt: this.clock() + 300_000, hostHandle: null,
      policyRevision: this.permission.getPolicyRevision(this.database.getActivePlugin(owner.pluginId)), senderId: this.host.getSenderId() };
    chat.activeTurn = turn; this.turns.set(turn.handle, turn);
    turn.context = { ...context, signal: controller.signal, assertActive: async () => this.#assertNow(turn) };
    const cancelStartup = () => this.#end(turn);
    turn.detachStartup = () => {
      context.signal?.removeEventListener("abort", cancelStartup);
      if (this.startupTurns.get(context.permissionOperation) === turn) this.startupTurns.delete(context.permissionOperation);
    };
    this.startupTurns.set(context.permissionOperation, turn);
    context.signal?.addEventListener("abort", cancelStartup, { once: true });
    try {
      context.signal?.throwIfAborted();
      this.#charge(owner); await this.#backendCurrent(chat.backend, context);
      turn.ticket = await this.scopes.begin(chat.scope.handle, context);
      turn.ticket.controller.signal.addEventListener("abort", () => this.#end(turn), { once: true });
      this.#assertNow(turn);
      const mcp = this.getMcpBridge();
      turn.registration = mcp.registerPluginAgentDelegation(chat.record.id, { turnTag: turn.handle, senderId: turn.senderId,
        tools: TOOLS.filter((tool) => chat.capabilities.includes(tool.capabilityId)).map((tool) => tool.mcpTool),
        assertCurrent: () => this.#assertNow(turn), dispatch: (method, payload, execute) => this.#dispatchTool(turn, method, payload, execute) });
      mcp.setChatSessionCancelled(chat.record.id, false);
      turn.timer = setTimeout(() => this.#end(turn, "budget-exceeded"), Math.max(1, Math.min(120_000, chat.expiresAt - this.clock()))); turn.timer.unref?.();
      const prior = structuredClone(chat.record);
      chat.record.messages.push({ id: randomUUID(), role: "user", content: params.text, timestamp: this.clock() });
      chat.record.updatedAt = this.clock();
      if (chat.record.title === "Global Agent chat") chat.record.title = params.text.trim().split(/\r?\n/u)[0].slice(0, 80);
      prior.title = chat.record.title;
      await this.store.save(owner, chat.record, async () => { await this.#guard(context); this.#assertNow(turn); });
      const result = await this.host.requestAgent("agent.run", { backendHandle: chat.backend.hostHandle, delegationTag: turn.handle,
        session: prior, capabilities: chat.capabilities, terminalSessions: chat.selection.terminalSessions, text: params.text, maxIterations: 12 }, turn.context);
      this.#assertNow(turn); turn.hostHandle = result.hostHandle;
      return { turnHandle: turn.handle, expiresAt: turn.expiresAt };
    } catch (error) { this.#end(turn); throw error; }
  }

  async read(params, context) {
    const turn = await this.#turn(params, context);
    if (turn.done) return turn.endEvent;
    if (turn.reading) throw fail("alreadyExists"); turn.reading = true;
    try {
      this.#assertNow(turn);
      await this.#backendCurrent(turn.chat.backend, context);
      const result = await this.host.requestAgent("agent.next", { hostHandle: turn.hostHandle },
        { ...context, signal: AbortSignal.any([context.signal ?? new AbortController().signal, turn.controller.signal]) });
      this.#assertNow(turn);
      if (result.session) {
        if (!this.sessionValidator(result.session) || result.session.id !== turn.chat.record.id
          || result.session.conversationRef !== turn.chat.record.conversationRef || result.session.agentId !== turn.chat.backend.backend) throw fail("internal");
        turn.chat.record = structuredClone(result.session);
        await this.store.save(turn.owner, turn.chat.record, async () => { await this.#guard(context); this.#assertNow(turn); });
      }
      const event = result.done ? { kind: "end", reason: "completed" } : result.event;
      if (!this.eventValidator(event)) throw fail("internal");
      turn.bytes += Buffer.byteLength(JSON.stringify(event));
      if (turn.bytes > 262_144) throw fail("resourceExhausted");
      if (event.kind === "end") this.#end(turn, event.reason);
      return event;
    } catch (error) { if (turn.done) return turn.endEvent; this.#end(turn, error.code === RPC_ERRORS.resourceExhausted ? "budget-exceeded" : "unavailable"); throw error; }
    finally { turn.reading = false; }
  }

  async history(params, context) {
    const chat = await this.#chat(params, context); const items = []; let bytes = 0;
    for (const message of [...chat.record.messages].reverse()) {
      if (!["user", "assistant"].includes(message?.role) || typeof message.content !== "string") continue;
      const text = message.content.slice(0, 32_768); bytes += Buffer.byteLength(text);
      if (bytes > 131_072) break; items.unshift({ role: message.role, text });
    }
    return { items };
  }

  #end(turn, reason = "cancelled") {
    if (turn.done) return;
    const wasCurrent = turn.chat.activeTurn === turn;
    turn.done = true; turn.detachStartup?.(); turn.endEvent = { kind: "end", reason }; clearTimeout(turn.timer); turn.controller.abort();
    if (turn.ticket) this.scopes.finish(turn.ticket);
    turn.registration?.dispose();
    if (wasCurrent) {
      turn.chat.activeTurn = null;
      try { this.getMcpBridge().applyChatSessionCancelled(turn.chat.record.id, true); } catch {}
    }
    if (turn.hostHandle) void this.host.requestAgent("agent.release", { hostHandle: turn.hostHandle },
      // Cleanup authenticates the owning source, independently of the ended
      // turn or its completed Send request. The host still checks app lifetime.
      { ...turn.context, signal: undefined, assertActive: async () => this.source.assertCurrent(turn.owner) }).catch(() => {});
  }
  async stop(params, context) { const turn = await this.#turn(params, context); this.#end(turn); return { ok: true }; }
  async closeChat(params, context) {
    const chat = await this.#chat(params, context);
    this.#forgetChat(chat); this.chats.delete(chat.handle); return { ok: true };
  }
  #forgetChat(chat) {
    if (chat.activeTurn) this.#end(chat.activeTurn);
    this.scopes.discard(chat.scope.handle, chat.owner);
    try { this.host.releaseAgentChat?.(chat.record.id, chat.owner.runtimeId); } catch {}
    try { void this.getMcpBridge().cleanupScopedMetadata?.(chat.record.id)?.catch(() => {}); } catch {}
  }
  releaseRuntime(runtimeId) {
    for (const [controller, owner] of this.pendingSelections) if (owner.runtimeId === runtimeId) controller.abort();
    for (const turn of this.turns.values()) if (turn.owner.runtimeId === runtimeId) this.#end(turn);
    for (const chat of this.chats.values()) if (chat.owner.runtimeId === runtimeId) this.#forgetChat(chat);
    for (const opening of this.pendingOpens) if (opening.owner.runtimeId === runtimeId) opening.active = false;
    for (const map of [this.backends, this.selections, this.chats, this.turns]) for (const [id, entry] of map) if (entry.owner.runtimeId === runtimeId) map.delete(id);
    this.scopes.releaseRuntime(runtimeId); this.source.releaseRuntime(runtimeId); this.host.releaseRuntime(runtimeId);
  }
  releasePlugin(pluginId) {
    const ids = new Set([...this.source.bindings.values()].filter((owner) => owner.pluginId === pluginId).map((owner) => owner.runtimeId));
    for (const id of ids) this.releaseRuntime(id);
  }
  releaseAll() { for (const id of [...this.source.bindings.keys()]) this.releaseRuntime(id); }
  shutdown() {
    this.releaseAll(); this.closed = true; this.scopes.shutdown(); this.source.shutdown(); this.revocation.dispose(); this.hostInvalidation();
    for (const item of this.registrations) item.dispose(); this.host.shutdown();
    for (const item of this.targetSubscriptions) item.dispose(); this.targetSubscriptions = [];
  }
}

module.exports = { PluginAgentService, PLUGIN_AGENT_FEATURE: FEATURE, PLUGIN_AGENT_CAPABILITIES: CAPABILITIES };
