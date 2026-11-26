"use strict";

const fs = require("node:fs");
const net = require("node:net");

function failure(_code, message) { return new TypeError(message); }

function canonicalizeStreamEndpoint(value) {
  if (typeof value !== "string" || value.length > 512) {
    throw failure("invalidArgument", "Byte stream endpoint is invalid");
  }
  // URL's permissive non-special scheme parser accepts paths, userinfo, and
  // alternate IPv4 spellings. Require a complete unambiguous authority instead.
  const match = /^(tcp|tls):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/u.exec(value);
  if (!match) throw failure("invalidArgument", "Byte streams require an exact TCP or TLS host and port");
  let host = match[2].toLowerCase();
  const port = Number(match[3]);
  if (port < 1 || port > 65535 || String(port) !== match[3]) {
    throw failure("invalidArgument", "Byte stream port is invalid");
  }
  if (host.startsWith("[")) {
    host = host.slice(1, -1);
    if (net.isIP(host) !== 6) throw failure("invalidArgument", "Byte stream IPv6 address is invalid");
    host = new URL(`http://[${host}]`).hostname.slice(1, -1);
  } else if (!net.isIP(host)) {
    if (host.length > 253 || /^[0-9.]+$/u.test(host) || host.split(".").some((label) => (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
    ))) throw failure("invalidArgument", "Byte stream hostname is invalid");
  }
  return Object.freeze({
    endpoint: `${match[1]}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`,
    transport: match[1], host, port,
  });
}

function normalizeStreamAddress(address) {
  if (net.isIP(address) === 4) return address;
  if (net.isIP(address) !== 6) return null;
  const canonical = new URL(`http://[${address.split("%")[0]}]`).hostname.slice(1, -1);
  if (!canonical.startsWith("::ffff:")) return canonical;
  const words = canonical.slice(7).split(":");
  const n = (parseInt(words[0], 16) * 65536) + parseInt(words[1], 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function isLoopbackAddress(address) {
  const normalized = normalizeStreamAddress(address);
  if (net.isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }
  return normalized === "::1";
}

function isUnconditionallyBlockedAddress(address) {
  const normalized = normalizeStreamAddress(address);
  if (net.isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a >= 224 || (a === 169 && b === 254);
  }
  if (net.isIP(normalized) !== 6) return true;
  if (normalized === "::1") return false;
  return normalized.startsWith("::") || normalized.startsWith("ff")
    || /^fe[89ab]/u.test(normalized) || normalized.startsWith("2002:")
    || normalized.startsWith("2001:0:");
}

function isLocalControlAddress(address) {
  return isLoopbackAddress(address) || isUnconditionallyBlockedAddress(address);
}

function getNetcattyInternalControlPorts() {
  const ports = new Set();
  const discoveryFile = process.env.NETCATTY_TOOL_CLI_DISCOVERY_FILE;
  if (typeof discoveryFile === "string" && discoveryFile.length > 0) {
    try {
      const parsed = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
      if (Number.isInteger(parsed?.port) && parsed.port > 0 && parsed.port <= 65535) {
        ports.add(parsed.port);
      }
    } catch { /* discovery file may not exist */ }
  }
  const viteUrl = process.env.VITE_DEV_SERVER_URL;
  if (typeof viteUrl === "string" && viteUrl.length > 0) {
    try {
      const parsed = new URL(viteUrl);
      const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    } catch { /* ignore invalid dev server URL */ }
  }
  for (const arg of [...(process.argv ?? []), ...(process.execArgv ?? [])]) {
    const match = /^--(?:remote-debugging-port|inspect|inspect-brk)=(?:[^:]*:)?(\d{1,5})$/u.exec(String(arg));
    if (match) {
      const port = Number(match[1]);
      if (port > 0 && port <= 65535) ports.add(port);
    }
  }
  // In the live Electron main process, every active TCP net.Server belongs to
  // Netcatty's own internal bridges (MCP/CLI RPC, external MCP HTTP, OAuth, etc.).
  if (process.versions?.electron && typeof process._getActiveHandles === "function") {
    try {
      for (const handle of process._getActiveHandles()) {
        if (handle instanceof net.Server && handle.listening) {
          const addr = handle.address();
          if (addr && typeof addr === "object" && Number.isInteger(addr.port) && addr.port > 0) {
            ports.add(addr.port);
          }
        }
      }
    } catch { /* ignore handle inspection errors */ }
  }
  return ports;
}

module.exports = {
  canonicalizeStreamEndpoint,
  getNetcattyInternalControlPorts,
  isLocalControlAddress,
  isLoopbackAddress,
  isUnconditionallyBlockedAddress,
  normalizeStreamAddress,
};
