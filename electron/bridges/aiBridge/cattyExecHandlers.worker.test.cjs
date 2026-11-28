const assert = require("node:assert/strict");
const test = require("node:test");

const { registerCattyExecHandlers } = require("./cattyExecHandlers.cjs");
const { createAiPrivacyService } = require("../../shared/aiPrivacyService.cjs");

function createFakeIpcMain() {
  return {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
  };
}

test("catty AI exec proxies to the terminal worker when the real session lives in the worker", async () => {
  const ipcMain = createFakeIpcMain();
  const aiPrivacyService = createAiPrivacyService();
  aiPrivacyService.checkSession("chat-1");
  const requests = [];
  const terminalWorkerManager = {
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve({ ok: true, stdout: "ok\n" });
    },
  };
  const locks = [];
  const mcpServerBridge = {
    getPermissionMode: () => "auto",
    getSessionBusyError: () => null,
    reserveSessionExecution(sessionId, kind) {
      locks.push(["reserve", sessionId, kind]);
      return { ok: true, token: "token-1" };
    },
    releaseSessionExecution(sessionId, token) {
      locks.push(["release", sessionId, token]);
    },
    getSessionMeta() {
      return { protocol: "ssh", deviceType: "", hostname: "host.example" };
    },
    checkCommandSafetyForShell() {
      return { blocked: false };
    },
    checkCommandSafetyCommonOnly() {
      return { blocked: false };
    },
    resolveSessionBlocklistShellKind() {
      return "";
    },
    getCommandTimeoutMs() {
      return 12345;
    },
    getCommandBlocklist() {
      return [];
    },
    activePtyExecs: new Map(),
  };

  registerCattyExecHandlers({
    ipcMain,
    aiPrivacyService,
    validateSender: () => true,
    sessions: new Map(),
    terminalWorkerManager,
    mcpServerBridge,
    electronModule: {},
    safeSend() {},
    execViaPty() {
      throw new Error("main process should not execute without a real session");
    },
    getFreshIdlePrompt() {
      return "";
    },
  });

  const result = await ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "ssh-1", command: "pwd", chatSessionId: "chat-1" },
  );

  assert.deepEqual(result, { ok: true, stdout: "ok\n" });
  assert.deepEqual(requests, [
    {
      channel: "netcatty:ai:exec",
      payload: {
        sessionId: "ssh-1",
        command: "pwd",
        chatSessionId: "chat-1",
        commandTimeoutMs: 12345,
        sessionMeta: { protocol: "ssh", deviceType: "", hostname: "host.example" },
        commandBlocklist: [],
      },
      options: { webContentsId: 7, beforeExecute: requests[0].options.beforeExecute },
    },
  ]);
  assert.equal(typeof requests[0].options.beforeExecute, "function");
  assert.deepEqual(locks, [
    ["reserve", "ssh-1", "exec"],
    ["release", "ssh-1", "token-1"],
  ]);
});

test("catty worker exec rehydrates prompt readiness via shared preflight and honors cancel during preflight", async (t) => {
  const { isolateCliDiscoveryFile } = require("../cliDiscoveryTestIsolation.cjs");
  isolateCliDiscoveryFile();
  const bridgePath = require.resolve("../mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  const bridge = require(bridgePath);
  t.after(() => bridge.cleanup());

  const events = [];
  const workerRequests = [];
  const terminalWorkerManager = {
    getSessionOwnerWebContentsId: () => null,
    drainOutputSession: () => true,
    send() {},
    request(channel, payload, options) {
      events.push(`worker:${channel}`);
      workerRequests.push({ channel, payload, options });
      if (channel === "netcatty:ai:shellReadiness") {
        return Promise.resolve({
          ok: true,
          found: true,
          trackedShell: true,
          freshIdlePrompt: "",
          visibleIdlePrompt: "",
          readiness: "unknown",
          generation: 7,
          bufferedBytes: 4,
          unackedBytes: 0,
          outputPaused: false,
        });
      }
      if (channel === "netcatty:ai:seedIdlePrompt") {
        return Promise.resolve({
          ok: true,
          found: true,
          ready: true,
          prompt: "[root@target ~]# ",
          generation: 8,
        });
      }
      return Promise.resolve({ ok: true, stdout: "ok\n", exitCode: 0 });
    },
  };

  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager,
    drainTerminalOutput: async (sessionId) => {
      events.push(`drain:${sessionId}`);
      return { success: true };
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([
    { sessionId: "ssh-1", protocol: "ssh", hostname: "jump.example.com", connected: true },
  ], "chat-catty");
  bridge.setVaultAgentInvoker(async (op, params) => {
    events.push(`renderer:${op}:${params.includeReadinessContext === true}`);
    return {
      ok: true,
      content: "[root@target ~]# ",
      readinessContext: "[root@target ~]# ",
      cursorLine: 0,
      cursorAtLineEnd: true,
      alternateScreen: false,
    };
  });

  const ipcMain = createFakeIpcMain();
  const aiPrivacyService = createAiPrivacyService();
  aiPrivacyService.checkSession("chat-catty");
  registerCattyExecHandlers({
    ipcMain,
    aiPrivacyService,
    validateSender: () => true,
    sessions: new Map(),
    terminalWorkerManager,
    mcpServerBridge: bridge,
    electronModule: {},
    safeSend() {},
    execViaPty() {
      throw new Error("main process should not execute without a real session");
    },
    getFreshIdlePrompt() {
      return "";
    },
  });

  const result = await ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "ssh-1", command: "pwd", chatSessionId: "chat-catty" },
  );
  assert.deepEqual(result, { ok: true, stdout: "ok\n", exitCode: 0 });
  assert.deepEqual(events, [
    "worker:netcatty:ai:shellReadiness",
    "drain:ssh-1",
    "renderer:terminal.readContext:true",
    "worker:netcatty:ai:seedIdlePrompt",
    "worker:netcatty:ai:exec",
  ]);
  assert.equal(workerRequests[1].payload.context, "[root@target ~]# ");
  assert.equal(workerRequests[1].payload.expectedGeneration, 7);

  // Cancelling via netcatty:ai:catty:cancel while preflight awaits renderer context aborts before exec.
  workerRequests.length = 0;
  let releaseRead;
  let readEntered;
  const readEnteredPromise = new Promise((resolve) => { readEntered = resolve; });
  bridge.setVaultAgentInvoker(async () => {
    readEntered();
    return await new Promise((resolve) => { releaseRead = resolve; });
  });

  const pending = ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "ssh-1", command: "pwd", chatSessionId: "chat-catty" },
  );
  await readEnteredPromise;
  await ipcMain.handlers.get("netcatty:ai:catty:cancel")(
    { sender: { id: 7 } },
    { chatSessionId: "chat-catty" },
  );
  const cancelled = await pending;
  releaseRead?.({ ok: true, readinessContext: "[root@target ~]# ", alternateScreen: false });

  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancel/i);
  assert.deepEqual(workerRequests.map((r) => r.channel), ["netcatty:ai:shellReadiness"]);
  assert.equal(bridge.getSessionBusyError("ssh-1"), null, "lock must be released after cancelled preflight");
});
