const test = require("node:test");
const assert = require("node:assert/strict");
const { translateClaudeMessage, buildClaudeQueryOptions, buildClaudePromptInput, classifyClaudeSpawnError, mapClaudeModels, parseClaudeSettings } = require("./claudeDriver.cjs");

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
  };
  return { events, emitter };
}

test("init system message -> sessionId event", () => {
  const { events, emitter } = collector();
  translateClaudeMessage({ type: "system", subtype: "init", session_id: "sess-1" }, emitter);
  assert.deepEqual(events, [{ k: "sessionId", s: "sess-1" }]);
});

test("stream_event text_delta -> text event", () => {
  const { events, emitter } = collector();
  translateClaudeMessage(
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } },
    emitter,
  );
  assert.deepEqual(events, [{ k: "text", t: "hello" }]);
});

test("assistant tool_use block -> toolCall event", () => {
  const { events, emitter } = collector();
  translateClaudeMessage(
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu-1", name: "mcp__netcatty-remote-hosts__terminal_execute", input: { command: "ls" } }] },
    },
    emitter,
  );
  assert.deepEqual(events, [
    { k: "toolCall", name: "mcp__netcatty-remote-hosts__terminal_execute", args: { command: "ls" }, id: "tu-1" },
  ]);
});

test("assistant text block (non-partial) is NOT double-emitted when partials enabled", () => {
  // With includePartialMessages, text arrives via stream_event; the assistant
  // message text block is the consolidated copy and must be skipped to avoid dupes.
  const { events, emitter } = collector();
  translateClaudeMessage(
    { type: "assistant", message: { content: [{ type: "text", text: "consolidated" }] } },
    emitter,
  );
  assert.deepEqual(events, []);
});

test("user tool_result block -> toolResult event", () => {
  const { events, emitter } = collector();
  translateClaudeMessage(
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "output text" }] } },
    emitter,
  );
  assert.deepEqual(events, [{ k: "toolResult", id: "tu-1", out: "output text", name: undefined }]);
});

test("buildClaudeQueryOptions sets bypassPermissions, built-in tools, mcp stdio, abort", () => {
  const ac = new AbortController();
  const opts = buildClaudeQueryOptions({
    cwd: "/tmp",
    model: "claude-opus-4-6",
    env: { PATH: "/usr/bin" },
    pathToClaudeCodeExecutable: "/abs/claude",
    abortController: ac,
    injectedMcpServers: [{
      name: "netcatty-remote-hosts", type: "stdio",
      command: "/abs/electron", args: ["/abs/server.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });
  assert.equal(opts.permissionMode, "bypassPermissions");
  // required companion to bypassPermissions (SDK rejects the bypass without it)
  assert.equal(opts.allowDangerouslySkipPermissions, true);
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.pathToClaudeCodeExecutable, "/abs/claude");
  assert.equal(opts.abortController, ac);
  // MCP mode disables Claude Code built-ins entirely; injected MCP tools remain wired below.
  assert.deepEqual(opts.tools, []);
  for (const t of ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]) {
    assert.ok(opts.disallowedTools.includes(t), `expected ${t} disallowed`);
  }
  // netcatty MCP wired as keyed stdio with env object (not pair array)
  assert.equal(opts.mcpServers["netcatty-remote-hosts"].type, "stdio");
  assert.deepEqual(opts.mcpServers["netcatty-remote-hosts"].env, { NETCATTY_MCP_PORT: "1" });
});

test("built-in tools are mode-aware: Skills+CLI allows only Bash/Skill, MCP blocks all built-ins", () => {
  const skills = buildClaudeQueryOptions({ env: {}, toolIntegrationMode: "skills" });
  // Bash + Skill are the only Claude Code built-ins exposed so the agent can
  // drive the netcatty CLI skill without direct file/search/web/local tools.
  assert.deepEqual(skills.tools, ["Bash", "Skill"]);
  for (const t of ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "REPL", "Workflow"]) {
    assert.ok(!skills.tools.includes(t), `expected ${t} absent from skills mode tool whitelist`);
  }
  // UI-coupled tools still blocked in BOTH modes as defense-in-depth.
  for (const t of ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]) {
    assert.ok(skills.disallowedTools.includes(t), `expected ${t} blocked in skills mode`);
  }
  // MCP mode (and the undefined default) disables all Claude Code built-ins.
  assert.deepEqual(buildClaudeQueryOptions({ env: {}, toolIntegrationMode: "mcp" }).tools, []);
  assert.deepEqual(buildClaudeQueryOptions({ env: {} }).tools, []);
});

test("classifyClaudeSpawnError detects ENOENT 'native binary not found'", () => {
  const r = classifyClaudeSpawnError(new Error("Claude Code native binary not found at /abs/claude"));
  assert.equal(r.isSpawnEnoent, true);
});

test("classifyClaudeSpawnError detects code:ENOENT", () => {
  const e = new Error("spawn failed"); e.code = "ENOENT"; e.syscall = "spawn";
  assert.equal(classifyClaudeSpawnError(e).isSpawnEnoent, true);
});

test("mapClaudeModels maps {value,displayName,description} -> {id,name,description} and drops value-less", () => {
  const out = mapClaudeModels([
    { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Recommended" },
    { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
    { displayName: "no value -> dropped" },
  ]);
  assert.deepEqual(out, [
    { id: "claude-opus-4-6", name: "Opus 4.6", description: "Recommended" },
    { id: "claude-sonnet-4-6", name: "Sonnet 4.6", description: undefined },
  ]);
  assert.deepEqual(mapClaudeModels(null), []);
});

test("parseClaudeSettings: path string, inline JSON object, empty, and bad JSON", () => {
  assert.equal(parseClaudeSettings("/path/to/settings.json"), "/path/to/settings.json");
  assert.deepEqual(parseClaudeSettings('{"model":"sonnet"}'), { model: "sonnet" });
  assert.deepEqual(parseClaudeSettings({ model: "opus" }), { model: "opus" });
  assert.equal(parseClaudeSettings(""), undefined);
  assert.equal(parseClaudeSettings(null), undefined);
  assert.equal(parseClaudeSettings("{bad json"), "{bad json"); // invalid JSON -> treated as a path
});

test("buildClaudeQueryOptions wires settings (additive to CLAUDE_CONFIG_DIR) and omits when absent", () => {
  const withS = buildClaudeQueryOptions({ env: {}, settings: "/abs/settings.json" });
  assert.equal(withS.settings, "/abs/settings.json");
  const without = buildClaudeQueryOptions({ env: {} });
  assert.equal("settings" in without, false);
});

test("buildClaudeQueryOptions wires resume so context carries across turns; omits when absent", () => {
  // Without options.resume the SDK starts a fresh session every turn (amnesia).
  assert.equal(buildClaudeQueryOptions({ env: {}, resume: "sess-1" }).resume, "sess-1");
  assert.equal("resume" in buildClaudeQueryOptions({ env: {} }), false);
});

test("buildClaudePromptInput sends supported images as native image blocks", async () => {
  const input = buildClaudePromptInput("describe this", [
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

test("buildClaudePromptInput keeps plain text when there are no supported images", () => {
  assert.equal(
    buildClaudePromptInput("hello", [{ filename: "note.txt", mediaType: "text/plain", base64Data: "abc" }]),
    "hello",
  );
});
