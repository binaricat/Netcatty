const test = require("node:test");
const assert = require("node:assert/strict");

const { createPtyOutputBuffer } = require("./ptyOutputBuffer.cjs");

/** Resolve after one event-loop turn (immediates have run). */
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await sleep(1);
  }
};

test("coalesces data buffered within the same turn into a single send", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("a");
  buffer.bufferData("b");
  buffer.bufferData("c");

  // Nothing is sent synchronously while still in the same turn.
  assert.equal(sends.length, 0);

  await tick();

  assert.deepEqual(sends, ["abc"]);
});

test("flushes within a single event-loop turn (not on a fixed delay)", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("x");

  // A fixed-interval (e.g. 8ms) buffer would NOT have flushed after one
  // immediate turn. Turn-based flushing must have delivered it by now.
  await tick();

  assert.deepEqual(sends, ["x"]);
});

test("paces size-cap flushes with a short flood delay", () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, ms) => {
    const timer = { callback, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  const sends = [];
  try {
    const buffer = createPtyOutputBuffer((data) => sends.push(data), {
      maxBufferSize: 4,
      floodFlushDelayMs: 5,
    });

    buffer.bufferData("ab");
    assert.equal(sends.length, 0); // under cap, still pending

    buffer.bufferData("cd"); // now "abcd" hits the 4-byte cap

    // Flood-sized output is paced instead of synchronously spamming IPC.
    assert.deepEqual(sends, []);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 5);

    timers[0].callback();
    assert.deepEqual(sends, ["abcd"]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("hard cap starts a paced drain instead of flushing a whole burst", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    floodFlushDelayMs: 1,
  });

  buffer.bufferData("1234567890abcdefgh");

  assert.deepEqual(sends, ["12345678"]);

  await waitFor(() => sends.length >= 3);
  assert.deepEqual(sends, ["12345678", "90abcdef", "gh"]);
});

test("single large accepted append obeys the total pending cap", async () => {
  const sends = [];
  const reports = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    maxPendingBytes: 16,
    floodFlushDelayMs: 1,
    onPendingBytesChange: (bytes) => reports.push(bytes),
  });

  buffer.bufferData("0123456789abcdefghij");

  assert.equal(reports.at(-1), 12);
  assert.deepEqual(sends, ["4567"]);

  await waitFor(() => sends.join("") === "456789abcdefghij");
  assert.deepEqual(sends, ["4567", "89abcdef", "ghij"]);
});

test("default hard cap keeps flood-sized renderer sends bounded", () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    floodFlushDelayMs: 50,
  });

  buffer.bufferData("abcd");
  buffer.bufferData("efgh");
  buffer.bufferData("ijkl");
  buffer.bufferData("mnop");

  assert.deepEqual(sends, ["abcdefghijklmnop"]);
});

test("flush() forces a synchronous send and cancels the pending turn", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("hello");
  buffer.flush();

  assert.deepEqual(sends, ["hello"]);

  await tick();
  assert.deepEqual(sends, ["hello"]); // not sent twice
});

test("flush() with an empty buffer does not send", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.flush();

  assert.equal(sends.length, 0);
});

test("discard() drops pending data and cancels the pending turn", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("tail");
  assert.equal(buffer.discard(), 4);

  assert.deepEqual(sends, []);
  await tick();
  assert.deepEqual(sends, []);
});

test("flushPaced callback clears paused backlog without materializing it", async () => {
  const sends = [];
  let drained = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    shouldAcceptOutput: () => false,
  });

  buffer.bufferData("1234567890abcdefgh");
  buffer.flushPaced(() => {
    drained = true;
  });

  assert.equal(buffer.discard(), 0);
  await sleep(5);

  assert.deepEqual(sends, []);
  assert.equal(drained, true);
});

test("takePending() returns pending data without sending it", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("tail");

  assert.equal(buffer.takePending(), "tail");
  assert.deepEqual(sends, []);
  await tick();
  assert.deepEqual(sends, []);
});

test("takePendingEntry() returns pending data with metadata", () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data, meta) => sends.push({ data, meta }), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    maxPendingBytes: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData(`\x1b[?1049h${"x".repeat(16)}tail`);

  const pending = buffer.takePendingEntry();

  assert.equal(pending.data.length, 8);
  assert.deepEqual(pending.meta, {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "enter",
  });
  assert.deepEqual(sends, []);
});

test("new unknown dropped-output risk clears stale alternate-screen action metadata", () => {
  const buffer = createPtyOutputBuffer(() => {});

  buffer.bufferData("first", {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "leave",
  });
  buffer.bufferData("second", {
    droppedOutputMayAffectTerminalState: true,
  });

  assert.deepEqual(buffer.takePendingEntry().meta, {
    droppedOutputMayAffectTerminalState: true,
  });
});

test("buffers incoming data while shouldAcceptOutput returns false", async () => {
  const sends = [];
  let accept = true;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("before");
  accept = false;
  buffer.bufferData("buffered");
  await tick();

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flush();

  assert.deepEqual(sends, ["beforebuffered"]);
});

test("flushes data buffered while output is not accepted in bounded chunks", async () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("1234");
  buffer.bufferData("5678");
  buffer.bufferData("90ab");
  await tick();

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flush();

  assert.deepEqual(sends, ["12345678", "90ab"]);
});

test("paused backlog keeps only the newest data after the total pending cap", async () => {
  const sends = [];
  const reports = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    maxPendingBytes: 16,
    shouldAcceptOutput: () => accept,
    onPendingBytesChange: (bytes) => reports.push(bytes),
  });

  buffer.bufferData("0123456789abcdefghij");
  await tick();

  assert.equal(reports.at(-1), 16);
  assert.deepEqual(sends, []);

  accept = true;
  buffer.flushPaced();
  await waitFor(() => sends.join("") === "456789abcdefghij");
  assert.deepEqual(sends, ["4567", "89abcdef", "ghij"]);
});

test("flushPaced releases paused backlog over multiple turns", async () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    floodFlushDelayMs: 1,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("1234567890abcdefgh");
  await tick();

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flushPaced();

  assert.deepEqual(sends, ["12345678"]);
  await waitFor(() => sends.length >= 3);

  assert.deepEqual(sends, ["12345678", "90abcdef", "gh"]);
});

test("fresh output does not cancel an active paced backlog drain", async () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    floodFlushDelayMs: 1,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("1234567890abcdefgh");
  await tick();

  accept = true;
  buffer.flushPaced();
  assert.deepEqual(sends, ["12345678"]);

  buffer.bufferData("NEW");
  assert.deepEqual(sends, ["12345678"]);

  await waitFor(() => sends.length >= 3);
  assert.deepEqual(sends, ["12345678", "90abcdef", "ghNEW"]);
});

test("fresh output during an active paced drain obeys the total pending cap", async () => {
  const sends = [];
  const reports = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    maxPendingBytes: 16,
    floodFlushDelayMs: 5,
    onPendingBytesChange: (bytes) => reports.push(bytes),
  });

  buffer.bufferData("0123456789abcdefghij");
  assert.deepEqual(sends, ["4567"]);

  buffer.bufferData("K".repeat(20));
  assert.equal(reports.at(-1), 16);
  assert.deepEqual(sends, ["4567"]);

  await waitFor(() => sends.join("") === `4567${"K".repeat(16)}`);
  assert.deepEqual(sends, ["4567", "KKKKKKKK", "KKKKKKKK"]);
});

test("flushPaced callback runs after the paced backlog drains", async () => {
  const sends = [];
  let drained = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    floodFlushDelayMs: 1,
  });

  buffer.bufferData("1234567890abcdefgh");
  buffer.flushPaced(() => {
    drained = true;
  });

  assert.equal(drained, false);
  assert.deepEqual(sends, ["12345678", "90abcdef"]);

  await waitFor(() => drained);
  assert.deepEqual(sends, ["12345678", "90abcdef", "gh"]);
});

test("flushPaced callback runs when output is paused by discarding pending data", async () => {
  const sends = [];
  const reports = [];
  let drained = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    shouldAcceptOutput: () => false,
    onPendingBytesChange: (bytes) => reports.push(bytes),
  });

  buffer.bufferData("1234567890abcdefgh");
  buffer.flushPaced(() => {
    drained = true;
  });

  assert.equal(drained, true);
  assert.deepEqual(sends, []);
  assert.equal(reports.at(-1), 0);
});

test("flushPaced callback runs if output pauses during a paced drain", async () => {
  const sends = [];
  const reports = [];
  let accept = false;
  let drained = false;
  const buffer = createPtyOutputBuffer((data) => {
    sends.push(data);
    accept = false;
  }, {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    floodFlushDelayMs: 1,
    shouldAcceptOutput: () => accept,
    onPendingBytesChange: (bytes) => reports.push(bytes),
  });

  buffer.bufferData("1234567890abcdefgh");
  accept = true;
  buffer.flushPaced(() => {
    drained = true;
  });

  assert.equal(drained, false);
  assert.deepEqual(sends, ["12345678"]);

  await waitFor(() => drained);

  assert.deepEqual(sends, ["12345678"]);
  assert.equal(reports.at(-1), 0);
  assert.equal(buffer.discard(), 0);
});

test("keeps a single paused append bounded before output is accepted", async () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("1234567890abcdefgh");
  await tick();

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flush();

  assert.deepEqual(sends, ["12345678", "90abcdef", "gh"]);
});

test("keeps batching after a flush", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("first");
  await tick();

  buffer.bufferData("second");
  await tick();

  assert.deepEqual(sends, ["first", "second"]);
});

test("pending cap marks next send when dropped output may affect terminal state", () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data, meta) => sends.push({ data, meta }), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    maxPendingBytes: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData(`\x1b[?1049h${"x".repeat(16)}tail`);

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flush();

  assert.equal(sends[0].meta?.droppedOutputMayAffectTerminalState, true);
  assert.equal(sends[0].meta?.droppedOutputAlternateScreenAction, "enter");
});

test("pending cap does not mark plain dropped output as terminal state risk", () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data, meta) => sends.push({ data, meta }), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    maxPendingBytes: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("abcdefghijklmnopqrstuv");

  accept = true;
  buffer.flush();

  assert.equal(sends[0].meta, undefined);
});

test("pending cap forwards dropped alternate-screen leave as recovery state", () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data, meta) => sends.push({ data, meta }), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    maxPendingBytes: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData(`\x1b[?1049ltail${"x".repeat(16)}`);

  accept = true;
  buffer.flush();

  assert.deepEqual(sends[0].meta, {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "leave",
  });
});

test("pending cap reports alternate-screen action split across dropped and retained bytes", () => {
  let accept = false;
  const buffer = createPtyOutputBuffer(() => {}, {
    maxBufferSize: 1,
    maxFloodBufferSize: 1,
    maxPendingBytes: "lREADY".length,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("\x1b[?1049lREADY");

  const pending = buffer.takePendingEntry();

  assert.equal(pending.data, "lREADY");
  assert.deepEqual(pending.meta, {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "leave",
  });
});

test("pending cap does not mark retained alternate-screen leave as already dropped", () => {
  const sends = [];
  let accept = false;
  const retained = "\x1b[?1049ltail";
  const buffer = createPtyOutputBuffer((data, meta) => sends.push({ data, meta }), {
    maxBufferSize: retained.length,
    maxFloodBufferSize: retained.length,
    maxPendingBytes: retained.length,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData(`${"x".repeat(16)}${retained}`);

  accept = true;
  buffer.flush();

  assert.deepEqual(sends[0].meta, {
    droppedOutputMayAffectTerminalState: true,
  });
});
