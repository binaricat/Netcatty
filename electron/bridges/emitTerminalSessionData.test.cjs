const assert = require("node:assert/strict");
const test = require("node:test");

const {
  addTerminalDataTap,
  configureTerminalSessionDataEmitter,
  emitTerminalSessionData,
} = require("./emitTerminalSessionData.cjs");

test("emitTerminalSessionData rejects output from a replaced backend session", () => {
  const oldSession = { _terminalSessionGeneration: 0 };
  const newSession = { _terminalSessionGeneration: 1 };
  const sent = [];
  const tapped = [];
  const removeTap = addTerminalDataTap((sessionId, data) => tapped.push({ sessionId, data }));
  configureTerminalSessionDataEmitter({
    getSession: () => newSession,
    outputChannel: { send: () => false },
  });

  const delivered = emitTerminalSessionData({
    send(channel, payload) { sent.push({ channel, payload }); },
  }, "session-1", "old-secret", { session: oldSession });

  assert.equal(delivered, false);
  assert.deepEqual(tapped, []);
  assert.deepEqual(sent, []);
  removeTap();
  configureTerminalSessionDataEmitter({});
});

test("emitTerminalSessionData binds fallback output to the backend generation", () => {
  const session = { _terminalSessionGeneration: 3 };
  const sent = [];
  configureTerminalSessionDataEmitter({
    getSession: () => session,
    outputChannel: { send: () => false },
  });

  emitTerminalSessionData({
    send(channel, payload) { sent.push({ channel, payload }); },
  }, "session-1", "hello", { session });

  assert.deepEqual(sent, [{
    channel: "netcatty:data",
    payload: {
      sessionId: "session-1",
      data: "hello",
      _terminalSessionGeneration: 3,
    },
  }]);
  configureTerminalSessionDataEmitter({});
});

test("emitTerminalSessionData prefers the dedicated terminal output channel", () => {
  const sent = [];
  const outputChannel = {
    send(sessionId, data) {
      sent.push({ sessionId, data });
      return true;
    },
  };
  const contents = {
    send() {
      throw new Error("legacy ipc should not be used");
    },
  };
  configureTerminalSessionDataEmitter({
    outputChannel,
    getSession: () => null,
  });

  emitTerminalSessionData(contents, "session-1", "hello");

  assert.deepEqual(sent, [{ sessionId: "session-1", data: "hello" }]);
  configureTerminalSessionDataEmitter({});
});

test("emitTerminalSessionData falls back to netcatty:data without an output port", () => {
  const sent = [];
  const outputChannel = {
    send() {
      return false;
    },
  };
  const contents = {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  configureTerminalSessionDataEmitter({
    outputChannel,
    getSession: () => null,
  });

  emitTerminalSessionData(contents, "session-1", "hello");

  assert.deepEqual(sent, [
    { channel: "netcatty:data", payload: { sessionId: "session-1", data: "hello" } },
  ]);
  configureTerminalSessionDataEmitter({});
});

test("emitTerminalSessionData forwards terminal output metadata", () => {
  const sent = [];
  const outputChannel = {
    send() {
      return false;
    },
  };
  const contents = {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  configureTerminalSessionDataEmitter({
    outputChannel,
    getSession: () => null,
  });

  emitTerminalSessionData(contents, "session-1", "hello", {
    meta: { droppedOutputMayAffectTerminalState: true },
  });

  assert.deepEqual(sent, [
    {
      channel: "netcatty:data",
      payload: {
        sessionId: "session-1",
        data: "hello",
        meta: { droppedOutputMayAffectTerminalState: true },
      },
    },
  ]);
  configureTerminalSessionDataEmitter({});
});

test("emitTerminalSessionData reports terminal output as session activity", () => {
  const activity = [];
  configureTerminalSessionDataEmitter({
    getSession: () => null,
    outputChannel: { send: () => true },
    onSessionActivity: (event) => activity.push(event),
  });

  emitTerminalSessionData(null, "session-activity", "output");

  assert.deepEqual(activity, [
    { sessionId: "session-activity", phase: "touch" },
  ]);
  configureTerminalSessionDataEmitter({});
});
