"use strict";

const os = require("node:os");
const path = require("node:path");
const { getToolCliStateDir } = require("./discoveryPath.cjs");

const SSH_BRIDGE_DIR_NAME = "ssh-bridge";
const SSH_BRIDGE_DISCOVERY_ENV_VAR = "NETCATTY_SSH_BRIDGE_DISCOVERY_FILE";

function toUnpackedAsarPath(filePath) {
  return filePath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

function getSshBridgeStateDir(options = {}) {
  const configuredDiscovery = process.env[SSH_BRIDGE_DISCOVERY_ENV_VAR];
  if (configuredDiscovery) {
    return path.dirname(configuredDiscovery);
  }
  if (typeof options.stateDir === "string" && options.stateDir) {
    return options.stateDir;
  }
  const userDataDir = typeof options.userDataDir === "string" && options.userDataDir
    ? options.userDataDir
    : path.dirname(getToolCliStateDir());
  return path.join(userDataDir, SSH_BRIDGE_DIR_NAME);
}

function getSshBridgeDiscoveryFilePath(options = {}) {
  const configured = process.env[SSH_BRIDGE_DISCOVERY_ENV_VAR];
  if (configured) return configured;
  return path.join(getSshBridgeStateDir(options), "discovery.json");
}

function getSshBridgeHostKeyPath(options = {}) {
  return path.join(getSshBridgeStateDir(options), "host_ed25519_key");
}

function getSshBridgeKnownHostsPath(options = {}) {
  return path.join(getSshBridgeStateDir(options), "known_hosts");
}

function getSshBridgeSocketPath(options = {}) {
  const suffix = `${process.pid}-${options.nonce || "default"}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\netcatty-ssh-bridge-${suffix}`;
  }
  // Unix domain socket paths are capped around 104-108 bytes on macOS/Linux.
  // Use os.tmpdir() when userDataDir path is long.
  const stateDir = getSshBridgeStateDir(options);
  const candidate = path.join(stateDir, `bridge-${suffix}.sock`);
  if (Buffer.byteLength(candidate, "utf8") <= 96) {
    return candidate;
  }
  return path.join(os.tmpdir(), `nc-ssh-${suffix}.sock`);
}

function getSshProxyLauncherPath(platform = process.platform) {
  const fileName = platform === "win32"
    ? "netcatty-ssh-proxy.cmd"
    : "netcatty-ssh-proxy";
  return toUnpackedAsarPath(path.join(__dirname, fileName));
}

module.exports = {
  SSH_BRIDGE_DIR_NAME,
  SSH_BRIDGE_DISCOVERY_ENV_VAR,
  toUnpackedAsarPath,
  getSshBridgeStateDir,
  getSshBridgeDiscoveryFilePath,
  getSshBridgeHostKeyPath,
  getSshBridgeKnownHostsPath,
  getSshBridgeSocketPath,
  getSshProxyLauncherPath,
};
