const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createSessionOpsApi } = require("./sessionOps.cjs");

// A fake ssh2 exec stream that emits the canned stdout then closes.
function fakeStream(stdout) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) stream.emit("data", Buffer.from(stdout));
    stream.emit("close", 0);
  });
  return stream;
}

// A fake connection whose exec() always returns the same canned Linux stats
// line so getServerStats parses a successful result.
function fakeConn(stdout) {
  return {
    exec(_command, cb) {
      cb(null, fakeStream(stdout));
    },
  };
}

// Minimal Linux stats payload: enough for the parser to report success
// (memTotal present). CPU needs two samples for a delta, which is fine — the
// success gate only requires cpu OR memTotal OR cpuCores to be non-null.
const LINUX_STATS =
  "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:|NET:";
const MACOS_STATS =
  "NC_LATENCY_MARK|CPU:27|CORES:10|MEMINFO:32768 4096 0 8192 2048 1536|PROCS:123;1.2;Finder|DISKS:/:120:460:26|NET:en0:1000:3000";

function makeSessionOps(sessions) {
  return createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    // The rest of the sessionOps surface isn't exercised by getServerStats.
  });
}

test("getServerStats opens a Mosh stats companion connection when session.conn is missing", async () => {
  const sessions = new Map();
  const session = { type: "mosh", moshStatsAuth: { hostname: "h", password: "p" } };
  sessions.set("sid", session);

  let ensureCalls = 0;
  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    ensureMoshStatsConnection: async (s, id) => {
      ensureCalls += 1;
      assert.equal(s, session);
      assert.equal(id, "sid");
      // Simulate a successful companion connection. The real helper stores it
      // on moshStatsConn (NOT conn) so it stays invisible to other bridges.
      s.moshStatsConn = fakeConn(LINUX_STATS);
      return s.moshStatsConn;
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(ensureCalls, 1);
  // session.conn must remain unset — only moshStatsConn carries the companion.
  assert.equal(session.conn, undefined);
  assert.equal(result.success, true);
  assert.equal(result.stats.memTotal, 8000);
  assert.equal(result.stats.cpuCores, 4);
  assert.equal(typeof result.stats.latencyMs, "number");
});

test("getServerStats fails gracefully when the companion connection cannot be established", async () => {
  const sessions = new Map();
  const session = { type: "mosh", moshStatsAuth: { hostname: "h" } };
  sessions.set("sid", session);

  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    ensureMoshStatsConnection: async () => null, // no usable auth, etc.
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, false);
  assert.match(result.error, /not connected/);
});

test("getServerStats does not touch the companion path for a normal SSH session", async () => {
  const sessions = new Map();
  const session = { type: "ssh", conn: fakeConn(LINUX_STATS) };
  sessions.set("sid", session);

  let ensureCalls = 0;
  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    ensureMoshStatsConnection: async () => {
      ensureCalls += 1;
      return null;
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(ensureCalls, 0);
  assert.equal(result.success, true);
});

test("getServerStats includes host identity, load average, and uptime", async () => {
  const sessions = new Map();
  const session = {
    type: "ssh",
    conn: fakeConn(
      "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:/:20:80:25|NET:eth0:1000:2000|HOST:demo-box|OS:Ubuntu 24.04 LTS|KERNEL:6.8.0|UPTIME:12345|LOAD:0.10 0.20 0.30",
    ),
  };
  sessions.set("sid", session);

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.hostname, "demo-box");
  assert.equal(result.stats.osName, "Ubuntu 24.04 LTS");
  assert.equal(result.stats.kernelRelease, "6.8.0");
  assert.equal(result.stats.uptimeSeconds, 12345);
  assert.deepEqual(result.stats.loadAverage, [0.1, 0.2, 0.3]);
});

test("getServerStats keeps blank load average and uptime as missing data", async () => {
  const sessions = new Map();
  const session = {
    type: "ssh",
    conn: fakeConn(
      "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:|NET:|UPTIME:|LOAD:",
    ),
  };
  sessions.set("sid", session);

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.uptimeSeconds, null);
  assert.deepEqual(result.stats.loadAverage, []);
});

test("getServerStats parses macOS stats and avoids blocking top command", async () => {
  const sessions = new Map();
  let command = "";
  const session = {
    type: "ssh",
    conn: {
      exec(cmd, cb) {
        command = cmd;
        cb(null, fakeStream(MACOS_STATS));
      },
    },
  };
  sessions.set("sid", session);

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.match(command, /Darwin/);
  assert.match(command, /ps -A -o %cpu=/);
  assert.match(command, /awk -v c="\$cores"/);
  assert.match(command, /s=s\/c/);
  assert.doesNotMatch(command, /top -l/);
  assert.equal(result.stats.cpu, 27);
  assert.equal(result.stats.cpuCores, 10);
  assert.equal(result.stats.memTotal, 32768);
  assert.equal(result.stats.memUsed, 20480);
  assert.equal(result.stats.diskPercent, 26);
  assert.equal(result.stats.netInterfaces.length, 1);
  assert.equal(result.stats.netInterfaces[0].name, "en0");
  assert.equal(result.stats.netInterfaces[0].rxBytes, 1000);
  assert.equal(result.stats.netInterfaces[0].txBytes, 3000);
  assert.equal(typeof result.stats.latencyMs, "number");
});

test("getServerStats reports pending (not a hard failure) for a Mosh session before the handshake swap", async () => {
  const sessions = new Map();
  // Connected (renderer polls) but moshStatsAuth not yet assigned.
  const session = { type: "mosh" };
  sessions.set("sid", session);

  let ensureCalls = 0;
  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    ensureMoshStatsConnection: async () => {
      ensureCalls += 1;
      return null; // nothing to connect with yet
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(ensureCalls, 1);
  assert.equal(result.success, false);
  // pending must be set so the renderer doesn't count this toward give-up.
  assert.equal(result.pending, true);
});

test("getServerStats reports a hard failure (not pending) once the companion permanently failed", async () => {
  const sessions = new Map();
  // moshStatsAuth present but the companion has permanently failed (e.g. auth
  // rejected) — this is a real failure, the renderer should be allowed to give
  // up.
  const session = { type: "mosh", moshStatsAuth: { hostname: "h" }, moshStatsConnFailed: true };
  sessions.set("sid", session);

  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    ensureMoshStatsConnection: async () => null,
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, false);
  assert.notEqual(result.pending, true);
});

test("getServerStats returns an error for an unknown session", async () => {
  const sessions = new Map();
  const api = makeSessionOps(sessions);

  const result = await api.getServerStats({ sender: {} }, { sessionId: "missing" });

  assert.equal(result.success, false);
});
