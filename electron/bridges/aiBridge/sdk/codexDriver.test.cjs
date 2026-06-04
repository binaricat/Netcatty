const test = require("node:test");
const assert = require("node:assert/strict");
const { translateCodexEvent, buildCodexConstructorOptions, buildCodexThreadOptions } = require("./codexDriver.cjs");

function collector() {
  const events = [];
  return {
    events,
    emitter: {
      text: (t) => events.push({ k: "text", t }),
      toolCall: (n, a, id) => events.push({ k: "toolCall", n, a, id }),
      toolResult: (id, o, n) => events.push({ k: "toolResult", id, o, n }),
      status: (m) => events.push({ k: "status", m }),
      sessionId: (s) => events.push({ k: "sessionId", s }),
      emitError: (e) => events.push({ k: "error", e }),
    },
  };
}

test("agent_message item -> text event", () => {
  const { events, emitter } = collector();
  translateCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "answer" } }, emitter);
  assert.deepEqual(events, [{ k: "text", t: "answer" }]);
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

test("turn.completed is a no-op event-wise", () => {
  const { events, emitter } = collector();
  translateCodexEvent({ type: "turn.completed", usage: {} }, emitter);
  assert.deepEqual(events, []);
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
});

test("buildCodexThreadOptions puts model + read-only sandbox in ThreadOptions", () => {
  // codex-sdk: model/sandboxMode/workingDirectory are ThreadOptions (startThread),
  // not runStreamed TurnOptions.
  const t = buildCodexThreadOptions({ cwd: "/tmp", model: "gpt-5.1-codex" });
  assert.equal(t.sandboxMode, "read-only");
  assert.equal(t.workingDirectory, "/tmp");
  assert.equal(t.model, "gpt-5.1-codex");
  assert.equal(t.skipGitRepoCheck, true);
});
