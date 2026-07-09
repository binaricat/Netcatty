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

test("build.files includes shared terminal flow constants for main process", () => {
  assert.ok(
    config.files.includes("infrastructure/config/terminalFlowConstants.cjs"),
    "terminalFlowAck.cjs requires infrastructure/config/terminalFlowConstants.cjs at packaged startup",
  );
  assert.ok(
    config.files.includes("infrastructure/config/terminalFlowConstants.json"),
    "terminalFlowConstants.cjs requires sibling terminalFlowConstants.json at packaged startup",
  );
});

test("unpacked Tool CLI includes capability runtime dependencies", () => {
  assert.ok(
    config.asarUnpack.includes("electron/cli/**/*"),
    "Tool CLI launcher and scripts must stay unpacked so agents can launch them as child processes",
  );
  assert.ok(
    config.asarUnpack.includes("electron/capabilities/**/*"),
    "Tool CLI requires capability catalog, registry, policy, timeout, and RPC transport modules from the unpacked runtime path",
  );
  assert.ok(
    config.asarUnpack.includes("electron/shared/**/*"),
    "Capability policy may load shared permission grant helpers from the unpacked runtime path",
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

test("packaged app declares ssh, telnet, and jms URL protocol support", () => {
  assert.deepEqual(config.protocols, [
    {
      name: "SSH URL",
      schemes: ["ssh"],
    },
    {
      name: "Telnet URL",
      schemes: ["telnet"],
    },
    {
      name: "JumpServer URL",
      schemes: ["jms"],
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

test("rpm packaging disables generated build-id symlinks", () => {
  assert.deepEqual(
    config.rpm?.fpm,
    [
      "--rpm-rpmbuild-define",
      "_build_id_links none",
      "--rpm-rpmbuild-define",
      "__os_install_post %{nil}",
    ],
    "RPM packages must skip build-id links and host brp post scripts on RHEL builders",
  );
});

test("rpm packaging uses gzip compression for RHEL-family package hosts", () => {
  // Default electron-builder/fpm RPM compression is xzmt. AlmaLinux/RHEL 8 CI
  // images provide `xz` but not the `xzmt` shim, which makes rpmbuild exit 127.
  assert.equal(
    config.rpm?.compression,
    "gzip",
    "RPM compression must avoid xzmt on RHEL 8 / AlmaLinux 8 package builders",
  );
});

test("windows packaging includes a zip archive target", () => {
  const winTargets = config.win.target.map((entry) => entry.target);
  assert.ok(
    winTargets.includes("zip"),
    "windows package builds must publish a zip archive for no-install environments",
  );
});

test("windows zip follows the requested build architecture", () => {
  const { Arch } = require("builder-util");
  const { Platform } = require("app-builder-lib");
  const { computeArchToTargetNamesMap } = require("app-builder-lib/out/targets/targetFactory");

  const rawCliTargets = new Map([[Arch.x64, []]]);
  const targetsByArch = computeArchToTargetNamesMap(
    rawCliTargets,
    {
      platformSpecificBuildOptions: config.win,
      defaultTarget: ["nsis"],
    },
    Platform.WINDOWS,
  );

  assert.ok(
    targetsByArch.get(Arch.x64)?.includes("zip"),
    "pack:win-x64 must publish an x64 zip archive",
  );
  assert.ok(
    !targetsByArch.get(Arch.arm64)?.includes("zip"),
    "pack:win-x64 must not publish an arm64 zip archive without arm64 bundled binaries",
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
