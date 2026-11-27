"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMcpStdioLifecycle } = require("./mcpStdioLifecycle.cjs");

function createFakeProcess(overrides = {}) {
  const proc = new EventEmitter();
  proc.platform = "linux";
  proc.ppid = 4242;
  proc.kill = () => true;
  proc.exit = () => {};
  return Object.assign(proc, overrides);
}

test("exits cleanly on stdin end and ignores duplicate triggers", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const reasons = [];
  const exits = [];

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    onShutdown: async (reason) => {
      reasons.push(reason);
    },
    exit: (code) => exits.push(code),
  });

  lifecycle.attach();
  stdin.emit("end");
  stdin.emit("close");
  proc.emit("SIGTERM");

  await lifecycle.shutdown("manual");
  assert.deepEqual(reasons, ["stdin_end"]);
  assert.deepEqual(exits, [0]);
  assert.equal(lifecycle.isShuttingDown(), true);
});

test("exits immediately on attach when stdin is already ended", async () => {
  const stdin = Object.assign(new EventEmitter(), { readableEnded: true });
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const reasons = [];
  const exits = [];

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    onShutdown: (reason) => reasons.push(reason),
    exit: (code) => exits.push(code),
  });

  lifecycle.attach();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ["stdin_already_closed"]);
  assert.deepEqual(exits, [0]);
});

test("handles stdout EPIPE as clean exit and unexpected stdout error as exit 1", async () => {
  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const exits = [];
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit: (code) => exits.push(code),
    });
    lifecycle.attach();
    stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [0]);
  }

  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const exits = [];
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit: (code) => exits.push(code),
    });
    lifecycle.attach();
    stdout.emit("error", Object.assign(new Error("io failure"), { code: "EIO" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [1]);
  }
});

test("bindTransport preserves existing onclose handler and triggers shutdown", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const order = [];
  const exits = [];

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    onShutdown: (reason) => order.push(`shutdown:${reason}`),
    exit: (code) => exits.push(code),
  });

  const transport = {
    onclose: () => order.push("prev_onclose"),
  };
  lifecycle.bindTransport(transport);
  lifecycle.attach();

  transport.onclose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["prev_onclose", "shutdown:transport_close"]);
  assert.deepEqual(exits, [0]);
});

test("forces exit if onShutdown hangs past forceExitMs", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const exits = [];

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    forceExitMs: 30,
    onShutdown: () => new Promise(() => {}),
    exit: (code) => exits.push(code),
  });

  lifecycle.attach();
  proc.emit("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(exits, [0]);
});

test("parent PID watchdog exits on ESRCH but treats EPERM as alive", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  let state = "eperm";
  const proc = createFakeProcess({
    platform: "win32",
    ppid: 9999,
    kill: () => {
      if (state === "eperm") {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }
      if (state === "esrch") {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    },
  });
  const reasons = [];
  const exits = [];

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: true,
    parentPollIntervalMs: 15,
    onShutdown: (reason) => reasons.push(reason),
    exit: (code) => exits.push(code),
  });

  lifecycle.attach();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(reasons, []);
  assert.deepEqual(exits, []);

  state = "esrch";
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(reasons, ["parent_exited"]);
  assert.deepEqual(exits, [0]);
});

test("detach removes listeners and prevents later shutdowns", () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const exits = [];

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    exit: (code) => exits.push(code),
  });

  lifecycle.attach();
  assert.equal(stdin.listenerCount("end"), 1);
  assert.equal(stdin.listenerCount("close"), 1);
  assert.equal(stdin.listenerCount("error"), 1);
  assert.equal(stdout.listenerCount("close"), 1);
  assert.equal(stdout.listenerCount("error"), 1);

  lifecycle.detach();
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(stdin.listenerCount("close"), 0);
  assert.equal(stdin.listenerCount("error"), 0);
  assert.equal(stdout.listenerCount("close"), 0);
  assert.equal(stdout.listenerCount("error"), 0);

  stdin.emit("end");
  assert.deepEqual(exits, []);
});

test("handles stdin ECONNRESET cleanly and unexpected stdin error with exit 1", async () => {
  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const exits = [];
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit: (code) => exits.push(code),
    });
    lifecycle.attach();
    stdin.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [0]);
  }

  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const exits = [];
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit: (code) => exits.push(code),
    });
    lifecycle.attach();
    stdin.emit("error", Object.assign(new Error("io error"), { code: "EIO" }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [1]);
  }
});
