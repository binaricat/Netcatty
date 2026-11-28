"use strict";

const path = require("node:path");
const { getToolCliStateDir } = require("./discoveryPath.cjs");

const SSH_BRIDGE_DIR_NAME = "ssh-bridge";
const SSH_BRIDGE_DISCOVERY_ENV_VAR = "NETCATTY_SSH_BRIDGE_DISCOVERY_FILE";
const MAX_UNIX_SOCKET_PATH_BYTES = 96;
const LOOPBACK_TCP_AUTO_ENDPOINT = "tcp://127.0.0.1:0";

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
  const platform = options.platform || process.platform;
  const suffix = `${process.pid}-${options.nonce || "default"}`;
  if (platform === "win32") {
    return `\\\\.\\pipe\\netcatty-ssh-bridge-${suffix}`;
  }
  // Unix domain socket paths are capped around 104-108 bytes on macOS/Linux.
  // 1. Prefer the private ssh-bridge state dir when within the safe byte limit.
  const stateDir = getSshBridgeStateDir(options);
  const candidate = path.join(stateDir, `bridge-${suffix}.sock`);
  if (Buffer.byteLength(candidate, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return candidate;
  }
  // 2. Fall back to Netcatty's managed private temp directory when it fits.
  const tempBridge = options.tempDirBridge || require("../bridges/tempDirBridge.cjs");
  const managedTempPath = tempBridge.getTempFilePath("nc.sock");
  if (typeof managedTempPath === "string" && Buffer.byteLength(managedTempPath, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return managedTempPath;
  }
  // 3. When both stateDir and custom managed tempDir exceed Unix socket limits,
  //    bind an ephemeral 127.0.0.1 loopback TCP listener (still protected by the
  //    256-bit discovery token and pinned Ed25519 bridge host key).
  return LOOPBACK_TCP_AUTO_ENDPOINT;
}

function parseSshBridgeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint) return null;
  const tcpMatch = /^tcp:\/\/(127\.0\.0\.1):(\d+)$/.exec(endpoint);
  if (tcpMatch) {
    const port = Number(tcpMatch[2]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return { host: tcpMatch[1], port };
    }
    return null;
  }
  return { path: endpoint };
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
  MAX_UNIX_SOCKET_PATH_BYTES,
  LOOPBACK_TCP_AUTO_ENDPOINT,
  toUnpackedAsarPath,
  getSshBridgeStateDir,
  getSshBridgeDiscoveryFilePath,
  getSshBridgeHostKeyPath,
  getSshBridgeKnownHostsPath,
  getSshBridgeSocketPath,
  parseSshBridgeEndpoint,
  getSshProxyLauncherPath,
};
