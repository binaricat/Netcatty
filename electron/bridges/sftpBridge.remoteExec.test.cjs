"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { _execRemoteShellCommandForTests: execRemoteShellCommand } = require("./sftpBridge.cjs");

function createRemoteStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closeCalls = 0;
  stream.destroyCalls = 0;
  stream.close = () => { stream.closeCalls += 1; };
  stream.destroy = () => { stream.destroyCalls += 1; };
  return stream;
}

test("remote delete exec times out while opening and closes a stream that arrives late", async () => {
  let callback;
  let invalidations = 0;
  const sshClient = {
    exec(_command, next) { callback = next; },
    destroy() { invalidations += 1; },
  };

  await assert.rejects(
    () => execRemoteShellCommand(sshClient, "rm -rf -- /tmp/example", {
      openingTimeoutMs: 10,
      runTimeoutMs: 100,
      maxOutputBytes: 64,
    }),
    /open timed out/i,
  );
  assert.equal(invalidations, 1);

  const lateStream = createRemoteStream();
  callback(null, lateStream);
  assert.ok(lateStream.closeCalls + lateStream.destroyCalls > 0);
});

test("remote delete exec has a running deadline and destroys the live stream", async () => {
  const stream = createRemoteStream();
  const sshClient = {
    exec(_command, next) { next(null, stream); },
  };

  await assert.rejects(
    () => execRemoteShellCommand(sshClient, "rm -rf -- /tmp/example", {
      openingTimeoutMs: 100,
      runTimeoutMs: 10,
      maxOutputBytes: 64,
    }),
    /execution timed out/i,
  );
  assert.ok(stream.closeCalls + stream.destroyCalls > 0);
});

test("remote delete exec cancellation closes a stream that arrives after cancellation", async () => {
  let callback;
  let invalidations = 0;
  const controller = new AbortController();
  const sshClient = {
    exec(_command, next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const pending = execRemoteShellCommand(sshClient, "rm -rf -- /tmp/example", {
    signal: controller.signal,
    openingTimeoutMs: 100,
    runTimeoutMs: 100,
    maxOutputBytes: 64,
  });

  controller.abort(new Error("cancelled by test"));
  await assert.rejects(() => pending, /cancelled by test/i);
  assert.equal(invalidations, 1);

  const lateStream = createRemoteStream();
  callback(null, lateStream);
  assert.ok(lateStream.closeCalls + lateStream.destroyCalls > 0);
});

test("remote delete exec rejects and closes the stream when output exceeds its hard limit", async () => {
  const stream = createRemoteStream();
  const sshClient = {
    exec(_command, next) {
      next(null, stream);
      queueMicrotask(() => stream.emit("data", Buffer.alloc(65, "x")));
    },
  };

  await assert.rejects(
    () => execRemoteShellCommand(sshClient, "rm -rf -- /tmp/example", {
      openingTimeoutMs: 100,
      runTimeoutMs: 100,
      maxOutputBytes: 64,
    }),
    /output exceeded/i,
  );
  assert.ok(stream.closeCalls + stream.destroyCalls > 0);
});

test("remote delete exec preserves split UTF-8 independently on stdout and stderr", async () => {
  const stream = createRemoteStream();
  const sshClient = {
    exec(_command, next) { next(null, stream); },
  };
  const running = execRemoteShellCommand(sshClient, "printf unicode", {
    openingTimeoutMs: 100,
    runTimeoutMs: 100,
    maxOutputBytes: 64,
  });
  const stdout = Buffer.from("中文", "utf8");
  const stderr = Buffer.from("错误", "utf8");
  stream.emit("data", stdout.subarray(0, 2));
  stream.stderr.emit("data", stderr.subarray(0, 1));
  stream.emit("data", stdout.subarray(2));
  stream.stderr.emit("data", stderr.subarray(1));
  stream.emit("close", 0);

  assert.deepEqual(await running, { stdout: "中文", stderr: "错误", code: 0 });
});

test("remote delete exec rejects before exposing a character cut by its byte limit", async () => {
  const stream = createRemoteStream();
  const sshClient = {
    exec(_command, next) { next(null, stream); },
  };
  const running = execRemoteShellCommand(sshClient, "printf unicode", {
    openingTimeoutMs: 100,
    runTimeoutMs: 100,
    maxOutputBytes: 2,
  });
  stream.emit("data", Buffer.from("中", "utf8"));

  await assert.rejects(running, (error) => (
    /output exceeded/i.test(error?.message || "") && !/�/u.test(error?.message || "")
  ));
  assert.ok(stream.closeCalls + stream.destroyCalls > 0);
});

test("remote extract exec drains stdout without treating progress as a hard limit", async () => {
  const stream = createRemoteStream();
  const sshClient = {
    exec(_command, next) { next(null, stream); },
  };
  const running = execRemoteShellCommand(sshClient, "unzip -qo archive.zip", {
    openingTimeoutMs: 100,
    runTimeoutMs: 100,
    maxOutputBytes: 8,
    discardStdout: true,
  });
  stream.emit("data", Buffer.alloc(64, "x"));
  stream.stderr.emit("data", Buffer.from("ok"));
  stream.emit("close", 0);

  assert.deepEqual(await running, { stdout: "", stderr: "ok", code: 0 });
});
