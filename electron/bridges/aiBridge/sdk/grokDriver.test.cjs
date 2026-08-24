const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS,
  buildGrokCliArgs,
  buildGrokMcpServerTomlSection,
  createLineBuffer,
  formatGrokErrorForUser,
  listGrokModels,
  mergeWorkspaceGrokMcpToml,
  parseGrokModelsOutput,
  resetGrokMcpMergeRefcountsForTests,
  resolveGrokPermissionFlags,
  resolveGrokSpawnSpec,
  resolveGrokToolIntegrationFlags,
  resolveGrokTurnPrompt,
  extractGrokAcpPromptUsage,
  emitGrokUsage,
  normalizeGrokPlanUpdate,
  parseGrokModelSelection,
  shouldReportGrokProcessExitFailure,
  runGrokTurn,
  spawnGrokProcess,
  stripGrokMcpServerSection,
  translateGrokStreamEvent,
} = require("./grokDriver.cjs");

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
    planUpdate: (itemId, items, status) => calls.push(["planUpdate", itemId, items, status]),
    usage: (usage) => calls.push(["usage", usage]),
    emitDone: () => calls.push(["done"]),
    emitError: (message) => calls.push(["error", message]),
  };
}

test("resolveGrokPermissionFlags maps observer to plan and others to always-approve", () => {
  assert.deepEqual(resolveGrokPermissionFlags("observer"), ["--permission-mode", "plan"]);
  assert.deepEqual(resolveGrokPermissionFlags("confirm"), ["--always-approve"]);
  assert.deepEqual(resolveGrokPermissionFlags("auto"), ["--always-approve"]);
});

test("buildGrokCliArgs uses streaming-json and optional model/resume/cwd", () => {
  assert.deepEqual(
    buildGrokCliArgs({
      prompt: "hi",
      model: "grok-4.5",
      cwd: "/repo",
      resumeSessionId: "sess-1",
      permissionMode: "observer",
      toolIntegrationMode: "skills",
    }),
    [
      "--no-auto-update",
      "-p",
      "hi",
      "--output-format",
      "streaming-json",
      "-m",
      "grok-4.5",
      "--cwd",
      "/repo",
      "-r",
      "sess-1",
      "--permission-mode",
      "plan",
    ],
  );

  const autoArgs = buildGrokCliArgs({
    prompt: "go",
    permissionMode: "auto",
    toolIntegrationMode: "skills",
  });
  assert.ok(autoArgs.includes("--always-approve"));
  assert.ok(autoArgs.includes("--no-auto-update"));
  assert.ok(!autoArgs.includes("-m"));
});

test("buildGrokCliArgs passes a selected reasoning effort separately from the model", () => {
  assert.deepEqual(parseGrokModelSelection("grok-4.6/xhigh"), {
    model: "grok-4.6",
    effort: "xhigh",
  });
  assert.deepEqual(parseGrokModelSelection("provider/model"), {
    model: "provider/model",
    effort: undefined,
  });

  const args = buildGrokCliArgs({
    prompt: "hi",
    model: "grok-4.6/xhigh",
    permissionMode: "auto",
    toolIntegrationMode: "skills",
  });
  const modelIdx = args.indexOf("-m");
  const effortIdx = args.indexOf("--reasoning-effort");
  assert.equal(args[modelIdx + 1], "grok-4.6");
  assert.equal(args[effortIdx + 1], "xhigh");
});

test("resolveGrokToolIntegrationFlags locks local side-effect tools only in MCP mode", () => {
  assert.deepEqual(resolveGrokToolIntegrationFlags("skills"), []);
  assert.deepEqual(resolveGrokToolIntegrationFlags("mcp"), [
    "--disallowed-tools",
    GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.join(","),
  ]);
  // Default/unknown → MCP lockdown (align with Claude MCP-mode empty local tools).
  assert.deepEqual(resolveGrokToolIntegrationFlags(undefined), [
    "--disallowed-tools",
    GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.join(","),
  ]);
  assert.ok(GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.includes("run_terminal_command"));
  assert.ok(GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.includes("search_replace"));
  assert.ok(GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.includes("write"));
});

test("buildGrokCliArgs applies MCP-mode local-tool lockdown via real builder", () => {
  const mcpArgs = buildGrokCliArgs({
    prompt: "list sessions",
    permissionMode: "auto",
    toolIntegrationMode: "mcp",
  });
  const denyIdx = mcpArgs.indexOf("--disallowed-tools");
  assert.ok(denyIdx >= 0, "MCP mode must pass --disallowed-tools");
  const denied = String(mcpArgs[denyIdx + 1] || "");
  assert.match(denied, /run_terminal_command/);
  assert.match(denied, /search_replace/);
  assert.match(denied, /write/);
  // MCP meta-tools must not appear in the deny list (Netcatty remote path).
  assert.doesNotMatch(denied, /mcp|netcatty/i);

  const skillsArgs = buildGrokCliArgs({
    prompt: "list sessions",
    permissionMode: "auto",
    toolIntegrationMode: "skills",
  });
  assert.ok(!skillsArgs.includes("--disallowed-tools"), "skills mode must not apply MCP lockdown");
});

test("createLineBuffer rejects and releases an unterminated oversized message", () => {
  const lines = [];
  const lineBuffer = createLineBuffer((line) => lines.push(line), 8);
  lineBuffer.push(Buffer.from("12345678"));
  assert.throws(
    () => lineBuffer.push(Buffer.from("9")),
    (error) => error?.code === "GROK_LINE_LIMIT",
  );
  lineBuffer.flush();
  assert.deepEqual(lines, []);
});

test("formatGrokErrorForUser maps auth failures without over-matching bare login strings", () => {
  assert.match(
    formatGrokErrorForUser("Not authenticated"),
    /not logged in/i,
  );
  assert.equal(
    formatGrokErrorForUser("Failed to run login form validation"),
    "Failed to run login form validation",
  );
});

test("resolveGrokSpawnSpec matches prepareCommandForSpawn for cmd shims and exes", () => {
  const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");
  // On win32, .cmd needs shell (or native-exe rewrite). Elsewhere shell stays false.
  const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd";
  const expected = prepareCommandForSpawn(shim, ["agent", "stdio"]);
  const actual = resolveGrokSpawnSpec(shim, ["agent", "stdio"]);
  assert.deepEqual(actual, expected);
  if (process.platform === "win32") {
    assert.equal(actual.shell, true);
    assert.equal(actual.args.length, 0);
  } else {
    assert.equal(actual.shell, false);
  }

  const exePath = process.platform === "win32" ? "C:\\Tools\\grok.exe" : "/usr/bin/grok";
  const exe = resolveGrokSpawnSpec(exePath, ["-p", "hi"]);
  assert.equal(exe.shell, false);
  assert.equal(exe.command, exePath);
  assert.deepEqual(exe.args, ["-p", "hi"]);
});

test("spawnGrokProcess forwards shell from prepareCommandForSpawn into spawnImpl", () => {
  const calls = [];
  const fakeChild = {
    stdout: { on() {} },
    stderr: { on() {} },
    stdin: null,
    on() {},
    kill() {},
  };
  const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd";
  const child = spawnGrokProcess(
    (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild;
    },
    shim,
    ["agent", "stdio"],
    { cwd: "D:\\repo", windowsHide: true },
  );
  assert.equal(child, fakeChild);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, "D:\\repo");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, process.platform === "win32");
  if (process.platform === "win32") {
    assert.match(String(calls[0].command), /grok\.cmd/i);
    assert.deepEqual(calls[0].args, []);
  } else {
    assert.equal(calls[0].command, shim);
    assert.deepEqual(calls[0].args, ["agent", "stdio"]);
  }
});

test("extractGrokAcpPromptUsage maps live Grok _meta.usage and cachedReadTokens", () => {
  const promptResult = {
    stopReason: "end_turn",
    _meta: {
      inputTokens: 27144,
      outputTokens: 29,
      totalTokens: 27174,
      cachedReadTokens: 2560,
      reasoningTokens: 24,
      usage: {
        inputTokens: 27144,
        outputTokens: 29,
        totalTokens: 27173,
        cachedReadTokens: 2560,
        reasoningTokens: 24,
      },
    },
  };
  const extracted = extractGrokAcpPromptUsage(promptResult);
  assert.equal(extracted.cachedReadTokens, 2560);
  const calls = [];
  emitGrokUsage({ usage: (u) => calls.push(u) }, extracted);
  assert.deepEqual(calls[0], {
    inputTokens: 27144,
    cachedInputTokens: 2560,
    outputTokens: 29,
    reasoningTokens: 24,
    totalTokens: 27173,
  });
});

test("resolveGrokTurnPrompt seeds history only when resume falls back to session/new", () => {
  const seed = "[Conversation context replay]\nUSER: earlier";
  const turn = "latest question";
  assert.equal(
    resolveGrokTurnPrompt({
      turnPrompt: turn,
      historySeed: seed,
      resumeSessionId: "old-sess",
      establishMethod: "new",
    }),
    `${seed}\n\n${turn}`,
  );
  // Successful resume/load must not inject seed (avoids stacked prior replies).
  assert.equal(
    resolveGrokTurnPrompt({
      turnPrompt: turn,
      historySeed: seed,
      resumeSessionId: "old-sess",
      establishMethod: "resume",
    }),
    turn,
  );
  assert.equal(
    resolveGrokTurnPrompt({
      turnPrompt: turn,
      historySeed: seed,
      resumeSessionId: "old-sess",
      establishMethod: "load",
    }),
    turn,
  );
  // No resume attempt → never seed (first-turn replay is handled upstream).
  assert.equal(
    resolveGrokTurnPrompt({
      turnPrompt: turn,
      historySeed: seed,
      resumeSessionId: undefined,
      establishMethod: "new",
    }),
    turn,
  );
  assert.equal(
    resolveGrokTurnPrompt({
      turnPrompt: turn,
      historySeed: "",
      resumeSessionId: "old-sess",
      establishMethod: "new",
    }),
    turn,
  );
});

test("translateGrokStreamEvent maps thought, text, tools, usage, end", () => {
  const emitter = makeEmitter();
  const state = {};

  translateGrokStreamEvent({ type: "thought", data: "plan" }, emitter, state);
  translateGrokStreamEvent({ type: "text", data: "Hi" }, emitter, state);
  translateGrokStreamEvent({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "read_file",
    status: "in_progress",
    rawInput: { path: "a.ts" },
  }, emitter, state);
  translateGrokStreamEvent({
    type: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    rawOutput: { lines: 2 },
  }, emitter, state);
  translateGrokStreamEvent({
    type: "usage",
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 1,
      reasoning_tokens: 2,
      total_tokens: 16,
    },
  }, emitter, state);
  translateGrokStreamEvent({
    type: "end",
    stopReason: "end_turn",
    sessionId: "s1",
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  }, emitter, state);

  assert.deepEqual(emitter.calls, [
    ["reasoning", "plan"],
    ["reasoningEnd"],
    ["text", "Hi"],
    ["toolCall", "read_file", { path: "a.ts" }, "c1"],
    ["toolResult", "c1", "{\"lines\":2}", "read_file"],
    ["usage", {
      inputTokens: 10,
      cachedInputTokens: 1,
      outputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 16,
    }],
    ["sessionId", "s1"],
    ["usage", {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningTokens: 0,
      totalTokens: 13,
    }],
  ]);
  assert.equal(state.sessionId, "s1");
  assert.equal(state.streamedAssistantText, true);
});

test("translateGrokStreamEvent maps error events to emitError and stop", () => {
  const emitter = makeEmitter();
  const state = {};
  const stop = translateGrokStreamEvent(
    { type: "error", message: "Couldn't start session" },
    emitter,
    state,
  );
  assert.equal(stop, true);
  assert.equal(state.failed, true);
  assert.deepEqual(emitter.calls, [["error", "Couldn't start session"]]);
});

test("buildGrokMcpServerTomlSection escapes paths and env", () => {
  const section = buildGrokMcpServerTomlSection({
    name: "netcatty-remote-hosts",
    command: "C:\\Program Files\\node.exe",
    args: ["mcp.cjs", "--flag"],
    env: [{ name: "TOKEN", value: 'a"b' }],
  });
  assert.match(section, /\[mcp_servers\.netcatty-remote-hosts\]/);
  assert.match(section, /command = "C:\\\\Program Files\\\\node\.exe"/);
  assert.match(section, /args = \["mcp\.cjs", "--flag"\]/);
  assert.match(section, /TOKEN = "a\\"b"/);
  assert.match(section, /enabled = true/);
});

test("stripGrokMcpServerSection removes only the named server block", () => {
  const input = [
    "[ui]",
    "compact_mode = true",
    "",
    "[mcp_servers.other]",
    'command = "echo"',
    "",
    "[mcp_servers.netcatty-remote-hosts]",
    'command = "node"',
    "enabled = true",
    "",
    "[mcp_servers.other.nested]",
    "x = 1",
  ].join("\n");

  const stripped = stripGrokMcpServerSection(input, "netcatty-remote-hosts");
  assert.match(stripped, /\[mcp_servers\.other\]/);
  assert.match(stripped, /\[ui\]/);
  assert.doesNotMatch(stripped, /netcatty-remote-hosts/);
});

test("mergeWorkspaceGrokMcpToml upserts netcatty without dropping other servers", () => {
  resetGrokMcpMergeRefcountsForTests();
  const path = require("node:path");
  const repo = path.join("repo-fixture");
  const grokDir = path.join(repo, ".grok");
  const configPath = path.join(grokDir, "config.toml");
  const original = [
    "[mcp_servers.other]",
    'command = "echo"',
    "enabled = true",
    "",
  ].join("\n");
  const files = new Map();
  files.set(configPath, original);

  const handle = mergeWorkspaceGrokMcpToml(repo, [{
    name: "netcatty-remote-hosts",
    command: "node",
    args: ["mcp.cjs"],
    env: [{ name: "TOKEN", value: "x" }],
  }], {
    existsSync: (p) => files.has(p) || p === grokDir,
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, data) => { files.set(p, data); },
    mkdirSync: () => {},
    unlinkSync: (p) => { files.delete(p); },
  });

  const written = files.get(configPath);
  assert.match(written, /\[mcp_servers\.other\]/);
  assert.match(written, /\[mcp_servers\.netcatty-remote-hosts\]/);
  assert.match(written, /TOKEN = "x"/);

  handle.restore();
  assert.equal(files.get(configPath), original);
});

test("parseGrokModelsOutput reads default and bullet list", () => {
  const parsed = parseGrokModelsOutput([
    "You are logged in with grok.com.",
    "",
    "Default model: grok-4.5",
    "",
    "Available models:",
    "  * grok-4.5 (default)",
    "  * grok-code-fast",
  ].join("\n"));
  assert.equal(parsed.currentModelId, "grok-4.5");
  assert.deepEqual(parsed.models, [
    {
      id: "grok-4.5",
      name: "grok-4.5",
      thinkingLevels: ["high", "medium", "low"],
      defaultThinkingLevel: "high",
    },
    { id: "grok-code-fast", name: "grok-code-fast" },
  ]);
});

test("runGrokTurn streams fixture lines and emits done", async () => {
  const emitter = makeEmitter();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = () => {};

  const spawnImpl = (bin, args) => {
    assert.equal(bin, "/usr/bin/grok");
    assert.ok(args.includes("streaming-json"));
    assert.ok(args.includes("--always-approve"));
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(
        [
          '{"type":"thought","data":"thinking"}',
          '{"type":"text","data":"hello"}',
          '{"type":"end","sessionId":"sess-xyz","stopReason":"end_turn"}',
          "",
        ].join("\n"),
      ));
      child.emit("close", 0);
    });
    return child;
  };

  const result = await runGrokTurn({
    prompt: "hi",
    binPath: "/usr/bin/grok",
    cwd: "/repo",
    permissionMode: "auto",
    injectedMcpServers: [],
    emitter,
    spawnImpl,
    mergeMcp: () => ({ restore() {} }),
  });

  assert.equal(result.sessionId, "sess-xyz");
  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "hello"));
  assert.ok(emitter.calls.some((c) => c[0] === "done"));
  assert.ok(emitter.calls.some((c) => c[0] === "sessionId" && c[1] === "sess-xyz"));
});

test("runGrokTurn reports error when process dies after partial text without end", async () => {
  // Mid-response crash: text already streamed, no end → must not emitDone.
  const emitter = makeEmitter();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 99;
  child.kill = () => {};

  const spawnImpl = () => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"type":"text","data":"partial…"}\n'));
      child.emit("close", 1);
    });
    return child;
  };

  await runGrokTurn({
    prompt: "write a lot",
    binPath: "/usr/bin/grok",
    permissionMode: "auto",
    injectedMcpServers: [],
    emitter,
    spawnImpl,
    mergeMcp: () => ({ restore() {} }),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "partial…"));
  assert.ok(emitter.calls.some((c) => c[0] === "error"), "partial stream + exit 1 must emitError");
  assert.ok(!emitter.calls.some((c) => c[0] === "done"), "must not emitDone on mid-turn crash");
});

test("runGrokTurn fails when process is signal-killed mid-turn (code=null)", async () => {
  // Node close(null, "SIGTERM") — previously skipped because code was not a nonzero number.
  const emitter = makeEmitter();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 98;
  child.kill = () => {};

  const spawnImpl = () => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"type":"text","data":"partial…"}\n'));
      child.emit("close", null, "SIGTERM");
    });
    return child;
  };

  await runGrokTurn({
    prompt: "write a lot",
    binPath: "/usr/bin/grok",
    permissionMode: "auto",
    injectedMcpServers: [],
    emitter,
    spawnImpl,
    mergeMcp: () => ({ restore() {} }),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "partial…"));
  const err = emitter.calls.find((c) => c[0] === "error");
  assert.ok(err, "signal kill mid-turn must emitError");
  assert.match(String(err[1]), /SIGTERM|signal/i);
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});

test("runGrokTurn fails when process exits 0 after partial text without end", async () => {
  // Quiet CLI death must not look like a successful turn.
  const emitter = makeEmitter();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 97;
  child.kill = () => {};

  const spawnImpl = () => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"type":"text","data":"partial…"}\n'));
      child.emit("close", 0);
    });
    return child;
  };

  await runGrokTurn({
    prompt: "write a lot",
    binPath: "/usr/bin/grok",
    permissionMode: "auto",
    injectedMcpServers: [],
    emitter,
    spawnImpl,
    mergeMcp: () => ({ restore() {} }),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "partial…"));
  assert.ok(emitter.calls.some((c) => c[0] === "error"), "exit 0 without end must emitError");
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});

test("translateGrokStreamEvent emits toolResult when rawOutput present without status", () => {
  const emitter = makeEmitter();
  const state = {};
  translateGrokStreamEvent({
    type: "tool_call_update",
    toolCallId: "t1",
    toolName: "read",
    rawOutput: { content: "file body" },
  }, emitter, state);
  assert.ok(emitter.calls.some((c) => c[0] === "toolCall" && c[3] === "t1"));
  assert.ok(emitter.calls.some((c) => c[0] === "toolResult" && c[1] === "t1"));
});

test("normalizeGrokPlanUpdate maps to shared { text, completed } activity shape", () => {
  assert.deepEqual(
    normalizeGrokPlanUpdate([
      { content: "Explore", status: "completed" },
      { text: "Edit", status: "pending" },
      "Ship it",
    ]),
    {
      items: [
        { text: "Explore", completed: true },
        { text: "Edit", completed: false },
        { text: "Ship it", completed: false },
      ],
      status: "running",
    },
  );
  assert.deepEqual(
    normalizeGrokPlanUpdate([
      { content: "A", status: "done" },
      { content: "B", completed: true },
    ]),
    {
      items: [
        { text: "A", completed: true },
        { text: "B", completed: true },
      ],
      status: "completed",
    },
  );
  assert.equal(normalizeGrokPlanUpdate([]), null);
});

test("translateGrokStreamEvent plan uses text/completed and running|completed status", () => {
  const emitter = makeEmitter();
  translateGrokStreamEvent({
    type: "plan",
    entries: [
      { content: "Step one", status: "completed" },
      { content: "Step two", status: "in_progress" },
    ],
  }, emitter, {});
  const planCall = emitter.calls.find((c) => c[0] === "planUpdate");
  assert.ok(planCall);
  assert.equal(planCall[1], "grok-plan");
  assert.deepEqual(planCall[2], [
    { text: "Step one", completed: true },
    { text: "Step two", completed: false },
  ]);
  assert.equal(planCall[3], "running");
  assert.notEqual(planCall[3], "updated");
});

test("shouldReportGrokProcessExitFailure fails any incomplete close (incl exit 0)", () => {
  assert.equal(shouldReportGrokProcessExitFailure({ turnCompleted: false }, null, null, "SIGTERM"), true);
  assert.equal(shouldReportGrokProcessExitFailure({ turnCompleted: false }, null, 143, null), true);
  // Exit 0 without protocol completion is still a failure (CLI can die quietly).
  assert.equal(shouldReportGrokProcessExitFailure({ turnCompleted: false }, null, 0, null), true);
  assert.equal(shouldReportGrokProcessExitFailure({ turnCompleted: true }, null, null, "SIGTERM"), false);
  assert.equal(shouldReportGrokProcessExitFailure({ turnCompleted: true }, null, 1, null), false);
  assert.equal(shouldReportGrokProcessExitFailure({ turnCompleted: false }, { aborted: true }, null, "SIGKILL"), false);
  assert.equal(shouldReportGrokProcessExitFailure({ turnCompleted: false, failed: true }, null, 1, null), false);
});

test("runGrokTurn ignores exit code 1 after end event (Windows teardown)", async () => {
  const emitter = makeEmitter();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 100;
  child.kill = () => {};

  const spawnImpl = () => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(
        [
          '{"type":"text","data":"done"}',
          '{"type":"end","sessionId":"s-end","stopReason":"end_turn"}',
          "",
        ].join("\n"),
      ));
      child.emit("close", 1);
    });
    return child;
  };

  await runGrokTurn({
    prompt: "hi",
    binPath: "/usr/bin/grok",
    permissionMode: "auto",
    injectedMcpServers: [],
    emitter,
    spawnImpl,
    mergeMcp: () => ({ restore() {} }),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "done"));
  assert.ok(!emitter.calls.some((c) => c[0] === "error"));
});

test("runGrokTurn reports missing CLI clearly", async () => {
  const emitter = makeEmitter();
  const result = await runGrokTurn({
    prompt: "hi",
    binPath: "",
    emitter,
  });
  assert.equal(result.sessionId, null);
  assert.match(String(emitter.calls[0]?.[1] || ""), /not found/i);
});

test("listGrokModels parses spawn stdout", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1;
  child.kill = () => {};

  const spawnImpl = (_bin, args) => {
    assert.deepEqual(args, ["--no-auto-update", "models"]);
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("Default model: grok-4.5\n* grok-4.5 (default)\n"));
      child.emit("close", 0);
    });
    return child;
  };

  const result = await listGrokModels({
    binPath: "/usr/bin/grok",
    spawnImpl,
  });
  assert.equal(result.currentModelId, "grok-4.5");
  assert.equal(result.models[0].id, "grok-4.5");
});
