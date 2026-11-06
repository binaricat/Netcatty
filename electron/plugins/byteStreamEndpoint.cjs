"use strict";

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

function isLocalControlAddress(address) {
  address = normalizeStreamAddress(address);
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254);
  }
  if (net.isIP(address) !== 6) return true;
  const canonical = address;
  // Also exclude compatible/tunnel addresses that can obscure a local IPv4 peer.
  return canonical.startsWith("::") || canonical.startsWith("ff")
    || /^fe[89ab]/u.test(canonical) || canonical.startsWith("2002:")
    || canonical.startsWith("2001:0:");
}

module.exports = { canonicalizeStreamEndpoint, isLocalControlAddress, normalizeStreamAddress };
