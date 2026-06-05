const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createSessionOpsApi } = require("./sshBridge/sessionOps.cjs");

function fakeStream(stdout) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) stream.emit("data", Buffer.from(stdout));
    stream.emit("close", 0);
  });
  return stream;
}

function fakeConn(stdout) {
  return {
    exec(_command, cb) {
      cb(null, fakeStream(stdout));
    },
  };
}

const LINUX_STATS =
  "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:|NET:";

function makeApi(session, execOnEtSession, extra = {}) {
  const sessions = new Map([["et-1", session]]);
  return createSessionOpsApi({
    sessions,
    console,
    setTimeout,
    clearTimeout,
    execOnEtSession,
    iconv: { encodingExists: () => true },
    sessionEncodings: new Map(),
    resetSessionDecoders: () => {},
    ...extra,
  });
}

test("getSessionDistroInfo probes ET sessions through execOnEtSession", async () => {
  let command = "";
  const api = makeApi(
    { type: "et", sshUserHost: "alice@example.test", sshOptions: [], sshEnv: {} },
    async (_session, cmd) => {
      command = cmd;
      return { success: true, stdout: "NAME=Ubuntu\n", stderr: "" };
    },
  );

  const result = await api.getSessionDistroInfo(null, { sessionId: "et-1" });

  assert.equal(result.success, true);
  assert.equal(result.stdout, "NAME=Ubuntu\n");
  assert.match(command, /os-release/);
});

test("getServerStats opens an ET stats companion connection for direct ET sessions", async () => {
  const session = {
    type: "et",
    sshUserHost: "alice@example.test",
    sshOptions: [],
    sshEnv: {},
    etStatsAuth: { hostname: "example.test", username: "alice" },
  };
  let ensureCalls = 0;
  let execFallbackCalls = 0;
  const api = makeApi(
    session,
    async () => {
      execFallbackCalls += 1;
      return { success: true, stdout: LINUX_STATS, stderr: "" };
    },
    {
      ensureEtStatsConnection: async (s, id) => {
        ensureCalls += 1;
        assert.equal(s, session);
        assert.equal(id, "et-1");
        s.etStatsConn = fakeConn(LINUX_STATS);
        return s.etStatsConn;
      },
    },
  );

  const result = await api.getServerStats(null, { sessionId: "et-1" });

  assert.equal(ensureCalls, 1);
  assert.equal(execFallbackCalls, 0);
  assert.equal(session.conn, undefined);
  assert.equal(result.success, true);
  assert.equal(result.stats.memTotal, 8000);
  assert.equal(result.stats.cpuCores, 4);
});

test("getServerStats falls back to execOnEtSession for jumped ET sessions", async () => {
  let command = "";
  let ensureCalls = 0;
  const api = makeApi(
    {
      type: "et",
      sshUserHost: "alice@example.test",
      sshOptions: [],
      sshEnv: {},
      etStatsAuth: { hostname: "example.test", hasJumpHost: true },
    },
    async (_session, cmd) => {
      command = cmd;
      return { success: true, stdout: LINUX_STATS, stderr: "" };
    },
    {
      ensureEtStatsConnection: async () => {
        ensureCalls += 1;
        return null;
      },
    },
  );

  const result = await api.getServerStats(null, { sessionId: "et-1" });

  assert.equal(ensureCalls, 0);
  assert.match(command, /CPURAW|UNSUPPORTED_OS/);
  assert.equal(result.success, true);
  assert.equal(result.stats.memTotal, 8000);
});

test("getServerStats falls back to execOnEtSession when the direct ET companion is unavailable", async () => {
  let execFallbackCalls = 0;
  const api = makeApi(
    {
      type: "et",
      sshUserHost: "alice@example.test",
      sshOptions: [],
      sshEnv: {},
      etStatsAuth: { hostname: "example.test" },
      etStatsConnFailed: true,
    },
    async () => {
      execFallbackCalls += 1;
      return { success: true, stdout: LINUX_STATS, stderr: "" };
    },
    {
      ensureEtStatsConnection: async () => {
        throw new Error("should not retry failed companion");
      },
    },
  );

  const result = await api.getServerStats(null, { sessionId: "et-1" });

  assert.equal(execFallbackCalls, 1);
  assert.equal(result.success, true);
  assert.equal(result.stats.memTotal, 8000);
});
