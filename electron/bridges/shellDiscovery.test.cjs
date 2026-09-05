const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isWindowsAppExecutionAlias,
  selectExecutableCandidate,
  windowsAppsAliasPrefix,
} = require("./shellDiscovery.cjs");

const WIN_ENV = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
const ALIAS_DIR = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps";
const ALIAS_PWSH = ALIAS_DIR + "\\pwsh.exe";

/**
 * Build a fake fs module simulating Windows file semantics:
 * - "file": regular file — existsSync/statSync/lstatSync all succeed.
 * - "appExecLink": AppExecLink reparse point — existsSync/statSync fail
 *   (EACCES, nodejs/node#36790), lstatSync sees the reparse point.
 * - "stub": plain zero-byte file (e.g. disabled alias) — all stat calls
 *   succeed but it is not launchable.
 * Missing paths behave like ENOENT everywhere.
 */
const makeFakeFs = (entries) => {
  const kindOf = (p) => entries.get(String(p).toLowerCase());
  const stat = (p) => {
    const kind = kindOf(p);
    if (!kind) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    if (kind === "appExecLink") {
      const err = new Error("EACCES");
      err.code = "EACCES";
      throw err;
    }
    return { isFile: () => true, size: 0 };
  };
  return {
    existsSync: (p) => {
      const kind = kindOf(p);
      return !!kind && kind !== "appExecLink";
    },
    statSync: stat,
    lstatSync: (p) => {
      if (!kindOf(p)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return { isFile: () => true, size: 0 };
    },
  };
};

const WIN_DEPS = (entries) => ({
  fs: makeFakeFs(entries),
  env: WIN_ENV,
  platform: "win32",
});

test("windowsAppsAliasPrefix returns null off Windows", () => {
  assert.equal(windowsAppsAliasPrefix(WIN_ENV, "linux"), null);
  assert.equal(windowsAppsAliasPrefix(WIN_ENV, "darwin"), null);
});

test("windowsAppsAliasPrefix joins LOCALAPPDATA + WindowsApps on win32", () => {
  const prefix = windowsAppsAliasPrefix(WIN_ENV, "win32");
  assert.ok(prefix.startsWith("c:\\users\\u\\appdata\\local"));
  assert.ok(prefix.endsWith("microsoft\\windowsapps\\"));
});

test("isWindowsAppExecutionAlias matches the per-user alias directory", () => {
  assert.equal(isWindowsAppExecutionAlias(ALIAS_PWSH, WIN_ENV, "win32"), true);
  assert.equal(
    isWindowsAppExecutionAlias(ALIAS_DIR + "\\WindowsPowerShell\\pwsh.exe", WIN_ENV, "win32"),
    true,
  );
  assert.equal(
    isWindowsAppExecutionAlias("C:\\Program Files\\PowerShell\\7\\pwsh.exe", WIN_ENV, "win32"),
    false,
  );
  assert.equal(isWindowsAppExecutionAlias(ALIAS_PWSH, WIN_ENV, "linux"), false);
  assert.equal(isWindowsAppExecutionAlias(null, WIN_ENV, "win32"), false);
});

test("selectExecutableCandidate returns the first existing regular file", () => {
  const deps = WIN_DEPS(new Map([
    ["c:\\tools\\pwsh.exe", "file"],
  ]));
  assert.equal(
    selectExecutableCandidate(["C:\\tools\\pwsh.exe", ALIAS_PWSH], deps),
    "C:\\tools\\pwsh.exe",
  );
});

test("selectExecutableCandidate skips missing candidates", () => {
  const deps = WIN_DEPS(new Map());
  assert.equal(selectExecutableCandidate(["C:\\nope\\pwsh.exe"], deps), null);
});

test("selectExecutableCandidate accepts an MSIX app execution alias (issue #3280)", () => {
  // winget MSIX PowerShell 7: only the WindowsApps alias exists, and
  // existsSync()/statSync() fail on its AppExecLink reparse point.
  const deps = WIN_DEPS(new Map([[ALIAS_PWSH.toLowerCase(), "appExecLink"]]));
  assert.equal(selectExecutableCandidate([ALIAS_PWSH], deps), ALIAS_PWSH);
});

test("selectExecutableCandidate rejects a plain zero-byte alias stub", () => {
  // Disabled alias: statSync succeeds (plain file) → not launchable.
  const deps = WIN_DEPS(new Map([[ALIAS_PWSH.toLowerCase(), "stub"]]));
  assert.equal(selectExecutableCandidate([ALIAS_PWSH], deps), null);
});

test("selectExecutableCandidate prefers a real install over the alias", () => {
  const deps = WIN_DEPS(new Map([
    ["c:\\program files\\powershell\\7\\pwsh.exe", "file"],
    [ALIAS_PWSH.toLowerCase(), "appExecLink"],
  ]));
  assert.equal(
    selectExecutableCandidate([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ALIAS_PWSH,
    ], deps),
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  );
  // Alias is still kept as fallback when it comes first in PATH order.
  assert.equal(
    selectExecutableCandidate([
      ALIAS_PWSH,
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ], deps),
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  );
});

test("selectExecutableCandidate falls back to the alias when no real install exists", () => {
  const deps = WIN_DEPS(new Map([
    [ALIAS_PWSH.toLowerCase(), "appExecLink"],
  ]));
  assert.equal(
    selectExecutableCandidate([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ALIAS_PWSH,
    ], deps),
    ALIAS_PWSH,
  );
});

test("selectExecutableCandidate ignores empty candidates", () => {
  const deps = WIN_DEPS(new Map([["c:\\tools\\pwsh.exe", "file"]]));
  assert.equal(
    selectExecutableCandidate(["", "C:\\tools\\pwsh.exe"], deps),
    "C:\\tools\\pwsh.exe",
  );
});
