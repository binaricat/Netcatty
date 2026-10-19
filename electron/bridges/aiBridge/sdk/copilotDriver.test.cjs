const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const tempDirBridge = require("../../tempDirBridge.cjs");
const { approveNetcattyMcpOnly, approveNetcattyCliShellOnly, buildCopilotClientOptions, buildCopilotPermissionHandler, buildCopilotSessionOptions, buildCopilotMessageOptions, connectCopilotStdioPath, copilotBuiltinTools, extractCopilotContent, isLikelyNetcattyCliShellCommand, listCopilotModels, mapCopilotModels, runCopilotTurn, translateCopilotEvent } = require("./copilotDriver.cjs");
const { resolveCopilotPlatformExecutable } = require("./copilotHeadlessLoader.cjs");

function createCopilotFixtureDir(name) {
  const dir = tempDirBridge.getTempFilePath(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function collector() {
  const events = [];
  return {
    events,
    emitter: {
      text: (t) => events.push({ k: "text", t }),
      reasoning: (d) => events.push({ k: "reasoning", d }),
      reasoningEnd: () => events.push({ k: "reasoningEnd" }),
      toolCall: (n, a, id) => events.push({ k: "toolCall", n, a, id }),
      toolResult: (id, o, n) => events.push({ k: "toolResult", id, o, n }),
      sessionId: (s) => events.push({ k: "sessionId", s }),
      emitError: (e) => events.push({ k: "error", e }),
      emitDone: () => events.push({ k: "done" }),
    },
  };
}

/** Minimal @github/copilot-sdk mock; records create vs resume + returns a session. */
function makeSdk(captured) {
  const makeSession = (sessionId) => ({
    sessionId,
    async sendAndWait({ prompt }) { captured.prompt = prompt; return { data: { content: "reply:" + sessionId } }; },
  });
  class CopilotClient {
    constructor(options) { captured.clientOptions = options; }
    async createSession(cfg) { captured.created = cfg; return makeSession("sess-new"); }
    async resumeSession(id, cfg) { captured.resumed = { id, cfg }; return makeSession(id); }
    async stop() {}
  }
  return { CopilotClient, RuntimeConnection: { forStdio: () => ({}) }, approveAll: () => {} };
}

test("buildCopilotClientOptions pins cliPath", () => {
  const o = buildCopilotClientOptions({ cliPath: "/abs/copilot" });
  assert.equal(o.cliPath, "/abs/copilot");
});

test("buildCopilotSessionOptions maps injected MCP to local stdio servers", () => {
  const o = buildCopilotSessionOptions({
    model: "claude-sonnet-4.5",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts", command: "/abs/electron",
      args: ["/abs/server.cjs"], env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });
  assert.equal(o.model, "claude-sonnet-4.5");
  assert.equal(o.streaming, true);
  const srv = o.mcpServers["netcatty-remote-hosts"];
  assert.equal(srv.type, "stdio");
  assert.equal(srv.command, "/abs/electron");
  assert.deepEqual(srv.env, { NETCATTY_MCP_PORT: "1" });
  assert.deepEqual(srv.tools, ["*"]);
  // onPermissionRequest is wired in runCopilotTurn via the SDK's approveAll,
  // not in buildCopilotSessionOptions.
});

test("approveNetcattyMcpOnly approves MCP permission requests and rejects local tools", () => {
  assert.deepEqual(
    approveNetcattyMcpOnly({ kind: "mcp", toolName: "terminal_execute" }),
    { kind: "approve-once" },
  );
  assert.deepEqual(
    approveNetcattyMcpOnly({ kind: "shell", fullCommandText: "rm -rf /tmp/x" }),
    { kind: "reject", feedback: "Only Netcatty MCP tools are allowed from this integration." },
  );
  assert.deepEqual(
    approveNetcattyMcpOnly({ kind: "read", fileName: "/etc/passwd" }),
    { kind: "reject", feedback: "Only Netcatty MCP tools are allowed from this integration." },
  );
});

test("extractCopilotContent reads response data.content", () => {
  assert.equal(extractCopilotContent({ data: { content: "hi" } }), "hi");
  assert.equal(extractCopilotContent(null), "");
  assert.equal(extractCopilotContent({ data: {} }), "");
});

test("buildCopilotMessageOptions sends pasted images/files as native attachments", () => {
  const opts = buildCopilotMessageOptions({
    prompt: "inspect these",
    attachments: [
      { filename: "shot.png", mediaType: "image/png", filePath: "/tmp/shot.png", base64Data: "abc" },
      { filename: "note.txt", mediaType: "text/plain", filePath: "/tmp/note.txt" },
    ],
  });
  assert.equal(opts.prompt, "inspect these");
  assert.equal("streamDeltas" in opts, false);
  assert.deepEqual(opts.attachments, [
    { type: "blob", data: "abc", mimeType: "image/png", displayName: "shot.png" },
    { type: "file", path: "/tmp/note.txt", displayName: "note.txt" },
  ]);
});

test("mapCopilotModels maps {id,name} and drops entries without id", () => {
  const out = mapCopilotModels([
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "gpt-5" },
    { name: "no id -> dropped" },
  ]);
  assert.deepEqual(out, [
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "gpt-5", name: "gpt-5" },
  ]);
  assert.deepEqual(mapCopilotModels(undefined), []);
});

test("runCopilotTurn (fresh) creates a session, emits its id early, returns it for resume", async () => {
  const { events, emitter } = collector();
  const captured = {};
  const result = await runCopilotTurn({
    prompt: "hi", clientOptions: { cliPath: "/c" }, sessionOptions: { model: "m" },
    emitter, sdkModule: makeSdk(captured),
  });
  assert.ok(captured.created, "used createSession when there's no resume id");
  assert.equal(captured.created.model, "m");
  assert.deepEqual(events.filter((e) => e.k === "sessionId"), [{ k: "sessionId", s: "sess-new" }]);
  assert.equal(result.sessionId, "sess-new");
});

test("runCopilotTurn resumes the prior session (carry context) and re-applies fresh config", async () => {
  const { events, emitter } = collector();
  const captured = {};
  const result = await runCopilotTurn({
    prompt: "what did we say", clientOptions: {}, sessionOptions: { model: "m" },
    resumeSessionId: "sess-existing", emitter, sdkModule: makeSdk(captured),
  });
  assert.equal(captured.resumed.id, "sess-existing", "used resumeSession, not createSession");
  assert.equal(captured.created, undefined);
  // fresh netcatty MCP/session config re-applied on resume (not the stale one)
  assert.equal(captured.resumed.cfg.model, "m");
  assert.equal(result.sessionId, "sess-existing");
  assert.ok(events.some((e) => e.k === "sessionId" && e.s === "sess-existing"));
});

test("translateCopilotEvent: deltas -> text/reasoning, tool start/complete -> tool card", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false, streamedText: false };
  translateCopilotEvent({ type: "assistant.reasoning_delta", data: { deltaContent: "thinking" } }, emitter, state);
  translateCopilotEvent({ type: "assistant.message_delta", data: { deltaContent: "hello" } }, emitter, state);
  translateCopilotEvent({ type: "tool.execution_start", data: { toolName: "shell", arguments: { command: "ls" }, toolCallId: "t1" } }, emitter, state);
  translateCopilotEvent({ type: "tool.execution_complete", data: { toolCallId: "t1", result: { content: [{ type: "text", text: "files" }] } } }, emitter, state);
  assert.deepEqual(events, [
    { k: "reasoning", d: "thinking" },
    { k: "reasoningEnd" }, // message_delta closes the thinking block
    { k: "text", t: "hello" },
    { k: "toolCall", n: "shell", a: { command: "ls" }, id: "t1" },
    { k: "toolResult", id: "t1", o: "files", n: undefined },
  ]);
  assert.equal(state.streamedText, true);
});

test("translateCopilotEvent: final reasoning is shown when no reasoning deltas streamed", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false, streamedText: false, streamedReasoning: false };
  translateCopilotEvent({ type: "assistant.reasoning", data: { content: "complete thinking" } }, emitter, state);
  assert.deepEqual(events, [
    { k: "reasoning", d: "complete thinking" },
    { k: "reasoningEnd" },
  ]);
  assert.equal(state.reasoningOpen, false);
});

test("translateCopilotEvent: final reasoning is ignored after streamed reasoning deltas", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false, streamedText: false, streamedReasoning: false };
  translateCopilotEvent({ type: "assistant.reasoning_delta", data: { deltaContent: "thinking" } }, emitter, state);
  translateCopilotEvent({ type: "assistant.reasoning", data: { content: "thinking" } }, emitter, state);
  translateCopilotEvent({ type: "assistant.message_delta", data: { deltaContent: "hello" } }, emitter, state);
  assert.deepEqual(events, [
    { k: "reasoning", d: "thinking" },
    { k: "reasoningEnd" },
    { k: "text", t: "hello" },
  ]);
});

test("runCopilotTurn streams tool calls + deltas via session.on (no final-text dup)", async () => {
  const { events, emitter } = collector();
  const captured = {};
  let handler = null;
  const sdkModule = {
    RuntimeConnection: { forStdio: () => ({}) },
    approveAll: () => {},
    CopilotClient: class {
      async createSession(cfg) {
        captured.created = cfg;
        return {
          sessionId: "sess-x",
          on(h) { handler = h; return () => { handler = null; }; },
          async sendAndWait(opts) {
            captured.opts = opts;
            handler({ type: "assistant.message_delta", data: { deltaContent: "hi " } });
            handler({ type: "tool.execution_start", data: { toolName: "shell", arguments: {}, toolCallId: "t1" } });
            handler({ type: "tool.execution_complete", data: { toolCallId: "t1", result: { content: [{ type: "text", text: "ok" }] } } });
            handler({ type: "assistant.message_delta", data: { deltaContent: "there" } });
            return { data: { content: "hi there" } };
          },
          async stop() {},
        };
      }
      async stop() {}
    },
  };
  const result = await runCopilotTurn({
    prompt: "go",
    attachments: [{ filename: "shot.png", mediaType: "image/png", filePath: "/tmp/shot.png", base64Data: "abc" }],
    clientOptions: {},
    sessionOptions: {},
    emitter,
    sdkModule,
  });
  assert.equal(captured.created.streaming, true, "requested session streaming");
  assert.equal("streamDeltas" in captured.opts, false, "does not send unsupported message streaming flag");
  assert.deepEqual(captured.opts.attachments, [
    { type: "blob", data: "abc", mimeType: "image/png", displayName: "shot.png" },
  ]);
  // streamed deltas shown, NOT the duplicated final consolidated text
  assert.deepEqual(events.filter((e) => e.k === "text"), [{ k: "text", t: "hi " }, { k: "text", t: "there" }]);
  assert.ok(events.some((e) => e.k === "toolCall" && e.id === "t1"), "tool card streamed");
  assert.ok(events.some((e) => e.k === "toolResult" && e.o === "ok"), "tool result streamed");
  assert.equal(result.sessionId, "sess-x");
});

test("runCopilotTurn aborts the active Copilot session when the signal aborts", async () => {
  const { events, emitter } = collector();
  const controller = new AbortController();
  let abortCalled = false;
  const sdkModule = {
    RuntimeConnection: { forStdio: () => ({}) },
    approveAll: () => {},
    CopilotClient: class {
      async createSession() {
        return {
          sessionId: "sess-abort",
          on() { return () => {}; },
          async sendAndWait() {
            controller.abort();
            await new Promise((resolve) => setTimeout(resolve, 0));
            return { data: { content: "late text" } };
          },
          async abort() { abortCalled = true; },
        };
      }
      async stop() {}
    },
  };

  const result = await runCopilotTurn({
    prompt: "stop me",
    clientOptions: {},
    sessionOptions: {},
    emitter,
    signal: controller.signal,
    sdkModule,
  });

  assert.equal(abortCalled, true);
  assert.equal(result.sessionId, "sess-abort");
  assert.equal(events.some((event) => event.k === "text" && event.t === "late text"), false);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("copilotBuiltinTools exposes bash only in skills mode", () => {
  assert.equal(copilotBuiltinTools("mcp"), null);
  assert.deepEqual(copilotBuiltinTools("skills"), ["builtin:bash"]);
});

test("buildCopilotSessionOptions whitelists bash in skills mode", () => {
  const skills = buildCopilotSessionOptions({
    model: "gpt-5",
    injectedMcpServers: [],
    toolIntegrationMode: "skills",
  });
  assert.deepEqual(skills.availableTools, ["builtin:bash"]);
  assert.deepEqual(skills.mcpServers, {});
});

test("approveNetcattyCliShellOnly allows Netcatty CLI shell commands only", () => {
  assert.deepEqual(
    approveNetcattyCliShellOnly({
      kind: "shell",
      fullCommandText: 'node "/Applications/Netcatty.app/netcatty-tool-cli.cjs" env --json',
    }),
    { kind: "approve-once" },
  );
  assert.equal(
    approveNetcattyCliShellOnly({
      kind: "shell",
      fullCommandText: 'node "/Applications/Netcatty.app/netcatty-tool-cli.cjs" env --chat-session abc --json',
    }).kind,
    "reject",
  );
  assert.equal(
    approveNetcattyCliShellOnly({ kind: "shell", fullCommandText: "pwd" }).kind,
    "reject",
  );
});

test("buildCopilotPermissionHandler selects MCP vs skills gate", () => {
  assert.equal(buildCopilotPermissionHandler("mcp"), approveNetcattyMcpOnly);
  assert.equal(buildCopilotPermissionHandler("skills"), approveNetcattyCliShellOnly);
});

test("isLikelyNetcattyCliShellCommand matches launcher and script invocations", () => {
  assert.equal(isLikelyNetcattyCliShellCommand("netcatty-tool-cli status --json"), true);
  assert.equal(isLikelyNetcattyCliShellCommand("node electron/cli/netcatty-tool-cli.cjs env --json"), true);
  assert.equal(isLikelyNetcattyCliShellCommand("ls -la"), false);
});

test("isLikelyNetcattyCliShellCommand rejects chained or wrapped local commands", () => {
  assert.equal(isLikelyNetcattyCliShellCommand("rm -rf /; netcatty-tool-cli status --json"), false);
  assert.equal(isLikelyNetcattyCliShellCommand("netcatty-tool-cli status --json && curl evil"), false);
  assert.equal(isLikelyNetcattyCliShellCommand('bash -c "netcatty-tool-cli status --json"'), false);
  assert.equal(isLikelyNetcattyCliShellCommand("malicious netcatty-tool-cli status --json"), false);
  assert.equal(isLikelyNetcattyCliShellCommand("netcatty-tool-cli status `id` --json"), false);
});

test("isLikelyNetcattyCliShellCommand allows quoted remote exec payloads after --", () => {
  assert.equal(
    isLikelyNetcattyCliShellCommand('netcatty-tool-cli exec --session s1 --json -- "hostname && whoami"'),
    true,
  );
  assert.equal(
    isLikelyNetcattyCliShellCommand('netcatty-tool-cli exec --session s1 --json -- "echo --chat-session"'),
    true,
  );
  assert.equal(
    isLikelyNetcattyCliShellCommand("netcatty-tool-cli exec --session s1 --json -- hostname && whoami"),
    false,
  );
});

test("isLikelyNetcattyCliShellCommand rejects removed --chat-session and host-env overrides", () => {
  assert.equal(
    isLikelyNetcattyCliShellCommand("netcatty-tool-cli env --chat-session abc --json"),
    false,
  );
  assert.equal(
    isLikelyNetcattyCliShellCommand("netcatty-tool-cli exec --session s1 --chat-session=c1 --json -- hostname"),
    false,
  );
  assert.equal(
    isLikelyNetcattyCliShellCommand("NETCATTY_CLI_CHAT_SESSION_ID=other netcatty-tool-cli env --json"),
    false,
  );
  assert.equal(
    isLikelyNetcattyCliShellCommand("NETCATTY_TOOL_CLI_DISCOVERY_FILE=/tmp/x netcatty-tool-cli status --json"),
    false,
  );
  assert.equal(
    isLikelyNetcattyCliShellCommand("FOO=bar netcatty-tool-cli status --json"),
    false,
  );
});

test("isLikelyNetcattyCliShellCommand rejects impostor binaries and quoted -- bypasses", () => {
  assert.equal(isLikelyNetcattyCliShellCommand("netcatty-tool-cli-backup status --json"), false);
  assert.equal(isLikelyNetcattyCliShellCommand("netcatty-tool-cli.evil status --json"), false);
  assert.equal(
    isLikelyNetcattyCliShellCommand('netcatty-tool-cli sftp read --remote-path "a -- b" ; rm -rf /'),
    false,
  );
  assert.equal(
    isLikelyNetcattyCliShellCommand('netcatty-tool-cli sftp read --remote-path "a -- b" --session s1 --json'),
    true,
  );
  assert.equal(isLikelyNetcattyCliShellCommand("netcatty-tool-cli status --json  --  ; rm -rf /"), false);
  assert.equal(isLikelyNetcattyCliShellCommand("netcatty-tool-cli status --json > /tmp/out"), false);
  assert.equal(isLikelyNetcattyCliShellCommand('"C:\\Apps\\Netcatty\\netcatty-tool-cli.cmd" status --json'), true);
  assert.equal(isLikelyNetcattyCliShellCommand("attacker/netcatty-tool-cli status --json"), false);
  assert.equal(isLikelyNetcattyCliShellCommand('netcatty-tool-cli status "$(id)" --json'), false);
});

test("runCopilotTurn passes runtime env and skills permission handler", async () => {
  const { emitter } = collector();
  const captured = {};
  await runCopilotTurn({
    prompt: "hi",
    clientOptions: { cliPath: "/c" },
    sessionOptions: { model: "m" },
    toolIntegrationMode: "skills",
    runtimeEnv: { NETCATTY_TOOL_CLI_DISCOVERY_FILE: "/tmp/discovery.json" },
    emitter,
    sdkModule: makeSdk(captured),
  });
  assert.deepEqual(captured.clientOptions.env, { NETCATTY_TOOL_CLI_DISCOVERY_FILE: "/tmp/discovery.json" });
  assert.equal(captured.created.onPermissionRequest, approveNetcattyCliShellOnly);
});

test("listCopilotModels resolves a Windows .cmd shim to the copilot JS entry before the SDK sees it", async () => {
  const dir = createCopilotFixtureDir("netcatty-copilot-shim-");
  try {
    const shim = path.join(dir, "copilot.cmd");
    fs.writeFileSync(shim, '@ECHO off\r\n"node"  "%dp0%\node_modules\@github\copilot\npm-loader.js" %*');
    const loaderJs = path.join(dir, "node_modules", "@github", "copilot", "npm-loader.js");
    fs.mkdirSync(path.dirname(loaderJs), { recursive: true });
    fs.writeFileSync(loaderJs, "");
    const captured = {};
    const sdkModule = {
      CopilotClient: class {
        constructor(options) { captured.options = options; }
        async start() {}
        async listModels() { return [{ id: "auto", name: "auto" }]; }
        async stop() {}
      },
      RuntimeConnection: { forStdio: (config) => { captured.forStdio = config; return {}; } },
    };
    const models = await listCopilotModels({ cliPath: shim, sdkModule });
    // With no platform runtime installed, Windows keeps the resolved loader.
    // Other platforms retain the supplied CLI path.
    assert.equal(captured.forStdio.path, process.platform === "win32" ? loaderJs : shim);
    assert.deepEqual(models, [{ id: "auto", name: "auto" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listCopilotModels directly owns the native runtime selected by the official loader", async () => {
  if (process.platform !== "win32") return; // resolution only special-cases win32
  const dir = createCopilotFixtureDir("netcatty-copilot-loader-");
  try {
    const shim = path.join(dir, "copilot.cmd");
    fs.writeFileSync(shim, '@ECHO off\r\n"node"  "%dp0%\node_modules\@github\copilot\npm-loader.js" %*');
    const packageRoot = path.join(dir, "node_modules", "@github", "copilot");
    fs.mkdirSync(packageRoot, { recursive: true });
    const loaderJs = path.join(packageRoot, "npm-loader.js");
    fs.writeFileSync(loaderJs, "");
    // The official loader forwards to this same binary. The SDK owns it
    // directly so hiding and forced stop both apply to the actual runtime.
    const nativeExe = path.join(
      dir, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`, "copilot.exe",
    );
    fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
    fs.writeFileSync(nativeExe, "");
    const captured = {};
    const sdkModule = {
      CopilotClient: class {
        constructor(options) { captured.options = options; }
        async start() {}
        async listModels() { return [{ id: "auto", name: "auto" }]; }
        async stop() {}
      },
      RuntimeConnection: { forStdio: (config) => { captured.forStdio = config; return {}; } },
    };
    const models = await listCopilotModels({ cliPath: shim, sdkModule });
    assert.equal(captured.forStdio.path, nativeExe, "the SDK owns the native process the official loader would start");
    assert.deepEqual(models, [{ id: "auto", name: "auto" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listCopilotModels honors native preference when resolving Windows npm shims", async () => {
  if (process.platform !== "win32") return; // resolution only special-cases win32
  const dir = createCopilotFixtureDir("netcatty-copilot-native-");
  const previous = process.env.NETCATTY_COPILOT_PREFER_NATIVE;
  process.env.NETCATTY_COPILOT_PREFER_NATIVE = "1";
  try {
    const shim = path.join(dir, "copilot.cmd");
    fs.writeFileSync(shim, '@ECHO off\r\n"node"  "%dp0%\node_modules\@github\copilot\npm-loader.js" %*');
    const packageRoot = path.join(dir, "node_modules", "@github", "copilot");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "npm-loader.js"), "");
    const nativeExe = path.join(
      dir, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`, "copilot.exe",
    );
    fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
    fs.writeFileSync(nativeExe, "");
    const captured = {};
    const sdkModule = {
      CopilotClient: class {
        constructor(options) { captured.options = options; }
        async start() {}
        async listModels() { return [{ id: "auto", name: "auto" }]; }
        async stop() {}
      },
      RuntimeConnection: { forStdio: (config) => { captured.forStdio = config; return {}; } },
    };
    const models = await listCopilotModels({ cliPath: shim, sdkModule });
    assert.equal(captured.forStdio.path, nativeExe, "the SDK owns the preferred native process directly");
    assert.deepEqual(models, [{ id: "auto", name: "auto" }]);
  } finally {
    if (previous === undefined) {
      delete process.env.NETCATTY_COPILOT_PREFER_NATIVE;
    } else {
      process.env.NETCATTY_COPILOT_PREFER_NATIVE = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listCopilotModels retains the official loader when its platform runtime is unavailable", async () => {
  const dir = createCopilotFixtureDir("netcatty-copilot-loader-fallback-");
  try {
    const loader = path.join(dir, "node_modules", "@github", "copilot", "npm-loader.js");
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.writeFileSync(loader, "");
    const captured = {};
    const sdkModule = {
      CopilotClient: class {
        async start() {}
        async listModels() { return []; }
        async stop() {}
      },
      RuntimeConnection: { forStdio: (config) => { captured.forStdio = config; return {}; } },
    };
    await listCopilotModels({ cliPath: loader, sdkModule });
    assert.equal(captured.forStdio.path, loader);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const outcome of ['success', 'reject', 'throw', 'hang']) {
  test(`listCopilotModels cleans up shutdown after ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clearTimer = t.mock.method(global, 'clearTimeout');
    let forced = 0;
    let rejectStop;
    const sdkModule = {
      CopilotClient: class {
        async start() {}
        async listModels() { return [{ id: 'auto', name: 'Auto' }]; }
        stop() {
          if (outcome === 'throw') throw new Error('stop failed');
          if (outcome === 'reject') return Promise.reject(new Error('stop failed'));
          if (outcome === 'hang') return new Promise((_, reject) => { rejectStop = reject; });
          return Promise.resolve();
        }
        async forceStop() { forced++; }
      },
    };
    assert.deepEqual(await listCopilotModels({ sdkModule }), [{ id: 'auto', name: 'Auto' }]);
    await new Promise(setImmediate);
    if (outcome === 'hang') {
      assert.equal(forced, 0);
      t.mock.timers.tick(3000);
      await new Promise(setImmediate);
      rejectStop(new Error('late stop rejection'));
      await new Promise(setImmediate);
    }
    assert.equal(forced, outcome === 'success' ? 0 : 1);
    if (outcome !== 'throw') assert.equal(clearTimer.mock.callCount(), 1);
    t.mock.timers.tick(3000);
    await new Promise(setImmediate);
    assert.equal(forced, outcome === 'success' ? 0 : 1);
  });
}

test("resolveCopilotPlatformExecutable resolves the platform package exe from the loader root", () => {
  const dir = createCopilotFixtureDir("netcatty-copilot-platexe-");
  try {
    const loaderJs = path.join(dir, "node_modules", "@github", "copilot", "npm-loader.js");
    const platformPkg = path.join(dir, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`);
    fs.mkdirSync(platformPkg, { recursive: true });
    fs.mkdirSync(path.dirname(loaderJs), { recursive: true });
    fs.writeFileSync(loaderJs, "");
    const exeName = process.platform === "win32" ? "copilot.exe" : "copilot";
    const exePath = path.join(platformPkg, exeName);
    fs.writeFileSync(exePath, "");
    fs.writeFileSync(path.join(platformPkg, "package.json"), JSON.stringify({
      name: `@github/copilot-${process.platform}-${process.arch}`,
      exports: { ".": `./${exeName}` },
    }));
    assert.equal(fs.realpathSync(resolveCopilotPlatformExecutable(loaderJs)), fs.realpathSync(exePath));
    // No platform package reachable from the loader's node_modules chain
    // (separate tree, so walk-up cannot hoist into the fixture above) -> null;
    // the SDK then retains the original loader.
    const lonelyDir = createCopilotFixtureDir("netcatty-copilot-lonely-");
    try {
      const lonelyLoader = path.join(lonelyDir, "pkg", "npm-loader.js");
      fs.mkdirSync(path.dirname(lonelyLoader), { recursive: true });
      fs.writeFileSync(lonelyLoader, "");
      assert.equal(resolveCopilotPlatformExecutable(lonelyLoader), null);
    } finally {
      fs.rmSync(lonelyDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("connectCopilotStdioPath returns null when nothing resolved (parity with the raw resolver)", () => {
  assert.equal(connectCopilotStdioPath(""), null);
  assert.equal(connectCopilotStdioPath(null), null);
});

test("resolveCopilotExecutableForSdk resolves npm's copilot.ps1 wrapper to the JS entry on Windows", () => {
  const { resolveCopilotExecutableForSdk } = require("../../ai/shellUtils.cjs");
  const dir = createCopilotFixtureDir("netcatty-copilot-ps1-");
  try {
    const shim = path.join(dir, "copilot.ps1");
    fs.writeFileSync(shim, '#!/usr/bin/env pwsh\r\n& "node$exe" "$basedir/node_modules/@github/copilot/npm-loader.js" $args');
    const loaderJs = path.join(dir, "node_modules", "@github", "copilot", "npm-loader.js");
    fs.mkdirSync(path.dirname(loaderJs), { recursive: true });
    fs.writeFileSync(loaderJs, "");
    assert.equal(resolveCopilotExecutableForSdk(shim, "win32"), loaderJs);
    // Other platforms never rewrite the configured path.
    assert.equal(resolveCopilotExecutableForSdk(shim, "linux"), shim);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("connectCopilotStdioPath keeps POSIX and native Windows executables direct", () => {
  assert.equal(connectCopilotStdioPath("/usr/local/bin/copilot", "linux"), "/usr/local/bin/copilot");
  assert.equal(connectCopilotStdioPath("/opt/homebrew/bin/copilot", "darwin"), "/opt/homebrew/bin/copilot");
  assert.equal(connectCopilotStdioPath("C:\\copilot\\copilot.exe", "win32"), "C:\\copilot\\copilot.exe");
});

test("connectCopilotStdioPath directly selects the official loader's native runtime", () => {
  const dir = require("../../tempDirBridge.cjs").getTempFilePath("copilot-loader-fixture");
  const loader = path.join(dir, "node_modules", "@github", "copilot", "npm-loader.js");
  const native = path.join(dir, "node_modules", "@github", `copilot-${process.platform}-${process.arch}`, process.platform === "win32" ? "copilot.exe" : "copilot");
  try {
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(loader, "", { flag: "wx" });
    fs.writeFileSync(native, "", { flag: "wx" });
    assert.equal(connectCopilotStdioPath(loader, "win32"), native);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("connectCopilotStdioPath preserves configured Windows JavaScript launchers", () => {
  for (const launcher of ["C:\\tools\\copilot\\custom-launcher.js", "/fixture/@github/copilot/custom-launcher.js", "/fixture/other-package/npm-loader.js"]) {
    assert.equal(connectCopilotStdioPath(launcher, "win32"), launcher);
  }
});
