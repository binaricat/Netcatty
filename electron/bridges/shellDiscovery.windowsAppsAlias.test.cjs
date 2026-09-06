const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

// shellDiscovery destructures execFileSync at require time, so the fake
// `where.exe` must be installed before the module under test is loaded.
const realExecFileSync = childProcess.execFileSync;
const whereResults = new Map();

childProcess.execFileSync = function fakeExecFileSync(file, args) {
  const argv0 = String(file).toLowerCase();
  const isWhere =
    argv0 === "where.exe" || argv0.endsWith("\\where.exe") || argv0.endsWith("/where.exe");
  if (isWhere) {
    const lines = whereResults.get(args[0]);
    if (lines !== undefined) {
      if (lines === null) {
        throw new Error("not found");
      }
      return lines.join("\r\n");
    }
  }
  // reg.exe / wsl.exe probes from other detectors: treated as missing.
  throw new Error(`unexpected execFileSync call: ${file} ${JSON.stringify(args)}`);
};

const shellDiscovery = require("./shellDiscovery.cjs");

function makeHarness(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-shell-discovery-"));
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

  const aliasPath = path.join(
    tmp,
    "Microsoft",
    "WindowsApps",
    "pwsh.exe",
  );
  // The alias fixture intentionally does NOT exist on disk: real App
  // Execution Aliases fail fs.statSync() with EACCES, so existsSync() is
  // false on a real machine too.

  return { tmp, aliasPath };
}

test("findExecutableOnPath accepts a WindowsApps execution alias as the only candidate", (t) => {
  const { aliasPath } = makeHarness(t);
  whereResults.set("pwsh", [aliasPath]);

  assert.equal(shellDiscovery.findExecutableOnPath("pwsh"), aliasPath);
  whereResults.delete("pwsh");
});

test("findExecutableOnPath prefers a regular executable over an execution alias", (t) => {
  const { tmp, aliasPath } = makeHarness(t);
  const realPwsh = path.join(tmp, "Program Files", "PowerShell", "7", "pwsh.exe");
  fs.mkdirSync(path.dirname(realPwsh), { recursive: true });
  fs.writeFileSync(realPwsh, "");
  whereResults.set("pwsh", [aliasPath, realPwsh]);

  assert.equal(shellDiscovery.findExecutableOnPath("pwsh"), realPwsh);
  whereResults.delete("pwsh");
});

test("findExecutableOnPath returns null when where.exe finds nothing", (t) => {
  makeHarness(t);
  whereResults.set("pwsh", null);

  assert.equal(shellDiscovery.findExecutableOnPath("pwsh"), null);
  whereResults.delete("pwsh");
});

test("discoverWindowsShells lists PowerShell 7 from an MSIX alias and marks it default", (t) => {
  const { aliasPath } = makeHarness(t);
  whereResults.set("pwsh", [aliasPath]);
  whereResults.set("powershell", null);
  t.after(() => {
    whereResults.delete("pwsh");
    whereResults.delete("powershell");
  });

  const shells = shellDiscovery.discoverWindowsShells();
  const pwsh = shells.find((s) => s.id === "pwsh");

  assert.ok(pwsh, "expected a discovered pwsh shell entry");
  assert.equal(pwsh.command, aliasPath);
  assert.equal(pwsh.isDefault, true);
});
