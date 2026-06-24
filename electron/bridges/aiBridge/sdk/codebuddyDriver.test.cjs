const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCodebuddyQueryOptions,
  buildCodebuddyPromptInput,
  codebuddyBuiltinTools,
  mapCodebuddyModels,
  runCodebuddyTurn,
  translateCodebuddyMessage,
} = require("./codebuddyDriver.cjs");

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

test("buildCodebuddyQueryOptions wires SDK options in isolated mode", () => {
  const ac = new AbortController();
  const opts = buildCodebuddyQueryOptions({
    cwd: "/tmp",
    model: "codebuddy-1",
    env: { PATH: "/usr/bin", CODEBUDDY_INTERNET_ENVIRONMENT: "ioa" },
    pathToCodebuddyCode: "/opt/codebuddy/bin/codebuddy",
    abortController: ac,
    resume: "sess-1",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "/abs/electron",
      args: ["/abs/server.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });

  assert.equal(opts.cwd, "/tmp");
  assert.equal(opts.model, "codebuddy-1");
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.allowDangerouslySkipPermissions, true);
  assert.deepEqual(opts.extraArgs, { "dangerously-skip-permissions": null });
  assert.deepEqual(opts.settingSources, []);
  assert.equal(opts.env.CODEBUDDY_INTERNET_ENVIRONMENT, "ioa");
  assert.equal(opts.pathToCodebuddyCode, "/opt/codebuddy/bin/codebuddy");
  assert.equal(opts.abortController, ac);
  assert.equal(opts.resume, "sess-1");
  assert.deepEqual(opts.tools, []);
  // allowedTools must stay unset in mcp mode: tools:[] disables built-ins, while
  // allowedTools:[] would prevent injected Netcatty MCP tools from running.
  assert.ok(!("allowedTools" in opts));
  assert.ok(opts.disallowedTools.includes("AskUserQuestion"));
  assert.equal(opts.mcpServers["netcatty-remote-hosts"].type, "stdio");
  assert.deepEqual(opts.mcpServers["netcatty-remote-hosts"].env, { NETCATTY_MCP_PORT: "1" });
});

test("built-in tools are mode-aware", () => {
  assert.deepEqual(codebuddyBuiltinTools("mcp"), []);
  assert.deepEqual(codebuddyBuiltinTools(undefined), []);
  assert.deepEqual(codebuddyBuiltinTools("skills"), ["Bash"]);
});

test("translateCodebuddyMessage emits assistant text fallback", () => {
  const { events, emitter } = collector();
  translateCodebuddyMessage(
    { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    emitter,
  );
  assert.deepEqual(events, [{ k: "text", t: "hello" }]);
});

test("translateCodebuddyMessage can skip consolidated assistant text after stream deltas", () => {
  const { events, emitter } = collector();
  translateCodebuddyMessage(
    { type: "assistant", message: { content: [{ type: "text", text: "consolidated" }] } },
    emitter,
    { skipAssistantText: true },
  );
  assert.deepEqual(events, []);
});

test("translateCodebuddyMessage maps stream deltas, tool calls, and tool results", () => {
  const { events, emitter } = collector();
  translateCodebuddyMessage(
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
    emitter,
  );
  translateCodebuddyMessage(
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "why" } } },
    emitter,
  );
  translateCodebuddyMessage(
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }] } },
    emitter,
  );
  translateCodebuddyMessage(
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] } },
    emitter,
  );
  assert.deepEqual(events, [
    { k: "text", t: "hi" },
    { k: "reasoning", d: "why" },
    { k: "toolCall", name: "Bash", args: { command: "ls" }, id: "tu-1" },
    { k: "toolResult", id: "tu-1", out: "ok", name: undefined },
  ]);
});

test("translateCodebuddyMessage emits system session id and status text", () => {
  const { events, emitter } = collector();
  translateCodebuddyMessage(
    { type: "system", session_id: "sess-1", message: "initializing" },
    emitter,
  );
  assert.deepEqual(events, [
    { k: "sessionId", s: "sess-1" },
    { k: "status", m: "initializing" },
  ]);
});

test("runCodebuddyTurn does not duplicate assistant text after streamed text", async () => {
  const { events, emitter } = collector();
  async function* fakeQuery() {
    yield { type: "system", session_id: "sess-1" };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } };
    yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
  }

  const result = await runCodebuddyTurn({
    prompt: "say hi",
    options: { abortController: new AbortController() },
    emitter,
    queryFn: () => fakeQuery(),
  });

  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.deepEqual(events, [
    { k: "sessionId", s: "sess-1" },
    { k: "text", t: "hello" },
    { k: "done" },
  ]);
});

test("runCodebuddyTurn interrupts the SDK query as soon as abort is signaled", async () => {
  const events = [];
  let sawSession;
  const sessionSeen = new Promise((resolve) => { sawSession = resolve; });
  const emitter = {
    text: (t) => events.push({ k: "text", t }),
    reasoning: (d) => events.push({ k: "reasoning", d }),
    toolCall: (name, args, id) => events.push({ k: "toolCall", name, args, id }),
    toolResult: (id, out, name) => events.push({ k: "toolResult", id, out, name }),
    status: (m) => events.push({ k: "status", m }),
    sessionId: (s) => { events.push({ k: "sessionId", s }); sawSession(); },
    emitDone: () => events.push({ k: "done" }),
    emitError: (m) => events.push({ k: "error", m }),
  };
  const ac = new AbortController();
  let interruptCount = 0;
  let release;

  const fakeQuery = () => ({
    interrupt: async () => { interruptCount += 1; release?.(); },
    async *[Symbol.asyncIterator]() {
      yield { type: "system", session_id: "sess-1" };
      await new Promise((resolve) => { release = resolve; });
    },
  });

  const turn = runCodebuddyTurn({
    prompt: "wait",
    options: { abortController: ac },
    emitter,
    queryFn: fakeQuery,
  });

  await sessionSeen;
  ac.abort();
  const result = await turn;

  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.ok(interruptCount >= 1);
  assert.deepEqual(events, [
    { k: "sessionId", s: "sess-1" },
    { k: "done" },
  ]);
});

test("buildCodebuddyPromptInput sends supported images as native image blocks", async () => {
  const input = buildCodebuddyPromptInput("describe this", [
    { filename: "shot.png", mediaType: "image/png", filePath: "/tmp/shot.png", base64Data: "abc" },
    { filename: "bad.svg", mediaType: "image/svg+xml", filePath: "/tmp/bad.svg", base64Data: "def" },
  ]);
  const messages = [];
  for await (const message of input) messages.push(message);
  assert.deepEqual(messages, [{
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ],
    },
    parent_tool_use_id: null,
  }]);
});

test("mapCodebuddyModels maps model ids and drops invalid entries", () => {
  assert.deepEqual(mapCodebuddyModels([
    // Real CLI wire shape ({id,name}) — must NOT be dropped.
    { id: "glm-5.1", name: "GLM-5.1" },
    { modelId: "cb-1", name: "CodeBuddy 1", description: "default" },
    { value: "cb-2", displayName: "CodeBuddy 2" },
    { name: "missing id" },
  ]), [
    { id: "glm-5.1", name: "GLM-5.1", description: undefined },
    { id: "cb-1", name: "CodeBuddy 1", description: "default" },
    { id: "cb-2", name: "CodeBuddy 2", description: undefined },
  ]);
  assert.deepEqual(mapCodebuddyModels(null), []);
});
