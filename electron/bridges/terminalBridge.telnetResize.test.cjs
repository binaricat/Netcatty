const test = require("node:test");
const assert = require("node:assert/strict");

const terminalBridge = require("./terminalBridge.cjs");

test("Telnet resize does not write NAWS bytes before the peer enables NAWS", () => {
  const sessionId = "telnet-resize-naws-disabled";
  const writes = [];
  let windowSizeRequests = 0;
  const sessions = new Map();

  sessions.set(sessionId, {
    type: "telnet-native",
    socket: {
      write(buf) {
        writes.push(Buffer.from(buf));
      },
      destroy() {},
    },
    telnetProtocolActive: true,
    sendTelnetWindowSize() {
      windowSizeRequests++;
      return false;
    },
  });

  terminalBridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId: () => ({ send() {} }),
      },
    },
  });

  try {
    terminalBridge.resizeSession(
      { sender: { id: 1 } },
      { sessionId, cols: 94, rows: 55 },
    );

    assert.equal(windowSizeRequests, 1);
    assert.equal(writes.length, 0);
    assert.equal(sessions.get(sessionId).cols, 94);
    assert.equal(sessions.get(sessionId).rows, 55);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});
