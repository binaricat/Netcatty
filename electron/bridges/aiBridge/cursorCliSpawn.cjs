"use strict";

/**
 * Windows launch helper for the Cursor Agent installer shim.
 *
 * `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` is a batch file that runs
 * `versions\<id>\node.exe` + `versions\<id>\index.js`. Node cannot spawn .cmd
 * directly (EINVAL). Routing the full turn prompt through cmd.exe is also
 * unsafe: 8191-char limit, %VAR% expansion, and broken quote escaping.
 *
 * Prefer the native node+script argv so prompts stay out of a shell.
 */
const fs = require("node:fs");
const path = require("node:path");
const { prepareCommandForSpawn } = require("../ai/shellUtils.cjs");

function defaultExists(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function defaultReadFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function defaultReaddir(dirPath) {
  return fs.readdirSync(dirPath);
}

function defaultStat(filePath) {
  return fs.statSync(filePath);
}

function expandWindowsShimPath(raw, shimDir) {
  const dp0 = /[\\/]$/.test(shimDir) ? shimDir : `${shimDir}${path.sep}`;
  let resolved = String(raw || "").replace(/%~dp0/gi, dp0);
  // Installer shims use Windows separators; normalize so existsSync works
  // when this helper is unit-tested on POSIX.
  resolved = resolved.replace(/\\/g, path.sep);
  if (!path.isAbsolute(resolved) && !path.win32.isAbsolute(resolved)) {
    resolved = path.resolve(shimDir, resolved);
  }
  return path.normalize(resolved);
}

function parseCursorAgentCmdLaunch(shimPath, { exists, readFile } = {}) {
  const existsFn = exists || defaultExists;
  const readFn = readFile || defaultReadFile;
  let contents;
  try {
    contents = readFn(shimPath);
  } catch {
    return null;
  }
  const match = String(contents || "").match(/"([^"\r\n]*node\.exe)"\s+"([^"\r\n]*index\.js)"/i);
  if (!match) return null;
  const shimDir = path.dirname(shimPath);
  const nodeExe = expandWindowsShimPath(match[1], shimDir);
  const script = expandWindowsShimPath(match[2], shimDir);
  if (!existsFn(nodeExe) || !existsFn(script)) return null;
  return { nodeExe, script };
}

function resolveCursorAgentVersionsLaunch(installDir, { exists, readdir, stat } = {}) {
  const existsFn = exists || defaultExists;
  const readdirFn = readdir || defaultReaddir;
  const statFn = stat || defaultStat;
  const versionsDir = path.join(installDir, "versions");
  if (!existsFn(versionsDir)) return null;
  let names;
  try {
    names = readdirFn(versionsDir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    const dir = path.join(versionsDir, name);
    const nodeExe = path.join(dir, "node.exe");
    const script = path.join(dir, "index.js");
    if (!existsFn(nodeExe) || !existsFn(script)) continue;
    let mtime = 0;
    try { mtime = Number(statFn(dir)?.mtimeMs) || 0; } catch { /* ignore */ }
    candidates.push({ name: String(name), nodeExe, script, mtime });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  return { nodeExe: candidates[0].nodeExe, script: candidates[0].script };
}

function resolveCursorAgentNativeLaunch(binPath, io = {}) {
  const normalized = String(binPath || "").trim();
  if (!normalized) return null;
  const ext = path.extname(normalized).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return null;

  const fromShim = parseCursorAgentCmdLaunch(normalized, io);
  if (fromShim) return fromShim;

  return resolveCursorAgentVersionsLaunch(path.dirname(normalized), io);
}

function resolveCursorCliSpawnSpec(binPath, args, io = {}) {
  const command = String(binPath || "").trim();
  const spawnArgs = Array.isArray(args) ? args : [];
  const native = resolveCursorAgentNativeLaunch(command, io);
  if (native) {
    return {
      command: native.nodeExe,
      args: [native.script, ...spawnArgs],
      shell: false,
    };
  }
  // Last resort for unknown shims / short probes (status, models). Turns with
  // a long prompt should have resolved the official versions/ layout above.
  return prepareCommandForSpawn(command, spawnArgs, { unwrapNativeExe: false });
}

module.exports = {
  expandWindowsShimPath,
  parseCursorAgentCmdLaunch,
  resolveCursorAgentNativeLaunch,
  resolveCursorAgentVersionsLaunch,
  resolveCursorCliSpawnSpec,
};
