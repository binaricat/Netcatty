const test = require("node:test");
const assert = require("node:assert/strict");

const {
  POSIX_PROCESS_LIST_TIMEOUT_MS,
  POSIX_PROCESS_LIST_MAX_BUFFER_BYTES,
  createProcessTree,
  defaultListPosix,
  defaultListWindows,
  defaultListWindowsFallback,
} = require("./ptyProcessTree.cjs");

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

test("default posix process listing bounds the child lifetime and captured output", async () => {
  let invocation = null;
  const processes = await defaultListPosix(1234, {
    execFileFn(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null, [
        "2001 1234 node server.js",
        "2002 9999 sleep 100",
        "2003 1234 python worker.py",
      ].join("\n"));
    },
  });

  assert.deepEqual(processes, [
    { pid: 2001, command: "node server.js" },
    { pid: 2003, command: "python worker.py" },
  ]);
  assert.equal(invocation.command, "ps");
  assert.deepEqual(invocation.args, ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="]);
  assert.equal(invocation.options.timeout, POSIX_PROCESS_LIST_TIMEOUT_MS);
  assert.equal(invocation.options.maxBuffer, POSIX_PROCESS_LIST_MAX_BUFFER_BYTES);
  assert.equal(invocation.options.windowsHide, true);
});

test("default posix process listing returns an empty result after command failure", async () => {
  const processes = await defaultListPosix(1234, {
    execFileFn(_command, _args, _options, callback) {
      callback(Object.assign(new Error("timed out"), { killed: true }), "");
    },
  });
  assert.deepEqual(processes, []);
});

test("default windows process listing uses native addon when available", async () => {
  let fallbackCalled = false;
  const processes = await defaultListWindows(4242, {
    loadWindowsProcessTree: () => ({
      getProcessTree(pid, callback) {
        assert.equal(pid, 4242);
        callback({
          pid: 4242,
          name: "pwsh.exe",
          children: [{ pid: 5001, name: "python.exe" }],
        });
      },
    }),
    execFileFn() {
      fallbackCalled = true;
    },
  });

  assert.equal(fallbackCalled, false);
  assert.deepEqual(processes, [{ pid: 5001, command: "python.exe" }]);
});

test("default windows process listing falls back to PowerShell CIM query when native addon is unavailable", async () => {
  let invocation = null;
  const processes = await defaultListWindows(4242, {
    loadWindowsProcessTree: () => {
      throw new Error("Cannot find module windows_process_tree.node");
    },
    execFileFn(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null, "5001\tpython.exe\r\n5002\tnode.exe\r\n");
    },
  });

  assert.deepEqual(processes, [
    { pid: 5001, command: "python.exe" },
    { pid: 5002, command: "node.exe" },
  ]);
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.options.timeout, POSIX_PROCESS_LIST_TIMEOUT_MS);
  assert.equal(invocation.options.maxBuffer, POSIX_PROCESS_LIST_MAX_BUFFER_BYTES);
  assert.equal(invocation.options.windowsHide, true);
  assert.match(invocation.args[invocation.args.length - 1], /ParentProcessId = 4242/);
});

test("default windows fallback rejects non-positive pids and handles command errors", async () => {
  let invoked = false;
  assert.deepEqual(
    await defaultListWindowsFallback(0, {
      execFileFn() {
        invoked = true;
      },
    }),
    [],
  );
  assert.equal(invoked, false);

  assert.deepEqual(
    await defaultListWindowsFallback(4242, {
      execFileFn(_command, _args, _options, callback) {
        callback(new Error("powershell failed"), "");
      },
    }),
    [],
  );
});
