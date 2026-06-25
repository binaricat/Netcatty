const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPiCreateAgentSessionOptions,
  buildPiMcpToolDefinitions,
  buildPiPromptContent,
  buildPiToolName,
  mcpResultToText,
  parsePiModelSelection,
  runPiTurn,
  translatePiSessionEvent,
} = require("./piDriver.cjs");

function collector() {
  const events = [];
  const emitter = {
    text: (t) => events.push({ k: "text", t }),
    reasoning: (d) => events.push({ k: "reasoning", d }),
    reasoningEnd: () => events.push({ k: "reasoningEnd" }),
    toolCall: (name, args, id) => events.push({ k: "toolCall", name, args, id }),
    toolResult: (id, out, name) => events.push({ k: "toolResult", id, out, name }),
    status: (m) => events.push({ k: "status", m }),
    sessionId: (s) => events.push({ k: "sessionId", s }),
    emitDone: () => events.push({ k: "done" }),
    emitError: (m) => events.push({ k: "error", m }),
  };
  return { events, emitter };
}

test("parsePiModelSelection splits provider/model/thinking", () => {
  assert.deepEqual(parsePiModelSelection("anthropic/claude-sonnet-4-5/high"), {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    thinkingLevel: "high",
  });
  assert.deepEqual(parsePiModelSelection("openrouter/openai/gpt-5.1"), {
    provider: "openrouter",
    modelId: "openai/gpt-5.1",
    thinkingLevel: undefined,
  });
});

test("buildPiPromptContent includes supported images", () => {
  assert.deepEqual(buildPiPromptContent("describe", [
    { filename: "shot.png", mediaType: "image/png", base64Data: "abc" },
    { filename: "bad.svg", mediaType: "image/svg+xml", base64Data: "def" },
  ]), [
    { type: "text", text: "describe" },
    { type: "image", data: "abc", mimeType: "image/png" },
  ]);
});

test("buildPiCreateAgentSessionOptions disables Pi built-ins and allowlists custom tools", () => {
  const options = buildPiCreateAgentSessionOptions({
    cwd: "/tmp/project",
    customTools: [{ name: "mcp__netcatty__terminal_execute" }],
    sdk: { SessionManager: { inMemory: (cwd) => ({ cwd }) } },
  });

  assert.equal(options.noTools, "builtin");
  assert.deepEqual(options.tools, ["mcp__netcatty__terminal_execute"]);
  assert.deepEqual(options.sessionManager, { cwd: "/tmp/project" });
});

test("translatePiSessionEvent maps text, reasoning, tools, compaction, and errors", () => {
  const { events, emitter } = collector();
  const state = {};

  translatePiSessionEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think" } }, emitter, state);
  translatePiSessionEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } }, emitter, state);
  translatePiSessionEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "mcp__netcatty__terminal_execute", args: { command: "uptime" } }, emitter, state);
  translatePiSessionEvent({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "mcp__netcatty__terminal_execute", result: { content: [{ type: "text", text: "ok" }] } }, emitter, state);
  translatePiSessionEvent({ type: "compaction_start", reason: "threshold" }, emitter, state);
  translatePiSessionEvent({ type: "message_end", message: { role: "assistant", errorMessage: "boom" } }, emitter, state);

  assert.deepEqual(events, [
    { k: "reasoning", d: "think" },
    { k: "reasoningEnd" },
    { k: "text", t: "hello" },
    { k: "toolCall", name: "mcp__netcatty__terminal_execute", args: { command: "uptime" }, id: "tool-1" },
    { k: "toolResult", id: "tool-1", out: "ok", name: "mcp__netcatty__terminal_execute" },
    { k: "status", m: "Pi compaction started (threshold)" },
    { k: "error", m: "boom" },
  ]);
});

test("buildPiMcpToolDefinitions exposes MCP tools as Pi custom tools", async () => {
  const calls = [];
  const { tools, cleanup } = await buildPiMcpToolDefinitions([{
    name: "netcatty-remote-hosts",
    command: "/abs/electron",
    args: ["/abs/server.cjs"],
    env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
  }], {
    createMcpClient: async () => ({
      async listTools() {
        return {
          tools: [{
            name: "terminal_execute",
            description: "Run a command",
            inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          }],
        };
      },
      async callTool(args) {
        calls.push(args);
        return { content: [{ type: "text", text: "done" }] };
      },
      async close() {
        calls.push({ closed: true });
      },
    }),
  });

  assert.equal(tools[0].name, buildPiToolName("netcatty-remote-hosts", "terminal_execute"));
  assert.equal(tools[0].parameters.properties.command.type, "string");
  const result = await tools[0].execute("call-1", { command: "uptime" });
  assert.deepEqual(calls[0], { name: "terminal_execute", arguments: { command: "uptime" } });
  assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
  await cleanup();
  assert.deepEqual(calls[1], { closed: true });
});

test("mcpResultToText formats text and non-text content", () => {
  assert.equal(mcpResultToText({ content: [{ type: "text", text: "a" }, { type: "image" }] }), "a[image]");
  assert.equal(mcpResultToText({ ok: true }), '{"ok":true}');
});

test("runPiTurn creates a Pi session with Netcatty custom tools only", async () => {
  const { events, emitter } = collector();
  let observedOptions;
  let observedPrompt;
  const fakeSession = {
    sessionId: "pi-session-1",
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async sendUserMessage(prompt) {
      observedPrompt = prompt;
      this.listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
      this.listener({ type: "agent_end" });
    },
    dispose() {},
  };

  const result = await runPiTurn({
    prompt: "hello",
    cwd: "/tmp/project",
    injectedMcpServers: [{ name: "netcatty", command: "server" }],
    emitter,
    createAgentSessionFn: async (options) => {
      observedOptions = options;
      return { session: fakeSession };
    },
    buildMcpToolsFn: async () => ({
      tools: [{ name: "mcp__netcatty__terminal_execute" }],
      cleanup() {},
    }),
    sdkModule: {
      createAgentSession: async () => ({ session: fakeSession }),
      SessionManager: { inMemory: (cwd) => ({ cwd }) },
    },
  });

  assert.equal(observedOptions.noTools, "builtin");
  assert.deepEqual(observedOptions.tools, ["mcp__netcatty__terminal_execute"]);
  assert.equal(observedPrompt, "hello");
  assert.deepEqual(events, [
    { k: "sessionId", s: "pi-session-1" },
    { k: "text", t: "hi" },
    { k: "done" },
  ]);
  assert.deepEqual(result, { sessionId: null });
});
