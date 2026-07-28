const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCursorCliArgs,
  formatCursorCliErrorForUser,
  listCursorCliModels,
  mergeWorkspaceMcpJson,
  resetMcpMergeRefcountsForTests,
  resolveCursorCliExecMode,
  resolveCursorCliModel,
  resolveCursorCliWorkspaceCwd,
  runCursorCliTurn,
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
});

test("stripCursorApiKeyFromEnv removes CURSOR_API_KEY", () => {
  assert.deepEqual(
    stripCursorApiKeyFromEnv({ CURSOR_API_KEY: "secret", PATH: "/bin" }),
    { PATH: "/bin" },
  );
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
