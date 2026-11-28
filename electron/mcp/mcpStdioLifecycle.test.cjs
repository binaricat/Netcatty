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

function createExitWaiter(timeoutMs = 2000) {
  const exits = [];
  let resolveExit;
  const exited = new Promise((resolve, reject) => {
    // Keep this timer referenced until exit() clears it so isolated unit tests
    // with fake streams and unref'd lifecycle timers stay alive until shutdown.
    const timer = setTimeout(() => {
      reject(new Error(`exit was not called within ${timeoutMs}ms`));
    }, timeoutMs);
    resolveExit = (code) => {
      clearTimeout(timer);
      resolve(code);
    };
  });
  return {
    exits,
    exited,
    exit: (code) => {
      exits.push(code);
      resolveExit(code);
    },
  };
}

test("exits cleanly on stdin end and ignores duplicate triggers", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const reasons = [];
  const { exits, exit } = createExitWaiter();

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    onShutdown: async (reason) => {
      reasons.push(reason);
    },
    exit,
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

test("exits immediately on attach when stdin or stdout is already closed", async () => {
  {
    const stdin = Object.assign(new EventEmitter(), { readableEnded: true });
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const reasons = [];
    const { exits, exited, exit } = createExitWaiter();

    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      onShutdown: (reason) => reasons.push(reason),
      exit,
    });

    lifecycle.attach();
    assert.equal(await exited, 0);
    assert.deepEqual(reasons, ["stdin_already_closed"]);
    assert.deepEqual(exits, [0]);
  }

  {
    const stdin = new EventEmitter();
    const stdout = Object.assign(new EventEmitter(), { writableEnded: true });
    const proc = createFakeProcess();
    const reasons = [];
    const { exits, exited, exit } = createExitWaiter();

    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      onShutdown: (reason) => reasons.push(reason),
      exit,
    });

    lifecycle.attach();
    assert.equal(await exited, 0);
    assert.deepEqual(reasons, ["stdout_already_closed"]);
    assert.deepEqual(exits, [0]);
  }
});

test("primes paused stdin via read(0) without consuming buffered data", () => {
  const readCalls = [];
  const stdin = Object.assign(new EventEmitter(), {
    readableFlowing: null,
    read: (size) => {
      readCalls.push(size);
      return null;
    },
  });
  const stdout = new EventEmitter();
  const proc = createFakeProcess();

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
  });

  lifecycle.attach();
  assert.deepEqual(readCalls, [0]);
  assert.equal(stdin.listenerCount("data"), 0);
  lifecycle.detach();
});

test("handles stdout EPIPE as clean exit and unexpected stdout error as exit 1", async () => {
  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const { exits, exited, exit } = createExitWaiter();
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit,
    });
    lifecycle.attach();
    stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    assert.equal(await exited, 0);
    assert.deepEqual(exits, [0]);
  }

  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const { exits, exited, exit } = createExitWaiter();
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit,
    });
    lifecycle.attach();
    stdout.emit("error", Object.assign(new Error("io failure"), { code: "EIO" }));
    assert.equal(await exited, 1);
    assert.deepEqual(exits, [1]);
  }
});

test("handles stdin ECONNRESET cleanly and unexpected stdin error with exit 1", async () => {
  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const { exits, exited, exit } = createExitWaiter();
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit,
    });
    lifecycle.attach();
    stdin.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    assert.equal(await exited, 0);
    assert.deepEqual(exits, [0]);
  }

  {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const proc = createFakeProcess();
    const { exits, exited, exit } = createExitWaiter();
    const lifecycle = createMcpStdioLifecycle({
      stdin,
      stdout,
      proc,
      watchParentPid: false,
      exit,
    });
    lifecycle.attach();
    stdin.emit("error", Object.assign(new Error("io error"), { code: "EIO" }));
    assert.equal(await exited, 1);
    assert.deepEqual(exits, [1]);
  }
});

test("keeps stdin and stdout error handlers alive during async onShutdown", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const { exits, exited, exit } = createExitWaiter();
  let finishShutdown;
  let resolveStarted;
  const shutdownStarted = new Promise((resolve) => {
    resolveStarted = resolve;
  });

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    onShutdown: () => new Promise((resolve) => {
      finishShutdown = resolve;
      resolveStarted();
    }),
    exit,
  });

  lifecycle.attach();
  stdin.emit("end");
  await shutdownStarted;

  // Emit stream errors asynchronously while onShutdown is still pending.
  assert.doesNotThrow(() => {
    stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    stdin.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
  });

  finishShutdown();
  assert.equal(await exited, 0);
  assert.deepEqual(exits, [0]);
});

test("swallows onLog and onShutdown errors and still exits cleanly", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const { exits, exited, exit } = createExitWaiter();

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    onLog: () => {
      throw new Error("stderr EPIPE");
    },
    onShutdown: async () => {
      throw new Error("close failed");
    },
    exit,
  });

  lifecycle.attach();
  stdin.emit("end");
  assert.equal(await exited, 0);
  assert.deepEqual(exits, [0]);
});

test("bindTransport preserves existing onclose handler and triggers shutdown", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const order = [];
  const { exits, exited, exit } = createExitWaiter();

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    onShutdown: (reason) => order.push(`shutdown:${reason}`),
    exit,
  });

  const transport = {
    onclose: () => order.push("prev_onclose"),
  };
  lifecycle.bindTransport(transport);
  lifecycle.attach();

  transport.onclose();
  assert.equal(await exited, 0);
  assert.deepEqual(order, ["prev_onclose", "shutdown:transport_close"]);
  assert.deepEqual(exits, [0]);
});

test("forces exit if onShutdown hangs past forceExitMs", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess();
  const { exits, exited, exit } = createExitWaiter();

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    forceExitMs: 25,
    onShutdown: () => new Promise(() => {}),
    exit,
  });

  lifecycle.attach();
  proc.emit("SIGINT");
  assert.equal(await exited, 0);
  assert.deepEqual(exits, [0]);
});

test("parent PID watchdog exits immediately when parent is already gone on attach", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess({
    platform: "win32",
    ppid: 9999,
    kill: () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    },
  });
  const reasons = [];
  const { exits, exited, exit } = createExitWaiter();

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: true,
    onShutdown: (reason) => reasons.push(reason),
    exit,
  });

  lifecycle.attach();
  assert.equal(await exited, 0);
  assert.deepEqual(reasons, ["parent_exited"]);
  assert.deepEqual(exits, [0]);
});

test("parent PID watchdog exits on ESRCH but treats EPERM as alive", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  let state = "eperm";
  let killChecks = 0;
  let resolveEpermChecks;
  const epermObserved = new Promise((resolve) => {
    resolveEpermChecks = resolve;
  });
  const proc = createFakeProcess({
    platform: "win32",
    ppid: 9999,
    kill: () => {
      killChecks += 1;
      if (state === "eperm") {
        if (killChecks >= 3) resolveEpermChecks();
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }
      if (state === "esrch") {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    },
  });
  const reasons = [];
  const { exits, exited, exit } = createExitWaiter();

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: true,
    parentPollIntervalMs: 10,
    onShutdown: (reason) => reasons.push(reason),
    exit,
  });

  lifecycle.attach();
  await epermObserved;
  assert.deepEqual(reasons, []);
  assert.deepEqual(exits, []);

  state = "esrch";
  assert.equal(await exited, 0);
  assert.deepEqual(reasons, ["parent_exited"]);
  assert.deepEqual(exits, [0]);
});

test("detach removes listeners and unbinds transport wrappers", () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const proc = createFakeProcess({ platform: "win32" });
  const exits = [];
  let prevCloseCalls = 0;
  const prevOnClose = () => {
    prevCloseCalls += 1;
  };
  const transport = { onclose: prevOnClose };

  const lifecycle = createMcpStdioLifecycle({
    stdin,
    stdout,
    proc,
    watchParentPid: false,
    exit: (code) => exits.push(code),
  });

  lifecycle.bindTransport(transport);
  lifecycle.attach();
  assert.equal(stdin.listenerCount("end"), 1);
  assert.equal(stdin.listenerCount("close"), 1);
  assert.equal(stdin.listenerCount("error"), 1);
  assert.equal(stdout.listenerCount("close"), 1);
  assert.equal(stdout.listenerCount("error"), 1);
  assert.equal(proc.listenerCount("SIGBREAK"), 1);

  lifecycle.detach();
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(stdin.listenerCount("close"), 0);
  assert.equal(stdin.listenerCount("error"), 0);
  assert.equal(stdout.listenerCount("close"), 0);
  assert.equal(stdout.listenerCount("error"), 0);
  assert.equal(proc.listenerCount("SIGBREAK"), 0);
  assert.equal(transport.onclose, prevOnClose);

  stdin.emit("end");
  transport.onclose();
  assert.equal(prevCloseCalls, 1);
  assert.deepEqual(exits, []);
});
