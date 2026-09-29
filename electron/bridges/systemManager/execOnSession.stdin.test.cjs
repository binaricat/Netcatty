"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createExecOnSessionApi } = require("./execOnSession.cjs");

test("execOnSession closes ssh exec stdin after writing provided input", async () => {
  const writes = [];
  let ended = false;
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = (data) => {
    writes.push(data);
    return true;
  };
  stream.end = () => {
    ended = true;
  };

  const conn = {
    exec(_command, callback) {
      callback(null, stream);
      process.nextTick(() => stream.emit("close", 0));
    },
  };
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ conn, type: "ssh" }) },
  });

  const result = await execApi.execOnSession(null, "s1", "sudo -S -p '' docker ps", 1000, {
    stdin: "secret\n",
  });

  assert.equal(result.success, true);
  assert.deepEqual(writes, ["secret\n"]);
  assert.equal(ended, true);
});

test("execOnSession reports local maxBuffer errors instead of returning truncated stdout", async () => {
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ type: "local", protocol: "local" }) },
    process,
  });

  const result = await execApi.execOnSession(null, "local", "yes x | head -c 2048", 1000, {
    maxBuffer: 128,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /maxBuffer|stdout maxBuffer/i);
});

test("execOnSession enforces maxBuffer for SSH streamed stdout", async () => {
  let closed = false;
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {
    closed = true;
  };

  const conn = {
    exec(_command, callback) {
      callback(null, stream);
      process.nextTick(() => {
        stream.emit("data", Buffer.from("x".repeat(256)));
        stream.emit("close", 0);
      });
    },
  };
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ conn, type: "ssh" }) },
  });

  const result = await execApi.execOnSession(null, "s1", "ps", 1000, {
    maxBuffer: 128,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /maxBuffer/i);
  assert.equal(result.stdout, "");
  assert.equal(closed, true);
});

test("execOnSession closes an SSH stream that arrives after the open timeout", async () => {
  let callback;
  const conn = { exec(_command, next) { callback = next; } };
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ conn, type: "ssh" }) },
  });

  const result = await execApi.execOnSession(null, "s1", "pending", 5);
  assert.equal(result.success, false);
  assert.match(result.error, /open timed out/);

  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  let closed = 0;
  stream.close = () => { closed += 1; };
  callback(null, stream);
  assert.ok(closed > 0);
});

test("execOnSession settles and releases listeners on SSH stream errors", async () => {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {};
  stream.destroy = () => {};
  const conn = { exec(_command, callback) { callback(null, stream); } };
  const execApi = createExecOnSessionApi({
    sessions: { get: () => ({ conn, type: "ssh" }) },
  });

  const pending = execApi.execOnSession(null, "s1", "fail", 1000);
  await new Promise((resolve) => setImmediate(resolve));
  stream.stderr.emit("error", new Error("remote stderr failed"));
  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.error, /stderr failed/);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.stderr.listenerCount("data"), 0);
});

test("execOnSession refuses extra channels when singleChannelSsh is set", async () => {
  let execCalls = 0;
  const execApi = createExecOnSessionApi({
    sessions: {
      get: () => ({
        conn: {
          _remoteVer: "CLOUDBILITY-4.14",
          exec() { execCalls += 1; },
        },
        type: "ssh",
        singleChannelSsh: true, remoteSshVersion: "CLOUDBILITY-4.14",
      }),
    },
  });

  const result = await execApi.execOnSession(null, "s1", "ps", 1000);

  assert.equal(result.success, false);
  assert.equal(result.code, "ERR_SINGLE_CHANNEL_BASTION");
  assert.equal(execCalls, 0);
});
