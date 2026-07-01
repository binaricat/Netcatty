const assert = require("node:assert/strict");
const test = require("node:test");

const { createTerminalOutputChannel } = require("./terminalOutputChannel.cjs");

class FakePort {
  constructor(label) {
    this.label = label;
    this.messages = [];
    this.closed = false;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  close() {
    this.closed = true;
  }
}

class FakeMessageChannelMain {
  constructor() {
    this.port1 = new FakePort("port1");
    this.port2 = new FakePort("port2");
  }
}

test("openSession posts a dedicated output port to the target webContents", () => {
  const posted = [];
  const channel = createTerminalOutputChannel({
    MessageChannelMain: FakeMessageChannelMain,
  });
  const webContents = {
    id: 42,
    postMessage(channelName, payload, ports) {
      posted.push({ channelName, payload, ports });
    },
  };

  channel.openSession("session-1", webContents);

  assert.equal(posted.length, 1);
  assert.equal(posted[0].channelName, "netcatty:terminal-output-port");
  assert.deepEqual(posted[0].payload, { sessionId: "session-1" });
  assert.equal(posted[0].ports.length, 1);
  assert.equal(posted[0].ports[0].label, "port2");
});

test("send posts terminal output over the dedicated port", () => {
  const channel = createTerminalOutputChannel({
    MessageChannelMain: FakeMessageChannelMain,
  });
  channel.openSession("session-1", { id: 42, postMessage() {} });

  assert.equal(channel.send("session-1", "hello"), true);

  const entry = channel.getSessionForTest("session-1");
  assert.deepEqual(entry.port.messages, [
    { sessionId: "session-1", data: "hello" },
  ]);
});

test("send includes terminal output metadata when present", () => {
  const channel = createTerminalOutputChannel({
    MessageChannelMain: FakeMessageChannelMain,
  });
  channel.openSession("session-1", { id: 42, postMessage() {} });

  assert.equal(channel.send("session-1", "hello", { droppedOutputMayAffectTerminalState: true }), true);

  const entry = channel.getSessionForTest("session-1");
  assert.deepEqual(entry.port.messages, [
    {
      sessionId: "session-1",
      data: "hello",
      meta: { droppedOutputMayAffectTerminalState: true },
    },
  ]);
});

test("openSession can reserve the output port for transfer to a worker", () => {
  const channel = createTerminalOutputChannel({
    MessageChannelMain: FakeMessageChannelMain,
  });
  const workerPort = channel.openSession("session-1", { id: 42, postMessage() {} }, {
    transferToWorker: true,
  });

  assert.equal(workerPort.label, "port1");
  assert.equal(channel.send("session-1", "hello"), false);
});

test("closeSession closes the output port and drops later output", () => {
  const channel = createTerminalOutputChannel({
    MessageChannelMain: FakeMessageChannelMain,
  });
  channel.openSession("session-1", { id: 42, postMessage() {} });
  const entry = channel.getSessionForTest("session-1");

  channel.closeSession("session-1");

  assert.equal(entry.port.closed, true);
  assert.equal(channel.send("session-1", "late"), false);
  assert.equal(channel.getSessionForTest("session-1"), undefined);
});

test("opening a replacement session closes the stale output port", () => {
  const channel = createTerminalOutputChannel({
    MessageChannelMain: FakeMessageChannelMain,
  });
  channel.openSession("session-1", { id: 42, postMessage() {} });
  const stale = channel.getSessionForTest("session-1");

  channel.openSession("session-1", { id: 42, postMessage() {} });

  assert.equal(stale.port.closed, true);
  assert.notEqual(channel.getSessionForTest("session-1"), stale);
});
