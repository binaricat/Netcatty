const test = require("node:test");
const assert = require("node:assert/strict");

const { createProcessTree } = require("./ptyProcessTree.cjs");

test("getChildProcesses returns [] when session has no registered pid", async () => {
  const tree = createProcessTree({ platform: "darwin", listPosix: async () => [] });
  assert.deepEqual(await tree.getChildProcesses("unknown-session"), []);
});

test("getChildProcesses calls listPosix with the registered ppid and returns its result", async () => {
  const calls = [];
  const listPosix = async (ppid) => {
    calls.push(ppid);
    return [
      { pid: 2001, command: "sleep 100" },
      { pid: 2002, command: "node server.js" },
    ];
  };
  const tree = createProcessTree({ platform: "linux", listPosix });
  tree.registerPid("s1", 1234);
  assert.deepEqual(await tree.getChildProcesses("s1"), [
    { pid: 2001, command: "sleep 100" },
    { pid: 2002, command: "node server.js" },
  ]);
  assert.deepEqual(calls, [1234]);
});

test("unregisterPid clears mapping", async () => {
  const tree = createProcessTree({
    platform: "darwin",
    listPosix: async () => [{ pid: 9, command: "x" }],
  });
  tree.registerPid("s1", 1234);
  tree.unregisterPid("s1");
  assert.deepEqual(await tree.getChildProcesses("s1"), []);
});

test("getChildProcesses on windows uses listWindows", async () => {
  const calls = [];
  const listWindows = async (pid) => {
    calls.push(pid);
    return [{ pid: 55, command: "python.exe" }];
  };
  const tree = createProcessTree({ platform: "win32", listWindows });
  tree.registerPid("s1", 3000);
  assert.deepEqual(await tree.getChildProcesses("s1"), [{ pid: 55, command: "python.exe" }]);
  assert.deepEqual(calls, [3000]);
});

test("getChildProcesses returns [] when listPosix missing on posix", async () => {
  const tree = createProcessTree({ platform: "darwin" });
  tree.registerPid("s1", 1234);
  assert.deepEqual(await tree.getChildProcesses("s1"), []);
});

test("getChildProcesses returns [] when listWindows missing on windows", async () => {
  const tree = createProcessTree({ platform: "win32" });
  tree.registerPid("s1", 3000);
  assert.deepEqual(await tree.getChildProcesses("s1"), []);
});

test("registerPid warns when overwriting an existing sessionId with a different pid", async () => {
  const warnCalls = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const tree = createProcessTree({ platform: "darwin", listPosix: async () => [] });
    tree.registerPid("s1", 1234);
    tree.registerPid("s1", 1234); // same pid — no warn
    tree.registerPid("s1", 5678); // different — should warn
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0][0], /s1/);
    assert.match(warnCalls[0][0], /1234/);
    assert.match(warnCalls[0][0], /5678/);
  } finally {
    console.warn = origWarn;
  }
});
