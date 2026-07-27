const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  findAntigravityCli,
  isSupportedAntigravityCliVersion,
  parseAntigravityCliVersion,
  probeAntigravityCli,
} = require("./antigravityProbe.cjs");

function fakeProcess({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("close", code, null);
  });
  return child;
}

test("Antigravity CLI version parsing requires the reliable headless boundary", () => {
  assert.equal(parseAntigravityCliVersion("1.1.7\n"), "1.1.7");
  assert.equal(parseAntigravityCliVersion("agy version v1.1.4"), "1.1.4");
  assert.equal(parseAntigravityCliVersion("Antigravity"), null);
  assert.equal(isSupportedAntigravityCliVersion("1.1.4"), true);
  assert.equal(isSupportedAntigravityCliVersion("1.1.3"), false);
  assert.equal(isSupportedAntigravityCliVersion("2.0.0"), true);
});

test("probeAntigravityCli validates a supported official agy executable", async () => {
  const calls = [];
  const result = await probeAntigravityCli("/usr/local/bin/agy", { PATH: "/usr/bin" }, {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return args[0] === "--version"
        ? fakeProcess({ stdout: "1.1.7\n" })
        : fakeProcess({ stdout: "--print --print-timeout --dangerously-skip-permissions\nAvailable subcommands:\n  models\n" });
    },
  });

  assert.deepEqual(result, {
    path: "/usr/local/bin/agy",
    binPath: "/usr/local/bin/agy",
    version: "Antigravity CLI 1.1.7",
    cliVersion: "1.1.7",
    installed: true,
    cliReady: true,
    available: true,
    authenticated: false,
    authSource: null,
  });
  assert.deepEqual(calls, [{
    command: "/usr/local/bin/agy",
    args: ["--version"],
    options: {
      env: { PATH: "/usr/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    },
  }, {
    command: "/usr/local/bin/agy",
    args: ["--help"],
    options: {
      env: { PATH: "/usr/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    },
  }]);
});

test("probeAntigravityCli rejects another executable that only prints a version", async () => {
  const result = await probeAntigravityCli("/usr/bin/node", {}, {
    spawn(_command, args) {
      return args[0] === "--version"
        ? fakeProcess({ stdout: "v22.0.0\n" })
        : fakeProcess({ stdout: "Usage: node [options]" });
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.available, false);
});

test("probeAntigravityCli force-kills a hung probe after returning unavailable", async () => {
  const signals = [];
  const result = await probeAntigravityCli("/bin/agy", {}, {
    timeoutMs: 5,
    killGraceMs: 5,
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => { signals.push(signal); return true; };
      return child;
    },
  });
  assert.equal(result.available, false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Windows shim probe waits for full process-tree termination", async () => {
  const taskkillCalls = [];
  let finishTaskkill;
  let probeSettled = false;
  const probe = probeAntigravityCli("C:\\npm\\agy.cmd", {}, {
    platform: "win32",
    timeoutMs: 5,
    spawn() {
      const child = new EventEmitter();
      child.pid = 7331;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    },
    execFile(command, args, options, callback) {
      taskkillCalls.push({ command, args, options });
      finishTaskkill = callback;
    },
  });
  void probe.then(() => { probeSettled = true; });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(probeSettled, false);
  assert.deepEqual(taskkillCalls, [{
    command: "taskkill",
    args: ["/PID", "7331", "/T", "/F"],
    options: { windowsHide: true },
  }]);

  finishTaskkill(null);
  const result = await probe;
  assert.equal(result.available, false);
  assert.equal(probeSettled, true);
});

test("POSIX probe timeout terminates the detached process group", async () => {
  const signals = [];
  const result = await probeAntigravityCli("/opt/agy", {}, {
    platform: "linux",
    timeoutMs: 5,
    killGraceMs: 5,
    spawn() {
      const child = new EventEmitter();
      child.pid = 7441;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    },
    kill(pid, signal) {
      signals.push([pid, signal]);
    },
  });

  assert.equal(result.available, false);
  assert.deepEqual(signals, [
    [-7441, "SIGTERM"],
    [-7441, "SIGKILL"],
  ]);
});

test("probeAntigravityCli reports an outdated CLI without accepting it", async () => {
  const result = await probeAntigravityCli("/opt/bin/agy", {}, {
    spawn: () => fakeProcess({ stdout: "1.1.3\n" }),
  });
  assert.equal(result.installed, true);
  assert.equal(result.cliReady, false);
  assert.equal(result.available, false);
  assert.equal(result.cliVersion, "1.1.3");
});

test("probeAntigravityCli rejects a path that is not a working agy executable", async () => {
  const result = await probeAntigravityCli("/tmp/not-agy", {}, {
    spawn: () => fakeProcess({ stderr: "not found", code: 1 }),
  });
  assert.deepEqual(result, {
    path: "/tmp/not-agy",
    binPath: "/tmp/not-agy",
    version: null,
    cliVersion: null,
    installed: true,
    cliReady: false,
    available: false,
    authenticated: false,
    authSource: null,
  });
});

test("findAntigravityCli discovers the official agy command", async () => {
  const resolved = [];
  const result = await findAntigravityCli({}, {
    async resolve(command) {
      resolved.push(command);
      return "/Users/me/.local/bin/agy";
    },
    async probe(cliPath) {
      return {
        path: cliPath,
        binPath: cliPath,
        version: "Antigravity CLI 1.1.7",
        cliVersion: "1.1.7",
        installed: true,
        cliReady: true,
        available: true,
        authenticated: false,
        authSource: null,
      };
    },
  });
  assert.deepEqual(resolved, ["agy"]);
  assert.equal(result.path, "/Users/me/.local/bin/agy");
});

test("findAntigravityCli falls back to the antigravity command name", async () => {
  const resolved = [];
  const result = await findAntigravityCli({}, {
    async resolve(command) {
      resolved.push(command);
      return command === "antigravity" ? "/opt/bin/antigravity" : null;
    },
    async probe(cliPath) {
      return {
        path: cliPath,
        binPath: cliPath,
        version: "Antigravity CLI 1.1.7",
        cliVersion: "1.1.7",
        installed: true,
        cliReady: true,
        available: true,
        authenticated: false,
        authSource: null,
      };
    },
  });
  assert.deepEqual(resolved, ["agy", "antigravity"]);
  assert.equal(result.path, "/opt/bin/antigravity");
});

test("findAntigravityCli continues after an unusable agy candidate", async () => {
  const probed = [];
  const result = await findAntigravityCli({}, {
    async resolve(command) {
      return `/opt/bin/${command}`;
    },
    async probe(cliPath) {
      probed.push(cliPath);
      if (cliPath.endsWith("/agy")) {
        return {
          path: cliPath,
          binPath: cliPath,
          version: "Antigravity CLI 1.1.3",
          cliVersion: "1.1.3",
          installed: true,
          cliReady: false,
          available: false,
          authenticated: false,
          authSource: null,
        };
      }
      return {
        path: cliPath,
        binPath: cliPath,
        version: "Antigravity CLI 1.1.7",
        cliVersion: "1.1.7",
        installed: true,
        cliReady: true,
        available: true,
        authenticated: false,
        authSource: null,
      };
    },
  });

  assert.deepEqual(probed, ["/opt/bin/agy", "/opt/bin/antigravity"]);
  assert.equal(result.path, "/opt/bin/antigravity");
  assert.equal(result.available, true);
});

test("findAntigravityCli reports a missing installation", async () => {
  const result = await findAntigravityCli({}, { resolve: async () => null });
  assert.deepEqual(result, {
    path: null,
    binPath: null,
    version: null,
    cliVersion: null,
    installed: false,
    cliReady: false,
    available: false,
    authenticated: false,
    authSource: null,
  });
});
