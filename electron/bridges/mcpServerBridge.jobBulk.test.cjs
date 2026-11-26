"use strict";

require("./cliDiscoveryTestIsolation.cjs").isolateCliDiscoveryFile();

const assert = require("node:assert/strict");
const test = require("node:test");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

/**
 * Bridge wired to a fake terminal worker that hosts the given sessions and runs
 * background jobs for them.
 */
function createBridge({ sessionIds = ["ssh-1", "ssh-2", "ssh-3"], refuse, chat = "chat-1", mode = "auto" } = {}) {
  const prechecks = [];
  const starts = [];
  const polls = [];
  const stops = [];
  const jobs = new Map();
  let nextJob = 0;
  const bridge = loadFreshBridge();
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      send() {},
      request(channel, payload) {
        if (channel === "netcatty:ai:jobStart") {
          if (payload.precheck === true) {
            prechecks.push(payload);
            const error = refuse?.(payload.sessionId, payload);
            return Promise.resolve(error ? { ok: false, error } : { ok: true });
          }
          starts.push(payload);
          const jobId = `wjob-${payload.sessionId}-${nextJob++}`;
          jobs.set(jobId, { sessionId: payload.sessionId, status: "running", output: `started ${payload.command}\n` });
          return Promise.resolve({ ok: true, jobId, sessionId: payload.sessionId, status: "running" });
        }
        if (channel === "netcatty:ai:jobPoll") {
          polls.push(payload);
          const job = jobs.get(payload.jobId);
          if (!job) return Promise.resolve({ ok: false, error: "Background job not found" });
          const total = job.output.length;
          const from = Math.min(Math.max(0, Number(payload.offset) || 0), total);
          return Promise.resolve({
            ok: true, jobId: payload.jobId, sessionId: job.sessionId, status: job.status,
            completed: job.status !== "running", exitCode: job.exitCode ?? null, error: null,
            output: job.output.slice(from), nextOffset: total, totalOutputChars: total, outputBaseOffset: 0,
          });
        }
        if (channel === "netcatty:ai:jobStop") {
          stops.push(payload);
          const job = jobs.get(payload.jobId);
          if (!job) return Promise.resolve({ ok: false, error: "Background job not found" });
          job.status = "stopping";
          return Promise.resolve({ ok: true, jobId: payload.jobId, sessionId: job.sessionId, status: "stopping", exitCode: null });
        }
        return Promise.reject(new Error(`unexpected worker request: ${channel}`));
      },
    },
  });
  bridge.setPermissionMode(mode);
  bridge.setCommandBlocklist([]);
  bridge.setCommandTimeout(30);
  bridge.updateSessionMetadata(
    sessionIds.map((sessionId, index) => ({
      sessionId,
      hostname: `host${index + 1}.example`,
      label: `web${index + 1}`,
      protocol: "ssh",
      connected: true,
    })),
    chat,
  );
  return { bridge, prechecks, starts, polls, stops, jobs, chat };
}

function captureApprovals(bridge) {
  const requests = [];
  bridge.setMainWindowGetter(() => ({
    isDestroyed: () => false,
    webContents: {
      id: 1,
      isDestroyed: () => false,
      send(channel, payload) {
        if (channel === "netcatty:ai:mcp:approval-request") requests.push(payload);
      },
    },
  }));
  return requests;
}

const startParams = (chatSessionId, overrides = {}) => ({
  command: "apt-get -y upgrade",
  sessionIds: '["ssh-1","ssh-2","ssh-3"]',
  chatSessionId,
  ...overrides,
});

test("netcatty/jobStartBulk prechecks every worker session, then starts one job per session", async () => {
  const { bridge, prechecks, starts, chat } = createBridge();
  const result = await bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));

  assert.equal(result.ok, true);
  assert.equal(typeof result.bulkId, "string");
  assert.deepEqual(result.counts, { running: 3 });
  assert.deepEqual(result.jobs.map((job) => [job.sessionId, job.label, job.status]), [
    ["ssh-1", "web1", "running"], ["ssh-2", "web2", "running"], ["ssh-3", "web3", "running"],
  ]);
  // Auto mode: the full precheck runs before anything starts, and every target passes it first.
  assert.equal(prechecks.length, 6, "a precheck before and after the (absent) prompt for each target");
  assert.ok(prechecks.every((payload) => payload.probe === undefined));
  assert.equal(starts.length, 3);
  assert.ok(starts.every((payload) => payload.precheck === undefined), "real starts are not prechecks");
});

test("any refused target starts nothing anywhere", async () => {
  const { bridge, starts, chat } = createBridge({
    refuse: (sessionId) => (sessionId === "ssh-2" ? "Background execution requires a writable PTY-backed terminal session." : null),
  });
  const result = await bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));
  assert.equal(result.ok, false);
  assert.match(result.error, /nothing was sent\. 1 of 3 targets/);
  assert.match(result.error, /- ssh-2 \(web2\): Background execution requires a writable PTY-backed terminal session\./);
  assert.equal(starts.length, 0);
});

test("observer mode refuses a bulk start", async () => {
  const { bridge, prechecks, starts, chat } = createBridge({ mode: "observer" });
  const result = await bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));
  assert.equal(result.ok, false);
  assert.match(result.error, /observer/);
  assert.equal(prechecks.length + starts.length, 0);
});

test("confirm mode asks once with a fresh approval and probes no host before it", async () => {
  const { bridge, prechecks, starts, chat } = createBridge({ mode: "confirm" });
  const approvals = captureApprovals(bridge);
  bridge.setPermissionGrants([
    { id: "g1", capabilityId: "terminal.startBulk", sessionPattern: "*", createdAt: Date.now() },
    { id: "g2", capabilityId: "terminal.start", sessionPattern: "*", createdAt: Date.now() },
  ]);

  const pending = bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));
  await tick();
  assert.equal(approvals.length, 1, "remembered grants never replace the prompt");
  assert.equal(approvals[0].toolName, "netcatty/jobStartBulk");
  assert.deepEqual(approvals[0].args, {
    command: "apt-get -y upgrade",
    sessions: ["ssh-1 (web1)", "ssh-2 (web2)", "ssh-3 (web3)"],
  });
  assert.equal(approvals[0].allowSession, false);
  assert.ok(prechecks.every((payload) => payload.probe === false), "no probe before approval");
  assert.equal(starts.length, 0);

  bridge.resolveApprovalFromRenderer(approvals[0].approvalId, true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(starts.length, 3);
});

test("a denied bulk start starts nothing and frees the sessions", async () => {
  const { bridge, starts, chat } = createBridge({ mode: "confirm" });
  const approvals = captureApprovals(bridge);
  const pending = bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));
  await tick();
  bridge.resolveApprovalFromRenderer(approvals[0].approvalId, false);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /denied/i);
  assert.equal(starts.length, 0);

  bridge.setPermissionMode("auto");
  const single = await bridge.dispatchBuiltinRpc("netcatty/jobStart", { sessionId: "ssh-1", command: "sleep 1", chatSessionId: chat });
  assert.equal(single.ok, true, "claims were released");
});

test("poll and stop by bulkId reach every worker job, without approval", async () => {
  const { bridge, polls, stops, jobs, chat } = createBridge({ mode: "confirm" });
  const approvals = captureApprovals(bridge);
  const pending = bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));
  await tick();
  bridge.resolveApprovalFromRenderer(approvals[0].approvalId, true);
  const started = await pending;
  assert.equal(started.ok, true);
  const [jobA, jobB] = started.jobs.map((job) => job.jobId);
  jobs.get(jobB).status = "completed";
  jobs.get(jobB).exitCode = 0;

  const polled = await bridge.dispatchBuiltinRpc("netcatty/jobPollBulk", {
    bulkId: started.bulkId,
    chatSessionId: chat,
    offsets: JSON.stringify({ [jobA]: 8 }),
  });
  assert.equal(polled.ok, true);
  assert.equal(polled.allCompleted, false);
  assert.deepEqual(polled.counts, { running: 2, completed: 1 });
  assert.equal(polled.jobs[0].output, "apt-get -y upgrade\n", "only output after the offset");
  assert.equal(polled.jobs[1].exitCode, 0);
  assert.ok(polls.length >= 3);

  const stopped = await bridge.dispatchBuiltinRpc("netcatty/jobStopBulk", { bulkId: started.bulkId, chatSessionId: chat });
  assert.equal(stopped.ok, true);
  assert.equal(stops.length, 3);
  assert.equal(approvals.length, 1, "poll and stop never ask");
});

test("stop works in observer mode, poll is a read", async () => {
  const { bridge, stops, chat } = createBridge();
  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));
  bridge.setPermissionMode("observer");
  assert.equal((await bridge.dispatchBuiltinRpc("netcatty/jobPollBulk", { bulkId: started.bulkId, chatSessionId: chat })).ok, true);
  assert.equal((await bridge.dispatchBuiltinRpc("netcatty/jobStopBulk", { bulkId: started.bulkId, chatSessionId: chat })).ok, true);
  assert.equal(stops.length, 3);
});

test("another chat cannot use the bulkId", async () => {
  const { bridge, chat } = createBridge();
  const started = await bridge.dispatchBuiltinRpc("netcatty/jobStartBulk", startParams(chat));
  const foreign = await bridge.dispatchBuiltinRpc("netcatty/jobPollBulk", { bulkId: started.bulkId, chatSessionId: "chat-2" });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /was not found/);
});
