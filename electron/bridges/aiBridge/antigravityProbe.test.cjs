const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  findAntigravitySdk,
  getAntigravityAuth,
  probeAntigravitySdk,
  SDK_PROBE,
} = require("./antigravityProbe.cjs");
const { buildPythonInvocationArgs } = require("./sdk/pythonLauncher.cjs");

test("Antigravity authentication only accepts credentials supported by the SDK", () => {
  assert.deepEqual(getAntigravityAuth({ GOOGLE_API_KEY: "unsupported" }), {
    authenticated: false,
    authSource: null,
  });
  assert.deepEqual(getAntigravityAuth({ GEMINI_API_KEY: "supported" }), {
    authenticated: true,
    authSource: "GEMINI_API_KEY",
  });
  assert.deepEqual(getAntigravityAuth({ GOOGLE_GENAI_USE_VERTEXAI: "false" }), {
    authenticated: false,
    authSource: null,
  });
  assert.deepEqual(getAntigravityAuth({ GOOGLE_GENAI_USE_VERTEXAI: "true" }), {
    authenticated: false,
    authSource: null,
  });
});

test("probeAntigravitySdk reports an installed official SDK", async () => {
  const calls = [];
  const resultPromise = probeAntigravitySdk("/usr/bin/python3", { GEMINI_API_KEY: "key" }, {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.end('{"version":"0.1.8","pythonVersion":"3.12.4"}\n');
        child.emit("close", 0);
      });
      return child;
    },
  });

  assert.deepEqual(await resultPromise, {
    path: "/usr/bin/python3",
    binPath: "/usr/bin/python3",
    version: "Antigravity SDK 0.1.8 (Python 3.12.4)",
    installed: true,
    sdkReady: true,
    available: true,
    authenticated: true,
    authSource: "GEMINI_API_KEY",
  });
  assert.equal(calls[0].command, "/usr/bin/python3");
  assert.equal(calls[0].args[0], "-c");
  assert.equal(calls[0].args[1], SDK_PROBE);
  assert.match(SDK_PROBE, /from google\.antigravity import Agent, LocalAgentConfig, types/);
  assert.match(SDK_PROBE, /from google\.antigravity\.hooks import policy/);
});

test("probeAntigravitySdk distinguishes missing packages from missing credentials", async () => {
  const spawnWith = (stdout, exitCode) => () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end(stdout);
      child.emit("close", exitCode);
    });
    return child;
  };

  assert.deepEqual(await probeAntigravitySdk("/usr/bin/python3", {}, {
    spawn: spawnWith('{"version":"0.1.8","pythonVersion":"3.12.4"}\n', 0),
  }), {
    path: "/usr/bin/python3",
    binPath: "/usr/bin/python3",
    version: "Antigravity SDK 0.1.8 (Python 3.12.4)",
    installed: true,
    sdkReady: true,
    available: false,
    authenticated: false,
    authSource: null,
  });

  assert.deepEqual(await probeAntigravitySdk("/usr/bin/python3", {}, {
    spawn: spawnWith("", 1),
  }), {
    path: "/usr/bin/python3",
    binPath: "/usr/bin/python3",
    version: null,
    installed: false,
    sdkReady: false,
    available: false,
    authenticated: false,
    authSource: null,
  });
});

test("probeAntigravitySdk rejects SDK releases older than the supported protocol", async () => {
  const result = await probeAntigravitySdk("/usr/bin/python3", {}, {
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.end('{"version":"0.1.7","pythonVersion":"3.12.4"}\n');
        child.emit("close", 0);
      });
      return child;
    },
  });

  assert.equal(result.installed, true);
  assert.equal(result.sdkReady, false);
  assert.equal(result.available, false);
  assert.match(result.version, /0\.1\.7/);
});

test("probeAntigravitySdk times out and terminates a hung Python launcher", async () => {
  const signals = [];
  const result = await probeAntigravitySdk("/usr/bin/python3", {}, {
    timeoutMs: 5,
    killGraceMs: 5,
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") child.emit("close", null);
        return true;
      };
      return child;
    },
  });

  assert.equal(result.available, false);
  assert.equal(result.installed, false);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("findAntigravitySdk probes every distinct Python until it finds the SDK", async () => {
  const probed = [];
  const result = await findAntigravitySdk({}, {
    async resolve(command) {
      return command === "python3" ? "/usr/bin/python3" : "/opt/python/bin/python";
    },
    async probe(pythonPath) {
      probed.push(pythonPath);
      return {
        path: pythonPath,
        binPath: pythonPath,
        version: pythonPath.includes("/opt/") ? "Antigravity SDK 0.1.8" : null,
        installed: pythonPath.includes("/opt/"),
        sdkReady: pythonPath.includes("/opt/"),
        available: false,
        authenticated: false,
        authSource: null,
      };
    },
  });

  assert.deepEqual(probed, ["/usr/bin/python3", "/opt/python/bin/python"]);
  assert.equal(result.path, "/opt/python/bin/python");
});

test("Windows discovery supports the standard py launcher", async () => {
  assert.deepEqual(
    buildPythonInvocationArgs("C:\\Windows\\py.exe", ["-c", "print('ok')"], "win32"),
    ["-3", "-c", "print('ok')"],
  );
  const resolvedCommands = [];
  const result = await findAntigravitySdk({}, {
    platform: "win32",
    async resolve(command) {
      resolvedCommands.push(command);
      return command === "py" ? "C:\\Windows\\py.exe" : null;
    },
    async probe(pythonPath) {
      return {
        path: pythonPath,
        binPath: pythonPath,
        version: "Antigravity SDK 0.1.8",
        installed: true,
        sdkReady: true,
        available: true,
        authenticated: true,
        authSource: "GEMINI_API_KEY",
      };
    },
  });

  assert.deepEqual(resolvedCommands, ["python3", "python", "py"]);
  assert.equal(result.path, "C:\\Windows\\py.exe");
});

test("probeAntigravitySdk accepts a verified Google Cloud environment", async () => {
  const result = await probeAntigravitySdk("/usr/bin/python3", {}, {
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.end('{"version":"0.1.8","pythonVersion":"3.12.4","authSource":"Google Cloud"}\n');
        child.emit("close", 0);
      });
      return child;
    },
  });

  assert.equal(result.sdkReady, true);
  assert.equal(result.available, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.authSource, "Google Cloud");
});
