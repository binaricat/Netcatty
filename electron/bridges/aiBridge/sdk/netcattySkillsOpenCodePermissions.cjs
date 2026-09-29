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
const MIMO_NATIVE_SKILL_DIR_SUFFIXES = [
  ".mimocode/skill",
  ".mimocode/skills",
  ".config/mimocode/skill",
  ".config/mimocode/skills",
  ".cache/mimocode/skills",
  ".local/share/mimocode/builtin_skills",
  ".local/share/mimocode/compose",
];

function getNativeSkillSuffixes({ mimo = false, env = {} } = {}) {
  if (!mimo) return OPENCODE_NATIVE_SKILL_DIR_SUFFIXES;
  const enabled = (key) => {
    const value = env[key]?.toLowerCase();
    return value === "true" || value === "1";
  };
  const suffixes = [...MIMO_NATIVE_SKILL_DIR_SUFFIXES];
  if (!enabled("MIMOCODE_DISABLE_AGENTS_SKILLS")) suffixes.push(".agents/skills");
  if (enabled("MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS")) suffixes.push(".claude/skills");
  if (enabled("MIMOCODE_ENABLE_CODEX_SKILLS")) suffixes.push(".codex/skills");
  if (enabled("MIMOCODE_ENABLE_OPENCODE_SKILLS")) {
    suffixes.push(...OPENCODE_NATIVE_SKILL_DIR_SUFFIXES.filter((suffix) => suffix.includes("opencode") && !suffix.includes(".cache/")));
  }
  return suffixes;
}

function resolveMimoConfiguredSkillPath(item, { cwd, env = {}, pathModule = path } = {}) {
  if (typeof item !== "string" || !item.trim()) return null;
  const home = [env.HOME, env.USERPROFILE].find((value) => typeof value === "string" && pathModule.isAbsolute(value));
  const expanded = item.startsWith("~/") && home ? pathModule.join(home, item.slice(2)) : item;
  if (expanded.startsWith("~/")) return null;
  return pathModule.isAbsolute(expanded) ? pathModule.resolve(expanded) : pathModule.resolve(cwd || process.cwd(), expanded);
}

function filterMimoTrustedSkillPaths(skillPaths, { cwd, env = {}, globalSkillPaths = [], pathModule = path } = {}) {
  if (!Array.isArray(skillPaths)) return [];
  const resolve = (item) => resolveMimoConfiguredSkillPath(item, { cwd, env, pathModule });
  const globalRoots = new Set((Array.isArray(globalSkillPaths) ? globalSkillPaths : []).map(resolve).filter(Boolean));
  let realCwd;
  try { realCwd = fs.realpathSync(cwd || process.cwd()); } catch {}
  return skillPaths.flatMap((item) => {
    const resolved = resolve(item);
    if (!resolved) return [];
    try {
      const canonical = fs.realpathSync(resolved);
      if (globalRoots.has(resolved)) return [canonical];
      if (!realCwd) return [];
      const relative = pathModule.relative(realCwd, canonical);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative))
        ? [canonical]
        : [];
    } catch {
      return [];
    }
  });
}

function getMimoNativeSkillDirectories({ mimo = false, env = {}, pathModule = path, platform = process.platform, cwd, skillPaths = [] } = {}) {
  if (!mimo) return [];
  const absolute = (value) => typeof value === "string" && pathModule.isAbsolute(value) ? value : null;
  const mimoHome = absolute(env.MIMOCODE_HOME);
  const configDir = absolute(env.MIMOCODE_CONFIG_DIR);
  const xdgConfig = absolute(env.XDG_CONFIG_HOME);
  const xdgData = absolute(env.XDG_DATA_HOME);
  const xdgCache = absolute(env.XDG_CACHE_HOME);
  const macData = platform === "darwin" && absolute(env.HOME)
    ? pathModule.join(env.HOME, "Library", "Application Support", "mimocode")
    : null;
  const winData = platform === "win32" && absolute(env.LOCALAPPDATA)
    ? pathModule.join(env.LOCALAPPDATA, "mimocode")
    : null;
  const custom = (Array.isArray(skillPaths) ? skillPaths : [])
    .map((item) => resolveMimoConfiguredSkillPath(item, { cwd, env, pathModule }))
    .filter(Boolean);
  const home = absolute(env.HOME) || absolute(env.USERPROFILE);
  const nativeSuffixes = getNativeSkillSuffixes({ mimo: true, env });
  const canonical = (base) => {
    try { return fs.realpathSync(base); } catch { return null; }
  };
  const projectSuffixes = nativeSuffixes.filter((suffix) =>
    !suffix.startsWith(".config/") && !suffix.startsWith(".cache/") && !suffix.startsWith(".local/"));
  const projectBases = new Set();
  for (const base of [cwd, cwd && canonical(cwd)]) {
    if (typeof base !== "string" || !pathModule.isAbsolute(base)) continue;
    for (let current = pathModule.resolve(base); !projectBases.has(current); current = pathModule.dirname(current)) {
      projectBases.add(current);
    }
  }
  const scopedDirs = [
    ...[...projectBases].flatMap((base) => projectSuffixes.map((suffix) => pathModule.join(base, suffix))),
    ...[home, home && canonical(home)]
      .filter((base) => typeof base === "string" && pathModule.isAbsolute(base))
      .flatMap((base) => nativeSuffixes.map((suffix) => pathModule.join(base, suffix))),
  ];
  return [
    ...scopedDirs,
    ...(mimoHome ? [
      pathModule.join(mimoHome, "config", "skill"),
      pathModule.join(mimoHome, "config", "skills"),
      pathModule.join(mimoHome, "data", "builtin_skills"),
      pathModule.join(mimoHome, "data", "compose"),
      pathModule.join(mimoHome, "cache", "skills"),
    ] : []),
    ...(configDir ? [pathModule.join(configDir, "skill"), pathModule.join(configDir, "skills")] : []),
    ...(xdgConfig ? [pathModule.join(xdgConfig, "mimocode", "skill"), pathModule.join(xdgConfig, "mimocode", "skills")] : []),
    ...(xdgData ? [pathModule.join(xdgData, "mimocode", "builtin_skills"), pathModule.join(xdgData, "mimocode", "compose")] : []),
    ...(xdgCache ? [pathModule.join(xdgCache, "mimocode", "skills")] : []),
    ...(macData ? [pathModule.join(macData, "builtin_skills"), pathModule.join(macData, "compose")] : []),
    ...(winData ? [pathModule.join(winData, "builtin_skills"), pathModule.join(winData, "compose")] : []),
    ...custom,
  ];
}

function getMimoRelativeSkillDirectory(dir, options = {}) {
  const pathModule = options.pathModule || path;
  const base = toOpenCodeDirectoryBase(dir, options);
  if (!base) return null;
  const cwd = options.cwd || process.cwd();
  const relative = pathModule.relative(pathModule.resolve(cwd), pathModule.resolve(dir));
  return normalizeOpenCodePath(relative || ".", options.platform || process.platform);
}

// OpenCode's `read` permission checks match worktree-relative paths (e.g.
// "../../.opencode/skills/foo/references/doc.md") while `external_directory`
// checks match absolute directory globs ("C:/Users/me/.opencode/skills/foo/*").
// OpenCode's suffix rules predate MiMo. MiMo uses concrete project and user
// roots below, so an unrelated folder named .mimocode/skills is not trusted.
function buildOpenCodeNativeSkillPermissionPatterns(options = {}) {
  return (options.mimo ? [] : getNativeSkillSuffixes(options)).flatMap((suffix) => [
    `*${suffix}`,
    `*${suffix}/*`,
    `*${suffix}/**`,
  ]).concat(getMimoNativeSkillDirectories(options).flatMap((dir) => toOpenCodeDirectoryPermissionPatterns(dir, options)));
}

// OpenCode's default rules gate `.env` secret files behind approval. The
// broad skill-directory read allows above would win over those defaults
// (last matching rule wins), so re-deny dot-env files inside skill dirs
// after the allow entries to keep secret-file protection intact.
function buildOpenCodeNativeSkillEnvDenyPatterns(options = {}) {
  const suffixRules = (options.mimo ? [] : getNativeSkillSuffixes(options)).flatMap((suffix) => [
    `*${suffix}/**.env`,
    `*${suffix}/**.env.*`,
  ]);
  const directoryRules = getMimoNativeSkillDirectories(options).flatMap((dir) => {
    const base = toOpenCodeDirectoryBase(dir, options);
    const relative = getMimoRelativeSkillDirectory(dir, options);
    return base && relative
      ? [`${base}/**.env`, `${base}/**.env.*`, `${relative}/**.env`, `${relative}/**.env.*`]
      : [];
  });
  return suffixRules.concat(directoryRules);
}

// Base rules shared by every tool-integration mode so OpenCode's native
// skills keep working: allow loading skills and reading their files while
// still denying all other external directory access.
function buildOpenCodeNativeSkillsPermissionRules(options = {}) {
  const external_directory = { "*": "deny" };
  const read = {};
  for (const pattern of buildOpenCodeNativeSkillPermissionPatterns(options)) {
    external_directory[pattern] = "allow";
    read[pattern] = "allow";
  }
  for (const dir of getMimoNativeSkillDirectories(options)) {
    const relative = getMimoRelativeSkillDirectory(dir, options);
    if (!relative) continue;
    for (const pattern of [relative, `${relative}/*`, `${relative}/**`]) {
      read[pattern] = "allow";
    }
  }
  for (const pattern of buildOpenCodeNativeSkillEnvDenyPatterns(options)) {
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

function buildOpenCodeSkillsPermissionRules(pathAllowlist = [], nativeSkillOptions = {}) {
  const { read, external_directory } = buildOpenCodeNativeSkillsPermissionRules(nativeSkillOptions);
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
  filterMimoTrustedSkillPaths,
  toOpenCodeDirectoryPermissionPatterns,
  toOpenCodeDirectoryGlob,
  toOpenCodeFileParentPermissionPatterns,
  toOpenCodeFileParentGlob,
};
