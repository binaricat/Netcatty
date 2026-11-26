"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createExecHandlerApi } = require("./mcpServerBridge/execHandlers.cjs");
const { createExecBulkHandler } = require("./mcpServerBridge/execBulk.cjs");
const {
  createWorkerAiExecHandler,
  createWorkerAiJobStartHandler,
} = require("../terminalWorker/aiExec.cjs");

describe("AI/MCP guards exclude VNC and RDP remote desktop sessions", () => {
  it("rejects vnc and rdp sessions in execHandlers.resolveExecContext / handleExec", () => {
    const sessions = new Map([
      ["s-vnc", { protocol: "vnc", stream: { write() {} } }],
      ["s-rdp", { protocol: "rdp", stream: { write() {} } }],
    ]);
    const api = createExecHandlerApi({
      sessions,
      debugLog() {},
      getSessionMeta: () => ({}),
      reserveSessionExecution: () => ({ ok: true, token: "t" }),
      releaseSessionExecution() {},
      beginChatExecution: () => ({ ok: true, release() {} }),
      checkCommandSafetyForShell: () => ({ blocked: false }),
      checkCommandSafetyCommonOnly: () => ({ blocked: false }),
      resolveSessionBlocklistShellKind: () => "posix",
      activePtyExecs: new Map(),
      backgroundJobs: new Map(),
      commandTimeoutMs: 5000,
    });

    const vncRes = api.handleExec({ sessionId: "s-vnc", command: "whoami" });
    assert.equal(vncRes.ok, false);
    assert.match(vncRes.error, /Remote desktop \(VNC\) sessions do not support terminal command execution/);

    const rdpRes = api.handleExec({ sessionId: "s-rdp", command: "whoami" });
    assert.equal(rdpRes.ok, false);
    assert.match(rdpRes.error, /Remote desktop \(RDP\) sessions do not support terminal command execution/);
  });

  it("fails terminal_execute_bulk preflight all-or-nothing when any target is vnc/rdp", async () => {
    let executed = false;
    const metas = new Map([
      ["s-ssh", { protocol: "ssh", connected: true, label: "web-1" }],
      ["s-rdp", { protocol: "rdp", connected: true, label: "win-1" }],
    ]);
    const bulk = createExecBulkHandler({
      getSessions: () => new Map(),
      getSessionMeta: (id) => metas.get(id),
      validateSessionScope: () => null,
      closingTerminalSessions: new Set(),
      getSessionBusyError: () => null,
      pendingSessionWriteApprovals: new Map(),
      getActiveChatExecution: () => null,
      beginChatExecution: () => ({ ok: true, release() {} }),
      isChatSessionCancelled: () => false,
      preflightMainExec: async () => ({ ok: true }),
      preflightWorkerExec: async () => ({ ok: true }),
      execOnSession: async () => {
        executed = true;
        return { ok: true, stdout: "ok", exitCode: 0 };
      },
      requestApproval: async () => true,
      sessionIdleManager: { beginActivity: () => true, endActivity() {} },
      getCommandTimeoutMs: () => 5000,
      getLivePermission: () => ({ allowed: true, requiresApproval: false }),
      cancelExecsForChat() {},
      USER_DENIED_MESSAGE: "denied",
      CHAT_SESSION_CANCELLED_MESSAGE: "cancelled",
    });

    const res = await bulk.run({ command: "uptime", sessionIds: ["s-ssh", "s-rdp"] });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BULK_PREFLIGHT_FAILED");
    assert.match(res.error, /Remote desktop \(RDP\) sessions do not support terminal command execution/);
    assert.equal(executed, false);
  });

  it("rejects vnc and rdp sessions in terminalWorker aiExec and aiJobStart", async () => {
    const sessions = new Map([
      ["w-vnc", { protocol: "vnc", stream: { write() {} } }],
      ["w-rdp", { protocol: "rdp", stream: { write() {} } }],
    ]);
    const execHandler = createWorkerAiExecHandler({ sessions });
    const jobStartHandler = createWorkerAiJobStartHandler({ sessions });

    const r1 = await execHandler({}, { sessionId: "w-vnc", command: "ls" });
    assert.equal(r1.ok, false);
    assert.match(r1.error, /Remote desktop \(VNC\)/);

    const r2 = await jobStartHandler({}, { sessionId: "w-rdp", command: "ls" });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /Remote desktop \(RDP\)/);
  });
});
