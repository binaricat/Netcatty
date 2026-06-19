const test = require("node:test");
const assert = require("node:assert/strict");

const terminalBridge = require("./terminalBridge.cjs");

function initBridge(sessions) {
  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({ send() {} }),
      },
    },
  });
}

test("SSH Ctrl+C signals INT immediately and still writes the original byte", () => {
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
    ["signal", "INT"],
    ["write", "\x03"],
  ]);
});

test("SSH Ctrl+C still writes when the server does not support channel signals", () => {
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
    ["signal", "INT"],
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
