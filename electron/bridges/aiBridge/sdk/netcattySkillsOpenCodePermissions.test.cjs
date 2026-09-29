const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
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
} = require("./netcattySkillsOpenCodePermissions.cjs");

// Mirrors OpenCode's Wildcard.match (packages/core/src/util/wildcard.ts):
// inputs and patterns are normalized to forward slashes, "*" matches any
// run of characters, and matching is anchored to the whole string.
function openCodeWildcardMatch(input, pattern) {
  const normalized = input.replaceAll("\\", "/");
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(normalized);
}

function matchesAnyPattern(input, patterns) {
  return patterns.some((pattern) => openCodeWildcardMatch(input, pattern));
}

// Mirrors OpenCode's Permission.evaluate: rules come from Object.entries of
// the config map in insertion order, and the last matching rule wins.
function evaluateOpenCodeRuleMap(input, ruleMap) {
  let action;
  for (const [pattern, ruleAction] of Object.entries(ruleMap)) {
    if (openCodeWildcardMatch(input, pattern)) action = ruleAction;
  }
  return action;
}

test("toOpenCodeFileParentGlob maps files to parent directory globs", () => {
  assert.equal(
    toOpenCodeFileParentGlob("/Applications/Netcatty.app/Contents/MacOS/netcatty-tool-cli"),
    "/Applications/Netcatty.app/Contents/MacOS/**",
  );
  assert.equal(
    toOpenCodeFileParentGlob("/tmp/netcatty/skills/netcatty-tool-cli/SKILL.md"),
    "/tmp/netcatty/skills/netcatty-tool-cli/**",
  );
});

test("toOpenCodeDirectoryGlob keeps directory roots stable when missing on disk", () => {
  assert.equal(
    toOpenCodeDirectoryGlob("/Users/me/Library/Application Support/netcatty/netcatty-tool-cli"),
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
  );
});

test("toOpenCodeDirectoryPermissionPatterns includes exact and wildcard forms", () => {
  assert.deepEqual(
    toOpenCodeDirectoryPermissionPatterns("/Users/me/Library/Application Support/netcatty/netcatty-tool-cli"),
    [
      "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli",
      "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/*",
      "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
    ],
  );
});

test("toOpenCodeFileParentPermissionPatterns normalizes Windows paths", () => {
  assert.deepEqual(
    toOpenCodeFileParentPermissionPatterns(
      "C:\\Users\\me\\AppData\\Local\\Programs\\Netcatty\\resources\\app.asar.unpacked\\electron\\cli\\netcatty-tool-cli.cmd",
      { platform: "win32", pathModule: path.win32 },
    ),
    [
      "C:/Users/me/AppData/Local/Programs/Netcatty/resources/app.asar.unpacked/electron/cli",
      "C:/Users/me/AppData/Local/Programs/Netcatty/resources/app.asar.unpacked/electron/cli/*",
      "C:/Users/me/AppData/Local/Programs/Netcatty/resources/app.asar.unpacked/electron/cli/**",
    ],
  );
});

test("buildNetcattySkillsOpenCodePathAllowlist dedupes launcher and script roots", () => {
  const launcher = "/Applications/Netcatty.app/Contents/MacOS/netcatty-tool-cli";
  const script = "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/electron/cli/netcatty-tool-cli.cjs";
  const skill = "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/skills/netcatty-tool-cli/SKILL.md";
  const patterns = buildNetcattySkillsOpenCodePathAllowlist({
    launcherPath: launcher,
    cliScriptPath: script,
    skillPath: skill,
    discoveryFilePath: "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/discovery.json",
    cliStateDir: "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli",
  });

  assert.deepEqual(patterns, [
    "/Applications/Netcatty.app/Contents/MacOS",
    "/Applications/Netcatty.app/Contents/MacOS/*",
    "/Applications/Netcatty.app/Contents/MacOS/**",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/electron/cli",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/electron/cli/*",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/electron/cli/**",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/skills/netcatty-tool-cli",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/skills/netcatty-tool-cli/*",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/skills/netcatty-tool-cli/**",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/*",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
  ]);
});

test("buildNetcattySkillsOpenCodePathAllowlist includes temp dir and extra attachment paths", () => {
  const patterns = buildNetcattySkillsOpenCodePathAllowlist({
    discoveryFilePath: "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/discovery.json",
    tempDir: "/var/folders/tmp/Netcatty",
    extraFilePaths: ["/var/folders/tmp/Netcatty/ai-attachment-1.png"],
  });

  assert.deepEqual(patterns, [
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/*",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
    "/var/folders/tmp/Netcatty",
    "/var/folders/tmp/Netcatty/*",
    "/var/folders/tmp/Netcatty/**",
  ]);
});

test("buildNetcattySkillsOpenCodePathAllowlist includes OpenCode-compatible Windows directory resources", () => {
  const patterns = buildNetcattySkillsOpenCodePathAllowlist({
    launcherPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Netcatty\\resources\\app.asar.unpacked\\electron\\cli\\netcatty-tool-cli.cmd",
    cliScriptPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Netcatty\\resources\\app.asar.unpacked\\electron\\cli\\netcatty-tool-cli.cjs",
    skillPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Netcatty\\resources\\app.asar.unpacked\\skills\\netcatty-tool-cli\\SKILL.md",
    discoveryFilePath: "C:\\Users\\me\\AppData\\Roaming\\netcatty\\netcatty-tool-cli\\discovery.json",
    runtimeBinaryPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Netcatty\\Netcatty.exe",
    tempDir: "C:\\Users\\me\\AppData\\Local\\Temp\\Netcatty",
    extraFilePaths: ["C:\\Users\\me\\AppData\\Local\\Temp\\Netcatty\\attachment.png"],
  }, { platform: "win32", pathModule: path.win32 });

  assert.equal(patterns.includes("C:/Users/me/AppData/Local/Programs/Netcatty/resources/app.asar.unpacked/electron/cli/*"), true);
  assert.equal(patterns.includes("C:/Users/me/AppData/Roaming/netcatty/netcatty-tool-cli/*"), true);
  assert.equal(patterns.includes("C:/Users/me/AppData/Local/Temp/Netcatty/*"), true);
  assert.equal(patterns.includes("C:/Users/me/AppData/Local/Programs/Netcatty/*"), true);
});

test("buildOpenCodeSkillsPermissionRules allowlists Netcatty CLI paths and denies other external access", () => {
  const rules = buildOpenCodeSkillsPermissionRules([
    "/Applications/Netcatty.app/Contents/MacOS/**",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
  ]);

  assert.equal(rules.bash, "allow");
  assert.equal(rules.skill, "allow");
  assert.equal(rules.list, "deny");
  assert.equal(rules.external_directory["*"], "deny");
  assert.equal(rules.external_directory["/Applications/Netcatty.app/Contents/MacOS/**"], "allow");
  assert.equal(rules.external_directory["/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**"], "allow");
  assert.equal(rules.read["/Applications/Netcatty.app/Contents/MacOS/**"], "allow");
  assert.equal(rules.read["/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**"], "allow");
  assert.equal(rules.read["*"], undefined);
  // Allowlist entries must come after the catch-all deny so OpenCode's
  // last-matching-rule-wins evaluation keeps them effective.
  assert.equal(Object.keys(rules.external_directory)[0], "*");
});

test("buildOpenCodeNativeSkillsPermissionRules keeps OpenCode native skill dirs readable", () => {
  const rules = buildOpenCodeNativeSkillsPermissionRules();
  assert.equal(rules.skill, "allow");
  assert.equal(rules.external_directory["*"], "deny");
  for (const pattern of buildOpenCodeNativeSkillPermissionPatterns()) {
    assert.equal(rules.external_directory[pattern], "allow");
    assert.equal(rules.read[pattern], "allow");
  }
  for (const pattern of buildOpenCodeNativeSkillEnvDenyPatterns()) {
    assert.equal(rules.read[pattern], "deny");
  }
});

test("native skill read rules re-deny dot-env files inside skill dirs (last match wins)", () => {
  const { read } = buildOpenCodeNativeSkillsPermissionRules();

  // Regular skill files stay allowed.
  assert.equal(evaluateOpenCodeRuleMap("../../.opencode/skills/foo/references/doc.md", read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("C:/Users/me/.config/opencode/skills/foo/SKILL.md", read), "allow");

  // Dot-env secret files under skill dirs must not be silently readable.
  assert.equal(evaluateOpenCodeRuleMap("../../.opencode/skills/foo/.env", read), "deny");
  assert.equal(evaluateOpenCodeRuleMap("C:/Users/me/.config/opencode/skills/foo/.env", read), "deny");
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.claude/skills/foo/.env.local", read), "deny");
  assert.equal(evaluateOpenCodeRuleMap("..\\..\\.agents\\skills\\foo\\references\\prod.env", read), "deny");
});

test("native skill patterns match OpenCode permission requests for skill files (issue #1939)", () => {
  const patterns = buildOpenCodeNativeSkillPermissionPatterns();

  // external_directory asks with an absolute parent-directory glob
  // (forward slashes on Windows after FSUtil.normalizePathPattern).
  assert.equal(matchesAnyPattern("C:/Users/me/.opencode/skills/my-skill/references/*", patterns), true);
  assert.equal(matchesAnyPattern("/home/me/.config/opencode/skills/my-skill/*", patterns), true);
  assert.equal(matchesAnyPattern("/Users/me/.claude/skills/my-skill/references/*", patterns), true);
  assert.equal(matchesAnyPattern("/Users/me/.agents/skills/my-skill/*", patterns), true);
  assert.equal(matchesAnyPattern("/Users/me/.cache/opencode/skills/abc123/my-skill/*", patterns), true);

  // read asks with a worktree-relative path (Windows backslashes included).
  assert.equal(matchesAnyPattern("..\\..\\.opencode\\skills\\my-skill\\references\\doc.md", patterns), true);
  assert.equal(matchesAnyPattern("../.config/opencode/skills/my-skill/SKILL.md", patterns), true);
  assert.equal(matchesAnyPattern(".opencode/skills/my-skill/references/doc.md", patterns), true);

  // unrelated external paths stay denied
  assert.equal(matchesAnyPattern("C:/Users/me/Documents/secret.txt/*", patterns), false);
  assert.equal(matchesAnyPattern("../../etc/passwd", patterns), false);
  assert.equal(matchesAnyPattern("C:/Users/me/.ssh/id_rsa", patterns), false);
});

test("MiMo native skills can read references from default and overridden roots without reading env files", () => {
  const options = {
    mimo: true,
    cwd: "/work/project",
    env: {
      HOME: "/home/me",
      MIMOCODE_HOME: "/opt/mimo-home",
      MIMOCODE_CONFIG_DIR: "/opt/mimo-extra",
      XDG_CONFIG_HOME: "/opt/xdg-config",
    },
  };
  const rules = buildOpenCodeSkillsPermissionRules(["/opt/netcatty-tool/**"], options);
  const readable = [
    "/home/me/.mimocode/skills/one/references/guide.md",
    "/home/me/.config/mimocode/skill/one/references/guide.md",
    "/home/me/.local/share/mimocode/builtin_skills/0.1.15/skills/one/references/guide.md",
    "/home/me/.cache/mimocode/skills/one/references/guide.md",
    "/opt/mimo-home/data/compose/0.1.15/skills/one/references/guide.md",
    "/opt/mimo-home/config/skill/one/references/guide.md",
    "/opt/mimo-extra/skills/one/references/guide.md",
    "/opt/xdg-config/mimocode/skills/one/references/guide.md",
  ];
  for (const file of readable) {
    assert.equal(evaluateOpenCodeRuleMap(file, rules.read), "allow", file);
    assert.equal(evaluateOpenCodeRuleMap(path.posix.dirname(file), rules.external_directory), "allow", file);
  }
  assert.equal(evaluateOpenCodeRuleMap("/opt/mimo-home/config/skill/one/.env", rules.read), "deny");
  assert.equal(evaluateOpenCodeRuleMap("../../opt/mimo-home/config/skill/one/references/guide.md", rules.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("../../opt/mimo-home/config/skill/one/.env", rules.read), "deny");
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.mimocode/skills/one/.env.local", rules.read), "deny");
  assert.equal(evaluateOpenCodeRuleMap("/opt/unrelated/secret.md", rules.read), undefined);
  assert.equal(evaluateOpenCodeRuleMap("/opt/other/.mimocode/skills/private/secret.txt", rules.read), undefined);
  assert.equal(evaluateOpenCodeRuleMap("/opt/unrelated", rules.external_directory), "deny");
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.mimocode/skills/one/references/guide.md", buildOpenCodeNativeSkillsPermissionRules().read), undefined);
});

test("MiMo native skills can read macOS built-in skill references", () => {
  const rules = buildOpenCodeNativeSkillsPermissionRules({
    mimo: true,
    platform: "darwin",
    cwd: "/Users/me/work/project",
    env: { HOME: "/Users/me" },
  });
  const file = "/Users/me/Library/Application Support/mimocode/builtin_skills/0.1.15/skills/one/references/guide.md";
  assert.equal(evaluateOpenCodeRuleMap(file, rules.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("../../Library/Application Support/mimocode/builtin_skills/0.1.15/skills/one/references/guide.md", rules.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap(path.posix.dirname(file), rules.external_directory), "allow");
  assert.equal(evaluateOpenCodeRuleMap("../../Library/Application Support/mimocode/builtin_skills/0.1.15/skills/one/.env", rules.read), "deny");
});

test("MiMo native skill reads include ancestor projects but exclude unrelated projects", () => {
  const rules = buildOpenCodeNativeSkillsPermissionRules({
    mimo: true,
    cwd: "/work/project/subdir",
    env: { HOME: "/home/me" },
  });
  assert.equal(evaluateOpenCodeRuleMap("/work/project/.mimocode/skills/one/reference.md", rules.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("/work/project/.agents/skills/one/reference.md", rules.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("/opt/other/.mimocode/skills/one/secret.txt", rules.read), undefined);
});

test("MiMo native skill reads accept a canonical path for an aliased project directory", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mimo-aliased-project-"));
  try {
    const rules = buildOpenCodeNativeSkillsPermissionRules({ mimo: true, cwd: project });
    const canonical = fs.realpathSync(project);
    assert.equal(evaluateOpenCodeRuleMap(`${canonical}/.mimocode/skills/one/reference.md`, rules.read), "allow");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("MiMo native skills can read Windows built-in skill references", () => {
  const rules = buildOpenCodeNativeSkillsPermissionRules({
    mimo: true,
    platform: "win32",
    pathModule: path.win32,
    cwd: "C:\\Users\\me\\work\\project",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
  });
  const file = "C:/Users/me/AppData/Local/mimocode/builtin_skills/0.1.15/skills/one/references/guide.md";
  assert.equal(evaluateOpenCodeRuleMap(file, rules.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap(path.posix.dirname(file), rules.external_directory), "allow");
  assert.equal(evaluateOpenCodeRuleMap("../../AppData/Local/mimocode/builtin_skills/0.1.15/skills/one/references/guide.md", rules.read), "allow");
});

test("MiMo native skill access follows enabled external roots", () => {
  const regular = buildOpenCodeNativeSkillsPermissionRules({ mimo: true, cwd: "/work/project", env: { HOME: "/home/me" } });
  for (const file of ["/home/me/.claude/skills/one/SKILL.md", "/home/me/.codex/skills/one/SKILL.md", "/home/me/.opencode/skills/one/SKILL.md"]) {
    assert.equal(evaluateOpenCodeRuleMap(file, regular.read), undefined, file);
    assert.equal(evaluateOpenCodeRuleMap(path.posix.dirname(file), regular.external_directory), "deny", file);
  }
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.agents/skills/one/SKILL.md", regular.read), "allow");
  const disabledAgents = buildOpenCodeNativeSkillsPermissionRules({ mimo: true, cwd: "/work/project", env: { HOME: "/home/me", MIMOCODE_DISABLE_AGENTS_SKILLS: "true" } });
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.agents/skills/one/SKILL.md", disabledAgents.read), undefined);
  const enabled = buildOpenCodeNativeSkillsPermissionRules({ mimo: true, cwd: "/work/project", env: {
    HOME: "/home/me",
    MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS: "true",
    MIMOCODE_ENABLE_CODEX_SKILLS: "true",
    MIMOCODE_ENABLE_OPENCODE_SKILLS: "true",
  } });
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.claude/skills/one/SKILL.md", enabled.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.codex/skills/one/SKILL.md", enabled.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.opencode/skills/one/SKILL.md", enabled.read), "allow");
  const numeric = buildOpenCodeNativeSkillsPermissionRules({ mimo: true, cwd: "/work/project", env: {
    HOME: "/home/me",
    MIMOCODE_ENABLE_CODEX_SKILLS: "1",
    MIMOCODE_DISABLE_AGENTS_SKILLS: "1",
  } });
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.codex/skills/one/SKILL.md", numeric.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("/home/me/.agents/skills/one/SKILL.md", numeric.read), undefined);
});

test("MiMo native skill rules allow configured custom skill paths", () => {
  const rules = buildOpenCodeNativeSkillsPermissionRules({
    mimo: true,
    cwd: "/work/project",
    env: { HOME: "/home/me" },
    skillPaths: ["/opt/team-skills", "./project-skills", "~/personal-skills"],
  });
  for (const file of [
    "/opt/team-skills/one/references/checklist.md",
    "/work/project/project-skills/one/references/checklist.md",
    "/home/me/personal-skills/one/references/checklist.md",
  ]) {
    assert.equal(evaluateOpenCodeRuleMap(file, rules.read), "allow", file);
    assert.equal(evaluateOpenCodeRuleMap(path.posix.dirname(file), rules.external_directory), "allow", file);
    assert.equal(evaluateOpenCodeRuleMap(path.posix.dirname(file) + "/.env", rules.read), "deny", file);
  }
  assert.equal(evaluateOpenCodeRuleMap("../../opt/team-skills/one/references/checklist.md", rules.read), "allow");
  assert.equal(evaluateOpenCodeRuleMap("/opt/unrelated/checklist.md", rules.read), undefined);
});

test("MiMo custom skill paths trust the project or the user's global config", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mimo-skills-project-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mimo-skills-external-"));
  const local = path.join(project, "skills");
  const linked = path.join(project, "linked");
  fs.mkdirSync(local);
  fs.symlinkSync(external, linked);
  try {
    assert.deepEqual(
      filterMimoTrustedSkillPaths([local, external, linked, "/etc"], { cwd: project }),
      [fs.realpathSync(local)],
    );
    assert.deepEqual(
      filterMimoTrustedSkillPaths([local, external, linked], { cwd: project, globalSkillPaths: [external] }),
      [fs.realpathSync(local), fs.realpathSync(external)],
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("MiMo skill paths use the checked target if a project link changes later", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mimo-linked-project-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mimo-linked-external-"));
  const local = path.join(project, "skills");
  const linked = path.join(project, "linked-skills");
  fs.mkdirSync(local);
  fs.symlinkSync(local, linked);
  try {
    const checked = filterMimoTrustedSkillPaths([linked], { cwd: project });
    fs.rmSync(linked);
    fs.symlinkSync(external, linked);
    assert.deepEqual(checked, [fs.realpathSync(local)]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});
