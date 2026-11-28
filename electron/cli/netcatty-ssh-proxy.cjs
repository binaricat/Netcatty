"use strict";

/**
 * OpenSSH ProxyCommand helper for `Host *.netcatty`.
 *
 * Connects to the running Netcatty SSH channel bridge over an authenticated
 * local IPC socket/named pipe, sends a one-line JSON handshake, and switches
 * to raw bidirectional stdio forwarding so OpenSSH (`ssh`, `sftp`, `scp`,
 * Zed, VS Code, Cursor, etc.) can multiplex channels onto Netcatty's already-
 * authenticated SSH transport without exposing vault credentials or keys.
 */

const fs = require("node:fs");
const net = require("node:net");
const {
  getSshBridgeDiscoveryFilePath,
  parseSshBridgeEndpoint,
} = require("./sshBridgeDiscoveryPath.cjs");

const BRIDGE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netcatty$/;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_LINE_BYTES = 4096;

function fail(message, code = 1) {
  try {
    process.stderr.write(`[netcatty-ssh-proxy] ${message}\n`);
  } catch {
    // ignore stderr write failures
  }
  process.exit(code);
}

function runProxy(argv = process.argv.slice(2)) {
  const targetHost = typeof argv[0] === "string" ? argv[0].trim().toLowerCase() : "";
  if (!BRIDGE_HOST_RE.test(targetHost)) {
    fail(`Invalid Netcatty bridge host "${targetHost}". Expected "<alias>.netcatty".`);
  }

  const explicitDiscoveryArg = argv.length > 1
    ? argv.slice(1).join(" ").trim()
    : "";
  const discoveryPath = explicitDiscoveryArg || getSshBridgeDiscoveryFilePath();
  let discovery;
  try {
    const raw = fs.readFileSync(discoveryPath, "utf8");
    discovery = JSON.parse(raw);
  } catch (err) {
    fail(
      `Netcatty SSH bridge is not running (could not read ${discoveryPath}: ${err?.code || err?.message}). Open Netcatty and connect to the host first.`,
    );
  }

  const endpoint = typeof discovery?.endpoint === "string" ? discovery.endpoint : "";
  const token = typeof discovery?.token === "string" ? discovery.token : "";
  const connectTarget = parseSshBridgeEndpoint(endpoint);
  if (!connectTarget || !token) {
    fail("Netcatty SSH bridge discovery file is incomplete.");
  }

  const socket = net.createConnection(connectTarget);
  let handshakeDone = false;
  let handshakeBuf = Buffer.alloc(0);

  const timeout = setTimeout(() => {
    if (!handshakeDone) {
      socket.destroy();
      fail("Timed out waiting for Netcatty SSH bridge handshake.");
    }
  }, HANDSHAKE_TIMEOUT_MS);

  socket.on("error", (err) => {
    clearTimeout(timeout);
    if (!handshakeDone) {
      fail(`Failed to connect to Netcatty SSH bridge (${err?.code || err?.message}). Ensure Netcatty is running.`);
    } else {
      process.exit(0);
    }
  });

  socket.on("connect", () => {
    const line = JSON.stringify({ token, host: targetHost }) + "\n";
    socket.write(line);
  });

  const onHandshakeData = (chunk) => {
    handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
    const nlIndex = handshakeBuf.indexOf(0x0a);
    if (nlIndex === -1) {
      if (handshakeBuf.length > MAX_HANDSHAKE_LINE_BYTES) {
        clearTimeout(timeout);
        socket.destroy();
        fail("Handshake response exceeded maximum length.");
      }
      return;
    }

    clearTimeout(timeout);
    socket.removeListener("data", onHandshakeData);

    const headerLine = handshakeBuf.subarray(0, nlIndex).toString("utf8");
    const remainder = handshakeBuf.subarray(nlIndex + 1);

    let reply;
    try {
      reply = JSON.parse(headerLine);
    } catch {
      socket.destroy();
      fail("Invalid handshake response from Netcatty SSH bridge.");
    }

    if (!reply || reply.ok !== true) {
      socket.destroy();
      fail(reply?.error || "Netcatty SSH bridge rejected connection.");
    }

    handshakeDone = true;

    if (remainder.length > 0) {
      process.stdout.write(remainder);
    }

    socket.pipe(process.stdout);
    process.stdin.pipe(socket);

    process.stdin.on("end", () => {
      try {
        socket.end();
      } catch {
        // ignore
      }
    });

    socket.on("close", () => {
      process.exit(0);
    });

    process.stdout.on("error", () => {
      socket.destroy();
      process.exit(0);
    });
  };

  socket.on("data", onHandshakeData);
}

if (require.main === module) {
  runProxy();
}

module.exports = { runProxy };
