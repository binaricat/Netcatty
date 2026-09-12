const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { prepareCommandForSpawn } = require("./ai/shellUtils.cjs");
const {
  isCodexAuthError: realIsCodexAuthError,
  normalizeCodexIntegrationState: realNormalizeCodexIntegrationState,
} = require("./ai/codexHelpers.cjs");

function createIpcMainStub() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

function loadBridgeWithMocks(options = {}) {
  const mocks = {
    "./mcpServerBridge.cjs": {
      init() {},
      setMainWindowGetter() {},
      setVaultAgentInvoker() {},
      getOrCreateHost: async () => 4010,
      getScopedSessionIds: () => [],
      buildMcpServerConfig: () => ({ name: "netcatty-remote-hosts", type: "http", url: "http://127.0.0.1:4010" }),
      getPermissionMode: () =>
        typeof options.getPermissionMode === "function"
          ? options.getPermissionMode()
          : "default",
      getMaxIterations: () => 20,
      setCommandTimeout: (...args) => {
        if (typeof options.setCommandTimeout === "function") options.setCommandTimeout(...args);
      },
      updateAttachmentMetadata: (...args) => {
        if (typeof options.updateAttachmentMetadata === "function") options.updateAttachmentMetadata(...args);
      },
      setChatSessionCancelled() {},
      cancelPtyExecsForSession() {},
      clearPendingApprovals() {},
      cleanupScopedMetadata: async () => {},
      cleanup() {},
    },
    "../cli/discoveryPath.cjs": {
      getCliLauncherPath: () => "/tmp/netcatty-tool-cli",
      TOOL_CLI_DISCOVERY_ENV_VAR: "NETCATTY_TOOL_CLI_DISCOVERY_FILE",
    },
    "./ai/userSkills.cjs": {
      scanUserSkills: async () => ({ readyCount: 0, warningCount: 0, skills: [], warnings: [] }),
      buildUserSkillsContext: async () => ({ context: "", selectedSkills: [] }),
      toPublicUserSkillsStatus: (value) => value,
    },
    "./ai/shellUtils.cjs": {
      stripAnsi: (value) => value,
      normalizeCliPathForPlatform: (...args) =>
        typeof options.normalizeCliPathForPlatform === "function"
          ? options.normalizeCliPathForPlatform(...args)
          : args[0],
      shouldUseShellForCommand: () => false,
      prepareCommandForSpawn: (...args) =>
        typeof options.prepareCommandForSpawn === "function"
          ? options.prepareCommandForSpawn(...args)
          : prepareCommandForSpawn(...args),
      normalizeClaudeCodeExecutableEnvForSdk: (env) =>
        typeof options.normalizeClaudeCodeExecutableEnvForSdk === "function"
          ? options.normalizeClaudeCodeExecutableEnvForSdk(env)
          : env,
      isPlausibleCliVersionOutput: (value) =>
        typeof options.isPlausibleCliVersionOutput === "function"
          ? options.isPlausibleCliVersionOutput(value)
          : true,
      resolveCliFromPath: (...args) =>
        typeof options.resolveCliFromPath === "function"
          ? options.resolveCliFromPath(...args)
          : null,
      resolveCliFromPathAsync: async (...args) =>
        typeof options.resolveCliFromPathAsync === "function"
          ? options.resolveCliFromPathAsync(...args)
          : typeof options.resolveCliFromPath === "function"
            ? options.resolveCliFromPath(...args)
            : null,
      resolveSdkBinPath: (...args) =>
        typeof options.resolveSdkBinPath === "function"
          ? options.resolveSdkBinPath(...args)
          : null,
      resolveSdkBinPathAsync: async (...args) =>
        typeof options.resolveSdkBinPathAsync === "function"
          ? options.resolveSdkBinPathAsync(...args)
          : typeof options.resolveSdkBinPath === "function"
            ? options.resolveSdkBinPath(...args)
            : null,
      getShellEnv: async () => (
        typeof options.shellEnv === "function"
          ? options.shellEnv()
          : options.shellEnv || {}
      ),
      invalidateShellEnvCache: () => {
        if (typeof options.invalidateShellEnvCache === "function") options.invalidateShellEnvCache();
      },
      toUnpackedAsarPath: (value) => value,
    },
    "./ai/codexHelpers.cjs": {
      codexLoginSessions: new Map(),
      appendCodexLoginOutput() {},
      toCodexLoginSessionResponse: (session) => ({ sessionId: session.id, codexPath: session.codexPath }),
      getActiveCodexLoginSession: () =>
        typeof options.getActiveCodexLoginSession === "function"
          ? options.getActiveCodexLoginSession()
          : null,
      normalizeCodexIntegrationState: (...args) =>
        typeof options.normalizeCodexIntegrationState === "function"
          ? options.normalizeCodexIntegrationState(...args)
          : realNormalizeCodexIntegrationState(...args),
      appendCodexChatGptValidationFailure: (rawOutput, validationError) =>
        `${rawOutput}\n\nChatGPT auth validation failed:\n${validationError}`.trim(),
      readCodexCustomProviderConfig: () => null,
      getCodexCustomConfigPreflightError: () => null,
      extractCodexError: (err) => ({ message: err?.message || String(err) }),
      isCodexAuthError: (...args) =>
        typeof options.isCodexAuthError === "function"
          ? options.isCodexAuthError(...args)
          : realIsCodexAuthError(...args),
      getCodexAuthFingerprint: (...args) =>
        typeof options.getCodexAuthFingerprint === "function"
          ? options.getCodexAuthFingerprint(...args)
          : "auth-fingerprint",
      getCodexMcpFingerprint: () => "mcp-fingerprint",
      invalidateCodexValidationCache() {},
      getCodexValidationCache: () => null,
      setCodexValidationCache() {},
    },
    "./aiBridge/agentAuthProbes.cjs": {
      probeClaudeAuth: (...args) =>
        typeof options.probeClaudeAuth === "function" ? options.probeClaudeAuth(...args) : { authenticated: false, authSource: null },
      probeCopilotAuth: (...args) =>
        typeof options.probeCopilotAuth === "function" ? options.probeCopilotAuth(...args) : { authenticated: false, authSource: null },
      probeCodexAuth: (...args) =>
        typeof options.probeCodexAuth === "function" ? options.probeCodexAuth(...args) : { authenticated: false, authSource: null },
      probeCodebuddyAuth: (...args) =>
        typeof options.probeCodebuddyAuth === "function"
          ? options.probeCodebuddyAuth(...args)
          : { authenticated: false, authSource: null },
      probeCursorCliAuth: (...args) =>
        typeof options.probeCursorCliAuth === "function"
          ? options.probeCursorCliAuth(...args)
          : { authenticated: false, authSource: null, email: null, binPath: null },
      probeGrokAuth: (...args) =>
        typeof options.probeGrokAuth === "function"
          ? options.probeGrokAuth(...args)
          : { authenticated: false, authSource: null },
    },
    "./ai/ptyExec.cjs": {
      execViaPty: async () => {
        throw new Error("execViaPty should not be called in this test");
      },
    },
    "./ipcUtils.cjs": {
      safeSend: (...args) => {
        if (typeof options.safeSend === "function") options.safeSend(...args);
      },
    },
    "./windowManager.cjs": {
      getMainWindow() {
        return {
          isDestroyed: () => false,
          webContents: { id: 1 },
        };
      },
      getSettingsWindow() {
        return null;
      },
    },
  };
  if (typeof options.registerSdkStreamHandlers === "function") {
    mocks["./aiBridge/sdk/sdkStreamHandlers.cjs"] = {
      registerSdkStreamHandlers: options.registerSdkStreamHandlers,
    };
  }

  const bridgePath = require.resolve("./aiBridge.cjs");
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[bridgePath];

  try {
    const bridge = require("./aiBridge.cjs");
    return {
      bridge,
      restore() {
        try {
          bridge.cleanup();
        } finally {
          delete require.cache[bridgePath];
          Module._load = originalLoad;
        }
      },
    };
  } catch (error) {
    delete require.cache[bridgePath];
    Module._load = originalLoad;
    throw error;
  }
}

test("cleanup closes persistent CodeBuddy sessions", () => {
  let codebuddyCloseCalls = 0;
  let codexCloseCalls = 0;
  let sdkAbortCalls = 0;
  const { bridge, restore } = loadBridgeWithMocks({
    registerSdkStreamHandlers: (context) => {
      context.sdkActiveStreams = new Map([
        ["request-1", { abort: () => { sdkAbortCalls += 1; } }],
      ]);
      context.codexAppServerRuntime = {
        close: () => { codexCloseCalls += 1; },
      };
      context.codebuddySessionManager = {
        closeAll: () => { codebuddyCloseCalls += 1; },
      };
    },
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    bridge.cleanup();
    assert.equal(sdkAbortCalls, 1);
    assert.equal(codexCloseCalls, 1);
    assert.equal(codebuddyCloseCalls, 1);
  } finally {
    restore();
  }
});

test("non-2xx streaming responses are bounded and actively terminated", async () => {
  let requestClosed = false;
  let resolveRequestClosed;
  const requestClosedPromise = new Promise((resolve) => { resolveRequestClosed = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    const interval = setInterval(() => response.write("abcdefgh"), 2);
    response.on("close", () => {
      clearInterval(interval);
      requestClosed = true;
      resolveRequestClosed();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const { bridge, restore } = loadBridgeWithMocks();
  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() }, session: {} },
  });

  try {
    await assert.rejects(
      () => bridge._streamRequestForTests(
        `http://127.0.0.1:${address.port}/streaming-error`,
        {
          method: "GET",
          maxErrorBodyBytes: 32,
          totalTimeoutMs: 1_000,
        },
        { sender: { id: 1 } },
        "streaming-error",
        false,
      ),
      /error response exceeded/i,
    );
    await Promise.race([
      requestClosedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server request stayed open")), 500)),
    ]);
    assert.equal(requestClosed, true);
    assert.equal(bridge._getActiveStreamCountForTests(), 0);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AI stream default total timeout is long enough for extended reasoning", () => {
  const { bridge, restore } = loadBridgeWithMocks();
  try {
    assert.equal(bridge.DEFAULT_AI_STREAM_IDLE_TIMEOUT_MS, 120_000);
    assert.equal(bridge.DEFAULT_AI_STREAM_TOTAL_TIMEOUT_MS, 30 * 60 * 1000);
    assert.ok(bridge.DEFAULT_AI_STREAM_TOTAL_TIMEOUT_MS > bridge.DEFAULT_AI_STREAM_IDLE_TIMEOUT_MS);
  } finally {
    restore();
  }
});

test("AI stream total timeout never undercuts the configured idle timeout", () => {
  const { bridge, restore } = loadBridgeWithMocks();
  try {
    const timeouts = bridge._resolveAIStreamTimeoutsForTests({
      idleTimeoutMs: 60 * 60 * 1000,
      totalTimeoutMs: 30 * 60 * 1000,
    });
    assert.equal(timeouts.idleTimeoutMs, 60 * 60 * 1000);
    assert.ok(timeouts.totalTimeoutMs > timeouts.idleTimeoutMs);
  } finally {
    restore();
  }
});

test("streaming requests enforce a total deadline even while bytes keep arriving", async () => {
  let requestClosed = false;
  let resolveRequestClosed;
  const requestClosedPromise = new Promise((resolve) => { resolveRequestClosed = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    const interval = setInterval(() => response.write("x"), 2);
    response.on("close", () => {
      clearInterval(interval);
      requestClosed = true;
      resolveRequestClosed();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const { bridge, restore } = loadBridgeWithMocks();
  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() }, session: {} },
  });

  try {
    await assert.rejects(
      () => bridge._streamRequestForTests(
        `http://127.0.0.1:${address.port}/never-ending`,
        {
          method: "GET",
          maxErrorBodyBytes: 1024 * 1024,
          totalTimeoutMs: 30,
        },
        { sender: { id: 1 } },
        "never-ending",
        false,
      ),
      /total deadline exceeded/i,
    );
    await Promise.race([
      requestClosedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server request stayed open")), 500)),
    ]);
    assert.equal(requestClosed, true);
    assert.equal(bridge._getActiveStreamCountForTests(), 0);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("streaming requests do not abort active thinking output at the idle deadline", async () => {
  let requestClosed = false;
  let resolveRequestClosed;
  const requestClosedPromise = new Promise((resolve) => { resolveRequestClosed = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const interval = setInterval(() => {
      n += 1;
      response.write(`data:{"choices":[{"delta":{"reasoning_content":"${n}"}}]}\n`);
      if (n >= 6) {
        clearInterval(interval);
        response.end("data:[DONE]\n\n");
      }
    }, 25);
    response.on("close", () => {
      clearInterval(interval);
      requestClosed = true;
      resolveRequestClosed();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const sentEvents = [];
  const { bridge, restore } = loadBridgeWithMocks({
    safeSend: (_sender, channel, payload) => {
      sentEvents.push({ channel, payload });
    },
  });
  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() }, session: {} },
  });

  try {
    const result = await bridge._streamRequestForTests(
      `http://127.0.0.1:${address.port}/thinking`,
      {
        method: "GET",
        idleTimeoutMs: 80,
        totalTimeoutMs: 2_000,
      },
      { sender: { id: 1 } },
      "thinking",
      false,
    );
    assert.equal(result.statusCode, 200);
    await Promise.race([
      new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (sentEvents.some(({ channel }) => channel === "netcatty:ai:stream:end")) {
            resolve();
            return;
          }
          const errorEvent = sentEvents.find(({ channel }) => channel === "netcatty:ai:stream:error");
          if (errorEvent) {
            reject(new Error(errorEvent.payload.error));
            return;
          }
          if (Date.now() - started > 1_500) {
            reject(new Error("thinking stream never finished"));
            return;
          }
          setTimeout(poll, 10);
        };
        poll();
      }),
    ]);
    await Promise.race([
      requestClosedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server request stayed open")), 500)),
    ]);
    assert.equal(requestClosed, true);
    assert.equal(bridge._getActiveStreamCountForTests(), 0);
    assert.equal(
      sentEvents.some(({ channel }) => channel === "netcatty:ai:stream:error"),
      false,
    );
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("streaming requests abort after the idle deadline when no more bytes arrive", async () => {
  let requestClosed = false;
  let resolveRequestClosed;
  const requestClosedPromise = new Promise((resolve) => { resolveRequestClosed = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data:{"choices":[{"delta":{"reasoning_content":"start"}}]}\n');
    response.on("close", () => {
      requestClosed = true;
      resolveRequestClosed();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const sentEvents = [];
  const { bridge, restore } = loadBridgeWithMocks({
    safeSend: (_sender, channel, payload) => {
      sentEvents.push({ channel, payload });
    },
  });
  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() }, session: {} },
  });

  try {
    const result = await bridge._streamRequestForTests(
      `http://127.0.0.1:${address.port}/stalled`,
      {
        method: "GET",
        idleTimeoutMs: 40,
        totalTimeoutMs: 2_000,
      },
      { sender: { id: 1 } },
      "stalled",
      false,
    );
    assert.equal(result.statusCode, 200);
    await Promise.race([
      new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          const errorEvent = sentEvents.find(({ channel }) => channel === "netcatty:ai:stream:error");
          if (errorEvent) {
            resolve(errorEvent.payload.error);
            return;
          }
          if (Date.now() - started > 1_000) {
            reject(new Error("stalled stream was not aborted"));
            return;
          }
          setTimeout(poll, 10);
        };
        poll();
      }).then((error) => {
        assert.match(error, /idle deadline exceeded/i);
      }),
    ]);
    await Promise.race([
      requestClosedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server request stayed open")), 500)),
    ]);
    assert.equal(requestClosed, true);
    assert.equal(bridge._getActiveStreamCountForTests(), 0);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("streaming chat handler forwards the configured idle deadline", { timeout: 5_000 }, async (t) => {
  const sentEvents = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data:{"choices":[{"delta":{"content":"start"}}]}\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { bridge, restore } = loadBridgeWithMocks({
    safeSend: (_sender, channel, payload) => sentEvents.push({ channel, payload }),
  });
  t.after(restore);
  const ipcMain = createIpcMainStub();
  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() }, session: {} },
  });
  bridge.registerHandlers(ipcMain);

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const sender = { id: 1 };
  await ipcMain.handlers.get("netcatty:ai:sync-providers")(
    { sender },
    { providers: [{ id: "custom-idle", baseURL }] },
  );

  const result = await ipcMain.handlers.get("netcatty:ai:chat:stream")(
    { sender },
    {
      requestId: "custom-idle-request",
      url: `${baseURL}/v1/chat/completions`,
      headers: { "content-type": "application/json" },
      body: '{"stream":true}',
      providerId: "custom-idle",
      idleTimeoutMs: 40,
    },
  );
  assert.equal(result.ok, true);

  const error = await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const event = sentEvents.find(({ channel }) => channel === "netcatty:ai:stream:error");
      if (event) {
        resolve(event.payload.error);
        return;
      }
      if (Date.now() - started > 1_000) {
        reject(new Error("configured stream idle deadline was not forwarded"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
  assert.match(error, /idle deadline exceeded|request timeout/i);
});

test("mcp attachment update handler forwards current chat attachments", async () => {
  const calls = [];
  const { bridge, restore } = loadBridgeWithMocks({
    updateAttachmentMetadata: (attachments, chatSessionId) => calls.push({ attachments, chatSessionId }),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const updateAttachments = ipcMain.handlers.get("netcatty:ai:mcp:update-attachments");
    assert.equal(typeof updateAttachments, "function");
    const attachments = [{
      filename: "hosts_export_2026-06-25.csv",
      mediaType: "text/csv",
      base64Data: Buffer.from("label,hostname\nprod,prod.example.com\n").toString("base64"),
      filePath: "/tmp/hosts_export_2026-06-25.csv",
    }];

    const result = await updateAttachments({ sender: { id: 1 } }, {
      attachments,
      chatSessionId: "chat-1",
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [{ attachments, chatSessionId: "chat-1" }]);
  } finally {
    restore();
  }
});

test("command timeout handler accepts one-day timeout values", async () => {
  const calls = [];
  const { bridge, restore } = loadBridgeWithMocks({
    setCommandTimeout: (value) => calls.push(value),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const setCommandTimeout = ipcMain.handlers.get("netcatty:ai:mcp:set-command-timeout");
    assert.equal(typeof setCommandTimeout, "function");

    const result = await setCommandTimeout({ sender: { id: 1 } }, { timeout: 86_400 });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [86_400]);
  } finally {
    restore();
  }
});

test("streaming AI responses preserve UTF-8 characters split across network chunks", { timeout: 5_000 }, async (t) => {
  const sentEvents = [];
  let handleStreamEvent = () => {};
  const { bridge, restore } = loadBridgeWithMocks({
    safeSend: (_sender, channel, payload) => {
      sentEvents.push({ channel, payload });
      handleStreamEvent(channel, payload);
    },
  });
  const ipcMain = createIpcMainStub();
  const server = require("node:http").createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const message = Buffer.from('data: {"choices":[{"delta":{"content":"环境正常"}}]}\n\n');
      const splitAt = message.indexOf(Buffer.from("环")) + 1;
      res.write(message.subarray(0, splitAt));
      setImmediate(() => res.end(message.subarray(splitAt)));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseURL = `http://127.0.0.1:${address.port}`;
    const sender = { id: 1 };
    await ipcMain.handlers.get("netcatty:ai:sync-providers")(
      { sender },
      { providers: [{ id: "split-utf8", baseURL }] },
    );

    const streamFinished = new Promise((resolve, reject) => {
      handleStreamEvent = (channel, payload) => {
        if (channel === "netcatty:ai:stream:end") resolve();
        else if (channel === "netcatty:ai:stream:error") reject(new Error(payload.error));
      };
    });

    const result = await ipcMain.handlers.get("netcatty:ai:chat:stream")(
      { sender },
      {
        requestId: "split-utf8-request",
        url: `${baseURL}/v1/chat/completions`,
        headers: { "content-type": "application/json" },
        body: '{"stream":true}',
        providerId: "split-utf8",
      },
    );
    await streamFinished;

    assert.equal(result.ok, true);
    const dataEvent = sentEvents.find(({ channel }) => channel === "netcatty:ai:stream:data");
    assert.equal(dataEvent?.payload.data, '{"choices":[{"delta":{"content":"环境正常"}}]}');
  } finally {
    restore();
  }
});

test("streaming AI responses accept SSE data: lines without a space after the colon", { timeout: 5_000 }, async (t) => {
  const sentEvents = [];
  let handleStreamEvent = () => {};
  const { bridge, restore } = loadBridgeWithMocks({
    safeSend: (_sender, channel, payload) => {
      sentEvents.push({ channel, payload });
      handleStreamEvent(channel, payload);
    },
  });
  const ipcMain = createIpcMainStub();
  const server = require("node:http").createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Older AxonHub 0.9 emits `data:{json}` with no space (issue #3020).
      res.end('data:{"choices":[{"delta":{"content":"hello"}}]}\ndata:[DONE]\n\n');
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseURL = `http://127.0.0.1:${address.port}`;
    const sender = { id: 1 };
    await ipcMain.handlers.get("netcatty:ai:sync-providers")(
      { sender },
      { providers: [{ id: "axonhub-legacy", baseURL }] },
    );

    const streamFinished = new Promise((resolve, reject) => {
      handleStreamEvent = (channel, payload) => {
        if (channel === "netcatty:ai:stream:end") resolve();
        else if (channel === "netcatty:ai:stream:error") reject(new Error(payload.error));
      };
    });

    const result = await ipcMain.handlers.get("netcatty:ai:chat:stream")(
      { sender },
      {
        requestId: "axonhub-legacy-request",
        url: `${baseURL}/v1/chat/completions`,
        headers: { "content-type": "application/json" },
        body: '{"stream":true}',
        providerId: "axonhub-legacy",
      },
    );
    await streamFinished;

    assert.equal(result.ok, true);
    const dataEvents = sentEvents
      .filter(({ channel }) => channel === "netcatty:ai:stream:data")
      .map(({ payload }) => payload.data);
    assert.deepEqual(dataEvents, [
      '{"choices":[{"delta":{"content":"hello"}}]}',
      "[DONE]",
    ]);
  } finally {
    restore();
  }
});

test("streaming AI responses flush a trailing data: line that has no space and no newline", { timeout: 5_000 }, async (t) => {
  const sentEvents = [];
  let handleStreamEvent = () => {};
  const { bridge, restore } = loadBridgeWithMocks({
    safeSend: (_sender, channel, payload) => {
      sentEvents.push({ channel, payload });
      handleStreamEvent(channel, payload);
    },
  });
  const ipcMain = createIpcMainStub();
  const server = require("node:http").createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data:{"choices":[{"delta":{"content":"tail"}}]}');
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseURL = `http://127.0.0.1:${address.port}`;
    const sender = { id: 1 };
    await ipcMain.handlers.get("netcatty:ai:sync-providers")(
      { sender },
      { providers: [{ id: "flush-no-space", baseURL }] },
    );

    const streamFinished = new Promise((resolve, reject) => {
      handleStreamEvent = (channel, payload) => {
        if (channel === "netcatty:ai:stream:end") resolve();
        else if (channel === "netcatty:ai:stream:error") reject(new Error(payload.error));
      };
    });

    const result = await ipcMain.handlers.get("netcatty:ai:chat:stream")(
      { sender },
      {
        requestId: "flush-no-space-request",
        url: `${baseURL}/v1/chat/completions`,
        headers: { "content-type": "application/json" },
        body: '{"stream":true}',
        providerId: "flush-no-space",
      },
    );
    await streamFinished;

    assert.equal(result.ok, true);
    const dataEvent = sentEvents.find(({ channel }) => channel === "netcatty:ai:stream:data");
    assert.equal(dataEvent?.payload.data, '{"choices":[{"delta":{"content":"tail"}}]}');
  } finally {
    restore();
  }
});

test("discover returns the 3-layer contract for an installed, authenticated agent", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-discover-contract-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const claudePath = path.join(tempDir, process.platform === "win32" ? "claude.cmd" : "claude");
  fs.writeFileSync(
    claudePath,
    process.platform === "win32" ? "@echo off\r\necho 1.2.3 (Claude Code)\r\n" : "#!/bin/sh\necho '1.2.3 (Claude Code)'\n",
    { mode: 0o755 },
  );

  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: (cmd) => (cmd === "claude" ? claudePath : null),
    isPlausibleCliVersionOutput: () => true,
    probeClaudeAuth: () => ({ authenticated: true, authSource: "env" }),
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const discover = ipcMain.handlers.get("netcatty:ai:agents:discover");
    assert.equal(typeof discover, "function");
    const agents = await discover({ sender: { id: 1 } });
    const claude = agents.find((agent) => agent.command === "claude");
    assert.ok(claude);
    assert.equal(claude.sdkBackend, "claude");
    assert.equal(claude.binPath, claudePath);
    assert.equal(claude.path, claudePath);
    assert.equal(claude.installed, true);
    assert.equal(claude.available, true);
    assert.equal(claude.authenticated, true);
    assert.equal(claude.authSource, "env");
  } finally {
    restore();
  }
});

test("resolve-cli does not fall back to PATH when a custom path is invalid", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: () => null,
    resolveCliFromPath: (command) => (command === "codex" ? "/usr/local/bin/codex" : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, {
      command: "codex",
      customPath: "/missing/codex",
      refreshShellEnv: true,
    });

    assert.equal(result.path, null);
    assert.equal(result.available, false);
    assert.equal(result.installed, false);
  } finally {
    restore();
  }
});

test("codex login does not reuse an active session from a different resolved path", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPathAsync: (command) => (command === "codex" ? "/usr/bin/codex" : null),
    getActiveCodexLoginSession: () => ({
      id: "codex_login_custom",
      state: "running",
      process: { killed: false },
      codexPath: "/custom/codex",
    }),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const startLogin = ipcMain.handlers.get("netcatty:ai:codex:start-login");
    const result = await startLogin({ sender: { id: 1 } }, {});

    assert.equal(result.ok, false);
    assert.match(result.error, /different CLI path/);
  } finally {
    restore();
  }
});

test("codex integration keeps ChatGPT connected when the SDK validation probe fails", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-integration-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, "codex");
  fs.writeFileSync(
    codexPath,
    `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`,
    { mode: 0o755 },
  );

  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: (value) => value,
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const handler = ipcMain.handlers.get("netcatty:ai:codex:get-integration");
    assert.equal(typeof handler, "function");

    const result = await handler({ sender: { id: 1 } }, {
      codexPath,
      validateChatGptAuth: true,
    });

    assert.equal(result.state, "connected_chatgpt", JSON.stringify(result));
    assert.equal(result.isConnected, true);
    assert.match(result.rawOutput, /Logged in using ChatGPT/);
    assert.match(result.rawOutput, /ChatGPT auth validation failed:/);
  } finally {
    restore();
  }
});

test("resolve-cli probes Windows cmd paths with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty codex resolve "));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const codexPath = path.join(tempDir, "codex.cmd");
  fs.writeFileSync(
    codexPath,
    "@echo off\r\necho codex-cli 1.2.3\r\n",
    "utf8",
  );

  const { bridge, restore } = loadBridgeWithMocks({
    prepareCommandForSpawn,
    resolveCliFromPath: (command) => (command === "codex" ? codexPath : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveHandler = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    assert.equal(typeof resolveHandler, "function");

    const result = await resolveHandler({ sender: { id: 1 } }, { command: "codex", customPath: "" });

    assert.deepEqual(result, {
      path: codexPath,
      binPath: codexPath,
      version: "codex-cli 1.2.3",
      available: true,
      installed: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli probes Windows Claude cmd paths with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty claude resolve "));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const claudePath = path.join(tempDir, "claude.cmd");
  fs.writeFileSync(
    claudePath,
    "@echo off\r\necho 2.1.123 (Claude Code)\r\n",
    "utf8",
  );

  const { bridge, restore } = loadBridgeWithMocks({
    prepareCommandForSpawn,
    resolveCliFromPath: (command) => (command === "claude" ? claudePath : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveHandler = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    assert.equal(typeof resolveHandler, "function");

    const result = await resolveHandler({ sender: { id: 1 } }, { command: "claude", customPath: "" });

    assert.deepEqual(result, {
      path: claudePath,
      binPath: claudePath,
      version: "2.1.123 (Claude Code)",
      available: true,
      installed: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli probes Windows Claude exe paths with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty claude exe resolve "));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const claudePath = path.join(tempDir, "claude.exe");
  fs.copyFileSync(process.execPath, claudePath);

  const { bridge, restore } = loadBridgeWithMocks({
    prepareCommandForSpawn,
    resolveCliFromPath: (command) => (command === "claude" ? claudePath : null),
  });
  const ipcMain = createIpcMainStub();

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveHandler = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    assert.equal(typeof resolveHandler, "function");

    const result = await resolveHandler({ sender: { id: 1 } }, { command: "claude", customPath: "" });

    assert.deepEqual(result, {
      path: claudePath,
      binPath: claudePath,
      version: process.version,
      available: true,
      installed: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli reports Cursor Agent CLI on PATH as installed without CLI login", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    probeCursorCliAuth: () => ({
      authenticated: false,
      authSource: null,
      email: null,
      binPath: "/usr/local/bin/cursor-agent",
    }),
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, { command: "cursor", customPath: "" });
    assert.equal(result.installed, true);
    assert.equal(result.sdkInstalled, true);
    assert.equal(result.cliBinPath, "/usr/local/bin/cursor-agent");
    assert.equal(result.cliLoginOk, false);
    assert.equal(result.available, false);
  } finally {
    restore();
  }
});

test("resolve-cli reports Cursor SDK installed but unavailable without an API key", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, { command: "cursor", customPath: "" });
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: false,
      installed: false,
      authenticated: false,
      authSource: null,
      cliEmail: null,
      cliBinPath: null,
      cliLoginOk: false,
      apiKeyOk: false,
      sdkInstalled: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli separates Cursor SDK installation from API key availability", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: () => "/Applications/Cursor.app/Contents/MacOS/Cursor",
    resolveCliFromPath: () => null,
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
    );
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: false,
      installed: false,
      authenticated: false,
      authSource: null,
      cliEmail: null,
      cliBinPath: null,
      cliLoginOk: false,
      apiKeyOk: false,
      sdkInstalled: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli ignores custom Cursor paths and stores the SDK sentinel path", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    normalizeCliPathForPlatform: () => "/tmp/not-cursor",
    resolveCliFromPath: () => null,
    shellEnv: { CURSOR_API_KEY: "cur-key" },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "/tmp/not-cursor" },
    );
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: true,
      installed: false,
      authenticated: true,
      authSource: "CURSOR_API_KEY",
      cliEmail: null,
      cliBinPath: null,
      cliLoginOk: false,
      apiKeyOk: true,
      sdkInstalled: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli exposes Cursor SDK support when installed and authenticated", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    shellEnv: { CURSOR_API_KEY: "cur-key" },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, { command: "cursor", customPath: "" });
    assert.deepEqual(result, {
      path: "cursor",
      binPath: "cursor",
      version: "Cursor SDK",
      available: true,
      installed: false,
      authenticated: true,
      authSource: "CURSOR_API_KEY",
      cliEmail: null,
      cliBinPath: null,
      cliLoginOk: false,
      apiKeyOk: true,
      sdkInstalled: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli exposes Cursor SDK support when API key is saved in settings", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => "/usr/local/bin/cursor",
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "", apiKeyPresent: true },
    );
    assert.deepEqual(result, {
      path: "/usr/local/bin/cursor",
      binPath: "/usr/local/bin/cursor",
      version: "Cursor SDK",
      available: true,
      installed: false,
      authenticated: true,
      authSource: "settings",
      cliEmail: null,
      cliBinPath: null,
      cliLoginOk: false,
      apiKeyOk: true,
      sdkInstalled: true,
    });
  } finally {
    restore();
  }
});

test("resolve-cli reports settings as Cursor auth source when settings and env keys both exist", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => "/usr/local/bin/cursor",
    shellEnv: { CURSOR_API_KEY: "env-key" },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "", apiKeyPresent: true },
    );

    assert.equal(result.available, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.authSource, "settings");
  } finally {
    restore();
  }
});

test("resolve-cli can refresh shell env before resolving Cursor", async () => {
  let refreshed = false;
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    shellEnv: { CURSOR_API_KEY: "cur-key" },
    invalidateShellEnvCache: () => { refreshed = true; },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli(
      { sender: { id: 1 } },
      { command: "cursor", customPath: "", refreshShellEnv: true },
    );

    assert.equal(refreshed, true);
    assert.equal(result.available, true);
  } finally {
    restore();
  }
});

test("discover exposes Cursor when CLI login succeeds without API key", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    probeCursorCliAuth: () => ({
      authenticated: true,
      authSource: "cli-login",
      email: "user@example.com",
      binPath: "/Users/me/.local/bin/agent",
    }),
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const discover = ipcMain.handlers.get("netcatty:ai:agents:discover");
    const agents = await discover({ sender: { id: 1 } }, {});
    const cursor = agents.find((agent) => agent.command === "cursor");

    assert.equal(cursor?.available, true);
    assert.equal(cursor?.installed, true);
    assert.equal(cursor?.authenticated, true);
    assert.equal(cursor?.authSource, "cli-login");
    assert.equal(cursor?.path, "/Users/me/.local/bin/agent");
    assert.equal(cursor?.cliEmail, "user@example.com");
  } finally {
    restore();
  }
});

test("discover exposes Cursor SDK support when API key is saved in settings", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const discover = ipcMain.handlers.get("netcatty:ai:agents:discover");
    const agents = await discover({ sender: { id: 1 } }, { apiKeyPresent: true });
    const cursor = agents.find((agent) => agent.command === "cursor");

    assert.equal(cursor?.path, "cursor");
    assert.equal(cursor?.available, true);
    assert.equal(cursor?.installed, false);
    assert.equal(cursor?.sdkInstalled, true);
    assert.equal(cursor?.authenticated, true);
    assert.equal(cursor?.authSource, "settings");
  } finally {
    restore();
  }
});

test("resolve-cli exposes Cursor CLI login without API key", async () => {
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    probeCursorCliAuth: () => ({
      authenticated: true,
      authSource: "cli-login",
      email: "user@example.com",
      binPath: "/Users/me/.local/bin/agent",
    }),
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const resolveCli = ipcMain.handlers.get("netcatty:ai:resolve-cli");
    const result = await resolveCli({ sender: { id: 1 } }, { command: "cursor", customPath: "" });
    assert.equal(result.available, true);
    assert.equal(result.installed, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.authSource, "cli-login");
    assert.equal(result.path, "/Users/me/.local/bin/agent");
    assert.equal(result.cliEmail, "user@example.com");
  } finally {
    restore();
  }
});

test("discover can refresh shell env before scanning Cursor", async () => {
  let refreshed = false;
  const { bridge, restore } = loadBridgeWithMocks({
    resolveCliFromPath: () => null,
    shellEnv: () => (refreshed ? { CURSOR_API_KEY: "cur-key" } : {}),
    invalidateShellEnvCache: () => { refreshed = true; },
  });
  const ipcMain = createIpcMainStub();
  bridge.init({ sessions: new Map(), sftpClients: new Map(), electronModule: { app: { getPath: () => process.cwd() } } });
  bridge.registerHandlers(ipcMain);

  try {
    const discover = ipcMain.handlers.get("netcatty:ai:agents:discover");
    const agents = await discover({ sender: { id: 1 } }, { refreshShellEnv: true });
    const cursor = agents.find((agent) => agent.command === "cursor");

    assert.equal(refreshed, true);
    assert.equal(cursor?.path, "cursor");
    assert.equal(cursor?.available, true);
  } finally {
    restore();
  }
});

/** Boot the bridge with a local HTTP server and capture the request it receives. */
async function withCapturingServer(t, options, respond) {
  const received = {};
  let handleStreamEvent = () => {};
  const { bridge, restore } = loadBridgeWithMocks({
    safeSend: (_sender, channel, payload) => handleStreamEvent(channel, payload),
    ...options,
  });
  const ipcMain = createIpcMainStub();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.headers = req.headers;
      received.body = Buffer.concat(chunks);
      respond(res);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  bridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    electronModule: { app: { getPath: () => process.cwd() } },
  });
  bridge.registerHandlers(ipcMain);

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const sender = { id: 1 };
  await ipcMain.handlers.get("netcatty:ai:sync-providers")(
    { sender },
    { providers: [{ id: "content-length", baseURL }] },
  );

  return {
    received,
    baseURL,
    sender,
    ipcMain,
    restore,
    onStreamEvent: (fn) => {
      handleStreamEvent = fn;
    },
  };
}

test("streaming AI requests send Content-Length instead of chunked encoding", { timeout: 5_000 }, async (t) => {
  const ctx = await withCapturingServer(t, {}, (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  });

  try {
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    const streamFinished = new Promise((resolve, reject) => {
      ctx.onStreamEvent((channel, payload) => {
        if (channel === "netcatty:ai:stream:end") resolve();
        else if (channel === "netcatty:ai:stream:error") reject(new Error(payload.error));
      });
    });

    const result = await ctx.ipcMain.handlers.get("netcatty:ai:chat:stream")(
      { sender: ctx.sender },
      {
        requestId: "content-length-stream",
        url: `${ctx.baseURL}/v1/messages`,
        headers: { "content-type": "application/json" },
        body,
        providerId: "content-length",
      },
    );
    await streamFinished;

    assert.equal(result.ok, true);
    assert.equal(ctx.received.headers["content-length"], String(Buffer.byteLength(body)));
    assert.equal(ctx.received.headers["transfer-encoding"], undefined);
    assert.equal(ctx.received.body.toString("utf8"), body);
  } finally {
    ctx.restore();
  }
});

test("Content-Length for AI request bodies counts bytes, not UTF-16 code units", { timeout: 5_000 }, async (t) => {
  const ctx = await withCapturingServer(t, {}, (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  });

  try {
    // A realistic system prompt: multi-byte characters make the UTF-16 length
    // shorter than the UTF-8 byte length, so `body.length` would truncate.
    const body = JSON.stringify({
      stream: true,
      system: "你是 Catty Agent，一个内置于 netcatty 的终端自动化助手。请检查磁盘使用率。",
      messages: [{ role: "user", content: "检查系统状态" }],
    });
    assert.notEqual(body.length, Buffer.byteLength(body));

    const streamFinished = new Promise((resolve, reject) => {
      ctx.onStreamEvent((channel, payload) => {
        if (channel === "netcatty:ai:stream:end") resolve();
        else if (channel === "netcatty:ai:stream:error") reject(new Error(payload.error));
      });
    });

    const result = await ctx.ipcMain.handlers.get("netcatty:ai:chat:stream")(
      { sender: ctx.sender },
      {
        requestId: "content-length-multibyte",
        url: `${ctx.baseURL}/v1/messages`,
        headers: { "content-type": "application/json" },
        body,
        providerId: "content-length",
      },
    );
    await streamFinished;

    assert.equal(result.ok, true);
    assert.equal(ctx.received.headers["content-length"], String(Buffer.byteLength(body)));
    assert.equal(ctx.received.body.toString("utf8"), body);
  } finally {
    ctx.restore();
  }
});

test("non-streaming AI requests send Content-Length instead of chunked encoding", { timeout: 5_000 }, async (t) => {
  const ctx = await withCapturingServer(t, {}, (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
  });

  try {
    const body = JSON.stringify({ model: "test-model", input: "hi" });

    const result = await ctx.ipcMain.handlers.get("netcatty:ai:fetch")(
      { sender: ctx.sender },
      {
        url: `${ctx.baseURL}/v1/messages`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        providerId: "content-length",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(ctx.received.headers["content-length"], String(Buffer.byteLength(body)));
    assert.equal(ctx.received.headers["transfer-encoding"], undefined);
    assert.equal(ctx.received.body.toString("utf8"), body);
  } finally {
    ctx.restore();
  }
});
