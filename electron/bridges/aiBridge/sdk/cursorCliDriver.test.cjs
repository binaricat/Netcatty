const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCursorCliArgs,
  createLineBuffer,
  formatCursorCliErrorForUser,
  listCursorCliModels,
  mergeWorkspaceMcpJson,
  resetMcpMergeRefcountsForTests,
  resolveCursorCliExecMode,
  resolveCursorCliModel,
  resolveCursorCliSpawnSpec,
  resolveCursorCliWorkspaceCwd,
  runCursorCliTurn,
  spawnCursorCliProcess,
  stripCursorApiKeyFromEnv,
  translateCursorCliEvent,
} = require("./cursorCliDriver.cjs");

function makeEmitter() {
  const calls = [];
  return {
    calls,
    text: (value) => calls.push(["text", value]),
    reasoning: (value) => calls.push(["reasoning", value]),
    reasoningEnd: () => calls.push(["reasoningEnd"]),
    toolCall: (name, args, id) => calls.push(["toolCall", name, args, id]),
    toolResult: (id, result, name) => calls.push(["toolResult", id, result, name]),
    sessionId: (id) => calls.push(["sessionId", id]),
    emitDone: () => calls.push(["done"]),
    emitError: (message) => calls.push(["error", message]),
  };
}

test("resolveCursorCliModel defaults to auto", () => {
  assert.equal(resolveCursorCliModel(undefined), "auto");
  assert.equal(resolveCursorCliModel(""), "auto");
  assert.equal(resolveCursorCliModel("composer-2.5"), "composer-2.5");
  assert.equal(resolveCursorCliModel("gpt-5/high"), "gpt-5?effort=high");
});

test("stripCursorApiKeyFromEnv removes CURSOR_API_KEY", () => {
  assert.deepEqual(
    stripCursorApiKeyFromEnv({ CURSOR_API_KEY: "secret", PATH: "/bin" }),
    { PATH: "/bin" },
  );
});

test("createLineBuffer rejects and releases an unterminated oversized message", () => {
  const lines = [];
  const lineBuffer = createLineBuffer((line) => lines.push(line), 8);
  lineBuffer.push(Buffer.from("12345678"));
  assert.throws(
    () => lineBuffer.push(Buffer.from("9")),
    (error) => error?.code === "CURSOR_CLI_LINE_LIMIT",
  );
  lineBuffer.flush();
  assert.deepEqual(lines, []);
});

test("buildCursorCliArgs maps permission modes and resume", () => {
  assert.deepEqual(
    buildCursorCliArgs({
      model: "",
      permissionMode: "observer",
      resumeSessionId: "sess-1",
      cwd: "/repo",
      prompt: "hi",
    }),
    [
      "--print",
      "--trust",
      "--approve-mcps",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      "auto",
      "--workspace",
      "/repo",
      "--resume",
      "sess-1",
      "--mode",
      "ask",
      "hi",
    ],
  );

  const autoArgs = buildCursorCliArgs({
    model: "auto",
    permissionMode: "auto",
    cwd: "/repo",
    prompt: "go",
  });
  assert.ok(autoArgs.includes("--force"));
  assert.ok(!autoArgs.includes("--mode"));

  // confirm must pass --force: stdin is ignored and Cursor asks y/n for shell tools.
  const confirmArgs = buildCursorCliArgs({
    model: "auto",
    permissionMode: "confirm",
    cwd: "/repo",
    prompt: "go",
  });
  assert.ok(confirmArgs.includes("--force"));
  assert.ok(!confirmArgs.includes("--mode"));
});

test("formatCursorCliErrorForUser does not over-match bare login strings", () => {
  assert.match(
    formatCursorCliErrorForUser("Not authenticated"),
    /not logged in/i,
  );
  assert.equal(
    formatCursorCliErrorForUser("Failed to run login form validation"),
    "Failed to run login form validation",
  );
});

test("translateCursorCliEvent streams thinking, text, and tools", () => {
  const emitter = makeEmitter();
  const state = {};
  translateCursorCliEvent({ type: "system", subtype: "init", session_id: "s1" }, emitter, state);
  translateCursorCliEvent({ type: "thinking", subtype: "delta", text: "plan" }, emitter, state);
  translateCursorCliEvent({ type: "thinking", subtype: "completed" }, emitter, state);
  translateCursorCliEvent({
    type: "assistant",
    timestamp_ms: 1,
    message: { content: [{ type: "text", text: "Hi" }] },
  }, emitter, state);
  translateCursorCliEvent({
    type: "assistant",
    timestamp_ms: 2,
    model_call_id: "call-dup",
    message: { content: [{ type: "text", text: "Hi" }] },
  }, emitter, state);
  translateCursorCliEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "Hi" }] },
  }, emitter, state);
  translateCursorCliEvent({
    type: "tool_call",
    subtype: "started",
    call_id: "c1",
    tool_call: { getMcpToolsToolCall: { args: { a: 1 } } },
  }, emitter, state);
  translateCursorCliEvent({
    type: "tool_call",
    subtype: "completed",
    call_id: "c1",
    tool_call: { getMcpToolsToolCall: { args: { a: 1 }, result: { success: { content: "ok" } } } },
  }, emitter, state);

  assert.deepEqual(emitter.calls, [
    ["sessionId", "s1"],
    ["reasoning", "plan"],
    ["reasoningEnd"],
    ["text", "Hi"],
    ["toolCall", "getMcpTools", { a: 1 }, "c1"],
    ["toolResult", "c1", "ok", "getMcpTools"],
  ]);
  assert.equal(state.sessionId, "s1");
});

test("resolveCursorCliExecMode maps observer to ask and others to agent", () => {
  assert.equal(resolveCursorCliExecMode("observer"), "ask");
  assert.equal(resolveCursorCliExecMode("confirm"), "agent");
  assert.equal(resolveCursorCliExecMode("auto"), "agent");
});

test("mergeWorkspaceMcpJson upserts netcatty without dropping others", () => {
  resetMcpMergeRefcountsForTests();
  const files = new Map();
  files.set("/repo/.cursor/mcp.json", JSON.stringify({
    mcpServers: { other: { command: "echo" } },
  }, null, 2));

  const handle = mergeWorkspaceMcpJson("/repo", [{
    name: "netcatty-remote-hosts",
    command: "node",
    args: ["mcp.cjs"],
    env: [{ name: "TOKEN", value: "x" }],
  }], {
    existsSync: (p) => files.has(p) || p === "/repo/.cursor",
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, data) => { files.set(p, data); },
    mkdirSync: () => {},
  });

  const written = JSON.parse(files.get("/repo/.cursor/mcp.json"));
  assert.equal(written.mcpServers.other.command, "echo");
  assert.equal(written.mcpServers["netcatty-remote-hosts"].command, "node");
  assert.equal(written.mcpServers["netcatty-remote-hosts"].type, "stdio");
  assert.equal(written.mcpServers["netcatty-remote-hosts"].env.TOKEN, "x");

  handle.restore();
  assert.ok(files.get("/repo/.cursor/mcp.json").includes('"other"'));
});

test("mergeWorkspaceMcpJson concurrent turns restore original only after last", () => {
  resetMcpMergeRefcountsForTests();
  const files = new Map();
  const original = JSON.stringify({ mcpServers: { other: { command: "echo" } } }, null, 2);
  files.set("/repo/.cursor/mcp.json", original);
  const fsApi = {
    existsSync: (p) => files.has(p) || p === "/repo/.cursor",
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, data) => { files.set(p, data); },
    mkdirSync: () => {},
  };

  const a = mergeWorkspaceMcpJson("/repo", [{
    name: "netcatty-remote-hosts",
    command: "node",
    args: ["a.cjs"],
  }], fsApi);
  const b = mergeWorkspaceMcpJson("/repo", [{
    name: "netcatty-remote-hosts",
    command: "node",
    args: ["b.cjs"],
  }], fsApi);

  a.restore();
  // First restore must keep the merged file while another turn is in flight.
  assert.ok(files.get("/repo/.cursor/mcp.json").includes("netcatty-remote-hosts"));
  b.restore();
  assert.equal(files.get("/repo/.cursor/mcp.json"), original);
});

test("runCursorCliTurn strips API key, parses stream, emits done", async () => {
  const emitter = makeEmitter();
  const observed = { env: null, args: null };

  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => { fakeChild.killed = true; };

  const result = await new Promise((resolve, reject) => {
    runCursorCliTurn({
      prompt: "hi",
      binPath: "/bin/agent",
      cwd: "/repo",
      model: "",
      env: { CURSOR_API_KEY: "secret", PATH: "/bin" },
      permissionMode: "confirm",
      injectedMcpServers: [],
      emitter,
      spawnImpl: (cmd, args, opts) => {
        observed.env = opts.env;
        observed.args = args;
        queueMicrotask(() => {
          fakeChild.stdout.emit("data", `${JSON.stringify({
            type: "system", subtype: "init", session_id: "sess-cli", apiKeySource: "login",
          })}\n`);
          fakeChild.stdout.emit("data", `${JSON.stringify({
            type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "PONG" }] },
          })}\n`);
          fakeChild.stdout.emit("data", `${JSON.stringify({
            type: "result", subtype: "success", session_id: "sess-cli", result: "PONG",
          })}\n`);
          fakeChild.emit("close", 0);
        });
        return fakeChild;
      },
      mergeMcp: () => ({ restore() {} }),
    }).then(resolve, reject);
  });

  assert.equal(observed.env.CURSOR_API_KEY, undefined);
  assert.equal(observed.env.PATH, "/bin");
  assert.ok(observed.args.includes("auto"));
  assert.ok(observed.args.includes("--force"));
  assert.equal(result.sessionId, "sess-cli");
  assert.deepEqual(emitter.calls, [
    ["sessionId", "sess-cli"],
    ["text", "PONG"],
    ["sessionId", "sess-cli"],
    ["done"],
  ]);
});

test("runCursorCliTurn preserves a Chinese JSON event split across UTF-8 chunks", async () => {
  const emitter = makeEmitter();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [],
    emitter,
    spawnImpl: () => {
      queueMicrotask(() => {
        const line = Buffer.from(`${JSON.stringify({
          type: "assistant",
          timestamp_ms: 1,
          message: { content: [{ type: "text", text: "中文回复" }] },
        })}\n`, "utf8");
        const split = line.indexOf(Buffer.from("中", "utf8")) + 2;
        fakeChild.stdout.emit("data", line.subarray(0, split));
        fakeChild.stdout.emit("data", line.subarray(split));
        fakeChild.emit("close", 0);
      });
      return fakeChild;
    },
    mergeMcp: () => ({ restore() {} }),
  });

  assert.ok(emitter.calls.some((call) => call[0] === "text" && call[1] === "中文回复"));
});

test("runCursorCliTurn preserves Chinese stderr split across UTF-8 chunks", async () => {
  const emitter = makeEmitter();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [],
    emitter,
    spawnImpl: () => {
      queueMicrotask(() => {
        const bytes = Buffer.from("中文错误", "utf8");
        fakeChild.stderr.emit("data", bytes.subarray(0, 2));
        fakeChild.stderr.emit("data", bytes.subarray(2));
        fakeChild.emit("close", 1);
      });
      return fakeChild;
    },
    mergeMcp: () => ({ restore() {} }),
  });

  assert.ok(emitter.calls.some((call) => call[0] === "error" && call[1] === "中文错误"));
});

test("runCursorCliTurn abort after text does not emit done", async () => {
  const emitter = makeEmitter();
  const ac = new AbortController();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => {
    fakeChild.killed = true;
    queueMicrotask(() => fakeChild.emit("close", 143));
  };

  const turnPromise = runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    model: "auto",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [],
    emitter,
    signal: ac.signal,
    spawnImpl: () => {
      queueMicrotask(() => {
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "partial" }] },
        })}\n`);
        ac.abort();
      });
      return fakeChild;
    },
    mergeMcp: () => ({ restore() {} }),
  });

  await turnPromise;
  assert.ok(fakeChild.killed);
  assert.deepEqual(emitter.calls, [
    ["text", "partial"],
  ]);
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
  assert.ok(!emitter.calls.some((c) => c[0] === "error"));
});

test("runCursorCliTurn abort before any text is soft cancel (no error/done)", async () => {
  const emitter = makeEmitter();
  const ac = new AbortController();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => {
    fakeChild.killed = true;
    queueMicrotask(() => fakeChild.emit("close", 143));
  };

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    model: "auto",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [],
    emitter,
    signal: ac.signal,
    spawnImpl: () => {
      queueMicrotask(() => ac.abort());
      return fakeChild;
    },
    mergeMcp: () => ({ restore() {} }),
  });

  assert.ok(fakeChild.killed);
  assert.deepEqual(emitter.calls, []);
});

test("runCursorCliTurn force-kills and settles when the CLI ignores SIGTERM", async () => {
  const emitter = makeEmitter();
  const ac = new AbortController();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  const signals = [];
  fakeChild.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  let restored = false;

  const turn = runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    model: "auto",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [{ name: "netcatty", command: "node", args: [] }],
    emitter,
    signal: ac.signal,
    abortGraceMs: 5,
    forceKillImpl: (child) => child.kill("SIGKILL"),
    spawnImpl: () => fakeChild,
    mergeMcp: () => ({ restore() { restored = true; } }),
  });
  ac.abort();

  await Promise.race([
    turn,
    new Promise((_, reject) => setTimeout(() => reject(new Error("aborted Cursor CLI did not settle")), 50)),
  ]);

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(restored, true);
  assert.deepEqual(emitter.calls, []);
});

test("runCursorCliTurn ignores late error events after abort (before text)", async () => {
  const emitter = makeEmitter();
  const ac = new AbortController();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => {
    fakeChild.killed = true;
  };

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    model: "auto",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [],
    emitter,
    signal: ac.signal,
    spawnImpl: () => {
      queueMicrotask(() => {
        ac.abort();
        // Late stream after Stop — must not surface as emitError.
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "error", message: "not authenticated",
        })}\n`);
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "result", subtype: "error", is_error: true, result: "boom",
        })}\n`);
        fakeChild.emit("close", 1);
      });
      return fakeChild;
    },
    mergeMcp: () => ({ restore() {} }),
  });

  assert.deepEqual(emitter.calls, []);
  assert.ok(!emitter.calls.some((c) => c[0] === "error"));
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});

test("runCursorCliTurn ignores late error after abort following partial text", async () => {
  const emitter = makeEmitter();
  const ac = new AbortController();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => {
    fakeChild.killed = true;
  };

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    model: "auto",
    env: {},
    permissionMode: "auto",
    injectedMcpServers: [],
    emitter,
    signal: ac.signal,
    spawnImpl: () => {
      queueMicrotask(() => {
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "hi" }] },
        })}\n`);
        ac.abort();
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "result", subtype: "error", is_error: true, result: "killed",
        })}\n`);
        fakeChild.emit("close", 143);
      });
      return fakeChild;
    },
    mergeMcp: () => ({ restore() {} }),
  });

  assert.deepEqual(emitter.calls, [
    ["text", "hi"],
  ]);
  assert.ok(!emitter.calls.some((c) => c[0] === "error"));
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});

test("runCursorCliTurn closes open reasoning before done", async () => {
  const emitter = makeEmitter();
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => { fakeChild.killed = true; };

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/repo",
    model: "auto",
    env: {},
    permissionMode: "auto",
    injectedMcpServers: [],
    emitter,
    spawnImpl: () => {
      queueMicrotask(() => {
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "thinking", subtype: "delta", text: "hmm",
        })}\n`);
        fakeChild.emit("close", 0);
      });
      return fakeChild;
    },
    mergeMcp: () => ({ restore() {} }),
  });

  assert.deepEqual(emitter.calls, [
    ["reasoning", "hmm"],
    ["reasoningEnd"],
    ["done"],
  ]);
});

test("resolveCursorCliSpawnSpec keeps a native exe on argv without a shell", () => {
  const exePath = process.platform === "win32"
    ? "C:\\Users\\me\\AppData\\Local\\cursor-agent\\cursor-agent.exe"
    : "/usr/local/bin/cursor-agent";
  const args = ["--print", "--trust"];
  const exe = resolveCursorCliSpawnSpec(exePath, args);
  assert.equal(exe.shell, false);
  assert.equal(exe.command, exePath);
  assert.deepEqual(exe.args, args);
});

test("spawnCursorCliProcess launches the installer node+script with the prompt on argv", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-turn-spawn-"));
  try {
    const versionDir = path.join(tmp, "versions", "2026.06.01-abc");
    fs.mkdirSync(versionDir, { recursive: true });
    const nodeExe = path.join(versionDir, "node.exe");
    const script = path.join(versionDir, "index.js");
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(script, "", "utf8");
    const shimPath = path.join(tmp, "cursor-agent.cmd");
    fs.writeFileSync(
      shimPath,
      `@ECHO off\r\n"%~dp0\\versions\\2026.06.01-abc\\node.exe" "%~dp0\\versions\\2026.06.01-abc\\index.js" %*\r\n`,
      "utf8",
    );

    const prompt = 'review "%TEMP%" then run whoami';
    const calls = [];
    spawnCursorCliProcess(
      (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
      },
      shimPath,
      ["--print", "--trust", prompt],
      { windowsHide: true },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, nodeExe);
    assert.deepEqual(calls[0].args, [script, "--print", "--trust", prompt]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(String(calls[0].command).includes("cmd.exe"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("spawnCursorCliProcess forwards shell from resolveCursorCliSpawnSpec", () => {
  const calls = [];
  const fakeChild = {
    stdout: { on() {} },
    stderr: { on() {} },
    stdin: null,
    on() {},
    kill() {},
  };
  const cliPath = "/usr/local/bin/cursor-agent";
  const child = spawnCursorCliProcess(
    (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild;
    },
    cliPath,
    ["models"],
    { cwd: "/repo", windowsHide: true },
  );
  assert.equal(child, fakeChild);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, cliPath);
  assert.deepEqual(calls[0].args, ["models"]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
});

test("listCursorCliModels parses agent models output and prefers auto", async () => {
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();

  const catalog = await listCursorCliModels({
    binPath: "/bin/agent",
    env: { CURSOR_API_KEY: "secret" },
    spawnImpl: (cmd, args, opts) => {
      assert.equal(cmd, "/bin/agent");
      assert.deepEqual(args, ["models"]);
      assert.equal(opts.env.CURSOR_API_KEY, undefined);
      queueMicrotask(() => {
        fakeChild.stdout.emit("data", [
          "Available models",
          "",
          "auto - Auto (current, default)",
          "composer-2.5 - Composer 2.5",
          "gpt-5.2 - GPT-5.2",
          "",
        ].join("\n"));
        fakeChild.emit("close", 0);
      });
      return fakeChild;
    },
  });

  assert.deepEqual(catalog, {
    currentModelId: "auto",
    models: [
      { id: "auto", name: "Auto" },
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "gpt-5.2", name: "GPT-5.2" },
    ],
  });
});

test("listCursorCliModels preserves Chinese model names split across UTF-8 chunks", async () => {
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {};

  const catalogPromise = listCursorCliModels({
    binPath: "/bin/agent",
    env: {},
    spawnImpl: () => {
      queueMicrotask(() => {
        const bytes = Buffer.from("model-cn - 中文模型\n", "utf8");
        const split = bytes.indexOf(Buffer.from("中", "utf8")) + 1;
        fakeChild.stdout.emit("data", bytes.subarray(0, split));
        fakeChild.stdout.emit("data", bytes.subarray(split));
        fakeChild.emit("close", 0);
      });
      return fakeChild;
    },
  });

  assert.deepEqual(await catalogPromise, {
    currentModelId: null,
    models: [{ id: "model-cn", name: "中文模型" }],
  });
});

test("listCursorCliModels aborts a hung CLI and settles after forced cleanup", async () => {
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.pid = 4242;
  const signals = [];
  const abortController = new AbortController();

  const catalogPromise = listCursorCliModels({
    binPath: "/bin/agent",
    env: {},
    abortController,
    abortGraceMs: 0,
    forceKillImpl: (_child, signal) => signals.push(signal),
    spawnImpl: () => fakeChild,
  });
  abortController.abort();

  const outcome = await Promise.race([
    catalogPromise.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 20)),
  ]);
  if (outcome === "hung") fakeChild.emit("close", 0);
  assert.equal(outcome, "settled");
  assert.deepEqual(await catalogPromise, { currentModelId: null, models: [] });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("resolveCursorCliWorkspaceCwd prefers Netcatty temp over unwritable preferred cwd", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-ws-"));
  const resolved = resolveCursorCliWorkspaceCwd({
    preferredCwd: "/",
    chatSessionId: "ai_chat_1",
    getTempDir: () => tempRoot,
  });
  assert.equal(resolved, path.join(tempRoot, "cursor-cli-mcp", "ai_chat_1"));
  assert.ok(fs.statSync(resolved).isDirectory());
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("runCursorCliTurn uses temp workspace for MCP merge and --workspace when cwd is /", async () => {
  const emitter = makeEmitter();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-ws-"));
  const observed = { spawnCwd: null, args: null, mergeCwd: null };
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.kill = () => { fakeChild.killed = true; };

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/",
    chatSessionId: "chat-packaged",
    getTempDir: () => tempRoot,
    model: "auto",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "node",
      args: ["server.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
    emitter,
    spawnImpl: (_cmd, args, opts) => {
      observed.spawnCwd = opts.cwd;
      observed.args = args;
      queueMicrotask(() => {
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "ok" }] },
        })}\n`);
        fakeChild.stdout.emit("data", `${JSON.stringify({
          type: "result", subtype: "success", result: "ok",
        })}\n`);
        fakeChild.emit("close", 0);
      });
      return fakeChild;
    },
    mergeMcp: (mergeCwd) => {
      observed.mergeCwd = mergeCwd;
      return { restore() {} };
    },
  });

  const expected = path.join(tempRoot, "cursor-cli-mcp", "chat-packaged");
  assert.equal(observed.mergeCwd, expected);
  assert.equal(observed.spawnCwd, expected);
  assert.ok(observed.args.includes("--workspace"));
  assert.equal(observed.args[observed.args.indexOf("--workspace") + 1], expected);
  assert.ok(!emitter.calls.some((c) => c[0] === "error"));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("runCursorCliTurn surfaces MCP merge failure instead of continuing without tools", async () => {
  const emitter = makeEmitter();
  let spawned = false;

  await runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/",
    chatSessionId: "chat-fail",
    getTempDir: () => "/definitely-not-writable-root-only",
    model: "auto",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "node",
      args: ["server.cjs"],
    }],
    emitter,
    spawnImpl: () => {
      spawned = true;
      const fakeChild = new EventEmitter();
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      fakeChild.killed = false;
      fakeChild.kill = () => {};
      return fakeChild;
    },
    mergeMcp: () => {
      const err = new Error("ENOENT: mkdir '/.cursor'");
      err.code = "ENOENT";
      throw err;
    },
  });

  assert.equal(spawned, false);
  assert.equal(emitter.calls.length, 1);
  assert.equal(emitter.calls[0][0], "error");
  assert.match(emitter.calls[0][1], /Failed to prepare Netcatty MCP for Cursor CLI/i);
});
