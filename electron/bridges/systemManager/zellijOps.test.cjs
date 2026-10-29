"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createZellijOpsApi, parseZellijSessions } = require("./zellijOps.cjs");

test("parseZellijSessions parses default list-sessions output", () => {
  const stdout = [
    "work [Created 2h 3m ago]",
    "main [Created 5m ago] (current)",
    "old [Created 1d ago] (EXITED - attach to resurrect)",
  ].join("\n");
  assert.deepEqual(parseZellijSessions(stdout), [
    { name: "work", createdText: "Created 2h 3m ago", attached: false, exited: false, isCurrent: false },
    { name: "main", createdText: "Created 5m ago", attached: true, exited: false, isCurrent: true },
    { name: "old", createdText: "Created 1d ago", attached: false, exited: true, isCurrent: false },
  ]);
});

test("parseZellijSessions parses bare --short output", () => {
  assert.deepEqual(parseZellijSessions("alpha\nbeta\n"), [
    { name: "alpha", createdText: "", attached: false, exited: false, isCurrent: false },
    { name: "beta", createdText: "", attached: false, exited: false, isCurrent: false },
  ]);
});

test("parseZellijSessions skips diagnostics and the no-sessions notice", () => {
  const stdout = "No active zellij sessions found.\nerror: something\nUsage: zellij";
  assert.deepEqual(parseZellijSessions(stdout), []);
});

test("parseZellijSessions strips ANSI escape sequences", () => {
  const stdout = "\x1b[32mwork\x1b[0m \x1b[1m[Created 1m ago]\x1b[0m";
  const sessions = parseZellijSessions(stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "work");
});

test("listSessions returns an empty list on the no-sessions notice", async () => {
  const execOnSession = async () => ({ success: true, stdout: "No active zellij sessions found.\n", stderr: "" });
  const api = createZellijOpsApi({ execOnSession });
  const result = await api.listSessions(null, "s1");
  assert.deepEqual(result, { success: true, sessions: [] });
});

test("listSessions propagates sudo errorCode from a scoped run", async () => {
  const execOnSession = async () => ({
    success: false,
    stdout: "",
    stderr: "sudo: a password is required",
    code: 1,
  });
  const api = createZellijOpsApi({ execOnSession });
  const result = await api.listSessions(null, "s1", { user: "alice" });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "sudoPasswordRequired");
});

test("listSessions falls back to ls and --short variants", async () => {
  const seen = [];
  const execOnSession = async (_e, _s, cmd) => {
    seen.push(cmd);
    if (cmd.includes("--short")) return { success: true, stdout: "alpha\n", stderr: "" };
    return { success: false, stdout: "", stderr: "", error: "boom" };
  };
  const api = createZellijOpsApi({ execOnSession });
  const result = await api.listSessions(null, "s1");
  assert.equal(result.success, true);
  assert.deepEqual(result.sessions.map((s) => s.name), ["alpha"]);
  assert.ok(seen.some((cmd) => cmd.includes("zellij list-sessions 2>&1")));
  assert.ok(seen.some((cmd) => cmd.includes("zellij ls 2>&1")));
  assert.ok(seen.some((cmd) => cmd.includes("zellij list-sessions --short 2>&1")));
});

test("zellijAction builds kill and delete commands", async () => {
  const seen = [];
  const execOnSession = async (_e, _s, cmd) => {
    seen.push(cmd);
    return { success: true, stdout: "", stderr: "", code: 0 };
  };
  const api = createZellijOpsApi({ execOnSession });
  await api.zellijAction(null, { sessionId: "s1", action: "killSession", sessionName: "work" });
  await api.zellijAction(null, { sessionId: "s1", action: "deleteSession", sessionName: "old", force: true });
  assert.ok(seen[0].includes("zellij kill-session 'work'"));
  assert.ok(seen.some((cmd) => cmd.includes("zellij delete-session --force 'old'")));
});

test("zellijAction rejects unknown actions and missing names", async () => {
  const api = createZellijOpsApi({ execOnSession: async () => ({ success: true }) });
  assert.equal((await api.zellijAction(null, { sessionId: "s1", action: "nope", sessionName: "x" })).success, false);
  assert.equal((await api.zellijAction(null, { sessionId: "s1", action: "killSession" })).success, false);
});
