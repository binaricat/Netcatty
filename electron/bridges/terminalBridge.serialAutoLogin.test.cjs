"use strict";

// --- merged from terminalBridge.serialAutoLogin.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");
const terminalBridge = require("./terminalBridge.cjs");
const { createTelnetAutoLogin } = require("./telnetAutoLogin.cjs");

function createSerialAutoLoginSession() {
  const writes = [];
  const events = [];
  const session = {
    type: "serial",
    protocol: "serial",
    encoding: "utf-8",
    serialPort: {
      write: (data) => {
        writes.push(typeof data === "string" ? data : Buffer.from(data).toString());
        return true;
      },
    },
  };
  session.autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => {
      session.serialPort.write(data);
    },
    onUserInput: () => { events.push("cancelled"); },
  });
  return { session, writes, events };
}

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

test("serial wake-only enter keeps auto-login armed and still reaches the port", () => {
  const { session, writes, events } = createSerialAutoLoginSession();
  terminalBridge.init({ sessions: new Map([["s", session]]), electronModule: {} });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "\r" });
    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["\r"]);

    session.autoLogin.handleText("login: ");
    session.autoLogin.handleText("\r\nPassword: ");

    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["\r", "admin\r", "secret\r"]);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("serial character input before login still cancels auto-login", () => {
  const { session, writes, events } = createSerialAutoLoginSession();
  terminalBridge.init({ sessions: new Map([["s", session]]), electronModule: {} });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "x" });
    session.autoLogin.handleText("login: ");
    session.autoLogin.handleText("\r\nPassword: ");

    assert.deepEqual(events, ["cancelled"]);
    assert.deepEqual(writes, ["x"]);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("serial wake-only enter stays armed when an input interceptor is pending", async () => {
  const { session, writes, events } = createSerialAutoLoginSession();
  let interceptorResolved = false;
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
    terminalBridge.writeToSession({}, { sessionId: "s", data: "\n" });
    assert.deepEqual(events, []);
    assert.equal(interceptorResolved, false);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(interceptorResolved, true);
    assert.deepEqual(writes, ["\n"]);

    session.autoLogin.handleText("login: ");
    session.autoLogin.handleText("\r\nPassword: ");
    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["\n", "admin\r", "secret\r"]);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("serial wake enter is not cancelled when login arrives during interceptor delay", async () => {
  const { session, writes, events } = createSerialAutoLoginSession();
  let interceptorStarted = false;
  let releaseInterceptor = () => {};
  const interceptorGate = new Promise((resolve) => {
    releaseInterceptor = resolve;
  });
  terminalBridge.init({
    sessions: new Map([["s", session]]),
    electronModule: {},
    terminalDataPipeline: {
      has: () => true,
      interceptInput: async (_sessionId, data) => {
        interceptorStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await interceptorGate;
        return data;
      },
    },
  });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "\r" });
    await Promise.resolve();
    assert.equal(interceptorStarted, true);

    // Prompt arrives while the wake byte is still queued in the interceptor.
    session.autoLogin.handleText("login: ");
    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["admin\r"]);

    releaseInterceptor();
    const deadline = Date.now() + 500;
    while (writes.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["admin\r", "\r"]);

    session.autoLogin.handleText("\r\nPassword: ");
    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["admin\r", "\r", "secret\r"]);
  } finally {
    releaseInterceptor();
    terminalBridge.cleanupAllSessions();
  }
});

test("serial interceptor that rewrites a wake enter into text cancels auto-login", async () => {
  const { session, writes, events } = createSerialAutoLoginSession();
  let interceptorStarted = false;
  terminalBridge.init({
    sessions: new Map([["s", session]]),
    electronModule: {},
    terminalDataPipeline: {
      has: () => true,
      interceptInput: async (_sessionId, data) => {
        interceptorStarted = true;
        assert.equal(data, "\r");
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Enter-to-command macro: the bare wake CR is no longer what is written.
        return "uptime\r";
      },
    },
  });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "\r" });
    await Promise.resolve();
    assert.equal(interceptorStarted, true);
    // Ingress still sees a wake, so autofill stays armed until the rewrite lands.
    assert.deepEqual(events, []);
    assert.deepEqual(writes, []);

    const deadline = Date.now() + 500;
    while (writes.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.deepEqual(events, ["cancelled"]);
    assert.deepEqual(writes, ["uptime\r"]);

    session.autoLogin.handleText("login: ");
    session.autoLogin.handleText("\r\nPassword: ");
    assert.deepEqual(events, ["cancelled"]);
    assert.deepEqual(writes, ["uptime\r"]);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("serial interceptor that rewrites a wake enter into another wake still autofills", async () => {
  const { session, writes, events } = createSerialAutoLoginSession();
  let releaseInterceptor = () => {};
  const interceptorGate = new Promise((resolve) => {
    releaseInterceptor = resolve;
  });
  terminalBridge.init({
    sessions: new Map([["s", session]]),
    electronModule: {},
    terminalDataPipeline: {
      has: () => true,
      interceptInput: async (_sessionId, data) => {
        assert.equal(data, "\r");
        await interceptorGate;
        return "\r\n";
      },
    },
  });
  try {
    terminalBridge.writeToSession({}, { sessionId: "s", data: "\r" });
    await Promise.resolve();

    session.autoLogin.handleText("login: ");
    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["admin\r"]);

    releaseInterceptor();
    const deadline = Date.now() + 500;
    while (writes.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["admin\r", "\r\n"]);

    session.autoLogin.handleText("\r\nPassword: ");
    assert.deepEqual(events, []);
    assert.deepEqual(writes, ["admin\r", "\r\n", "secret\r"]);
  } finally {
    releaseInterceptor();
    terminalBridge.cleanupAllSessions();
  }
});

test("serial line-mode notification still cancels auto-login without keystroke data", () => {
  const { session, writes, events } = createSerialAutoLoginSession();
  terminalBridge.init({ sessions: new Map([["s", session]]), electronModule: {} });
  try {
    terminalBridge.notifySessionUserInput({}, { sessionId: "s" });
    session.autoLogin.handleText("login: ");
    session.autoLogin.handleText("\r\nPassword: ");

    assert.deepEqual(events, ["cancelled"]);
    assert.deepEqual(writes, []);
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
}

// --- merged from terminalBridge.serialBackspace.test.cjs ---
{
const test = require('node:test');
const assert = require('node:assert/strict');
const terminalBridge = require('./terminalBridge.cjs');
const { encodeTerminalInput, normalizeTerminalEncoding } = require('./terminalEncoding.cjs');

for (const charset of ['utf-8', 'GBK', 'Shift_JIS', 'Big5', 'EUC-JP', 'latin1', 'utf-16', 'unknown']) {
  test(`serial byte deletion matches actual ${charset} input and preserves preceding text`, () => {
    const encoding = normalizeTerminalEncoding(charset);
    let wire = Buffer.alloc(0);
    const serialPort = { write(data) {
      for (const byte of Buffer.from(data)) {
        wire = byte === 127 || byte === 8 ? wire.subarray(0, Math.max(0, wire.length - 1)) : Buffer.concat([wire, Buffer.from([byte])]);
      }
    } };
    terminalBridge.init({ sessions: new Map([['serial', {type: 'serial', protocol: 'serial', encoding, serialPort}]]), electronModule: {} });
    for (const char of ['你', 'é', 'ü', 'α', '〿', 'ｱ', '龘', '❤️', '𠀀']) {
      wire = Buffer.alloc(0);
      terminalBridge.writeToSession({}, {sessionId: 'serial', data: 'abc' + char});
      assert.equal(wire.length, 3 + Buffer.byteLength(encodeTerminalInput(char, encoding)));
      terminalBridge.writeToSession({}, {sessionId: 'serial', data: '\x7f', serialEraseChar: char});
      assert.equal(wire.toString(), 'abc', char);
    }
  });
}

test('ordinary serial and non-serial input retain one Backspace', () => {
  for (const serial of [true, false]) {
    const writes = [];
    const session = serial ? {serialPort: {write: data => writes.push(data)}} : {stream: {write: data => writes.push(data)}};
    terminalBridge.init({sessions: new Map([['s', session]]), electronModule: {}});
    terminalBridge.writeToSession({}, {sessionId: 's', data: '\x7f', ...(!serial ? {serialEraseChar: '你'} : {})});
    assert.deepEqual(writes, ['\x7f']);
  }
});

test('serial byte deletion uses the current backend encoding and preserves other keys', () => {
  const writes = [];
  const session = {serialPort: {write: data => writes.push(Buffer.from(data))}, encoding: 'gb18030'};
  terminalBridge.init({sessions: new Map([['s', session]]), electronModule: {}});
  terminalBridge.writeToSession({}, {sessionId: 's', data: '\b', serialEraseChar: '你'});
  session.encoding = 'utf-8';
  terminalBridge.writeToSession({}, {sessionId: 's', data: '\b', serialEraseChar: '你'});
  terminalBridge.writeToSession({}, {sessionId: 's', data: '\x03', serialEraseChar: '你'});
  assert.deepEqual(writes.map(b => [...b]), [[8, 8], [8, 8, 8], [3]]);
});
}
