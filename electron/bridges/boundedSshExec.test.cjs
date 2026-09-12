"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  executeBoundedSshCommand,
  openBoundedSshExecStream,
} = require("./boundedSshExec.cjs");

function createStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closed = 0;
  stream.destroyed = 0;
  stream.signals = [];
  stream.signal = (name) => { stream.signals.push(name); };
  stream.close = () => { stream.closed += 1; };
  stream.destroy = () => { stream.destroyed += 1; };
  return stream;
}

function trackedTimerApi() {
  const active = new Set();
  return {
    active,
    setTimeoutFn(callback, delay) {
      let timer;
      timer = setTimeout(() => {
        active.delete(timer);
        callback();
      }, delay);
      active.add(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      clearTimeout(timer);
      active.delete(timer);
    },
  };
}

test("bounded SSH exec times out while opening and terminates a late stream", async () => {
  let callback;
  let endCalls = 0;
  let destroyCalls = 0;
  const timers = trackedTimerApi();
  const sshClient = {
    exec(_command, next) { callback = next; },
    end() { endCalls += 1; },
    destroy() { destroyCalls += 1; },
  };
  const result = executeBoundedSshCommand(sshClient, "true", {
    openingTimeoutMs: 5,
    ...timers,
  });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  await assert.rejects(result, (error) => error.code === "SSH_EXEC_OPEN_TIMEOUT");
  assert.equal(timers.active.size, 0);
  assert.ok(endCalls > 0 || destroyCalls > 0, "open timeout must invalidate the physical transport");

  const stream = createStream();
  callback(new Error("late open failure"), stream);
  assert.ok(stream.closed > 0 || stream.destroyed > 0);
  assert.equal(timers.active.size, 0);
});

test("best-effort SSH exec open timeout can preserve a shared transport", async () => {
  let callback;
  let endCalls = 0;
  let destroyCalls = 0;
  const sshClient = {
    exec(_command, next) { callback = next; },
    end() { endCalls += 1; },
    destroy() { destroyCalls += 1; },
  };
  await assert.rejects(
    executeBoundedSshCommand(sshClient, "true", {
      openingTimeoutMs: 2,
      invalidateOnOpenTimeout: false,
    }),
    (error) => error.code === "SSH_EXEC_OPEN_TIMEOUT",
  );
  assert.equal(endCalls, 0);
  assert.equal(destroyCalls, 0);

  const stream = createStream();
  callback(null, stream);
  assert.ok(stream.closed > 0 || stream.destroyed > 0);
});

test("bounded raw exec stream preserves options and invalidates a hung open", async () => {
  let callback;
  let receivedOptions;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const sshClient = {
    exec(_command, options, next) {
      receivedOptions = options;
      callback = next;
    },
    destroy() { invalidations += 1; },
  };

  const pending = openBoundedSshExecStream(
    sshClient,
    "sudo sftp-server",
    { pty: false },
    { openingTimeoutMs: 2, ...timers },
  );
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  await assert.rejects(pending, (error) => error.code === "SSH_EXEC_OPEN_TIMEOUT");
  assert.deepEqual(receivedOptions, { pty: false });
  assert.equal(invalidations, 1);
  assert.equal(timers.active.size, 0);

  const lateStream = createStream();
  callback(null, lateStream);
  assert.ok(lateStream.closed > 0 || lateStream.destroyed > 0);
  assert.equal(timers.active.size, 0);
});

test("bounded SSH exec times out a live command and removes data listeners", async () => {
  const stream = createStream();
  const timers = trackedTimerApi();
  const sshClient = { exec(_command, next) { next(null, stream); } };
  const result = executeBoundedSshCommand(sshClient, "sleep", {
    runTimeoutMs: 5,
    ...timers,
  });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  await assert.rejects(
    result,
    (error) => error.code === "SSH_EXEC_RUN_TIMEOUT",
  );
  assert.equal(timers.active.size, 0);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.stderr.listenerCount("data"), 0);
  assert.ok(stream.closed > 0 || stream.destroyed > 0);
  // Best-effort remote kill: servers that answer "signal" channel requests
  // stop the abandoned command instead of leaving it running (#3187).
  assert.deepEqual(stream.signals, ["KILL"]);
});

test("bounded SSH exec caps combined stdout and stderr and terminates the stream", async () => {
  const stream = createStream();
  const sshClient = { exec(_command, next) { next(null, stream); } };
  const result = executeBoundedSshCommand(sshClient, "flood", { maxOutputBytes: 16 });
  stream.emit("data", Buffer.alloc(10, 97));
  stream.stderr.emit("data", Buffer.alloc(10, 98));
  await assert.rejects(result, (error) => error.code === "SSH_EXEC_OUTPUT_LIMIT");
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.stderr.listenerCount("data"), 0);
  assert.ok(stream.closed > 0 || stream.destroyed > 0);
});

test("bounded SSH exec settles on stdout and stderr stream errors", async () => {
  for (const target of ["stdout", "stderr"]) {
    const stream = createStream();
    const sshClient = { exec(_command, next) { next(null, stream); } };
    const result = executeBoundedSshCommand(sshClient, "fail");
    const expected = new Error(`${target} failed`);
    if (target === "stdout") stream.emit("error", expected);
    else stream.stderr.emit("error", expected);
    await assert.rejects(result, /failed/);
    assert.equal(stream.listenerCount("data"), 0);
    assert.equal(stream.stderr.listenerCount("data"), 0);
  }
});

test("bounded SSH exec aborts before callback and terminates a late stream", async () => {
  let callback;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const controller = new AbortController();
  const sshClient = {
    exec(_command, next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const result = executeBoundedSshCommand(sshClient, "pending", {
    signal: controller.signal,
    ...timers,
  });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.equal(invalidations, 1);
  assert.equal(timers.active.size, 0);

  const stream = createStream();
  callback(null, stream);
  assert.ok(stream.closed > 0 || stream.destroyed > 0);
  assert.equal(timers.active.size, 0);
});

test("bounded SSH exec can abort a shared-channel probe without invalidating the transport", async () => {
  let invalidations = 0;
  const controller = new AbortController();
  const sshClient = {
    exec() {},
    destroy() { invalidations += 1; },
  };
  const result = executeBoundedSshCommand(sshClient, "probe", {
    signal: controller.signal,
    invalidateTransportOnAbort: false,
  });

  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.equal(invalidations, 0);
});

test("bounded SSH exec clears its run deadline after normal completion", async () => {
  const stream = createStream();
  const timers = trackedTimerApi();
  const sshClient = { exec(_command, next) { next(null, stream); } };
  const result = executeBoundedSshCommand(sshClient, "true", {
    runTimeoutMs: 1_000,
    ...timers,
  });

  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  stream.emit("close", 0);
  assert.deepEqual(await result, { stdout: "", stderr: "", code: 0 });
  assert.equal(timers.active.size, 0);
});

test("repeated unresponsive exec opens release channel callbacks and evict the shared transport", async () => {
  const {
    borrowTransport,
    createTransport,
    findTransportByEndpoint,
    getTransportStats,
    resetSshTransportRegistryForTests,
  } = require("./sshConnectionPool.cjs");
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const endpoint = { hostId: "host-1", hostname: "wedged.example", username: "root" };
  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn.pendingChannelCallbacks = [];
  conn.exec = (_command, callback) => {
    if (conn._sock.destroyed) throw new Error("Not connected");
    conn.pendingChannelCallbacks.push(callback);
  };
  conn.end = () => {};
  conn.destroy = () => {
    if (conn._sock.destroyed) return;
    conn._sock.destroyed = true;
    conn.pendingChannelCallbacks.length = 0;
    conn.emit("close");
  };
  const transport = createTransport({ conn, endpoint });
  borrowTransport(transport, { kind: "shell", holder: {} });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      executeBoundedSshCommand(conn, "stats", { openingTimeoutMs: 2 }),
      /timed out|Not connected/,
    );
  }

  assert.equal(conn.pendingChannelCallbacks.length, 0);
  assert.equal(getTransportStats().transports, 0);
  assert.equal(findTransportByEndpoint(endpoint), null);

  const replacement = new EventEmitter();
  replacement._sock = { destroyed: false };
  replacement.end = () => {};
  const replacementTransport = createTransport({ conn: replacement, endpoint });
  assert.equal(findTransportByEndpoint(endpoint), replacementTransport, "a fresh reconnect must be reusable");
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
});

test("bounded SSH exec preserves UTF-8 split across stream chunks", async () => {
  const stream = createStream();
  const sshClient = { exec(_command, next) { next(null, stream); } };
  const result = executeBoundedSshCommand(sshClient, "printf unicode");
  const bytes = Buffer.from("你🙂", "utf8");
  stream.emit("data", bytes.subarray(0, 2));
  stream.emit("data", bytes.subarray(2, 5));
  stream.emit("data", bytes.subarray(5));
  stream.emit("close", 0);

  assert.deepEqual(await result, { stdout: "你🙂", stderr: "", code: 0 });
});
