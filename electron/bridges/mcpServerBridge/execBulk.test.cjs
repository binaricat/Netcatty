"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BULK_RPC_METHOD,
  CHAT_LOCK_HELD,
  DEADLINE_GRACE_MS,
  MAX_BULK_TARGETS,
  MIN_BULK_TARGETS,
  classifyHostResult,
  createExecBulkHandler,
  formatPreflightFailure,
  groupBulkResults,
  parseBulkExecParams,
  tailText,
} = require("./execBulk.cjs");

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// ── parseBulkExecParams ──

test("parseBulkExecParams accepts a JSON string or an array and applies defaults", () => {
  const fromString = parseBulkExecParams({ command: "uptime", sessionIds: '["a","b"]' });
  assert.deepEqual(fromString, { ok: true, command: "uptime", sessionIds: ["a", "b"], tailLines: 100 });
  const fromArray = parseBulkExecParams({ command: "uptime", sessionIds: [" a ", "b"], tailLines: 5 });
  assert.deepEqual(fromArray, { ok: true, command: "uptime", sessionIds: ["a", "b"], tailLines: 5 });
});

test("parseBulkExecParams rejects malformed input without touching any session", () => {
  const bad = [
    [{ command: "", sessionIds: '["a","b"]' }, /Invalid command/],
    [{ command: "  ", sessionIds: '["a","b"]' }, /Invalid command/],
    [{ command: "ls", sessionIds: "not json" }, /JSON array/],
    [{ command: "ls", sessionIds: "{}" }, /JSON array/],
    [{ command: "ls", sessionIds: "[]" }, /JSON array of 2-20/],
    [{ command: "ls", sessionIds: '["a"]' }, /at least|Use terminal_execute/],
    [{ command: "ls", sessionIds: '["a", 1]' }, /JSON array/],
    [{ command: "ls", sessionIds: '["a", ""]' }, /JSON array/],
    [{ command: "ls", sessionIds: JSON.stringify(Array.from({ length: MAX_BULK_TARGETS + 1 }, (_, i) => `s${i}`)) }, /JSON array/],
    [{ command: "ls", sessionIds: '["a","b","a"]' }, /unique.*a/],
    [{ command: "ls", sessionIds: '["a","b"]', tailLines: -1 }, /tailLines/],
    [{ command: "ls", sessionIds: '["a","b"]', tailLines: "abc" }, /tailLines/],
  ];
  for (const [params, pattern] of bad) {
    const result = parseBulkExecParams(params);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.match(result.error, pattern);
  }
});

test("parseBulkExecParams treats tailLines 0 as default and caps large values", () => {
  assert.equal(parseBulkExecParams({ command: "ls", sessionIds: '["a","b"]', tailLines: 0 }).tailLines, 100);
  assert.equal(parseBulkExecParams({ command: "ls", sessionIds: '["a","b"]', tailLines: 99999 }).tailLines, 2000);
  assert.equal(parseBulkExecParams({ command: "ls", sessionIds: '["a","b"]', tailLines: 7.9 }).tailLines, 7);
});

// ── formatting ──

test("formatPreflightFailure lists every failing target and carries no Error prefix", () => {
  const text = formatPreflightFailure([
    { sessionId: "s-9", label: "", error: 'Session "s-9" is not in the current scope.' },
    { sessionId: "s-3", label: "web3", error: "Session already has exec in progress." },
  ], 5);
  assert.equal(text, [
    "nothing was sent. 2 of 5 targets cannot run this command:",
    '- s-9: Session "s-9" is not in the current scope.',
    "- s-3 (web3): Session already has exec in progress.",
    "Remove or fix these session ids and retry.",
  ].join("\n"));
});

test("classifyHostResult reports what happened without judging the exit code", () => {
  assert.deepEqual(classifyHostResult({ ok: true, stdout: "a", stderr: "", exitCode: 0 }), {
    status: "completed", exitCode: 0, stdout: "a", stderr: "", error: "",
  });
  assert.equal(classifyHostResult({ ok: false, stdout: "inactive", exitCode: 3 }).status, "completed");
  assert.equal(classifyHostResult({ ok: false, stdout: "inactive", exitCode: 3 }).exitCode, 3);
  // Raw serial / network-device runs have no exit code.
  assert.deepEqual(
    [classifyHostResult({ ok: true, stdout: "x", exitCode: null }).status, classifyHostResult({ ok: true, stdout: "x", exitCode: null }).exitCode],
    ["completed", null],
  );
  const timeout = classifyHostResult({ ok: false, stdout: "p", exitCode: -1, error: "Command timed out (60s)" });
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.exitCode, null, "the -1 sentinel never leaves the handler");
  assert.equal(classifyHostResult({ ok: false, exitCode: -1, error: "Cancelled" }).status, "cancelled");
  assert.equal(
    classifyHostResult({ ok: false, exitCode: -1, error: "Command terminated unexpectedly (connection lost or signal)" }).status,
    "connection_lost",
  );
  assert.equal(
    classifyHostResult({ ok: false, error: "Command blocked by safety policy. Pattern: rm -rf" }).status,
    "not_sent",
  );
  assert.equal(
    classifyHostResult({ ok: false, code: "SHELL_READINESS_UNKNOWN", error: "no command was sent" }).status,
    "not_sent",
  );
  assert.equal(classifyHostResult({ ok: false, stdout: "partial", exitCode: 1, error: "boom" }).status, "error");
  assert.equal(classifyHostResult(null).status, "error");
});

test("tailText keeps the last lines and the last characters", () => {
  assert.deepEqual(tailText("", 5, 100), { text: "", omittedLines: 0, truncated: false });
  assert.deepEqual(tailText("a\nb\nc\n", 5, 100), { text: "a\nb\nc\n", omittedLines: 0, truncated: false });
  assert.deepEqual(tailText("1\n2\n3\n4\n5\n", 2, 100), { text: "4\n5\n", omittedLines: 3, truncated: true });
  const long = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
  const capped = tailText(long, 1000, 40);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 40);
  assert.ok(capped.text.startsWith("line-"), "cut starts on a line boundary");
  assert.ok(capped.omittedLines > 0);
  const oneHugeLine = tailText("x".repeat(100), 10, 30);
  assert.equal(oneHugeLine.truncated, true);
  assert.equal(oneHugeLine.text.length, 30);
});

// ── groupBulkResults ──

test("groupBulkResults groups identical results on full raw output and keeps request order", () => {
  const entries = [
    { sessionId: "s1", label: "web1", result: { ok: true, stdout: "active", exitCode: 0 } },
    { sessionId: "s2", label: "web2", result: { ok: false, stdout: "inactive", exitCode: 3 } },
    { sessionId: "s3", label: "web3", result: { ok: true, stdout: "active", exitCode: 0 } },
    { sessionId: "s4", label: "db1", result: { ok: false, stdout: "", stderr: "no route", exitCode: -1, error: "Command timed out (60s)" } },
  ];
  const payload = groupBulkResults(entries, { tailLines: 100 });
  assert.equal(payload.ok, true);
  assert.equal(payload.hostCount, 4);
  assert.deepEqual(payload.counts, { completed: 3, timeout: 1 });
  assert.deepEqual(payload.groups, [
    {
      hosts: [{ sessionId: "s1", label: "web1" }, { sessionId: "s3", label: "web3" }],
      status: "completed", exitCode: 0, stdout: "active",
    },
    { hosts: [{ sessionId: "s2", label: "web2" }], status: "completed", exitCode: 3, stdout: "inactive" },
    {
      hosts: [{ sessionId: "s4", label: "db1" }],
      status: "timeout", exitCode: null, stdout: "", stderr: "no route", error: "Command timed out (60s)",
    },
  ]);
});

test("groupBulkResults never merges hosts that only differ in the truncated part", () => {
  const head = (tag) => `${tag}\n${Array.from({ length: 10 }, (_, i) => `same-${i}`).join("\n")}`;
  const payload = groupBulkResults([
    { sessionId: "s1", label: "a", result: { ok: true, stdout: head("first"), exitCode: 0 } },
    { sessionId: "s2", label: "b", result: { ok: true, stdout: head("second"), exitCode: 0 } },
  ], { tailLines: 3 });
  assert.equal(payload.groups.length, 2);
  for (const group of payload.groups) {
    assert.equal(group.outputTruncated, true);
    assert.equal(group.omittedLines, 8);
    assert.equal(group.stdout, "same-7\nsame-8\nsame-9");
  }
});

test("groupBulkResults omits empty stderr/error and truncation fields", () => {
  const [group] = groupBulkResults([{ sessionId: "s1", label: "", result: { ok: true, stdout: "", exitCode: 0 } }]).groups;
  assert.deepEqual(Object.keys(group).sort(), ["exitCode", "hosts", "status", "stdout"]);
  assert.equal(group.stdout, "");
});

// ── handler ──

function createHarness(options = {}) {
  const ids = options.ids || ["a", "b", "c"];
  const inScope = new Set(options.inScope || ids);
  const labels = options.labels || { a: "web1", b: "web2", c: "web3" };
  const mainSessions = new Map((options.mainIds || ids).map((id) => [id, { label: labels[id] }]));
  const busy = new Map();
  const closing = new Map();
  const pending = new Map();
  const state = {
    chatLock: null,
    cancelled: false,
    events: [],
    execCalls: [],
    approvals: [],
    activity: { begun: [], ended: [] },
    cancelCalls: [],
  };
  const transportErrors = options.transportErrors || {};
  const deps = {
    getSessions: () => mainSessions,
    getSessionMeta: (id) => (options.noMeta?.includes(id) ? null : { label: labels[id] || "", connected: options.disconnected?.includes(id) ? false : true }),
    validateSessionScope: (id) => (inScope.has(id) ? null : `Session "${id}" is not in the current scope.`),
    closingTerminalSessions: closing,
    getSessionBusyError: (id) => (busy.has(id) ? { ok: false, error: busy.get(id) } : null),
    pendingSessionWriteApprovals: pending,
    getActiveChatExecution: () => state.chatLock,
    beginChatExecution: (chatSessionId, sessionId, command) => {
      state.events.push(`lock:${sessionId}`);
      if (options.lockBusy) return { ok: false, active: { command: "other", sessionId: "x" } };
      state.chatLock = { sessionId, command };
      return { ok: true, release: () => { state.events.push("unlock"); state.chatLock = null; } };
    },
    isChatSessionCancelled: () => state.cancelled,
    preflightMainExec: async ({ sessionId }) => (transportErrors[sessionId] ? { ok: false, error: transportErrors[sessionId] } : { ok: true }),
    preflightWorkerExec: ({ sessionId }) => (transportErrors[sessionId] ? { ok: false, error: transportErrors[sessionId] } : { ok: true }),
    execOnSession: (params, executionContext) => {
      state.execCalls.push({ params, executionContext });
      if (options.exec) return options.exec(params, executionContext, state);
      return Promise.resolve({ ok: true, stdout: `out-${params.sessionId}`, exitCode: 0 });
    },
    requestApproval: async (...args) => {
      state.approvals.push(args);
      state.events.push("approval");
      if (options.onApproval) await options.onApproval({ busy, closing, state, pending });
      return options.approve !== false;
    },
    sessionIdleManager: {
      beginActivity: (chat, id) => { state.activity.begun.push(id); return true; },
      endActivity: (chat, id) => { state.activity.ended.push(id); return true; },
    },
    getCommandTimeoutMs: () => 60000,
    cancelExecsForChat: (chatSessionId) => state.cancelCalls.push(chatSessionId),
    USER_DENIED_MESSAGE: "Operation denied by user.",
    CHAT_SESSION_CANCELLED_MESSAGE: "Operation cancelled: the SDK agent session was stopped.",
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  };
  Object.keys(deps).forEach((key) => deps[key] === undefined && delete deps[key]);
  const handler = createExecBulkHandler(deps);
  const baseParams = { command: "uptime", sessionIds: JSON.stringify(ids), chatSessionId: "chat-1" };
  return { handler, state, busy, closing, pending, baseParams, deps };
}

test("run fans out to every target in the same turn and holds the chat lock once", async () => {
  const gates = new Map();
  const harness = createHarness({
    exec: (params) => {
      const gate = deferred();
      gates.set(params.sessionId, gate);
      return gate.promise;
    },
  });
  const running = harness.handler.run(harness.baseParams, {}, { requiresApproval: false });
  await nextTick();
  // Every target started before any of them finished.
  assert.deepEqual(harness.state.execCalls.map((call) => call.params.sessionId), ["a", "b", "c"]);
  assert.equal(harness.state.events.filter((event) => event.startsWith("lock:")).length, 1);
  assert.equal(harness.state.events.includes("unlock"), false, "lock is held while hosts run");
  for (const call of harness.state.execCalls) {
    assert.equal(call.executionContext[CHAT_LOCK_HELD], true);
    assert.equal(call.params.chatSessionId, "chat-1");
  }
  gates.get("a").resolve({ ok: true, stdout: "same", exitCode: 0 });
  gates.get("b").resolve({ ok: true, stdout: "same", exitCode: 0 });
  gates.get("c").resolve({ ok: false, stdout: "different", exitCode: 2 });
  const payload = await running;
  assert.equal(payload.ok, true);
  assert.equal(payload.hostCount, 3);
  assert.equal(payload.groups.length, 2);
  assert.deepEqual(payload.groups[0].hosts.map((host) => host.sessionId), ["a", "b"]);
  assert.equal(harness.state.events.at(-1), "unlock");
  assert.deepEqual(harness.state.activity.begun, ["a", "b", "c"]);
  assert.deepEqual(harness.state.activity.ended.sort(), ["a", "b", "c"]);
  assert.equal(harness.pending.size, 0, "write locks are released");
});

test("run sends nothing and lists every bad target when any preflight check fails", async () => {
  const harness = createHarness({
    ids: ["a", "b", "c", "d"],
    labels: { a: "web1", b: "web2", c: "web3", d: "db1" },
    inScope: ["a", "b", "c"],
    transportErrors: { c: "Command blocked by safety policy. Pattern: rm -rf" },
  });
  harness.busy.set("b", "Session already has exec in progress.");
  const result = await harness.handler.run(
    { ...harness.baseParams, sessionIds: '["a","b","c","d"]' },
    {},
    { requiresApproval: true },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "BULK_PREFLIGHT_FAILED");
  assert.match(result.error, /^nothing was sent\. 3 of 4 targets cannot run this command:/);
  assert.match(result.error, /- b \(web2\): Session already has exec in progress\./);
  assert.match(result.error, /- c \(web3\): Command blocked by safety policy\. Pattern: rm -rf/);
  assert.match(result.error, /- d: Session "d" is not in the current scope\./);
  assert.doesNotMatch(result.error, /db1/, "out-of-scope ids reveal no label");
  assert.equal(harness.state.execCalls.length, 0);
  assert.equal(harness.state.approvals.length, 0, "no approval prompt for an impossible run");
  assert.equal(harness.pending.size, 0);
});

test("run reports closing, disconnected and unknown sessions", async () => {
  const harness = createHarness({
    ids: ["a", "b", "c"],
    mainIds: ["a"],
    disconnected: ["b"],
    noMeta: ["c"],
  });
  harness.closing.set("a", 1);
  const result = await harness.handler.run(harness.baseParams, {}, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /- a \(web1\): Session "a" is closing\./);
  assert.match(result.error, /- b \(web2\): Session "b" is not connected\./);
  assert.match(result.error, /- c: Session not found/);
  assert.equal(harness.state.execCalls.length, 0);
});

test("run refuses while another command holds the chat lock", async () => {
  const harness = createHarness();
  harness.state.chatLock = { command: "sleep 100", sessionId: "z" };
  const result = await harness.handler.run(harness.baseParams, {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "COMMAND_ALREADY_RUNNING");
  assert.equal(harness.state.execCalls.length, 0);
});

test("run asks once with a fresh, readable approval and runs only after it", async () => {
  const harness = createHarness();
  const payload = await harness.handler.run(harness.baseParams, { externalSocket: "sock" }, { requiresApproval: true });
  assert.equal(payload.ok, true);
  assert.equal(harness.state.approvals.length, 1);
  const [method, args, chatSessionId, context] = harness.state.approvals[0];
  assert.equal(method, BULK_RPC_METHOD);
  assert.deepEqual(args, { command: "uptime", sessions: ["a (web1)", "b (web2)", "c (web3)"] });
  assert.equal(chatSessionId, "chat-1");
  assert.equal(context.requireFreshApproval, true);
  assert.equal(context.externalSocket, "sock");
  assert.ok(harness.state.events.indexOf("approval") < harness.state.events.findIndex((event) => event.startsWith("lock:")));
});

test("run does not ask for approval when the permission mode needs none", async () => {
  const harness = createHarness();
  const payload = await harness.handler.run(harness.baseParams, {}, { requiresApproval: false });
  assert.equal(payload.ok, true);
  assert.equal(harness.state.approvals.length, 0);
});

test("a denied approval runs nothing and releases every claim", async () => {
  const harness = createHarness({ approve: false });
  const result = await harness.handler.run(harness.baseParams, {}, { requiresApproval: true });
  assert.deepEqual(result, { ok: false, error: "Operation denied by user." });
  assert.equal(harness.state.execCalls.length, 0);
  assert.equal(harness.state.events.some((event) => event.startsWith("lock:")), false);
  assert.equal(harness.pending.size, 0);
});

test("targets stay claimed while approval is pending", async () => {
  let claimedDuringApproval = null;
  const harness = createHarness({
    onApproval: ({ pending }) => { claimedDuringApproval = [...pending.keys()]; },
  });
  await harness.handler.run(harness.baseParams, {}, { requiresApproval: true });
  assert.deepEqual(claimedDuringApproval, ["a", "b", "c"]);
});

test("a concurrent bulk call cannot claim targets that are awaiting approval", async () => {
  const approvalGate = deferred();
  const first = createHarness({ onApproval: () => approvalGate.promise });
  const running = first.handler.run(first.baseParams, {}, { requiresApproval: true });
  await nextTick();
  const second = createHarness();
  // Share the first call's claims, like two calls inside one bridge.
  for (const id of first.pending.keys()) second.pending.set(id, BULK_RPC_METHOD);
  const conflict = await second.handler.run(second.baseParams, {}, { requiresApproval: true });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /awaiting approval or startup/);
  assert.equal(second.state.execCalls.length, 0);
  approvalGate.resolve();
  assert.equal((await running).ok, true);
});

test("sessions that become busy during approval cancel the whole call before anything is sent", async () => {
  const harness = createHarness({
    onApproval: ({ busy }) => { busy.set("c", "Session already has exec in progress."); },
  });
  const result = await harness.handler.run(harness.baseParams, {}, { requiresApproval: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /^nothing was sent\. 1 of 3 targets/);
  assert.equal(harness.state.execCalls.length, 0);
  assert.equal(harness.pending.size, 0);
});

test("a chat cancelled during approval sends nothing", async () => {
  const harness = createHarness({ onApproval: ({ state }) => { state.cancelled = true; } });
  const result = await harness.handler.run(harness.baseParams, {}, { requiresApproval: true });
  assert.deepEqual(result, { ok: false, error: "Operation cancelled: the SDK agent session was stopped." });
  assert.equal(harness.state.execCalls.length, 0);
  assert.equal(harness.pending.size, 0);
});

test("the privacy hook runs before the first command and can stop the call", async () => {
  const harness = createHarness();
  const result = await harness.handler.run(
    harness.baseParams,
    { beforeExecute: () => { throw new Error("External MCP privacy settings changed. Reconnect the MCP client before continuing."); } },
    {},
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /privacy settings changed/);
  assert.equal(harness.state.execCalls.length, 0);
  assert.equal(harness.state.events.at(-1), "unlock");
});

test("per-host failures stay per host and the others still report", async () => {
  const harness = createHarness({
    exec: (params) => {
      if (params.sessionId === "a") throw new Error("sync boom");
      if (params.sessionId === "b") return Promise.reject(new Error("async boom"));
      return Promise.resolve({ ok: true, stdout: "fine", exitCode: 0 });
    },
  });
  const payload = await harness.handler.run(harness.baseParams, {}, {});
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.counts, { error: 2, completed: 1 });
  const errors = payload.groups.filter((group) => group.status === "error");
  assert.deepEqual(errors.map((group) => group.error).sort(), ["async boom", "sync boom"]);
  assert.equal(payload.groups.find((group) => group.status === "completed").stdout, "fine");
});

test("when no host received the command the call fails", async () => {
  const harness = createHarness({
    exec: () => Promise.resolve({ ok: false, error: "Command blocked by safety policy. Pattern: shutdown" }),
  });
  const result = await harness.handler.run(harness.baseParams, {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "BULK_NOT_SENT");
  assert.match(result.error, /^No command was sent to any host\./);
  assert.match(result.error, /- a \(web1\): Command blocked by safety policy/);
});

test("the deadline reports unfinished hosts as timeouts and cancels the chat's execs", async () => {
  let fireDeadline;
  let scheduledMs;
  const harness = createHarness({
    exec: (params) => (params.sessionId === "c" ? new Promise(() => {}) : Promise.resolve({ ok: true, stdout: "ok", exitCode: 0 })),
    setTimeoutFn: (fn, ms) => { fireDeadline = fn; scheduledMs = ms; return 1; },
    clearTimeoutFn: () => {},
  });
  const running = harness.handler.run(harness.baseParams, {}, {});
  await nextTick();
  assert.equal(scheduledMs, 60000 + DEADLINE_GRACE_MS);
  fireDeadline();
  const payload = await running;
  assert.deepEqual(harness.state.cancelCalls, ["chat-1"]);
  assert.deepEqual(payload.counts, { completed: 2, timeout: 1 });
  const timeout = payload.groups.find((group) => group.status === "timeout");
  assert.deepEqual(timeout.hosts, [{ sessionId: "c", label: "web3" }]);
  assert.equal(timeout.error, "Command timed out (60s)");
  assert.equal(timeout.exitCode, null);
  assert.equal(harness.state.events.at(-1), "unlock");
});

test("invalid input is rejected before any session is inspected", async () => {
  const harness = createHarness();
  const result = await harness.handler.run({ ...harness.baseParams, sessionIds: '["a","a"]' }, {}, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /unique/);
  assert.equal(harness.state.execCalls.length, 0);
  assert.equal(harness.pending.size, 0);
});

test("a single session is rejected and pointed at terminal_execute", () => {
  assert.equal(MIN_BULK_TARGETS, 2);
  const result = parseBulkExecParams({ command: "uptime", sessionIds: '["only-one"]' });
  assert.equal(result.ok, false);
  assert.match(result.error, /2-20/);
  assert.match(result.error, /terminal_execute/);
  assert.equal(parseBulkExecParams({ command: "uptime", sessionIds: '["a","b"]' }).ok, true);
});
