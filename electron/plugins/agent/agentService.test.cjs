"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PluginAgentService } = require("./agentService.cjs");
const { PluginAgentConversationStore } = require("./conversationStore.cjs");
const { PluginAgentMcpDelegations } = require("./mcpDelegation.cjs");
const { PluginPermissionEngine } = require("../permissionEngine.cjs");
const { PluginHostRpcRegistry } = require("../hostRpcRegistry.cjs");

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-agent-service-"));
  const manifest = { id: "com.example.agent", publisher: "example", version: "1.0.0", permissions: { required: ["ai.agent.use", "ai.agent.actions"] } };
  let identity = { pluginId: manifest.id, pluginVersion: manifest.version, runtimeId: "r1", runtimeKind: "browser", manifest };
  let sourceId = "source-a"; let time = 1; let locked = false; const modes = new Map(); let focus = "a"; let effects = 0;
  const audits = []; const decisions = []; const hostRequests = []; const releasedHandles = []; const invalidations = new Set();
  const plugin = () => ({ id: manifest.id, enabled: true, activeVersion: manifest.version, manifest,
    source: { id: sourceId, kind: "third-party", origin: "https://synthetic.invalid" }, runtime: { status: "running" } });
  const database = { getActivePlugin: (id) => id === manifest.id ? plugin() : null,
    getRetainedPluginSource: () => plugin().source, privateOwner: () => `opaque-owner:${sourceId}`,
    publicPluginId: (owner) => owner === `opaque-owner:${sourceId}` ? manifest.id : null,
    getPermissionMode: (_id, permission) => modes.get(permission) ?? "allow",
    listPermissionGrants: () => [], recordSecurityAudit: (_id, event, value) => audits.push({ event, ...value }) };
  let approve = async (request) => ({ requestId: request.requestId, decision: "allow", scope: "once" });
  const permission = new PluginPermissionEngine({ database, requestDecision: (request) => { decisions.push(request); return approve(request); } });
  const targetState = new Map([["a", { owner: "7", revision: "worker-a:1" }], ["b", { owner: "8", revision: "worker-a:2" }]]);
  const backendHandle = randomUUID(); const externalHandle = randomUUID();
  const sessions = new Map(); const events = [];
  let run = async (payload) => { const handle = randomUUID(); sessions.set(handle, structuredClone(payload.session)); return { hostHandle: handle }; };
  let current = true;
  let choose = async () => ({ targets: [...targetState.keys()].map((id) => ({ sessionId: id, hostname: `${id}.invalid`, label: `Synthetic ${id}`, connected: true })) });
  const resourceListeners = new Set();
  const watch = (callback) => { resourceListeners.add(callback); return { dispose: () => resourceListeners.delete(callback) }; };
  const targetManager = { onSessionOwned: watch, onSessionClosed: watch, onWorkerExit: watch };
  const host = { generation: 1, getSenderId: () => 7,
    assertActive: async (context) => { await context.assertActive(); if (locked) throw Error("Locked"); },
    onDidInvalidate: (callback) => { invalidations.add(callback); return () => invalidations.delete(callback); },
    requestAgent: async (kind, payload, context) => {
      hostRequests.push({ kind, payload: structuredClone(payload) });
      if (kind === "agent.backends") return { backends: [
        { hostHandle: backendHandle, backend: "catty", label: "Catty fixture", status: "supported", reason: "ready" },
        { hostHandle: externalHandle, backend: "claude", label: "Claude fixture", status: "supported", reason: "ready" },
        { hostHandle: randomUUID(), backend: "codex", label: "Codex fixture", status: "supported", reason: "ready" },
      ] };
      if (kind === "agent.current") return { current };
      if (kind === "agent.targets") return choose();
      if (kind === "agent.run") return run(payload);
      if (kind === "agent.next") return { done: false, event: events.shift() ?? { kind: "end", reason: "completed" }, session: sessions.get(payload.hostHandle) };
      if (kind === "agent.release") { await context.assertActive(); releasedHandles.push(payload.hostHandle); }
      return { ok: true };
    }, releaseRuntime: () => {}, shutdown: () => {} };
  const delegation = new PluginAgentMcpDelegations();
  const mcp = { registerPluginAgentDelegation: (...args) => delegation.register(...args),
    setChatSessionCancelled: () => {}, applyChatSessionCancelled: () => {}, getPluginAgentJobTarget: () => null };
  const service = new PluginAgentService({ database, permissionEngine: permission, hostAdapter: host,
    conversationStore: new PluginAgentConversationStore(directory), getRuntimeIdentity: () => identity, getMcpBridge: () => mcp, clock: () => time,
    getTargetManager: () => targetManager,
    getSessionBinding: (id) => { const snapshot = targetState.get(id); return snapshot && { ...snapshot,
      isCurrent: (target) => targetState.get(id)?.owner === target.owner && targetState.get(id)?.revision === target.revision }; } });
  const registry = new PluginHostRpcRegistry(); registry.use(permission.createMiddleware()); service.registerRpcCapabilities(registry);
  const call = (method, params = {}, overrides = {}) => registry.createRoutes(identity).requestHandlers[`agent.${method}`](params, { signal: new AbortController().signal, ...overrides });
  const open = async (backend = "catty", conversationRef) => {
    const backends = await call("listBackends"); const selection = await call("selectTargets");
    return call("openChat", { backendRef: backends.items.find((item) => item.backend === backend).backendRef, selectionHandle: selection.selectionHandle, ...(conversationRef ? { conversationRef } : {}) });
  };
  const dispatch = async (turn, id = "a") => {
    const internal = service.turns.get(turn.turnHandle); if (!internal) throw Error("Turn unavailable");
    return delegation.dispatch("netcatty/exec", { chatSessionId: internal.chat.record.id, sessionId: id, command: "printf synthetic" },
      { trustedAgentSenderId: 7, trustedAgentTurnTag: turn.turnHandle }, (context) => { context.beforeExecute(); effects++; return "synthetic"; });
  };
  t.after(() => { service.shutdown(); delegation.shutdown(); permission.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, call, open, dispatch, events, sessions, hostRequests, releasedHandles, decisions, audits, host, delegation, targetState,
    effects: () => effects, focusTo: (id) => { focus = id; }, focus: () => focus, modeTo: (value, permission = "ai.agent.actions") => { modes.set(permission, value); },
    approve: (fn) => { approve = fn; }, run: (fn) => { run = fn; }, tick: (ms) => { time += ms; },
    choose: (fn) => { choose = fn; }, resourceChanged: () => { for (const callback of resourceListeners) callback(); },
    replaceSource: () => { sourceId = "source-b"; }, currentTo: (value) => { current = value; },
    restart: () => { service.releaseRuntime(identity.runtimeId); identity = { ...identity, runtimeId: randomUUID() }; },
    lock: () => { locked = true; host.generation++; for (const callback of invalidations) callback(); } };
}

test("registered Agent routes validate opaque authority, report unsupported modes and preserve core-only native history", async (t) => {
  const f = fixture(t); const backends = await f.call("listBackends");
  assert.deepEqual(f.hostRequests.map((request) => request.kind), ["agent.backends"], "public backend listing never starts native model discovery");
  await assert.rejects(f.call("listBackends", { delegatedAgent: true }));
  assert.equal(backends.items.find((entry) => entry.backend === "codex").status, "unsupported");
  await assert.rejects(f.call("openChat", { backendRef: randomUUID(), selectionHandle: randomUUID(), permissionMode: "auto" }));
  const chat = await f.open(); const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic conversation" });
  await assert.rejects(f.call("send", { chatHandle: chat.chatHandle, text: "Spoof delegated mode", delegatedAgent: false }));
  const [handle, session] = [...f.sessions][0];
  session.messages = [{ role: "user", content: "Synthetic conversation" }, { role: "assistant", content: "Synthetic answer" }];
  session.externalSessionId = "NATIVE_PRIVATE_SESSION"; f.events.push({ kind: "text", text: "Synthetic answer" });
  assert.deepEqual(await f.call("read", { turnHandle: turn.turnHandle }), { kind: "text", text: "Synthetic answer" });
  await f.call("read", { turnHandle: turn.turnHandle });
  assert.deepEqual(await f.call("history", { chatHandle: chat.chatHandle }), { items: [
    { role: "user", text: "Synthetic conversation" }, { role: "assistant", text: "Synthetic answer" } ] });
  const summaries = await f.call("listChats"); assert.doesNotMatch(JSON.stringify({ chat, turn, summaries }), /NATIVE_|opaque-owner|source-a|plugin-agent:/);
  await f.call("closeChat", { chatHandle: chat.chatHandle });
  const reopened = await f.open("claude", chat.conversationRef);
  assert.equal(f.service.chats.get(reopened.chatHandle).record.externalSessionId, undefined);
  assert.equal((await f.call("history", { chatHandle: reopened.chatHandle })).items.length, 2);
  assert.ok(handle); f.restart(); f.replaceSource();
  assert.deepEqual(await f.call("listChats"), { items: [] });
  await assert.rejects(f.open("catty", chat.conversationRef));
});

test("actual source policy decides once per tool and targets never follow focus across workspaces", async (t) => {
  const f = fixture(t); f.modeTo("ask"); const chat = await f.open();
  const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic action" }); f.focusTo("unselected");
  assert.equal(await f.dispatch(turn, "b"), "synthetic"); assert.equal(f.effects(), 1); assert.equal(f.decisions.length, 1);
  assert.equal(f.decisions[0].permission, "ai.agent.actions"); assert.equal(f.decisions[0].displayContext.action.capabilityId, "terminal.execute");
  await assert.rejects(f.dispatch(turn, f.focus())); assert.equal(f.effects(), 1); assert.equal(f.decisions.length, 1);
  f.approve(async (request) => ({ requestId: request.requestId, decision: "deny" }));
  await assert.rejects(f.dispatch(turn)); assert.equal(f.effects(), 1); assert.equal(f.decisions.length, 2);
  const entered = deferred(); const resume = deferred();
  f.approve(async (request) => { entered.resolve(); await resume.promise; return { requestId: request.requestId, decision: "allow", scope: "once" }; });
  const pending = f.dispatch(turn); const rejection = assert.rejects(pending); await entered.promise;
  f.targetState.set("a", { owner: "new-window", revision: "new-generation" }); resume.resolve(); await rejection;
  assert.equal(f.effects(), 1);
});

test("a duplicate owned-history Open cannot replace or cancel an active core chat", async (t) => {
  const f = fixture(t); const chat = await f.open();
  const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic active chat" });
  const active = f.service.turns.get(turn.turnHandle);
  await assert.rejects(f.open("catty", chat.conversationRef), { code: -32006 });
  assert.equal(f.service.chats.size, 1); assert.equal(active.chat.activeTurn, active);
  assert.equal(active.controller.signal.aborted, false); assert.equal(await f.dispatch(turn), "synthetic");
});

test("backend revision changed during Ask cannot execute the already selected target without any pending event read", async (t) => {
  const f = fixture(t); f.modeTo("ask"); const chat = await f.open();
  const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic pending approval" });
  const internal = f.service.turns.get(turn.turnHandle); const native = new AbortController();
  f.delegation.onRelease(internal.chat.record.id, turn.turnHandle, () => native.abort());
  const entered = deferred(); const resume = deferred();
  f.approve(async (request) => { entered.resolve(); await resume.promise; return { requestId: request.requestId, decision: "allow", scope: "once" }; });
  const pending = f.dispatch(turn); await entered.promise;
  const checksBeforeApproval = f.hostRequests.filter((item) => item.kind === "agent.current").length;
  f.currentTo(false); resume.resolve();
  const result = await pending.then(() => "executed", () => "rejected");
  assert.equal(f.effects(), 0); assert.equal(result, "rejected");
  assert.ok(f.hostRequests.filter((item) => item.kind === "agent.current").length > checksBeforeApproval);
  assert.equal(native.signal.aborted, true); assert.equal(internal.controller.signal.aborted, true);
  assert.equal(f.decisions.length, 1);
});

test("empty-argument environment Ask carries the canonical host operation and selected-target disclosure", async (t) => {
  const f = fixture(t); f.choose(async () => ({ targets: [] })); f.modeTo("ask");
  const chat = await f.open(); const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic environment" });
  const internal = f.service.turns.get(turn.turnHandle);
  await f.delegation.dispatch("netcatty/getContext", { chatSessionId: internal.chat.record.id },
    { trustedAgentSenderId: 7, trustedAgentTurnTag: turn.turnHandle }, () => ({ hosts: [], hostCount: 0 }));
  assert.equal(f.decisions.length, 1);
  assert.deepEqual(f.decisions[0].displayContext.action, { capabilityId: "session.environment", text: "{}" });
  assert.deepEqual(f.decisions[0].displayContext.selections, []);
});

test("Actions Deny keeps model conversation available with no tools; Agent-use Deny prevents host dispatch", async (t) => {
  const f = fixture(t); f.modeTo("deny"); const chat = await f.open();
  const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic model-only intent" });
  const internal = f.service.turns.get(turn.turnHandle);
  assert.deepEqual(f.delegation.configuration(internal.chat.record.id, turn.turnHandle).tools, []);
  await assert.rejects(f.dispatch(turn)); assert.equal(f.effects(), 0); assert.equal(f.decisions.length, 0);
  await f.call("stop", { turnHandle: turn.turnHandle });
  f.modeTo("deny", "ai.agent.use"); const count = f.hostRequests.length;
  await assert.rejects(f.call("send", { chatHandle: chat.chatHandle, text: "Denied" })); assert.equal(f.hostRequests.length, count);
});

test("source replacement, lock and backend changes revoke native work and reject late events", async (t) => {
  for (const kind of ["source", "lock", "backend"]) {
    const f = fixture(t); const chat = await f.open(); const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic" });
    const internal = f.service.turns.get(turn.turnHandle); const native = new AbortController();
    f.delegation.onRelease(internal.chat.record.id, turn.turnHandle, () => native.abort());
    if (kind === "source") f.replaceSource(); else if (kind === "lock") f.lock(); else f.currentTo(false);
    await assert.rejects(f.dispatch(turn)); assert.equal(native.signal.aborted, true); assert.equal(f.effects(), 0);
    if (kind !== "backend") await assert.rejects(f.call("read", { turnHandle: turn.turnHandle }));
  }
});

test("per-source turn budget survives runtime restart and is isolated from a different source", async (t) => {
  const f = fixture(t); let chat = await f.open();
  for (let i = 0; i < 6; i++) { const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic" }); await f.call("stop", { turnHandle: turn.turnHandle }); }
  f.restart(); chat = await f.open(); await assert.rejects(f.call("send", { chatHandle: chat.chatHandle, text: "Over budget" }));
  f.restart(); f.replaceSource(); chat = await f.open();
  assert.ok((await f.call("send", { chatHandle: chat.chatHandle, text: "Isolated source" })).turnHandle);
});

test("late start/open completion after release cannot publish handles or affect a replacement turn", async (t) => {
  const f = fixture(t); const chat = await f.open(); const entered = deferred(); const resume = deferred();
  f.run(async () => { entered.resolve(); await resume.promise; return { hostHandle: randomUUID() }; });
  const starting = f.call("send", { chatHandle: chat.chatHandle, text: "Delayed synthetic start" }); const rejected = assert.rejects(starting);
  await entered.promise; f.restart(); resume.resolve(); await rejected; assert.equal(f.service.chats.size, 0); assert.equal(f.service.turns.size, 0);
  const next = await f.open(); f.tick(300_001);
  await assert.rejects(f.call("send", { chatHandle: next.chatHandle, text: "Expired" }));
  assert.ok((await f.open()).chatHandle); assert.equal(f.service.chats.size, 1);
});

test("registered send cancellation during trusted startup revokes the exact turn before a handle can be handed off", async (t) => {
  const f = fixture(t); const chat = await f.open(); const entered = deferred(); const resume = deferred();
  const caller = new AbortController();
  f.run(async () => { entered.resolve(); await resume.promise; return { hostHandle: randomUUID() }; });
  const pending = f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic cancelled startup" }, { signal: caller.signal });
  const rejected = assert.rejects(pending); await entered.promise;
  const internal = [...f.service.turns.values()][0]; const native = new AbortController();
  f.delegation.onRelease(internal.chat.record.id, internal.handle, () => native.abort());
  caller.abort(); resume.resolve(); await rejected;
  assert.equal(internal.chat.activeTurn, null); assert.equal(internal.controller.signal.aborted, true);
  assert.equal(f.delegation.has(internal.chat.record.id), false); assert.equal(native.signal.aborted, true);
  assert.equal(internal.hostHandle, null, "late startup completion cannot publish an orphan handle");
  assert.equal(f.service.startupTurns.size, 0);
});

test("completed send detaches request lifetime from its live turn and cannot cancel replacement B", async (t) => {
  const f = fixture(t); const chat = await f.open(); const caller = new AbortController();
  const first = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic completed handoff" }, { signal: caller.signal });
  const a = f.service.turns.get(first.turnHandle); caller.abort();
  assert.equal(f.service.startupTurns.size, 0);
  assert.equal(a.controller.signal.aborted, false); assert.equal(await f.dispatch(first), "synthetic");
  await f.call("stop", { turnHandle: first.turnHandle });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.releasedHandles.includes(a.hostHandle), "completed request lifetime cannot block exact host-handle cleanup");
  const second = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic replacement B" });
  const b = f.service.turns.get(second.turnHandle); caller.abort();
  assert.equal(b.controller.signal.aborted, false); assert.equal(await f.dispatch(second), "synthetic");
});

test("worker lifecycle during target confirmation cannot silently bind a replacement connection or leave native work running", async (t) => {
  const f = fixture(t); const chat = await f.open(); const turn = await f.call("send", { chatHandle: chat.chatHandle, text: "Synthetic pending work" });
  const internal = f.service.turns.get(turn.turnHandle); const native = new AbortController();
  f.delegation.onRelease(internal.chat.record.id, turn.turnHandle, () => native.abort());
  const entered = deferred(); const resume = deferred();
  f.choose(async () => { entered.resolve(); await resume.promise; return { targets: [{ sessionId: "a", hostname: "a.invalid", label: "Synthetic a", connected: true }] }; });
  const pending = f.call("selectTargets"); const rejected = assert.rejects(pending); await entered.promise;
  f.targetState.set("a", { owner: "replacement-window", revision: "replacement-generation" }); f.resourceChanged();
  assert.equal(native.signal.aborted, true); assert.equal(f.service.chats.size, 0);
  const count = f.service.selections.size; resume.resolve(); await rejected; assert.equal(f.service.selections.size, count);
});
