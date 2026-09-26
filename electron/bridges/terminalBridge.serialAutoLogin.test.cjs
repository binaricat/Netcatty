const test = require("node:test");
const assert = require("node:assert/strict");
const terminalBridge = require("./terminalBridge.cjs");

test("serial auto-login cancels on interactive user input but not automated writes", () => {
  let userInputs = 0;
  const session = {
    type: "serial",
    protocol: "serial",
    encoding: "utf-8",
    serialPort: { write: () => true },
    autoLogin: { handleUserInput: () => { userInputs += 1; } },
  };
  terminalBridge.init({ sessions: new Map([["s", session]]), electronModule: {} });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "x" });
    assert.equal(userInputs, 1);
    terminalBridge.writeToSession({}, { sessionId: "s", data: "y", automated: true });
    assert.equal(userInputs, 1);
    // xterm replies to ANSI queries (cursor position, DA1, ...) travel through
    // onData without `automated`; they must not cancel auto-login.
    terminalBridge.writeToSession({}, { sessionId: "s", data: "\x1b[24;80R" });
    assert.equal(userInputs, 1);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("serial line-mode buffered input notification cancels auto-login", () => {
  let userInputs = 0;
  const session = {
    type: "serial",
    protocol: "serial",
    encoding: "utf-8",
    serialPort: { write: () => true },
    autoLogin: {
      // Mirror createTelnetAutoLogin.handleUserInput: idempotent cancel.
      handleUserInput() {
        if (this.disabled) return;
        this.disabled = true;
        userInputs += 1;
      },
      disabled: false,
    },
  };
  terminalBridge.init({ sessions: new Map([["s", session]]), electronModule: {} });
  try {
    // Serial line mode buffers keystrokes in the renderer and only writes to
    // the session on Enter, so cancellation is signalled via a dedicated
    // notification instead of the write path.
    terminalBridge.notifySessionUserInput({}, { sessionId: "s" });
    assert.equal(userInputs, 1);
    // Idempotent: further notifications do not re-notify.
    terminalBridge.notifySessionUserInput({}, { sessionId: "s" });
    assert.equal(userInputs, 1);
    // Unknown sessions are ignored.
    terminalBridge.notifySessionUserInput({}, { sessionId: "missing" });
    assert.equal(userInputs, 1);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("serial sessions without auto-login credentials accept input normally", () => {
  const writes = [];
  const session = {
    type: "serial",
    protocol: "serial",
    encoding: "utf-8",
    serialPort: { write: (d) => writes.push(Buffer.from(d)) },
  };
  terminalBridge.init({ sessions: new Map([["s", session]]), electronModule: {} });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "ls\r" });
    assert.deepEqual(writes.map((b) => b.toString()), ["ls\r"]);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("serial auto-login cancels at input ingress before a slow interceptor resolves", async () => {
  let userInputs = 0;
  let interceptorResolved = false;
  const session = {
    type: "serial",
    protocol: "serial",
    encoding: "utf-8",
    serialPort: { write: () => true },
    autoLogin: {
      // Mirror createTelnetAutoLogin.handleUserInput: idempotent cancel.
      handleUserInput() {
        if (this.disabled) return;
        this.disabled = true;
        userInputs += 1;
      },
      disabled: false,
    },
  };
  terminalBridge.init({
    sessions: new Map([["s", session]]),
    electronModule: {},
    terminalDataPipeline: {
      has: () => true,
      interceptInput: async (sessionId, data) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        interceptorResolved = true;
        return data;
      },
    },
  });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "ls\r" });
    // Cancellation must happen synchronously at ingress, not only after the
    // asynchronous interceptor resolves.
    assert.equal(userInputs, 1);
    assert.equal(interceptorResolved, false);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(userInputs, 1);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});
