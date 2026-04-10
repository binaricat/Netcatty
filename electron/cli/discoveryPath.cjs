"use strict";

const os = require("node:os");
const path = require("node:path");
const CLI_STATE_DIR_NAME = "netcatty-tool-cli";
const TOOL_CLI_DISCOVERY_ENV_VAR = "NETCATTY_TOOL_CLI_DISCOVERY_FILE";
const FALLBACK_APP_DATA_DIR_NAME = "netcatty";

function toUnpackedAsarPath(filePath) {
  return filePath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

function getDefaultAppDataDirName() {
  const packageJsonPaths = [
    process.resourcesPath ? path.join(process.resourcesPath, "app.asar", "package.json") : null,
    path.resolve(__dirname, "../../package.json"),
    path.join(process.cwd(), "package.json"),
  ].filter(Boolean);

  for (const packageJsonPath of packageJsonPaths) {
    try {
      const packageJson = require(packageJsonPath);
      if (typeof packageJson?.name === "string" && packageJson.name) {
        return packageJson.name;
      }
    } catch {
      // Try the next location.
    }
  }

  return FALLBACK_APP_DATA_DIR_NAME;
}

function getDefaultUserDataDir() {
  const appDataDirName = getDefaultAppDataDirName();
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appDataDirName);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, appDataDirName);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, appDataDirName);
}

function getConfiguredDiscoveryFilePath() {
  return process.env[TOOL_CLI_DISCOVERY_ENV_VAR] || null;
}

function getToolCliStateDir(options = {}) {
  const discoveryFilePath = getConfiguredDiscoveryFilePath();
  if (discoveryFilePath) {
    return path.dirname(discoveryFilePath);
  }
  const userDataDir = typeof options.userDataDir === "string" && options.userDataDir
    ? options.userDataDir
    : getDefaultUserDataDir();
  return path.join(userDataDir, CLI_STATE_DIR_NAME);
}

function getCliDiscoveryFilePath(options = {}) {
  const discoveryFilePath = getConfiguredDiscoveryFilePath();
  if (discoveryFilePath) {
    return discoveryFilePath;
  }
  return path.join(getToolCliStateDir(options), "discovery.json");
}

function getCliLauncherPath() {
  const fileName = process.platform === "win32"
    ? "netcatty-tool-cli.cmd"
    : "netcatty-tool-cli";
  return toUnpackedAsarPath(path.join(__dirname, fileName));
}

module.exports = {
  getToolCliStateDir,
  getCliDiscoveryFilePath,
  getCliLauncherPath,
  TOOL_CLI_DISCOVERY_ENV_VAR,
};
