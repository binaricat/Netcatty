const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// mimoDriver.cjs destructures `spawn` / `spawnSync` from child_process at load
// time, so the only way to observe the launch argv without starting a real
// process is to swap them on the module before requiring the driver. This runs
// in its own node --test process, so the patch cannot leak into other files.
const childProcess = require("node:child_process");
const realSpawn = childProcess.spawn;
const realSpawnSync = childProcess.spawnSync;
let spawnMock = null;
let spawnSyncMock = null;
childProcess.spawn = (command, args, options) =>
  (spawnMock ? spawnMock(command, args, options) : realSpawn(command, args, options));
childProcess.spawnSync = (command, args, options) =>
  (spawnSyncMock ? spawnSyncMock(command, args, options) : realSpawnSync(command, args, options));

const {
  MIMO_SERVE_TIMEOUT_MS,
  listMimoModels,
  resolveUsableMimoBinPath,
  runMimoTurn,
  spawnMimoServer,
  stopMimoProcess,
} = require("./mimoDriver.cjs");

function collector() {
  const events = [];
  const emitter = {
    text: (t) => events.push({ k: "text", t }),
    reasoning: (d) => events.push({ k: "reasoning", d }),
    toolCall: (name, args, id) => events.push({ k: "toolCall", name, args, id }),
    toolResult: (id, out, name) => events.push({ k: "toolResult", id, out, name }),
    status: (m) => events.push({ k: "status", m }),
    sessionId: (s) => events.push({ k: "sessionId", s }),
    emitDone: () => events.push({ k: "done" }),
    emitError: (m) => events.push({ k: "error", m }),
  };
  return { events, emitter };
}

function connectedStream(stream) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "server.connected" } };
      yield* stream;
    },
  };
}

// Minimal ChildProcess stand-in with only the members spawnMimoServer touches.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killCount = 0;
  child.kill = () => {
    child.killCount += 1;
    child.exitCode = 0;
  };
  return child;
}

function tempBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mimo-test-"));
  return dir;
}

test("MIMO_SERVE_TIMEOUT_MS matches the documented cold-start budget", () => {
  assert.equal(MIMO_SERVE_TIMEOUT_MS, 10_000);
});

test("resolveUsableMimoBinPath returns only existing files and honours candidate order", () => {
  const dir = tempBinDir();
  const explicitBin = path.join(dir, "explicit-mimo");
  const envBin = path.join(dir, "env-mimo");
  const envBinPath = path.join(dir, "env-bin-path-mimo");
  fs.writeFileSync(explicitBin, "");
  fs.writeFileSync(envBin, "");
  fs.writeFileSync(envBinPath, "");

  try {
    assert.equal(
      resolveUsableMimoBinPath("/definitely/missing/mimo", {
        MIMOCODE_BIN: "/also/missing",
        MIMOCODE_BIN_PATH: "/nope",
      }),
      undefined,
    );
    // A directory is not a runnable file and must be ignored.
    assert.equal(resolveUsableMimoBinPath(dir, {}), undefined);
    assert.equal(
      resolveUsableMimoBinPath(explicitBin, { MIMOCODE_BIN: envBin, MIMOCODE_BIN_PATH: envBinPath }),
      explicitBin,
    );
    assert.equal(resolveUsableMimoBinPath(null, { MIMOCODE_BIN: envBin, MIMOCODE_BIN_PATH: envBinPath }), envBin);
    assert.equal(resolveUsableMimoBinPath(null, { MIMOCODE_BIN_PATH: envBinPath }), envBinPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnMimoServer launches `mimo serve` with hostname/port argv and passes MIMOCODE_CONFIG_CONTENT", async () => {
  const dir = tempBinDir();
  const bin = path.join(dir, "mimo-bin");
  fs.writeFileSync(bin, "");
  const calls = [];
  const child = fakeChild();
  spawnMock = (command, args, options) => {
    calls.push({ command, args, options });
    setImmediate(() => child.stdout.emit("data", Buffer.from("mimocode server listening on http://127.0.0.1:5123\n")));
    return child;
  };

  try {
    const instance = await spawnMimoServer({
      config: { autoupdate: false },
      port: 5123,
      binPath: bin,
      env: { MIMOCODE_BIN: bin, NETCATTY_TEST: "1", NODE_OPTIONS: "--require=/tmp/unsafe.js", MIMOCODE_PERMISSION: '{"edit":"allow"}' },
    });

    assert.equal(calls.length, 1);
    const { command, args, options } = calls[0];
    assert.equal(command, bin);
    assert.deepEqual(args, ["serve", "--hostname=127.0.0.1", "--port=5123"]);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
    // POSIX needs its own process group so close() can reach the native
    // server behind the npm shim.
    assert.equal(options.detached, process.platform !== "win32");
    assert.equal(options.env.MIMOCODE_CONFIG_CONTENT, JSON.stringify({ autoupdate: false }));
    assert.equal(options.env.MIMOCODE_BIN, bin);
    assert.equal(options.env.NETCATTY_TEST, "1");
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.MIMOCODE_PERMISSION, undefined);
    assert.equal(options.env.MIMOCODE_SERVER_USERNAME, "netcatty");
    assert.ok(options.env.MIMOCODE_SERVER_PASSWORD.length >= 32);

    assert.equal(instance.url, "http://127.0.0.1:5123");
    assert.equal(instance.server.url, "http://127.0.0.1:5123");
    assert.equal(typeof instance.client, "object");
    const originalFetch = global.fetch;
    const replies = [];
    global.fetch = async (url, options) => {
      replies.push({ url, options });
      return { ok: true };
    };
    try {
      await instance.server.replyPermission("permission.updated", { id: "per_1", sessionID: "ses_1" }, true);
      await instance.server.replyPermission("permission.asked", { id: "per_2", sessionID: "ses_1" }, false);
    } finally {
      global.fetch = originalFetch;
    }
    assert.deepEqual(replies.map(({ url, options }) => [url, JSON.parse(options.body)]), [
      ["http://127.0.0.1:5123/session/ses_1/permissions/per_1", { response: "once" }],
      ["http://127.0.0.1:5123/permission/per_2/reply", { reply: "reject" }],
    ]);
    assert.equal(replies[0].options.headers.Authorization,
      `Basic ${Buffer.from(`netcatty:${options.env.MIMOCODE_SERVER_PASSWORD}`).toString("base64")}`);

    // server.close() must tear down the spawned handle (no orphan).
    instance.server.close();
    assert.equal(child.killCount, 1);
  } finally {
    spawnMock = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnMimoServer resolves the binary from MIMOCODE_BIN_PATH when no explicit path is given", async () => {
  const dir = tempBinDir();
  const bin = path.join(dir, "mimo-from-env");
  fs.writeFileSync(bin, "");
  const calls = [];
  const child = fakeChild();
  spawnMock = (command, args, options) => {
    calls.push({ command, args, options });
    setImmediate(() => child.stdout.emit("data", Buffer.from("mimocode server listening on http://127.0.0.1:4097\n")));
    return child;
  };

  try {
    const instance = await spawnMimoServer({ port: 4097, env: { MIMOCODE_BIN_PATH: bin } });
    assert.equal(calls[0].command, bin);
    assert.deepEqual(calls[0].args, ["serve", "--hostname=127.0.0.1", "--port=4097"]);
    assert.equal(instance.url, "http://127.0.0.1:4097");
    instance.server.close();
  } finally {
    spawnMock = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnMimoServer parses the readiness URL across split stdout chunks", async () => {
  const child = fakeChild();
  spawnMock = () => {
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("mimocode server list"));
      child.stdout.emit("data", Buffer.from("ening on http://127.0.0.1:5555\n"));
    });
    return child;
  };

  try {
    const instance = await spawnMimoServer({ timeout: 1000 });
    assert.equal(instance.url, "http://127.0.0.1:5555");
    instance.server.close();
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer accepts the readiness line on stderr and the OpenCode spelling", async () => {
  const stderrChild = fakeChild();
  spawnMock = () => {
    setImmediate(() => stderrChild.stderr.emit("data", Buffer.from("mimocode server listening on http://127.0.0.1:6000\n")));
    return stderrChild;
  };

  try {
    const instance = await spawnMimoServer({ timeout: 1000 });
    assert.equal(instance.url, "http://127.0.0.1:6000");
    instance.server.close();
  } finally {
    spawnMock = null;
  }

  const rebrandedChild = fakeChild();
  spawnMock = () => {
    setImmediate(() => rebrandedChild.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:6001\n")));
    return rebrandedChild;
  };

  try {
    const instance = await spawnMimoServer({ timeout: 1000 });
    assert.equal(instance.url, "http://127.0.0.1:6001");
    instance.server.close();
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer rejects with the driver timeout error and kills the child", async () => {
  const child = fakeChild();
  spawnMock = () => child;

  try {
    await assert.rejects(
      spawnMimoServer({ timeout: 25 }),
      /Timeout waiting for mimo server to start after 25ms/,
    );
    assert.equal(child.killCount, 1);
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer rejects when the CLI exits before readiness", async () => {
  const child = fakeChild();
  spawnMock = () => {
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("boom"));
      child.emit("exit", 3);
    });
    return child;
  };

  try {
    await assert.rejects(spawnMimoServer({ timeout: 1000 }), /mimo server exited with code 3[\s\S]*mimo output: boom/);
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer bounds startup diagnostics from a noisy CLI", async () => {
  const child = fakeChild();
  spawnMock = () => {
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from(`${"x".repeat(200 * 1024)}\ntail`));
      child.emit("exit", 3);
    });
    return child;
  };
  try {
    await assert.rejects(spawnMimoServer({ timeout: 1000 }), (error) => {
      assert.match(error.message, /tail$/);
      assert.ok(error.message.length < 66 * 1024);
      return true;
    });
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer finds readiness before a large trailing log chunk", async () => {
  const child = fakeChild();
  spawnMock = () => {
    setImmediate(() => child.stdout.emit("data", Buffer.from(`mimocode server listening on http://127.0.0.1:5124\n${"x".repeat(200 * 1024)}`)));
    return child;
  };
  try {
    const instance = await spawnMimoServer({ timeout: 1000 });
    assert.equal(instance.url, "http://127.0.0.1:5124");
    instance.server.close();
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer waits for the complete readiness URL across chunks", async () => {
  const child = fakeChild();
  spawnMock = () => {
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("mimocode server listening on http://127.0.0.1:5"));
      setImmediate(() => child.stdout.emit("data", Buffer.from("124\n")));
    });
    return child;
  };
  try {
    const instance = await spawnMimoServer({ timeout: 1000 });
    assert.equal(instance.url, "http://127.0.0.1:5124");
    instance.server.close();
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer rejects when the spawn itself errors", async () => {
  const child = fakeChild();
  const spawnError = Object.assign(new Error("spawn mimo ENOENT"), { code: "ENOENT" });
  spawnMock = () => {
    setImmediate(() => child.emit("error", spawnError));
    return child;
  };

  try {
    await assert.rejects(spawnMimoServer({ timeout: 1000 }), /spawn mimo ENOENT/);
    assert.equal(child.killCount, 1);
  } finally {
    spawnMock = null;
  }
});

test("spawnMimoServer rejects immediately when the signal is already aborted", async () => {
  const child = fakeChild();
  spawnMock = () => child;
  const abortController = new AbortController();
  abortController.abort(new Error("cancelled"));

  try {
    await assert.rejects(spawnMimoServer({ timeout: 1000, signal: abortController.signal }), /cancelled/);
    assert.equal(child.killCount, 1);
  } finally {
    spawnMock = null;
  }
});

test("stopMimoProcess kills a live child, is idempotent, and never throws on shutdown failures", () => {
  const live = fakeChild();
  stopMimoProcess(live);
  assert.equal(live.killCount, 1);
  // After the first kill the child reports an exit code, so a second call is a no-op.
  stopMimoProcess(live);
  assert.equal(live.killCount, 1);

  const exited = fakeChild();
  exited.exitCode = 0;
  stopMimoProcess(exited);
  assert.equal(exited.killCount, 0);

  const throwing = fakeChild();
  throwing.kill = () => { throw new Error("kill failed"); };
  assert.doesNotThrow(() => stopMimoProcess(throwing));
  assert.doesNotThrow(() => stopMimoProcess(null));
});

test("stopMimoProcess uses taskkill /T /F for a live pid on Windows, else the direct signal", () => {
  const calls = [];
  spawnSyncMock = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  const child = fakeChild();
  child.pid = 4242;

  try {
    stopMimoProcess(child, { platform: "win32" });
    assert.deepEqual(calls, [{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"], options: { windowsHide: true } }]);
    assert.equal(child.killCount, 0);
  } finally {
    spawnSyncMock = null;
  }
});

test("stopMimoProcess signals the whole process group on POSIX and escalates to SIGKILL", async () => {
  for (const platform of ["darwin", "linux"]) {
    const signals = [];
    const child = fakeChild();
    child.pid = 4242;
    stopMimoProcess(child, {
      platform,
      killGroup: (pid, signal) => signals.push([pid, signal]),
      groupAlive: () => true,
      graceMs: 0,
    });
    // The shim alone must not be the target: its native child would survive.
    assert.equal(child.killCount, 0, platform);
    assert.deepEqual(signals, [[4242, "SIGTERM"]], platform);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]], platform);
  }

  // If the group cannot be signalled, fall back to the direct child.
  const child = fakeChild();
  child.pid = 4242;
  stopMimoProcess(child, {
    platform: "linux",
    killGroup: () => { throw Object.assign(new Error("no such group"), { code: "ESRCH" }); },
    graceMs: 0,
  });
  assert.equal(child.killCount, 1);
});

test("stopMimoProcess cancels escalation when the process group exits and does not schedule it twice", async () => {
  const signals = [];
  const child = fakeChild();
  child.pid = 4242;
  let alive = true;
  const options = {
    platform: "darwin",
    killGroup: (pid, signal) => signals.push([pid, signal]),
    groupAlive: () => alive,
    graceMs: 15,
    pollMs: 1,
  };
  stopMimoProcess(child, options);
  stopMimoProcess(child, options);
  alive = false;
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
});

test("stopMimoProcess escalates if the shim exits while its server group lives", async () => {
  const signals = [];
  const child = fakeChild();
  child.pid = 4242;
  stopMimoProcess(child, {
    platform: "darwin",
    killGroup: (pid, signal) => signals.push([pid, signal]),
    groupAlive: () => true,
    graceMs: 5,
    pollMs: 1,
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
});

test("stopMimoProcess can stop a live server group after its launcher already exited", async () => {
  const signals = [];
  const child = fakeChild();
  child.pid = 4242;
  child.exitCode = 0;
  stopMimoProcess(child, {
    platform: "darwin",
    killGroup: (pid, signal) => signals.push([pid, signal]),
    groupAlive: () => true,
    graceMs: 5,
    pollMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
});

test("runMimoTurn creates a session, streams deltas, and returns the session id", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", id: "p1", text: "hi" }, delta: "hi" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: {
      create: async (args) => {
        assert.deepEqual(args.query, { directory: "/repo" });
        return { data: { id: "sess-1" } };
      },
      promptAsync: async (args) => {
        assert.equal(args.path.id, "sess-1");
        assert.deepEqual(args.body.model, { providerID: "openai", modelID: "gpt-5.1" });
        return { data: true };
      },
    },
  };

  const result = await runMimoTurn({
    prompt: "hello",
    cwd: "/repo",
    model: "openai/gpt-5.1",
    toolIntegrationMode: "skills",
    skillsPathAllowlist: ["/opt/netcatty/**"],
    env: { MIMOCODE_HOME: "/opt/mimo-home" },
    emitter,
    abortController,
    mimoFactory: async ({ config }) => {
      assert.equal(config.permission.read["/opt/netcatty/**"], "allow");
      assert.equal(config.permission.read["/opt/mimo-home/config/skill/*"], "allow");
      assert.equal(config.permission.read["/opt/mimo-home/data/builtin_skills/**"], "allow");
      return { client, server: { close() {} } };
    },
  });

  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.deepEqual(events, [
    { k: "sessionId", s: "sess-1" },
    { k: "text", t: "hi" },
    { k: "status", m: "MiMo Code session idle" },
    { k: "done" },
  ]);
});

test("runMimoTurn allows configured custom skill paths before sending a prompt", async (t) => {
  const { events, emitter } = collector();
  const calls = [];
  const customPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mimo-turn-skills-")));
  t.after(() => fs.rmSync(customPath, { recursive: true, force: true }));
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const result = await runMimoTurn({
    prompt: "hello",
    cwd: "/work/project",
    emitter,
    abortController: new AbortController(),
    mimoConfigReader: async () => ({ project: [customPath], global: [customPath] }),
    mimoFactory: async ({ config }) => {
      calls.push(config);
      assert.equal(config.permission.read[`${customPath}/**`], "allow");
      assert.equal(config.permission.read[`${path.relative("/work/project", customPath)}/**`], "allow");
      assert.deepEqual(config.skills.paths, [customPath]);
      return {
        client: {
          global: { event: async () => ({ stream: connectedStream(stream) }) },
          session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
        },
        server: { close() {} },
      };
    },
  });
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(calls.length, 1);
  assert.equal(events.some((event) => event.k === "done"), true);
});

test("runMimoTurn gates MiMo commands by the selected permission mode", async () => {
  for (const [permissionMode, expected] of [["observer", "deny"], ["confirm", "ask"], ["auto", "allow"]]) {
    const { emitter } = collector();
    let actual;
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } } };
        yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
      },
    };
    await runMimoTurn({
      prompt: "hello",
      toolIntegrationMode: "skills",
      permissionMode,
      emitter,
      abortController: new AbortController(),
      mimoFactory: async ({ config }) => {
        actual = config.permission.bash;
        return {
          client: {
            global: { event: async () => ({ stream: connectedStream(stream) }) },
            session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
          },
          server: { close() {} },
        };
      },
    });
    assert.equal(actual, expected, permissionMode);
  }
});

test("runMimoTurn answers MiMo native permission requests through Netcatty approval", async () => {
  const { events, emitter } = collector();
  const approvals = [];
  const replies = [];
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "permission.updated", properties: {
        id: "per_1", sessionID: "sess-1", type: "bash", title: "Run command", pattern: "echo ok",
        metadata: { command: "echo ok" },
      } } };
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const result = await runMimoTurn({
    prompt: "hello",
    toolIntegrationMode: "skills",
    permissionMode: "confirm",
    chatSessionId: "chat-1",
    requestApprovalFromRenderer: async (...args) => { approvals.push(args); return true; },
    emitter,
    abortController: new AbortController(),
    mimoFactory: async () => ({
      client: {
        global: { event: async () => ({ stream: connectedStream(stream) }) },
        session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
      },
      server: { close() {}, replyPermission: async (...args) => { replies.push(args); } },
    }),
  });
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0][0], "MiMo Code permission");
  assert.equal(approvals[0][1].metadata.command, "echo ok");
  assert.equal(approvals[0][2], "chat-1");
  assert.deepEqual(replies.map(([type, request, approved]) => [type, request.id, approved]), [["permission.updated", "per_1", true]]);
  assert.equal(events.some((event) => event.k === "done"), true);
});

test("runMimoTurn rejects an unexpected MiMo permission request in observer mode", async () => {
  const { emitter } = collector();
  const replies = [];
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "permission.asked", properties: {
        id: "per_2", sessionID: "sess-1", permission: "bash", patterns: ["echo ok"], metadata: {},
      } } };
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  await runMimoTurn({
    prompt: "hello",
    toolIntegrationMode: "skills",
    permissionMode: "observer",
    requestApprovalFromRenderer: () => { throw new Error("observer must not ask"); },
    emitter,
    abortController: new AbortController(),
    mimoFactory: async () => ({
      client: {
        global: { event: async () => ({ stream: connectedStream(stream) }) },
        session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
      },
      server: { close() {}, replyPermission: async (...args) => { replies.push(args); } },
    }),
  });
  assert.deepEqual(replies.map(([type, request, approved]) => [type, request.id, approved]), [["permission.asked", "per_2", false]]);
});

test("runMimoTurn clears a pending approval when the MiMo service exits", async () => {
  const { events, emitter } = collector();
  let signalExit;
  const exited = new Promise((resolve) => { signalExit = resolve; });
  let approvalStarted;
  const approvalSeen = new Promise((resolve) => { approvalStarted = resolve; });
  const cleared = [];
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "permission.updated", properties: {
        id: "per_3", sessionID: "sess-1", type: "bash", title: "Run command", metadata: {},
      } } };
      await new Promise(() => {});
    },
  };
  const running = runMimoTurn({
    prompt: "hello",
    toolIntegrationMode: "skills",
    permissionMode: "confirm",
    chatSessionId: "chat-1",
    requestApprovalFromRenderer: () => { approvalStarted(); return new Promise(() => {}); },
    clearPendingApprovals: (chatId) => { cleared.push(chatId); },
    emitter,
    abortController: new AbortController(),
    mimoFactory: async () => ({
      client: {
        global: { event: async () => ({ stream: connectedStream(stream) }) },
        session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
      },
      server: { exited, close() {}, replyPermission: async () => {} },
    }),
  });
  await approvalSeen;
  signalExit();
  const result = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("MiMo turn hung after service exit")), 500))]);
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.deepEqual(cleared, ["chat-1"]);
  assert.equal(events.some((event) => event.k === "error"), true);
});

test("runMimoTurn does not grant a project-configured system directory", async () => {
  const { events, emitter } = collector();
  let calls = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  await runMimoTurn({
    prompt: "hello",
    cwd: process.cwd(),
    emitter,
    abortController: new AbortController(),
    mimoConfigReader: async () => ({ project: ["/etc"], global: [] }),
    mimoFactory: async ({ config }) => {
      calls += 1;
      assert.equal(config.permission.read["/etc/**"], undefined);
      assert.deepEqual(config.skills.paths, []);
      return {
        client: {
          global: { event: async () => ({ stream: connectedStream(stream) }) },
          session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
        },
        server: { close() {} },
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(events.some((event) => event.k === "done"), true);
});

test("runMimoTurn reports a resolved configuration error before starting the server", async () => {
  const { events, emitter } = collector();
  let started = false;
  const result = await runMimoTurn({
    prompt: "hello",
    emitter,
    abortController: new AbortController(),
    mimoConfigReader: async () => { throw new Error("config unavailable"); },
    mimoFactory: async () => { started = true; throw new Error("must not start"); },
  });
  assert.deepEqual(result, { sessionId: null });
  assert.equal(started, false);
  assert.equal(events.some((event) => event.k === "error" && event.m === "config unavailable"), true);
});

test("runMimoTurn waits for the event connection before sending a fast prompt", async () => {
  const { events, emitter } = collector();
  let connect;
  let promptCalls = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => { connect = resolve; });
      yield { payload: { type: "server.connected" } };
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "quick" }, delta: "quick" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => { promptCalls += 1; return { data: true }; },
    },
  };
  const running = runMimoTurn({ prompt: "hello", emitter, abortController: new AbortController(), mimoFactory: async () => ({ client, server: { close() {} } }) });
  for (let attempt = 0; !connect && attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(typeof connect, "function");
  assert.equal(promptCalls, 0);
  connect();
  await running;
  assert.equal(promptCalls, 1);
  assert.equal(events.some((event) => event.k === "text" && event.t === "quick"), true);
  assert.equal(events.some((event) => event.k === "done"), true);
});

test("runMimoTurn silently stops while connecting the event stream", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  let entered;
  const connecting = new Promise((resolve) => { entered = resolve; });
  let closeCount = 0;
  const client = {
    global: { event: () => { entered(); return new Promise(() => {}); } },
    session: { create: async () => { throw new Error("session should not be created"); } },
  };
  const running = runMimoTurn({ prompt: "hello", emitter, abortController, mimoFactory: async () => ({ client, server: { close() { closeCount += 1; } } }) });
  await connecting;
  abortController.abort(new Error("user cancelled"));
  assert.deepEqual(await running, { sessionId: null });
  assert.equal(closeCount >= 1, true);
  assert.equal(events.some((event) => event.k === "error"), false);
});

test("runMimoTurn silently stops while creating the session", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  let entered;
  const creating = new Promise((resolve) => { entered = resolve; });
  let closeCount = 0;
  const client = {
    global: { event: async () => ({ stream: connectedStream({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }) }) },
    session: { create: () => { entered(); return new Promise(() => {}); } },
  };
  const running = runMimoTurn({ prompt: "hello", emitter, abortController, mimoFactory: async () => ({ client, server: { close() { closeCount += 1; } } }) });
  await creating;
  abortController.abort(new Error("user cancelled"));
  assert.deepEqual(await running, { sessionId: null });
  assert.equal(closeCount >= 1, true);
  assert.equal(events.some((event) => event.k === "error"), false);
});

test("runMimoTurn reports a server exit while connecting the event stream", async () => {
  const { events, emitter } = collector();
  let reading;
  const readStarted = new Promise((resolve) => { reading = resolve; });
  let exitServer;
  const exited = new Promise((resolve) => { exitServer = resolve; });
  const stream = { async *[Symbol.asyncIterator]() { reading(); await new Promise(() => {}); } };
  const client = {
    global: { event: async () => ({ stream }) },
    session: { create: async () => { throw new Error("session should not be created"); } },
  };
  const running = runMimoTurn({ prompt: "hello", emitter, abortController: new AbortController(), mimoFactory: async () => ({ client, server: { exited, close() {} } }) });
  await readStarted;
  exitServer();
  assert.deepEqual(await running, { sessionId: null });
  assert.equal(events.some((event) => event.k === "error" && /exited unexpectedly/.test(event.m)), true);
});

test("runMimoTurn reports a server exit while waiting for the reply", async () => {
  const { events, emitter } = collector();
  let exitServer;
  const exited = new Promise((resolve) => { exitServer = resolve; });
  let prompted;
  const promptStarted = new Promise((resolve) => { prompted = resolve; });
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "server.connected" } };
      await new Promise(() => {});
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => { prompted(); return { data: true }; },
    },
  };
  const running = runMimoTurn({ prompt: "hello", emitter, abortController: new AbortController(), mimoFactory: async () => ({ client, server: { exited, close() {} } }) });
  await promptStarted;
  exitServer();
  assert.deepEqual(await running, { sessionId: "sess-1" });
  assert.equal(events.some((event) => event.k === "error" && /exited unexpectedly/.test(event.m)), true);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("runMimoTurn stops when the session reports an error and the prompt call hangs", async () => {
  const { events, emitter } = collector();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "server.connected" } };
      yield { payload: { type: "session.error", properties: { sessionID: "sess-1", error: { message: "model failed" } } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => new Promise(() => {}),
    },
  };
  const running = runMimoTurn({ prompt: "hello", emitter, abortController: new AbortController(), mimoFactory: async () => ({ client, server: { close() {} } }) });
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("timed-out"), 200))]);
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(events.some((event) => event.k === "error" && event.m === "model failed"), true);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("runMimoTurn reports a partial reply when the event stream ends without idle", async () => {
  const { events, emitter } = collector();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "server.connected" } };
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "partial" }, delta: "partial" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ data: true }),
    },
  };
  const result = await runMimoTurn({ prompt: "hello", emitter, abortController: new AbortController(), mimoFactory: async () => ({ client, server: { close() {} } }) });
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(events.some((event) => event.k === "text" && event.t === "partial"), true);
  assert.equal(events.some((event) => event.k === "error" && /before it was complete/.test(event.m)), true);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("runMimoTurn ignores events from other sessions on the shared global stream", async () => {
  const { events, emitter } = collector();
  const stream = {
    async *[Symbol.asyncIterator]() {
      // Another session's reply and idle arrive first on the global stream.
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", id: "o1", text: "other", sessionID: "other-session" }, delta: "other" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "other-session" } } };
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", id: "p1", text: "mine", sessionID: "own-session" }, delta: "mine" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "own-session" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: {
      create: async () => ({ data: { id: "own-session" } }),
      promptAsync: async () => {
        return { data: true };
      },
    },
  };

  const result = await runMimoTurn({
    prompt: "hello",
    emitter,
    abortController: new AbortController(),
    mimoFactory: async () => ({ client, server: { close() {} } }),
  });

  assert.deepEqual(result, { sessionId: "own-session" });
  assert.deepEqual(events, [
    { k: "sessionId", s: "own-session" },
    { k: "text", t: "mine" },
    { k: "status", m: "MiMo Code session idle" },
    { k: "done" },
  ]);
});

test("runMimoTurn ignores a resumed session's stale idle before its new reply", async () => {
  const { events, emitter } = collector();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "server.connected" } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
      yield { payload: { type: "session.status", properties: { sessionID: "sess-1", status: { type: "busy" } } } };
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "new", text: "new reply" }, delta: "new reply" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: { promptAsync: async () => ({ data: true }) },
  };
  const result = await runMimoTurn({
    prompt: "continue",
    resumeSessionId: "sess-1",
    emitter,
    abortController: new AbortController(),
    mimoFactory: async () => ({ client, server: { close() {} } }),
  });
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(events.some((event) => event.k === "text" && event.t === "new reply"), true);
  assert.equal(events.filter((event) => event.k === "status" && event.m === "MiMo Code session idle").length, 1);
  assert.equal(events.some((event) => event.k === "done"), true);
  assert.equal(events.some((event) => event.k === "error"), false);
});

test("runMimoTurn returns promptly on abort and tears down the server without throwing", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  let abortCount = 0;
  let closeCount = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ data: true }),
      abort: async () => { abortCount += 1; },
    },
  };

  const running = runMimoTurn({
    prompt: "hello",
    emitter,
    abortController,
    mimoFactory: async () => ({
      client,
      // A throwing close() must be swallowed by both abort and finally paths.
      server: { close() { closeCount += 1; throw new Error("close failed"); } },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  abortController.abort(new Error("user cancelled"));

  const result = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
  ]);

  assert.notEqual(result, "timed-out");
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(abortCount, 1);
  assert.equal(closeCount >= 1, true);
  assert.equal(events.some((event) => event.k === "done"), false);
  assert.equal(events.some((event) => event.k === "error"), false);
});

test("runMimoTurn passes a non-default port to the MiMo server factory", async () => {
  const { emitter } = collector();
  const abortController = new AbortController();
  let capturedPort;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ data: true }),
    },
  };

  await runMimoTurn({
    prompt: "hello",
    emitter,
    abortController,
    mimoFactory: async (options) => {
      capturedPort = options.port;
      return { client, server: { close() {} } };
    },
  });

  assert.equal(typeof capturedPort, "number");
  assert.notEqual(capturedPort, 4096);
});

test("runMimoTurn surfaces a prompt error result and still tears down the server", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  let closeCount = 0;
  let abortCount = 0;
  const client = {
    global: { event: async () => ({ stream: connectedStream({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }) }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ error: { data: { message: "bad model" } } }),
      abort: async () => { abortCount += 1; },
    },
  };

  const result = await runMimoTurn({
    prompt: "hello",
    emitter,
    abortController,
    mimoFactory: async () => ({ client, server: { close() { closeCount += 1; } } }),
  });

  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(events.some((event) => event.k === "error" && event.m === "bad model"), true);
  assert.equal(events.some((event) => event.k === "done"), false);
  assert.equal(abortCount, 1);
  assert.equal(closeCount >= 1, true);
});

test("runMimoTurn reports a prompt error even when the abort request never answers", async () => {
  const { events, emitter } = collector();
  let closed = false;
  const stream = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ error: { data: { message: "bad model" } } }),
      abort: async () => new Promise(() => {}),
    },
  };
  const running = runMimoTurn({ prompt: "hello", emitter, abortController: new AbortController(), mimoFactory: async () => ({ client, server: { close() { closed = true; } } }) });
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("timed-out"), 200))]);
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(closed, true);
  assert.equal(events.some((event) => event.k === "error" && event.m === "bad model"), true);
});

test("runMimoTurn rebrands shared OpenCode status strings to MiMo Code", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "session.status", properties: { status: { type: "busy" } } };
      yield { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } };
      yield { type: "session.idle", properties: { sessionID: "sess-1" } };
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
  };

  await runMimoTurn({ prompt: "hello", emitter, abortController, mimoFactory: async () => ({ client, server: { close() {} } }) });

  const statuses = events.filter((event) => event.k === "status").map((event) => event.m);
  assert.deepEqual(statuses, ["MiMo Code session busy", "MiMo Code session idle"]);
  assert.equal(statuses.some((message) => message.includes("OpenCode")), false);
});

test("runMimoTurn rebrands the failed and tool-failure fallbacks but leaves tool output verbatim", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      // Tool part error with neither error nor output -> shared fallback string.
      yield { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "sess-1", callID: "t1", tool: "bash", state: { status: "error", input: {} } } } };
      // Tool output that mentions the shared brand must pass through untouched.
      yield { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "sess-1", callID: "t2", tool: "grep", state: { status: "completed", input: {}, output: "OpenCode source tree" } } } };
      yield { type: "session.error", properties: {} };
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
  };

  await runMimoTurn({ prompt: "hello", emitter, abortController, mimoFactory: async () => ({ client, server: { close() {} } }) });

  assert.deepEqual(events.filter((event) => event.k === "toolResult").map((event) => event.out), [
    "MiMo Code tool failed",
    "OpenCode source tree",
  ]);
  assert.deepEqual(events.filter((event) => event.k === "error").map((event) => event.m), ["MiMo Code session failed"]);
});

test("runMimoTurn passes non-brand technical error text through unchanged", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "session.error", properties: { error: { data: { message: "ECONNREFUSED 127.0.0.1:4096" } } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
  };

  await runMimoTurn({ prompt: "hello", emitter, abortController, mimoFactory: async () => ({ client, server: { close() {} } }) });

  assert.deepEqual(events.filter((event) => event.k === "error").map((event) => event.m), ["ECONNREFUSED 127.0.0.1:4096"]);
});

test("runMimoTurn reports an empty response with MiMo branding when no content arrives", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "session.idle", properties: { sessionID: "sess-1" } };
    },
  };
  const client = {
    global: { event: async () => ({ stream: connectedStream(stream) }) },
    session: { create: async () => ({ data: { id: "sess-1" } }), promptAsync: async () => ({ data: true }) },
  };

  await runMimoTurn({ prompt: "hello", emitter, abortController, mimoFactory: async () => ({ client, server: { close() {} } }) });

  const errors = events.filter((event) => event.k === "error").map((event) => event.m);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^MiMo Code returned an empty response/);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("runMimoTurn reports a branded missing-CLI error when the spawn is ENOENT", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const enoent = Object.assign(new Error("spawn mimo ENOENT"), { code: "ENOENT" });

  const result = await runMimoTurn({
    prompt: "hello",
    emitter,
    abortController,
    mimoFactory: async () => { throw enoent; },
  });

  assert.deepEqual(result, { sessionId: null });
  assert.deepEqual(events.filter((event) => event.k === "error").map((event) => event.m), [
    "MiMo Code CLI not found or not runnable. Install MiMo Code and ensure `mimo` is on PATH, or set a custom path in Settings.",
  ]);
});

test("listMimoModels passes a non-default port to the factory and maps the provider catalog", async () => {
  let capturedPort;
  let sawSignal = false;
  const models = await listMimoModels({
    binPath: "/tmp/mimo-list-test",
    mimoFactory: async (options) => {
      capturedPort = options.port;
      sawSignal = options.signal !== undefined;
      return {
        client: {
          config: {
            providers: async () => ({
              providers: [
                { id: "xiaomi", name: "Xiaomi", models: { "mimo-v2.6-flash": { name: "MiMo V2.6 Flash" } } },
              ],
              default: { xiaomi: "mimo-v2.6-flash" },
            }),
          },
        },
        server: { close() {} },
      };
    },
  });

  assert.equal(typeof capturedPort, "number");
  assert.notEqual(capturedPort, 4096);
  assert.equal(sawSignal, false);
  assert.deepEqual(models, {
    currentModelId: "xiaomi/mimo-v2.6-flash",
    models: [{ id: "xiaomi/mimo-v2.6-flash", name: "Xiaomi MiMo V2.6 Flash" }],
  });
});

test("listMimoModels returns an empty catalog when pre-aborted or when the provider call fails", async () => {
  const abortController = new AbortController();
  abortController.abort(new Error("pre-aborted"));
  let createCount = 0;
  const aborted = await listMimoModels({
    binPath: "/tmp/mimo-preabort-test",
    signal: abortController.signal,
    mimoFactory: async () => {
      createCount += 1;
      return { client: { config: { providers: async () => ({ providers: [] }) } }, server: { close() {} } };
    },
  });
  assert.deepEqual(aborted, { currentModelId: null, models: [] });
  assert.equal(createCount, 0);

  let closeCount = 0;
  const failed = await listMimoModels({
    binPath: "/tmp/mimo-fail-test",
    mimoFactory: async () => ({
      client: { config: { providers: async () => { throw new Error("providers down"); } } },
      server: { close() { closeCount += 1; } },
    }),
  });
  assert.deepEqual(failed, { currentModelId: null, models: [] });
  assert.equal(closeCount, 1);
});

test("listMimoModels stops when the service exits during provider discovery", async () => {
  let exitServer;
  const exited = new Promise((resolve) => { exitServer = resolve; });
  let querying;
  const queryStarted = new Promise((resolve) => { querying = resolve; });
  let closeCount = 0;
  const running = listMimoModels({
    mimoFactory: async () => ({
      client: { config: { providers: () => { querying(); return new Promise(() => {}); } } },
      server: { exited, close() { closeCount += 1; } },
    }),
  });
  await queryStarted;
  exitServer();
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("timed-out"), 200))]);
  assert.deepEqual(result, { currentModelId: null, models: [] });
  assert.equal(closeCount, 1);
});
