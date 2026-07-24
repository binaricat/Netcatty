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

test("clearSessionPtyBuffer calls node-pty clear for ConPTY sync after frontend clear", () => {
  const calls = [];
  const sessions = new Map();
  sessions.set("local-ps-1", {
    proc: {
      clear() {
        calls.push("clear");
      },
      write() {
        calls.push("write");
      },
    },
  });
  initBridge(sessions);

  terminalBridge.clearSessionPtyBuffer({ sender: {} }, { sessionId: "local-ps-1" });

  assert.deepEqual(calls, ["clear"]);
});

test("clearSessionPtyBuffer is a no-op when the session has no pty process", () => {
  const sessions = new Map();
  sessions.set("ssh-1", {
    stream: {
      write() {},
    },
  });
  initBridge(sessions);

  assert.doesNotThrow(() => {
    terminalBridge.clearSessionPtyBuffer({ sender: {} }, { sessionId: "ssh-1" });
  });
});

test("clearSessionPtyBuffer ignores missing sessions", () => {
  initBridge(new Map());
  assert.doesNotThrow(() => {
    terminalBridge.clearSessionPtyBuffer({ sender: {} }, { sessionId: "missing" });
  });
});
