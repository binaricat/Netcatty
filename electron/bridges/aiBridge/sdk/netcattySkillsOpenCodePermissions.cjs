"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeOpenCodePath(targetPath) {
  return process.platform === "win32"
    ? targetPath.replace(/\\/g, "/")
    : targetPath;
}

function toOpenCodeDirectoryGlob(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return null;
  try {
    const resolved = path.resolve(dirPath);
    let baseDir = resolved;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      baseDir = path.dirname(resolved);
    }
    return `${normalizeOpenCodePath(baseDir)}/**`;
  } catch {
    return null;
  }
}

function toOpenCodeFileParentGlob(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  try {
    return toOpenCodeDirectoryGlob(path.dirname(path.resolve(filePath)));
  } catch {
    return null;
  }
}

function dedupePatterns(patterns) {
  return [...new Set(patterns.filter(Boolean))];
}

function buildNetcattySkillsOpenCodePathAllowlist({
  launcherPath,
  cliScriptPath,
  skillPath,
  discoveryFilePath,
  cliStateDir,
  runtimeBinaryPath,
  tempDir,
  extraFilePaths,
} = {}) {
  const filePaths = [
    launcherPath,
    cliScriptPath,
    skillPath,
    discoveryFilePath,
    runtimeBinaryPath,
    ...(Array.isArray(extraFilePaths) ? extraFilePaths : []),
  ];
  return dedupePatterns([
    ...filePaths.map((filePath) => filePath && toOpenCodeFileParentGlob(filePath)),
    cliStateDir && toOpenCodeDirectoryGlob(cliStateDir),
    tempDir && toOpenCodeDirectoryGlob(tempDir),
  ]);
}

function buildOpenCodeSkillsPermissionRules(pathAllowlist = []) {
  const external_directory = { "*": "deny" };
  const read = {};
  for (const pattern of pathAllowlist) {
    external_directory[pattern] = "allow";
    read[pattern] = "allow";
  }

  return {
    bash: "allow",
    read,
    list: "deny",
    glob: "deny",
    grep: "deny",
    skill: "allow",
    external_directory,
  };
}

module.exports = {
  buildNetcattySkillsOpenCodePathAllowlist,
  buildOpenCodeSkillsPermissionRules,
  toOpenCodeDirectoryGlob,
  toOpenCodeFileParentGlob,
};
