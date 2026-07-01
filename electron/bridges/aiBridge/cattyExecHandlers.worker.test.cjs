const assert = require("node:assert/strict");
const test = require("node:test");

const { registerCattyExecHandlers } = require("./cattyExecHandlers.cjs");

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
    checkCommandSafety() {
      return { blocked: false };
    },
    getCommandTimeoutMs() {
      return 12345;
    },
    activePtyExecs: new Map(),
  };

  registerCattyExecHandlers({
    ipcMain,
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
      },
      options: { webContentsId: 7 },
    },
  ]);
  assert.deepEqual(locks, [
    ["reserve", "ssh-1", "exec"],
    ["release", "ssh-1", "token-1"],
  ]);
});
