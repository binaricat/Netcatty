const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../electron-builder.config.cjs");

test("unpacked MCP server includes its shared CommonJS dependencies", () => {
  assert.ok(
    config.asarUnpack.includes("electron/mcp/**/*"),
    "MCP server must stay unpacked so Codex can launch it as a child process",
  );
  assert.ok(
    config.asarUnpack.includes("lib/**/*.cjs"),
    "MCP server requires ../../lib/commandBlocklist.cjs from the unpacked runtime path",
  );
  assert.ok(
    config.asarUnpack.includes("lib/**/*.json"),
    "unpacked lib CommonJS modules require sibling JSON data files at runtime",
  );
});

test("build.files excludes per-platform agent binaries", () => {
  const files = config.files;
  const expectExclusions = [
    "!**/@anthropic-ai/claude-agent-sdk-*/**/*",
    "!node_modules/@anthropic-ai/claude-code-*/**/*",
    "!node_modules/@openai/codex-{darwin,linux,linuxmusl,win32}-*/**/*",
    "!node_modules/@github/copilot-{darwin,linux,linuxmusl,win32}-*/**/*",
    "!node_modules/@github/copilot/**/*",
    "!node_modules/opencode-{darwin,linux,linuxmusl,windows}-*/**/*",
    "!node_modules/opencode-ai/**/*",
  ];
  for (const glob of expectExclusions) {
    assert.ok(
      files.includes(glob),
      `build.files must exclude platform binary glob: ${glob}`,
    );
  }
});

test("asarUnpack no longer references removed legacy agent packages", () => {
  const unpack = config.asarUnpack.join("\n");
  for (const stale of [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/sdk",
    "@zed-industries/codex-acp",
  ]) {
    assert.ok(
      !unpack.includes(stale),
      `asarUnpack must not reference removed package: ${stale}`,
    );
  }
});

test("asarUnpack keeps MCP server runtime deps unpacked", () => {
  // @modelcontextprotocol/sdk is now a direct dep and the MCP server hard-requires it.
  assert.ok(config.asarUnpack.includes("node_modules/@modelcontextprotocol/sdk/**/*"));
});

test("asarUnpack keeps Cursor SDK runtime deps unpacked", () => {
  assert.ok(
    !config.asarUnpack.includes("node_modules/@cursor/sdk/**/*"),
    "Cursor SDK JavaScript can load from app.asar and should not be duplicated into app.asar.unpacked",
  );
  assert.ok(config.asarUnpack.includes("node_modules/@cursor/sdk-*/**/*"));
  assert.ok(config.asarUnpack.includes("node_modules/sqlite3/**/*"));
});

test("beforePack installs missing Cursor SDK platform runtime packages", () => {
  assert.equal(config.beforePack, "./scripts/beforePackCursorSdk.cjs");
});

test("packaged app declares ssh URL protocol support", () => {
  assert.deepEqual(config.protocols, [
    {
      name: "SSH URL",
      schemes: ["ssh"],
    },
  ]);
});

test("build.files trims release-only dependency payloads", () => {
  const files = config.files;
  for (const glob of [
    "!node_modules/@cursor/sdk/dist/cjs/**/*",
    "!node_modules/@cursor/sdk/dist/**/*.d.ts",
    "!node_modules/@cursor/sdk/dist/**/*.d.ts.map",
    "!node_modules/sqlite3/deps/**/*",
    "!node_modules/**/docs/**/*",
    "!node_modules/**/doc/**/*",
    "!node_modules/**/benchmark/**/*",
    "!node_modules/**/benchmarks/**/*",
  ]) {
    assert.ok(files.includes(glob), `build.files must exclude release-only payload: ${glob}`);
  }
});

test("linux packaging uses multi-size build/icons instead of a single 1024px override", async () => {
  assert.equal(
    config.linux.icon,
    "icons",
    "linux.icon must point at build/icons so electron-builder installs hicolor/* sizes",
  );
  assert.equal(config.directories.buildResources, "build");

  const fs = require("node:fs");
  const path = require("node:path");
  const iconsDir = path.join(__dirname, "..", "build", "icons");
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    const file = path.join(iconsDir, `${size}x${size}.png`);
    assert.ok(fs.existsSync(file), `expected Linux icon: build/icons/${size}x${size}.png`);
  }

  const { convertIcon } = require("app-builder-lib/out/util/iconConverter");
  const projectDir = path.join(__dirname, "..");
  const buildResources = path.join(projectDir, config.directories.buildResources);
  const sources = [config.linux.icon, config.mac?.icon ?? config.icon].filter(Boolean);
  const result = await convertIcon({
    sources,
    fallbackSources: [buildResources],
    roots: [buildResources, projectDir],
    format: "set",
    outDir: path.join(projectDir, "release", ".icon-config-test"),
  });
  const sizes = result.icons.map((icon) => icon.size);
  assert.ok(
    sizes.includes(48) && sizes.includes(256) && !sizes.every((size) => size === 1024),
    `expected standard hicolor sizes, got: ${sizes.join(", ")}`,
  );
});

test("linux packaging includes an Arch Linux pacman package target", () => {
  assert.deepEqual(
    config.linux.target,
    ["AppImage", "deb", "rpm", "pacman"],
    "linux package builds must publish AppImage, Debian, RPM, and Arch pacman artifacts",
  );
});

test("linux FPM packages refresh the hicolor icon cache after install and remove", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  assert.equal(
    config.pacman.afterInstall,
    "scripts/linux/after-install.tpl",
    "pacman.afterInstall must point at the custom FPM post-install template",
  );
  assert.equal(
    config.pacman.afterRemove,
    "scripts/linux/after-remove.tpl",
    "pacman.afterRemove must point at the custom FPM post-remove template",
  );

  for (const relPath of [config.pacman.afterInstall, config.pacman.afterRemove]) {
    const file = path.join(__dirname, "..", relPath);
    const contents = fs.readFileSync(file, "utf8");
    assert.match(
      contents,
      /gtk-update-icon-cache.*\/usr\/share\/icons\/hicolor/,
      `${relPath} must refresh the hicolor icon cache`,
    );
  }
});
