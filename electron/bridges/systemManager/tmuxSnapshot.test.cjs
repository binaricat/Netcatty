/* eslint-disable no-undef */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createTmuxOpsApi, parseTmuxSnapshot } = require("./tmuxOps.cjs");

const SNAPSHOT_STDOUT = [
  "work\t2\t1\t1700000000\t1700000100\t",
  "main\t1\t0\t1700000200\t1700000300\t",
  "__NC_SNAP_WINDOWS__",
  "work\t0\tzsh\t1\t1\tlayout-a",
  "work\t1\tvim\t1\t0\tlayout-b",
  "main\t0\tbash\t1\t1\tlayout-c",
  "__NC_SNAP_CLIENTS__",
  "/dev/pts/1\t/dev/pts/1\t1700000500\twork",
  "",
].join("\n");

test("parseTmuxSnapshot groups sessions, windows and clients", () => {
  const snap = parseTmuxSnapshot(SNAPSHOT_STDOUT);
  assert.equal(snap.markersSeen, true);
  assert.deepEqual(
    snap.sessions.map((s) => [s.name, s.windows, s.attached]),
    [["work", 2, true], ["main", 1, false]],
  );
  assert.deepEqual(
    (snap.windowsBySession.work || []).map((w) => [w.index, w.name, w.active]),
    [[0, "zsh", true], [1, "vim", false]],
  );
  assert.deepEqual(
    (snap.windowsBySession.main || []).map((w) => [w.index, w.name]),
    [[0, "bash"]],
  );
  assert.deepEqual(
    snap.clients.map((c) => [c.name, c.session]),
    [["/dev/pts/1", "work"]],
  );
});

test("parseTmuxSnapshot reports missing markers", () => {
  const snap = parseTmuxSnapshot("work: 2 windows (attached)\n");
  assert.equal(snap.markersSeen, false);
  assert.equal(snap.sessions.length, 1); // plain list-sessions fallback still parses
});

function createSnapshotExec({ snapshotStdout = SNAPSHOT_STDOUT, sockets = ["/tmp/tmux-1000/default"] } = {}) {
  const commands = [];
  const execOnSession = async (_event, _sessionId, command) => {
    commands.push(command);
    if (command.includes("tmux -V")) return { success: true, stdout: "tmux 3.4\n", stderr: "", code: 0 };
    if (command.includes("command -v tmux")) return { success: true, stdout: "/usr/bin/tmux\n", stderr: "", code: 0 };
    if (command.includes("/tmp/tmux-1000/*")) {
      return { success: true, stdout: sockets.map((s) => `${s}\n`).join(""), stderr: "", code: 0 };
    }
    if (command.includes("__NC_SNAP_WINDOWS__")) {
      return { success: true, stdout: snapshotStdout, stderr: "", code: 0 };
    }
    return { success: true, stdout: "", stderr: "", code: 0 };
  };
  return { commands, execOnSession };
}

test("listTmuxSnapshot fetches sessions, windows and clients in one exec", async () => {
  const { commands, execOnSession } = createSnapshotExec();
  const api = createTmuxOpsApi({ execOnSession });
  const result = await api.listTmuxSnapshot(null, "s1");

  assert.equal(result.success, true);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.windowsBySession.work.length, 2);
  assert.equal(result.clients.length, 1);
  assert.equal(result.tmuxVersion, "tmux 3.4");
  const snapshotCalls = commands.filter((c) => c.includes("__NC_SNAP_WINDOWS__"));
  assert.equal(snapshotCalls.length, 1);
  assert.match(snapshotCalls[0], /list-sessions/);
  assert.match(snapshotCalls[0], /list-windows -a/);
  assert.match(snapshotCalls[0], /list-clients/);
});

test("listTmuxSnapshot under sudo scope wraps once and keeps the default socket", async () => {
  const { commands, execOnSession } = createSnapshotExec();
  const api = createTmuxOpsApi({ execOnSession });
  const result = await api.listTmuxSnapshot(null, "s1", { user: "alice", sudoPassword: "pw" });

  assert.equal(result.success, true);
  const snapshotCalls = commands.filter((c) => c.includes("__NC_SNAP_WINDOWS__"));
  assert.equal(snapshotCalls.length, 1);
  assert.match(snapshotCalls[0], /^sudo -S -p '' -u 'alice' -- /);
  assert.doesNotMatch(snapshotCalls[0], /-S '\/tmp\//);
});

test("listTmuxSnapshot root fast path skips sudo and targets the user's socket", async () => {
  const { commands, execOnSession } = createSnapshotExec();
  const api = createTmuxOpsApi({ execOnSession });
  const result = await api.listTmuxSnapshot(null, "s1", {
    user: "alice",
    targetUid: 1000,
    directAsRoot: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.sessions.length, 2);
  const snapshotCalls = commands.filter((c) => c.includes("__NC_SNAP_WINDOWS__"));
  assert.equal(snapshotCalls.length, 1);
  assert.doesNotMatch(snapshotCalls[0], /sudo/);
  assert.match(snapshotCalls[0], /-S '\/tmp\/tmux-1000\/default'/);
});

test("listTmuxSnapshot root fast path with no socket dir reports an empty server", async () => {
  const { commands, execOnSession } = createSnapshotExec({ sockets: [] });
  const api = createTmuxOpsApi({ execOnSession });
  const result = await api.listTmuxSnapshot(null, "s1", {
    user: "alice",
    targetUid: 1000,
    directAsRoot: true,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.windowsBySession, {});
  // No snapshot exec at all — the empty socket scan already proves no server.
  assert.equal(commands.filter((c) => c.includes("__NC_SNAP_WINDOWS__")).length, 0);
});

test("listTmuxSnapshot treats a no-server reply as an empty session list", async () => {
  const noServer = "no server running on /tmp/tmux-1000/default\n__NC_SNAP_WINDOWS__\n__NC_SNAP_CLIENTS__\n";
  const { execOnSession } = createSnapshotExec({ snapshotStdout: noServer });
  const api = createTmuxOpsApi({ execOnSession });
  const result = await api.listTmuxSnapshot(null, "s1");

  assert.equal(result.success, true);
  assert.deepEqual(result.sessions, []);
});
