const assert = require("node:assert/strict");
const test = require("node:test");

const {
  configureTerminalSessionDataEmitter,
  emitTerminalSessionData,
} = require("./emitTerminalSessionData.cjs");

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
