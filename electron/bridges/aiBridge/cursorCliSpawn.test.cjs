"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareCommandForSpawn } = require("../ai/shellUtils.cjs");
const {
  expandWindowsShimPath,
  parseCursorAgentCmdLaunch,
  resolveCursorAgentNativeLaunch,
  resolveCursorAgentVersionsLaunch,
  resolveCursorCliSpawnSpec,
} = require("./cursorCliSpawn.cjs");

function writeCursorAgentInstall(root, version = "2026.06.01-abc") {
  const versionDir = path.join(root, "versions", version);
  fs.mkdirSync(versionDir, { recursive: true });
  const nodeExe = path.join(versionDir, "node.exe");
  const script = path.join(versionDir, "index.js");
  fs.writeFileSync(nodeExe, "", "utf8");
  fs.writeFileSync(script, "", "utf8");
  const shimPath = path.join(root, "cursor-agent.cmd");
  fs.writeFileSync(
    shimPath,
    `@ECHO off\r\n"%~dp0\\versions\\${version}\\node.exe" "%~dp0\\versions\\${version}\\index.js" %*\r\n`,
    "utf8",
  );
  return { shimPath, nodeExe, script, versionDir };
}

test("expandWindowsShimPath expands %~dp0 relative to the shim directory", () => {
  const shimDir = path.join("C:", "Users", "me", "AppData", "Local", "cursor-agent");
  const resolved = expandWindowsShimPath("%~dp0\\versions\\2026.06.01-abc\\node.exe", shimDir);
  assert.equal(
    path.normalize(resolved),
    path.normalize(path.join(shimDir, "versions", "2026.06.01-abc", "node.exe")),
  );
});

test("parseCursorAgentCmdLaunch reads node.exe + index.js from the installer shim", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-shim-"));
  try {
    const { shimPath, nodeExe, script } = writeCursorAgentInstall(tmp);
    const launch = parseCursorAgentCmdLaunch(shimPath);
    assert.deepEqual(launch, { nodeExe, script });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCursorAgentVersionsLaunch picks the newest version directory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-versions-"));
  try {
    const older = writeCursorAgentInstall(tmp, "2026.01.01-old");
    const newer = writeCursorAgentInstall(tmp, "2026.08.01-new");
    const olderTime = new Date("2026-01-01T00:00:00Z");
    const newerTime = new Date("2026-08-01T00:00:00Z");
    fs.utimesSync(older.versionDir, olderTime, olderTime);
    fs.utimesSync(newer.versionDir, newerTime, newerTime);

    const launch = resolveCursorAgentVersionsLaunch(tmp);
    assert.deepEqual(launch, { nodeExe: newer.nodeExe, script: newer.script });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCursorAgentNativeLaunch prefers the shim's node+script over a lone exe unwrap", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-native-"));
  try {
    const { shimPath, nodeExe, script } = writeCursorAgentInstall(tmp);
    const launch = resolveCursorAgentNativeLaunch(shimPath);
    assert.deepEqual(launch, { nodeExe, script });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCursorCliSpawnSpec puts the prompt on argv, not a cmd.exe line", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-spawn-"));
  try {
    const { shimPath, nodeExe, script } = writeCursorAgentInstall(tmp);
    const prompt = 'do "%USERPROFILE%" and `whoami` then say hello';
    const spec = resolveCursorCliSpawnSpec(shimPath, ["--print", "--trust", prompt]);
    assert.deepEqual(spec, {
      command: nodeExe,
      args: [script, "--print", "--trust", prompt],
      shell: false,
    });
    assert.equal(spec.command.includes("cmd.exe"), false);
    assert.equal(spec.args.includes(prompt), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCursorCliSpawnSpec falls back to the cmd shim when versions/ is missing", () => {
  const shim = "C:\\Users\\me\\AppData\\Local\\cursor-agent\\cursor-agent.cmd";
  const args = ["status", "--format", "json"];
  const spec = resolveCursorCliSpawnSpec(shim, args, {
    exists: () => false,
    readFile: () => { throw new Error("missing"); },
  });
  assert.deepEqual(spec, prepareCommandForSpawn(shim, args, { unwrapNativeExe: false }));
});
