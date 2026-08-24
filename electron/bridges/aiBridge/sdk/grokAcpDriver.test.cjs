const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  ACP_PROTOCOL_VERSION,
  authenticateGrokAcp,
  buildGrokAcpInitializeParams,
  buildGrokAcpPermissionResponse,
  buildGrokAcpPromptParams,
  buildGrokAcpSessionNewParams,
  buildGrokAcpSessionResumeOrLoadParams,
  buildGrokAcpSpawnArgs,
  createJsonRpcClient,
  establishGrokAcpSession,
  handleGrokAcpMessage,
  listGrokAcpModels,
  parseGrokAcpAgentCapabilities,
  parseGrokAcpModelCatalog,
  planGrokAcpSessionEstablish,
  resolveGrokAcpCwd,
  runGrokAcpTurn,
  selectGrokAcpAuthMethodId,
  toAcpMcpEnvPairs,
  toAcpMcpServers,
  translateGrokAcpUpdate,
} = require("./grokAcpDriver.cjs");
const {
  GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS,
  shouldReportGrokProcessExitFailure,
} = require("./grokDriver.cjs");
const { getDriver, listBackends } = require("./index.cjs");

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

test("buildGrokAcpSpawnArgs uses agent stdio, no-auto-update, and always-approve for non-observer", () => {
  const args = buildGrokAcpSpawnArgs({
    model: "grok-4.5",
    permissionMode: "auto",
    toolIntegrationMode: "skills",
  });
  assert.deepEqual(args, [
    "--no-auto-update",
    "agent",
    "--always-approve",
    "-m",
    "grok-4.5",
    "stdio",
  ]);
  const observer = buildGrokAcpSpawnArgs({
    permissionMode: "observer",
    toolIntegrationMode: "skills",
  });
  assert.deepEqual(observer, ["--no-auto-update", "agent", "stdio"]);
});

test("buildGrokAcpSpawnArgs passes a selected reasoning effort separately from the model", () => {
  assert.deepEqual(buildGrokAcpSpawnArgs({
    model: "grok-4.6/high",
    permissionMode: "auto",
    toolIntegrationMode: "skills",
  }), [
    "--no-auto-update",
    "agent",
    "--always-approve",
    "-m",
    "grok-4.6",
    "--reasoning-effort",
    "high",
    "stdio",
  ]);
});

test("parseGrokAcpModelCatalog exposes only each model's advertised reasoning efforts", () => {
  const catalog = parseGrokAcpModelCatalog({
    _meta: {
      modelState: {
        currentModelId: "grok-4.6",
        availableModels: [
          {
            modelId: "grok-4.6",
            name: "Grok 4.6",
            description: "Latest",
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [
                { id: "deep", value: "xhigh", label: "Extra High" },
                { id: "high", value: "high", label: "High" },
                { id: "medium", value: "medium", label: "Medium" },
                { id: "low", value: "low", label: "Low" },
              ],
            },
          },
          {
            modelId: "ocx-fast",
            name: "OCX Fast",
            _meta: { supportsReasoningEffort: false },
          },
        ],
      },
    },
  });

  assert.deepEqual(catalog, {
    currentModelId: "grok-4.6/high",
    models: [
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        description: "Latest",
        thinkingLevels: ["xhigh", "high", "medium", "low"],
        defaultThinkingLevel: "high",
      },
      { id: "ocx-fast", name: "OCX Fast" },
    ],
  });
});

test("parseGrokAcpModelCatalog fills known legacy models without overriding explicit no-reasoning metadata", () => {
  const catalog = parseGrokAcpModelCatalog({
    _meta: {
      modelState: {
        currentModelId: "grok-4.5",
        availableModels: [
          { modelId: "grok-4.5", name: "Grok 4.5" },
          {
            modelId: "grok-4.6",
            name: "Grok 4.6",
            _meta: { supportsReasoningEffort: false },
          },
        ],
      },
    },
  });

  assert.deepEqual(catalog.models, [
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      thinkingLevels: ["high", "medium", "low"],
      defaultThinkingLevel: "high",
    },
    { id: "grok-4.6", name: "Grok 4.6" },
  ]);
  assert.equal(catalog.currentModelId, "grok-4.5/high");
});

test("parseGrokAcpModelCatalog uses a model-specific fallback when advertised options are empty", () => {
  const catalog = parseGrokAcpModelCatalog({
    _meta: {
      modelState: {
        currentModelId: "grok-4.5",
        availableModels: [{
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEfforts: [],
          },
        }],
      },
    },
  });

  assert.equal(catalog.currentModelId, "grok-4.5/high");
  assert.deepEqual(catalog.models[0].thinkingLevels, ["high", "medium", "low"]);
  assert.ok(!catalog.models[0].thinkingLevels.includes("xhigh"));
});

test("listGrokAcpModels reads reasoning metadata from the initialize response", async () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.exitCode = null;
  child.killed = false;
  child.pid = 42;
  child.kill = () => { child.killed = true; };
  child.stdin.write = (line, callback) => {
    const request = JSON.parse(String(line));
    assert.equal(request.method, "initialize");
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          _meta: {
            modelState: {
              currentModelId: "grok-4.6",
              availableModels: [{
                modelId: "grok-4.6",
                name: "Grok 4.6",
                _meta: {
                  supportsReasoningEffort: true,
                  reasoningEffort: "high",
                  reasoningEfforts: [
                    { id: "high", value: "high" },
                    { id: "low", value: "low" },
                  ],
                },
              }],
            },
          },
        },
      })}\n`));
      callback?.();
    });
    return true;
  };

  const signals = [];
  const catalog = await listGrokAcpModels({
    binPath: "/usr/bin/grok",
    spawnImpl: (bin, args) => {
      assert.equal(bin, "/usr/bin/grok");
      assert.deepEqual(args, ["--no-auto-update", "agent", "stdio"]);
      return child;
    },
    forceKillImpl: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("close", 0);
        });
      }
    },
  });

  assert.equal(catalog.currentModelId, "grok-4.6/high");
  assert.deepEqual(catalog.models[0].thinkingLevels, ["high", "low"]);
  assert.equal(catalog.models[0].defaultThinkingLevel, "high");
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("listGrokAcpModels force-kills a model probe that ignores timeout shutdown", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  child.exitCode = null;
  child.killed = false;
  child.pid = 43;
  const signals = [];

  const keepAlive = setTimeout(() => {}, 50);
  let catalog;
  try {
    catalog = await listGrokAcpModels({
      binPath: "/usr/bin/grok",
      spawnImpl: () => child,
      timeoutMs: 2,
      abortGraceMs: 2,
      forceKillImpl: (_child, signal) => signals.push(signal),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    clearTimeout(keepAlive);
  }

  assert.deepEqual(catalog, { currentModelId: null, models: [] });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("listGrokAcpModels force-kills a model probe that ignores abort shutdown", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  child.exitCode = null;
  child.killed = false;
  child.pid = 44;
  const signals = [];
  const controller = new AbortController();

  const pending = listGrokAcpModels({
    binPath: "/usr/bin/grok",
    spawnImpl: () => child,
    signal: controller.signal,
    timeoutMs: 100,
    abortGraceMs: 2,
    forceKillImpl: (_child, signal) => signals.push(signal),
  });
  controller.abort();
  const catalog = await pending;
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(catalog, { currentModelId: null, models: [] });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("registry Grok model discovery enriches legacy fallback reasoning levels", async () => {
  const grokModule = require("./grokDriver.cjs");
  const grokAcpModule = require("./grokAcpDriver.cjs");
  const originalAcp = grokAcpModule.listGrokAcpModels;
  const originalLegacy = grokModule.listGrokModels;
  grokAcpModule.listGrokAcpModels = async () => ({ currentModelId: null, models: [] });
  grokModule.listGrokModels = async () => ({
    currentModelId: "grok-4.6",
    models: [grokModule.applyGrokReasoningFallback({ id: "grok-4.6", name: "Grok 4.6" })],
  });
  try {
    const catalog = await getDriver("grok").listModels({});
    assert.equal(catalog.currentModelId, "grok-4.6/high");
    assert.deepEqual(catalog.models[0].thinkingLevels, ["xhigh", "high", "medium", "low"]);
    assert.equal(catalog.models[0].defaultThinkingLevel, "high");
  } finally {
    grokAcpModule.listGrokAcpModels = originalAcp;
    grokModule.listGrokModels = originalLegacy;
  }
});

test("registry Grok model discovery keeps ACP current model when its list is incomplete", async () => {
  const grokModule = require("./grokDriver.cjs");
  const grokAcpModule = require("./grokAcpDriver.cjs");
  const originalAcp = grokAcpModule.listGrokAcpModels;
  const originalLegacy = grokModule.listGrokModels;
  grokAcpModule.listGrokAcpModels = async () => ({ currentModelId: "grok-4.6", models: [] });
  grokModule.listGrokModels = async () => ({ currentModelId: "grok-4.5", models: [] });
  try {
    const catalog = await getDriver("grok").listModels({});
    assert.equal(catalog.currentModelId, "grok-4.6/high");
    assert.deepEqual(catalog.models, [{
      id: "grok-4.6",
      name: "grok-4.6",
      thinkingLevels: ["xhigh", "high", "medium", "low"],
      defaultThinkingLevel: "high",
    }]);
  } finally {
    grokAcpModule.listGrokAcpModels = originalAcp;
    grokModule.listGrokModels = originalLegacy;
  }
});

test("buildGrokAcpSpawnArgs places global MCP lockdown before agent subcommand", () => {
  const args = buildGrokAcpSpawnArgs({
    model: "grok-4.5",
    permissionMode: "auto",
    toolIntegrationMode: "mcp",
  });
  const agentIdx = args.indexOf("agent");
  const denyIdx = args.indexOf("--disallowed-tools");
  const noUpdateIdx = args.indexOf("--no-auto-update");
  const alwaysIdx = args.indexOf("--always-approve");
  const modelIdx = args.indexOf("-m");
  assert.ok(agentIdx >= 0, "must include agent subcommand");
  assert.ok(denyIdx >= 0, "MCP mode must pass --disallowed-tools on ACP spawn");
  // Live grok rejects --disallowed-tools AFTER `agent` (unexpected argument).
  assert.ok(noUpdateIdx < agentIdx, "--no-auto-update must be before agent");
  assert.ok(denyIdx < agentIdx, "--disallowed-tools must be before agent");
  assert.ok(alwaysIdx > agentIdx, "--always-approve is agent-local (after agent)");
  assert.ok(modelIdx > agentIdx, "-m is agent-local (after agent)");
  assert.equal(args[args.length - 1], "stdio");
  assert.deepEqual(args, [
    "--no-auto-update",
    "--disallowed-tools",
    GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.join(","),
    "agent",
    "--always-approve",
    "-m",
    "grok-4.5",
    "stdio",
  ]);
  const denied = String(args[denyIdx + 1] || "");
  assert.match(denied, /run_terminal_command/);
  assert.match(denied, /search_replace/);
  assert.match(denied, /write/);
  assert.doesNotMatch(denied, /mcp|netcatty/i);
  // Skills mode: no lockdown list; global flags still precede agent.
  const skills = buildGrokAcpSpawnArgs({
    permissionMode: "auto",
    toolIntegrationMode: "skills",
  });
  assert.ok(!skills.includes("--disallowed-tools"));
  assert.ok(skills.indexOf("--no-auto-update") < skills.indexOf("agent"));
});

test("toAcpMcpEnvPairs keeps Grok session/new pair-array shape", () => {
  // Live Grok rejects plain object env (Invalid params / McpServer enum).
  assert.deepEqual(
    toAcpMcpEnvPairs([{ name: "NETCATTY_MCP_PORT", value: "9" }]),
    [{ name: "NETCATTY_MCP_PORT", value: "9" }],
  );
  // If a plain object sneaks in, still emit pairs (not a map).
  assert.deepEqual(
    toAcpMcpEnvPairs({ NETCATTY_MCP_PORT: "9", NETCATTY_MCP_TOKEN: "t" }),
    [
      { name: "NETCATTY_MCP_PORT", value: "9" },
      { name: "NETCATTY_MCP_TOKEN", value: "t" },
    ],
  );
  assert.deepEqual(toAcpMcpEnvPairs(undefined), []);
});

test("toAcpMcpServers maps injectMcp env as name/value pairs for session/new", () => {
  assert.deepEqual(
    toAcpMcpServers([{
      name: "netcatty-remote-hosts",
      command: "node",
      args: ["mcp.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "9" }, { name: "NETCATTY_MCP_TOKEN", value: "t" }],
    }]),
    [{
      name: "netcatty-remote-hosts",
      type: "stdio",
      command: "node",
      args: ["mcp.cjs"],
      env: [
        { name: "NETCATTY_MCP_PORT", value: "9" },
        { name: "NETCATTY_MCP_TOKEN", value: "t" },
      ],
    }],
  );
  // Must never emit object-map env (Grok session/new rejects it).
  const mapped = toAcpMcpServers([{
    name: "x",
    command: "node",
    args: [],
    env: { A: "1" },
  }]);
  assert.ok(Array.isArray(mapped[0].env));
  assert.equal(mapped[0].type, "stdio");
  assert.deepEqual(mapped[0].env, [{ name: "A", value: "1" }]);
});

test("buildGrokAcpSessionNewParams injects MCP servers and MCP-mode rules", () => {
  const params = buildGrokAcpSessionNewParams({
    cwd: "/repo",
    permissionMode: "auto",
    toolIntegrationMode: "mcp",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "node",
      args: ["mcp.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });
  assert.equal(params.cwd, resolveGrokAcpCwd("/repo"));
  assert.equal(params.mcpServers[0].name, "netcatty-remote-hosts");
  assert.equal(params.mcpServers[0].type, "stdio");
  assert.ok(Array.isArray(params.mcpServers[0].env));
  assert.deepEqual(params.mcpServers[0].env, [{ name: "NETCATTY_MCP_PORT", value: "1" }]);
  // Explicitly forbid the broken object-map shape in the shipped builder output.
  assert.equal(typeof params.mcpServers[0].env.NETCATTY_MCP_PORT, "undefined");
  assert.equal(params._meta.yoloMode, true);
  assert.match(String(params._meta.rules || ""), /netcatty-remote-hosts|MCP mode/i);
  assert.match(String(params._meta.rules || ""), /run_terminal_command|search_replace|write/);
  // Soft rules list the same local tools as the hard CLI deny list.
  for (const tool of GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS) {
    assert.match(String(params._meta.rules || ""), new RegExp(tool));
  }

  const skills = buildGrokAcpSessionNewParams({
    cwd: "/repo",
    permissionMode: "auto",
    toolIntegrationMode: "skills",
    injectedMcpServers: [],
  });
  assert.equal(skills._meta.yoloMode, true);
  assert.equal(skills._meta.rules, undefined);
});

test("planGrokAcpSessionEstablish prefers resume then load then new", () => {
  assert.deepEqual(planGrokAcpSessionEstablish({ resumeSessionId: null }), ["new"]);
  assert.deepEqual(planGrokAcpSessionEstablish({
    resumeSessionId: "s1",
    agentCapabilities: { resume: true, loadSession: true, hasCapabilityInfo: true },
  }), ["resume", "load", "new"]);
  assert.deepEqual(planGrokAcpSessionEstablish({
    resumeSessionId: "s1",
    agentCapabilities: { resume: true, loadSession: false, hasCapabilityInfo: true },
  }), ["resume", "new"]);
  assert.deepEqual(planGrokAcpSessionEstablish({
    resumeSessionId: "s1",
    agentCapabilities: { resume: false, loadSession: true, hasCapabilityInfo: true },
  }), ["load", "new"]);
  // Unknown capabilities: try resume + load then new (Grok versions vary).
  assert.deepEqual(planGrokAcpSessionEstablish({
    resumeSessionId: "s1",
    agentCapabilities: { resume: false, loadSession: false, hasCapabilityInfo: false },
  }), ["resume", "load", "new"]);
});

test("parseGrokAcpAgentCapabilities reads loadSession and sessionCapabilities.resume", () => {
  assert.deepEqual(parseGrokAcpAgentCapabilities({
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
    },
  }), { loadSession: true, resume: true, hasCapabilityInfo: true });
  assert.deepEqual(parseGrokAcpAgentCapabilities({}), {
    loadSession: false,
    resume: false,
    hasCapabilityInfo: false,
  });
});

test("selectGrokAcpAuthMethodId follows xAI sample precedence", () => {
  assert.deepEqual(
    selectGrokAcpAuthMethodId({ authMethods: [] }, {}),
    { methodId: null, required: false },
  );
  assert.deepEqual(
    selectGrokAcpAuthMethodId({
      authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
    }, { XAI_API_KEY: "xai-test" }),
    { methodId: "xai.api_key", required: true },
  );
  assert.deepEqual(
    selectGrokAcpAuthMethodId({
      authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
    }, {}),
    { methodId: "cached_token", required: true },
  );
  assert.deepEqual(
    selectGrokAcpAuthMethodId({ authMethods: [{ id: "other" }] }, {}),
    { methodId: null, required: true },
  );
});

test("authenticateGrokAcp skips when no methods; errors when required method missing", async () => {
  const calls = [];
  const rpc = {
    async request(method, params) {
      calls.push([method, params]);
      return {};
    },
  };
  const skipped = await authenticateGrokAcp(rpc, { authMethods: [] }, {});
  assert.equal(skipped.skipped, true);
  assert.deepEqual(calls, []);

  await assert.rejects(
    () => authenticateGrokAcp(rpc, { authMethods: [{ id: "unknown" }] }, {}),
    /grok login|XAI_API_KEY/i,
  );

  const ok = await authenticateGrokAcp(
    rpc,
    { authMethods: [{ id: "cached_token" }] },
    {},
  );
  assert.equal(ok.methodId, "cached_token");
  assert.equal(calls[0][0], "authenticate");
  assert.equal(calls[0][1].methodId, "cached_token");
  assert.equal(calls[0][1]._meta.headless, true);
});

test("establishGrokAcpSession tries resume then falls back to load then new", async () => {
  const methods = [];
  const rpc = {
    async request(method, params) {
      methods.push([method, params]);
      if (method === "session/resume") throw new Error("resume unsupported");
      if (method === "session/load") {
        // Simulate history replay side-channel; caller keeps acceptUpdates false.
        return { sessionId: "loaded-1" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const result = await establishGrokAcpSession(rpc, {
    resumeSessionId: "prev-1",
    cwd: "/repo",
    injectedMcpServers: [],
    agentCapabilities: { resume: true, loadSession: true, hasCapabilityInfo: true },
  });
  assert.equal(result.method, "load");
  assert.equal(result.sessionId, "loaded-1");
  assert.deepEqual(methods.map((m) => m[0]), ["session/resume", "session/load"]);
  assert.equal(methods[0][1].sessionId, "prev-1");
  assert.equal(methods[0][1].cwd, resolveGrokAcpCwd("/repo"));
});

test("establishGrokAcpSession prefers resume when it succeeds", async () => {
  const methods = [];
  const rpc = {
    async request(method, params) {
      methods.push(method);
      if (method === "session/resume") return {};
      throw new Error(`unexpected ${method}`);
    },
  };
  const result = await establishGrokAcpSession(rpc, {
    resumeSessionId: "prev-2",
    cwd: path.resolve("/repo"),
    injectedMcpServers: [],
    agentCapabilities: { resume: true, loadSession: true, hasCapabilityInfo: true },
  });
  assert.equal(result.method, "resume");
  assert.equal(result.sessionId, "prev-2");
  assert.deepEqual(methods, ["session/resume"]);
});

test("buildGrokAcpSessionResumeOrLoadParams keeps absolute cwd and MCP pairs", () => {
  const params = buildGrokAcpSessionResumeOrLoadParams({
    sessionId: "s1",
    cwd: "relative-dir",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "node",
      args: ["x"],
      env: { A: "1" },
    }],
  });
  assert.equal(params.sessionId, "s1");
  assert.equal(params.cwd, resolveGrokAcpCwd("relative-dir"));
  assert.ok(path.isAbsolute(params.cwd));
  assert.deepEqual(params.mcpServers[0].env, [{ name: "A", value: "1" }]);
});

test("buildGrokAcpInitializeParams and prompt params follow ACP shapes", () => {
  const init = buildGrokAcpInitializeParams();
  assert.equal(init.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.equal(init.clientInfo.name, "netcatty");
  assert.deepEqual(
    buildGrokAcpPromptParams("sess-1", "hello"),
    { sessionId: "sess-1", prompt: [{ type: "text", text: "hello" }] },
  );
});

test("translateGrokAcpUpdate maps text, thought, tools to canonical emitter events", () => {
  const emitter = makeEmitter();
  const state = {};
  translateGrokAcpUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { text: "plan" },
  }, emitter, state);
  translateGrokAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { text: "Hi" },
  }, emitter, state);
  translateGrokAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    toolName: "mcp__netcatty-remote-hosts__get_environment",
    rawInput: { x: 1 },
  }, emitter, state);
  translateGrokAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    rawOutput: { ok: true },
  }, emitter, state);

  assert.deepEqual(emitter.calls, [
    ["reasoning", "plan"],
    ["reasoningEnd"],
    ["text", "Hi"],
    ["toolCall", "mcp__netcatty-remote-hosts__get_environment", { x: 1 }, "c1"],
    ["toolResult", "c1", "{\"ok\":true}", "mcp__netcatty-remote-hosts__get_environment"],
  ]);
});

test("translateGrokAcpUpdate plan uses shared { text, completed } shape not content/status", () => {
  const emitter = makeEmitter();
  translateGrokAcpUpdate({
    sessionUpdate: "plan",
    entries: [
      { content: "Map APIs", status: "completed" },
      { text: "Write tests", status: "pending" },
    ],
  }, emitter, {});
  const planCall = emitter.calls.find((c) => c[0] === "planUpdate");
  assert.ok(planCall, "plan must emit planUpdate");
  assert.deepEqual(planCall[2], [
    { text: "Map APIs", completed: true },
    { text: "Write tests", completed: false },
  ]);
  assert.equal(planCall[3], "running");
  // Adapter only treats top-level "completed" as done; "updated" stuck as running forever.
  assert.notEqual(planCall[3], "updated");
});

test("createJsonRpcClient correlates request ids and parses lines", async () => {
  const written = [];
  const client = createJsonRpcClient({
    write: (line) => written.push(line),
    onMessage: (message, pending) => {
      if (message.id != null && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        waiter.resolve(message.result);
      }
    },
  });
  const pending = client.request("initialize", { protocolVersion: 1 });
  assert.match(written[0], /"method":"initialize"/);
  const sent = JSON.parse(written[0]);
  client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }));
  assert.deepEqual(await pending, { ok: true });
});

test("handleGrokAcpMessage routes session/update notifications", () => {
  const emitter = makeEmitter();
  const state = { acceptUpdates: true };
  const pending = new Map();
  handleGrokAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "ok" },
      },
    },
  }, { emitter, state, pending });
  assert.equal(state.sessionId, "s1");
  assert.deepEqual(emitter.calls, [
    ["text", "ok"],
    ["sessionId", "s1"],
  ]);
});

test("handleGrokAcpMessage suppresses session/load history until prompt accepts updates", () => {
  const emitter = makeEmitter();
  const state = { acceptUpdates: false };
  const pending = new Map();
  // Historical replay during session/load must not pollute the current turn.
  handleGrokAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "previous turn reply" },
      },
    },
  }, { emitter, state, pending });
  assert.equal(state.sessionId, "s1");
  assert.deepEqual(emitter.calls, []);

  state.acceptUpdates = true;
  handleGrokAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "only this turn" },
      },
    },
  }, { emitter, state, pending });
  assert.deepEqual(emitter.calls, [["text", "only this turn"]]);
});

test("runGrokAcpTurn drives initialize/authenticate/session/new/prompt via fixture RPC", async () => {
  const emitter = makeEmitter();
  const methods = [];
  const result = await runGrokAcpTurn({
    prompt: "hi",
    binPath: "/usr/bin/grok",
    cwd: "/repo",
    permissionMode: "auto",
    toolIntegrationMode: "mcp",
    env: { XAI_API_KEY: "xai-test" },
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "node",
      args: ["mcp.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "7" }],
    }],
    emitter,
    rpcClientFactory: ({ emitter: em, state }) => ({
      async request(method, params) {
        methods.push([method, params]);
        if (method === "initialize") {
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
          };
        }
        if (method === "authenticate") {
          assert.equal(params.methodId, "xai.api_key");
          assert.equal(params._meta.headless, true);
          return {};
        }
        if (method === "session/new") {
          assert.equal(params.cwd, resolveGrokAcpCwd("/repo"));
          assert.equal(params.mcpServers[0].name, "netcatty-remote-hosts");
          assert.equal(params.mcpServers[0].type, "stdio");
          assert.ok(Array.isArray(params.mcpServers[0].env));
          assert.deepEqual(
            params.mcpServers[0].env,
            [{ name: "NETCATTY_MCP_PORT", value: "7" }],
          );
          return { sessionId: "acp-sess-1" };
        }
        if (method === "session/prompt") {
          // Simulate streamed ACP updates during the prompt
          translateGrokAcpUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "hello-acp" },
          }, em, state);
          return { stopReason: "end_turn" };
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });

  assert.equal(result.runtime, "acp");
  assert.equal(result.sessionId, "acp-sess-1");
  assert.deepEqual(
    methods.map((m) => m[0]),
    ["initialize", "authenticate", "session/new", "session/prompt"],
  );
  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "hello-acp"));
  assert.ok(emitter.calls.some((c) => c[0] === "sessionId" && c[1] === "acp-sess-1"));
  assert.ok(emitter.calls.some((c) => c[0] === "done"));
});

test("runGrokAcpTurn seeds history when resume/load fail and session/new is used", async () => {
  const emitter = makeEmitter();
  const methods = [];
  const historySeed = [
    "[Conversation context replay: the agent SDK may be starting from a fresh local session, so use these prior turns as context and answer only the latest user request.]",
    "USER: earlier question",
    "ASSISTANT: earlier answer",
  ].join("\n");
  await runGrokAcpTurn({
    prompt: "latest only",
    binPath: "/usr/bin/grok",
    resumeSessionId: "stale-sess",
    historySeed,
    permissionMode: "auto",
    emitter,
    rpcClientFactory: () => ({
      async request(method, params) {
        methods.push([method, params]);
        if (method === "initialize") {
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {} },
            },
            authMethods: [],
          };
        }
        if (method === "session/resume") throw new Error("missing session");
        if (method === "session/load") throw new Error("cannot load");
        if (method === "session/new") return { sessionId: "fresh-sess" };
        if (method === "session/prompt") {
          assert.equal(params.sessionId, "fresh-sess");
          const text = params.prompt?.[0]?.text || "";
          assert.match(text, /Conversation context replay/);
          assert.match(text, /earlier question/);
          assert.match(text, /latest only$/);
          return { stopReason: "end_turn" };
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });
  assert.deepEqual(methods.map((m) => m[0]), [
    "initialize",
    "session/resume",
    "session/load",
    "session/new",
    "session/prompt",
  ]);
  assert.ok(emitter.calls.some((c) => c[0] === "sessionId" && c[1] === "fresh-sess"));
});

test("runGrokAcpTurn does not seed history when session/resume succeeds", async () => {
  const emitter = makeEmitter();
  const historySeed = "USER: earlier\nASSISTANT: earlier answer";
  await runGrokAcpTurn({
    prompt: "latest only",
    binPath: "/usr/bin/grok",
    resumeSessionId: "live-sess",
    historySeed,
    permissionMode: "auto",
    emitter,
    rpcClientFactory: () => ({
      async request(method, params) {
        if (method === "initialize") {
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {} },
            },
            authMethods: [],
          };
        }
        if (method === "session/resume") return {};
        if (method === "session/prompt") {
          const text = params.prompt?.[0]?.text || "";
          assert.equal(text, "latest only");
          assert.doesNotMatch(text, /earlier/);
          return { stopReason: "end_turn" };
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });
});

test("runGrokAcpTurn prefers session/resume and keeps load history off the emitter", async () => {
  const emitter = makeEmitter();
  const methods = [];
  const result = await runGrokAcpTurn({
    prompt: "follow up",
    binPath: "/usr/bin/grok",
    cwd: "/repo",
    resumeSessionId: "prior-sess",
    permissionMode: "auto",
    toolIntegrationMode: "mcp",
    emitter,
    rpcClientFactory: ({ emitter: em, state }) => ({
      async request(method, params) {
        methods.push(method);
        if (method === "initialize") {
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {} },
            },
            authMethods: [],
          };
        }
        if (method === "session/resume") {
          assert.equal(params.sessionId, "prior-sess");
          // Resume must not replay; even if a rogue update arrives pre-prompt, suppress it.
          handleGrokAcpMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "prior-sess",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "SHOULD NOT APPEAR" },
              },
            },
          }, { emitter: em, state, pending: new Map() });
          return {};
        }
        if (method === "session/prompt") {
          assert.equal(state.acceptUpdates, true);
          translateGrokAcpUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "only this turn" },
          }, em, state);
          return { stopReason: "end_turn" };
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });

  assert.equal(result.sessionId, "prior-sess");
  assert.deepEqual(methods, ["initialize", "session/resume", "session/prompt"]);
  assert.deepEqual(
    emitter.calls.filter((c) => c[0] === "text"),
    [["text", "only this turn"]],
  );
  assert.ok(!emitter.calls.some((c) => c[0] === "text" && String(c[1]).includes("SHOULD NOT")));
});

test("runGrokAcpTurn falls back to session/load and suppresses history replay text", async () => {
  const emitter = makeEmitter();
  const methods = [];
  const result = await runGrokAcpTurn({
    prompt: "follow up",
    binPath: "/usr/bin/grok",
    resumeSessionId: "prior-load",
    permissionMode: "auto",
    emitter,
    rpcClientFactory: ({ emitter: em, state }) => ({
      async request(method) {
        methods.push(method);
        if (method === "initialize") {
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {} },
            },
            authMethods: [],
          };
        }
        if (method === "session/resume") throw new Error("resume not available");
        if (method === "session/load") {
          assert.equal(state.acceptUpdates, false);
          // Load-style history replay must not hit the current bubble.
          handleGrokAcpMessage({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "prior-load",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "previous turn reply" },
              },
            },
          }, { emitter: em, state, pending: new Map() });
          return { sessionId: "prior-load" };
        }
        if (method === "session/prompt") {
          translateGrokAcpUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "fresh reply" },
          }, em, state);
          return { stopReason: "end_turn" };
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });

  assert.equal(result.sessionId, "prior-load");
  assert.deepEqual(methods, [
    "initialize",
    "session/resume",
    "session/load",
    "session/prompt",
  ]);
  assert.deepEqual(
    emitter.calls.filter((c) => c[0] === "text"),
    [["text", "fresh reply"]],
  );
});

test("runGrokAcpTurn maps missing auth methods to a clear user error", async () => {
  const emitter = makeEmitter();
  await runGrokAcpTurn({
    prompt: "hi",
    binPath: "/usr/bin/grok",
    emitter,
    rpcClientFactory: () => ({
      async request(method) {
        if (method === "initialize") {
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            authMethods: [{ id: "weird-method" }],
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });
  const err = emitter.calls.find((c) => c[0] === "error");
  assert.ok(err);
  assert.match(String(err[1]), /not logged in|grok login|XAI_API_KEY/i);
});

test("runGrokAcpTurn reports missing CLI clearly", async () => {
  const emitter = makeEmitter();
  const result = await runGrokAcpTurn({
    prompt: "hi",
    binPath: "",
    emitter,
  });
  assert.equal(result.sessionId, null);
  assert.equal(result.runtime, "acp");
  assert.match(String(emitter.calls[0]?.[1] || ""), /not found/i);
});

test("runGrokAcpTurn ignores benign stdin EPIPE after turn completes", async () => {
  // Matches processErrorGuards: EPIPE must not crash main or fail a completed turn.
  const { EventEmitter } = require("node:events");
  const emitter = makeEmitter();
  let stdinRef = null;

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.writable = true;
    stdin.write = (line, cb) => {
      let msg;
      try { msg = JSON.parse(String(line).trim()); } catch {
        if (typeof cb === "function") cb();
        return true;
      }
      if (msg?.id == null) {
        if (typeof cb === "function") cb();
        return true;
      }
      queueMicrotask(() => {
        if (msg.method === "initialize") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
          })}\n`));
        } else if (msg.method === "session/new") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "s-epipe" },
          })}\n`));
        } else if (msg.method === "session/prompt") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-epipe",
              update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } },
            },
          })}\n`));
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" },
          })}\n`));
          // Teardown race: peer closed stdin after prompt success.
          queueMicrotask(() => {
            const err = new Error("write EPIPE");
            err.code = "EPIPE";
            stdin.emit("error", err);
            child.emit("close", 1);
          });
        } else {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {},
          })}\n`));
        }
        if (typeof cb === "function") cb();
      });
      return true;
    };
    stdin.end = () => {};
    child.stdin = stdin;
    stdinRef = stdin;
    child.pid = 3;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", 1));
    };
    return child;
  }

  await runGrokAcpTurn({
    prompt: "hi",
    binPath: "C:\\fake\\grok.exe",
    permissionMode: "auto",
    emitter,
    spawnImpl: () => makeFakeChild(),
    forceKillImpl: (c) => { c.kill(); },
  });

  assert.ok(stdinRef, "stdin must have been wired");
  assert.ok(emitter.calls.some((c) => c[0] === "done"));
  assert.ok(!emitter.calls.some((c) => c[0] === "error"), "post-completion EPIPE is benign");
});

test("runGrokAcpTurn forwards usage from session/prompt result", async () => {
  const emitter = makeEmitter();
  await runGrokAcpTurn({
    prompt: "hi",
    binPath: "/usr/bin/grok",
    permissionMode: "auto",
    emitter,
    rpcClientFactory: ({ emitter: em, state }) => ({
      async request(method) {
        if (method === "initialize") {
          return { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] };
        }
        if (method === "session/new") return { sessionId: "s-usage" };
        if (method === "session/prompt") {
          translateGrokAcpUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { text: "ok" },
          }, em, state);
          // Live Grok shape under _meta.usage (camelCase + cachedReadTokens).
          return {
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
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  const usage = emitter.calls.find((c) => c[0] === "usage");
  assert.ok(usage);
  assert.deepEqual(usage[1], {
    inputTokens: 27144,
    cachedInputTokens: 2560,
    outputTokens: 29,
    reasoningTokens: 24,
    totalTokens: 27173,
  });
  assert.ok(emitter.calls.some((c) => c[0] === "done"));
});

test("runGrokAcpTurn emits usage on prompt response even when process closes same tick", async () => {
  // Repro of Token ~1: onPromptComplete resolves promptDone in the same turn as
  // the prompt RPC result; Promise.race often returns "closed" and used to skip usage.
  const { EventEmitter } = require("node:events");
  const emitter = makeEmitter();

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      destroyed: false,
      write(line) {
        let msg;
        try { msg = JSON.parse(String(line).trim()); } catch { return; }
        if (msg?.id == null) return;
        queueMicrotask(() => {
          if (msg.method === "initialize") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
            })}\n`));
          } else if (msg.method === "session/new") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-race" },
            })}\n`));
          } else if (msg.method === "session/prompt") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0", method: "session/update",
              params: {
                sessionId: "s-race",
                update: { sessionUpdate: "agent_message_chunk", content: { text: "long reply…" } },
              },
            })}\n`));
            // Prompt result with real Grok usage, then same-tick process close
            // (simulates onPromptComplete → promptDone racing the await).
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                stopReason: "end_turn",
                _meta: {
                  usage: {
                    inputTokens: 1200,
                    outputTokens: 800,
                    totalTokens: 2000,
                    cachedReadTokens: 100,
                    reasoningTokens: 50,
                  },
                },
              },
            })}\n`));
            queueMicrotask(() => child.emit("close", 1));
          } else {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0", id: msg.id, result: {},
            })}\n`));
          }
        });
      },
      end() {},
    };
    child.pid = 7;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", 1));
    };
    return child;
  }

  await runGrokAcpTurn({
    prompt: "write a long essay",
    binPath: "C:\\fake\\grok.exe",
    permissionMode: "auto",
    emitter,
    spawnImpl: () => makeFakeChild(),
    forceKillImpl: (c) => { c.kill(); },
  });

  const usage = emitter.calls.find((c) => c[0] === "usage");
  assert.ok(usage, "usage must be emitted even if process closes in the same tick");
  assert.deepEqual(usage[1], {
    inputTokens: 1200,
    cachedInputTokens: 100,
    outputTokens: 800,
    reasoningTokens: 50,
    totalTokens: 2000,
  });
  assert.ok(emitter.calls.some((c) => c[0] === "done"));
  assert.ok(!emitter.calls.some((c) => c[0] === "error"));
});

test("runGrokAcpTurn does not treat post-prompt exit code 1 as failure for tool-only turns", async () => {
  // Repro: successful session/prompt (tools only, no assistant text) then
  // process teardown with code 1 (Windows taskkill). Must emitDone, not error.
  const { EventEmitter } = require("node:events");
  const emitter = makeEmitter();

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      destroyed: false,
      write(line) {
        let msg;
        try { msg = JSON.parse(String(line).trim()); } catch { return; }
        if (msg?.id == null) return;
        queueMicrotask(() => {
          if (msg.method === "initialize") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
            })}\n`));
          } else if (msg.method === "session/new") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: "s-tool" },
            })}\n`));
          } else if (msg.method === "session/prompt") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-tool",
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "t1",
                  toolName: "read_file",
                  rawInput: {},
                },
              },
            })}\n`));
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-tool",
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "t1",
                  status: "completed",
                  rawOutput: "ok",
                },
              },
            })}\n`));
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "end_turn" },
            })}\n`));
            queueMicrotask(() => child.emit("close", 1));
          } else {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {},
            })}\n`));
          }
        });
      },
      end() {},
    };
    child.pid = 4242;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", 1));
    };
    return child;
  }

  const result = await runGrokAcpTurn({
    prompt: "tool only",
    binPath: "C:\\fake\\grok.exe",
    permissionMode: "auto",
    emitter,
    spawnImpl: () => makeFakeChild(),
    forceKillImpl: (child) => { child.kill(); },
  });

  assert.equal(result.sessionId, "s-tool");
  assert.ok(emitter.calls.some((c) => c[0] === "toolCall"));
  assert.ok(emitter.calls.some((c) => c[0] === "done"));
  assert.ok(!emitter.calls.some((c) => c[0] === "error"), "post-prompt exit 1 must not emitError");
});

test("runGrokAcpTurn still errors when process dies mid-turn with no completion", async () => {
  const { EventEmitter } = require("node:events");
  const emitter = makeEmitter();

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      destroyed: false,
      write(line) {
        let msg;
        try { msg = JSON.parse(String(line).trim()); } catch { return; }
        if (msg?.id == null) return;
        queueMicrotask(() => {
          if (msg.method === "initialize") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
            })}\n`));
          } else if (msg.method === "session/new") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: "s-die" },
            })}\n`));
          } else if (msg.method === "session/prompt") {
            // Die before answering prompt — turn never completed.
            queueMicrotask(() => child.emit("close", 1));
          } else {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {},
            })}\n`));
          }
        });
      },
      end() {},
    };
    child.pid = 1;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    return child;
  }

  await runGrokAcpTurn({
    prompt: "die mid turn",
    binPath: "C:\\fake\\grok.exe",
    permissionMode: "auto",
    emitter,
    spawnImpl: () => makeFakeChild(),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "error"));
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});

test("runGrokAcpTurn errors when process dies after partial text without prompt result", async () => {
  // Partial assistant text is not success — must not suppress exit failure.
  const { EventEmitter } = require("node:events");
  const emitter = makeEmitter();

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      destroyed: false,
      write(line) {
        let msg;
        try { msg = JSON.parse(String(line).trim()); } catch { return; }
        if (msg?.id == null) return;
        queueMicrotask(() => {
          if (msg.method === "initialize") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
            })}\n`));
          } else if (msg.method === "session/new") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: "s-partial" },
            })}\n`));
          } else if (msg.method === "session/prompt") {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s-partial",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { text: "half…" },
                },
              },
            })}\n`));
            // Crash before session/prompt result (turnCompleted stays false).
            queueMicrotask(() => child.emit("close", 1));
          } else {
            child.stdout.emit("data", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {},
            })}\n`));
          }
        });
      },
      end() {},
    };
    child.pid = 2;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    return child;
  }

  await runGrokAcpTurn({
    prompt: "long answer",
    binPath: "C:\\fake\\grok.exe",
    permissionMode: "auto",
    emitter,
    spawnImpl: () => makeFakeChild(),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "half…"));
  assert.ok(emitter.calls.some((c) => c[0] === "error"), "partial text + crash must error");
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});

test("registry grok backend defaults to ACP path and keeps streaming-json fallback", async () => {
  assert.ok(listBackends().includes("grok"));
  const driver = getDriver("grok");
  assert.equal(typeof driver.runTurn, "function");

  // Fallback runtime uses streaming-json builder path (no real binary).
  const emitter = makeEmitter();
  const fallback = await driver.runTurn({
    prompt: "x",
    binPath: "",
    grokRuntime: "streaming-json",
    emitter,
    env: {},
  });
  assert.equal(fallback.sessionId, null);
  assert.match(String(emitter.calls[0]?.[1] || ""), /not found/i);

  // Default ACP path also surfaces missing CLI without hanging.
  const emitter2 = makeEmitter();
  const acp = await driver.runTurn({
    prompt: "x",
    binPath: "",
    emitter: emitter2,
    env: {},
  });
  assert.equal(acp.runtime, "acp");
  assert.match(String(emitter2.calls[0]?.[1] || ""), /not found/i);
});

test("buildGrokAcpPermissionResponse selects offered optionId, never invents allow-once", () => {
  // Live ACP uses optionId values like "allow-once" / "allow-always" / "reject".
  const allowOnce = buildGrokAcpPermissionResponse({
    options: [
      { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow-always", kind: "allow_always", name: "Allow always" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  }, true);
  assert.deepEqual(allowOnce, {
    outcome: { outcome: "selected", optionId: "allow-always" },
  });

  const allowOnlyOnce = buildGrokAcpPermissionResponse({
    options: [
      { optionId: "allow-once", name: "Allow once" },
      { optionId: "reject", name: "Reject" },
    ],
  }, true);
  assert.deepEqual(allowOnlyOnce, {
    outcome: { outcome: "selected", optionId: "allow-once" },
  });

  const deny = buildGrokAcpPermissionResponse({
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ],
  }, false);
  assert.deepEqual(deny, {
    outcome: { outcome: "selected", optionId: "reject" },
  });

  // No options offered: deny cancels; allow falls back to underscore form only as last resort.
  assert.deepEqual(
    buildGrokAcpPermissionResponse({}, false),
    { outcome: { outcome: "cancelled" } },
  );
  assert.deepEqual(
    buildGrokAcpPermissionResponse({ options: [] }, true),
    { outcome: { outcome: "selected", optionId: "allow_once" } },
  );
});

test("handleGrokAcpMessage permission reply uses real optionId from params.options", () => {
  const written = [];
  const state = {
    autoAllowPermissions: true,
    writeResponse: (id, result) => written.push([id, result]),
  };
  handleGrokAcpMessage({
    jsonrpc: "2.0",
    id: 42,
    method: "session/request_permission",
    params: {
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    },
  }, { emitter: makeEmitter(), state, pending: new Map() });

  assert.equal(written.length, 1);
  assert.equal(written[0][0], 42);
  // Must echo the offered id (hyphen form), not invent underscore "allow_once".
  assert.equal(written[0][1].outcome.optionId, "allow-once");
});

test("shouldReportGrokProcessExitFailure treats any incomplete close as failure", () => {
  // Node close(null, "SIGTERM") when killed — must fail unfinished turns.
  assert.equal(
    shouldReportGrokProcessExitFailure({ turnCompleted: false }, null, null, "SIGTERM"),
    true,
  );
  assert.equal(
    shouldReportGrokProcessExitFailure({ turnCompleted: false }, null, 1, null),
    true,
  );
  // Exit 0 without session/prompt success is still a failure.
  assert.equal(
    shouldReportGrokProcessExitFailure({ turnCompleted: false }, null, 0, null),
    true,
  );
  assert.equal(
    shouldReportGrokProcessExitFailure({ turnCompleted: true }, null, 1, "SIGTERM"),
    false,
  );
  assert.equal(
    shouldReportGrokProcessExitFailure({ turnCompleted: false }, { aborted: true }, null, "SIGTERM"),
    false,
  );
  assert.equal(
    shouldReportGrokProcessExitFailure({ turnCompleted: false, failed: true }, null, 1, null),
    false,
  );
});

test("runGrokAcpTurn fails on session/prompt JSON-RPC error (no silent done)", async () => {
  // Regression: async request wrap + promptDone race used to swallow the reject
  // and emitDone when the process later exited 0.
  const emitter = makeEmitter();
  const { EventEmitter } = require("node:events");
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.write = (chunk, cb) => {
      const msg = JSON.parse(String(chunk).trim());
      queueMicrotask(() => {
        if (msg.method === "initialize") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
          })}\n`));
        } else if (msg.method === "session/new") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "s-err" },
          })}\n`));
        } else if (msg.method === "session/prompt") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "model overloaded" },
          })}\n`));
          queueMicrotask(() => child.emit("close", 0));
        } else {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {},
          })}\n`));
        }
        if (typeof cb === "function") cb();
      });
      return true;
    };
    stdin.end = () => {};
    child.stdin = stdin;
    child.pid = 8;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    return child;
  }

  try {
    await runGrokAcpTurn({
      prompt: "hi",
      binPath: "C:\\fake\\grok.exe",
      permissionMode: "auto",
      emitter,
      spawnImpl: () => makeFakeChild(),
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  const err = emitter.calls.find((c) => c[0] === "error");
  assert.ok(err, "prompt JSON-RPC error must emitError");
  assert.match(String(err[1]), /overloaded|error|fail/i);
  assert.ok(!emitter.calls.some((c) => c[0] === "done"), "must not emitDone on prompt error");
  assert.equal(unhandled.length, 0, "must not leave unhandledRejection from swallowed race");
});

test("runGrokAcpTurn fails when process exits 0 mid-prompt without result", async () => {
  const emitter = makeEmitter();
  const { EventEmitter } = require("node:events");

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.write = (chunk, cb) => {
      const msg = JSON.parse(String(chunk).trim());
      queueMicrotask(() => {
        if (msg.method === "initialize") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
          })}\n`));
        } else if (msg.method === "session/new") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "s-zero" },
          })}\n`));
        } else if (msg.method === "session/prompt") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-zero",
              update: { sessionUpdate: "agent_message_chunk", content: { text: "half…" } },
            },
          })}\n`));
          queueMicrotask(() => child.emit("close", 0));
        } else {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {},
          })}\n`));
        }
        if (typeof cb === "function") cb();
      });
      return true;
    };
    stdin.end = () => {};
    child.stdin = stdin;
    child.pid = 9;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    return child;
  }

  await runGrokAcpTurn({
    prompt: "long",
    binPath: "C:\\fake\\grok.exe",
    permissionMode: "auto",
    emitter,
    spawnImpl: () => makeFakeChild(),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "half…"));
  assert.ok(emitter.calls.some((c) => c[0] === "error"), "exit 0 mid-prompt must emitError");
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});

test("runGrokAcpTurn fails when process is signal-killed mid-turn (code=null)", async () => {
  // Node reports close(null, "SIGTERM") for signal kills — must not silently succeed.
  const emitter = makeEmitter();
  const { EventEmitter } = require("node:events");

  function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.write = (chunk, cb) => {
      const msg = JSON.parse(String(chunk).trim());
      queueMicrotask(() => {
        if (msg.method === "initialize") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: ACP_PROTOCOL_VERSION, authMethods: [] },
          })}\n`));
        } else if (msg.method === "session/new") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "s-sig" },
          })}\n`));
        } else if (msg.method === "session/prompt") {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s-sig",
              update: { sessionUpdate: "agent_message_chunk", content: { text: "half…" } },
            },
          })}\n`));
          // Crash mid-prompt: signal kill, code=null (Node convention).
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        } else {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {},
          })}\n`));
        }
        if (typeof cb === "function") cb();
      });
      return true;
    };
    stdin.end = () => {};
    child.stdin = stdin;
    child.pid = 7;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    return child;
  }

  await runGrokAcpTurn({
    prompt: "long",
    binPath: "C:\\fake\\grok.exe",
    permissionMode: "auto",
    emitter,
    spawnImpl: () => makeFakeChild(),
  });

  assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "half…"));
  const err = emitter.calls.find((c) => c[0] === "error");
  assert.ok(err, "signal kill mid-turn must emitError");
  assert.match(String(err[1]), /SIGTERM|signal/i);
  assert.ok(!emitter.calls.some((c) => c[0] === "done"));
});
