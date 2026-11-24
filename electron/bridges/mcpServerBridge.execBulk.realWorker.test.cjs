"use strict";

require("./cliDiscoveryTestIsolation.cjs").isolateCliDiscoveryFile();

// terminal_execute_bulk wired to the REAL terminal-worker exec handler. The terminals are
// fakes that speak the wrapper protocol, so worker precheck, readiness, markers, timeouts
// and cancellation all run through production code.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { registerWorkerAiExecHandlers } = require("../terminalWorker/aiExec.cjs");
const { trackSessionIdlePrompt } = require("./ai/shellUtils.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeShellPty extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(data) {
    this.writes.push(String(data));
    const input = this.writes.join("");
    if (!this.probeReplied && input.includes("command sh -c") && input.endsWith("_Q'\n")) {
      this.probeReplied = true;
      const marker = input.match(/(__NCMCP_[A-Za-z0-9_]+__)/)[1];
      queueMicrotask(() => this.emit("data", `${marker}_P:\n${marker}_Q`));
    }
    if (String(data).includes("\x03") && this.session) {
      // A real shell prints a fresh prompt after Ctrl-C.
      queueMicrotask(() => {
        trackSessionIdlePrompt(this.session, "user@host:~$ ");
        this.emit("data", "^C\r\nuser@host:~$ ");
      });
    }
  }
}

async function wrapperMarker(pty) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const input = pty.writes.join("");
    const wrapper = input.slice(input.lastIndexOf("\x0b\x15"));
    if (wrapper.includes("_cmd") && wrapper.includes("_E:") && wrapper.endsWith("\n") && !wrapper.endsWith("\\\n")) {
      return wrapper.match(/(__NCMCP_[A-Za-z0-9_]+__)/)[1];
    }
    await sleep(10);
  }
  throw new Error("the command wrapper was never written to the terminal");
}

const reply = async (pty, stdout, exitCode) => {
  const marker = await wrapperMarker(pty);
  pty.emit("data", `${marker}_S\n${stdout}\n${marker}_E:${exitCode}\n`);
};

function setup(ids = ["w1", "w2", "w3"]) {
  const ptys = new Map();
  const sessions = new Map();
  for (const id of ids) {
    const pty = new FakeShellPty();
    const session = { protocol: "ssh", stream: pty, shellKind: "posix", _promptTrackTail: "", lastIdlePrompt: "" };
    pty.session = session;
    trackSessionIdlePrompt(session, "user@host:~$ ");
    ptys.set(id, pty);
    sessions.set(id, session);
  }
  const ipc = {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    on(channel, listener) { this.listeners.set(channel, listener); },
  };
  registerWorkerAiExecHandlers(ipc, { sessions });
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  const bridge = require("./mcpServerBridge.cjs");
  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request: (channel, payload, options) => ipc.handlers.get(channel)(
        { sender: { send() {} }, beforeExecute: options?.beforeExecute }, payload,
      ),
      send: (channel, payload) => { ipc.listeners.get(channel)?.({}, payload); },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.setCommandBlocklist([]);
  bridge.setCommandTimeout(30);
  bridge.updateSessionMetadata(
    ids.map((id) => ({ sessionId: id, hostname: `${id}.example`, label: id, protocol: "ssh", connected: true })),
    "chat",
  );
  const run = (command, sessionIds = ids) => bridge.dispatchBuiltinRpc("netcatty/execBulk", {
    command, sessionIds: JSON.stringify(sessionIds), chatSessionId: "chat",
  });
  return { bridge, ptys, run };
}

test("real worker: identical hosts group and the exit code is reported, not judged", async () => {
  const { ptys, run } = setup();
  const running = run("systemctl is-active nginx");
  await Promise.all([
    reply(ptys.get("w1"), "active", 0),
    reply(ptys.get("w2"), "active", 0),
    reply(ptys.get("w3"), "inactive", 3),
  ]);
  const result = await running;
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.groups.map((group) => [group.hosts.map((host) => host.sessionId), group.status, group.exitCode, group.stdout]),
    [[["w1", "w2"], "completed", 0, "active"], [["w3"], "completed", 3, "inactive"]],
  );
});

test("real worker: Stop while every host is running ends the call promptly with cancelled hosts", async () => {
  const { bridge, ptys, run } = setup();
  const running = run("sleep 100");
  await Promise.all([...ptys.values()].map(wrapperMarker));
  await bridge.dispatchBuiltinRpc("netcatty/setCancelled", { chatSessionId: "chat", cancelled: true });
  const result = await Promise.race([running, sleep(8000).then(() => "HUNG")]);
  assert.notEqual(result, "HUNG", "Stop must not leave the call waiting for the deadline");
  assert.equal(result.ok, true);
  assert.deepEqual(result.groups.map((group) => [group.hosts.length, group.status]), [[3, "cancelled"]]);
});

test("real worker: every host has its own timeout and the call still returns per-host statuses", async () => {
  const { bridge, run } = setup();
  bridge.setCommandTimeout(1);
  const started = Date.now();
  const result = await Promise.race([run("sleep 100"), sleep(12000).then(() => "HUNG")]);
  assert.notEqual(result, "HUNG");
  assert.deepEqual(result.groups.map((group) => [group.hosts.length, group.status, group.error]), [[3, "timeout", "Command timed out (1s)"]]);
  assert.ok(Date.now() - started < 6000, "all hosts time out together, not one after another");
});
