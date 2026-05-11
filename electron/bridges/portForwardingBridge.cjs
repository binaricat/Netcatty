/**
 * Port Forwarding Bridge - Handles SSH port forwarding tunnels
 * Extracted from main.cjs for single responsibility
 */

const net = require("node:net");
const { Client: SSHClient } = require("ssh2");
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const { connectThroughChain, buildAlgorithms } = require("./sshBridge.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const { 
  buildAuthHandler, 
  createKeyboardInteractiveHandler, 
  applyAuthToConnOpts,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
  preparePrivateKeyForAuth,
  loadFirstIdentityFileForAuth,
  isPassphraseCancelledError,
} = require("./sshAuthHelper.cjs");

// Active port forwarding tunnels
const portForwardingTunnels = new Map();

function cleanupChainConnections(connections) {
  if (!Array.isArray(connections)) return;
  for (const chainConn of connections) {
    try { chainConn.end(); } catch { /* ignore */ }
  }
}

function isTunnelCancelled(tunnelState) {
  return Boolean(tunnelState?.cancelled);
}

function cancelTunnel(tunnelId, tunnel, sendStatus, { deleteEntry = false } = {}) {
  if (!tunnel) return;
  tunnel.cancelled = true;
  tunnel.status = 'inactive';
  if (tunnel.server) {
    try { tunnel.server.close(); } catch { /* ignore */ }
  }
  if (tunnel.passphraseAbortController && !tunnel.passphraseAbortController.signal.aborted) {
    try { tunnel.passphraseAbortController.abort(); } catch { /* ignore */ }
  }
  if (tunnel.pendingConn) {
    try { tunnel.pendingConn.end(); } catch { /* ignore */ }
  }
  cleanupChainConnections(tunnel.chainConnections);
  if (tunnel.conn) {
    try { tunnel.conn.end(); } catch { /* ignore */ }
  }
  sendStatus?.('inactive');
  if (deleteEntry) {
    portForwardingTunnels.delete(tunnelId);
  }
}

const { safeSend } = require("./ipcUtils.cjs");

/**
 * Start a port forwarding tunnel
 */
async function startPortForward(event, payload) {
  const {
    ruleId,
    tunnelId,
    type, // 'local' | 'remote' | 'dynamic'
    localPort,
    bindAddress = '127.0.0.1',
    remoteHost,
    remotePort,
    hostname,
    port = 22,
    username,
    password,
    privateKey,
    certificate,
    keyId,
    passphrase,
    proxy,
    jumpHosts = [],
    identityFilePaths,
    legacyAlgorithms,
    keepaliveInterval: resolvedKeepaliveInterval,
    keepaliveCountMax: resolvedKeepaliveCountMax,
  } = payload;

  const conn = new SSHClient();
  const sender = event.sender;
  const hasJumpHosts = jumpHosts.length > 0;
  const hasProxy = !!proxy;
  let chainConnections = [];
  let connectionSocket = null;
  const passphraseAbortController = new AbortController();
  const tunnelState = {
    type,
    conn,
    pendingConn: null,
    server: null,
    chainConnections,
    passphraseAbortController,
    ruleId,
    status: 'connecting',
    webContentsId: sender.id,
    cancelled: false,
  };

  const sendStatus = (status, error = null) => {
    if (!sender.isDestroyed()) {
      sender.send("netcatty:portforward:status", { tunnelId, status, error });
    }
  };

  // Keepalive policy:
  //   - positive value: honor it
  //   - explicit 0: truly disabled (host opted out via per-host override —
  //     a router/switch that doesn't reply to keepalive@openssh.com would
  //     otherwise be killed by ssh2 after countMax unanswered probes)
  //   - undefined: legacy caller path, fall back to 10s/3 so an idle
  //     forwarded TCP tunnel doesn't get dropped by NAT state tables.
  const tunnelKeepaliveMs = resolvedKeepaliveInterval == null
    ? 10000
    : (resolvedKeepaliveInterval > 0 ? resolvedKeepaliveInterval * 1000 : 0);
  const tunnelKeepaliveCountMax = resolvedKeepaliveInterval == null
    ? 3
    : (resolvedKeepaliveInterval > 0 ? (resolvedKeepaliveCountMax ?? 3) : 0);
  const connectOpts = {
    host: hostname,
    port: port,
    username: username || 'root',
    readyTimeout: 120000, // 2 minutes for 2FA input
    keepaliveInterval: tunnelKeepaliveMs,
    keepaliveCountMax: tunnelKeepaliveCountMax,
    // Enable keyboard-interactive authentication (required for 2FA/MFA)
    tryKeyboard: true,
    algorithms: buildAlgorithms(legacyAlgorithms),
  };

  const hasCertificate = typeof certificate === "string" && certificate.trim().length > 0;
  sendStatus('connecting');
  portForwardingTunnels.set(tunnelId, tunnelState);

  let defaultKeys = [];
  try {
    const identityFile = !privateKey
      ? await loadFirstIdentityFileForAuth({
        sender,
        identityFilePaths,
        hostname,
        initialPassphrase: passphrase,
        passphraseSignal: passphraseAbortController.signal,
        logPrefix: "[PortForward]",
        onError: (err, keyPath) => {
          console.warn(`[PortForward] Failed to read identity file ${keyPath}:`, err.message);
        },
      })
      : null;
    const inlineKey = privateKey
      ? await preparePrivateKeyForAuth({
        sender,
        privateKey,
        keyId,
        keyName: keyId || username,
        hostname,
        initialPassphrase: passphrase,
        passphraseSignal: passphraseAbortController.signal,
        logPrefix: "[PortForward]",
      })
      : null;
    const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
    const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;

    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }

    if (hasCertificate) {
      connectOpts.agent = new NetcattyAgent({
        mode: "certificate",
        webContents: sender,
        meta: {
          label: keyId || username || "",
          certificate,
          privateKey: effectivePrivateKey,
          passphrase: effectivePassphrase,
        },
      });
    } else if (effectivePrivateKey) {
      connectOpts.privateKey = effectivePrivateKey;
      if (effectivePassphrase) {
        connectOpts.passphrase = effectivePassphrase;
      }
    }
    if (password) {
      connectOpts.password = password;
    }

    // Get default keys
    defaultKeys = await findAllDefaultPrivateKeysFromHelper();
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }

    // Build auth handler using shared helper
    const authConfig = buildAuthHandler({
      privateKey: connectOpts.privateKey,
      password,
      passphrase: connectOpts.passphrase,
      agent: connectOpts.agent,
      username: connectOpts.username,
      logPrefix: "[PortForward]",
      defaultKeys,
    });
    applyAuthToConnOpts(connectOpts, authConfig);
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }

    if (hasJumpHosts) {
      const chainResult = await connectThroughChain(
        event,
        {
          hostname,
          port,
          username,
          password,
          privateKey,
          passphrase,
          proxy,
          jumpHosts,
          legacyAlgorithms,
          _defaultKeys: defaultKeys,
          _connectionsRef: chainConnections,
          _tunnelRef: tunnelState,
          _passphraseSignal: passphraseAbortController.signal,
        },
        jumpHosts,
        hostname,
        port,
        tunnelId,
      );
      connectionSocket = chainResult.socket;
      chainConnections = chainResult.connections;
      tunnelState.chainConnections = chainConnections;
      if (isTunnelCancelled(tunnelState)) {
        cleanupChainConnections(chainConnections);
        portForwardingTunnels.delete(tunnelId);
        return { tunnelId, success: false, cancelled: true };
      }
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    } else if (hasProxy) {
      connectionSocket = await createProxySocket(proxy, hostname, port, {
        onSocket: (socket) => {
          tunnelState.pendingConn = socket;
        },
      });
      if (isTunnelCancelled(tunnelState)) {
        try { connectionSocket?.end?.(); } catch { /* ignore */ }
        try { connectionSocket?.destroy?.(); } catch { /* ignore */ }
        portForwardingTunnels.delete(tunnelId);
        return { tunnelId, success: false, cancelled: true };
      }
      tunnelState.pendingConn = null;
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    }
  } catch (err) {
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }
    if (isPassphraseCancelledError(err)) {
      cancelTunnel(tunnelId, tunnelState, sendStatus, { deleteEntry: true });
      return { tunnelId, success: false, cancelled: true };
    }
    tunnelState.cancelled = true;
    if (tunnelState.pendingConn) {
      try { tunnelState.pendingConn.end(); } catch { /* ignore */ }
    }
    cleanupChainConnections(tunnelState.chainConnections);
    if (connectionSocket) {
      try { connectionSocket.end?.(); } catch { /* ignore */ }
      try { connectionSocket.destroy?.(); } catch { /* ignore */ }
    }
    portForwardingTunnels.delete(tunnelId);
    sendStatus('error', err?.message || String(err));
    throw err;
  }

  // Handle keyboard-interactive authentication (2FA/MFA)
  conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
    sender,
    sessionId: tunnelId,
    hostname,
    password,
    logPrefix: "[PortForward]",
  }));

  return new Promise((resolve, reject) => {
    // Track whether the Promise has been settled so conn.on('close')
    // can reject if the tunnel was killed during SSH handshake.
    let settled = false;

    conn.once('ready', () => {
      console.log(`[PortForward] SSH connection ready for tunnel ${tunnelId}`);

      if (type === 'local') {
        // LOCAL FORWARDING: Listen on local port, forward to remote
        const server = net.createServer((socket) => {
          conn.forwardOut(
            bindAddress,
            localPort,
            remoteHost,
            remotePort,
            (err, stream) => {
              if (err) {
                console.error(`[PortForward] Forward error:`, err.message);
                socket.end();
                return;
              }
              socket.pipe(stream).pipe(socket);

              socket.on('error', (e) => console.warn('[PortForward] Socket error:', e.message));
              stream.on('error', (e) => console.warn('[PortForward] Stream error:', e.message));
            }
          );
        });

        server.on('error', (err) => {
          console.error(`[PortForward] Server error:`, err.message);
          sendStatus('error', err.message);
          conn.end();
          settled = true;
          reject(err);
        });

        server.listen(localPort, bindAddress, () => {
          console.log(`[PortForward] Local forwarding active: ${bindAddress}:${localPort} -> ${remoteHost}:${remotePort}`);
          tunnelState.type = 'local';
          tunnelState.conn = conn;
          tunnelState.server = server;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = 'active';
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus('active');
          settled = true;
          resolve({ tunnelId, success: true });
        });

      } else if (type === 'remote') {
        // REMOTE FORWARDING: Listen on remote port, forward to local
        conn.forwardIn(bindAddress, localPort, (err) => {
          if (err) {
            console.error(`[PortForward] Remote forward error:`, err.message);
            sendStatus('error', err.message);
            conn.end();
            settled = true;
            reject(err);
            return;
          }

          console.log(`[PortForward] Remote forwarding active: remote ${bindAddress}:${localPort} -> local ${remoteHost}:${remotePort}`);
          tunnelState.type = 'remote';
          tunnelState.conn = conn;
          tunnelState.server = null;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = 'active';
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus('active');
          settled = true;
          resolve({ tunnelId, success: true });
        });

        // Handle incoming connections from remote
        conn.on('tcp connection', (info, accept, rejectConn) => {
          const stream = accept();
          const socket = net.connect(remotePort, remoteHost || '127.0.0.1', () => {
            stream.pipe(socket).pipe(stream);
          });

          socket.on('error', (e) => {
            console.warn('[PortForward] Local socket error:', e.message);
            stream.end();
          });
          stream.on('error', (e) => {
            console.warn('[PortForward] Remote stream error:', e.message);
            socket.end();
          });
        });

      } else if (type === 'dynamic') {
        // DYNAMIC FORWARDING (SOCKS5 Proxy)
        const server = net.createServer((socket) => {
          // Simple SOCKS5 handshake
          socket.once('data', (data) => {
            if (data[0] !== 0x05) {
              socket.end();
              return;
            }

            // Reply: version, no auth required
            socket.write(Buffer.from([0x05, 0x00]));

            // Wait for connection request
            socket.once('data', (request) => {
              if (request[0] !== 0x05 || request[1] !== 0x01) {
                socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                socket.end();
                return;
              }

              let targetHost, targetPort;
              const addressType = request[3];

              if (addressType === 0x01) {
                // IPv4
                targetHost = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
                targetPort = request.readUInt16BE(8);
              } else if (addressType === 0x03) {
                // Domain name
                const domainLength = request[4];
                targetHost = request.slice(5, 5 + domainLength).toString();
                targetPort = request.readUInt16BE(5 + domainLength);
              } else if (addressType === 0x04) {
                // IPv6 - simplified handling
                socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                socket.end();
                return;
              } else {
                socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                socket.end();
                return;
              }

              // Forward through SSH tunnel
              conn.forwardOut(
                bindAddress,
                0,
                targetHost,
                targetPort,
                (err, stream) => {
                  if (err) {
                    socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    socket.end();
                    return;
                  }

                  // Success reply
                  const reply = Buffer.alloc(10);
                  reply[0] = 0x05;
                  reply[1] = 0x00;
                  reply[2] = 0x00;
                  reply[3] = 0x01;
                  reply.writeUInt16BE(0, 8);
                  socket.write(reply);

                  socket.pipe(stream).pipe(socket);

                  socket.on('error', () => stream.end());
                  stream.on('error', () => socket.end());
                }
              );
            });
          });
        });

        server.on('error', (err) => {
          console.error(`[PortForward] SOCKS server error:`, err.message);
          sendStatus('error', err.message);
          conn.end();
          settled = true;
          reject(err);
        });

        server.listen(localPort, bindAddress, () => {
          console.log(`[PortForward] Dynamic SOCKS5 proxy active on ${bindAddress}:${localPort}`);
          tunnelState.type = 'dynamic';
          tunnelState.conn = conn;
          tunnelState.server = server;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = 'active';
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus('active');
          settled = true;
          resolve({ tunnelId, success: true });
        });
      } else {
        settled = true;
        reject(new Error(`Unknown forwarding type: ${type}`));
      }
    });

    conn.on('error', (err) => {
      console.error(`[PortForward] SSH error:`, err.message);
      if (settled) return;
      sendStatus('error', err.message);
      cleanupChainConnections(chainConnections);
      settled = true;
      reject(err);
    });

    conn.once('close', () => {
      console.log(`[PortForward] SSH connection closed for tunnel ${tunnelId}`);
      const tunnel = portForwardingTunnels.get(tunnelId) || tunnelState;
      // Capture the cancelled flag BEFORE cleanup deletes the entry.
      const wasCancelled = !!tunnel?.cancelled;
      if (tunnel) {
        if (tunnel.server) {
          try { tunnel.server.close(); } catch { }
        }
        if (Array.isArray(tunnel.chainConnections)) {
          cleanupChainConnections(tunnel.chainConnections);
        }
        if (tunnel.pendingConn) {
          try { tunnel.pendingConn.end(); } catch { /* ignore */ }
        }
        sendStatus('inactive');
        portForwardingTunnels.delete(tunnelId);
      }
      // If the Promise was never settled (tunnel killed during
      // handshake by stopPortForwardByRuleId), settle it.
      if (!settled) {
        settled = true;
        if (wasCancelled) {
          resolve({ tunnelId, success: false, cancelled: true });
        } else {
          reject(new Error(`Tunnel ${tunnelId} closed before connection established`));
        }
      }
    });

    conn.connect(connectOpts);
  });
}

/**
 * Stop a port forwarding tunnel
 */
async function stopPortForward(event, payload) {
  const { tunnelId } = payload;
  const tunnel = portForwardingTunnels.get(tunnelId);

  if (!tunnel) {
    return { tunnelId, success: false, error: 'Tunnel not found' };
  }

  try {
    cancelTunnel(tunnelId, tunnel, null, { deleteEntry: true });
    if (!event.sender.isDestroyed()) {
      event.sender.send("netcatty:portforward:status", { tunnelId, status: 'inactive', error: null });
    }
    return { tunnelId, success: true };
  } catch (err) {
    return { tunnelId, success: false, error: err.message };
  }
}

/**
 * Get status of a tunnel
 */
async function getPortForwardStatus(event, payload) {
  const { tunnelId } = payload;
  const tunnel = portForwardingTunnels.get(tunnelId);

  if (!tunnel) {
    return { tunnelId, status: 'inactive' };
  }

  return { tunnelId, status: tunnel.status || 'active', type: tunnel.type };
}

/**
 * List all active port forwards
 */
async function listPortForwards() {
  const list = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    list.push({
      tunnelId,
      type: tunnel.type,
      status: tunnel.status || 'active',
    });
  }
  return list;
}

/**
 * Stop all active port forwards (cleanup on app quit)
 */
function stopAllPortForwards() {
  console.log(`[PortForward] Stopping all ${portForwardingTunnels.size} active tunnels...`);
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
      try {
        cancelTunnel(tunnelId, tunnel, null, { deleteEntry: true });
        console.log(`[PortForward] Stopped tunnel ${tunnelId}`);
    } catch (err) {
      console.warn(`[PortForward] Failed to stop tunnel ${tunnelId}:`, err.message);
    }
  }
  console.log('[PortForward] All tunnels stopped');
}

/**
 * Stop all active port forwards for a given rule ID.
 * This catches tunnels in ANY state (connecting, active) because it
 * operates on the main-process portForwardingTunnels map directly.
 */
function stopPortForwardByRuleId(_event, { ruleId }) {
  let stopped = 0;
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    if (tunnel.ruleId === ruleId) {
      try {
        cancelTunnel(tunnelId, tunnel, null, { deleteEntry: true });
        console.log(`[PortForward] Stopped tunnel ${tunnelId} for rule ${ruleId}`);
        stopped++;
      } catch (err) {
        console.warn(`[PortForward] Failed to stop tunnel ${tunnelId}:`, err.message);
      }
    }
  }
  return { stopped };
}

/**
 * Register IPC handlers for port forwarding operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:portforward:start", startPortForward);
  ipcMain.handle("netcatty:portforward:stop", stopPortForward);
  ipcMain.handle("netcatty:portforward:status", getPortForwardStatus);
  ipcMain.handle("netcatty:portforward:list", listPortForwards);
  ipcMain.handle("netcatty:portforward:stopAll", () => stopAllPortForwards());
  ipcMain.handle("netcatty:portforward:stopByRuleId", stopPortForwardByRuleId);
}

module.exports = {
  registerHandlers,
  startPortForward,
  stopPortForward,
  getPortForwardStatus,
  listPortForwards,
  stopAllPortForwards,
  stopPortForwardByRuleId,
};
