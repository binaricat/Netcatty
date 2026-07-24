const test = require("node:test");
const assert = require("node:assert/strict");
const {
  translateCodexEvent,
  buildCodexConstructorOptions,
  buildCodexThreadOptions,
  buildCodexPromptInput,
  runCodexTurn,
  toCodexMcpConfig,
} = require("./codexDriver.cjs");

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
      fileChange: (id, changes, status) => events.push({ k: "fileChange", id, changes, status }),
      webSearch: (id, query, status) => events.push({ k: "webSearch", id, query, status }),
      planUpdate: (id, items, status) => events.push({ k: "planUpdate", id, items, status }),
      warning: (id, message) => events.push({ k: "warning", id, message }),
      usage: (usage) => events.push({ k: "usage", usage }),
      status: (m) => events.push({ k: "status", m }),
      sessionId: (s) => events.push({ k: "sessionId", s }),
      emitError: (e) => events.push({ k: "error", e }),
      emitDone: () => events.push({ k: "done" }),
    },
  };
}

test("agent_message item -> text event", () => {
  const { events, emitter } = collector();
  translateCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "answer" } }, emitter);
  assert.deepEqual(events, [{ k: "text", t: "answer" }]);
});

test("reasoning item -> reasoning event (thinking panel), not plain text", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false };
  translateCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "**Plan**" } }, emitter, state);
  assert.deepEqual(events, [{ k: "reasoning", d: "**Plan**" }]);
  assert.equal(state.reasoningOpen, true);
});

test("reasoning then agent_message -> reasoning, reasoningEnd, text (block closes on content)", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false };
  translateCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "step 1" } }, emitter, state);
  translateCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "step 2" } }, emitter, state);
  translateCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } }, emitter, state);
  assert.deepEqual(events, [
    { k: "reasoning", d: "step 1" },
    { k: "reasoning", d: "step 2" },
    { k: "reasoningEnd" },
    { k: "text", t: "done" },
  ]);
  assert.equal(state.reasoningOpen, false);
});

test("reasoning item updates stream only new thinking text", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false };
  const item = { id: "r-1", type: "reasoning" };
  translateCodexEvent({ type: "item.started", item: { ...item, text: "step 1" } }, emitter, state);
  translateCodexEvent({ type: "item.updated", item: { ...item, text: "step 1\nstep 2" } }, emitter, state);
  translateCodexEvent({ type: "item.completed", item: { ...item, text: "step 1\nstep 2" } }, emitter, state);
  translateCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } }, emitter, state);
  assert.deepEqual(events, [
    { k: "reasoning", d: "step 1" },
    { k: "reasoning", d: "\nstep 2" },
    { k: "reasoningEnd" },
    { k: "text", t: "done" },
  ]);
});

test("mcp_tool_call item -> toolCall + toolResult events (extracts content text)", () => {
  const { events, emitter } = collector();
  translateCodexEvent(
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call", id: "i-1",
        server: "netcatty-remote-hosts", tool: "terminal_execute",
        arguments: { command: "ls" },
        result: { content: [{ type: "text", text: "files" }] },
        status: "completed",
      },
    },
    emitter,
  );
  assert.deepEqual(events.map((e) => e.k), ["toolCall", "toolResult"]);
  assert.equal(events[0].id, "i-1");
  assert.equal(events[0].n, "terminal_execute");
  assert.equal(events[1].o, "files");
});

test("mcp_tool_call streams start early and completes without duplicate tool cards", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false };
  const item = {
    type: "mcp_tool_call", id: "i-live",
    server: "netcatty-remote-hosts", tool: "terminal_execute",
    arguments: { command: "uptime" },
  };
  translateCodexEvent({ type: "item.started", item: { ...item, status: "in_progress" } }, emitter, state);
  assert.deepEqual(events, [
    { k: "toolCall", n: "terminal_execute", a: { command: "uptime" }, id: "i-live" },
  ]);
  translateCodexEvent({ type: "item.updated", item: { ...item, status: "in_progress" } }, emitter, state);
  translateCodexEvent(
    {
      type: "item.completed",
      item: {
        ...item,
        result: { content: [{ type: "text", text: "up 1 day" }] },
        status: "completed",
      },
    },
    emitter,
    state,
  );
  assert.deepEqual(events, [
    { k: "toolCall", n: "terminal_execute", a: { command: "uptime" }, id: "i-live" },
    { k: "toolResult", id: "i-live", o: "up 1 day", n: "terminal_execute" },
  ]);
});

test("command_execution streams start early and completes without duplicate tool cards", () => {
  const { events, emitter } = collector();
  const state = { reasoningOpen: false };
  const item = { type: "command_execution", id: "cmd-live", command: "pwd" };
  translateCodexEvent({ type: "item.started", item: { ...item, status: "in_progress", aggregated_output: "" } }, emitter, state);
  assert.deepEqual(events, [
    { k: "toolCall", n: "shell", a: { command: "pwd" }, id: "cmd-live" },
  ]);
  translateCodexEvent({ type: "item.updated", item: { ...item, status: "in_progress", aggregated_output: "/tmp" } }, emitter, state);
  translateCodexEvent({ type: "item.completed", item: { ...item, status: "completed", aggregated_output: "/tmp\n" } }, emitter, state);
  assert.deepEqual(events, [
    { k: "toolCall", n: "shell", a: { command: "pwd" }, id: "cmd-live" },
    { k: "toolResult", id: "cmd-live", o: "/tmp\n", n: "shell" },
  ]);
});

test("mcp_tool_call failure -> toolResult carries the error message", () => {
  const { events, emitter } = collector();
  translateCodexEvent(
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call", id: "i-2",
        server: "netcatty-remote-hosts", tool: "terminal_execute",
        arguments: {}, error: { message: "denied by observer" }, status: "failed",
      },
    },
    emitter,
  );
  assert.equal(events[1].o, "denied by observer");
});

test("turn.failed -> error event", () => {
  const { events, emitter } = collector();
  translateCodexEvent({ type: "turn.failed", error: { message: "stale login" } }, emitter);
  assert.deepEqual(events, [{ k: "error", e: "stale login" }]);
});

test("turn.completed emits actual token usage", () => {
  const { events, emitter } = collector();
  translateCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 25,
      reasoning_output_tokens: 10,
    },
  }, emitter);
  assert.deepEqual(events, [{
    k: "usage",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 10,
      totalTokens: 125,
    },
  }]);
});

test("turn.completed without usage preserves the estimated fallback", () => {
  const { events, emitter } = collector();
  translateCodexEvent({ type: "turn.completed", usage: {} }, emitter);
  assert.deepEqual(events, []);
});

test("file changes emit once on completion", () => {
  const { events, emitter } = collector();
  const item = {
    id: "patch-1",
    type: "file_change",
    changes: [{ path: "src/app.ts", kind: "update" }],
    status: "completed",
  };
  translateCodexEvent({ type: "item.started", item }, emitter);
  translateCodexEvent({ type: "item.completed", item }, emitter);
  assert.deepEqual(events, [{
    k: "fileChange",
    id: "patch-1",
    changes: item.changes,
    status: "completed",
  }]);
});

test("web search and todo list updates keep stable item ids", () => {
  const { events, emitter } = collector();
  translateCodexEvent({
    type: "item.started",
    item: { id: "search-1", type: "web_search", query: "Codex SDK events" },
  }, emitter);
  translateCodexEvent({
    type: "item.completed",
    item: { id: "search-1", type: "web_search", query: "Codex SDK events" },
  }, emitter);
  translateCodexEvent({
    type: "item.updated",
    item: {
      id: "plan-1",
      type: "todo_list",
      items: [{ text: "Map events", completed: false }],
    },
  }, emitter);
  translateCodexEvent({
    type: "item.completed",
    item: {
      id: "plan-1",
      type: "todo_list",
      items: [{ text: "Map events", completed: true }],
    },
  }, emitter);
  assert.deepEqual(events.map((event) => [event.k, event.id, event.status]), [
    ["webSearch", "search-1", "running"],
    ["webSearch", "search-1", "completed"],
    ["planUpdate", "plan-1", "running"],
    ["planUpdate", "plan-1", "completed"],
  ]);
});

test("item errors and reconnectable stream errors are warnings; other stream errors stay fatal", () => {
  const { events, emitter } = collector();
  const state = {};
  translateCodexEvent({
    type: "item.completed",
    item: { id: "warning-1", type: "error", message: "Search result was unavailable" },
  }, emitter, state);
  translateCodexEvent({
    type: "error",
    message: "Reconnecting... 1/5 (stream disconnected before completion: Transport error: network error: error decoding response body)",
  }, emitter, state);
  translateCodexEvent({
    type: "error",
    message: "stream disconnected before completion: Transport error: error decoding response body; retrying 2/5 in 361ms…",
  }, emitter, state);
  translateCodexEvent({ type: "error", message: "stream disconnected", willRetry: true }, emitter, state);
  translateCodexEvent({ type: "error", message: "transport error", will_retry: true }, emitter, state);
  translateCodexEvent({ type: "error", message: "stream disconnected" }, emitter, state);
  translateCodexEvent({ type: "error", message: "error decoding response body" }, emitter, state);
  translateCodexEvent({ type: "error", message: "transport error" }, emitter, state);
  translateCodexEvent({
    type: "error",
    message: "Reconnecting... 5/5 (stream disconnected before completion: Transport error)",
    willRetry: false,
  }, emitter, state);
  translateCodexEvent({
    type: "error",
    message: "transport error; retrying 5/5 after retries exhausted",
    will_retry: false,
  }, emitter, state);
  translateCodexEvent({ type: "error", message: "not authenticated" }, emitter, state);
  assert.equal(events.filter((event) => event.k === "warning").length, 5);
  assert.deepEqual(events.filter((event) => event.k === "error"), [
    { k: "error", e: "stream disconnected" },
    { k: "error", e: "error decoding response body" },
    { k: "error", e: "transport error" },
    { k: "error", e: "Reconnecting... 5/5 (stream disconnected before completion: Transport error)" },
    { k: "error", e: "transport error; retrying 5/5 after retries exhausted" },
    { k: "error", e: "not authenticated" },
  ]);
  assert.match(events[1].message, /Reconnecting|error decoding response body/);
});

test("explicit non-retryable stream disconnect fails the turn even after partial content", async () => {
  const { events, emitter } = collector();
  class FakeCodex {
    startThread() {
      return {
        id: "thr-exhausted",
        async runStreamed() {
          return {
            events: (async function* () {
              yield { type: "thread.started", thread_id: "thr-exhausted" };
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "partial answer" },
              };
              yield {
                type: "error",
                message: "Reconnecting... 5/5 (stream disconnected before completion: Transport error)",
                willRetry: false,
              };
            })(),
          };
        },
      };
    }
    resumeThread() { return this.startThread(); }
  }
  await runCodexTurn({
    prompt: "hi", constructorOptions: {}, threadOptions: {}, emitter, CodexCtor: FakeCodex,
  });
  assert.deepEqual(events.filter((event) => event.k === "text"), [{ k: "text", t: "partial answer" }]);
  assert.deepEqual(events.filter((event) => event.k === "error"), [
    { k: "error", e: "Reconnecting... 5/5 (stream disconnected before completion: Transport error)" },
  ]);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("message-only transport failure fails the turn even after partial content", async () => {
  const { events, emitter } = collector();
  class FakeCodex {
    startThread() {
      return {
        id: "thr-disconnected",
        async runStreamed() {
          return {
            events: (async function* () {
              yield { type: "thread.started", thread_id: "thr-disconnected" };
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "partial answer" },
              };
              yield {
                type: "error",
                message: "stream disconnected before completion: Transport error",
              };
            })(),
          };
        },
      };
    }
    resumeThread() { return this.startThread(); }
  }
  await runCodexTurn({
    prompt: "hi", constructorOptions: {}, threadOptions: {}, emitter, CodexCtor: FakeCodex,
  });
  assert.deepEqual(events.filter((event) => event.k === "text"), [{ k: "text", t: "partial answer" }]);
  assert.deepEqual(events.filter((event) => event.k === "error"), [
    { k: "error", e: "stream disconnected before completion: Transport error" },
  ]);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("reconnectable Codex stream errors keep the turn open for later output", async () => {
  const { events, emitter } = collector();
  class FakeCodex {
    startThread() {
      return {
        id: "thr-reconnect",
        async runStreamed() {
          return {
            events: (async function* () {
              yield { type: "thread.started", thread_id: "thr-reconnect" };
              yield {
                type: "error",
                message: "Reconnecting... 1/5 (stream disconnected before completion: error decoding response body)",
              };
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "recovered answer" },
              };
            })(),
          };
        },
      };
    }
    resumeThread() { return this.startThread(); }
  }
  await runCodexTurn({
    prompt: "hi", constructorOptions: {}, threadOptions: {}, emitter, CodexCtor: FakeCodex,
  });
  assert.ok(events.some((event) => event.k === "warning" && /decoding response body|Reconnecting/.test(event.message)));
  assert.deepEqual(events.filter((event) => event.k === "text"), [{ k: "text", t: "recovered answer" }]);
  assert.ok(events.some((event) => event.k === "done"));
  assert.equal(events.some((event) => event.k === "error"), false);
});

test("runCodexTurn captures+emits the thread id early so an aborted turn still resumes", async () => {
  // Simulate a Stop that kills the stream mid-turn: thread.started arrives, then
  // the event stream throws. The id must already be emitted (renderer) and
  // returned (handler) so the NEXT turn resumes this thread instead of starting
  // fresh (which is what made the whole session lose its memory after a Stop).
  const { events, emitter } = collector();
  class FakeCodex {
    startThread() {
      return {
        id: "thr-abc",
        async runStreamed() {
          return {
            events: (async function* () {
              yield { type: "thread.started", thread_id: "thr-abc" };
              throw new Error("stream aborted mid-turn");
            })(),
          };
        },
      };
    }
    resumeThread() { return this.startThread(); }
  }
  const result = await runCodexTurn({
    prompt: "hi", constructorOptions: {}, threadOptions: {}, emitter, CodexCtor: FakeCodex,
  });
  assert.deepEqual(events.filter((e) => e.k === "sessionId"), [{ k: "sessionId", s: "thr-abc" }]);
  assert.equal(result.threadId, "thr-abc");
});

test("buildCodexPromptInput sends image attachments as native local_image inputs", () => {
  const input = buildCodexPromptInput("describe this", [
    { filename: "shot.png", mediaType: "image/png", filePath: "/tmp/shot.png", base64Data: "abc" },
    { filename: "note.txt", mediaType: "text/plain", filePath: "/tmp/note.txt", base64Data: "def" },
  ]);
  assert.deepEqual(input, [
    { type: "text", text: "describe this" },
    { type: "local_image", path: "/tmp/shot.png" },
  ]);
});

test("runCodexTurn passes native image input to the SDK", async () => {
  const { emitter } = collector();
  let capturedInput = null;
  class FakeCodex {
    startThread() {
      return {
        id: "thr-img",
        async runStreamed(input) {
          capturedInput = input;
          return {
            events: (async function* () {
              yield { type: "thread.started", thread_id: "thr-img" };
              yield { type: "item.completed", item: { type: "agent_message", text: "ok" } };
            })(),
          };
        },
      };
    }
  }
  await runCodexTurn({
    prompt: "what is in this image",
    attachments: [{ mediaType: "image/png", filePath: "/tmp/a.png", base64Data: "abc" }],
    constructorOptions: {},
    threadOptions: {},
    emitter,
    CodexCtor: FakeCodex,
  });
  assert.deepEqual(capturedInput, [
    { type: "text", text: "what is in this image" },
    { type: "local_image", path: "/tmp/a.png" },
  ]);
});

test("buildCodexConstructorOptions sets path override + env + mcp config table", () => {
  const opts = buildCodexConstructorOptions({
    codexPath: "/abs/codex",
    env: { PATH: "/usr/bin" },
    apiKey: undefined,
    injectedMcpServers: [{
      name: "netcatty-remote-hosts", command: "/abs/electron",
      args: ["/abs/server.cjs"], env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });
  assert.equal(opts.codexPathOverride, "/abs/codex");
  assert.equal(opts.env.PATH, "/usr/bin");
  assert.deepEqual(opts.config.mcp_servers["netcatty-remote-hosts"], {
    command: "/abs/electron", args: ["/abs/server.cjs"], env: { NETCATTY_MCP_PORT: "1" },
  });
  // request visible reasoning summaries (default "auto" emits none in exec mode)
  assert.equal(opts.config.model_reasoning_summary, "concise");
});

test("toCodexMcpConfig can delegate MCP approval to the embedding client", () => {
  const config = toCodexMcpConfig([{
    name: "netcatty-remote-hosts",
    command: "/abs/electron",
    args: ["/abs/server.cjs"],
    env: [],
  }], { defaultToolsApprovalMode: "approve" });

  assert.equal(
    config["netcatty-remote-hosts"].default_tools_approval_mode,
    "approve",
  );
});

test("buildCodexThreadOptions enables MCP via danger-full-access + approvalPolicy never", () => {
  // codex-sdk: model/sandboxMode/workingDirectory are ThreadOptions (startThread),
  // not runStreamed TurnOptions. Non-interactive `codex exec` cancels MCP tool
  // calls under read-only/workspace-write (any approval policy); only the full
  // bypass (danger-full-access + never) lets injected netcatty MCP tools run.
  // Real guardrails live in the netcatty MCP server, not codex's local sandbox.
  const t = buildCodexThreadOptions({ cwd: "/tmp", model: "gpt-5.5" });
  assert.equal(t.sandboxMode, "danger-full-access");
  assert.equal(t.approvalPolicy, "never");
  assert.equal(t.workingDirectory, "/tmp");
  assert.equal(t.model, "gpt-5.5");
  assert.equal(t.modelReasoningEffort, undefined);
  assert.equal(t.skipGitRepoCheck, true);
});

test("buildCodexThreadOptions splits <model>/<effort> into model + modelReasoningEffort", () => {
  const t = buildCodexThreadOptions({ model: "gpt-5.5/high" });
  assert.equal(t.model, "gpt-5.5");
  assert.equal(t.modelReasoningEffort, "high");
  // GPT-5.6 advertises max/ultra reasoning efforts in the Codex catalog.
  const solMax = buildCodexThreadOptions({ model: "gpt-5.6-sol/max" });
  assert.equal(solMax.model, "gpt-5.6-sol");
  assert.equal(solMax.modelReasoningEffort, "max");
  const solUltra = buildCodexThreadOptions({ model: "gpt-5.6-sol/ultra" });
  assert.equal(solUltra.model, "gpt-5.6-sol");
  assert.equal(solUltra.modelReasoningEffort, "ultra");
  // a trailing segment that isn't a valid effort (custom/OpenRouter id) is kept whole
  const c = buildCodexThreadOptions({ model: "openrouter/some-model" });
  assert.equal(c.model, "openrouter/some-model");
  assert.equal(c.modelReasoningEffort, undefined);
});
