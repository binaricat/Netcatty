const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CURSOR_PLATFORM_PACKAGES = {
  darwin: ["@cursor/sdk-darwin-arm64", "@cursor/sdk-darwin-x64"],
  linux: ["@cursor/sdk-linux-arm64", "@cursor/sdk-linux-x64"],
  win32: ["@cursor/sdk-win32-x64"],
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getCursorSdkVersion(projectDir) {
  const sdkPackagePath = path.join(projectDir, "node_modules", "@cursor", "sdk", "package.json");
  if (fs.existsSync(sdkPackagePath)) {
    return readJson(sdkPackagePath).version;
  }

  const lockPath = path.join(projectDir, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    const lockedVersion = lock.packages?.["node_modules/@cursor/sdk"]?.version;
    if (lockedVersion) return lockedVersion;
  }

  const packageJson = readJson(path.join(projectDir, "package.json"));
  const spec = packageJson.optionalDependencies?.["@cursor/sdk"];
  return typeof spec === "string" ? spec.replace(/^[^\d]*/, "") : null;
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

const ELECTRON_BUILDER_ARCH = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

function rebuildPatchedNodePty({
  projectDir,
  platform,
  arch,
  run = execFileSync,
  logger = console,
}) {
  if (platform !== "win32") return false;
  const targetArch = typeof arch === "number" ? ELECTRON_BUILDER_ARCH[arch] : arch;
  if (!targetArch || targetArch === "universal") {
    throw new Error(`[beforePackCursorSdk] Unsupported Windows architecture: ${String(arch)}`);
  }
  const rebuildExecutable = path.join(
    projectDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-rebuild.cmd" : "electron-rebuild",
  );
  logger.log(`[beforePackCursorSdk] Rebuilding patched node-pty for Windows ${targetArch}`);
  run(rebuildExecutable, [
    "--force",
    "--build-from-source",
    "--which-module",
    "node-pty",
    "--arch",
    targetArch,
  ], {
    cwd: projectDir,
    stdio: "inherit",
  });
  return true;
}

function ensureCursorSdkPlatformPackages({
  projectDir,
  platform,
  run = execFileSync,
  logger = console,
}) {
  const packages = CURSOR_PLATFORM_PACKAGES[platform] || [];
  if (packages.length === 0) return [];

  const version = getCursorSdkVersion(projectDir);
  if (!version) {
    logger.warn("[beforePackCursorSdk] Cursor SDK version not found; skipping platform package install.");
    return [];
  }

  const missingPackages = packages.filter((packageName) => (
    !fs.existsSync(path.join(projectDir, "node_modules", ...packageName.split("/"), "package.json"))
  ));
  if (missingPackages.length === 0) return [];

  const packageSpecs = missingPackages.map((packageName) => `${packageName}@${version}`);
  logger.log(`[beforePackCursorSdk] Installing Cursor SDK platform packages: ${packageSpecs.join(", ")}`);
  run(npmExecutable(), ["install", "--no-save", "--force", "--ignore-scripts", ...packageSpecs], {
    cwd: projectDir,
    stdio: "inherit",
  });

  return missingPackages;
}

function beforePackCursorSdk(context = {}) {
  const projectDir = context.appDir || process.cwd();
  const platform = context.electronPlatformName || process.platform;
  ensureCursorSdkPlatformPackages({ projectDir, platform });
  rebuildPatchedNodePty({ projectDir, platform, arch: context.arch ?? process.arch });
}

module.exports = beforePackCursorSdk;
module.exports.default = beforePackCursorSdk;
module.exports.ensureCursorSdkPlatformPackages = ensureCursorSdkPlatformPackages;
module.exports.rebuildPatchedNodePty = rebuildPatchedNodePty;
module.exports.CURSOR_PLATFORM_PACKAGES = CURSOR_PLATFORM_PACKAGES;
