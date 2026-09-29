"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  extractInteractivePwd,
  markInteractiveCommandBaseline,
  readInteractivePwd,
} = require("./singleChannelShell.cjs");

test("extractInteractivePwd accepts only a pwd path followed by a prompt", () => {
  assert.equal(
    extractInteractivePwd("pwd\r\n/root\r\n[root@host root]# "),
    "/root",
  );
  assert.equal(
    extractInteractivePwd("pwd\n/home/my docs\n[root@host docs]# "),
    "/home/my docs",
  );
});

test("extractInteractivePwd ignores a bare path and unrelated later output", () => {
  assert.equal(extractInteractivePwd("pwd\n/ro"), null);
  assert.equal(extractInteractivePwd("pwd\n/root\n"), null);
  assert.equal(extractInteractivePwd("answer=pwd\n/tmp\n[root@host tmp]# "), null);
});

function shell(tail, baselineTail) {
  const stream = new EventEmitter();
  stream.writable = true;
  const written = [];
  stream.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  const session = {
    singleChannelSsh: true,
    stream,
    _promptTrackTail: baselineTail,
    lastIdlePromptAt: 10,
  };
  markInteractiveCommandBaseline(session);
  session._promptTrackTail = tail;
  return { session, written };
}

test("readInteractivePwd does not feed pwd to a command still waiting for input", async () => {
  const waiting = shell("[user@host ~]# ", "[user@host ~]# ");
  const echoed = shell("[user@host ~]# cd /tmp; read answer", "[user@host ~]# ");

  const silent = await readInteractivePwd(waiting.session, { waitMs: 0, timeoutMs: 30 });
  const visible = await readInteractivePwd(echoed.session, { waitMs: 0, timeoutMs: 30 });

  assert.equal(silent, null);
  assert.equal(visible, null);
  assert.deepEqual(waiting.written, []);
  assert.deepEqual(echoed.written, []);
});

test("readInteractivePwd runs after a new prompt and ignores an unrelated path", async () => {
  const { session, written } = shell("[user@host /tmp]# ", "[user@host ~]# ");
  session.stream.write = (chunk) => {
    written.push(String(chunk));
    session.stream.emit("data", Buffer.from("answer=pwd\r\n/tmp\r\n[user@host tmp]# "));
    return true;
  };

  const cwd = await readInteractivePwd(session, { waitMs: 50, timeoutMs: 50 });

  assert.equal(cwd, null);
  assert.deepEqual(written, ["pwd\r"]);
});

test("readInteractivePwd returns the directory after the command prompt comes back", async () => {
  const { session, written } = shell("[user@host /tmp]# ", "[user@host ~]# ");
  session.stream.write = (chunk) => {
    written.push(String(chunk));
    session.stream.emit("data", Buffer.from("pwd\r\n/tmp\r\n[user@host tmp]# "));
    return true;
  };

  const cwd = await readInteractivePwd(session, { waitMs: 50, timeoutMs: 50 });

  assert.equal(cwd, "/tmp");
  assert.deepEqual(written, ["pwd\r"]);
});
