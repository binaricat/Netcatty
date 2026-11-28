"use strict";

/**
 * Local SSH Channel Multiplexer Bridge (`*.netcatty`)
 *
 * Exposes a local-only authenticated IPC server (`\\.\pipe\...` on Windows,
 * `0600` Unix domain socket on macOS/Linux) backed by an in-process `ssh2.Server`.
 *
 * External SSH clients (Zed, VS Code Remote-SSH, Cursor, Windsurf, `ssh`, `sftp`)
 * connect via OpenSSH `ProxyCommand netcatty-ssh-proxy <alias>.netcatty`.
 * After verifying a 256-bit per-instance discovery token, this bridge multiplexes
 * SSH channels (`exec`, `shell`, `pty`, `env`, `window-change`, `signal`,
 * `subsystem` including `sftp`, `direct-tcpip`, and `tcpip-forward`) directly
 * onto Netcatty's already-authenticated remote `ssh2.Client` transport.
 *
 * Security & privacy properties:
 * - Zero Netcatty hostnames, IPs, ports, jump hosts, passwords, or private keys
 *   are ever written to `~/.ssh/config` or exported to disk.
 * - Local bridge authentication uses a 256-bit random token stored in a `0600`
 *   discovery file, plus a verified per-installation Ed25519 host key stored in
 *   a dedicated `known_hosts` file (keeping `StrictHostKeyChecking yes`).
 * - Borrows a transport lease from `sshConnectionPool` while external clients
 *   are connected so idle park never tears down the transport mid-session.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const {
  borrowTransport,
  returnTransport,
  findTransportByEndpoint,
  LEASE_KINDS,
} = require("./sshConnectionPool.cjs");
const {
  getSshBridgeStateDir,
  getSshBridgeDiscoveryFilePath,
  getSshBridgeHostKeyPath,
  getSshBridgeKnownHostsPath,
  getSshBridgeSocketPath,
} = require("../cli/sshBridgeDiscoveryPath.cjs");

const BRIDGE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netcatty$/;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 4096;

let _ssh2 = null;
function getSsh2() {
  if (!_ssh2) {
    require("./boringSslDhCompat.cjs").installBoringSslDhCompat();
    _ssh2 = require("ssh2");
  }
  return _ssh2;
}

function isValidBridgeHostname(host) {
  return typeof host === "string" && BRIDGE_HOST_RE.test(host);
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dirPath, 0o700);
    } catch {
      // ignore chmod failures on exotic filesystems
    }
  }
}

function ensureHostKeyAndKnownHosts(options = {}) {
  const { utils } = getSsh2();
  const stateDir = getSshBridgeStateDir(options);
  ensurePrivateDir(stateDir);
  const keyPath = getSshBridgeHostKeyPath(options);
  const knownHostsPath = getSshBridgeKnownHostsPath(options);

  let privateKeyPem = null;
  let publicKeyOpenSsh = null;

  if (fs.existsSync(keyPath)) {
    try {
      const raw = fs.readFileSync(keyPath, "utf8");
      const parsed = utils.parseKey(raw);
      if (parsed && !(parsed instanceof Error) && typeof parsed.getPublicSSH === "function") {
        privateKeyPem = raw;
        publicKeyOpenSsh = `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
      }
    } catch {
      // Regenerate below if corrupted.
    }
  }

  if (!privateKeyPem || !publicKeyOpenSsh) {
    const pair = utils.generateKeyPairSync("ed25519");
    privateKeyPem = pair.private;
    publicKeyOpenSsh = pair.public.trim();
    fs.writeFileSync(keyPath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch {
        // ignore
      }
    }
  }

  const knownHostsLine = `*.netcatty ${publicKeyOpenSsh}\n`;
  let existingKnownHosts = "";
  try {
    existingKnownHosts = fs.readFileSync(knownHostsPath, "utf8");
  } catch {
    // not created yet
  }
  if (existingKnownHosts !== knownHostsLine) {
    fs.writeFileSync(knownHostsPath, knownHostsLine, { encoding: "utf8", mode: 0o600 });
  }

  return {
    privateKeyPem,
    publicKeyOpenSsh,
    keyPath,
    knownHostsPath,
  };
}

function isConnHealthy(conn) {
  if (!conn) return false;
  if (conn._sock && conn._sock.destroyed) return false;
  if (typeof conn.exec !== "function") return false;
  return true;
}

function getLiveTransport(transport) {
  return transport && transport.state !== "dead" && transport.state !== "closing"
    ? transport
    : null;
}

function getSftpClientTransport(sftpClient, sftpClients) {
  if (!sftpClient) return null;
  const direct = sftpClient.__netcattyRefHolder?.connRef || sftpClient.connRef || null;
  if (direct) return direct;
  if (sftpClient.__netcattySharedChannelOwnerId && sftpClients?.get) {
    const owner = sftpClients.get(sftpClient.__netcattySharedChannelOwnerId);
    if (owner && owner !== sftpClient) {
      return owner.__netcattyRefHolder?.connRef || owner.connRef || null;
    }
  }
  return null;
}

function getSftpClientConn(sftpClient, sftpClients) {
  const transport = getSftpClientTransport(sftpClient, sftpClients);
  return transport?.conn || sftpClient?._sshConn || sftpClient?.client || null;
}

function getSftpClientEndpoint(sftpClient, sftpClients) {
  const transport = getSftpClientTransport(sftpClient, sftpClients);
  return transport?.endpoint || sftpClient?._reuseEndpoint || null;
}

function matchesTargetEndpointTuple(target, ep) {
  return Boolean(
    target.hostname
    && String(ep.hostname || "").toLowerCase() === String(target.hostname).toLowerCase()
    && Number(ep.port || 22) === Number(target.port || 22)
    && (!target.username || ep.username === target.username),
  );
}

/**
 * Resolve a live remote `ssh2.Client` (and optional `sshConnectionPool` transport)
 * for a registered bridge target.
 */
function resolveRemoteTransportForTarget(target, { sessions, sftpClients }) {
  if (!target) return null;

  // 1. Prefer the exact originating terminal session if still live.
  if (target.sessionId && sessions?.get) {
    const session = sessions.get(target.sessionId);
    if (session?.conn && isConnHealthy(session.conn)) {
      return { conn: session.conn, transport: getLiveTransport(session.connRef) };
    }
  }

  // 2. Check originating SFTP client if invoked from SFTP browser.
  if (target.sftpId && sftpClients?.get) {
    const sftpClient = sftpClients.get(target.sftpId);
    const conn = getSftpClientConn(sftpClient, sftpClients);
    if (isConnHealthy(conn)) {
      const transport = getLiveTransport(getSftpClientTransport(sftpClient, sftpClients));
      return { conn, transport };
    }
  }

  // 3. Fall back to any live terminal session matching hostId or (when profile
  //    identity does not conflict) hostname+port+username.
  if (sessions?.values) {
    let endpointFallback = null;
    for (const session of sessions.values()) {
      if (!session?.conn || !isConnHealthy(session.conn)) continue;
      const ep = session._reuseEndpoint || session.connRef?.endpoint;
      if (!ep) continue;
      if (target.hostId && ep.hostId && ep.hostId !== target.hostId) {
        continue;
      }
      if (target.hostId && ep.hostId && ep.hostId === target.hostId) {
        return {
          conn: session.conn,
          transport: getLiveTransport(session.connRef),
        };
      }
      if (!endpointFallback && matchesTargetEndpointTuple(target, ep)) {
        endpointFallback = {
          conn: session.conn,
          transport: getLiveTransport(session.connRef),
        };
      }
    }
    if (endpointFallback) return endpointFallback;
  }

  // 4. Fall back to any live SFTP client matching hostId or (when profile
  //    identity does not conflict) hostname+port+username.
  if (sftpClients?.values) {
    let endpointFallback = null;
    for (const sftpClient of sftpClients.values()) {
      const conn = getSftpClientConn(sftpClient, sftpClients);
      if (!isConnHealthy(conn)) continue;
      const ep = getSftpClientEndpoint(sftpClient, sftpClients);
      if (!ep) continue;
      if (target.hostId && ep.hostId && ep.hostId !== target.hostId) {
        continue;
      }
      const transport = getLiveTransport(getSftpClientTransport(sftpClient, sftpClients));
      if (target.hostId && ep.hostId && ep.hostId === target.hostId) {
        return { conn, transport };
      }
      if (!endpointFallback && matchesTargetEndpointTuple(target, ep)) {
        endpointFallback = { conn, transport };
      }
    }
    if (endpointFallback) return endpointFallback;
  }

  // 5. Wake an idle-parked transport in sshConnectionPool if one exists for the endpoint.
  if (target.hostname) {
    try {
      const transport = findTransportByEndpoint({
        hostId: target.hostId,
        hostname: target.hostname,
        port: target.port || 22,
        username: target.username || "",
        protocol: "ssh",
      }, { kind: "channel" });
      if (transport?.conn && isConnHealthy(transport.conn)) {
        return { conn: transport.conn, transport };
      }
    } catch {
      // ignore lookup errors
    }
  }

  return null;
}

/**
 * Wire bidirectional data, stderr, exit, signal, and window-change between
 * an accepted local ssh2.Server channel (`clientStream`) and a remote ssh2.Client
 * channel (`remoteStream`), applying backpressure in every direction.
 */
function bridgeChannelStreams(clientStream, remoteStream, options = {}) {
  let closed = false;
  let exitForwarded = false;
  let pendingExit = null;
  const relayCleanups = [];

  const relayWithBackpressure = (source, dest, { onWriteError, initiallyBackpressured = false } = {}) => {
    let waitingDrain = Boolean(initiallyBackpressured);
    const onDrain = () => {
      if (!waitingDrain) return;
      waitingDrain = false;
      if (!closed) {
        try {
          source.resume?.();
        } catch {
          // ignore
        }
      }
    };

    const onData = (chunk) => {
      if (closed) return;
      try {
        const ok = dest.write(chunk);
        if (ok === false && !waitingDrain && typeof source.pause === "function") {
          waitingDrain = true;
          source.pause();
        }
      } catch {
        if (onWriteError) onWriteError();
      }
    };

    if (waitingDrain && typeof source.pause === "function") {
      try {
        source.pause();
      } catch {
        // ignore
      }
    }

    dest.on("drain", onDrain);
    source.on("data", onData);

    relayCleanups.push(() => {
      try {
        dest.removeListener?.("drain", onDrain);
      } catch {
        // ignore
      }
      try {
        source.removeListener?.("data", onData);
      } catch {
        // ignore
      }
    });
  };

  const cleanupRelays = () => {
    while (relayCleanups.length > 0) {
      const fn = relayCleanups.pop();
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };

  const flushExit = () => {
    if (exitForwarded || !pendingExit) return;
    exitForwarded = true;
    const { code, signalName, didCoreDump, description } = pendingExit;
    try {
      if (typeof code === "number") {
        clientStream.exit(code);
      } else if (signalName) {
        clientStream.exit(signalName, Boolean(didCoreDump), description || "");
      } else {
        clientStream.exit(0);
      }
    } catch {
      // ignore
    }
  };

  const finishClose = () => {
    if (closed) return;
    closed = true;
    cleanupRelays();
    flushExit();
    try {
      clientStream.end();
    } catch {
      // ignore
    }
    try {
      clientStream.close?.();
    } catch {
      // ignore
    }
    try {
      remoteStream.end();
    } catch {
      // ignore
    }
  };

  relayWithBackpressure(remoteStream, clientStream, {
    onWriteError: finishClose,
  });

  if (remoteStream.stderr && clientStream.stderr) {
    relayWithBackpressure(remoteStream.stderr, clientStream.stderr);
  }

  relayWithBackpressure(clientStream, remoteStream, {
    onWriteError: finishClose,
    initiallyBackpressured: Boolean(options.clientInitiallyBackpressured),
  });

  clientStream.on("end", () => {
    try {
      remoteStream.end();
    } catch {
      // ignore
    }
  });

  remoteStream.on("end", () => {
    flushExit();
    try {
      clientStream.end();
    } catch {
      // ignore
    }
  });

  remoteStream.on("exit", (code, signalName, didCoreDump, description) => {
    pendingExit = { code, signalName, didCoreDump, description };
  });

  remoteStream.on("close", (code, signalName, didCoreDump, description) => {
    if (!pendingExit && (typeof code === "number" || signalName)) {
      pendingExit = { code, signalName, didCoreDump, description };
    }
    finishClose();
  });

  clientStream.on("close", () => {
    closed = true;
    cleanupRelays();
    try {
      remoteStream.close?.();
    } catch {
      // ignore
    }
    try {
      remoteStream.end?.();
    } catch {
      // ignore
    }
  });

  remoteStream.on("error", () => {
    finishClose();
  });
  clientStream.on("error", () => {
    finishClose();
  });
}

function attachClientChannelMultiplexer(client, remoteConn) {
  // Reverse port forwarding registrations owned by this client connection.
  const activeReverseForwards = new Map();

  client.on("authentication", (ctx) => {
    // The underlying local socket ALREADY presented our 256-bit per-instance
    // discovery token over an owner-only local socket / Windows named pipe.
    ctx.accept();
  });

  client.on("ready", () => {
    client.on("session", (acceptSession) => {
      const session = acceptSession();
      let ptyInfo = null;
      const envVars = {};
      let activeRemoteStream = null;

      session.on("env", (accept, _reject, info) => {
        if (info?.key && typeof info.val === "string") {
          envVars[info.key] = info.val;
        }
        accept?.();
      });

      session.on("pty", (accept, _reject, info) => {
        ptyInfo = {
          rows: info.rows,
          cols: info.cols,
          height: info.height,
          width: info.width,
          term: info.term,
          modes: info.modes,
        };
        accept?.();
      });

      session.on("window-change", (accept, _reject, info) => {
        if (ptyInfo) {
          ptyInfo.rows = info.rows;
          ptyInfo.cols = info.cols;
          ptyInfo.height = info.height;
          ptyInfo.width = info.width;
        }
        try {
          activeRemoteStream?.setWindow?.(info.rows, info.cols, info.height, info.width);
        } catch {
          // ignore
        }
        accept?.();
      });

      session.on("signal", (accept, _reject, info) => {
        try {
          if (info?.name) activeRemoteStream?.signal?.(info.name);
        } catch {
          // ignore
        }
        accept?.();
      });

      const buildExecShellOptions = () => {
        const opts = {};
        if (ptyInfo) opts.pty = ptyInfo;
        if (Object.keys(envVars).length > 0) opts.env = { ...envVars };
        return opts;
      };

      const MAX_EARLY_BUFFER_BYTES = 64 * 1024;
      const acceptAndBridge = (accept, openRemote) => {
        // Call accept() synchronously before any async remote channel open!
        // OpenSSH clients with stdin=/dev/null (including Zed on Windows) send
        // SSH_MSG_CHANNEL_EOF immediately after the exec/shell/subsystem request;
        // ssh2's Session marks `_ending = true` on CHANNEL_EOF and silently
        // drops any late `accept()` call, which would otherwise hang OpenSSH.
        const clientStream = accept();
        if (!clientStream) return;

        const earlyChunks = [];
        let earlyBytes = 0;
        let clientPausedEarly = false;
        let clientEndedEarly = false;
        let clientClosedEarly = false;

        const onEarlyData = (chunk) => {
          earlyChunks.push(chunk);
          earlyBytes += chunk.length;
          if (!clientPausedEarly && earlyBytes >= MAX_EARLY_BUFFER_BYTES && typeof clientStream.pause === "function") {
            clientPausedEarly = true;
            clientStream.pause();
          }
        };
        const onEarlyEnd = () => { clientEndedEarly = true; };
        const onEarlyClose = () => { clientClosedEarly = true; };

        clientStream.on("data", onEarlyData);
        clientStream.once("end", onEarlyEnd);
        clientStream.once("close", onEarlyClose);

        openRemote((err, remoteStream) => {
          clientStream.removeListener("data", onEarlyData);
          clientStream.removeListener("end", onEarlyEnd);
          clientStream.removeListener("close", onEarlyClose);

          if (err || !remoteStream) {
            try {
              if (err?.message && clientStream.stderr) {
                clientStream.stderr.write(`${err.message}\n`);
              }
              clientStream.exit(1);
              clientStream.end();
              clientStream.close?.();
            } catch {
              // ignore
            }
            return;
          }

          if (clientClosedEarly) {
            try { remoteStream.close?.(); } catch {}
            try { remoteStream.end?.(); } catch {}
            return;
          }

          let clientInitiallyBackpressured = false;
          for (const chunk of earlyChunks) {
            try {
              if (remoteStream.write(chunk) === false) {
                clientInitiallyBackpressured = true;
              }
            } catch {
              break;
            }
          }

          activeRemoteStream = remoteStream;
          bridgeChannelStreams(clientStream, remoteStream, {
            clientInitiallyBackpressured,
          });

          if (!clientInitiallyBackpressured && clientPausedEarly && typeof clientStream.resume === "function") {
            try {
              clientStream.resume();
            } catch {
              // ignore
            }
          }

          if (clientEndedEarly) {
            try {
              remoteStream.end();
            } catch {
              // ignore
            }
          }
        });
      };

      session.on("exec", (accept, _reject, info) => {
        const command = info?.command ?? "";
        acceptAndBridge(accept, (cb) => remoteConn.exec(command, buildExecShellOptions(), cb));
      });

      session.on("shell", (accept) => {
        const shellOpts = buildExecShellOptions();
        const windowArg = ptyInfo || false;
        acceptAndBridge(accept, (cb) => remoteConn.shell(windowArg, shellOpts, cb));
      });

      session.on("subsystem", (accept, reject, info) => {
        const name = info?.name;
        if (!name || typeof remoteConn.subsys !== "function") {
          reject?.();
          return;
        }
        acceptAndBridge(accept, (cb) => remoteConn.subsys(name, cb));
      });
    });

    // Local port forwarding (`ssh -L`, used by Zed and VS Code port forwarding)
    client.on("tcpip", (accept, reject, info) => {
      if (typeof remoteConn.forwardOut !== "function") {
        reject();
        return;
      }
      remoteConn.forwardOut(
        info.srcIP,
        info.srcPort,
        info.destIP,
        info.destPort,
        (err, remoteStream) => {
          if (err || !remoteStream) {
            reject();
            return;
          }
          const clientStream = accept();
          clientStream.pipe(remoteStream);
          remoteStream.pipe(clientStream);
          const cleanup = () => {
            try { clientStream.destroy(); } catch {}
            try { remoteStream.destroy(); } catch {}
          };
          clientStream.on("error", cleanup);
          remoteStream.on("error", cleanup);
        },
      );
    });

    // Reverse port forwarding (`ssh -R`)
    client.on("request", (accept, reject, name, info) => {
      if (name === "tcpip-forward" && typeof remoteConn.forwardIn === "function") {
        const bindAddr = info.bindAddr || "127.0.0.1";
        const bindPort = info.bindPort || 0;
        remoteConn.forwardIn(bindAddr, bindPort, (err, actualPort) => {
          if (err) {
            reject?.();
            return;
          }
          const assignedPort = actualPort || bindPort;
          const key = `${bindAddr}:${assignedPort}`;
          activeReverseForwards.set(key, { bindAddr, bindPort: assignedPort });
          accept?.(assignedPort);
        });
        return;
      }
      if (name === "cancel-tcpip-forward" && typeof remoteConn.unforwardIn === "function") {
        const bindAddr = info.bindAddr || "127.0.0.1";
        const bindPort = info.bindPort || 0;
        const key = `${bindAddr}:${bindPort}`;
        activeReverseForwards.delete(key);
        remoteConn.unforwardIn(bindAddr, bindPort, (err) => {
          if (err) reject?.();
          else accept?.();
        });
        return;
      }
      reject?.();
    });

    const onRemoteTcpConnection = (details, acceptRemote, rejectRemote) => {
      const key = `${details.destIP}:${details.destPort}`;
      if (!activeReverseForwards.has(key)) return;
      client.forwardOut(
        details.destIP,
        details.destPort,
        details.srcIP,
        details.srcPort,
        (err, clientStream) => {
          if (err || !clientStream) {
            rejectRemote();
            return;
          }
          const remoteStream = acceptRemote();
          remoteStream.pipe(clientStream);
          clientStream.pipe(remoteStream);
        },
      );
    };

    if (typeof remoteConn.on === "function") {
      remoteConn.on("tcp connection", onRemoteTcpConnection);
    }

    client.once("close", () => {
      if (typeof remoteConn.removeListener === "function") {
        remoteConn.removeListener("tcp connection", onRemoteTcpConnection);
      }
      for (const { bindAddr, bindPort } of activeReverseForwards.values()) {
        try {
          remoteConn.unforwardIn?.(bindAddr, bindPort, () => {});
        } catch {
          // ignore
        }
      }
      activeReverseForwards.clear();
    });
  });

  client.on("error", () => {
    // Expected when external SSH clients disconnect abruptly.
  });
}

function createSshChannelBridge(options = {}) {
  let sessions = options.sessions || null;
  let sftpClients = options.sftpClients || null;
  let userDataDir = options.userDataDir || null;
  let stateDir = options.stateDir || null;

  /** @type {Map<string, object>} bridgeHost -> target descriptor */
  const targets = new Map();
  /** @type {Set<net.Socket>} */
  const activeSockets = new Set();

  let ipcServer = null;
  let started = false;
  let startingPromise = null;
  let authToken = null;
  let socketEndpoint = null;
  let discoveryPath = null;
  let hostKeyInfo = null;

  function init(deps = {}) {
    if (deps.sessions) sessions = deps.sessions;
    if (deps.sftpClients) sftpClients = deps.sftpClients;
    if (deps.userDataDir) userDataDir = deps.userDataDir;
    if (deps.stateDir) stateDir = deps.stateDir;
  }

  function getPathOptions() {
    return {
      ...(userDataDir ? { userDataDir } : {}),
      ...(stateDir ? { stateDir } : {}),
    };
  }

  function writeHandshakeReply(socket, payload) {
    try {
      socket.write(JSON.stringify(payload) + "\n");
    } catch {
      // ignore
    }
  }

  function handleIncomingSocket(socket) {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));

    let handshakeDone = false;
    let handshakeBuf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      if (!handshakeDone) {
        writeHandshakeReply(socket, { ok: false, error: "Handshake timed out" });
        socket.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const onData = (chunk) => {
      handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
      const nlIndex = handshakeBuf.indexOf(0x0a);
      if (nlIndex === -1) {
        if (handshakeBuf.length > MAX_HANDSHAKE_BYTES) {
          clearTimeout(timer);
          writeHandshakeReply(socket, { ok: false, error: "Handshake too large" });
          socket.destroy();
        }
        return;
      }

      clearTimeout(timer);
      socket.removeListener("data", onData);
      handshakeDone = true;

      const headerStr = handshakeBuf.subarray(0, nlIndex).toString("utf8");
      const remainder = handshakeBuf.subarray(nlIndex + 1);

      let request;
      try {
        request = JSON.parse(headerStr);
      } catch {
        writeHandshakeReply(socket, { ok: false, error: "Malformed handshake JSON" });
        socket.destroy();
        return;
      }

      if (!timingSafeStringEqual(request?.token, authToken)) {
        writeHandshakeReply(socket, { ok: false, error: "Unauthorized" });
        socket.destroy();
        return;
      }

      const bridgeHost = typeof request?.host === "string" ? request.host.trim().toLowerCase() : "";
      if (!isValidBridgeHostname(bridgeHost)) {
        writeHandshakeReply(socket, { ok: false, error: "Invalid bridge host" });
        socket.destroy();
        return;
      }

      const target = targets.get(bridgeHost);
      if (!target) {
        writeHandshakeReply(socket, {
          ok: false,
          error: `No active Netcatty session registered for ${bridgeHost}. Open it from Netcatty first.`,
        });
        socket.destroy();
        return;
      }

      const resolved = resolveRemoteTransportForTarget(target, { sessions, sftpClients });
      if (!resolved?.conn) {
        writeHandshakeReply(socket, {
          ok: false,
          error: `Netcatty SSH session for ${bridgeHost} is disconnected. Reconnect in Netcatty and try again.`,
        });
        socket.destroy();
        return;
      }

      // Borrow a lease on the shared SSH transport while this external SSH client is connected.
      const leaseHolder = { id: `ssh-bridge:${bridgeHost}:${crypto.randomUUID()}` };
      let leased = false;
      if (resolved.transport) {
        try {
          borrowTransport(resolved.transport, {
            kind: LEASE_KINDS.forward,
            holder: leaseHolder,
            meta: { source: "sshChannelBridge", bridgeHost },
          });
          leased = true;
        } catch {
          // If transport cannot be leased (e.g., synthetic test conn), continue with direct conn.
        }
      }

      const releaseLease = () => {
        if (!leased) return;
        leased = false;
        try {
          returnTransport(leaseHolder);
        } catch {
          // ignore
        }
      };

      socket.once("close", releaseLease);

      // Acknowledge handshake, then hand the raw socket to an isolated ssh2.Server instance.
      writeHandshakeReply(socket, { ok: true });

      const { Server } = getSsh2();
      const sshServer = new Server(
        {
          hostKeys: [hostKeyInfo.privateKeyPem],
          ident: "SSH-2.0-NetcattyBridge_1.0",
        },
        (client) => {
          attachClientChannelMultiplexer(client, resolved.conn);
          client.once("close", releaseLease);
        },
      );
      sshServer.on("error", () => {
        releaseLease();
      });

      if (remainder.length > 0) {
        socket.unshift(remainder);
      }
      sshServer.injectSocket(socket);
    };

    socket.on("data", onData);
    socket.on("error", () => {
      clearTimeout(timer);
    });
  }

  async function ensureStarted() {
    if (started && ipcServer) {
      return getStatus();
    }
    if (startingPromise) return startingPromise;

    startingPromise = (async () => {
      const pathOpts = getPathOptions();
      hostKeyInfo = ensureHostKeyAndKnownHosts(pathOpts);
      authToken = crypto.randomBytes(32).toString("hex");
      const nonce = crypto.randomBytes(6).toString("hex");
      socketEndpoint = getSshBridgeSocketPath({ ...pathOpts, nonce });
      discoveryPath = getSshBridgeDiscoveryFilePath(pathOpts);

      if (process.platform !== "win32") {
        try {
          if (fs.existsSync(socketEndpoint)) fs.unlinkSync(socketEndpoint);
        } catch {
          // ignore stale socket cleanup errors
        }
      }

      const server = net.createServer(handleIncomingSocket);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketEndpoint, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });

      if (process.platform !== "win32") {
        try {
          fs.chmodSync(socketEndpoint, 0o600);
        } catch {
          // ignore
        }
      }

      ipcServer = server;
      started = true;

      const discoveryPayload = {
        version: 1,
        pid: process.pid,
        endpoint: socketEndpoint,
        token: authToken,
        knownHostsPath: hostKeyInfo.knownHostsPath,
        startedAt: Date.now(),
      };
      ensurePrivateDir(path.dirname(discoveryPath));
      const tmpDiscovery = `${discoveryPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpDiscovery, JSON.stringify(discoveryPayload, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tmpDiscovery, discoveryPath);

      return getStatus();
    })();

    try {
      return await startingPromise;
    } finally {
      startingPromise = null;
    }
  }

  async function registerTarget(payload = {}) {
    if (typeof payload.userDataDir === "string" && payload.userDataDir && !userDataDir) {
      userDataDir = payload.userDataDir;
    }
    const bridgeHost = typeof payload.bridgeHost === "string"
      ? payload.bridgeHost.trim().toLowerCase()
      : "";
    if (!isValidBridgeHostname(bridgeHost)) {
      throw new Error(`Invalid SSH bridge hostname: ${bridgeHost}`);
    }
    const status = await ensureStarted();
    const record = {
      bridgeHost,
      sessionId: typeof payload.sessionId === "string" && payload.sessionId ? payload.sessionId : null,
      sftpId: typeof payload.sftpId === "string" && payload.sftpId ? payload.sftpId : null,
      hostId: typeof payload.hostId === "string" && payload.hostId ? payload.hostId : null,
      hostname: typeof payload.hostname === "string" ? payload.hostname : "",
      port: Number.isInteger(payload.port) && payload.port > 0 ? payload.port : 22,
      username: typeof payload.username === "string" ? payload.username : "",
      updatedAt: Date.now(),
    };

    const resolved = resolveRemoteTransportForTarget(record, { sessions, sftpClients });
    if (!resolved?.conn) {
      throw new Error("No active SSH connection is available for this host.");
    }

    targets.set(bridgeHost, record);
    return {
      ...status,
      bridgeHost,
      connected: true,
    };
  }

  function unregisterTarget(bridgeHost) {
    if (typeof bridgeHost === "string") {
      targets.delete(bridgeHost.trim().toLowerCase());
    }
    return { ok: true };
  }

  function getStatus() {
    const pathOpts = getPathOptions();
    return {
      running: started && Boolean(ipcServer),
      endpoint: socketEndpoint,
      discoveryPath: discoveryPath || getSshBridgeDiscoveryFilePath(pathOpts),
      knownHostsPath: hostKeyInfo?.knownHostsPath || getSshBridgeKnownHostsPath(pathOpts),
      registeredTargets: targets.size,
    };
  }

  async function stop() {
    started = false;
    targets.clear();
    for (const sock of Array.from(activeSockets)) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    activeSockets.clear();

    const serverToClose = ipcServer;
    ipcServer = null;
    if (serverToClose) {
      await new Promise((resolve) => {
        try {
          serverToClose.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    if (process.platform !== "win32" && socketEndpoint) {
      try {
        if (fs.existsSync(socketEndpoint)) fs.unlinkSync(socketEndpoint);
      } catch {
        // ignore
      }
    }

    if (discoveryPath) {
      try {
        if (fs.existsSync(discoveryPath)) {
          const current = JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
          if (current?.pid === process.pid) {
            fs.unlinkSync(discoveryPath);
          }
        }
      } catch {
        // ignore
      }
    }

    authToken = null;
    socketEndpoint = null;
    return { ok: true };
  }

  function registerHandlers(ipcMain, { terminalWorkerManager } = {}) {
    ipcMain.handle("netcatty:ssh-bridge:register-target", async (event, payload) => {
      if (terminalWorkerManager) {
        return terminalWorkerManager.request("netcatty:ssh-bridge:register-target", payload, {
          webContentsId: event?.sender?.id,
        });
      }
      return registerTarget(payload);
    });

    ipcMain.handle("netcatty:ssh-bridge:unregister-target", async (event, payload) => {
      if (terminalWorkerManager) {
        return terminalWorkerManager.request("netcatty:ssh-bridge:unregister-target", payload, {
          webContentsId: event?.sender?.id,
        });
      }
      return unregisterTarget(payload?.bridgeHost);
    });

    ipcMain.handle("netcatty:ssh-bridge:status", async (event) => {
      if (terminalWorkerManager) {
        return terminalWorkerManager.request("netcatty:ssh-bridge:status", {}, {
          webContentsId: event?.sender?.id,
        });
      }
      return getStatus();
    });

    ipcMain.handle("netcatty:ssh-bridge:stop", async (event) => {
      if (terminalWorkerManager) {
        return terminalWorkerManager.request("netcatty:ssh-bridge:stop", {}, {
          webContentsId: event?.sender?.id,
        });
      }
      return stop();
    });
  }

  return {
    init,
    ensureStarted,
    registerTarget,
    unregisterTarget,
    getStatus,
    stop,
    registerHandlers,
  };
}

const defaultBridge = createSshChannelBridge();

module.exports = {
  createSshChannelBridge,
  ensureHostKeyAndKnownHosts,
  isValidBridgeHostname,
  resolveRemoteTransportForTarget,
  bridgeChannelStreams,
  init: defaultBridge.init,
  ensureStarted: defaultBridge.ensureStarted,
  registerTarget: defaultBridge.registerTarget,
  unregisterTarget: defaultBridge.unregisterTarget,
  getStatus: defaultBridge.getStatus,
  stop: defaultBridge.stop,
  registerHandlers: defaultBridge.registerHandlers,
};
