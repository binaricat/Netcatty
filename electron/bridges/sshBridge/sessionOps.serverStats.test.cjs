const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");

const { createSessionOpsApi } = require("./sessionOps.cjs");

// A fake ssh2 exec stream that emits the canned stdout then closes.
function fakeStream(stdout) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    if (stdout) stream.emit("data", Buffer.from(stdout));
    stream.emit("close", 0);
  };
  stream.write = () => true;
  setImmediate(send);
  return stream;
}

// A fake connection whose exec() always returns the same canned Linux stats
// line so getServerStats parses a successful result.
function fakeConn(stdout) {
  return {
    exec(command, cb) {
      const output = command.includes("NC_LATENCY_MARK") && !stdout.includes("NC_LATENCY_MARK")
        ? `NC_LATENCY_MARK|${stdout}`
        : stdout;
      cb(null, fakeStream(output));
    },
  };
}

// Minimal Linux stats payload: enough for the parser to report success
// (memTotal present). CPU needs two samples for a delta, which is fine — the
// success gate only requires cpu OR memTotal OR cpuCores to be non-null.
const LINUX_STATS =
  "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:|NET:";
const MACOS_STATS =
  "NC_LATENCY_MARK|CPU:27|CORES:10|MEMINFO:32768 4096 0 8192 2048 1536|PROCS:123;1.2;Finder|DISKS:/:120:460:26:apfs:/dev/disk3|NET:en0:1000:3000";

function makeSessionOps(sessions) {
  return createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    measureTcpConnectLatency: async () => 3,
    // The rest of the sessionOps surface isn't exercised by getServerStats.
  });
}

function runStatsCommandWithBusyBoxTools(command) {
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 4; }",
    "ps() { return 1; }",
    "top() {",
    "  printf '%s\\n' 'Mem: 256000K used, 768000K free, 0K shrd, 0K buff, 0K cached'",
    "  printf '%s\\n' 'CPU:   0% usr   0% sys   0% nic 100% idle   0% io   0% irq   0% sirq'",
    "  printf '%s\\n' '  PID  PPID USER     STAT   VSZ %VSZ %CPU COMMAND'",
    "  printf '%s\\n' '    1     0 root     S     2048   2%   3% /sbin/procd'",
    "}",
    "df() {",
    "  if [ \"$1\" = '-BG' ]; then return 1; fi",
    "  printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    "  printf '%s\\n' 'overlayfs:/overlay 1048576 262144 786432 25% /'",
    "  printf '%s\\n' '/dev/loop0 131072 131072 0 100% /snap/example/1'",
    "}",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

function runStatsCommandWithBusyBoxSmpTop(command) {
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 4; }",
    "ps() { return 1; }",
    "top() {",
    "  printf '%s\\n' 'Mem: 256000K used, 768000K free, 0K shrd, 0K buff, 0K cached'",
    "  printf '%s\\n' 'CPU:   0% usr   0% sys   0% nic 100% idle   0% io   0% irq   0% sirq'",
    "  printf '%s\\n' '  PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND'",
    "  printf '%s\\n' '    1     0 root     S     2048   2.0   0   3.0 /sbin/procd sh -c echo a,b|c'",
    "}",
    "df() { return 1; }",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

test("getServerStats falls back to BusyBox tools and excludes loop-backed images", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "router.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithBusyBoxTools(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.topProcesses, [
    { pid: "1", memPercent: 2, command: "/sbin/procd" },
  ]);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 0.25, total: 1, percent: 25, capacityKey: "overlayfs:/overlay" },
  ]);
  assert.equal(result.stats.diskPercent, 25);
});

test("getServerStats reads commands after BusyBox top's CPU column", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "router.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithBusyBoxSmpTop(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.topProcesses, [
    { pid: "1", memPercent: 2, command: "/sbin/procd" },
  ]);
});

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
    measureTcpConnectLatency: async () => 3,
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

test("getServerStats measures TCP connectivity instead of SSH protocol latency", async () => {
  const sessions = new Map();
  const session = {
    type: "mosh",
    hostname: "vm.example.test",
    moshStatsAuth: { hostname: "vm.example.test", port: 2222 },
    moshStatsConn: fakeConn(LINUX_STATS),
  };
  sessions.set("sid", session);

  const probes = [];
  const api = createSessionOpsApi({
    sessions,
    setTimeout,
    clearTimeout,
    Buffer,
    measureTcpConnectLatency: async (target) => {
      probes.push(target);
      return 2;
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.latencyMs, 2);
  assert.deepEqual(probes, [{ hostname: "vm.example.test", port: 2222 }]);
});

test("getServerStats skips a misleading direct probe for jump-host sessions", async () => {
  const sessions = new Map([["sid", {
    type: "mosh",
    moshStatsAuth: { hostname: "private.example.test", port: 22, hasJumpHost: true },
    moshStatsConn: fakeConn(LINUX_STATS),
  }]]);
  let probeCalls = 0;
  const api = createSessionOpsApi({
    sessions,
    setTimeout,
    clearTimeout,
    Buffer,
    measureTcpConnectLatency: async () => {
      probeCalls += 1;
      return 2;
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.latencyMs, null);
  assert.equal(probeCalls, 0);
});

test("getServerStats closes a blocked probe channel when stats time out", async () => {
  let fireTimeout;
  let closeCalls = 0;
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = () => true;
  stream.close = () => { closeCalls += 1; };
  const api = createSessionOpsApi({
    sessions: new Map([["sid", { type: "ssh", conn: { exec: (_command, cb) => cb(null, stream) } }]]),
    Date,
    setTimeout: (callback) => {
      fireTimeout = callback;
      return 1;
    },
    clearTimeout: () => {},
    Buffer,
  });

  const pending = api.getServerStats({ sender: {} }, { sessionId: "sid" });
  fireTimeout();
  const result = await pending;

  assert.equal(result.success, false);
  assert.match(result.error, /Timeout/);
  assert.equal(closeCalls, 1);
});

test("getServerStats closes a stats stream delivered after timeout", async () => {
  let execCallback;
  let fireTimeout;
  let closeCalls = 0;
  const api = createSessionOpsApi({
    sessions: new Map([["sid", {
      type: "ssh",
      conn: { exec: (_command, callback) => { execCallback = callback; } },
    }]]),
    Date,
    setTimeout: (callback) => {
      fireTimeout = callback;
      return 1;
    },
    clearTimeout: () => {},
    Buffer,
  });

  const pending = api.getServerStats({ sender: {} }, { sessionId: "sid" });
  fireTimeout();
  const result = await pending;
  const lateStream = new EventEmitter();
  lateStream.stderr = new EventEmitter();
  lateStream.close = () => { closeCalls += 1; };
  execCallback(null, lateStream);

  assert.equal(result.success, false);
  assert.equal(closeCalls, 1);
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
    _reuseEndpoint: { hostname: "mac.example.test", port: 22 },
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
  assert.match(command, /u=\(\$2-\$4\)\/1048576/);
  assert.doesNotMatch(command, /top -l/);
  assert.equal(result.stats.cpu, 27);
  assert.equal(result.stats.cpuCores, 10);
  assert.equal(result.stats.memTotal, 32768);
  assert.equal(result.stats.memUsed, 20480);
  assert.equal(result.stats.diskPercent, 26);
  assert.equal(result.stats.disks[0].capacityKey, "apfs:/dev/disk3");
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
