/**
 * Port Forwarding Bridge - Handles SSH port forwarding tunnels
 * Extracted from main.cjs for single responsibility
 */

const net = require("node:net");
const { Client: SSHClient } = require("ssh2");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const { 
  buildAuthHandler, 
  createKeyboardInteractiveHandler, 
  applyAuthToConnOpts,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
} = require("./sshAuthHelper.cjs");

// Active port forwarding tunnels
const portForwardingTunnels = new Map();

/**
 * Send message to renderer safely
 */
function safeSend(sender, channel, payload) {
  try {
    if (!sender || sender.isDestroyed()) return;
    sender.send(channel, payload);
  } catch {
    // Ignore destroyed webContents during shutdown.
  }
}

/**
 * Start a port forwarding tunnel
 */
async function startPortForward(event, payload) {
  const {
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
    passphrase,
  } = payload;

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    const sender = event.sender;

    const sendStatus = (status, error = null) => {
      if (!sender.isDestroyed()) {
        sender.send("netcatty:portforward:status", { tunnelId, status, error });
      }
    };

    const connectOpts = {
      host: hostname,
      port: port,
      username: username || 'root',
      readyTimeout: 120000, // 2 minutes for 2FA input
      keepaliveInterval: 10000,
      // Enable keyboard-interactive authentication (required for 2FA/MFA)
      tryKeyboard: true,
    };

    if (privateKey) {
      connectOpts.privateKey = privateKey;
    }
    if (passphrase) {
      connectOpts.passphrase = passphrase;
    }
    if (password) {
      connectOpts.password = password;
    }

    // Get default keys
    const defaultKeys = await findAllDefaultPrivateKeysFromHelper();

    // Build auth handler using shared helper
    const authConfig = buildAuthHandler({
      privateKey,
      password,
      passphrase,
      username: connectOpts.username,
      logPrefix: "[PortForward]",
      defaultKeys,
    });
    applyAuthToConnOpts(connectOpts, authConfig);

    // Handle keyboard-interactive authentication (2FA/MFA)
    conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
      sender,
      sessionId: tunnelId,
      hostname,
      password,
      logPrefix: "[PortForward]",
    }));


    conn.on('ready', () => {
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
          portForwardingTunnels.delete(tunnelId);
          reject(err);
        });

        server.listen(localPort, bindAddress, () => {
          console.log(`[PortForward] Local forwarding active: ${bindAddress}:${localPort} -> ${remoteHost}:${remotePort}`);
          portForwardingTunnels.set(tunnelId, {
            type: 'local',
            conn,
            server,
            webContentsId: sender.id
          });
          sendStatus('active');
          resolve({ tunnelId, success: true });
        });

      } else if (type === 'remote') {
        // REMOTE FORWARDING: Listen on remote port, forward to local
        conn.forwardIn(bindAddress, localPort, (err) => {
          if (err) {
            console.error(`[PortForward] Remote forward error:`, err.message);
            sendStatus('error', err.message);
            conn.end();
            reject(err);
            return;
          }

          console.log(`[PortForward] Remote forwarding active: remote ${bindAddress}:${localPort} -> local ${remoteHost}:${remotePort}`);
          portForwardingTunnels.set(tunnelId, {
            type: 'remote',
            conn,
            webContentsId: sender.id
          });
          sendStatus('active');
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
          portForwardingTunnels.delete(tunnelId);
          reject(err);
        });

        server.listen(localPort, bindAddress, () => {
          console.log(`[PortForward] Dynamic SOCKS5 proxy active on ${bindAddress}:${localPort}`);
          portForwardingTunnels.set(tunnelId, {
            type: 'dynamic',
            conn,
            server,
            webContentsId: sender.id
          });
          sendStatus('active');
          resolve({ tunnelId, success: true });
        });
      } else {
        reject(new Error(`Unknown forwarding type: ${type}`));
      }
    });

    conn.on('error', (err) => {
      console.error(`[PortForward] SSH error:`, err.message);
      sendStatus('error', err.message);
      portForwardingTunnels.delete(tunnelId);
      reject(err);
    });

    conn.on('close', () => {
      console.log(`[PortForward] SSH connection closed for tunnel ${tunnelId}`);
      const tunnel = portForwardingTunnels.get(tunnelId);
      if (tunnel) {
        if (tunnel.server) {
          try { tunnel.server.close(); } catch { }
        }
        sendStatus('inactive');
        portForwardingTunnels.delete(tunnelId);
      }
    });

    sendStatus('connecting');
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
    if (tunnel.server) {
      tunnel.server.close();
    }
    if (tunnel.conn) {
      tunnel.conn.end();
    }
    portForwardingTunnels.delete(tunnelId);

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

  return { tunnelId, status: 'active', type: tunnel.type };
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
      status: 'active',
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
      if (tunnel.server) {
        tunnel.server.close();
      }
      if (tunnel.conn) {
        tunnel.conn.end();
      }
      console.log(`[PortForward] Stopped tunnel ${tunnelId}`);
    } catch (err) {
      console.warn(`[PortForward] Failed to stop tunnel ${tunnelId}:`, err.message);
    }
  }
  portForwardingTunnels.clear();
  console.log('[PortForward] All tunnels stopped');
}

/**
 * Register IPC handlers for port forwarding operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:portforward:start", startPortForward);
  ipcMain.handle("netcatty:portforward:stop", stopPortForward);
  ipcMain.handle("netcatty:portforward:status", getPortForwardStatus);
  ipcMain.handle("netcatty:portforward:list", listPortForwards);
}

module.exports = {
  registerHandlers,
  startPortForward,
  stopPortForward,
  getPortForwardStatus,
  listPortForwards,
  stopAllPortForwards,
};
