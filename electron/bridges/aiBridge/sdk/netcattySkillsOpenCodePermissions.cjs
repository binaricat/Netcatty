"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeOpenCodePath(targetPath, platform = process.platform) {
  return platform === "win32"
    ? targetPath.replace(/\\/g, "/")
    : targetPath;
}

function appendOpenCodePathPattern(baseDir, suffix) {
  const trimmedSuffix = suffix.replace(/^\//, "");
  return baseDir.endsWith("/")
    ? `${baseDir}${trimmedSuffix}`
    : `${baseDir}/${trimmedSuffix}`;
}

function toOpenCodeDirectoryBase(dirPath, options = {}) {
  if (!dirPath || typeof dirPath !== "string") return null;
  const pathModule = options.pathModule || path;
  const platform = options.platform || process.platform;
  try {
    const resolved = pathModule.resolve(dirPath);
    let baseDir = resolved;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      baseDir = pathModule.dirname(resolved);
    }
    return normalizeOpenCodePath(baseDir, platform);
  } catch {
    return null;
  }
}

function toOpenCodeDirectoryGlob(dirPath, options = {}) {
  const baseDir = toOpenCodeDirectoryBase(dirPath, options);
  return baseDir ? appendOpenCodePathPattern(baseDir, "**") : null;
}

function toOpenCodeDirectoryPermissionPatterns(dirPath, options = {}) {
  const baseDir = toOpenCodeDirectoryBase(dirPath, options);
  return baseDir
    ? [
        baseDir,
        appendOpenCodePathPattern(baseDir, "*"),
        appendOpenCodePathPattern(baseDir, "**"),
      ]
    : [];
}

function toOpenCodeFileParentGlob(filePath, options = {}) {
  if (!filePath || typeof filePath !== "string") return null;
  const pathModule = options.pathModule || path;
  try {
    return toOpenCodeDirectoryGlob(pathModule.dirname(pathModule.resolve(filePath)), options);
  } catch {
    return null;
  }
}

function toOpenCodeFileParentPermissionPatterns(filePath, options = {}) {
  if (!filePath || typeof filePath !== "string") return [];
  const pathModule = options.pathModule || path;
  try {
    return toOpenCodeDirectoryPermissionPatterns(pathModule.dirname(pathModule.resolve(filePath)), options);
  } catch {
    return [];
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
} = {}, options = {}) {
  const filePaths = [
    launcherPath,
    cliScriptPath,
    skillPath,
    discoveryFilePath,
    runtimeBinaryPath,
    ...(Array.isArray(extraFilePaths) ? extraFilePaths : []),
  ];
  return dedupePatterns([
    ...filePaths.flatMap((filePath) => toOpenCodeFileParentPermissionPatterns(filePath, options)),
    ...(cliStateDir ? toOpenCodeDirectoryPermissionPatterns(cliStateDir, options) : []),
    ...(tempDir ? toOpenCodeDirectoryPermissionPatterns(tempDir, options) : []),
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
  toOpenCodeDirectoryPermissionPatterns,
  toOpenCodeDirectoryGlob,
  toOpenCodeFileParentPermissionPatterns,
  toOpenCodeFileParentGlob,
};
