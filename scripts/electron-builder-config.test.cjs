const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

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

test("build.files includes the prompt classifier required by Mosh", () => {
  assert.ok(
    config.files.includes("domain/terminalPromptSecurity.shared.cjs"),
    "packaged Mosh bootstrap requires the shared prompt classifier",
  );
  const promptSecurity = require("../domain/terminalPromptSecurity.shared.cjs");
  assert.equal(promptSecurity.isUntrustedTerminalInputPrompt("验证码："), true);
});

test("build.files includes the container runtime adapter", () => {
  assert.ok(
    config.files.includes("domain/systemManager/containerRuntime.shared.cjs"),
    "packaged system manager requires the shared container runtime adapter",
  );
});

test("build.files includes the single-channel SSH banner matcher", () => {
  assert.ok(
    config.files.includes("domain/singleChannelSshBanner.shared.cjs"),
    "packaged SSH and SFTP bridges require the shared banner matcher",
  );
  const banner = require("../domain/singleChannelSshBanner.shared.cjs");
  assert.equal(banner.remoteSoftwareRequiresSingleChannel("BHostSSH_7.0"), true);
  assert.equal(banner.remoteSoftwareRequiresSingleChannel("JumpServer"), false);
});

test("build.files includes the shared TOTP runtime required by SSH bridges", () => {
  assert.ok(
    config.files.includes("domain/totp.shared.cjs"),
    "packaged SSH bridges require domain/totp.shared.cjs at load",
  );
  assert.ok(
    config.files.includes("domain/totpPrompt.shared.cjs"),
    "the shared TOTP runtime requires the prompt exclusion list",
  );
  const totp = require("../domain/totp.shared.cjs");
  const prompts = require("../domain/totpPrompt.shared.cjs");
  assert.equal(typeof totp.generateTotp, "function");
  assert.equal(typeof totp.planTotpAutoSubmit, "function");
  assert.equal(totp.NON_TOTP_PROMPT, prompts.NON_TOTP_PROMPT);
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
  // externalMcpRedaction.cjs requires re2js. The launcher runs from
  // app.asar.unpacked with ELECTRON_RUN_AS_NODE, which cannot see modules
  // that exist only inside app.asar (issue #3910).
  assert.ok(
    config.asarUnpack.includes("node_modules/re2js/**/*"),
    "external MCP bridge must unpack re2js so the stdio launcher can resolve it",
  );
});

test("asarUnpack keeps Cursor SDK runtime deps unpacked", () => {
  assert.ok(
    !config.asarUnpack.includes("node_modules/@cursor/sdk/**/*"),
    "Cursor SDK JavaScript can load from app.asar and should not be duplicated into app.asar.unpacked",
  );
  assert.ok(config.asarUnpack.includes("node_modules/@cursor/sdk-*/**/*"));
  assert.ok(config.asarUnpack.includes("node_modules/sqlite3/**/*"));
});

test("beforePack installs missing Cursor SDK packages and builds Windows Hello helper", () => {
  assert.equal(config.beforePack, "./scripts/beforePackCursorSdk.cjs");
});

test("Windows packaging includes the Windows Hello helper executable", () => {
  assert.ok(
    Array.isArray(config.win.extraResources),
    "win.extraResources must be an array",
  );
  assert.ok(
    config.win.extraResources.some((entry) => (
      entry &&
      entry.from === "electron/bridges/windowsHelloHelper/build/${arch}/NetcattyWindowsHello.exe" &&
      entry.to === "windowsHello/NetcattyWindowsHello.exe"
    )),
    "Windows package must include the Windows Hello helper executable for the target arch",
  );
  assert.ok(
    config.files.includes("!electron/bridges/windowsHelloHelper/build/**/*"),
    "Windows Hello build output must not also be copied into app.asar",
  );
});

test("Windows package arch is controlled by pack script CLI flags", () => {
  assert.deepEqual(
    config.win.target,
    ["nsis", "portable", "zip"],
    "win.target must not hard-code x64 and arm64 or pack:win-x64 will still invoke arm64 beforePack hooks",
  );
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

test("build.files keeps README screenshot WebP out of the package", () => {
  assert.ok(
    config.files.includes("!docs/assets/readme/**/*"),
    "README WebP screenshots must stay out of app.asar",
  );
  const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
  const root = path.resolve(__dirname, "..");
  const matcher = new FileMatcher(root, path.join(root, "release"), (value) => value);
  for (const pattern of config.files) matcher.addPattern(pattern);
  const filter = matcher.createFilter();
  const stat = { isDirectory: () => false };
  assert.equal(filter(path.join(root, "docs/assets/readme/overview.webp"), stat), false);
  assert.equal(filter(path.join(root, "electron/main.cjs"), stat), true);
  assert.equal(filter(path.join(root, "public/icon.png"), stat), false);
});

test("build.files excludes Vite-bundled renderer-only packages", () => {
  const files = config.files;
  for (const glob of [
    "!node_modules/react/**/*",
    "!node_modules/react-dom/**/*",
    "!node_modules/@radix-ui/**/*",
    "!node_modules/ai/**/*",
    "!node_modules/@ai-sdk/**/*",
    "!node_modules/@mdxeditor/**/*",
    "!node_modules/streamdown/**/*",
    "!node_modules/@streamdown/**/*",
    "!node_modules/@tanstack/react-virtual/**/*",
    "!node_modules/pinyin-pro/**/*",
    "!node_modules/@eslint-community/regexpp/**/*",
    "!node_modules/clsx/**/*",
    "!node_modules/tailwind-merge/**/*",
    "!node_modules/use-stick-to-bottom/**/*",
    "!node_modules/lexical/**/*",
    "!node_modules/@lexical/**/*",
    "!node_modules/@codemirror/**/*",
    "!node_modules/katex/**/*",
    "!node_modules/shiki/**/*",
    "!node_modules/@shiki/**/*",
  ]) {
    assert.ok(
      files.includes(glob),
      `build.files must exclude Vite-bundled renderer package: ${glob}`,
    );
  }
});

test("KaTeX distribution keeps its license notice", () => {
  const notice = readFileSync(
    path.join(__dirname, "..", "public", "licenses", "KaTeX-LICENSE.txt"),
    "utf8",
  );
  assert.match(notice, /Copyright \(c\) 2013-2020 Khan Academy and other contributors/);
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

test("Windows package arch is controlled by pack script CLI flags", () => {
  assert.deepEqual(
    config.win.target,
    ["nsis", "portable", "zip"],
    "win.target must not hard-code x64 and arm64 or pack:win-x64 will still emit broken arm64 installers",
  );
});

test("windows packaging includes a zip archive target", () => {
  assert.ok(
    config.win.target.includes("zip"),
    "windows package builds must publish a zip archive for no-install environments",
  );
});

test("windows installer kills leftover Netcatty.exe before file replacement", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const installerScript = fs.readFileSync(
    path.join(__dirname, "..", config.nsis.include),
    "utf8",
  );

  assert.match(installerScript, /!macro customInit\b/);
  assert.match(installerScript, /#3946/);
  assert.match(installerScript, /ELECTRON_RUN_AS_NODE/);
  assert.match(
    installerScript,
    /nsExec::ExecToLog "taskkill \/F \/IM Netcatty\.exe"/,
  );
  assert.match(installerScript, /Pop \$0/);
  // /T would kill this installer while it is still a child of the UI Netcatty.exe.
  assert.doesNotMatch(installerScript, /taskkill [^\r\n]*\/T/);
});

test("windows installer registers and removes Explorer folder context menu entries", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  assert.equal(
    config.nsis.include,
    "build/installer.nsh",
    "NSIS packaging must include the Explorer context-menu installer hooks",
  );

  const installerScript = fs.readFileSync(
    path.join(__dirname, "..", config.nsis.include),
    "utf8",
  );
  const folderKey = String.raw`Software\Classes\Directory\shell\Netcatty`;
  const backgroundKey = String.raw`Software\Classes\Directory\Background\shell\Netcatty`;

  assert.match(installerScript, /!macro customInstall\b/);
  assert.match(installerScript, new RegExp(`WriteRegStr SHCTX "${folderKey.replaceAll("\\", "\\\\")}"`));
  assert.match(installerScript, new RegExp(`WriteRegStr SHCTX "${backgroundKey.replaceAll("\\", "\\\\")}"`));
  assert.match(installerScript, /-- --open-terminal-path="%1\."/);
  assert.match(installerScript, /-- --open-terminal-path="%V\."/);

  assert.match(installerScript, /!macro customUnInstall\b/);
  assert.match(installerScript, new RegExp(`DeleteRegKey SHCTX "${folderKey.replaceAll("\\", "\\\\")}"`));
  assert.match(installerScript, new RegExp(`DeleteRegKey SHCTX "${backgroundKey.replaceAll("\\", "\\\\")}"`));
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

  assert.deepEqual(
    targetsByArch.get(Arch.x64)?.slice().sort(),
    ["nsis", "portable", "zip"].sort(),
    "pack:win-x64 must publish x64 nsis, portable, and zip",
  );
  assert.equal(
    targetsByArch.has(Arch.arm64),
    false,
    "pack:win-x64 must not publish arm64 nsis/portable/zip without a dedicated arm64 job",
  );
});

test("cross Windows build script skips host native rebuilds", () => {
  const packageJson = require("../package.json");
  assert.match(
    packageJson.scripts["pack:win-x64:cross"],
    /electron-builder[\s\S]*--win[\s\S]*--x64[\s\S]*-c\.npmRebuild=false/,
  );
});

test("linux FPM packages use the custom post-install template", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  for (const [target, afterInstall] of Object.entries({
    deb: config.deb.afterInstall,
    rpm: config.rpm.afterInstall,
    pacman: config.pacman.afterInstall,
  })) {
    assert.equal(
      afterInstall,
      "scripts/linux/after-install.tpl",
      `${target}.afterInstall must point at the custom FPM post-install template`,
    );
  }
  assert.equal(
    config.pacman.afterRemove,
    "scripts/linux/after-remove.tpl",
    "pacman.afterRemove must point at the custom FPM post-remove template",
  );

  for (const relPath of [config.deb.afterInstall, config.pacman.afterRemove]) {
    const file = path.join(__dirname, "..", relPath);
    const contents = fs.readFileSync(file, "utf8");
    assert.match(
      contents,
      /gtk-update-icon-cache.*\/usr\/share\/icons\/hicolor/,
      `${relPath} must refresh the hicolor icon cache`,
    );
  }
});

test("@remote-dom/core is a root devDependency while remaining in plugin-sdk and excluded from app.asar", () => {
  const rootPkg = require("../package.json");
  const sdkPkg = require("../packages/plugin-sdk/package.json");
  assert.equal(rootPkg.dependencies["@remote-dom/core"], undefined);
  assert.ok(rootPkg.devDependencies["@remote-dom/core"]);
  assert.ok(sdkPkg.dependencies["@remote-dom/core"]);
  assert.ok(config.files.includes("!node_modules/@remote-dom/**/*"));
});

test("node_modules packaging exclusions prune unused payloads while preserving license notices and css-tree CJS", () => {
  const { getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher");
  const root = path.resolve(__dirname, "..");
  const outDir = path.join(root, "release");
  const stat = { isDirectory: () => false };

  const nmMac = getNodeModuleFileMatcher(root, outDir, (v) => v, config.mac, {
    config,
    debugLogger: { isEnabled: false },
  }).createFilter();
  const nmWin = getNodeModuleFileMatcher(root, outDir, (v) => v, config.win, {
    config,
    debugLogger: { isEnabled: false },
  }).createFilter();
  const nmLinux = getNodeModuleFileMatcher(root, outDir, (v) => v, config.linux, {
    config,
    debugLogger: { isEnabled: false },
  }).createFilter();

  for (const dropped of [
    "node_modules/@remote-dom/core/build/esm/index.mjs",
    "node_modules/web-streams-polyfill/dist/ponyfill.es2018.js",
    "node_modules/css-tree/dist/csstree.js",
    "node_modules/css-tree/lib/index.js",
    "node_modules/mdn-data/l10n/css.json",
    "node_modules/mdn-data/api/inheritance.json",
    "node_modules/mdn-data/css/properties.schema.json",
    "node_modules/@statsig/js-client/build/statsig-js-client.min.js",
    "node_modules/@agentclientprotocol/sdk/schema/schema.json",
    "node_modules/yaml/browser/index.js",
    "node_modules/webdav/dist/web/index.js",
    "node_modules/webdav/dist/react-native/index.js",
    "node_modules/@withfig/autocomplete/icons/git.png",
    "node_modules/js-yaml/dist/js-yaml.js",
    "node_modules/js-yaml/dist/js-yaml.min.js",
    "node_modules/foo/tsconfig.tsbuildinfo",
    "node_modules/foo/README.md",
    "node_modules/foo/readme.txt",
    "node_modules/foo/CHANGELOG.md",
    "node_modules/foo/HISTORY.md",
    "node_modules/@anthropic-ai/sdk/README.md",
  ]) {
    assert.equal(nmMac(path.join(root, dropped), stat), false, `expected excluded: ${dropped}`);
  }

  for (const kept of [
    "node_modules/css-tree/cjs/index.cjs",
    "node_modules/mdn-data/css/properties.json",
    "node_modules/mdn-data/css/at-rules.json",
    "node_modules/mdn-data/css/syntaxes.json",
    "node_modules/yaml/dist/index.js",
    "node_modules/webdav/dist/node/index.js",
    "node_modules/js-yaml/index.js",
    "node_modules/js-yaml/dist/js-yaml.mjs",
    "node_modules/foo/LICENSE",
    "node_modules/foo/LICENSE.md",
    "node_modules/foo/LICENSE-MIT.md",
    "node_modules/foo/NOTICE.md",
    // @anthropic-ai/claude-agent-sdk declares "license": "SEE LICENSE IN README.md"
    "node_modules/@anthropic-ai/claude-agent-sdk/README.md",
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  ]) {
    assert.equal(nmMac(path.join(root, kept), stat), true, `expected preserved: ${kept}`);
  }

  // Platform-scoped @vscode/windows-process-tree exclusion
  const winProcTree = path.join(root, "node_modules/@vscode/windows-process-tree/lib/index.js");
  assert.equal(nmMac(winProcTree, stat), false);
  assert.equal(nmLinux(winProcTree, stat), false);
  assert.equal(nmWin(winProcTree, stat), true);

  // Verify css-tree + mdn-data runtime loader still works cleanly
  const policy = require("../domain/pluginViewStylePolicy.cjs");
  assert.equal(typeof policy.validatePluginStylesheet, "function");
});

test("app file exclusions prune dev schemas, test helpers/fixtures, svg sources, and non-target macOS icons", () => {
  const { getFileMatchers } = require("app-builder-lib/out/fileMatcher");
  const root = path.resolve(__dirname, "..");
  const outDir = path.join(root, "release");
  const stat = { isDirectory: () => false };

  const makeFilter = (platformOpts) =>
    getFileMatchers(config, "files", outDir, {
      macroExpander: (v) => v,
      customBuildOptions: platformOpts,
      globalOutDir: outDir,
      defaultSrc: root,
    })[0].createFilter();

  const macFilter = makeFilter(config.mac);
  const winFilter = makeFilter(config.win);
  const linuxFilter = makeFilter(config.linux);

  for (const dropped of [
    "electron/bridges/aiBridge/codexAppServer/protocol.schema.json",
    "electron/plugins/fixtures/inProcessBrowserRuntime.cjs",
    "electron/bridges/fixtures/sample.cs",
    "electron/hostBrowser/fixtures/renderer.html",
    "electron/bridges/testSupport/bridgeHarness.cjs",
    "electron/bridges/cliDiscoveryTestIsolation.cjs",
    "electron/bridges/sshBridge/serverStatsTestHelpers.cjs",
    "electron/bridges/terminalBridge.moshConpty.integration.cjs",
    "dist/icon.svg",
    "dist/tray-iconTemplate.svg",
  ]) {
    assert.equal(macFilter(path.join(root, dropped), stat), false, `expected excluded: ${dropped}`);
  }

  assert.equal(macFilter(path.join(root, "dist/index.html"), stat), true);
  assert.equal(macFilter(path.join(root, "electron/main.cjs"), stat), true);

  const macosVariantIcon = path.join(root, "dist/icons/variants/macos/icon.png");
  assert.equal(macFilter(macosVariantIcon, stat), true);
  assert.equal(winFilter(macosVariantIcon, stat), false);
  assert.equal(linuxFilter(macosVariantIcon, stat), false);
});
