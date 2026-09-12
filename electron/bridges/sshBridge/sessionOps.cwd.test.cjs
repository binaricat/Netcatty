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
  const sessions = overrides.sessions || new Map([
    ["session-1", session],
    ...siblingSessions,
  ]);
  return createSessionOpsApi({
    sessions,
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

test("session cwd probe honors a caller-provided timeout budget", async () => {
  const timeouts = [];
  const session = {
    shellPid: "4242",
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(_command, callback) {
        callback(null, makePwdStream("/srv/project", "4242"));
      },
    },
  };
  const api = makeApi(session, [], {
    setTimeout(callback, timeoutMs) {
      timeouts.push(timeoutMs);
      return setTimeout(callback, timeoutMs);
    },
  });

  const result = await api.getSessionPwd(null, { sessionId: "session-1", timeoutMs: 1234 });

  assert.deepEqual(result, { success: true, cwd: "/srv/project" });
  assert.ok(timeouts.includes(1234));
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

test("cwd probe forces POSIX sh, captures sshd PPID, and keeps the watchdog", async () => {
  let command = "";
  const session = {
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(nextCommand, callback) {
        command = nextCommand;
        callback(null, makePwdStream("/home/alice/project", "3131"));
      },
    },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.deepEqual(result, { success: true, cwd: "/home/alice/project" });
  assert.ok(command.startsWith("exec sh -c "), command.slice(0, 80));
  assert.ok(command.includes("export NC_SSHD_PPID=$PPID"));
  assert.ok(command.includes("( sleep 5 &&"), "cwd watchdog bound must match the 5s default timeout");
  assert.ok(command.includes('kill -9 $nc_tree "$$"'));
  assert.ok(command.includes(") </dev/null >/dev/null 2>&1 & nc_watchdog_pid=$!"));
  assert.ok(command.includes('kill -9 $nc_kids "$nc_watchdog_pid"'));
  assert.ok(command.includes('find_login_shell "${NC_SSHD_PPID:-$PPID}"'));
});

test("immediate parked reconnect does not guess cwd from an exiting shell", async () => {
  let execCalls = 0;
  const session = {
    blockUntargetedCwdProbe: true,
    connRef: { count: 1 },
    stream: {},
    conn: { exec() { execCalls += 1; } },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.equal(result.success, false);
  assert.equal(execCalls, 0);
  assert.equal(session.shellPid, undefined);
});

test("parked reconnect recovers cwd only after the new shell is unambiguous", async () => {
  let scan = ["111", "222", "333"];
  let scanCalls = 0;
  let targetedPwdCalls = 0;
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(command, callback) {
        if (command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) {
          scanCalls += 1;
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          stream.close = () => {};
          callback(null, stream);
          setImmediate(() => {
            stream.emit("data", Buffer.from(`${scan.join("\n")}\n__NETCATTY_SHELL_SCAN_COMPLETE__\n`));
            stream.emit("close", 0);
          });
          return;
        }
        targetedPwdCalls += 1;
        assert.match(command, /TARGET_LOGIN=222/);
        callback(null, makePwdStream("/new/cwd", "222"));
      },
    },
  };
  const api = makeApi(session);

  const ambiguous = await api.getSessionPwd(null, {
    sessionId: "session-1",
  });
  assert.equal(ambiguous.success, false);
  assert.equal(session.shellPid, undefined);
  assert.equal(targetedPwdCalls, 0);

  scan = ["222"];
  const withoutAnotherCommand = await api.getSessionPwd(null, {
    sessionId: "session-1",
  });
  assert.equal(withoutAnotherCommand.success, false);
  assert.equal(scanCalls, 1, "an ambiguous attempt consumes its command/output signal");
  // A failed/ambiguous attempt consumes the command/output signal. A later
  // real command can safely authorize one new uniqueness check.
  session.allowCwdRecovery = true;
  const recovered = await api.getSessionPwd(null, {
    sessionId: "session-1",
  });
  assert.deepEqual(recovered, { success: true, cwd: "/new/cwd" });
  assert.equal(session.shellPid, "222");
  assert.equal(session.blockUntargetedCwdProbe, false);
  assert.equal(targetedPwdCalls, 1);
  assert.equal(scanCalls, 2);
});

test("parked reconnect never binds a scan that only sees the old shell", async () => {
  let targetedPwdCalls = 0;
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(command, callback) {
        if (!command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) {
          targetedPwdCalls += 1;
          return;
        }
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => {};
        callback(null, stream);
        setImmediate(() => {
          stream.emit("data", Buffer.from("111\n__NETCATTY_SHELL_SCAN_COMPLETE__\n"));
          stream.emit("close", 0);
        });
      },
    },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.equal(result.success, false);
  assert.equal(session.shellPid, undefined);
  assert.equal(targetedPwdCalls, 0);
});

test("parked reconnect with an unknown old shell remains fail closed", async () => {
  let execCalls = 0;
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: [], hasUnknownOldShell: true },
    connRef: { count: 1 },
    stream: {},
    conn: { exec() { execCalls += 1; } },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.equal(result.success, false);
  assert.equal(execCalls, 0);
  assert.equal(session.shellPid, undefined);
});

test("parked reconnect does not scan while another terminal shares the transport", async () => {
  let execCalls = 0;
  const connRef = { count: 2, shellCloseGeneration: 0 };
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn: { exec() { execCalls += 1; } },
  };
  const api = makeApi(session, [["session-2", { connRef, stream: {} }]]);

  const result = await api.getSessionPwd(null, { sessionId: "session-1" });

  assert.equal(result.success, false);
  assert.equal(execCalls, 0);
  assert.equal(session.shellPid, undefined);
});

test("a shell close during recovery invalidates the PID scan result", async () => {
  let scanStream;
  let targetedPwdCalls = 0;
  const connRef = {
    count: 1,
    shellCloseGeneration: 0,
    closedShellPids: new Set(),
    closedShellPidUnknown: false,
  };
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn: {
      exec(command, callback) {
        if (!command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) {
          targetedPwdCalls += 1;
          return;
        }
        scanStream = new EventEmitter();
        scanStream.stderr = new EventEmitter();
        scanStream.close = () => {};
        callback(null, scanStream);
      },
    },
  };
  const api = makeApi(session);

  const pending = api.getSessionPwd(null, { sessionId: "session-1" });
  connRef.shellCloseGeneration += 1;
  connRef.closedShellPids.add("333");
  scanStream.emit("data", Buffer.from("333\n__NETCATTY_SHELL_SCAN_COMPLETE__\n"));
  scanStream.emit("close", 0);
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(targetedPwdCalls, 0);
  assert.equal(session.shellPid, undefined);
});

test("concurrent cwd recovery uses one scan and one targeted probe", async () => {
  let scanCalls = 0;
  let targetedPwdCalls = 0;
  const connRef = { count: 1, shellCloseGeneration: 0 };
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn: {
      exec(command, callback) {
        if (command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) {
          scanCalls += 1;
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          stream.close = () => {};
          callback(null, stream);
          setImmediate(() => {
            stream.emit("data", Buffer.from("222\n__NETCATTY_SHELL_SCAN_COMPLETE__\n"));
            stream.emit("close", 0);
          });
          return;
        }
        targetedPwdCalls += 1;
        callback(null, makePwdStream("/new/cwd", "222"));
      },
    },
  };
  const api = makeApi(session);

  const [left, right] = await Promise.all([
    api.getSessionPwd(null, { sessionId: "session-1" }),
    api.getSessionPwd(null, { sessionId: "session-1" }),
  ]);

  assert.deepEqual(left, { success: true, cwd: "/new/cwd" });
  assert.deepEqual(right, left);
  assert.equal(scanCalls, 1);
  assert.equal(targetedPwdCalls, 1);
});

test("a late cwd request joins recovery after PID scan but before targeted pwd completes", async () => {
  let scanCalls = 0;
  let targetedPwdCalls = 0;
  let targetedStream;
  const connRef = { count: 1, shellCloseGeneration: 0 };
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn: {
      exec(command, callback) {
        if (command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) {
          scanCalls += 1;
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          stream.close = () => {};
          callback(null, stream);
          setImmediate(() => {
            stream.emit("data", Buffer.from("222\n__NETCATTY_SHELL_SCAN_COMPLETE__\n"));
            stream.emit("close", 0);
          });
          return;
        }
        targetedPwdCalls += 1;
        targetedStream = new EventEmitter();
        targetedStream.stderr = new EventEmitter();
        targetedStream.close = () => {};
        callback(null, targetedStream);
      },
    },
  };
  const api = makeApi(session);

  const first = api.getSessionPwd(null, { sessionId: "session-1" });
  while (!targetedStream) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.shellPid, undefined, "candidate PID stays private until pwd succeeds");
  const late = api.getSessionPwd(null, { sessionId: "session-1" });
  assert.equal(scanCalls, 1);
  assert.equal(targetedPwdCalls, 1);

  targetedStream.emit("data", Buffer.from("/new/cwd\n"));
  targetedStream.stderr.emit("data", Buffer.from("NETCATTY_LOGIN_PID=222\n"));
  targetedStream.emit("close", 0);
  const [left, right] = await Promise.all([first, late]);

  assert.deepEqual(left, { success: true, cwd: "/new/cwd" });
  assert.deepEqual(right, left);
  assert.equal(session.shellPid, "222");
  assert.equal(scanCalls, 1);
  assert.equal(targetedPwdCalls, 1);
});

test("targeted recovery ignores cwd returned after the session is replaced", async () => {
  let targetedStream;
  const connRef = { count: 1, shellCloseGeneration: 0 };
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn: {
      exec(command, callback) {
        if (command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) {
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          stream.close = () => {};
          callback(null, stream);
          setImmediate(() => {
            stream.emit("data", Buffer.from("222\n__NETCATTY_SHELL_SCAN_COMPLETE__\n"));
            stream.emit("close", 0);
          });
          return;
        }
        targetedStream = new EventEmitter();
        targetedStream.stderr = new EventEmitter();
        targetedStream.close = () => {};
        callback(null, targetedStream);
      },
    },
  };
  const sessions = new Map([["session-1", session]]);
  const api = makeApi(session, [], { sessions });
  const pending = api.getSessionPwd(null, { sessionId: "session-1" });
  while (!targetedStream) await new Promise((resolve) => setImmediate(resolve));

  const replacement = { conn: session.conn, connRef, stream: {} };
  sessions.set("session-1", replacement);
  targetedStream.emit("data", Buffer.from("/old/cwd\n"));
  targetedStream.stderr.emit("data", Buffer.from("NETCATTY_LOGIN_PID=222\n"));
  targetedStream.emit("close", 0);
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(replacement.shellPid, undefined);
  assert.equal(session.shellPid, undefined);
});

test("a sibling close during targeted pwd invalidates the recovery result", async () => {
  let targetedStream;
  const connRef = {
    count: 1,
    shellCloseGeneration: 0,
    closedShellPids: new Set(),
    closedShellPidUnknown: false,
  };
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn: {
      exec(command, callback) {
        if (command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) {
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          stream.close = () => {};
          callback(null, stream);
          setImmediate(() => {
            stream.emit("data", Buffer.from("222\n__NETCATTY_SHELL_SCAN_COMPLETE__\n"));
            stream.emit("close", 0);
          });
          return;
        }
        targetedStream = new EventEmitter();
        targetedStream.stderr = new EventEmitter();
        targetedStream.close = () => {};
        callback(null, targetedStream);
      },
    },
  };
  const sessions = new Map([["session-1", session]]);
  const api = makeApi(session, [], { sessions });
  const pending = api.getSessionPwd(null, { sessionId: "session-1" });
  while (!targetedStream) await new Promise((resolve) => setImmediate(resolve));

  // A second shell opened and closed while targeted pwd was pending. Its local
  // session is gone again, but the close generation proves the terminal set
  // changed and the candidate can no longer be committed safely.
  connRef.shellCloseGeneration += 1;
  connRef.closedShellPids.add("222");
  targetedStream.emit("data", Buffer.from("/closed-sibling/cwd\n"));
  targetedStream.stderr.emit("data", Buffer.from("NETCATTY_LOGIN_PID=222\n"));
  targetedStream.emit("close", 0);
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(session.shellPid, undefined);
  assert.equal(session.blockUntargetedCwdProbe, true);
  assert.notEqual(session.parkedReconnectRisk, null);
});

test("targeted recovery open timeout preserves and disables the shared transport", async () => {
  const timers = [];
  const setTimeoutFn = (callback) => {
    const timer = { callback, active: true };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutFn = (timer) => { if (timer) timer.active = false; };
  let execCalls = 0;
  let endCalls = 0;
  let destroyCalls = 0;
  const connRef = { count: 2, shellCloseGeneration: 0 };
  const conn = {
    end() { endCalls += 1; },
    destroy() { destroyCalls += 1; },
    exec(command, callback) {
      execCalls += 1;
      if (!command.includes("__NETCATTY_SHELL_SCAN_COMPLETE__")) return;
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      callback(null, stream);
      stream.emit("data", Buffer.from("222\n__NETCATTY_SHELL_SCAN_COMPLETE__\n"));
      stream.emit("close", 0);
    },
  };
  const session = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["111"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn,
  };
  const sessions = new Map([["session-1", session]]);
  const api = makeApi(session, [], {
    sessions,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });
  const pending = api.getSessionPwd(null, { sessionId: "session-1" });
  while (execCalls < 2) await Promise.resolve();

  sessions.delete("session-1");
  const openingTimer = timers.find((timer) => timer.active);
  assert.ok(openingTimer);
  openingTimer.callback();
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(connRef.cwdRecoveryDisabled, true);
  assert.equal(endCalls, 0);
  assert.equal(destroyCalls, 0);

  const replacement = {
    blockUntargetedCwdProbe: true,
    allowCwdRecovery: true,
    parkedReconnectRisk: { oldShellPids: ["222"], hasUnknownOldShell: false },
    connRef,
    stream: {},
    conn,
  };
  sessions.set("session-2", replacement);
  const replacementApi = createSessionOpsApi({
    sessions,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    quoteShellArg,
    log: () => {},
  });
  const retry = await replacementApi.getSessionPwd(null, { sessionId: "session-2" });
  assert.equal(retry.success, false);
  assert.equal(execCalls, 2, "disabled transport must not accumulate another hung open");
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

test("cwd probe keeps login-shell fallback when home fallback is disabled (#2886)", async () => {
  // After `sudo su`, the active shell cwd is often unreadable to the login-uid
  // exec channel. preferFreshBackend disables home guessing, but must still
  // fall back to the same-uid login shell cwd so terminal drag-drop SFTP
  // uploads land in a writable directory instead of failing closed.
  let command = "";
  const session = {
    shellPid: "4242",
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(nextCommand, callback) {
        command = nextCommand;
        callback(null, makePwdStream("/home/alice", "4242"));
      },
    },
  };
  const api = makeApi(session);

  const result = await api.getSessionPwd(null, {
    sessionId: "session-1",
    allowHomeFallback: false,
    allowLoginShellFallback: true,
  });

  assert.deepEqual(result, { success: true, cwd: "/home/alice" });
  assert.match(command, /ALLOW_HOME_FALLBACK=0/);
  assert.match(command, /ALLOW_LOGIN_FALLBACK=1/);
  assert.match(
    command,
    /if \[ -z "\$cwd" \] && \[ "\$pid" != "\$login" \] && \[ "\$ALLOW_LOGIN_FALLBACK" = "1" \]; then/,
  );
  assert.match(command, /\[ "\$ALLOW_HOME_FALLBACK" = "1" \] \|\| exit 1/);
});

test("cwd probe couples login-shell fallback to home fallback when unset", async () => {
  // captureInheritedCwd passes allowHomeFallback: false without opting into
  // login-shell fallback; the backend must keep ALLOW_LOGIN_FALLBACK=0 so a
  // failed active-shell probe fails closed and the caller can fall through to
  // lastCwd instead of inheriting the parent login shell directory after sudo.
  let command = "";
  const session = {
    shellPid: "4242",
    connRef: { count: 1 },
    stream: {},
    conn: {
      exec(nextCommand, callback) {
        command = nextCommand;
        callback(null, makePwdStream("/home/alice", "4242"));
      },
    },
  };
  const api = makeApi(session);

  await api.getSessionPwd(null, {
    sessionId: "session-1",
    allowHomeFallback: false,
  });

  assert.match(command, /ALLOW_HOME_FALLBACK=0/);
  assert.match(command, /ALLOW_LOGIN_FALLBACK=0/);
});
