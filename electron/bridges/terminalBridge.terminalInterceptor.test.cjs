"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const terminalBridge = require("./terminalBridge.cjs");
const {
  getSessionLastObservedShellKind,
  isSessionInputLineKnownEmpty,
  trackSessionIdlePrompt,
} = require("./ai/shellUtils.cjs");

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
  trackSessionIdlePrompt(h.session, "PS C:\\Users\\alice>");
  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "hello" });
  assert.equal(isSessionInputLineKnownEmpty(h.session), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted.map((entry) => entry.data), ["hello"]);
  assert.deepEqual(h.writes, ["HELLO"]);
});

test("interceptor-consumed input releases its reservation without becoming pending", async () => {
  const writes = [];
  const session = {
    type: "local",
    proc: { write(data) { writes.push(data); } },
  };
  terminalBridge.init({
    sessions: new Map([["session-consumed", session]]),
    electronModule: {},
    terminalDataPipeline: {
      has() { return true; },
      async interceptInput() { return new Uint8Array(); },
    },
  });
  trackSessionIdlePrompt(session, "PS C:\\Users\\alice>");

  terminalBridge.writeToSession(null, { sessionId: "session-consumed", data: "x" });
  assert.equal(isSessionInputLineKnownEmpty(session), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(writes, []);
  assert.equal(isSessionInputLineKnownEmpty(session), true);
});

test("queued intercepted input stays reserved until every write is delivered", async () => {
  const writes = [];
  const releases = new Map();
  const session = {
    type: "local",
    proc: { write(data) { writes.push(String(data)); } },
  };
  terminalBridge.init({
    sessions: new Map([["session-queued", session]]),
    electronModule: {},
    terminalDataPipeline: {
      has() { return true; },
      interceptInput(_sessionId, data) {
        return new Promise((resolve) => { releases.set(data, resolve); });
      },
    },
  });
  trackSessionIdlePrompt(session, "PS C:\\Users\\alice>");

  terminalBridge.writeToSession(null, { sessionId: "session-queued", data: "ONE\r" });
  terminalBridge.writeToSession(null, { sessionId: "session-queued", data: "USER" });
  await new Promise((resolve) => setImmediate(resolve));
  trackSessionIdlePrompt(session, "\r\nPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), false);

  releases.get("ONE\r")("ONE\r");
  await new Promise((resolve) => setImmediate(resolve));
  trackSessionIdlePrompt(session, "\r\nPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), false);
  assert.deepEqual(writes, ["ONE\r"]);

  await new Promise((resolve) => setImmediate(resolve));
  releases.get("USER")("USER");
  await new Promise((resolve) => setImmediate(resolve));
  trackSessionIdlePrompt(session, "\r\nPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), false);
  assert.deepEqual(writes, ["ONE\r", "USER"]);
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
    "\x1b]52;c;c2VjcmV0Cg==\x07",
    "\x1b[M *%",
    "\x1b[<0;10;5M",
    "\x1b[<0;10;5m",
  ];
  for (const data of reports) {
    terminalBridge.writeToSession(null, { sessionId: "session-1", data });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted, []);
  assert.deepEqual(h.writes, reports);
  assert.equal(h.session._inputSinceIdlePrompt, false);
});

test("transport keyboard records use logical Enter semantics for prompt tracking", () => {
  const writes = [];
  const session = {
    type: "local",
    proc: { write(data) { writes.push(String(data)); } },
  };
  terminalBridge.init({
    sessions: new Map([["session-keyboard", session]]),
    electronModule: {},
  });
  trackSessionIdlePrompt(session, "PS C:\\Users\\alice>");

  const win32Enter = "\x1b[13;28;13;1;0;1_";
  terminalBridge.writeToSession(null, {
    sessionId: "session-keyboard",
    data: win32Enter,
    logicalData: "\r",
  });
  assert.equal(isSessionInputLineKnownEmpty(session), false);
  trackSessionIdlePrompt(session, "\r\nPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), true);

  const win32KeyUp = "\x1b[13;28;13;0;0;1_";
  terminalBridge.writeToSession(null, {
    sessionId: "session-keyboard",
    data: win32KeyUp,
    logicalData: null,
  });
  assert.equal(isSessionInputLineKnownEmpty(session), true);
  assert.deepEqual(writes, [win32Enter, win32KeyUp]);
});

test("modified Enter stays pending when its editing effect is unknown", async () => {
  const writes = [];
  let releaseInput;
  const session = {
    type: "local",
    proc: { write(data) { writes.push(String(data)); } },
  };
  terminalBridge.init({
    sessions: new Map([["session-modified-enter", session]]),
    electronModule: {},
    terminalDataPipeline: {
      has() { return true; },
      interceptInput(_sessionId, data) {
        return new Promise((resolve) => { releaseInput = () => resolve(data); });
      },
    },
  });
  trackSessionIdlePrompt(session, "PS C:\\Users\\alice>");

  const modifiedEnter = "\x1b[13;28;13;1;16;1_";
  terminalBridge.writeToSession(null, {
    sessionId: "session-modified-enter",
    data: modifiedEnter,
    logicalData: undefined,
  });
  await new Promise((resolve) => setImmediate(resolve));
  trackSessionIdlePrompt(session, "\r\nPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), false);

  releaseInput();
  await new Promise((resolve) => setImmediate(resolve));
  trackSessionIdlePrompt(session, "\r\nPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), false);
  assert.deepEqual(writes, [modifiedEnter]);

  terminalBridge.writeToSession(null, {
    sessionId: "session-modified-enter",
    data: "\x03",
    logicalData: "\x03",
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseInput();
  await new Promise((resolve) => setImmediate(resolve));
  trackSessionIdlePrompt(session, "\r\nPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), true);
});

test("a manual line-clear key restores clean input after the prompt redraw", () => {
  const writes = [];
  const session = {
    type: "local",
    proc: { write(data) { writes.push(String(data)); } },
  };
  terminalBridge.init({
    sessions: new Map([["session-line-clear", session]]),
    electronModule: {},
  });
  trackSessionIdlePrompt(session, "PS C:\\Users\\alice>");

  terminalBridge.writeToSession(null, {
    sessionId: "session-line-clear",
    data: "Write-Output 'partial'",
  });
  terminalBridge.writeToSession(null, {
    sessionId: "session-line-clear",
    data: "\x1b",
  });
  assert.equal(isSessionInputLineKnownEmpty(session), false);

  trackSessionIdlePrompt(session, "\rPS C:\\Users\\alice>");
  assert.equal(isSessionInputLineKnownEmpty(session), true);
  assert.deepEqual(writes, ["Write-Output 'partial'", "\x1b"]);
});

test("manual command output cannot promote a different shell prompt", () => {
  const writes = [];
  const session = {
    type: "local",
    proc: { write(data) { writes.push(String(data)); } },
  };
  terminalBridge.init({
    sessions: new Map([["session-manual", session]]),
    electronModule: {},
  });
  trackSessionIdlePrompt(session, "alice@host:~$");

  terminalBridge.writeToSession(null, {
    sessionId: "session-manual",
    data: "printf 'PS C:\\fake>'\r",
  });
  assert.equal(trackSessionIdlePrompt(session, "\r\nPS C:\\fake>"), "");
  assert.equal(getSessionLastObservedShellKind(session), "powershell");
  assert.equal(isSessionInputLineKnownEmpty(session), false);

  trackSessionIdlePrompt(session, "\r\nalice@host:~$");
  assert.equal(getSessionLastObservedShellKind(session), "posix");
  assert.equal(isSessionInputLineKnownEmpty(session), false);

  terminalBridge.writeToSession(null, {
    sessionId: "session-manual",
    data: "\x03",
  });
  trackSessionIdlePrompt(session, "\r\nalice@host:~$");
  assert.equal(isSessionInputLineKnownEmpty(session), true);
  assert.deepEqual(writes, ["printf 'PS C:\\fake>'\r", "\x03"]);
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
