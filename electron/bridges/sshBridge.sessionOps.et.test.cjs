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

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function makeApi(session, execOnEtSession, extra = {}) {
  const sessions = new Map([["et-1", session]]);
  return createSessionOpsApi({
    sessions,
    console,
    setTimeout,
    clearTimeout,
    execOnEtSession,
    quoteShellArg,
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

test("readRemoteHistory probes ET sessions and parses the detected shell", async () => {
  let command = "";
  const stdout = [
    "__NC_SHELL__zsh",
    "__NC_ZSH__",
    ": 1700000000:0;ls -la",
    ": 1700000100:0;pwd",
    "",
  ].join("\n");
  const api = makeApi(
    { type: "et", sshUserHost: "alice@example.test", sshOptions: [], sshEnv: {} },
    async (_session, cmd) => {
      command = cmd;
      return { success: true, stdout, stderr: "" };
    },
  );

  const result = await api.readRemoteHistory(null, { sessionId: "et-1", limit: 500 });

  assert.equal(result.success, true);
  assert.equal(result.shell, "zsh");
  assert.match(result.zsh, /ls -la/);
  assert.equal(result.bash, "");
  assert.equal(result.fish, "");
  assert.match(command, /^exec sh -c /);
  assert.doesNotMatch(command, /^SH=/);
  assert.match(command, /getent passwd/);
  assert.match(command, /case "\$SH" in/);
});

test("readRemoteHistory reads ~/.bash_history over an SSH exec channel", async () => {
  const stdout = ["__NC_SHELL__bash", "__NC_BASH__", "ls -la", "pwd", ""].join("\n");
  const api = makeApi({ conn: fakeConn(stdout) }, async () => {
    throw new Error("execOnEtSession should not be used for ssh sessions");
  });

  const result = await api.readRemoteHistory(null, { sessionId: "et-1" });

  assert.equal(result.success, true);
  assert.equal(result.shell, "bash");
  assert.match(result.bash, /ls -la/);
  assert.match(result.bash, /pwd/);
  assert.equal(result.zsh, "");
});

test("readRemoteHistory opens a Mosh stats companion when no conn exists", async () => {
  const stdout = ["__NC_SHELL__bash", "__NC_BASH__", "make build", "git status", ""].join("\n");
  const session = { type: "mosh", moshStatsAuth: { hostname: "h", password: "p" } };
  let ensureCalls = 0;
  const api = makeApi(
    session,
    async () => {
      throw new Error("execOnEtSession should not be used for mosh sessions");
    },
    {
      ensureMoshStatsConnection: async (s, id) => {
        ensureCalls += 1;
        assert.equal(s, session);
        assert.equal(id, "et-1");
        s.moshStatsConn = fakeConn(stdout);
        return s.moshStatsConn;
      },
    },
  );

  const result = await api.readRemoteHistory({ sender: {} }, { sessionId: "et-1" });

  assert.equal(ensureCalls, 1);
  assert.equal(session.conn, undefined);
  assert.equal(result.success, true);
  assert.equal(result.shell, "bash");
  assert.match(result.bash, /make build/);
  assert.match(result.bash, /git status/);
});

test("readRemoteHistory reuses an existing Mosh companion without reconnecting", async () => {
  const stdout = ["__NC_SHELL__zsh", "__NC_ZSH__", ": 1700000000:0;htop", ""].join("\n");
  const session = { type: "mosh", moshStatsConn: fakeConn(stdout), moshStatsAuth: { hostname: "h" } };
  const api = makeApi(
    session,
    async () => {
      throw new Error("execOnEtSession should not be used for mosh sessions");
    },
    {
      ensureMoshStatsConnection: async () => {
        throw new Error("should not reconnect when a companion already exists");
      },
    },
  );

  const result = await api.readRemoteHistory(null, { sessionId: "et-1" });

  assert.equal(result.success, true);
  assert.equal(result.shell, "zsh");
  assert.match(result.zsh, /htop/);
  assert.equal(session.conn, undefined);
});

test("readRemoteHistory reports pending while the Mosh handshake is still in progress", async () => {
  const session = { type: "mosh" };
  const api = makeApi(
    session,
    async () => {
      throw new Error("execOnEtSession should not be used for mosh sessions");
    },
    {
      ensureMoshStatsConnection: async () => null,
    },
  );

  const result = await api.readRemoteHistory(null, { sessionId: "et-1" });

  assert.equal(result.success, false);
  assert.equal(result.pending, true);
  assert.equal(session.conn, undefined);
});
