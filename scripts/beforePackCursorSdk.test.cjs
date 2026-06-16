const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CURSOR_PLATFORM_PACKAGES,
  ensureCursorSdkPlatformPackages,
} = require("./beforePackCursorSdk.cjs");

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
