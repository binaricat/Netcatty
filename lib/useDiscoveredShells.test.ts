import test from "node:test";
import assert from "node:assert/strict";

import { matchesSearchQuery } from "../domain/searchMatcher";
import { buildQuickSwitcherShells, resolveShellSetting } from "./useDiscoveredShells";

const DISCOVERED: DiscoveredShell[] = [
  { id: "git-bash", name: "Git Bash", command: "C:\\Git\\bin\\bash.exe", args: ["--login", "-i"], icon: "git-bash" },
];

const WINDOWS_SHELLS: DiscoveredShell[] = [
  { id: "cmd", name: "CMD", command: "cmd.exe", args: [], icon: "cmd" },
  { id: "powershell", name: "Windows PowerShell", command: "powershell.exe", args: ["-NoLogo"], icon: "powershell", isDefault: true },
  { id: "pwsh", name: "PowerShell 7", command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo"], icon: "pwsh" },
];

test("resolveShellSetting returns null for empty value", () => {
  assert.equal(resolveShellSetting("", DISCOVERED), null);
});

test("resolveShellSetting passes custom args through for a custom path", () => {
  const resolved = resolveShellSetting("C:\\msys64\\usr\\bin\\bash.exe", DISCOVERED, ["--login", "-i"]);
  assert.equal(resolved?.command, "C:\\msys64\\usr\\bin\\bash.exe");
  assert.deepEqual(resolved?.args, ["--login", "-i"]);
});

test("resolveShellSetting omits args when custom args are empty (preserves bridge fallback)", () => {
  const resolved = resolveShellSetting("/usr/local/bin/fish", DISCOVERED, []);
  assert.equal(resolved?.command, "/usr/local/bin/fish");
  assert.equal(resolved?.args, undefined);
});

test("resolveShellSetting omits args when no custom args are given", () => {
  const resolved = resolveShellSetting("/usr/local/bin/fish", DISCOVERED);
  assert.equal(resolved?.command, "/usr/local/bin/fish");
  assert.equal(resolved?.args, undefined);
});

test("resolveShellSetting uses discovered shell args when value matches and no custom args are given", () => {
  const resolved = resolveShellSetting("git-bash", DISCOVERED);
  assert.equal(resolved?.command, "C:\\Git\\bin\\bash.exe");
  assert.deepEqual(resolved?.args, ["--login", "-i"]);
});

test("resolveShellSetting prefers explicit custom args when value collides with a discovered shell id", () => {
  const resolved = resolveShellSetting("git-bash", DISCOVERED, ["--private"]);
  assert.equal(resolved?.command, "C:\\Git\\bin\\bash.exe");
  assert.deepEqual(resolved?.args, ["--private"]);
});

test("buildQuickSwitcherShells keeps discovered defaults when no local shell is configured", () => {
  const shells = buildQuickSwitcherShells(WINDOWS_SHELLS, "");
  assert.equal(shells.find((shell) => shell.id === "powershell")?.isDefault, true);
  assert.equal(shells.find((shell) => shell.id === "pwsh")?.isDefault, undefined);
});

test("buildQuickSwitcherShells marks a configured discovered shell as default", () => {
  const shells = buildQuickSwitcherShells(WINDOWS_SHELLS, "pwsh");
  const pwsh = shells.find((shell) => shell.id === "pwsh");
  assert.equal(pwsh?.isDefault, true);
  assert.equal(pwsh?.command, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.deepEqual(pwsh?.args, ["-NoLogo"]);
  assert.equal(shells.find((shell) => shell.id === "powershell")?.isDefault, false);
});

test("buildQuickSwitcherShells maps a custom pwsh.exe setting onto the PowerShell quick switch entry", () => {
  const shells = buildQuickSwitcherShells(
    WINDOWS_SHELLS.filter((shell) => shell.id !== "pwsh"),
    "pwsh.exe",
  );
  const powershell = shells.find((shell) => shell.id === "powershell");
  assert.equal(powershell?.isDefault, true);
  assert.equal(powershell?.name, "PowerShell 7");
  assert.equal(powershell?.command, "pwsh.exe");
  assert.equal(powershell?.icon, "pwsh");
  assert.equal(shells.find((shell) => shell.id === "cmd")?.isDefault, false);
});

test("custom quick switch shells remain searchable by executable name", () => {
  const shells = buildQuickSwitcherShells(
    WINDOWS_SHELLS.filter((shell) => shell.id !== "pwsh"),
    "pwsh.exe",
  );
  const powershell = shells.find((shell) => shell.id === "powershell");
  assert.ok(powershell);
  assert.equal(matchesSearchQuery("pwsh", powershell.name, powershell.id, powershell.command), true);
});

test("buildQuickSwitcherShells matches custom shell paths by full command before basename fallback", () => {
  const shells = buildQuickSwitcherShells([
    { id: "bash-system", name: "Bash (/bin/bash)", command: "/bin/bash", args: ["-l"], icon: "bash", isDefault: true },
    { id: "bash-homebrew", name: "Bash (/opt/homebrew/bin/bash)", command: "/opt/homebrew/bin/bash", args: ["-l"], icon: "bash" },
  ], "/opt/homebrew/bin/bash");

  assert.equal(shells.find((shell) => shell.id === "bash-system")?.isDefault, false);
  assert.equal(shells.find((shell) => shell.id === "bash-homebrew")?.isDefault, true);
});
