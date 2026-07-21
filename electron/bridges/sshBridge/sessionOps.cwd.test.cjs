const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createSessionOpsApi } = require("./sessionOps.cjs");

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function makePwdStream(cwd, loginPid) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {};
  setImmediate(() => {
    stream.emit("data", Buffer.from(`${cwd}\n`));
    stream.stderr.emit("data", Buffer.from(`NETCATTY_LOGIN_PID=${loginPid}\n`));
    stream.emit("close", 0);
  });
  return stream;
}

function makeApi(session, siblingSessions = []) {
  return createSessionOpsApi({
    sessions: new Map([["session-1", session], ...siblingSessions]),
    setTimeout,
    clearTimeout,
    quoteShellArg,
    log: () => {},
  });
}

test("shared terminal cwd probe refuses to guess without a shell pid", async () => {
  let execCalls = 0;
  const connRef = { count: 2 };
  const api = makeApi({
    connRef,
    stream: {},
    conn: {
      exec() { execCalls += 1; },
    },
  }, [["session-2", { connRef, stream: {} }]]);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.equal(result.success, false);
  assert.match(result.error, /ambiguous/);
  assert.equal(execCalls, 0);
});

test("shared terminal cwd probe targets the shell pid assigned to that tab", async () => {
  let command = "";
  const session = {
    shellPid: "4242",
    connRef: { count: 2 },
    stream: {},
    conn: {
      exec(nextCommand, callback) {
        command = nextCommand;
        callback(null, makePwdStream("/srv/copied-tab", "4242"));
      },
    },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.deepEqual(result, { success: true, cwd: "/srv/copied-tab" });
  assert.match(command, /TARGET_LOGIN=4242/);
  assert.equal(session.shellPid, "4242");
});

test("an unshared terminal remembers the shell pid discovered by its cwd probe", async () => {
  const session = {
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(_command, callback) {
        callback(null, makePwdStream("/home/alice/project", "3131"));
      },
    },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.deepEqual(result, { success: true, cwd: "/home/alice/project" });
  assert.equal(session.shellPid, "3131");
});

test("an SFTP reference does not make one terminal cwd ambiguous", async () => {
  const session = {
    connRef: { count: 2 },
    stream: {},
    conn: {
      exec(_command, callback) {
        callback(null, makePwdStream("/home/alice/project", "5151"));
      },
    },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.deepEqual(result, { success: true, cwd: "/home/alice/project" });
  assert.equal(session.shellPid, "5151");
});
