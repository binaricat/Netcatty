"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BULK_ENTRY_MAX_AGE_MS,
  BULK_START_RPC_METHOD,
  MAX_BULK_ENTRIES,
  MAX_POLL_CHARS_PER_JOB,
  MAX_POLL_TOTAL_CHARS,
  allocatePollBudgets,
  createJobBulkHandler,
  parseJobTargets,
  parseOffsets,
} = require("./jobBulk.cjs");
const { serializeBackgroundJob } = require("../ai/backgroundJobOutput.cjs");

// ── input parsing ──

test("parseJobTargets accepts a bulkId or a JSON list of jobIds, not both", () => {
  assert.deepEqual(parseJobTargets({ bulkId: " bulk-1 " }), { ok: true, bulkId: "bulk-1", jobIds: [] });
  assert.deepEqual(parseJobTargets({ jobIds: '["j1","j2","j1"]' }), { ok: true, bulkId: null, jobIds: ["j1", "j2"] });
  assert.deepEqual(parseJobTargets({ jobIds: ["j1"] }), { ok: true, bulkId: null, jobIds: ["j1"] });
  for (const [params, pattern] of [
    [{}, /bulkId or jobIds is required/],
    [{ bulkId: "b", jobIds: '["j"]' }, /either bulkId or jobIds/],
    [{ jobIds: "not json" }, /JSON array of 1-20/],
    [{ jobIds: "[]" }, /JSON array of 1-20/],
    [{ jobIds: '["a", 1]' }, /JSON array of 1-20/],
    [{ jobIds: JSON.stringify(Array.from({ length: 21 }, (_, i) => `j${i}`)) }, /JSON array of 1-20/],
  ]) {
    const result = parseJobTargets(params);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.match(result.error, pattern);
  }
});

test("parseOffsets maps jobId to a non-negative offset", () => {
  assert.deepEqual([...parseOffsets(undefined).offsets], []);
  assert.deepEqual([...parseOffsets('{"j1":10,"j2":"5.9"}').offsets], [["j1", 10], ["j2", 5]]);
  assert.deepEqual([...parseOffsets({ j1: 3 }).offsets], [["j1", 3]]);
  for (const raw of ["[1]", '{"j":-1}', '{"j":"x"}', "nope"]) {
    assert.equal(parseOffsets(raw).ok, false, raw);
  }
});

test("allocatePollBudgets shares the total by need and never exceeds the caps", () => {
  // Everyone fits: each gets what it needs.
  assert.deepEqual(allocatePollBudgets([10, 0, 30], 100, 1000), [10, 0, 30]);
  // Per-job cap.
  assert.deepEqual(allocatePollBudgets([500, 5], 100, 1000), [100, 5]);
  // Quiet jobs leave room for busy ones.
  assert.deepEqual(allocatePollBudgets([1, 1, 1000, 1000], 100, 150), [1, 1, 74, 74]);
  // All busy: an equal share, total never exceeded.
  const even = allocatePollBudgets(Array(20).fill(50_000), 4096, 32 * 1024);
  assert.ok(even.every((value) => value === 1638));
  assert.ok(even.reduce((a, b) => a + b, 0) <= 32 * 1024);
  assert.deepEqual(allocatePollBudgets([], 100, 100), []);
});

// ── harness ──

function createHarness(options = {}) {
  const ids = options.ids || ["a", "b", "c"];
  const inScope = new Set(options.inScope || ids);
  const labels = options.labels || { a: "web1", b: "web2", c: "db1" };
  const mainSessions = new Map((options.mainIds || ids).map((id) => [id, { label: labels[id] }]));
  const busy = new Map();
  const closing = new Map();
  const pending = new Map();
  const jobs = new Map(options.jobs || []);
  const state = {
    cancelled: false,
    events: [],
    approvals: [],
    probes: [],
    starts: [],
    polls: [],
    stops: [],
    activity: { begun: [], ended: [] },
    livePermission: null,
    now: options.now ?? 1_000_000,
  };
  let nextBulk = 0;
  let nextJob = 0;
  const preflight = (where) => async ({ sessionId }, { probe }) => {
    state.probes.push({ sessionId, where, probe });
    const error = options.transportErrors?.[sessionId];
    return error ? { ok: false, error } : { ok: true };
  };
  const deps = {
    getSessions: () => mainSessions,
    getSessionMeta: (id) => ({ label: labels[id] || "", connected: true }),
    validateSessionScope: (id) => (inScope.has(id) ? null : `Session "${id}" is not in the current scope.`),
    closingTerminalSessions: closing,
    getSessionBusyError: (id) => (busy.has(id) ? { ok: false, error: busy.get(id) } : null),
    pendingSessionWriteApprovals: pending,
    isChatSessionCancelled: () => state.cancelled,
    preflightMainJobStart: preflight("main"),
    preflightWorkerJobStart: preflight("worker"),
    startJobOnSession: (params, beforeExecute) => {
      state.starts.push({ params, beforeExecute });
      state.events.push(`start:${params.sessionId}`);
      if (options.start) return options.start(params, state);
      const jobId = `job-${params.sessionId}-${nextJob++}`;
      jobs.set(jobId, { id: jobId, sessionId: params.sessionId, chatSessionId: params.chatSessionId, status: "running", stdout: "", outputBaseOffset: 0, totalOutputChars: 0 });
      return Promise.resolve({ ok: true, jobId, sessionId: params.sessionId, status: "running" });
    },
    pollJob: (params) => {
      state.polls.push(params);
      const job = jobs.get(params.jobId);
      if (!job || (job.chatSessionId && job.chatSessionId !== params.chatSessionId)) {
        return { ok: false, error: "Background job not found" };
      }
      return serializeBackgroundJob(job, params.offset);
    },
    stopJob: (params) => {
      state.stops.push(params);
      const job = jobs.get(params.jobId);
      if (!job) return { ok: false, error: "Background job not found" };
      if (job.status === "running") job.status = "stopping";
      return serializeBackgroundJob(job, 0);
    },
    requestApproval: async (...args) => {
      state.approvals.push(args);
      state.events.push("approval");
      if (options.onApproval) await options.onApproval({ busy, closing, state, pending, inScope });
      return options.approve !== false;
    },
    sessionIdleManager: {
      beginActivity: (chat, id) => { state.activity.begun.push(id); return true; },
      endActivity: (chat, id) => { state.activity.ended.push(id); return true; },
    },
    getLivePermission: () => state.livePermission,
    USER_DENIED_MESSAGE: "Operation denied by user.",
    CHAT_SESSION_CANCELLED_MESSAGE: "Operation cancelled: the SDK agent session was stopped.",
    createBulkId: () => `bulk-${nextBulk++}`,
    now: () => state.now,
  };
  const handler = createJobBulkHandler(deps);
  const baseParams = { command: "apt-get -y upgrade", sessionIds: JSON.stringify(ids), chatSessionId: "chat-1" };
  return { handler, state, busy, closing, pending, jobs, baseParams, deps, inScope };
}

// ── start ──

test("start launches one job per session after one fresh approval and returns a bulkId", async () => {
  const harness = createHarness();
  const result = await harness.handler.start(harness.baseParams, { beforeExecute: () => {} }, { requiresApproval: true });

  assert.equal(result.ok, true);
  assert.equal(result.bulkId, "bulk-0");
  assert.equal(result.hostCount, 3);
  assert.deepEqual(result.counts, { running: 3 });
  assert.deepEqual(result.jobs.map((job) => [job.sessionId, job.label, job.status]), [
    ["a", "web1", "running"], ["b", "web2", "running"], ["c", "db1", "running"],
  ]);
  assert.ok(result.jobs.every((job) => typeof job.jobId === "string"));

  assert.equal(harness.state.approvals.length, 1, "one approval for the whole fan-out");
  const [method, args, chatSessionId, context] = harness.state.approvals[0];
  assert.equal(method, BULK_START_RPC_METHOD);
  assert.deepEqual(args, { command: "apt-get -y upgrade", sessions: ["a (web1)", "b (web2)", "c (db1)"] });
  assert.equal(chatSessionId, "chat-1");
  assert.equal(context.requireFreshApproval, true);
  // Every start runs after the approval.
  assert.deepEqual(harness.state.events, ["approval", "start:a", "start:b", "start:c"]);
  // Claims and idle protection are released once the jobs exist.
  assert.equal(harness.pending.size, 0);
  assert.deepEqual(harness.state.activity.ended, ["a", "b", "c"]);
});

test("start never probes a remote host before approval, and probes every target after it", async () => {
  const harness = createHarness({ mainIds: ["a"], ids: ["a", "b"] });
  await harness.handler.start({ ...harness.baseParams, sessionIds: '["a","b"]' }, {}, { requiresApproval: true });
  const beforeApproval = harness.state.probes.slice(0, 2);
  const afterApproval = harness.state.probes.slice(2);
  assert.deepEqual(beforeApproval.map((p) => [p.sessionId, p.where, p.probe]), [["a", "main", false], ["b", "worker", false]]);
  assert.deepEqual(afterApproval.map((p) => [p.sessionId, p.probe]), [["a", true], ["b", true]]);
});

test("start without a prompt runs the full check right away", async () => {
  const harness = createHarness();
  const result = await harness.handler.start(harness.baseParams, {}, { requiresApproval: false });
  assert.equal(result.ok, true);
  assert.equal(harness.state.approvals.length, 0);
  assert.ok(harness.state.probes.every((p) => p.probe === true));
});

test("start is all-or-nothing: every bad target is listed and no job starts", async () => {
  const harness = createHarness({
    inScope: ["a", "b"],
    transportErrors: { b: "Background execution currently supports shell-backed PTY sessions only." },
  });
  harness.busy.set("a", "Session already has a long-running command in progress.");
  const result = await harness.handler.start(harness.baseParams, {}, { requiresApproval: true });

  assert.equal(result.ok, false);
  assert.equal(result.code, "BULK_PREFLIGHT_FAILED");
  assert.match(result.error, /^nothing was sent\. 3 of 3 targets cannot run this command:/);
  assert.match(result.error, /- a \(web1\): Session already has a long-running command/);
  assert.match(result.error, /- b \(web2\): Background execution currently supports shell-backed PTY sessions only\./);
  // An out-of-scope id never reveals its label.
  assert.match(result.error, /- c: Session "c" is not in the current scope\./);
  assert.equal(harness.state.approvals.length, 0);
  assert.equal(harness.state.starts.length, 0);
});

test("start rejects malformed input and points single sessions to terminal_start", async () => {
  const harness = createHarness();
  const single = await harness.handler.start({ ...harness.baseParams, sessionIds: '["a"]' });
  assert.equal(single.ok, false);
  assert.match(single.error, /Use terminal_start/);
  assert.equal((await harness.handler.start({ ...harness.baseParams, command: " " })).ok, false);
  assert.equal(harness.state.starts.length, 0);
});

test("a denied approval starts nothing and releases every claim", async () => {
  const harness = createHarness({ approve: false });
  const result = await harness.handler.start(harness.baseParams, {}, { requiresApproval: true });
  assert.deepEqual(result, { ok: false, error: "Operation denied by user." });
  assert.equal(harness.state.starts.length, 0);
  assert.equal(harness.pending.size, 0);
});

test("targets are claimed while the approval is open", async () => {
  let claimedDuringApproval = null;
  const harness = createHarness({
    onApproval: ({ pending }) => { claimedDuringApproval = [...pending.entries()]; },
  });
  await harness.handler.start(harness.baseParams, {}, { requiresApproval: true });
  assert.deepEqual(claimedDuringApproval, [["a", BULK_START_RPC_METHOD], ["b", BULK_START_RPC_METHOD], ["c", BULK_START_RPC_METHOD]]);
});

test("a target claimed by another request is refused before the prompt", async () => {
  const harness = createHarness();
  harness.pending.set("b", "netcatty/exec");
  const result = await harness.handler.start(harness.baseParams, {}, { requiresApproval: true });
  assert.equal(result.code, "BULK_PREFLIGHT_FAILED");
  assert.match(result.error, /- b \(web2\): Session already has another command request awaiting approval/);
  assert.equal(harness.pending.get("b"), "netcatty/exec", "the other request keeps its claim");
});

test("state that changes while the prompt is open stops the whole start", async () => {
  const cancelled = createHarness({ onApproval: ({ state }) => { state.cancelled = true; } });
  assert.deepEqual(
    await cancelled.handler.start(cancelled.baseParams, {}, { requiresApproval: true }),
    { ok: false, error: "Operation cancelled: the SDK agent session was stopped." },
  );
  assert.equal(cancelled.state.starts.length, 0);

  const observer = createHarness({
    onApproval: ({ state }) => { state.livePermission = { allowed: false, error: "observer mode" }; },
  });
  assert.deepEqual(await observer.handler.start(observer.baseParams, {}, { requiresApproval: true }), { ok: false, error: "observer mode" });
  assert.equal(observer.state.starts.length, 0);

  const closing = createHarness({ onApproval: ({ closing: map }) => { map.set("c", true); } });
  const result = await closing.handler.start(closing.baseParams, {}, { requiresApproval: true });
  assert.equal(result.code, "BULK_PREFLIGHT_FAILED");
  assert.match(result.error, /- c \(db1\): Session "c" is closing\./);
  assert.equal(closing.state.starts.length, 0);
  assert.equal(closing.pending.size, 0);
});

test("switching to confirm mode during an unprompted start refuses it", async () => {
  const harness = createHarness();
  harness.state.livePermission = { allowed: true, requiresApproval: true };
  const result = await harness.handler.start(harness.baseParams, {}, { requiresApproval: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /permission mode changed to confirm/);
  assert.equal(harness.state.starts.length, 0);
});

test("a privacy-policy change during approval stops the start", async () => {
  const harness = createHarness();
  let calls = 0;
  const result = await harness.handler.start(harness.baseParams, {
    beforeExecute: () => {
      calls += 1;
      throw new Error("External MCP privacy policy changed.");
    },
  }, { requiresApproval: true });
  assert.deepEqual(result, { ok: false, error: "External MCP privacy policy changed." });
  assert.equal(calls, 1);
  assert.equal(harness.state.starts.length, 0);
});

test("a host that fails to start is reported per host; the others keep running", async () => {
  const harness = createHarness({
    start: (params) => (params.sessionId === "b"
      ? Promise.resolve({ ok: false, error: "Session is closing." })
      : Promise.resolve({ ok: true, jobId: `job-${params.sessionId}`, status: "running" })),
  });
  const result = await harness.handler.start(harness.baseParams, {}, { requiresApproval: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { running: 2, not_started: 1 });
  assert.deepEqual(result.jobs[1], { sessionId: "b", label: "web2", status: "not_started", error: "Session is closing." });
  // The bulkId only names the jobs that exist.
  assert.deepEqual(harness.handler._bulkEntries.get(result.bulkId).jobs.map((job) => job.jobId), ["job-a", "job-c"]);
});

test("when no job starts at all the call fails and no bulkId is created", async () => {
  const harness = createHarness({
    start: (params) => (params.sessionId === "a"
      ? Promise.reject(new Error("worker gone"))
      : Promise.resolve({ ok: false, error: "Shell prompt is not ready; no command was sent" })),
  });
  const result = await harness.handler.start(harness.baseParams, {}, { requiresApproval: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, "BULK_NOT_STARTED");
  assert.match(result.error, /^No background job was started\.\n- a \(web1\): worker gone\n- b \(web2\): Shell prompt is not ready/);
  assert.equal(harness.handler._bulkEntries.size, 0);
  assert.equal(harness.pending.size, 0);
});

// ── poll ──

async function startedHarness(options = {}) {
  const harness = createHarness(options);
  const started = await harness.handler.start(harness.baseParams, {}, { requiresApproval: false });
  assert.equal(started.ok, true);
  const jobIds = started.jobs.map((job) => job.jobId);
  return { ...harness, started, jobIds };
}

test("poll returns each job's status and new output since its offset", async () => {
  const harness = await startedHarness();
  const [jobA, jobB, jobC] = harness.jobIds;
  Object.assign(harness.jobs.get(jobA), { stdout: "line1\nline2\n", totalOutputChars: 12 });
  Object.assign(harness.jobs.get(jobB), { stdout: "done\n", totalOutputChars: 5, status: "completed", exitCode: 0 });
  Object.assign(harness.jobs.get(jobC), { stdout: "E: failed\n", totalOutputChars: 10, status: "failed", exitCode: 100, error: "exit 100" });

  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1", offsets: JSON.stringify({ [jobA]: 6 }) });
  assert.equal(result.ok, true);
  assert.equal(result.bulkId, harness.started.bulkId);
  assert.equal(result.allCompleted, false);
  assert.deepEqual(result.counts, { running: 1, completed: 1, failed: 1 });
  assert.deepEqual(result.jobs[0], { jobId: jobA, sessionId: "a", label: "web1", status: "running", exitCode: null, nextOffset: 12, output: "line2\n" });
  assert.deepEqual(result.jobs[1], { jobId: jobB, sessionId: "b", label: "web2", status: "completed", exitCode: 0, nextOffset: 5, output: "done\n" });
  assert.equal(result.jobs[2].error, "exit 100");
  assert.equal(result.jobs[2].exitCode, 100);
});

test("poll keeps only the newest output per job and reports what it skipped", async () => {
  const harness = await startedHarness();
  const [jobA] = harness.jobIds;
  const big = "x".repeat(40_000) + "TAIL";
  Object.assign(harness.jobs.get(jobA), { stdout: big, totalOutputChars: big.length });
  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1" });
  const entry = result.jobs[0];
  assert.equal(entry.output.length, MAX_POLL_CHARS_PER_JOB);
  assert.ok(entry.output.endsWith("TAIL"));
  assert.equal(entry.skippedChars, big.length - MAX_POLL_CHARS_PER_JOB);
  assert.equal(entry.nextOffset, big.length, "nextOffset stays exact");

  // The next poll from nextOffset has nothing new and skips nothing.
  const again = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1", offsets: { [jobA]: entry.nextOffset } });
  assert.equal(again.jobs[0].output, "");
  assert.equal("skippedChars" in again.jobs[0], false);
});

test("poll counts output dropped from the job's kept window as skipped", async () => {
  const harness = await startedHarness();
  const [jobA] = harness.jobIds;
  // The job kept only the last 100 chars of 1000 produced.
  Object.assign(harness.jobs.get(jobA), { stdout: "y".repeat(100), outputBaseOffset: 900, totalOutputChars: 1000, outputTruncated: true });
  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1", offsets: { [jobA]: 400 } });
  assert.equal(result.jobs[0].output, "y".repeat(100));
  assert.equal(result.jobs[0].skippedChars, 500);
});

test("progress redraws are collapsed and offsets stay on the raw output", async () => {
  const harness = await startedHarness();
  const [jobA] = harness.jobIds;
  const raw = "10%\r50%\r100%\ndone\n";
  Object.assign(harness.jobs.get(jobA), { stdout: raw, totalOutputChars: raw.length });
  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1" });
  assert.equal(result.jobs[0].output, "100%\ndone\n");
  assert.equal(result.jobs[0].nextOffset, raw.length);
});

test("the total poll budget is shared across jobs", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
  const harness = await startedHarness({ ids, labels: {} });
  for (const jobId of harness.jobIds) {
    const out = "z".repeat(20_000);
    Object.assign(harness.jobs.get(jobId), { stdout: out, totalOutputChars: out.length });
  }
  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1" });
  const perJob = Math.floor(MAX_POLL_TOTAL_CHARS / 20);
  assert.ok(perJob < MAX_POLL_CHARS_PER_JOB);
  assert.ok(result.jobs.every((job) => job.output.length === perJob));
  const total = result.jobs.reduce((sum, job) => sum + job.output.length, 0);
  assert.ok(total <= MAX_POLL_TOTAL_CHARS);
});

test("quiet jobs leave their share to busy jobs", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
  const harness = await startedHarness({ ids, labels: {} });
  harness.jobIds.forEach((jobId, index) => {
    const out = index < 2 ? "b".repeat(50_000) : "q".repeat(100);
    Object.assign(harness.jobs.get(jobId), { stdout: out, totalOutputChars: out.length });
  });
  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1" });
  // The two busy jobs get the full per-job cap, not 32 KB / 20.
  assert.equal(result.jobs[0].output.length, MAX_POLL_CHARS_PER_JOB);
  assert.equal(result.jobs[1].output.length, MAX_POLL_CHARS_PER_JOB);
  assert.equal(result.jobs[0].skippedChars, 50_000 - MAX_POLL_CHARS_PER_JOB);
  // Quiet jobs return all their new output and skip nothing.
  assert.ok(result.jobs.slice(2).every((job) => job.output.length === 100 && !("skippedChars" in job)));
  const total = result.jobs.reduce((sum, job) => sum + job.output.length, 0);
  assert.ok(total <= MAX_POLL_TOTAL_CHARS);
});

test("per-job problems are reported per job and never fail the poll", async () => {
  const harness = await startedHarness();
  const [jobA, jobB] = harness.jobIds;
  harness.jobs.delete(jobB);
  Object.assign(harness.jobs.get(jobA), { status: "completed", exitCode: 0 });
  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.jobs[1], { jobId: jobB, sessionId: "b", label: "web2", status: "unavailable", error: "Background job not found" });
  assert.deepEqual(result.counts, { completed: 1, unavailable: 1, running: 1 });
});

test("allCompleted is true once no job is running or stopping", async () => {
  const harness = await startedHarness();
  for (const jobId of harness.jobIds) Object.assign(harness.jobs.get(jobId), { status: "completed", exitCode: 0 });
  const result = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-1" });
  assert.equal(result.allCompleted, true);
});

test("poll accepts explicit jobIds and resolves their labels", async () => {
  const harness = await startedHarness();
  const result = await harness.handler.poll({ jobIds: JSON.stringify(harness.jobIds.slice(0, 2)), chatSessionId: "chat-1" });
  assert.equal(result.ok, true);
  assert.equal("bulkId" in result, false);
  assert.deepEqual(result.jobs.map((job) => job.label), ["web1", "web2"]);
});

test("a bulkId is only visible to the chat that created it", async () => {
  const harness = await startedHarness();
  const foreign = await harness.handler.poll({ bulkId: harness.started.bulkId, chatSessionId: "chat-2" });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /was not found/);
  const unknown = await harness.handler.stop({ bulkId: "bulk-nope", chatSessionId: "chat-1" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /was not found.*jobIds instead/);
  // Explicit jobIds still go through each job's own ownership check.
  const foreignJobs = await harness.handler.poll({ jobIds: JSON.stringify(harness.jobIds), chatSessionId: "chat-2" });
  assert.ok(foreignJobs.jobs.every((job) => job.status === "unavailable"));
});

// ── stop ──

test("stop stops every job of a bulkId and reports each one", async () => {
  const harness = await startedHarness();
  const [, jobB] = harness.jobIds;
  Object.assign(harness.jobs.get(jobB), { status: "completed", exitCode: 0 });
  const result = await harness.handler.stop({ bulkId: harness.started.bulkId, chatSessionId: "chat-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { stopping: 2, completed: 1 });
  assert.equal(result.jobs[1].status, "completed");
  assert.deepEqual(harness.state.stops.map((params) => [params.jobId, params.chatSessionId]), harness.jobIds.map((id) => [id, "chat-1"]));
});

test("stop reports missing jobs per job", async () => {
  const harness = await startedHarness();
  harness.jobs.clear();
  const result = await harness.handler.stop({ jobIds: JSON.stringify(harness.jobIds), chatSessionId: "chat-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { unavailable: 3 });
});

// ── bulkId registry ──

test("bulkIds expire after the jobs' lifetime and the registry stays bounded", async () => {
  const harness = await startedHarness();
  const { bulkId } = harness.started;
  harness.state.now += BULK_ENTRY_MAX_AGE_MS + 1;
  const expired = await harness.handler.poll({ bulkId, chatSessionId: "chat-1" });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);

  for (let i = 0; i < MAX_BULK_ENTRIES + 5; i++) {
    const started = await harness.handler.start(harness.baseParams, {}, { requiresApproval: false });
    assert.equal(started.ok, true);
  }
  assert.equal(harness.handler._bulkEntries.size, MAX_BULK_ENTRIES);
});
