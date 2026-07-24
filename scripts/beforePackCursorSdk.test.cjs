const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CURSOR_PLATFORM_PACKAGES,
  ensureCursorSdkPlatformPackages,
} = require("./beforePackCursorSdk.cjs");
const {
  copyPatchedNodePtyToPackagedApp,
  rebuildPatchedNodePty,
} = require("./nodePtyConptyPatch.cjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("ensureCursorSdkPlatformPackages installs both macOS Cursor runtime packages", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-pack-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  writeJson(path.join(tempDir, "node_modules", "@cursor", "sdk", "package.json"), { version: "1.0.18" });
  writeJson(path.join(tempDir, "node_modules", "@cursor", "sdk-darwin-arm64", "package.json"), { version: "1.0.18" });
  const calls = [];

  const installed = ensureCursorSdkPlatformPackages({
    projectDir: tempDir,
    platform: "darwin",
    run: (...args) => calls.push(args),
    logger: { log() {}, warn() {} },
  });

  assert.deepEqual(installed, ["@cursor/sdk-darwin-x64"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.platform === "win32" ? "npm.cmd" : "npm");
  assert.deepEqual(calls[0][1], [
    "install",
    "--no-save",
    "--force",
    "--ignore-scripts",
    "@cursor/sdk-darwin-x64@1.0.18",
  ]);
  assert.equal(calls[0][2].cwd, tempDir);
});

test("ensureCursorSdkPlatformPackages is a no-op when target packages exist", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-pack-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  writeJson(path.join(tempDir, "node_modules", "@cursor", "sdk", "package.json"), { version: "1.0.18" });
  for (const packageName of CURSOR_PLATFORM_PACKAGES.linux) {
    writeJson(path.join(tempDir, "node_modules", ...packageName.split("/"), "package.json"), { version: "1.0.18" });
  }
  const calls = [];

  const installed = ensureCursorSdkPlatformPackages({
    projectDir: tempDir,
    platform: "linux",
    run: (...args) => calls.push(args),
    logger: { log() {}, warn() {} },
  });

  assert.deepEqual(installed, []);
  assert.deepEqual(calls, []);
});

test("Windows packaging rebuilds patched node-pty from source for the target architecture", () => {
  const calls = [];
  const rebuilt = rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: 3,
    run: (...args) => calls.push(args),
    exists: () => true,
    logger: { log() {} },
  });

  assert.equal(rebuilt, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], [
    path.join("/workspace/netcatty", "node_modules", "@electron", "rebuild", "lib", "cli.js"),
    "--force",
    "--build-from-source",
    "--only",
    "node-pty",
    "--arch",
    "arm64",
  ]);
  assert.equal(calls[0][2].cwd, "/workspace/netcatty");
  assert.equal(calls[1][0], process.execPath);
  assert.equal(
    calls[1][1][0],
    path.join("/workspace/netcatty", "node_modules", "node-pty", "scripts", "post-install.js"),
  );
  assert.equal(calls[1][2].env.npm_config_arch, "arm64");
});

test("Windows packaging fails when rebuilt node-pty runtime files are incomplete", () => {
  assert.throws(() => rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: 1,
    run() {},
    exists: (filePath) => !filePath.endsWith("conpty.dll"),
    logger: { log() {} },
  }), /Patched node-pty artifacts missing: .*conpty\.dll/);
});

test("non-Windows packaging keeps the prebuilt node-pty path", () => {
  const calls = [];
  const rebuilt = rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "linux",
    arch: 1,
    run: (...args) => calls.push(args),
    logger: { log() {} },
  });

  assert.equal(rebuilt, false);
  assert.deepEqual(calls, []);
});

test("Windows afterPack copies rebuilt ConPTY files over packaged prebuilds", () => {
  const copied = [];
  const made = [];
  const destinations = copyPatchedNodePtyToPackagedApp({
    projectDir: "/workspace/netcatty",
    resourcesDir: "/workspace/release/resources",
    copy: (...args) => copied.push(args),
    mkdir: (...args) => made.push(args),
  });

  assert.equal(copied.length, 3);
  assert.equal(made.length, 3);
  assert.equal(copied[0][0], path.join(
    "/workspace/netcatty", "node_modules", "node-pty", "build", "Release", "conpty.node",
  ));
  assert.equal(copied[0][1], path.join(
    "/workspace/release/resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "conpty.node",
  ));
  assert.deepEqual(destinations, copied.map(([, destination]) => destination));
});

test("node-pty patch matches bundled ConPTY clear ABI and preserves the cursor row", () => {
  const patch = fs.readFileSync(
    path.join(__dirname, "..", "patches", "node-pty+1.1.0.patch"),
    "utf8",
  );

  assert.match(patch, /ConptyClearPseudoConsole\(HPCON hPC, BOOL keepCursorRow\)/);
  assert.match(patch, /PFNCLEARPSEUDOCONSOLE\)\(HPCON hpc, BOOL keepCursorRow\)/);
  assert.match(patch, /pfnClearPseudoConsole\(handle->hpc, TRUE\)/);
  assert.doesNotMatch(patch, /node_modules\/node-pty\/build\//);
});
