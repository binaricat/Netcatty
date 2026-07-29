const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  answersRecordToOpenCodeAnswers,
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  buildOpenCodeQuestionReplyUrl,
  classifyOpenCodeSpawnError,
  createOpenCodeProcessEnv,
  listOpenCodeModels,
  mapOpenCodeModels,
  normalizeOpenCodeQuestions,
  OPENCODE_LIST_SERVER_IDLE_MS,
  parseOpenCodeModel,
  resetOpenCodeListServerPool,
  resolveUsableOpenCodeBinPath,
  runOpenCodeTurn,
  translateOpenCodeEvent,
  withOpenCodeProcessEnv,
} = require("./opencodeDriver.cjs");

function collector() {
  const events = [];
  const emitter = {
    text: (t) => events.push({ k: "text", t }),
    reasoning: (d) => events.push({ k: "reasoning", d }),
    toolCall: (name, args, id) => events.push({ k: "toolCall", name, args, id }),
    toolResult: (id, out, name) => events.push({ k: "toolResult", id, out, name }),
    questionAsk: (payload) => events.push({ k: "questionAsk", payload }),
    questionSettled: (payload) => events.push({ k: "questionSettled", payload }),
    status: (m) => events.push({ k: "status", m }),
    sessionId: (s) => events.push({ k: "sessionId", s }),
    emitDone: () => events.push({ k: "done" }),
    emitError: (m) => events.push({ k: "error", m }),
  };
  return { events, emitter };
}

test("parseOpenCodeModel splits provider/model ids", () => {
  assert.deepEqual(parseOpenCodeModel("openai/gpt-5.1"), { providerID: "openai", modelID: "gpt-5.1" });
  assert.deepEqual(parseOpenCodeModel("anthropic/claude-sonnet-4-6"), { providerID: "anthropic", modelID: "claude-sonnet-4-6" });
  assert.equal(parseOpenCodeModel("gpt-5.1"), undefined);
  assert.equal(parseOpenCodeModel(""), undefined);
});

test("buildOpenCodeConfig isolates local tools and injects Netcatty MCP", () => {
  const cfg = buildOpenCodeConfig({
    model: "openai/gpt-5.1",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "/abs/electron",
      args: ["/abs/server.cjs"],
      env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });

  assert.equal(cfg.model, "openai/gpt-5.1");
  assert.equal(cfg.permission.edit, "deny");
  assert.equal(cfg.permission.bash, "deny");
  assert.equal(cfg.permission.webfetch, "deny");
  assert.equal(cfg.permission.question, "allow");
  assert.equal(cfg.permission.skill, "allow");
  assert.equal(cfg.permission.external_directory["*"], "deny");
  // Native OpenCode skill directories stay readable in MCP mode (issue #1939).
  assert.equal(cfg.permission.external_directory["*.opencode/skills/**"], "allow");
  assert.equal(cfg.permission.read["*.config/opencode/skills/**"], "allow");
  assert.equal(cfg.permission.read["*"], undefined);
  assert.deepEqual(cfg.mcp["netcatty-remote-hosts"], {
    type: "local",
    command: ["/abs/electron", "/abs/server.cjs"],
    environment: { NETCATTY_MCP_PORT: "1" },
    enabled: true,
  });
});

test("buildOpenCodeConfig allowlists Netcatty CLI paths in skills mode", () => {
  const cfg = buildOpenCodeConfig({
    toolIntegrationMode: "skills",
    skillsPathAllowlist: [
      "/Applications/Netcatty.app/Contents/MacOS/**",
      "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
    ],
  });

  assert.equal(cfg.permission.bash, "allow");
  assert.equal(cfg.permission.skill, "allow");
  assert.equal(cfg.permission.list, "deny");
  assert.equal(cfg.permission.external_directory["*"], "deny");
  assert.equal(cfg.permission.external_directory["/Applications/Netcatty.app/Contents/MacOS/**"], "allow");
  assert.equal(
    cfg.permission.external_directory["/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**"],
    "allow",
  );
  // Native OpenCode skill directories stay readable in skills mode too (issue #1939).
  assert.equal(cfg.permission.external_directory["*.opencode/skills/**"], "allow");
  assert.equal(cfg.permission.read["*.claude/skills/**"], "allow");
});

test("buildOpenCodePromptParts includes supported images as file parts", () => {
  assert.deepEqual(buildOpenCodePromptParts("describe", [
    { filename: "shot.png", mediaType: "image/png", filePath: "/tmp/shot.png", base64Data: "abc" },
    { filename: "bad.svg", mediaType: "image/svg+xml", filePath: "/tmp/bad.svg", base64Data: "def" },
  ]), [
    { type: "text", text: "describe" },
    { type: "file", mime: "image/png", filename: "shot.png", url: "file:///tmp/shot.png" },
  ]);
});

test("createOpenCodeProcessEnv creates an opencode shim for arbitrary custom binary paths", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-opencode-test-"));
  const fakeBin = path.join(tempRoot, "my-opencode-wrapper");
  fs.writeFileSync(fakeBin, "#!/bin/sh\n");
  fs.chmodSync(fakeBin, 0o755);

  const { env, cleanup } = createOpenCodeProcessEnv(
    { PATH: "/usr/bin" },
    fakeBin,
    {
      platform: "linux",
      getTempFilePath: (name) => path.join(tempRoot, name),
    },
  );

  try {
    const shimDir = env.PATH.split(path.delimiter)[0];
    const shim = path.join(shimDir, "opencode");
    assert.equal(env.OPENCODE_BIN, fakeBin);
    assert.equal(fs.existsSync(shim), true);
    assert.match(fs.readFileSync(shim, "utf8"), new RegExp(`exec "${fakeBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("createOpenCodeProcessEnv uses a unique shim directory per launch", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-opencode-test-"));
  const fakeBin = path.join(tempRoot, "my-opencode-wrapper");
  fs.writeFileSync(fakeBin, "#!/bin/sh\n");
  fs.chmodSync(fakeBin, 0o755);

  const first = createOpenCodeProcessEnv(
    { PATH: "/usr/bin" },
    fakeBin,
    {
      platform: "linux",
      getTempFilePath: (name) => path.join(tempRoot, name),
    },
  );
  const second = createOpenCodeProcessEnv(
    { PATH: "/usr/bin" },
    fakeBin,
    {
      platform: "linux",
      getTempFilePath: (name) => path.join(tempRoot, name),
    },
  );

  try {
    const firstShimDir = first.env.PATH.split(path.delimiter)[0];
    const secondShimDir = second.env.PATH.split(path.delimiter)[0];
    const shimParent = path.dirname(firstShimDir);
    assert.notEqual(firstShimDir, secondShimDir);
    assert.equal(path.dirname(secondShimDir), shimParent);
    assert.equal(fs.existsSync(path.join(firstShimDir, "opencode")), true);
    assert.equal(fs.existsSync(path.join(secondShimDir, "opencode")), true);

    first.cleanup();
    assert.equal(fs.existsSync(path.join(firstShimDir, "opencode")), false);
    assert.equal(fs.existsSync(path.join(secondShimDir, "opencode")), true);
    assert.equal(fs.existsSync(shimParent), true);

    second.cleanup();
    assert.equal(fs.existsSync(shimParent), false);
  } finally {
    second.cleanup();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("withOpenCodeProcessEnv launches before another call can overwrite process env", async () => {
  const previousOpenCodeBin = process.env.OPENCODE_BIN;
  const previousPath = process.env.PATH;
  const observed = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-opencode-test-"));
  const firstBin = path.join(tempRoot, "opencode-one");
  const secondBin = path.join(tempRoot, "opencode-two");
  fs.writeFileSync(firstBin, "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(secondBin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(firstBin, 0o755);
  fs.chmodSync(secondBin, 0o755);

  try {
    const first = withOpenCodeProcessEnv(
      { OPENCODE_BIN: firstBin, PATH: "/tmp/one" },
      null,
      () => {
        observed.push({ bin: process.env.OPENCODE_BIN, path: process.env.PATH });
        return new Promise((resolve) => setImmediate(resolve));
      },
    );
    const second = withOpenCodeProcessEnv(
      { OPENCODE_BIN: secondBin, PATH: "/tmp/two" },
      null,
      () => {
        observed.push({ bin: process.env.OPENCODE_BIN, path: process.env.PATH });
        return Promise.resolve();
      },
    );

    await Promise.all([first, second]);

    assert.deepEqual(observed, [
      { bin: firstBin, path: "/tmp/one" },
      { bin: secondBin, path: "/tmp/two" },
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (previousOpenCodeBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousOpenCodeBin;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("withOpenCodeProcessEnv restores process env before async startup settles", async () => {
  const previousOpenCodeBin = process.env.OPENCODE_BIN;
  const previousPath = process.env.PATH;
  let releaseStartup;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-opencode-test-"));
  const fakeBin = path.join(tempRoot, "opencode-starting");
  fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeBin, 0o755);

  try {
    const pending = withOpenCodeProcessEnv(
      { OPENCODE_BIN: fakeBin, PATH: "/tmp/opencode-shim" },
      null,
      () => {
        assert.equal(process.env.OPENCODE_BIN, fakeBin);
        return new Promise((resolve) => { releaseStartup = resolve; });
      },
    );

    assert.equal(process.env.OPENCODE_BIN, previousOpenCodeBin);
    assert.equal(process.env.PATH, previousPath);
    releaseStartup();
    await pending;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (previousOpenCodeBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousOpenCodeBin;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("translateOpenCodeEvent maps text, reasoning, tools, errors, and idle", () => {
  const { events, emitter } = collector();
  const state = {};
  translateOpenCodeEvent(
    { directory: "/tmp", payload: { type: "message.part.updated", properties: { part: { type: "text", id: "p1", text: "hello" }, delta: "he" } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { payload: { type: "message.part.updated", properties: { part: { type: "reasoning", id: "r1", text: "thinking" }, delta: "think" } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { payload: { type: "message.part.updated", properties: { part: { type: "tool", callID: "tool-1", tool: "netcatty_run", state: { status: "running", input: { command: "uptime" } } } } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { payload: { type: "message.part.updated", properties: { part: { type: "tool", callID: "tool-1", tool: "netcatty_run", state: { status: "completed", input: { command: "uptime" }, output: "ok" } } } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { payload: { type: "session.error", properties: { error: { data: { message: "bad key" } } } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } },
    emitter,
    state,
  );

  assert.deepEqual(events, [
    { k: "text", t: "he" },
    { k: "reasoning", d: "think" },
    { k: "toolCall", name: "netcatty_run", args: { command: "uptime" }, id: "tool-1" },
    { k: "toolResult", id: "tool-1", out: "ok", name: "netcatty_run" },
    { k: "error", m: "bad key" },
    { k: "status", m: "OpenCode session idle" },
  ]);
});

test("translateOpenCodeEvent maps OpenCode part delta text and reasoning events", () => {
  const { events, emitter } = collector();
  const state = {};

  assert.equal(
    translateOpenCodeEvent(
      { type: "message.part.delta", properties: { sessionID: "sess-1", messageID: "msg-1", partID: "p1", field: "text", delta: "he" } },
      emitter,
      state,
    ).content,
    true,
  );
  translateOpenCodeEvent(
    { type: "message.part.updated", properties: { part: { type: "text", id: "p1", sessionID: "sess-1", text: "hello" } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { type: "message.part.updated", properties: { part: { type: "reasoning", id: "r1", sessionID: "sess-1", text: "" } } },
    emitter,
    state,
  );
  assert.equal(
    translateOpenCodeEvent(
      { type: "message.part.delta", properties: { sessionID: "sess-1", messageID: "msg-1", partID: "r1", field: "text", delta: "think" } },
      emitter,
      state,
    ).content,
    true,
  );
  translateOpenCodeEvent(
    { type: "message.part.updated", properties: { part: { type: "reasoning", id: "r1", sessionID: "sess-1", text: "thinking" } } },
    emitter,
    state,
  );

  assert.deepEqual(events, [
    { k: "text", t: "he" },
    { k: "text", t: "llo" },
    { k: "reasoning", d: "think" },
    { k: "reasoning", d: "ing" },
  ]);
});

test("translateOpenCodeEvent ignores user message text and delta parts", () => {
  const { events, emitter } = collector();
  const state = {};
  translateOpenCodeEvent(
    { type: "message.updated", properties: { info: { id: "msg-user", role: "user" } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { type: "message.part.updated", properties: { part: { type: "text", id: "p-user", messageID: "msg-user", text: "用户问题" } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { type: "message.part.delta", properties: { messageID: "msg-user", partID: "p-user", field: "text", delta: "?" } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { type: "message.updated", properties: { info: { id: "msg-asst", role: "assistant" } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { type: "message.part.updated", properties: { part: { type: "text", id: "p-asst", messageID: "msg-asst", text: "reply" }, delta: "reply" } },
    emitter,
    state,
  );

  assert.deepEqual(events, [{ k: "text", t: "reply" }]);
});

test("translateOpenCodeEvent also accepts direct OpenCode SDK events", () => {
  const { events, emitter } = collector();
  translateOpenCodeEvent(
    { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "hello" }, delta: "he" } },
    emitter,
  );
  translateOpenCodeEvent(
    { type: "session.idle", properties: { sessionID: "sess-1" } },
    emitter,
  );

  assert.deepEqual(events, [
    { k: "text", t: "he" },
    { k: "status", m: "OpenCode session idle" },
  ]);
});

test("translateOpenCodeEvent emits a tool call before a result when only completion arrives", () => {
  const { events, emitter } = collector();
  translateOpenCodeEvent(
    { type: "message.part.updated", properties: { part: { type: "tool", callID: "tool-1", tool: "netcatty_run", state: { status: "completed", input: { command: "whoami" }, output: "me" } } } },
    emitter,
  );

  assert.deepEqual(events, [
    { k: "toolCall", name: "netcatty_run", args: { command: "whoami" }, id: "tool-1" },
    { k: "toolResult", id: "tool-1", out: "me", name: "netcatty_run" },
  ]);
});

test("mapOpenCodeModels flattens providers", () => {
  assert.deepEqual(mapOpenCodeModels({
    providers: [
      { id: "openai", name: "OpenAI", models: { "gpt-5.1": { name: "GPT-5.1" } } },
      { id: "anthropic", models: { "claude-sonnet": {} } },
    ],
  }), [
    { id: "openai/gpt-5.1", name: "OpenAI GPT-5.1" },
    { id: "anthropic/claude-sonnet", name: "anthropic claude-sonnet" },
  ]);
  assert.deepEqual(mapOpenCodeModels(null), []);
});

test("runOpenCodeTurn ignores events from other OpenCode sessions", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "message.part.updated", properties: { part: { type: "text", sessionID: "other", id: "p0", text: "wrong" }, delta: "wrong" } };
      yield { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "right" }, delta: "right" } };
      yield { type: "session.idle", properties: { sessionID: "sess-1" } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ data: true }),
    },
  };

  await runOpenCodeTurn({
    prompt: "hello",
    emitter,
    abortController,
    openCodeFactory: async () => ({ client, server: { close() {} } }),
  });

  assert.deepEqual(events.filter((event) => event.k === "text"), [
    { k: "text", t: "right" },
  ]);
});

test("runOpenCodeTurn creates a session, streams event deltas, and returns session id", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  let eventController;
  const stream = {
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => { eventController = resolve; });
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", id: "p1", text: "hi" }, delta: "hi" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async (args) => {
        assert.equal(args.query.directory, "/repo");
        return { data: { id: "sess-1" } };
      },
      promptAsync: async (args) => {
        assert.equal(args.path.id, "sess-1");
        assert.deepEqual(args.body.model, { providerID: "openai", modelID: "gpt-5.1" });
        eventController();
        return { data: true };
      },
    },
  };

  const result = await runOpenCodeTurn({
    prompt: "hello",
    cwd: "/repo",
    model: "openai/gpt-5.1",
    emitter,
    abortController,
    openCodeFactory: async () => ({ client, server: { close() {} } }),
  });

  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.deepEqual(events, [
    { k: "sessionId", s: "sess-1" },
    { k: "text", t: "hi" },
    { k: "status", m: "OpenCode session idle" },
    { k: "done" },
  ]);
});

test("runOpenCodeTurn sends Netcatty context via body.system instead of user parts", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", id: "p1", text: "ok" }, delta: "ok" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async (args) => {
        assert.equal(args.body.system, "[Context: You are inside Netcatty.]");
        assert.deepEqual(args.body.parts, [{ type: "text", text: "看看这个机器的配置" }]);
        return { data: true };
      },
    },
  };

  await runOpenCodeTurn({
    prompt: "看看这个机器的配置",
    systemPrompt: "[Context: You are inside Netcatty.]",
    emitter,
    abortController,
    openCodeFactory: async () => ({ client, server: { close() {} } }),
  });

  assert.deepEqual(events.filter((event) => event.k === "text"), [{ k: "text", t: "ok" }]);
});

test("runOpenCodeTurn treats OpenCode part delta events as streamed content", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "message.part.delta", properties: { sessionID: "sess-1", messageID: "msg-1", partID: "p1", field: "text", delta: "hi" } };
      yield { type: "session.idle", properties: { sessionID: "sess-1" } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ data: true }),
    },
  };

  const result = await runOpenCodeTurn({
    prompt: "hello",
    emitter,
    abortController,
    openCodeFactory: async () => ({ client, server: { close() {} } }),
  });

  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.deepEqual(events, [
    { k: "sessionId", s: "sess-1" },
    { k: "text", t: "hi" },
    { k: "status", m: "OpenCode session idle" },
    { k: "done" },
  ]);
});

test("runOpenCodeTurn surfaces promptAsync error results without waiting for events", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  let closeCount = 0;
  let abortCount = 0;
  let iteratorReturnCount = 0;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => new Promise(() => {}),
        return: async () => {
          iteratorReturnCount += 1;
          return { done: true };
        },
      };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ error: { data: { message: "bad model" } } }),
      abort: async () => { abortCount += 1; },
    },
  };

  const result = await Promise.race([
    runOpenCodeTurn({
      prompt: "hello",
      emitter,
      abortController,
      openCodeFactory: async () => ({ client, server: { close() { closeCount += 1; } } }),
    }),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
  ]);

  assert.notEqual(result, "timed-out");
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(events.some((event) => event.k === "error" && event.m === "bad model"), true);
  assert.equal(events.some((event) => event.k === "done"), false);
  assert.equal(abortCount, 1);
  assert.equal(closeCount >= 1, true);
  assert.equal(iteratorReturnCount, 1);
});

test("runOpenCodeTurn returns promptly when aborted while the event stream is quiet", async () => {
  const { events, emitter } = collector();
  const abortController = new AbortController();
  let closeCount = 0;
  let abortCount = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ data: true }),
      abort: async () => { abortCount += 1; },
    },
  };

  const running = runOpenCodeTurn({
    prompt: "hello",
    emitter,
    abortController,
    openCodeFactory: async () => ({ client, server: { close() { closeCount += 1; } } }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  abortController.abort();

  const result = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
  ]);

  assert.notEqual(result, "timed-out");
  assert.deepEqual(result, { sessionId: "sess-1" });
  assert.equal(abortCount, 1);
  assert.equal(closeCount >= 1, true);
  assert.equal(events.some((event) => event.k === "done"), false);
});

test("runOpenCodeTurn passes an explicit non-default port to the OpenCode SDK factory", async () => {
  const { emitter } = collector();
  const abortController = new AbortController();
  let capturedPort;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } };
      yield { type: "session.idle", properties: { sessionID: "sess-1" } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => ({ data: true }),
    },
  };

  await runOpenCodeTurn({
    prompt: "hello",
    emitter,
    abortController,
    openCodeFactory: async (options) => {
      capturedPort = options.port;
      return { client, server: { close() {} } };
    },
  });

  assert.equal(typeof capturedPort, "number");
  assert.notEqual(capturedPort, 4096);
});

test("runOpenCodeTurn waits for the OpenCode event stream before prompting", async () => {
  const { emitter } = collector();
  const abortController = new AbortController();
  let releaseServerConnected;
  let serverConnectedSeen = false;
  const stream = {
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => { releaseServerConnected = resolve; });
      yield { payload: { type: "server.connected", properties: {} } };
      serverConnectedSeen = true;
      yield { payload: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess-1", id: "p1", text: "ok" }, delta: "ok" } } };
      yield { payload: { type: "session.idle", properties: { sessionID: "sess-1" } } };
    },
  };
  const client = {
    global: { event: async () => ({ stream }) },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      promptAsync: async () => {
        assert.equal(serverConnectedSeen, true);
        return { data: true };
      },
    },
  };

  const running = runOpenCodeTurn({
    prompt: "hello",
    model: "openai/gpt-5.1",
    emitter,
    abortController,
    openCodeFactory: async () => ({ client, server: { close() {} } }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  releaseServerConnected();
  const result = await running;

  assert.deepEqual(result, { sessionId: "sess-1" });
});

test("resolveUsableOpenCodeBinPath ignores missing candidates", () => {
  assert.equal(resolveUsableOpenCodeBinPath("/definitely/missing/opencode", { OPENCODE_BIN: "/also/missing" }), undefined);
});

test("createOpenCodeProcessEnv drops stale OPENCODE_BIN when no usable binary exists", () => {
  const { env } = createOpenCodeProcessEnv(
    { OPENCODE_BIN: "/stale/opencode", PATH: "/bin" },
    "/missing/opencode",
  );
  assert.equal(env.OPENCODE_BIN, undefined);
  assert.equal(env.PATH, "/bin");
});

test("createOpenCodeProcessEnv prefers an existing opencode binary", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-opencode-test-"));
  const fakeBin = path.join(tempRoot, "my-opencode-wrapper");
  fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeBin, 0o755);

  const { env, cleanup } = createOpenCodeProcessEnv(
    { OPENCODE_BIN: "/stale/opencode", PATH: "/bin" },
    fakeBin,
  );
  try {
    assert.equal(env.OPENCODE_BIN, fakeBin);
    assert.match(env.PATH, /opencode-sdk-shim/);
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("listOpenCodeModels passes an explicit non-default port to the OpenCode SDK factory", async () => {
  resetOpenCodeListServerPool();
  let capturedPort;
  const models = await listOpenCodeModels({
    binPath: "/tmp/opencode-port-test",
    openCodeFactory: async (options) => {
      capturedPort = options.port;
      return {
        client: { config: { providers: async () => ({ providers: [], default: { openai: "gpt-5.1" } }) } },
        server: { close() {} },
      };
    },
  });

  assert.deepEqual(models, { currentModelId: "openai/gpt-5.1", models: [] });
  assert.equal(typeof capturedPort, "number");
  assert.notEqual(capturedPort, 4096);
  resetOpenCodeListServerPool();
});

test("listOpenCodeModels aborts a hanging providers() call and tears down the pooled server", async () => {
  resetOpenCodeListServerPool();
  const abortController = new AbortController();
  let closeCount = 0;
  let sawAbortSignal = false;
  let releaseProviders;

  const running = listOpenCodeModels({
    binPath: "/tmp/opencode-abort-test",
    signal: abortController.signal,
    openCodeFactory: async (options) => {
      sawAbortSignal = Boolean(options.signal);
      return {
        client: {
          config: {
            providers: () => new Promise((resolve) => {
              releaseProviders = resolve;
            }),
          },
        },
        server: {
          close() { closeCount += 1; },
        },
      };
    },
  });

  // Let the factory settle, then abort while providers() is pending.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  abortController.abort(new Error("list-models timed out"));
  const models = await running;
  assert.deepEqual(models, { currentModelId: null, models: [] });
  assert.equal(sawAbortSignal, true);

  // Release schedules a short idle close; force dispose for a deterministic assert.
  resetOpenCodeListServerPool();
  assert.equal(closeCount, 1);

  // Unblock any leftover resolver so the test process can exit cleanly.
  releaseProviders?.({ providers: [], default: {} });
});

test("listOpenCodeModels reuses one pooled OpenCode server for concurrent loads", async () => {
  resetOpenCodeListServerPool();
  let createCount = 0;
  let closeCount = 0;
  let releaseProviders;
  const providersGate = new Promise((resolve) => { releaseProviders = resolve; });

  const openCodeFactory = async () => {
    createCount += 1;
    return {
      client: {
        config: {
          providers: async () => providersGate,
        },
      },
      server: {
        close() { closeCount += 1; },
      },
    };
  };

  const first = listOpenCodeModels({
    binPath: "/tmp/opencode-pool-test",
    openCodeFactory,
  });
  const second = listOpenCodeModels({
    binPath: "/tmp/opencode-pool-test",
    openCodeFactory,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCount, 1);

  releaseProviders({
    providers: [],
    default: { openai: "gpt-5.1" },
  });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { currentModelId: "openai/gpt-5.1", models: [] });
  assert.deepEqual(b, { currentModelId: "openai/gpt-5.1", models: [] });
  assert.equal(createCount, 1);

  resetOpenCodeListServerPool();
  assert.equal(closeCount, 1);
  assert.ok(OPENCODE_LIST_SERVER_IDLE_MS >= 0);
});

test("listOpenCodeModels returns empty immediately when already aborted", async () => {
  resetOpenCodeListServerPool();
  let createCount = 0;
  const abortController = new AbortController();
  abortController.abort(new Error("pre-aborted"));
  const models = await listOpenCodeModels({
    binPath: "/tmp/opencode-preabort-test",
    signal: abortController.signal,
    openCodeFactory: async () => {
      createCount += 1;
      return {
        client: { config: { providers: async () => ({ providers: [] }) } },
        server: { close() {} },
      };
    },
  });
  assert.deepEqual(models, { currentModelId: null, models: [] });
  assert.equal(createCount, 0);
  resetOpenCodeListServerPool();
});

test("listOpenCodeModels does not share a pooled server across different catalog env", async () => {
  resetOpenCodeListServerPool();
  let createCount = 0;
  const openCodeFactory = async () => {
    createCount += 1;
    const id = createCount;
    return {
      client: {
        config: {
          providers: async () => ({
            providers: [],
            default: { openai: `profile-${id}` },
          }),
        },
      },
      server: { close() {} },
    };
  };

  const first = await listOpenCodeModels({
    binPath: "/tmp/opencode-env-pool",
    env: { HOME: "/Users/a", OPENCODE_CONFIG_DIR: "/a/config" },
    openCodeFactory,
  });
  const second = await listOpenCodeModels({
    binPath: "/tmp/opencode-env-pool",
    env: { HOME: "/Users/b", OPENCODE_CONFIG_DIR: "/b/config" },
    openCodeFactory,
  });

  assert.equal(createCount, 2);
  assert.deepEqual(first, { currentModelId: "openai/profile-1", models: [] });
  assert.deepEqual(second, { currentModelId: "openai/profile-2", models: [] });
  resetOpenCodeListServerPool();
});

test("classifyOpenCodeSpawnError recognizes missing opencode CLI", () => {
  assert.equal(classifyOpenCodeSpawnError(Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" })).isSpawnEnoent, true);
  assert.equal(classifyOpenCodeSpawnError(new Error("other")).isSpawnEnoent, false);
});

test("normalizeOpenCodeQuestions maps options and custom answers into UI shape", () => {
  assert.deepEqual(normalizeOpenCodeQuestions([
    {
      header: "Mode",
      question: "Which mode?",
      custom: true,
      options: [{ label: "Safe", description: "Read-only" }],
    },
    {
      id: "keep-me",
      question: "Free text?",
      options: [],
    },
  ]), [
    {
      id: "q0",
      header: "Mode",
      question: "Which mode?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Safe", description: "Read-only" }],
    },
    {
      id: "keep-me",
      header: "",
      question: "Free text?",
      isOther: false,
      isSecret: false,
      options: null,
    },
  ]);
});

test("answersRecordToOpenCodeAnswers preserves question order for the reply API", () => {
  assert.deepEqual(answersRecordToOpenCodeAnswers(
    [{ id: "q0" }, { id: "q1" }],
    { q1: { answers: ["second"] }, q0: { answers: ["first", "also"] } },
  ), [["first", "also"], ["second"]]);
  assert.deepEqual(answersRecordToOpenCodeAnswers([{ id: "q0" }], {}), [[]]);
});

test("buildOpenCodeQuestionReplyUrl targets the session-local reply endpoint", () => {
  assert.equal(
    buildOpenCodeQuestionReplyUrl({
      baseUrl: "http://127.0.0.1:4096/",
      requestId: "req/1",
      directory: "/tmp/proj",
      action: "reply",
    }),
    "http://127.0.0.1:4096/question/req%2F1/reply?directory=%2Ftmp%2Fproj",
  );
  assert.equal(
    buildOpenCodeQuestionReplyUrl({
      baseUrl: "http://127.0.0.1:4096",
      requestId: "req-2",
      action: "reject",
    }),
    "http://127.0.0.1:4096/question/req-2/reject",
  );
});

test("translateOpenCodeEvent surfaces question.asked and question.v2.asked for the UI bridge", () => {
  const { events, emitter } = collector();
  const state = {};
  const asked = translateOpenCodeEvent(
    {
      payload: {
        type: "question.asked",
        properties: {
          id: "req-1",
          sessionID: "sess-1",
          questions: [{ header: "Pick", question: "Continue?", options: [{ label: "Yes", description: "" }] }],
          tool: { messageID: "m1", callID: "c1" },
        },
      },
    },
    emitter,
    state,
  );
  const askedV2 = translateOpenCodeEvent(
    {
      type: "question.v2.asked",
      properties: {
        id: "req-2",
        sessionID: "sess-1",
        questions: [{ header: "V2", question: "Ready?", options: [] }],
      },
    },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { payload: { type: "question.replied", properties: { sessionID: "sess-1", requestID: "req-1", answers: [["Yes"]] } } },
    emitter,
    state,
  );
  translateOpenCodeEvent(
    { payload: { type: "question.v2.rejected", properties: { sessionID: "sess-1", requestID: "req-2" } } },
    emitter,
    state,
  );

  assert.equal(asked.content, true);
  assert.equal(askedV2.content, true);
  assert.deepEqual(events, [
    {
      k: "questionAsk",
      payload: {
        requestId: "req-1",
        sessionId: "sess-1",
        questions: [{ header: "Pick", question: "Continue?", options: [{ label: "Yes", description: "" }] }],
        tool: { messageID: "m1", callID: "c1" },
      },
    },
    {
      k: "questionAsk",
      payload: {
        requestId: "req-2",
        sessionId: "sess-1",
        questions: [{ header: "V2", question: "Ready?", options: [] }],
        tool: undefined,
      },
    },
    { k: "questionSettled", payload: { requestId: "req-1", sessionId: "sess-1", status: "replied" } },
    { k: "questionSettled", payload: { requestId: "req-2", sessionId: "sess-1", status: "rejected" } },
  ]);
});

test("translateOpenCodeEvent does not emit a stuck spinner tool-call for question tools", () => {
  const { events, emitter } = collector();
  translateOpenCodeEvent(
    {
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            callID: "q-call",
            tool: "question",
            state: {
              status: "running",
              input: { questions: [{ question: "Choose", header: "A", options: [] }] },
            },
          },
        },
      },
    },
    emitter,
    {},
  );
  assert.deepEqual(events, []);
});
