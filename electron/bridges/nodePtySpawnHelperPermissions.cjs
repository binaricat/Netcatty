const fs = require("node:fs");
const path = require("node:path");

function chmodExecutableIfNeeded(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if ((stat.mode & 0o111) !== 0) return false;

  fs.chmodSync(filePath, stat.mode | 0o111);
  return true;
}

function listNodePtySpawnHelperCandidates(packageRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return [
    path.join(packageRoot, "build", "Release", "spawn-helper"),
    path.join(packageRoot, "build", "Debug", "spawn-helper"),
    path.join(packageRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
  ];
}

function ensureNodePtySpawnHelperExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return [];

  const packageRoot = options.packageRoot ?? path.dirname(require.resolve("node-pty/package.json"));
  const changed = [];

  for (const helperPath of listNodePtySpawnHelperCandidates(packageRoot, options)) {
    try {
      if (chmodExecutableIfNeeded(helperPath)) {
        changed.push(helperPath);
      }
    } catch {
      // Best effort: a permission fix must not prevent the app from starting.
    }
  }

  return changed;
}

module.exports = {
  ensureNodePtySpawnHelperExecutable,
  listNodePtySpawnHelperCandidates,
};
