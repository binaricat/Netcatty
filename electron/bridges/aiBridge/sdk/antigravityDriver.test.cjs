const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildAntigravityWorkerRequest,
  resolveAntigravityWorkerPath,
  runAntigravityTurn,
  translateAntigravityWorkerEvent,
} = require("./antigravityDriver.cjs");

test("resolveAntigravityWorkerPath points packaged builds at the unpacked Python worker", () => {
  assert.equal(
    resolveAntigravityWorkerPath("/Applications/Netcatty.app/Contents/Resources/app.asar/electron/bridges/aiBridge/sdk"),
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/electron/bridges/aiBridge/sdk/antigravity_worker.py",
  );
  assert.equal(
    resolveAntigravityWorkerPath("/workspace/electron/bridges/aiBridge/sdk"),
    "/workspace/electron/bridges/aiBridge/sdk/antigravity_worker.py",
  );
});

function collector() {
  const events = [];
  return {
    events,
    emitter: {
      text: (text) => events.push({ type: "text", text }),
      reasoning: (text) => events.push({ type: "reasoning", text }),
      reasoningEnd: () => events.push({ type: "reasoning-end" }),
      toolCall: (name, args, id) => events.push({ type: "tool-call", name, args, id }),
      toolResult: (id, output, name) => events.push({ type: "tool-result", id, output, name }),
      usage: (usage) => events.push({ type: "usage", usage }),
      sessionId: (id) => events.push({ type: "session-id", id }),
      status: (message) => events.push({ type: "status", message }),
    },
  };
}

test("buildAntigravityWorkerRequest disables direct local tools in MCP mode", () => {
  assert.deepEqual(buildAntigravityWorkerRequest({
    prompt: "inspect the host",
    cwd: "/workspace",
    permissionMode: "confirm",
    toolIntegrationMode: "mcp",
    saveDir: "/managed/temp/antigravity/sessions",
    appDataDir: "/managed/temp/antigravity/app-data",
    resumeSessionId: "12345678-1234-1234-1234-123456789abc",
    attachments: [{ filePath: "/tmp/screenshot.png", mediaType: "image/png", filename: "screenshot.png" }],
    injectedMcpServers: [{
      name: "netcatty",
      command: "/app/electron",
      args: ["/app/netcatty-mcp-server.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "4321" }],
    }],
  }), {
    type: "turn",
    prompt: "inspect the host",
    cwd: "/workspace",
    permissionMode: "confirm",
    toolIntegrationMode: "mcp",
    saveDir: "/managed/temp/antigravity/sessions",
    appDataDir: "/managed/temp/antigravity/app-data",
    conversationId: "12345678-1234-1234-1234-123456789abc",
    attachments: [{ path: "/tmp/screenshot.png", mediaType: "image/png", filename: "screenshot.png" }],
    mcpServers: [{
      name: "netcatty",
      command: "/app/electron",
      args: ["/app/netcatty-mcp-server.cjs"],
      env: { NETCATTY_MCP_PORT: "4321" },
    }],
  });
});

test("translateAntigravityWorkerEvent maps the official SDK stream to Netcatty events", () => {
  const { events, emitter } = collector();
  translateAntigravityWorkerEvent({ type: "text", text: "hello" }, emitter);
  translateAntigravityWorkerEvent({ type: "reasoning", text: "thinking" }, emitter);
  translateAntigravityWorkerEvent({ type: "tool_call", id: "call-1", name: "netcatty_terminal_execute", args: { command: "pwd" } }, emitter);
  translateAntigravityWorkerEvent({ type: "tool_result", id: "call-1", name: "netcatty_terminal_execute", output: { ok: true } }, emitter);
  translateAntigravityWorkerEvent({ type: "usage", inputTokens: 11, cachedInputTokens: 2, outputTokens: 7, reasoningTokens: 3, totalTokens: 21 }, emitter);
  translateAntigravityWorkerEvent({ type: "session_id", sessionId: "session-1" }, emitter);

  assert.deepEqual(events, [
    { type: "text", text: "hello" },
    { type: "reasoning", text: "thinking" },
    { type: "tool-call", name: "netcatty_terminal_execute", args: { command: "pwd" }, id: "call-1" },
    { type: "tool-result", id: "call-1", output: { ok: true }, name: "netcatty_terminal_execute" },
    { type: "usage", usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 7, reasoningTokens: 3, totalTokens: 21 } },
    { type: "session-id", id: "session-1" },
  ]);
});

test("runAntigravityTurn starts the SDK worker, streams JSONL, and returns its session", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const writes = [];
  child.stdin.on("data", (chunk) => writes.push(chunk.toString()));
  const spawned = [];
  const { events, emitter } = collector();

  const turn = runAntigravityTurn({
    prompt: "hello",
    cwd: "/workspace",
    env: { GEMINI_API_KEY: "secret" },
    pythonPath: "/usr/bin/python3",
    injectedMcpServers: [],
    toolIntegrationMode: "mcp",
    permissionMode: "observer",
    chatSessionId: "chat-123",
    emitter,
  }, {
    workerPath: "/app/antigravity_worker.py",
    resolveStorageDirs() {
      return {
        saveDir: "/managed/temp/antigravity/sessions",
        appDataDir: "/managed/temp/antigravity/app-data",
      };
    },
    spawn(command, args, options) {
      spawned.push({ command, args, options });
      return child;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write('{"type":"session_id","sessionId":"session-123"}\n');
  child.stdout.write('{"type":"text","text":"Hi"}\n');
  child.stdout.write('{"type":"done"}\n');
  child.stdout.end();
  child.emit("close", 0, null);

  assert.deepEqual(await turn, { sessionId: "session-123" });
  assert.deepEqual(spawned, [{
    command: "/usr/bin/python3",
    args: ["/app/antigravity_worker.py"],
    options: {
      cwd: "/workspace",
      env: { GEMINI_API_KEY: "secret" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  }]);
  assert.equal(JSON.parse(writes.join("")).prompt, "hello");
  assert.equal(JSON.parse(writes.join("")).saveDir, "/managed/temp/antigravity/sessions");
  assert.equal(JSON.parse(writes.join("")).appDataDir, "/managed/temp/antigravity/app-data");
  assert.deepEqual(events, [
    { type: "session-id", id: "session-123" },
    { type: "text", text: "Hi" },
  ]);
});

test("Python worker completes MCP activities from the official receive_steps contract", (t) => {
  const python = [process.env.PYTHON, "python3", "python"]
    .filter(Boolean)
    .find((candidate) => spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0);
  if (!python) return t.skip("Python is not available");

  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-antigravity-worker-"));
  t.after(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
  const packageRoot = path.join(fakeRoot, "google", "antigravity");
  fs.mkdirSync(path.join(packageRoot, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "google", "__init__.py"), "");
  fs.writeFileSync(path.join(packageRoot, "hooks", "__init__.py"), "");
  fs.writeFileSync(path.join(packageRoot, "hooks", "policy.py"), "def allow_all(): return 'allow-all'\n");
  fs.writeFileSync(path.join(packageRoot, "types.py"), `
from enum import Enum
from types import SimpleNamespace
class BuiltinTools:
  @staticmethod
  def none(): return []
class CapabilitiesConfig:
  def __init__(self, enabled_tools=None): self.enabled_tools = enabled_tools
class McpStdioServer:
  def __init__(self, **kwargs): self.kwargs = kwargs
class SessionContinuationMode:
  CREATE_OR_RESUME = "create_or_resume"
class StepSource(Enum):
  MODEL = "MODEL"
class StepTarget(Enum):
  USER = "TARGET_USER"
  ENVIRONMENT = "TARGET_ENVIRONMENT"
class StepStatus(Enum):
  ACTIVE = "ACTIVE"
  DONE = "DONE"
  ERROR = "ERROR"
  CANCELED = "CANCELED"
class ToolCall:
  def __init__(self, id, name, args): self.id, self.name, self.args = id, name, args
def from_file(file_path): return file_path
`);
  fs.writeFileSync(path.join(packageRoot, "__init__.py"), `
from types import SimpleNamespace
from . import types
class LocalAgentConfig:
  def __init__(self, **kwargs):
    assert kwargs["save_dir"].endswith("sessions")
    assert kwargs["app_data_dir"].endswith("app-data")
class Conversation:
  conversation_id = "12345678-1234-1234-1234-123456789abc"
  async def send(self, prompt): pass
  async def receive_steps(self):
    call = types.ToolCall("call-1", "netcatty_terminal_execute", {"command": "pwd"})
    base = dict(thinking_delta="", content_delta="", tool_calls=[call], error="", usage_metadata=None, id="step-1")
    yield SimpleNamespace(source=types.StepSource.MODEL, target=types.StepTarget.ENVIRONMENT, status=types.StepStatus.ACTIVE, **base)
    yield SimpleNamespace(source=types.StepSource.MODEL, target=types.StepTarget.ENVIRONMENT, status=types.StepStatus.DONE, **base)
    usage = SimpleNamespace(prompt_token_count=3, cached_content_token_count=1, candidates_token_count=2, thoughts_token_count=0, total_token_count=5)
    yield SimpleNamespace(source=types.StepSource.MODEL, target=types.StepTarget.USER, status=types.StepStatus.DONE, thinking_delta="", content_delta="done", tool_calls=[], error="", usage_metadata=usage, id="step-2")
class Agent:
  def __init__(self, config): self.conversation = Conversation()
  @property
  def conversation_id(self): return self.conversation.conversation_id
  async def __aenter__(self): return self
  async def __aexit__(self, *args): pass
`);

  const request = {
    type: "turn",
    prompt: "run pwd",
    cwd: fakeRoot,
    saveDir: path.join(fakeRoot, "sessions"),
    appDataDir: path.join(fakeRoot, "app-data"),
    mcpServers: [{ name: "netcatty", command: "netcatty-mcp", args: [], env: {} }],
  };
  const result = spawnSync(python, [path.join(__dirname, "antigravity_worker.py")], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: fakeRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "tool_call").length, 1);
  assert.deepEqual(events.find((event) => event.type === "tool_result"), {
    type: "tool_result",
    id: "call-1",
    name: "netcatty_terminal_execute",
    output: { status: "DONE" },
  });
  assert.equal(events.find((event) => event.type === "text").text, "done");
  assert.equal(events.at(-1).type, "done");
});
