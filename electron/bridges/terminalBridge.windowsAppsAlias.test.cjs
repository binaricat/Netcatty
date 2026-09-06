const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const childProcess = require("node:child_process");

function loadBridgeWithFakePty() {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "node-pty") {
      return {
        spawn() {
          throw new Error("node-pty spawn is not exercised by this suite");
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("./terminalBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

const bridge = loadBridgeWithFakePty();

function withWin32Platform(fn) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

// findExecutable() re-requires child_process inside the call, so patching the
// module object's execFileSync at runtime intercepts its `where.exe` probes.
function withWhereFake(resultsByname, fn) {
  const realExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function fakeExecFileSync(file, args) {
    const argv0 = String(file).toLowerCase();
    const isWhere =
      argv0 === "where.exe" || argv0.endsWith("\\where.exe") || argv0.endsWith("/where.exe");
    if (isWhere) {
      const lines = resultsByname.get(args[0]);
      if (lines !== undefined) {
        if (lines === null) {
          throw new Error("not found");
        }
        return lines.join("\r\n");
      }
    }
    throw new Error(`unexpected execFileSync call: ${file} ${JSON.stringify(args)}`);
  };
  try {
    return fn();
  } finally {
    childProcess.execFileSync = realExecFileSync;
  }
}

// Hide machine-specific fallback paths (e.g. an MSI pwsh under Program Files)
// so the tests behave identically regardless of what the host has installed.
function withExistsSyncAllowlist(allowed, fn) {
  const realExistsSync = fs.existsSync;
  fs.existsSync = (p) => allowed.has(String(p));
  try {
    return fn();
  } finally {
    fs.existsSync = realExistsSync;
  }
}

function makeHarness(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-local-shell-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmp;
  t.after(() => {
    if (previousLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = previousLocalAppData;
    }
  });

  const aliasPath = path.join(tmp, "Microsoft", "WindowsApps", "pwsh.exe");
  // Intentionally not created on disk: real App Execution Aliases fail
  // fs.statSync() with EACCES, so existsSync() is false for them anyway.

  const realPwshPath = path.join(tmp, "PowerShell", "7", "pwsh.exe");
  fs.mkdirSync(path.dirname(realPwshPath), { recursive: true });
  fs.writeFileSync(realPwshPath, "");

  const windowsPowerShellPath = path.join(tmp, "WindowsPowerShell", "v1.0", "powershell.exe");
  fs.mkdirSync(path.dirname(windowsPowerShellPath), { recursive: true });
  fs.writeFileSync(windowsPowerShellPath, "");

  return { tmp, aliasPath, realPwshPath, windowsPowerShellPath };
}

test("getDefaultLocalShell resolves an MSIX pwsh execution alias", (t) => {
  const { aliasPath } = makeHarness(t);

  withWin32Platform(() =>
    withWhereFake(new Map([["pwsh", [aliasPath]]]), () => {
      assert.equal(bridge.getDefaultLocalShell(), aliasPath);
    }),
  );
});

test("findExecutable prefers a regular executable listed after an execution alias", (t) => {
  const { aliasPath, realPwshPath } = makeHarness(t);

  withWin32Platform(() =>
    withWhereFake(new Map([["pwsh", [aliasPath, realPwshPath]]]), () => {
      assert.equal(bridge.findExecutable("pwsh"), realPwshPath);
    }),
  );
});

test("getDefaultLocalShell still falls back to Windows PowerShell when no pwsh exists", (t) => {
  const { windowsPowerShellPath } = makeHarness(t);

  withWin32Platform(() =>
    withWhereFake(
      new Map([
        ["pwsh", null],
        ["powershell", [windowsPowerShellPath]],
      ]),
      () =>
        withExistsSyncAllowlist(new Set([windowsPowerShellPath]), () => {
          assert.equal(bridge.getDefaultLocalShell(), windowsPowerShellPath);
        }),
    ),
  );
});

test("getDefaultLocalShell keeps the powershell.exe last-resort fallback", (t) => {
  makeHarness(t);

  withWin32Platform(() =>
    withWhereFake(
      new Map([
        ["pwsh", null],
        ["powershell", null],
      ]),
      () =>
        withExistsSyncAllowlist(new Set(), () => {
          assert.equal(bridge.getDefaultLocalShell(), "powershell.exe");
        }),
    ),
  );
});
