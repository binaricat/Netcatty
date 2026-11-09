"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { startPtyJob } = require("./ptyExec.cjs");
const {
  trackSessionIdlePrompt,
  getFreshIdlePrompt,
  getVisibleIdlePrompt,
} = require("./shellUtils.cjs");
const {
  READINESS_UNKNOWN,
  SHELL_READINESS_UNKNOWN_MESSAGE,
  classifyShellReadiness,
} = require("./shellReadinessState.cjs");
const {
  formatTerminalExecuteMcpResponse,
} = require("../../capabilities/codegen/mcpToolRegistry.cjs");
const { MODEL_DESCRIPTION_HINTS } = require("../../capabilities/schemas/toolInputs.cjs");

function readyPrompt(session) {
  return getFreshIdlePrompt(session) || getVisibleIdlePrompt(session);
}

function makeSession(extra = {}) {
  return { _promptTrackTail: "", lastIdlePrompt: "", ...extra };
}

// Records every byte written to the PTY; echoes a completion marker so a
// genuinely-executed command resolves ok:true (same seam as
// ptyExec.readiness.test.cjs).
class TestPty extends EventEmitter {
  writes = [];
  write(data) {
    this.writes.push(String(data));
    const marker = String(data).match(/(__NCMCP_[a-z0-9]+_[0-9a-f]+__)/i)?.[1];
    if (marker) queueMicrotask(() => this.emit("data", `${marker}_S\nOK\n${marker}_E:0\n`));
  }
}

const UNKNOWN_PROMPT = "Last login: Mon\r\nstarship-custom-prompt─❯ ";
const SHORT_BUDGET = { promptWaitTimeoutMs: 30, timeoutMs: 2000 };

// ---------------------------------------------------------------------------
// classifier unit: PROVEN busy stays hard, whitelist miss on a live shell is
// an honest unknown. These are the #4110 false-ready guards we must not weaken.
// ---------------------------------------------------------------------------
test("classifyShellReadiness: proven-busy OSC 133 / pending-input / task / transport stay busy", () => {
  assert.equal(classifyShellReadiness(makeSession({ osc133Ready: false })), "busy"); // C/D
  assert.equal(classifyShellReadiness(makeSession({ _osc133PromptRedrawPending: true })), "busy");
  assert.equal(classifyShellReadiness(makeSession({ _osc133PromptContinued: true })), "busy");
  assert.equal(classifyShellReadiness(makeSession({ osc133Ready: true, _osc133PromptLine: 3 })), "busy"); // B cursor deviation
  assert.equal(classifyShellReadiness(makeSession({ waitingForInput: true })), "busy");
  assert.equal(classifyShellReadiness(makeSession({ busy: true })), "busy");
  assert.equal(classifyShellReadiness(makeSession({ status: "disconnected" })), "busy");
  assert.equal(classifyShellReadiness(makeSession(), { taskInFlight: true }), "busy");
  assert.equal(classifyShellReadiness(makeSession(), { transportAlive: false }), "busy");
  assert.equal(classifyShellReadiness(null), "busy"); // fail closed
});

test("classifyShellReadiness: unrecognized prompt on a live shell is unknown (not ready, not busy)", () => {
  const session = makeSession();
  trackSessionIdlePrompt(session, UNKNOWN_PROMPT);
  assert.equal(readyPrompt(session), ""); // genuine whitelist miss
  assert.equal(classifyShellReadiness(session), "unknown");
  // A-only marker with no C/D and no B confirmation is still unknown (no busy evidence).
  assert.equal(classifyShellReadiness(makeSession({ osc133Ready: true, _osc133PromptLine: null })), "unknown");
});

test("classifyShellReadiness: credential prompts remain hard busy (#4195)", () => {
  for (const line of ["Password:", "[sudo] password for alice: ", "Enter passphrase for key '/root/.ssh/id_rsa': ", "PIN: ", "Sorry, try again."]) {
    const session = makeSession({ _promptTrackTail: line });
    assert.equal(readyPrompt(session), "", line);
    assert.equal(classifyShellReadiness(session), "busy", line);
  }
});

// ---------------------------------------------------------------------------
// gating trichotomy end-to-end — EVERY case asserts PTY bytes written.
// ---------------------------------------------------------------------------
test("ready (whitelist match) → command sent, unchanged", async () => {
  const pty = new TestPty();
  const prompt = "user@host:~$ ";
  const result = await startPtyJob(pty, "echo OK", {
    shellKind: "posix",
    getReadyPrompt: () => prompt,
    classifyReadiness: () => "unknown", // never consulted when a prompt is recognized
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(result.ok, true);
  assert.equal(pty.writes.length, 1);
});

test("ready (OSC 133 A with empty input) → command sent, unchanged (#4110)", async () => {
  const pty = new TestPty();
  const session = makeSession();
  trackSessionIdlePrompt(session, "\x1b]133;A\x07\x1b[38;5;39m~/src\x1b[0m \x1b[38;5;213m❯\x1b[0m ");
  assert.equal(readyPrompt(session), "~/src ❯ ");
  const result = await startPtyJob(pty, "echo OK", {
    shellKind: "posix",
    getReadyPrompt: () => readyPrompt(session),
    classifyReadiness: () => classifyShellReadiness(session),
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(result.ok, true);
  assert.equal(pty.writes.length, 1);
});

test("PROVEN busy (OSC 133 C/D) → hard SHELL_NOT_READY, ZERO bytes written (#4110 guard)", async () => {
  const pty = new TestPty();
  const session = makeSession();
  trackSessionIdlePrompt(session, "\x1b]133;A\x07PS C:\\Users\\alice> ");
  assert.equal(readyPrompt(session), "PS C:\\Users\\alice> ");
  trackSessionIdlePrompt(session, "\x1b]133;C\x07build running...\r\nPS C:\\Users\\alice> ");
  assert.equal(readyPrompt(session), "");
  assert.equal(classifyShellReadiness(session), "busy");
  const result = await startPtyJob(pty, "echo OK", {
    shellKind: "powershell",
    getReadyPrompt: () => readyPrompt(session),
    classifyReadiness: () => classifyShellReadiness(session),
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(result.code, "SHELL_NOT_READY");
  assert.deepEqual(pty.writes, []);
});

test("PROVEN busy (pending-input / our task / disconnected) → hard block, ZERO bytes written", async () => {
  for (const extra of [
    { _osc133PromptContinued: true },
    { _osc133PromptRedrawPending: true },
    { waitingForInput: true },
    { busy: true },
    { status: "disconnected" },
  ]) {
    const pty = new TestPty();
    const session = makeSession(extra);
    trackSessionIdlePrompt(session, UNKNOWN_PROMPT);
    assert.equal(readyPrompt(session), "");
    const result = await startPtyJob(pty, "echo OK", {
      shellKind: "posix",
      getReadyPrompt: () => readyPrompt(session),
      classifyReadiness: () => classifyShellReadiness(session),
      ...SHORT_BUDGET,
    }).resultPromise;
    assert.equal(result.code, "SHELL_NOT_READY", JSON.stringify(extra));
    assert.deepEqual(pty.writes, [], JSON.stringify(extra));
  }
});

test("unknown (unrecognized prompt, live shell, no busy evidence): command NOT sent, actionable NON-fatal result", async () => {
  const pty = new TestPty();
  const session = makeSession();
  trackSessionIdlePrompt(session, UNKNOWN_PROMPT);
  assert.equal(readyPrompt(session), "");
  assert.equal(classifyShellReadiness(session), "unknown");
  const result = await startPtyJob(pty, "echo OK", {
    shellKind: "posix",
    getReadyPrompt: () => readyPrompt(session),
    classifyReadiness: () => classifyShellReadiness(session),
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(result.code, READINESS_UNKNOWN);
  assert.equal(result.ok, false); // NOT a lie of success
  assert.equal(result.error, SHELL_READINESS_UNKNOWN_MESSAGE);
  assert.match(result.error, /connection is alive/i);
  assert.match(result.error, /could not be recognized/i);
  assert.match(result.error, /NOT sent/i);
  assert.match(result.error, /read-only/i);
  assert.match(result.error, /get_environment|terminal_read_context/);
  assert.deepEqual(pty.writes, []); // no blind typing
});

test("unknown keeps the same bounded wait (no early send, no early verdict)", async () => {
  const pty = new TestPty();
  let prompt = "";
  const job = startPtyJob(pty, "echo OK", {
    shellKind: "posix",
    getReadyPrompt: () => prompt,
    classifyReadiness: () => "unknown",
    promptWaitTimeoutMs: 80,
    timeoutMs: 2000,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(pty.writes, []); // still waiting at the bounded budget
  const result = await job.resultPromise;
  assert.equal(result.code, READINESS_UNKNOWN);
  assert.deepEqual(pty.writes, []);
});

test("unknown is recoverable: a recognized prompt (user pressed Enter) lets the next exec succeed", async () => {
  const pty = new TestPty();
  let prompt = "";
  const first = await startPtyJob(pty, "echo OK", {
    shellKind: "posix",
    getReadyPrompt: () => prompt,
    classifyReadiness: () => "unknown",
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(first.code, READINESS_UNKNOWN);
  assert.deepEqual(pty.writes, []); // first exec never bricked the session

  prompt = "user@host:~$ ";
  const second = await startPtyJob(pty, "echo OK", {
    shellKind: "posix",
    getReadyPrompt: () => prompt,
    classifyReadiness: () => "unknown",
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(second.ok, true);
  assert.equal(pty.writes.length, 1);
});

test("Password: remains hard not-ready, ZERO bytes written (#4195 correct behavior)", async () => {
  const pty = new TestPty();
  const session = makeSession();
  trackSessionIdlePrompt(session, "Password:");
  assert.equal(readyPrompt(session), "");
  assert.equal(classifyShellReadiness(session), "busy");
  const result = await startPtyJob(pty, "echo OK", {
    shellKind: "posix",
    getReadyPrompt: () => readyPrompt(session),
    classifyReadiness: () => classifyShellReadiness(session),
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(result.code, "SHELL_NOT_READY");
  assert.deepEqual(pty.writes, []);
});

test("legacy callers without classifyReadiness keep the exact hard SHELL_NOT_READY block", async () => {
  const pty = new TestPty();
  const result = await startPtyJob(pty, "echo OK", {
    getReadyPrompt: () => "",
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(result.code, "SHELL_NOT_READY");
  assert.deepEqual(pty.writes, []);
});

test("a throwing / ambiguous classifier fails closed to busy (never a false ready)", async () => {
  const pty = new TestPty();
  const result = await startPtyJob(pty, "echo OK", {
    getReadyPrompt: () => "",
    classifyReadiness: () => { throw new Error("inspection blew up"); },
    ...SHORT_BUDGET,
  }).resultPromise;
  assert.equal(result.code, "SHELL_NOT_READY");
  assert.deepEqual(pty.writes, []);
});

// ---------------------------------------------------------------------------
// agent-visible surfaces: MCP tool result + tool description.
// ---------------------------------------------------------------------------
test("MCP terminal_execute surfaces unknown as a NON-fatal, actionable result (not isError)", () => {
  const unknownResult = {
    ok: false,
    error: SHELL_READINESS_UNKNOWN_MESSAGE,
    code: READINESS_UNKNOWN,
    exitCode: -1,
    stdout: "",
    stderr: "",
  };
  const formatted = formatTerminalExecuteMcpResponse(unknownResult);
  assert.notEqual(formatted.isError, true); // THE fix: agent does not see a terminal error
  assert.match(formatted.content[0].text, /read-only/i);
  assert.match(formatted.content[0].text, /NOT sent/i);
  assert.match(formatted.content[0].text, /get_environment|terminal_read_context/);
  // Control: a proven-busy verdict is still a hard error.
  const busy = formatTerminalExecuteMcpResponse({ ...unknownResult, code: "SHELL_NOT_READY", error: "Shell prompt is not ready; no command was sent" });
  assert.equal(busy.isError, true);
});

test("terminal_execute tool description documents the unknown outcome and the read-only/confirm path", () => {
  const description = MODEL_DESCRIPTION_HINTS["terminal.execute"] || "";
  assert.match(description, /SHELL_READINESS_UNKNOWN/);
  assert.match(description, /NOT sent/);
  assert.match(description, /read-only/);
  assert.match(description, /get_environment|terminal_read_context/);
  assert.match(description, /ask the user to confirm/);
});
