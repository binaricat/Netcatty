const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  buildAntigravityCliArgs,
  formatAntigravityCliFailure,
  getAntigravityPromptByteLimit,
  listAntigravityModels,
  runAntigravityTurn,
  signalAntigravityProcessTree,
} = require("./antigravityDriver.cjs");

function makeEmitter() {
  const calls = [];
  return {
    calls,
    text: (value) => calls.push(["text", value]),
    status: (value) => calls.push(["status", value]),
    emitDone: () => calls.push(["done"]),
  };
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    return true;
  };
  return child;
}

test("buildAntigravityCliArgs maps Netcatty permission modes without unsafe defaults", () => {
  assert.deepEqual(buildAntigravityCliArgs({
    prompt: "inspect",
    model: "gemini-3-pro",
    permissionMode: "observer",
    cwd: "/workspace",
  }), [
    "--print=inspect", "--print-timeout", "5m", "--model", "gemini-3-pro",
    "--add-dir", "/workspace", "--mode", "plan", "--sandbox",
  ]);

  assert.deepEqual(buildAntigravityCliArgs({
    prompt: "inspect",
    permissionMode: "confirm",
    cwd: "/workspace",
  }), ["--print=inspect", "--print-timeout", "5m", "--add-dir", "/workspace", "--mode", "plan", "--sandbox"]);

  assert.deepEqual(buildAntigravityCliArgs({
    prompt: "change it",
    permissionMode: "auto",
  }), [
    "--print=change it", "--print-timeout", "5m",
    "--dangerously-skip-permissions",
  ]);
});

test("buildAntigravityCliArgs rejects prompts too large for argv", () => {
  assert.throws(
    () => buildAntigravityCliArgs({ prompt: "x".repeat(300_000) }),
    /too large/i,
  );
});

test("Windows command shims use a cmd.exe-safe prompt budget", () => {
  assert.equal(getAntigravityPromptByteLimit("C:\\npm\\agy.cmd"), 5 * 1024);
  assert.equal(getAntigravityPromptByteLimit("C:\\bin\\agy.exe"), 24 * 1024);
  assert.doesNotThrow(() => buildAntigravityCliArgs({
    binPath: "C:\\npm\\agy.cmd",
    prompt: "x".repeat(5 * 1024),
  }));
  assert.throws(() => buildAntigravityCliArgs({
    binPath: "C:\\npm\\agy.cmd",
    prompt: "x".repeat((5 * 1024) + 1),
  }), /maximum 5120/);
  assert.throws(() => buildAntigravityCliArgs({
    binPath: "C:\\project\\node_modules\\.bin\\agy.cmd",
    prompt: "&%!^".repeat(1000),
  }), /Windows command-shell characters/);
});

test("runAntigravityTurn closes stdin, captures the final response, and emits done", async () => {
  const child = fakeChild();
  const emitter = makeEmitter();
  const observed = [];
  const writtenConfigs = [];
  const cleaned = [];
  const turn = runAntigravityTurn({
    prompt: "hello",
    cwd: "/workspace",
    model: "gemini-3-pro",
    permissionMode: "confirm",
    env: { PATH: "/bin" },
    binPath: "/usr/local/bin/agy",
    emitter,
    injectedMcpServers: [],
  }, {
    spawn(command, args, options) {
      observed.push({ command, args, options });
      return child;
    },
    timeoutMs: 1000,
    createTurnDirectory: () => "/netcatty-temp/agy-turn-1",
    writeMcpConfig: (dir, servers) => writtenConfigs.push({ dir, servers }),
    cleanupTurnDirectory: (dir) => cleaned.push(dir),
  });

  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write("Hello from Agy\n");
  child.stderr.end();
  child.stdout.end();
  child.emit("close", 0, null);

  assert.deepEqual(await turn, { sessionId: null });
  assert.deepEqual(observed, [{
    command: "/usr/local/bin/agy",
    args: ["--print=hello", "--print-timeout", "5m", "--model", "gemini-3-pro", "--add-dir", "/workspace", "--mode", "plan", "--sandbox"],
    options: {
      cwd: "/netcatty-temp/agy-turn-1",
      env: { PATH: "/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    },
  }]);
  assert.deepEqual(writtenConfigs, [{ dir: "/netcatty-temp/agy-turn-1", servers: [] }]);
  assert.deepEqual(cleaned, ["/netcatty-temp/agy-turn-1"]);
  assert.deepEqual(emitter.calls, [["text", "Hello from Agy\n"], ["done"]]);
});

test("runAntigravityTurn reports stderr and does not emit partial stdout on failure", async () => {
  const child = fakeChild();
  const emitter = makeEmitter();
  const turn = runAntigravityTurn({
    prompt: "hello",
    cwd: "/workspace",
    binPath: "/bin/agy",
    emitter,
  }, { spawn: () => child, timeoutMs: 1000 });

  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.end("partial answer");
  child.stderr.end("permission confirmation required");
  child.emit("close", 1, null);

  await assert.rejects(turn, /permission confirmation required/);
  assert.deepEqual(emitter.calls, []);
});

test("runAntigravityTurn times out and terminates the full process tree", async () => {
  const child = fakeChild();
  const signals = [];
  const turn = runAntigravityTurn({
    prompt: "hang",
    binPath: "/bin/agy",
    emitter: makeEmitter(),
  }, {
    spawn: () => child,
    timeoutMs: 5,
    killGraceMs: 5,
    signalProcessTree(_child, signal) {
      signals.push(signal);
      if (signal === "SIGTERM") child.emit("close", null, "SIGTERM");
    },
  });

  await assert.rejects(turn, /timed out/i);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("runAntigravityTurn terminates immediately when captured output is too large", async () => {
  const child = fakeChild();
  const signals = [];
  const turn = runAntigravityTurn({
    prompt: "large output", binPath: "/bin/agy", emitter: makeEmitter(),
  }, {
    spawn: () => child,
    timeoutMs: 1000,
    killGraceMs: 5,
    maxOutputBytes: 4,
    signalProcessTree(_child, signal) {
      signals.push(signal);
      child.emit("close", null, signal);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write("12345");
  await assert.rejects(turn, /capture limit/i);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("runAntigravityTurn treats user cancellation as a soft stop", async () => {
  const child = fakeChild();
  const emitter = makeEmitter();
  const controller = new AbortController();
  const signals = [];
  const turn = runAntigravityTurn({
    prompt: "stop",
    binPath: "/bin/agy",
    emitter,
    signal: controller.signal,
  }, {
    spawn: () => child,
    timeoutMs: 1000,
    killGraceMs: 5,
    signalProcessTree(_child, signal) {
      signals.push(signal);
      child.emit("close", null, signal);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await turn, { sessionId: null });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(emitter.calls, []);
});

test("listAntigravityModels parses model ids and supports cancellation", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const result = listAntigravityModels({
    binPath: "/bin/agy", env: { PATH: "/bin" }, signal: controller.signal,
  }, { spawn: () => child, timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.end("gemini-3.6-flash-high\nclaude-sonnet-4-6\n");
  child.stderr.end();
  child.emit("close", 0, null);
  assert.deepEqual(await result, {
    currentModelId: null,
    models: [
      { id: "gemini-3.6-flash-high", name: "gemini-3.6-flash-high" },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    ],
  });
});

test("listAntigravityModels returns promptly when cancelled", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const result = listAntigravityModels({
    binPath: "/bin/agy", signal: controller.signal,
  }, {
    spawn: () => child,
    timeoutMs: 1000,
    killGraceMs: 5,
    signalProcessTree(_child, signal) {
      child.kill(signal);
      child.emit("close", null, signal);
    },
  });
  controller.abort();
  assert.deepEqual(await result, { currentModelId: null, models: [] });
  assert.equal(child.killSignal, "SIGKILL");
});

test("signalAntigravityProcessTree targets the POSIX process group", async () => {
  const signals = [];
  await signalAntigravityProcessTree(fakeChild(4321), "SIGTERM", {
    platform: "linux",
    kill(pid, signal) { signals.push([pid, signal]); },
  });
  assert.deepEqual(signals, [[-4321, "SIGTERM"]]);
});

test("signalAntigravityProcessTree uses taskkill for a Windows process tree", async () => {
  const calls = [];
  await signalAntigravityProcessTree(fakeChild(4321), "SIGKILL", {
    platform: "win32",
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null);
    },
  });
  assert.deepEqual(calls, [{
    command: "taskkill",
    args: ["/PID", "4321", "/T", "/F"],
    options: { windowsHide: true },
  }]);
});

test("Windows cancellation waits for taskkill before cleaning the private turn directory", async () => {
  const child = fakeChild(9001);
  const controller = new AbortController();
  const callbacks = [];
  const cleaned = [];
  const turn = runAntigravityTurn({
    prompt: "stop", cwd: "/workspace", binPath: "C:\\agy.exe",
    signal: controller.signal, emitter: makeEmitter(),
  }, {
    spawn: () => child,
    platform: "win32",
    execFile(_command, _args, _options, callback) { callbacks.push(callback); },
    createTurnDirectory: () => "C:\\Netcatty\\agy-turn-1",
    writeMcpConfig() {},
    cleanupTurnDirectory: (dir) => cleaned.push(dir),
    timeoutMs: 1000,
    killGraceMs: 5,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  child.emit("close", null, "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cleaned, []);
  callbacks[0](null);
  assert.deepEqual(await turn, { sessionId: null });
  assert.deepEqual(cleaned, ["C:\\Netcatty\\agy-turn-1"]);
});

test("model cancellation escalates from process-tree SIGTERM to SIGKILL", async () => {
  const child = fakeChild(9101);
  const controller = new AbortController();
  const signals = [];
  const result = listAntigravityModels({ binPath: "/bin/agy", signal: controller.signal }, {
    spawn: () => child,
    killGraceMs: 5,
    signalProcessTree(_child, signal) {
      signals.push(signal);
      if (signal === "SIGTERM") child.emit("close", null, signal);
    },
  });
  controller.abort();
  assert.deepEqual(await result, { currentModelId: null, models: [] });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("formatAntigravityCliFailure gives actionable authentication guidance", () => {
  assert.match(formatAntigravityCliFailure("not authenticated", 1), /run `agy`/i);
  assert.equal(formatAntigravityCliFailure("quota exceeded", 1), "quota exceeded");
});
