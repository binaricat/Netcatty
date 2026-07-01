"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { registerWorkerAiExecHandlers } = require("./aiExec.cjs");

class FakePty extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(data) {
    this.writes.push(String(data));
  }
}

function createFakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
  };
}

function createFakeEvent() {
  const rendererMessages = [];
  return {
    rendererMessages,
    sender: {
      send(channel, payload) {
        rendererMessages.push({ channel, payload });
      },
    },
  };
}

function extractMarker(writes) {
  const wrapper = writes.find((entry) => entry.includes("__NCMCP_"));
  assert.ok(wrapper, "expected wrapped command to be written to the PTY");
  const match = wrapper.match(/(__NCMCP_[A-Za-z0-9_]+__)/);
  assert.ok(match, "expected command wrapper to contain an MCP marker");
  return match[1];
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("worker AI background jobs start, poll, stop, and block overlapping exec", async () => {
  const pty = new FakePty();
  const sessions = new Map([
    ["ssh-1", {
      protocol: "ssh",
      stream: pty,
      shellKind: "posix",
    }],
  ]);
  const ipcMain = createFakeIpcMain();
  registerWorkerAiExecHandlers(ipcMain, { sessions });

  assert.equal(typeof ipcMain.handlers.get("netcatty:ai:jobStart"), "function");
  assert.equal(typeof ipcMain.handlers.get("netcatty:ai:jobPoll"), "function");
  assert.equal(typeof ipcMain.handlers.get("netcatty:ai:jobStop"), "function");

  const event = createFakeEvent();
  const started = await ipcMain.handlers.get("netcatty:ai:jobStart")(event, {
    sessionId: "ssh-1",
    command: "npm test",
    chatSessionId: "chat-1",
    commandTimeoutMs: 5000,
  });

  assert.equal(started.ok, true);
  assert.equal(started.sessionId, "ssh-1");
  assert.equal(started.command, "npm test");
  assert.equal(started.status, "running");
  assert.equal(started.outputMode, "foreground-mirrored");
  assert.deepEqual(event.rendererMessages, [
    {
      channel: "netcatty:data",
      payload: {
        sessionId: "ssh-1",
        data: "npm test\r\n",
        syntheticEcho: true,
      },
    },
  ]);

  const marker = extractMarker(pty.writes);
  pty.emit("data", `${marker}_S\r\nready\r\n`);
  await nextTick();

  const polled = await ipcMain.handlers.get("netcatty:ai:jobPoll")(event, {
    jobId: started.jobId,
    offset: 0,
    chatSessionId: "chat-1",
  });

  assert.equal(polled.ok, true);
  assert.equal(polled.completed, false);
  assert.equal(polled.output, "ready\n");
  assert.equal(polled.nextOffset, "ready\n".length);

  const busy = await ipcMain.handlers.get("netcatty:ai:exec")(event, {
    sessionId: "ssh-1",
    command: "pwd",
    chatSessionId: "chat-1",
  });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /already has a long-running command in progress/);

  const stopped = await ipcMain.handlers.get("netcatty:ai:jobStop")(event, {
    jobId: started.jobId,
    chatSessionId: "chat-1",
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status, "stopping");
  assert.ok(pty.writes.includes("\x03"), "expected stop to send Ctrl+C to the PTY");

  pty.emit("data", `${marker}_E:130\r\n`);
  await nextTick();

  const cancelled = await ipcMain.handlers.get("netcatty:ai:jobPoll")(event, {
    jobId: started.jobId,
    offset: 0,
    chatSessionId: "chat-1",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.completed, true);
  assert.equal(cancelled.error, "Cancelled");
});

test("worker chat cancellation stops matching background jobs", async () => {
  const pty = new FakePty();
  const sessions = new Map([
    ["ssh-1", {
      protocol: "ssh",
      stream: pty,
      shellKind: "posix",
    }],
  ]);
  const ipcMain = createFakeIpcMain();
  registerWorkerAiExecHandlers(ipcMain, { sessions });

  const event = createFakeEvent();
  const started = await ipcMain.handlers.get("netcatty:ai:jobStart")(event, {
    sessionId: "ssh-1",
    command: "sleep 30",
    chatSessionId: "chat-1",
    commandTimeoutMs: 5000,
  });
  const marker = extractMarker(pty.writes);
  pty.emit("data", `${marker}_S\r\nrunning\r\n`);
  await nextTick();

  ipcMain.listeners.get("netcatty:ai:catty:cancel")(event, {
    chatSessionId: "chat-1",
  });

  assert.ok(pty.writes.includes("\x03"), "expected chat cancellation to send Ctrl+C to the background job");

  const stopping = await ipcMain.handlers.get("netcatty:ai:jobPoll")(event, {
    jobId: started.jobId,
    offset: 0,
    chatSessionId: "chat-1",
  });
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.error, "Cancellation requested");

  pty.emit("data", `${marker}_E:130\r\n`);
  await nextTick();

  const cancelled = await ipcMain.handlers.get("netcatty:ai:jobPoll")(event, {
    jobId: started.jobId,
    offset: 0,
    chatSessionId: "chat-1",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.completed, true);
});
