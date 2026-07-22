const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createSessionOpsApi, decodeLsofFileName } = require("./sessionOps.cjs");

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

function makeApi(session, siblingSessions = [], overrides = {}) {
  return createSessionOpsApi({
    sessions: new Map([["session-1", session], ...siblingSessions]),
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout: overrides.clearTimeout || clearTimeout,
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
  assert.ok(command.includes("sub(/^.*\\//"));
  assert.ok(command.includes("$3 !~ /^\\?+$/"));
  assert.match(command, /LC_ALL=C lsof/);
  assert.equal(session.shellPid, "4242");
});

test("lsof cwd output decodes UTF-8 bytes and escaped control characters", () => {
  assert.equal(
    decodeLsofFileName("/tmp/\\xe4\\xb8\\xad\\xe6\\x96\\x87"),
    "/tmp/中文",
  );
  assert.equal(decodeLsofFileName("/tmp/line1\\nline2\\\\tail"), "/tmp/line1\nline2\\tail");
  assert.equal(decodeLsofFileName("/tmp/bad\\xQZ"), null);
  assert.equal(decodeLsofFileName("/tmp/control-^G-name"), null);
});

test("macOS ps shell names and multi-character no-tty markers classify correctly", () => {
  const awk = String.raw`
    function isshell(c) { sub(/^.*\//, "", c); sub(/^-/, "", c); return c ~ /^(ba|z|fi|k|da|a|c|tc)?sh$/ }
    isshell($4) { print $1, ($3 !~ /^\?+$/ ? "tty" : "no-tty") }
  `;
  const { spawnSync } = require("node:child_process");
  const result = spawnSync("awk", [awk], {
    input: "4242 100 ttys001 /bin/zsh\n4243 100 ?? /bin/sh\n",
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "4242 tty\n4243 no-tty\n");
});

test("session cwd probe decodes the marked lsof pathname", async () => {
  const session = {
    shellPid: "4242",
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(_command, callback) {
        callback(null, makePwdStream(
          "NETCATTY_LSOF_CWD=/srv/\\xe4\\xb8\\xad\\xe6\\x96\\x87",
          "4242",
        ));
      },
    },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.deepEqual(result, { success: true, cwd: "/srv/中文" });
});

test("session cwd probe closes a remote command that exceeds its timeout", async () => {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  let closed = false;
  stream.close = () => { closed = true; };
  const session = {
    shellPid: "4242",
    connRef: { count: 1 },
    stream: {},
    conn: { exec(_command, callback) { callback(null, stream); } },
  };
  const api = makeApi(session, [], {
    setTimeout(callback) { setImmediate(callback); return 1; },
    clearTimeout() {},
  });

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.deepEqual(result, { success: false, error: "Timeout getting pwd" });
  assert.equal(closed, true);
});

test("session cwd probe closes a stream returned after its timeout", async () => {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  let closed = false;
  stream.close = () => { closed = true; };
  const session = {
    shellPid: "4242",
    connRef: { count: 1 },
    stream: {},
    conn: { exec(_command, callback) { setImmediate(() => callback(null, stream)); } },
  };
  const api = makeApi(session, [], {
    setTimeout(callback) { setImmediate(callback); return 1; },
    clearTimeout() {},
  });

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { success: false, error: "Timeout getting pwd" });
  assert.equal(closed, true);
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
