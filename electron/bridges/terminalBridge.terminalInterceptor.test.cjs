"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const terminalBridge = require("./terminalBridge.cjs");

function createHarness() {
  const writes = [];
  const intercepted = [];
  const session = {
    type: "local",
    proc: { write(data) { writes.push(String(data)); } },
    _inputSinceIdlePrompt: false,
  };
  const sessions = new Map([["session-1", session]]);
  terminalBridge.init({
    sessions,
    electronModule: {},
    terminalDataPipeline: {
      has(sessionId, direction) { return sessionId === "session-1" && direction === "input"; },
      async interceptInput(sessionId, data, options) {
        if (options?.bypass || options?.sensitive) return data;
        intercepted.push({ sessionId, data, options });
        return String(data).toUpperCase();
      },
    },
  });
  return { writes, intercepted, session };
}

test("ordinary terminal input uses the worker-owned interceptor before transport encoding", async () => {
  const h = createHarness();
  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "hello" });
  assert.equal(h.session._inputSinceIdlePrompt, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted.map((entry) => entry.data), ["hello"]);
  assert.deepEqual(h.writes, ["HELLO"]);
});

test("host-classified sensitive input bypasses interceptors and preserves original bytes", async () => {
  const h = createHarness();
  terminalBridge.writeToSession(null, {
    sessionId: "session-1",
    data: "secret\r",
    sensitive: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted, []);
  assert.deepEqual(h.writes, ["secret\r"]);
});

test("host terminal protocol replies bypass third-party interceptors", async () => {
  const h = createHarness();
  const reports = [
    "\x1b[1;2R",
    "\x1b[?2004;1$y",
    "\x1b[8;24;80t",
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
  ];
  for (const data of reports) {
    terminalBridge.writeToSession(null, { sessionId: "session-1", data });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted, []);
  assert.deepEqual(h.writes, reports);
});

test("input remains ordered when an interceptor is disabled during an in-flight transform", async () => {
  const writes = [];
  let enabled = true;
  let releaseFirst;
  terminalBridge.init({
    sessions: new Map([["session-1", {
      type: "local",
      proc: { write(data) { writes.push(String(data)); } },
    }]]),
    electronModule: {},
    terminalDataPipeline: {
      has() { return enabled; },
      interceptInput() {
        return new Promise((resolve) => { releaseFirst = resolve; });
      },
    },
  });

  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  enabled = false;
  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "second" });
  assert.deepEqual(writes, []);

  releaseFirst("FIRST");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["FIRST", "second"]);
});

test("a pending input transform cannot write into a reused session id", async () => {
  const oldWrites = [];
  const newWrites = [];
  let enabled = true;
  let releaseOld;
  const sessions = new Map([["session-1", {
    type: "local",
    proc: {
      write(data) { oldWrites.push(String(data)); },
      kill() {},
    },
  }]]);
  terminalBridge.init({
    sessions,
    electronModule: {},
    terminalDataPipeline: {
      has() { return enabled; },
      interceptInput() {
        return new Promise((resolve) => { releaseOld = resolve; });
      },
    },
  });

  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "old" });
  await new Promise((resolve) => setImmediate(resolve));
  terminalBridge.closeSession({ sender: {} }, { sessionId: "session-1" });
  sessions.set("session-1", {
    type: "local",
    proc: { write(data) { newWrites.push(String(data)); } },
  });
  enabled = false;
  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "new" });
  releaseOld("STALE");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(oldWrites, []);
  assert.deepEqual(newWrites, ["new"]);
});
