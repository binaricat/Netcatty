const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildNetcattySkillsOpenCodePathAllowlist,
  buildOpenCodeSkillsPermissionRules,
  toOpenCodeDirectoryPermissionPatterns,
  toOpenCodeDirectoryGlob,
  toOpenCodeFileParentPermissionPatterns,
  toOpenCodeFileParentGlob,
} = require("./netcattySkillsOpenCodePermissions.cjs");

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
  assert.deepEqual(rules.external_directory, {
    "/Applications/Netcatty.app/Contents/MacOS/**": "allow",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**": "allow",
    "*": "deny",
  });
  assert.deepEqual(rules.read, {
    "/Applications/Netcatty.app/Contents/MacOS/**": "allow",
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**": "allow",
  });
});
