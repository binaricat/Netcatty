const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildNetcattySkillsOpenCodePathAllowlist,
  buildOpenCodeSkillsPermissionRules,
  toOpenCodeDirectoryGlob,
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
    "/Applications/Netcatty.app/Contents/MacOS/**",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/electron/cli/**",
    "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/skills/netcatty-tool-cli/**",
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
    "/Users/me/Library/Application Support/netcatty/netcatty-tool-cli/**",
    "/var/folders/tmp/Netcatty/**",
  ]);
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
