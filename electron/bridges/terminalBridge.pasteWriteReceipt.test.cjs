"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("./terminalBridge.cjs");

function harness(t, pipeline) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes = [];
  const receipts = [];
  const session = {
    webContentsId: 41,
    stream: { write(data) { writes.push(data); return false; }, close() {} },
  };
  const sessions = new Map([["s", session]]);
  bridge.init({ sessions, terminalDataPipeline: pipeline, electronModule: {
    webContents: { fromId(id) {
      assert.equal(id, 41, "notify session owner, not invoking sender");
      return { send(channel, payload) {
        if (channel !== "netcatty:paste-write") return;
        assert.equal(writes.length >= receipts.filter(r => r.index !== undefined).length, true);
        receipts.push(payload);
      } };
    } },
  } });
  const send = (overrides = {}) => bridge.writeToSession({ sender: { id: 99 } }, {
    sessionId: "s", data: "one\r\ntwo\nthree\r", automated: true,
    lineDelayMs: 100, pasteRequestId: "request", ...overrides,
  });
  const expected = (...entries) => entries.map(entry => ({ sessionId: "s", requestId: "request", ...entry }));
  return { writes, receipts, session, sessions, send, expected };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const mode of ["interrupt", "manual", "ctrl-c"]) {
  test(`paste ${mode} after first line acknowledges only the sent line`, t => {
    const h = harness(t);
    h.send();
    assert.deepEqual(h.writes, ["one\r"]);
    if (mode === "interrupt") bridge.interruptSession(null, { sessionId: "s" });
    else bridge.writeToSession(null, { sessionId: "s", data: mode === "manual" ? "x" : "\x03" });
    t.mock.timers.tick(1000);
    assert.deepEqual(h.writes, ["one\r", mode === "manual" ? "x" : "\x03"]);
    assert.deepEqual(h.receipts, h.expected({ index: 0 }, { done: true }));
  });
}

test("normal scheduler sends original chunk indices then final done, without content", t => {
  const h = harness(t);
  h.send({ data: "one\n\ntail" });
  assert.deepEqual(h.receipts, h.expected({ index: 0 }));
  t.mock.timers.tick(100);
  assert.deepEqual(h.receipts, h.expected({ index: 0 }, { index: 1 }));
  t.mock.timers.tick(100);
  assert.deepEqual(h.writes, ["one\r", "\r", "tail"]);
  assert.deepEqual(h.receipts, h.expected({ index: 0 }, { index: 1 }, { index: 2, done: true }));
  assert.equal(h.session.pendingPasteWrites.size, 0);
});

test("single line acknowledges only after write returns, including backpressure false", t => {
  const h = harness(t);
  h.session.stream.write = data => {
    assert.deepEqual(h.receipts, []);
    h.writes.push(data);
    return false;
  };
  h.send({ data: "one" });
  assert.deepEqual(h.receipts, h.expected({ index: 0, done: true }));
});

for (const failure of ["throw", "blocked", "ymodem", "disconnect", "replacement", "no-transport"]) {
  test(`${failure} after first line never acknowledges unsent lines`, t => {
    const h = harness(t);
    h.send();
    if (failure === "throw") h.session.stream.write = () => { throw Object.assign(new Error("closed"), { code: "EPIPE" }); };
    if (failure === "blocked") h.session.zmodemSentry = { isActive: () => true };
    if (failure === "ymodem") h.session.ymodemActive = true;
    if (failure === "disconnect") h.sessions.delete("s");
    if (failure === "replacement") h.sessions.set("s", { stream: { write() { assert.fail("stale paste"); } } });
    if (failure === "no-transport") delete h.session.stream;
    t.mock.timers.tick(1000);
    assert.deepEqual(h.writes, ["one\r"]);
    assert.deepEqual(h.receipts, h.expected({ index: 0 }, { done: true }));
  });
}

test("blocked initial paste ends without index", t => {
  const h = harness(t);
  h.session.zmodemSentry = { isActive: () => true };
  h.send();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.receipts, h.expected({ done: true }));
});

for (const cancel of ["interrupt", "manual", "close", "replacement"]) {
  test(`pending interceptor and queued chunks cannot write after ${cancel}`, async t => {
    let release;
    let interceptCount = 0;
    const h = harness(t, {
      has: () => true,
      interceptInput(_id, data) {
        interceptCount++;
        if (data === "one\r") return new Promise(resolve => { release = resolve; });
        return Promise.resolve(data);
      },
    });
    h.send();
    await flush();
    t.mock.timers.tick(200); // All timer callbacks have already entered the barrier.
    if (cancel === "interrupt") bridge.interruptSession(null, { sessionId: "s" });
    if (cancel === "manual") bridge.writeToSession(null, { sessionId: "s", data: "x" });
    if (cancel === "close") bridge.closeSession({ sender: {} }, { sessionId: "s" });
    if (cancel === "replacement") h.send({ data: "new\nlast", pasteRequestId: "new" });
    release("STALE");
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(h.writes.includes("STALE"), false);
    assert.equal(h.writes.includes("two\r"), false);
    assert.equal(h.writes.includes("three\r"), false);
    assert.deepEqual(h.receipts.filter(r => r.requestId === "request"), h.expected({ done: true }));
    assert.equal(interceptCount, cancel === "replacement" ? 3 : cancel === "manual" ? 2 : 1);
  });
}

test("ordinary writes stay opt-in and terminal replies do not cancel paste", t => {
  const h = harness(t);
  h.send({ pasteRequestId: undefined });
  t.mock.timers.tick(200);
  assert.deepEqual(h.receipts, []);
  h.send();
  bridge.writeToSession(null, { sessionId: "s", data: "\x1b[2;1R" });
  t.mock.timers.tick(200);
  assert.deepEqual(h.receipts, h.expected({ index: 0 }, { index: 1 }, { index: 2, done: true }));
});

test("cancel second line while its interceptor waits preserves only first receipt", async t => {
  let rejectPending;
  const h = harness(t, {
    has: () => true,
    interceptInput(_id, data) {
      if (data === "two\r") return new Promise((_resolve, reject) => { rejectPending = reject; });
      return Promise.resolve(data);
    },
  });
  h.send();
  await flush();
  t.mock.timers.tick(100);
  await flush();
  bridge.interruptSession(null, { sessionId: "s" });
  rejectPending(new Error("interceptor unavailable"));
  await flush();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.writes, ["one\r", "\x03"]);
  assert.deepEqual(h.receipts, h.expected({ index: 0 }, { done: true }));
});

test("single line pending interceptor is canceled even with no delayed timers", async t => {
  let release;
  const h = harness(t, {
    has: () => true,
    interceptInput() { return new Promise(resolve => { release = resolve; }); },
  });
  h.send({ data: "one" });
  await flush();
  bridge.interruptSession(null, { sessionId: "s" });
  release("one");
  await flush();
  assert.deepEqual(h.writes, ["\x03"]);
  assert.deepEqual(h.receipts, h.expected({ done: true }));
});

test("failed single write ends without successful index", t => {
  const h = harness(t);
  h.session.stream.write = () => { throw Object.assign(new Error("closed"), { code: "EPIPE" }); };
  h.send({ data: "one" });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.receipts, h.expected({ done: true }));
});

for (const dropped of [[0], [2], [0, 1, 2]]) {
  test(`filtered empty paste chunks ${dropped.join(',')} have no receipt but preserve later chunks`, async t => {
    let nextIndex = 0;
    const h = harness(t, {
      has: () => true,
      async interceptInput(_id, data) {
        return dropped.includes(nextIndex++) ? "" : data;
      },
    });
    const chunks = ["one\r", "two\r", "three\r"];
    h.send();
    for (let index = 0; index < chunks.length; index++) {
      if (index > 0) t.mock.timers.tick(100);
      await flush();
      const sentIndices = chunks.map((_, i) => i).filter(i => i <= index && !dropped.includes(i));
      assert.deepEqual(h.writes, sentIndices.map(i => chunks[i]));
      const entries = sentIndices.map(i => i === 2 ? { index: i, done: true } : { index: i });
      if (index === 2 && dropped.includes(2)) entries.push({ done: true });
      assert.deepEqual(h.receipts, h.expected(...entries));
      assert.equal(h.session.pendingPasteWrites.size, index === 2 ? 0 : 1);
    }
    assert.equal(nextIndex, 3, "every original chunk still reaches the interceptor");
  });
}

for (const replacement of [
  { name: "paced single line", options: {} },
  { name: "paced single line without receipts", options: { pasteRequestId: undefined } },
  { name: "identified unpaced paste", options: { lineDelayMs: undefined } },
]) {
  test(`new ${replacement.name} cancels old delayed paste before writing`, async t => {
    const h = harness(t);
    h.send();
    h.send({ data: "replacement\r", pasteRequestId: "new", ...replacement.options });
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(h.writes, ["one\r", "replacement\r"]);
    assert.deepEqual(h.receipts.filter(r => r.requestId === "request"), h.expected({ index: 0 }, { done: true }));
    assert.deepEqual(h.receipts.filter(r => r.requestId === "new"), replacement.options.pasteRequestId === undefined && "pasteRequestId" in replacement.options
      ? [] : [{ sessionId: "s", requestId: "new", index: 0, done: true }]);
  });
}

test("single-line replacement invalidates old chunks already waiting on an interceptor", async t => {
  let release;
  const intercepted = [];
  const h = harness(t, {
    has: () => true,
    interceptInput(_id, data) {
      intercepted.push(data);
      if (data === "one\r") return new Promise(resolve => { release = resolve; });
      return Promise.resolve(data);
    },
  });
  h.send();
  await flush();
  t.mock.timers.tick(200);
  h.send({ data: "replacement\r", pasteRequestId: "new" });
  release("STALE");
  await flush();
  assert.deepEqual(h.writes, ["replacement\r"]);
  assert.deepEqual(intercepted, ["one\r", "replacement\r"]);
  assert.deepEqual(h.receipts.filter(r => r.requestId === "request"), h.expected({ done: true }));
});

test("blocked replacement still cancels old paste before transfer gate", async t => {
  let release;
  const h = harness(t, {
    has: () => true,
    interceptInput() { return new Promise(resolve => { release = resolve; }); },
  });
  h.send();
  await flush();
  h.session.zmodemSentry = { isActive: () => true };
  h.send({ data: "replacement\r", pasteRequestId: "new" });
  h.session.zmodemSentry = null;
  release("STALE");
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.receipts, [
    ...h.expected({ done: true }),
    { sessionId: "s", requestId: "new", done: true },
  ]);
});

for (const automatic of [false, true]) {
  test(`ordinary empty input preserves existing ${automatic ? "automated" : "manual"} behavior`, t => {
    const h = harness(t);
    h.send();
    bridge.writeToSession(null, { sessionId: "s", data: "", automated: automatic });
    t.mock.timers.tick(1000);
    assert.deepEqual(h.writes, automatic ? ["one\r", "", "two\r", "three\r"] : ["one\r", ""]);
    assert.deepEqual(h.receipts, automatic
      ? h.expected({ index: 0 }, { index: 1 }, { index: 2, done: true })
      : h.expected({ index: 0 }, { done: true }));
  });
}

for (const disconnected of ["removed", "closed", "replaced"]) {
  test(`disconnect ${disconnected} blocks pending interceptor and delayed paste`, async t => {
    let release;
    const h = harness(t, {
      has: () => true,
      interceptInput() { return new Promise(resolve => { release = resolve; }); },
    });
    h.send();
    await flush();
    if (disconnected === "removed") h.sessions.delete("s");
    if (disconnected === "closed") h.session.closed = true;
    if (disconnected === "replaced") h.sessions.set("s", { stream: { write() { assert.fail("stale write"); } } });
    release("STALE");
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.receipts, h.expected({ done: true }));
  });
}

for (const bypass of ["sensitive", "disabled-interceptor"]) {
  test(`single-line replacement through ${bypass} does not revive canceled interceptor input`, async t => {
    let release;
    let enabled = true;
    const h = harness(t, {
      has: () => enabled,
      interceptInput(_id, data, options) {
        if (data === "one\r") return new Promise(resolve => { release = resolve; });
        assert.equal(options.bypass, true);
        return Promise.resolve(data);
      },
    });
    h.send();
    await flush();
    t.mock.timers.tick(200);
    if (bypass === "disabled-interceptor") enabled = false;
    h.send({ data: "replacement\r", pasteRequestId: "new", sensitive: bypass === "sensitive" });
    release("STALE");
    await flush();
    assert.deepEqual(h.writes, ["replacement\r"]);
    assert.deepEqual(h.receipts, [
      ...h.expected({ done: true }),
      { sessionId: "s", requestId: "new", index: 0, done: true },
    ]);
  });
}

for (const cancel of ["interrupt", "manual", "replacement", "cancel-only", "removed", "closed", "replaced"]) {
  test(`no-receipt paced batch cannot resume from interceptor after ${cancel}`, async t => {
    let release;
    const h = harness(t, {
      has: () => true,
      interceptInput(_id, data) {
        if (data === "one\r") return new Promise(resolve => { release = resolve; });
        return Promise.resolve(data);
      },
    });
    h.send({ pasteRequestId: undefined });
    await flush();
    t.mock.timers.tick(200);
    if (cancel === "interrupt") bridge.interruptSession(null, { sessionId: "s" });
    if (cancel === "manual") bridge.writeToSession(null, { sessionId: "s", data: "x" });
    if (cancel === "replacement") h.send({ data: "new\r", pasteRequestId: undefined });
    if (cancel === "cancel-only") {
      h.session.stream.signal = () => assert.fail("must not signal");
      h.session.stream.pause = () => assert.fail("must not pause output");
      h.session.stream.resume = () => assert.fail("must not resume output");
      h.session.takePendingData = () => assert.fail("must not drain output");
      bridge.interruptSession(null, { sessionId: "s", cancelPendingWritesOnly: true });
    }
    if (cancel === "removed") h.sessions.delete("s");
    if (cancel === "closed") h.session.closed = true;
    if (cancel === "replaced") h.sessions.set("s", { stream: { write() { assert.fail("stale write"); } } });
    release("STALE");
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(h.writes, cancel === "interrupt" ? ["\x03"] : cancel === "manual" ? ["x"] : cancel === "replacement" ? ["new\r"] : []);
    assert.deepEqual(h.receipts, []);
    assert.equal(h.session.pendingPasteWrites.size, 0);
  });
}

test("cancel-only ends receipt batch without raw Ctrl+C, including missing session", t => {
  const h = harness(t);
  h.send();
  h.session.zmodemSentry = { isActive: () => true, cancel() { assert.fail("must not cancel transfer"); } };
  h.session.ymodemActive = true;
  h.session.ymodemAbortController = { abort() { assert.fail("must not abort transfer"); } };
  bridge.interruptSession(null, { sessionId: "s", cancelPendingWritesOnly: true });
  bridge.interruptSession(null, { sessionId: "missing", cancelPendingWritesOnly: true });
  t.mock.timers.tick(1000);
  assert.deepEqual(h.writes, ["one\r"]);
  assert.deepEqual(h.receipts, h.expected({ index: 0 }, { done: true }));
});
