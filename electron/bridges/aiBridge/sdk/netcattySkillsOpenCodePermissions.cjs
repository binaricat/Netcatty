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

// OpenCode discovers native agent skills from these well-known directories:
// its global config dirs (~/.opencode and ~/.config/opencode, both "skill"
// and "skills" spellings), Claude/agents-compatible dirs, project-level
// .opencode/.claude/.agents dirs, and the remote-skill download cache.
// Reads inside them must stay allowed even though Netcatty otherwise locks
// external directory access down, or loading a skill's reference files fails
// with an OpenCode permission error (issue #1939).
const OPENCODE_NATIVE_SKILL_DIR_SUFFIXES = [
  ".opencode/skill",
  ".opencode/skills",
  ".config/opencode/skill",
  ".config/opencode/skills",
  ".claude/skills",
  ".agents/skills",
  ".cache/opencode/skills",
];

// OpenCode's `read` permission checks match worktree-relative paths (e.g.
// "../../.opencode/skills/foo/references/doc.md") while `external_directory`
// checks match absolute directory globs ("C:/Users/me/.opencode/skills/foo/*").
// Anchoring each well-known suffix behind a leading wildcard covers both
// forms on every platform (OpenCode normalizes "\\" to "/" before matching).
function buildOpenCodeNativeSkillPermissionPatterns() {
  return OPENCODE_NATIVE_SKILL_DIR_SUFFIXES.flatMap((suffix) => [
    `*${suffix}`,
    `*${suffix}/*`,
    `*${suffix}/**`,
  ]);
}

// OpenCode's default rules gate `.env` secret files behind approval. The
// broad skill-directory read allows above would win over those defaults
// (last matching rule wins), so re-deny dot-env files inside skill dirs
// after the allow entries to keep secret-file protection intact.
function buildOpenCodeNativeSkillEnvDenyPatterns() {
  return OPENCODE_NATIVE_SKILL_DIR_SUFFIXES.flatMap((suffix) => [
    `*${suffix}/**.env`,
    `*${suffix}/**.env.*`,
  ]);
}

// Base rules shared by every tool-integration mode so OpenCode's native
// skills keep working: allow loading skills and reading their files while
// still denying all other external directory access.
function buildOpenCodeNativeSkillsPermissionRules() {
  const external_directory = { "*": "deny" };
  const read = {};
  for (const pattern of buildOpenCodeNativeSkillPermissionPatterns()) {
    external_directory[pattern] = "allow";
    read[pattern] = "allow";
  }
  for (const pattern of buildOpenCodeNativeSkillEnvDenyPatterns()) {
    read[pattern] = "deny";
  }
  return {
    skill: "allow",
    read,
    external_directory,
  };
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
  const { read, external_directory } = buildOpenCodeNativeSkillsPermissionRules();
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
  buildOpenCodeNativeSkillEnvDenyPatterns,
  buildOpenCodeNativeSkillPermissionPatterns,
  buildOpenCodeNativeSkillsPermissionRules,
  buildOpenCodeSkillsPermissionRules,
  toOpenCodeDirectoryPermissionPatterns,
  toOpenCodeDirectoryGlob,
  toOpenCodeFileParentPermissionPatterns,
  toOpenCodeFileParentGlob,
};
