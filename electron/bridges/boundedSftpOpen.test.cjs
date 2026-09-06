"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const { openBoundedSftpChannel } = require("./boundedSftpOpen.cjs");

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

function createChannel() {
  const channel = new EventEmitter();
  channel.endCalls = 0;
  channel.closeCalls = 0;
  channel.end = () => { channel.endCalls += 1; };
  channel.close = () => { channel.closeCalls += 1; };
  return channel;
}

test("bounded SFTP open times out and closes a late channel", async () => {
  let callback;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const sshClient = {
    sftp(next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const result = openBoundedSftpChannel(sshClient, { timeoutMs: 5, ...timers });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  await assert.rejects(result, (error) => error.code === "SFTP_CHANNEL_OPEN_TIMEOUT");
  assert.equal(invalidations, 0, "one channel request must not destroy the shared SSH transport");
  assert.equal(timers.active.size, 0);

  const channel = createChannel();
  callback(null, channel);
  assert.ok(channel.endCalls > 0 || channel.closeCalls > 0);
  assert.equal(timers.active.size, 0);
});

test("bounded SFTP open cancellation settles immediately and closes a late channel", async () => {
  let callback;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const controller = new AbortController();
  const sshClient = {
    sftp(next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const result = openBoundedSftpChannel(sshClient, {
    signal: controller.signal,
    ...timers,
  });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.equal(invalidations, 0, "one channel request must not destroy the shared SSH transport");
  assert.equal(timers.active.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  const channel = createChannel();
  callback(new Error("late open failure"), channel);
  assert.ok(channel.endCalls > 0 || channel.closeCalls > 0);
  assert.equal(timers.active.size, 0);
});

for (const reason of ["timeout", "cancel"]) {
  test(`abandoned ${reason} opens cannot accumulate requests on a shared transport`, async () => {
    const callbacks = [];
    let physicalCloses = 0;
    const sshClient = new EventEmitter();
    sshClient.sftp = callback => { callbacks.push(callback); };
    sshClient.end = sshClient.destroy = () => { physicalCloses++; };
    const controller = new AbortController();
    const opening = openBoundedSftpChannel(sshClient, { timeoutMs: 5, signal: controller.signal });
    if (reason === "cancel") controller.abort(new Error("cancelled"));
    await assert.rejects(opening);
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(openBoundedSftpChannel(sshClient, { timeoutMs: 5 }));
    }
    assert.equal(callbacks.length, 1, "retries must not allocate more abandoned SSH channel requests");
    assert.equal(physicalCloses, 0, "existing terminal and SFTP channels remain connected");

    const late = createChannel();
    callbacks[0](null, late);
    assert.ok(late.endCalls > 0 || late.closeCalls > 0);
    const next = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
    assert.equal(callbacks.length, 2, "a settled abandoned request must release admission");
    const healthy = createChannel();
    callbacks[1](null, healthy);
    assert.equal(await next, healthy);
    assert.equal(physicalCloses, 0);
  });
}

test("healthy SFTP channel openings remain parallel", async () => {
  const callbacks = [];
  const sshClient = { sftp(callback) { callbacks.push(callback); } };
  const first = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
  const second = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
  assert.equal(callbacks.length, 2);
  const channels = [createChannel(), createChannel()];
  callbacks.forEach((callback, index) => callback(null, channels[index]));
  assert.deepEqual(await Promise.all([first, second]), channels);
});

test("bounded SFTP open removes cancellation listeners after success and failure", async () => {
  for (const outcome of ["success", "error"]) {
    const controller = new AbortController();
    const timers = trackedTimerApi();
    let callback;
    const sshClient = { sftp(next) { callback = next; } };
    const result = openBoundedSftpChannel(sshClient, {
      signal: controller.signal,
      ...timers,
    });
    assert.equal(timers.active.size, 1);
    assert.equal([...timers.active][0].hasRef(), true);
    if (outcome === "success") callback(null, createChannel());
    else callback(new Error("open failed"));
    if (outcome === "success") assert.ok(await result);
    else await assert.rejects(result, /open failed/);
    assert.equal(timers.active.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("bounded SFTP open converts synchronous setup errors into rejections", async () => {
  const sshClient = { sftp() { throw new Error("sync failure"); } };
  await assert.rejects(openBoundedSftpChannel(sshClient), /sync failure/);
});

test("transport closure releases abandoned-open bookkeeping without a late callback", async () => {
  const sshClient = new EventEmitter();
  const callbacks = [];
  sshClient.sftp = callback => callbacks.push(callback);
  await assert.rejects(openBoundedSftpChannel(sshClient, { timeoutMs: 5 }));
  assert.equal(sshClient.listenerCount("close"), 1);
  sshClient.emit("close");
  assert.equal(sshClient.listenerCount("close"), 0);
  const next = openBoundedSftpChannel(sshClient, { timeoutMs: 50 });
  const channel = createChannel();
  callbacks[1](null, channel);
  assert.equal(await next, channel);
  const late = createChannel();
  callbacks[0](null, late);
  assert.ok(late.endCalls > 0);
});

test("all abandoned parallel opens must settle before admitting a new one", async () => {
  const sshClient = new EventEmitter();
  const callbacks = [];
  sshClient.sftp = callback => callbacks.push(callback);
  const first = openBoundedSftpChannel(sshClient, { timeoutMs: 5 });
  const second = openBoundedSftpChannel(sshClient, { timeoutMs: 5 });
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  assert.equal(sshClient.listenerCount("close"), 1);
  callbacks[0](new Error("first failed"));
  await assert.rejects(openBoundedSftpChannel(sshClient), error => error.code === "SFTP_CHANNEL_OPEN_PENDING");
  callbacks[1](new Error("second failed"));
  assert.equal(sshClient.listenerCount("close"), 0);
  const next = openBoundedSftpChannel(sshClient);
  callbacks[2](null, createChannel());
  await next;
});
