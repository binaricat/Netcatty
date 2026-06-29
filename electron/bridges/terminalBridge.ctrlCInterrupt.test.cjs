const test = require("node:test");
const assert = require("node:assert/strict");

const terminalBridge = require("./terminalBridge.cjs");
const {
  FLOW_HIGH_WATER_MARK,
} = require("../../infrastructure/config/terminalFlowConstants.cjs");

function initBridge(sessions, sent = []) {
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({
          send(channel, payload) {
            sent.push([channel, payload]);
          },
        }),
      },
    },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("SSH Ctrl+C writes the original byte without sending a channel signal", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: {
      signal(signalName) {
        calls.push(["signal", signalName]);
      },
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "ssh-1", data: "\x03" });

  assert.deepEqual(calls, [
    ["write", "\x03"],
  ]);
});

test("interruptSession sends SSH Ctrl+C without discarding pending output", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    discardPendingData() {
      calls.push(["discard"]);
    },
    stream: {
      signal(signalName) {
        calls.push(["signal", signalName]);
      },
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "ssh-1" });

  assert.deepEqual(calls, [
    ["write", "\x03"],
  ]);
});

test("interruptSession sends SSH Ctrl+C before resuming a paused output flood", async () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    discardPendingData() {
      calls.push(["discard"]);
    },
    stream: {
      pause() {
        calls.push(["pause"]);
      },
      resume() {
        calls.push(["resume"]);
      },
      signal(signalName) {
        calls.push(["signal", signalName]);
      },
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.setSessionFlowPaused({ sender: {} }, { sessionId: "ssh-1", paused: true });
  terminalBridge.interruptSession({ sender: {} }, { sessionId: "ssh-1" });

  assert.deepEqual(calls, [
    ["pause"],
    ["write", "\x03"],
  ]);

  await delay(0);
  assert.deepEqual(calls, [
    ["pause"],
    ["write", "\x03"],
    ["resume"],
  ]);
});

test("interruptSession sends SSH Ctrl+C without fastpath under low output pressure", async () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    takePendingData() {
      calls.push(["take-pending"]);
      return "Type  :qa  and press <Enter> to exit Vim";
    },
    discardPendingData() {
      calls.push(["discard"]);
    },
    flowState: {
      rendererPaused: false,
      unackedBytes: 119,
      appliedPause: false,
    },
    stream: {
      pause() {
        calls.push(["pause"]);
      },
      resume() {
        calls.push(["resume"]);
      },
      signal(signalName) {
        calls.push(["signal", signalName]);
      },
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "ssh-1" });

  assert.deepEqual(calls, [
    ["write", "\x03"],
  ]);

  await delay(0);
  assert.deepEqual(calls, [
    ["write", "\x03"],
  ]);
});

test("interruptSession filters pending SSH output under high output pressure", () => {
  const calls = [];
  const sent = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    cols: 80,
    rows: 24,
    webContentsId: 1,
    takePendingData() {
      calls.push(["take-pending"]);
      return "stale frame\x1b[?1049l";
    },
    discardPendingData() {
      calls.push(["discard"]);
    },
    flowState: {
      rendererPaused: false,
      unackedBytes: FLOW_HIGH_WATER_MARK + 1300,
      appliedPause: false,
    },
    stream: {
      pause() {
        calls.push(["pause"]);
      },
      resume() {},
      signal(signalName) {
        calls.push(["signal", signalName]);
      },
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions, sent);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "ssh-1" });

  assert.deepEqual(calls, [
    ["pause"],
    ["take-pending"],
    ["pause"],
    ["write", "\x03"],
  ]);
  assert.deepEqual(sent, [
    ["netcatty:data", { sessionId: "ssh-1", data: "\x1b[?1049l" }],
  ]);
});

test("interruptSession does not arm SSH output drain for tiny in-flight echo", () => {
  const sessions = new Map();
  const session = {
    discardPendingData() {},
    flowState: {
      rendererPaused: false,
      unackedBytes: 119,
      appliedPause: false,
    },
    stream: {
      pause() {},
      resume() {},
      signal() {},
      write() {},
    },
  };
  sessions.set("ssh-1", session);
  initBridge(sessions);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "ssh-1" });

  assert.notEqual(session._interruptOutputGate?.active, true);
});

test("interruptSession arms SSH output drain when interrupting a paused output flood", () => {
  const sessions = new Map();
  const session = {
    discardPendingData() {},
    flowState: {
      rendererPaused: false,
      unackedBytes: 34068,
      appliedPause: true,
    },
    stream: {
      resume() {},
      signal() {},
      write() {},
    },
  };
  sessions.set("ssh-1", session);
  initBridge(sessions);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "ssh-1" });

  assert.equal(session._interruptOutputGate?.active, true);
});

test("ordinary SSH input still disarms a pending interrupt output drain", () => {
  const sessions = new Map();
  const session = {
    discardPendingData() {},
    flowState: {
      rendererPaused: false,
      unackedBytes: 119,
      appliedPause: false,
    },
    stream: {
      resume() {},
      signal() {},
      write() {},
    },
  };
  sessions.set("ssh-1", session);
  initBridge(sessions);

  session._interruptOutputGate = { active: true };
  assert.equal(session._interruptOutputGate?.active, true);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "ssh-1", data: "l" });

  assert.equal(session._interruptOutputGate?.active, false);
});

test("SSH Ctrl+C does not use channel signals even when the stream exposes them", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: {
      signal(signalName) {
        calls.push(["signal", signalName]);
        throw new Error("signals unsupported");
      },
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "ssh-1", data: "\x03" });

  assert.deepEqual(calls, [
    ["write", "\x03"],
  ]);
});

test("SSH ordinary input is written without sending INT", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: {
      signal(signalName) {
        calls.push(["signal", signalName]);
      },
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "ssh-1", data: "cat\r" });

  assert.deepEqual(calls, [["write", "cat\r"]]);
});

test("local Ctrl+C behavior is unchanged", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("local-1", {
    type: "local",
    proc: {
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "local-1", data: "\x03" });

  assert.deepEqual(calls, [["write", "\x03"]]);
});

test("local interruptSession writes Ctrl+C without fastpath", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("local-1", {
    type: "local",
    takePendingData() {
      calls.push(["take-pending"]);
      return "pending";
    },
    proc: {
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "local-1" });

  assert.deepEqual(calls, [["write", "\x03"]]);
});

test("telnet Ctrl+C behavior is unchanged", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("telnet-1", {
    type: "telnet-native",
    socket: {
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "telnet-1", data: "\x03" });

  assert.deepEqual(calls, [["write", "\x03"]]);
});

test("telnet interruptSession writes Ctrl+C without fastpath", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("telnet-1", {
    type: "telnet-native",
    takePendingData() {
      calls.push(["take-pending"]);
      return "pending";
    },
    socket: {
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "telnet-1" });

  assert.deepEqual(calls, [["write", "\x03"]]);
});

test("serial Ctrl+C behavior is unchanged", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("serial-1", {
    type: "serial",
    serialPort: {
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "serial-1", data: "\x03" });

  assert.deepEqual(calls, [["write", "\x03"]]);
});

test("serial interruptSession writes Ctrl+C without fastpath", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("serial-1", {
    type: "serial",
    takePendingData() {
      calls.push(["take-pending"]);
      return "pending";
    },
    serialPort: {
      write(data) {
        calls.push(["write", data]);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.interruptSession({ sender: {} }, { sessionId: "serial-1" });

  assert.deepEqual(calls, [["write", "\x03"]]);
});

test("automated multi-line input is written one line at a time", async () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("telnet-1", {
    type: "telnet-native",
    socket: {
      write(data) {
        calls.push(data);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession(
    { sender: {} },
    {
      sessionId: "telnet-1",
      data: "tthdf 0 2323\nadmin\ntest123\n\r",
      automated: true,
      lineDelayMs: 5,
    },
  );

  assert.deepEqual(calls, ["tthdf 0 2323\r\n"]);
  await delay(30);
  assert.deepEqual(calls, ["tthdf 0 2323\r\n", "admin\r\n", "test123\r\n", "\r\n"]);
});

test("manual input cancels pending automated lines", async () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("telnet-1", {
    type: "telnet-native",
    socket: {
      write(data) {
        calls.push(data);
      },
    },
  });
  initBridge(sessions);

  terminalBridge.writeToSession(
    { sender: {} },
    {
      sessionId: "telnet-1",
      data: "first\nsecond\nthird\r",
      automated: true,
      lineDelayMs: 20,
    },
  );
  terminalBridge.writeToSession({ sender: {} }, { sessionId: "telnet-1", data: "\x03" });

  await delay(60);
  assert.deepEqual(calls, ["first\r\n", "\x03"]);
});

test("closing a paused SSH session does not resume the output flood first", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: {
      pause() {
        calls.push("pause");
      },
      resume() {
        calls.push("resume");
      },
      close() {
        calls.push("close");
      },
    },
  });
  initBridge(sessions);

  terminalBridge.setSessionFlowPaused({ sender: {} }, { sessionId: "ssh-1", paused: true });
  terminalBridge.closeSession({ sender: {} }, { sessionId: "ssh-1" });

  assert.deepEqual(calls, ["pause", "close"]);
});
