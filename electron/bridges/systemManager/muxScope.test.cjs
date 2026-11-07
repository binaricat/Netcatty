"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSudoUserCommand,
  classifySudoError,
  execScopedOnSession,
  parseListUsersOutput,
} = require("./muxScope.cjs");

test("classifySudoError detects password-required sudo failures", () => {
  assert.equal(classifySudoError("sudo: a password is required"), "sudoPasswordRequired");
  assert.equal(classifySudoError("sudo: no tty present and no askpass program specified"), "sudoPasswordRequired");
  assert.equal(classifySudoError("sudo: no password was provided"), "sudoPasswordRequired");
});

test("classifySudoError detects incorrect-password sudo failures", () => {
  assert.equal(classifySudoError("Sorry, try again.\nsudo: 1 incorrect password attempt"), "sudoPasswordIncorrect");
  assert.equal(classifySudoError("sudo: 2 incorrect password attempts"), "sudoPasswordIncorrect");
});

test("classifySudoError returns null for unrelated output", () => {
  assert.equal(classifySudoError("work [Created 2h ago]"), null);
  assert.equal(classifySudoError(""), null);
  assert.equal(classifySudoError(null), null);
});

test("buildSudoUserCommand passes password via stdin, never argv", () => {
  const { command, stdin } = buildSudoUserCommand("tmux ls", "alice", "s3cret");
  assert.ok(command.startsWith("sudo -S -p '' -u 'alice' -- sh -c "));
  assert.ok(command.includes("tmux ls"));
  assert.ok(!command.includes("s3cret"));
  assert.equal(stdin, "s3cret\n");
});

test("buildSudoUserCommand without password fails fast via sudo -n", () => {
  const { command, stdin } = buildSudoUserCommand("zellij ls", "bob");
  assert.ok(command.startsWith("sudo -n -u 'bob' -- sh -c "));
  assert.equal(stdin, undefined);
});

test("buildSudoUserCommand without user returns the script unchanged", () => {
  const { command, stdin } = buildSudoUserCommand("tmux ls", "");
  assert.equal(command, "tmux ls");
  assert.equal(stdin, undefined);
});

test("buildSudoUserCommand shell-quotes user and script", () => {
  const { command } = buildSudoUserCommand("echo 'hi'", "o'hara", "pw");
  assert.ok(command.includes("-u 'o'\"'\"'hara'"));
});

test("parseListUsersOutput parses markers and flags tmux socket owners", () => {
  const stdout = [
    "__NC_CURRENT_USER__=deploy",
    "__NC_CURRENT_UID__=1001",
    "__NC_USER__=root:0",
    "__NC_USER__=alice:1000",
    "__NC_USER__=deploy:1001",
    "__NC_TMUX_UID__=1000",
  ].join("\n");
  const { currentUser, currentUid, users } = parseListUsersOutput(stdout);
  assert.equal(currentUser, "deploy");
  assert.equal(currentUid, 1001);
  assert.deepEqual(users, [
    { name: "root", uid: 0, hasTmuxSockets: false },
    { name: "alice", uid: 1000, hasTmuxSockets: true },
    { name: "deploy", uid: 1001, hasTmuxSockets: false },
  ]);
});

test("parseListUsersOutput tolerates empty and malformed output", () => {
  assert.deepEqual(parseListUsersOutput(""), { currentUser: "", currentUid: 0, users: [] });
  const { users } = parseListUsersOutput("__NC_USER__=:1000\n__NC_USER__=x:notanumber\nnoise");
  assert.deepEqual(users, []);
});

test("execScopedOnSession runs unscoped when no user is given", async () => {
  const calls = [];
  const execOnSession = async (_e, _s, cmd) => {
    calls.push(cmd);
    return { success: true, stdout: "ok", stderr: "" };
  };
  const result = await execScopedOnSession(execOnSession, null, "s1", "tmux ls", 1000, null);
  assert.equal(result.success, true);
  assert.deepEqual(calls, ["tmux ls"]);
});

test("execScopedOnSession classifies sudo failures with errorCode", async () => {
  const execOnSession = async () => ({
    success: false,
    stdout: "",
    stderr: "sudo: a password is required",
    code: 1,
  });
  const result = await execScopedOnSession(execOnSession, null, "s1", "tmux ls", 1000, { user: "alice" });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "sudoPasswordRequired");
});

test("execScopedOnSession feeds the sudo password through stdin", async () => {
  let seen;
  const execOnSession = async (_e, _s, cmd, _t, opts) => {
    seen = { cmd, opts };
    return { success: true, stdout: "ok", stderr: "" };
  };
  const result = await execScopedOnSession(
    execOnSession, null, "s1", "tmux ls", 1000, { user: "alice", sudoPassword: "pw" },
  );
  assert.equal(result.success, true);
  assert.equal(seen.opts.stdin, "pw\n");
  assert.ok(seen.cmd.startsWith("sudo -S -p '' -u 'alice' --"));
});
