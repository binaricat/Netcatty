/**
 * SSH Bridge - Handles SSH connections, sessions, and related operations
 * Extracted from main.cjs for single responsibility
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { Client: SSHClient, utils: sshUtils } = require("ssh2");
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const biometricBridge = require("./biometricBridge.cjs");

// Simple file logger for debugging
const logFile = path.join(require("os").tmpdir(), "netcatty-ssh.log");
const log = (msg, data) => {
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ""}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
  console.log("[SSH]", msg, data || "");
};

// Session storage - shared reference passed from main
let sessions = null;
let electronModule = null;

// Normalize charset inputs (often provided as bare encodings like "UTF-8")
// into a usable LANG locale for remote shells.
function resolveLangFromCharset(charset) {
  if (!charset) return "en_US.UTF-8";
  const trimmed = String(charset).trim();
  if (/^utf-?8$/i.test(trimmed) || /^utf8$/i.test(trimmed)) {
    return "en_US.UTF-8";
  }
  return trimmed;
}

/**
 * Initialize the SSH bridge with dependencies
 */
function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule;
}

/**
 * Create a socket through a proxy (HTTP CONNECT or SOCKS5)
 */
function createProxySocket(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    if (proxy.type === 'http') {
      // HTTP CONNECT proxy
      const socket = net.connect(proxy.port, proxy.host, () => {
        let authHeader = '';
        if (proxy.username && proxy.password) {
          const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
          authHeader = `Proxy-Authorization: Basic ${auth}\r\n`;
        }
        const connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`;
        socket.write(connectRequest);
        
        let response = '';
        const onData = (data) => {
          response += data.toString();
          if (response.includes('\r\n\r\n')) {
            socket.removeListener('data', onData);
            if (response.startsWith('HTTP/1.1 200') || response.startsWith('HTTP/1.0 200')) {
              resolve(socket);
            } else {
              socket.destroy();
              reject(new Error(`HTTP proxy error: ${response.split('\r\n')[0]}`));
            }
          }
        };
        socket.on('data', onData);
      });
      socket.on('error', reject);
    } else if (proxy.type === 'socks5') {
      // SOCKS5 proxy
      const socket = net.connect(proxy.port, proxy.host, () => {
        // SOCKS5 greeting
        const authMethods = proxy.username && proxy.password ? [0x00, 0x02] : [0x00];
        socket.write(Buffer.from([0x05, authMethods.length, ...authMethods]));
        
        let step = 'greeting';
        const onData = (data) => {
          if (step === 'greeting') {
            if (data[0] !== 0x05) {
              socket.destroy();
              reject(new Error('Invalid SOCKS5 response'));
              return;
            }
            const method = data[1];
            if (method === 0x02 && proxy.username && proxy.password) {
              // Username/password auth
              step = 'auth';
              const userBuf = Buffer.from(proxy.username);
              const passBuf = Buffer.from(proxy.password);
              socket.write(Buffer.concat([
                Buffer.from([0x01, userBuf.length]),
                userBuf,
                Buffer.from([passBuf.length]),
                passBuf
              ]));
            } else if (method === 0x00) {
              // No auth, proceed to connect
              step = 'connect';
              sendConnectRequest();
            } else {
              socket.destroy();
              reject(new Error('SOCKS5 authentication method not supported'));
            }
          } else if (step === 'auth') {
            if (data[1] !== 0x00) {
              socket.destroy();
              reject(new Error('SOCKS5 authentication failed'));
              return;
            }
            step = 'connect';
            sendConnectRequest();
          } else if (step === 'connect') {
            socket.removeListener('data', onData);
            if (data[1] === 0x00) {
              resolve(socket);
            } else {
              const errors = {
                0x01: 'General failure',
                0x02: 'Connection not allowed',
                0x03: 'Network unreachable',
                0x04: 'Host unreachable',
                0x05: 'Connection refused',
                0x06: 'TTL expired',
                0x07: 'Command not supported',
                0x08: 'Address type not supported',
              };
              socket.destroy();
              reject(new Error(`SOCKS5 error: ${errors[data[1]] || 'Unknown'}`));
            }
          }
        };
        
        const sendConnectRequest = () => {
          // SOCKS5 connect request
          const hostBuf = Buffer.from(targetHost);
          const request = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
          ]);
          socket.write(request);
        };
        
        socket.on('data', onData);
      });
      socket.on('error', reject);
    } else {
      reject(new Error(`Unknown proxy type: ${proxy.type}`));
    }
  });
}

/**
 * Connect through a chain of jump hosts
 */
async function connectThroughChain(event, options, jumpHosts, targetHost, targetPort) {
  const sender = event.sender;
  const connections = [];
  let currentSocket = null;
  
  const sendProgress = (hop, total, label, status) => {
    if (!sender.isDestroyed()) {
      sender.send("netcatty:chain:progress", { hop, total, label, status });
    }
  };
  
  try {
    const totalHops = jumpHosts.length;
    
    // Connect through each jump host
    for (let i = 0; i < jumpHosts.length; i++) {
      const jump = jumpHosts[i];
      const isFirst = i === 0;
      const isLast = i === jumpHosts.length - 1;
      const hopLabel = jump.label || `${jump.hostname}:${jump.port || 22}`;
      
      sendProgress(i + 1, totalHops + 1, hopLabel, 'connecting');
      
      const conn = new SSHClient();
      
      // Build connection options
      const connOpts = {
        host: jump.hostname,
        port: jump.port || 22,
        username: jump.username || 'root',
        readyTimeout: 20000, // Reduced from 60s for faster failure detection
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        algorithms: {
          // Prioritize fastest ciphers (GCM modes are hardware-accelerated)
          cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes256-ctr'],
          // Prioritize faster key exchange
          kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'diffie-hellman-group14-sha256'],
          compress: ['none'],
        },
      };
      
      // Auth - support agent (certificate), key, and password fallback
      const hasCertificate =
        typeof jump.certificate === "string" && jump.certificate.trim().length > 0;

      // Check if this jump host uses a Termius-style biometric key
      const isJumpBiometricKey =
        jump.keySource === "biometric"
        && jump.keyId
        && jump.privateKey;

      // For biometric keys, retrieve passphrase from OS Secure Storage
      let jumpEffectivePassphrase = jump.passphrase;
      if (isJumpBiometricKey && !jumpEffectivePassphrase) {
        console.log("[SSH] Jump host biometric key detected, retrieving passphrase...");
        log("Jump host biometric key", { keyId: jump.keyId, hop: i + 1 });
        
        try {
          const passphraseResult = await biometricBridge.getBiometricPassphrase(jump.keyId);
          if (passphraseResult.success && passphraseResult.passphrase) {
            jumpEffectivePassphrase = passphraseResult.passphrase;
            console.log("[SSH] Jump host biometric passphrase retrieved successfully");
          } else {
            throw new Error(passphraseResult.error || "Failed to retrieve passphrase");
          }
        } catch (err) {
          console.error("[SSH] Jump host biometric passphrase error:", err);
          throw new Error(`Biometric authentication failed for jump host ${hopLabel}: ${err.message}`);
        }
      }

      let authAgent = null;
      if (hasCertificate) {
        authAgent = new NetcattyAgent({
          mode: "certificate",
          webContents: event.sender,
          meta: {
            label: jump.keyId || jump.username || "",
            certificate: jump.certificate,
            privateKey: jump.privateKey,
            passphrase: jumpEffectivePassphrase,
          },
        });
        connOpts.agent = authAgent;
      } else if (jump.privateKey) {
        connOpts.privateKey = jump.privateKey;
        if (jumpEffectivePassphrase) connOpts.passphrase = jumpEffectivePassphrase;
      }

      if (jump.password) connOpts.password = jump.password;

      if (authAgent) {
        const order = ["agent"];
        if (connOpts.password) order.push("password");
        connOpts.authHandler = order;
      }
      
      // If first hop and proxy is configured, connect through proxy
      if (isFirst && options.proxy) {
        currentSocket = await createProxySocket(options.proxy, jump.hostname, jump.port || 22);
        connOpts.sock = currentSocket;
        delete connOpts.host;
        delete connOpts.port;
      } else if (!isFirst && currentSocket) {
        // Tunnel through previous hop
        connOpts.sock = currentSocket;
        delete connOpts.host;
        delete connOpts.port;
      }
      
      // Connect this hop
      await new Promise((resolve, reject) => {
        conn.on('ready', () => {
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} connected`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'connected');
          resolve();
        });
        conn.on('error', (err) => {
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} error:`, err.message);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error');
          reject(err);
        });
        conn.on('timeout', () => {
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} timeout`);
          reject(new Error(`Connection timeout to ${hopLabel}`));
        });
        console.log(`[Chain] Hop ${i + 1}/${totalHops}: Connecting to ${hopLabel}...`);
        conn.connect(connOpts);
      });
      
      connections.push(conn);
      
      // Determine next target
      let nextHost, nextPort;
      if (isLast) {
        // Last jump host, forward to final target
        nextHost = targetHost;
        nextPort = targetPort;
      } else {
        // Forward to next jump host
        const nextJump = jumpHosts[i + 1];
        nextHost = nextJump.hostname;
        nextPort = nextJump.port || 22;
      }
      
      // Create forward stream to next hop
      console.log(`[Chain] Hop ${i + 1}/${totalHops}: Forwarding from ${hopLabel} to ${nextHost}:${nextPort}...`);
      sendProgress(i + 1, totalHops + 1, hopLabel, 'forwarding');
      currentSocket = await new Promise((resolve, reject) => {
        conn.forwardOut('127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
          if (err) {
            console.error(`[Chain] Hop ${i + 1}/${totalHops}: forwardOut from ${hopLabel} to ${nextHost}:${nextPort} FAILED:`, err.message);
            reject(err);
            return;
          }
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: forwardOut from ${hopLabel} to ${nextHost}:${nextPort} SUCCESS`);
          resolve(stream);
        });
      });
    }
    
    // Return the final forwarded stream and all connections for cleanup
    return { 
      socket: currentSocket, 
      connections,
      sendProgress 
    };
  } catch (err) {
    // Cleanup on error
    for (const conn of connections) {
      try { conn.end(); } catch {}
    }
    throw err;
  }
}

/**
 * Start an SSH session
 */
async function startSSHSession(event, options) {
  const sessionId =
    options.sessionId ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const cols = options.cols || 80;
  const rows = options.rows || 24;
  const sender = event.sender;
  
  const sendProgress = (hop, total, label, status) => {
    if (!sender.isDestroyed()) {
      sender.send("netcatty:chain:progress", { hop, total, label, status });
    }
  };

  try {
    const conn = new SSHClient();
    let chainConnections = [];
    let connectionSocket = null;
    
    // Determine if we have jump hosts
    const jumpHosts = options.jumpHosts || [];
    const hasJumpHosts = jumpHosts.length > 0;
    const hasProxy = !!options.proxy;
    const totalHops = jumpHosts.length + 1; // +1 for final target
    
    // Build base connection options for final target
    const connectOpts = {
      host: options.hostname,
      port: options.port || 22,
      username: options.username || "root",
      // `readyTimeout` covers the entire connection + authentication flow in ssh2.
      // WebAuthn (Touch ID / browser helper) can be user-interactive and take longer than a typical key auth.
      readyTimeout: 20000, // Fast failure for non-interactive auth
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      algorithms: {
        // Prioritize fastest ciphers (GCM modes are hardware-accelerated)
        cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes256-ctr'],
        // Prioritize faster key exchange
        kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'diffie-hellman-group14-sha256'],
        compress: ['none'],
      },
      // Enable debug logging for SSH connection troubleshooting
      debug: (msg) => {
        log("SSH DEBUG", msg);
      },
    };

    // Authentication for final target
    const hasCertificate = typeof options.certificate === "string" && options.certificate.trim().length > 0;

    // Check if this is a Termius-style biometric key (ED25519 + OS Secure Storage)
    const isBiometricKey =
      options.keySource === "biometric"
      && options.keyId
      && options.privateKey;

    // For biometric keys, retrieve passphrase from OS Secure Storage
    // This will trigger Windows Hello / Touch ID prompt
    let effectivePassphrase = options.passphrase;
    if (isBiometricKey && !effectivePassphrase) {
      console.log("[SSH] Biometric key detected, retrieving passphrase from secure storage...");
      log("Biometric key detected", { keyId: options.keyId });
      
      try {
        const passphraseResult = await biometricBridge.getBiometricPassphrase(options.keyId);
        if (passphraseResult.success && passphraseResult.passphrase) {
          effectivePassphrase = passphraseResult.passphrase;
          console.log("[SSH] Biometric passphrase retrieved successfully");
          log("Biometric passphrase retrieved", { keyId: options.keyId });
        } else {
          const errorMsg = passphraseResult.error || "Failed to retrieve biometric passphrase";
          console.error("[SSH] Biometric passphrase retrieval failed:", errorMsg);
          log("Biometric passphrase retrieval failed", { error: errorMsg });
          throw new Error(`Biometric authentication failed: ${errorMsg}`);
        }
      } catch (err) {
        console.error("[SSH] Biometric passphrase error:", err);
        log("Biometric passphrase error", { error: err.message });
        throw new Error(`Biometric authentication failed: ${err.message}`);
      }
    }

    console.log("[SSH] Auth configuration:", {
      hasCertificate,
      isBiometricKey,
      keySource: options.keySource,
      hasPublicKey: !!options.publicKey,
      hasEffectivePassphrase: !!effectivePassphrase,
    });
    
    log("Auth configuration", {
      hasCertificate,
      isBiometricKey,
      keySource: options.keySource,
      hasPublicKey: !!options.publicKey,
    });

    let authAgent = null;
    if (hasCertificate) {
      authAgent = new NetcattyAgent({
        mode: "certificate",
        webContents: event.sender,
        meta: {
          label: options.keyId || options.username || "",
          certificate: options.certificate,
          privateKey: options.privateKey,
          passphrase: effectivePassphrase,
        },
      });
      connectOpts.agent = authAgent;
    } else if (options.privateKey) {
      connectOpts.privateKey = options.privateKey;
      // Use effectivePassphrase (which may have been retrieved from OS Secure Storage for biometric keys)
      if (effectivePassphrase) {
        connectOpts.passphrase = effectivePassphrase;
      }
    }

    if (options.password) {
      connectOpts.password = options.password;
    }

    // Agent forwarding
    if (options.agentForwarding) {
      connectOpts.agentForward = true;
      if (!connectOpts.agent) {
        if (process.platform === "win32") {
          connectOpts.agent = "\\\\.\\pipe\\openssh-ssh-agent";
        } else {
          connectOpts.agent = process.env.SSH_AUTH_SOCK;
        }
      }
    }

    // Prefer agent-based auth when we created an in-process agent (cert/webauthn)
    if (authAgent) {
      const order = ["agent"];
      // Allow password fallback if provided
      if (connectOpts.password) order.push("password");
      connectOpts.authHandler = order;
    }

    // Handle chain/proxy connections
    if (hasJumpHosts) {
      const chainResult = await connectThroughChain(
        event, 
        options, 
        jumpHosts, 
        options.hostname, 
        options.port || 22
      );
      connectionSocket = chainResult.socket;
      chainConnections = chainResult.connections;
      
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
      
      sendProgress(totalHops, totalHops, options.hostname, 'connecting');
    } else if (hasProxy) {
      sendProgress(1, 1, options.hostname, 'connecting');
      connectionSocket = await createProxySocket(
        options.proxy, 
        options.hostname, 
        options.port || 22
      );
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    }

    return new Promise((resolve, reject) => {
      conn.on("ready", () => {
        console.log(`[Chain] Final target ${options.hostname} ready`);
        if (hasJumpHosts || hasProxy) {
          sendProgress(totalHops, totalHops, options.hostname, 'connected');
        }
        
        conn.shell(
          {
            term: "xterm-256color",
            cols,
            rows,
          },
          {
            env: { 
              LANG: resolveLangFromCharset(options.charset),
              COLORTERM: "truecolor",
              ...(options.env || {}),
            },
          },
          (err, stream) => {
            if (err) {
              conn.end();
              for (const c of chainConnections) {
                try { c.end(); } catch {}
              }
              reject(err);
              return;
            }

            const session = {
              conn,
              stream,
              chainConnections,
              webContentsId: event.sender.id,
            };
            sessions.set(sessionId, session);

            // Data buffering for reduced IPC overhead
            let dataBuffer = '';
            let flushTimeout = null;
            const FLUSH_INTERVAL = 8; // ms - flush every 8ms for ~120fps equivalent
            const MAX_BUFFER_SIZE = 16384; // 16KB - flush immediately if buffer gets too large
            
            const flushBuffer = () => {
              if (dataBuffer.length > 0) {
                const contents = electronModule.BrowserWindow.fromWebContents(event.sender)?.webContents;
                contents?.send("netcatty:data", { sessionId, data: dataBuffer });
                dataBuffer = '';
              }
              flushTimeout = null;
            };
            
            const bufferData = (data) => {
              dataBuffer += data;
              // Immediate flush for large chunks
              if (dataBuffer.length >= MAX_BUFFER_SIZE) {
                if (flushTimeout) {
                  clearTimeout(flushTimeout);
                  flushTimeout = null;
                }
                flushBuffer();
              } else if (!flushTimeout) {
                // Schedule flush
                flushTimeout = setTimeout(flushBuffer, FLUSH_INTERVAL);
              }
            };

            stream.on("data", (data) => {
              bufferData(data.toString("utf8"));
            });

            stream.stderr?.on("data", (data) => {
              bufferData(data.toString("utf8"));
            });

            stream.on("close", () => {
              // Flush any remaining data before close
              if (flushTimeout) {
                clearTimeout(flushTimeout);
              }
              flushBuffer();
              const contents = electronModule.BrowserWindow.fromWebContents(event.sender)?.webContents;
              contents?.send("netcatty:exit", { sessionId, exitCode: 0 });
              sessions.delete(sessionId);
              conn.end();
              for (const c of chainConnections) {
                try { c.end(); } catch {}
              }
            });

            // Run startup command if specified
            if (options.startupCommand) {
              setTimeout(() => {
                stream.write(`${options.startupCommand}\n`);
              }, 300);
            }

            resolve({ sessionId });
          }
        );
      });

      conn.on("error", (err) => {
        console.error(`[Chain] Final target ${options.hostname} error:`, err.message);
        const contents = electronModule.BrowserWindow.fromWebContents(event.sender)?.webContents;
        
        const isAuthError = err.message?.toLowerCase().includes('authentication') ||
                           err.message?.toLowerCase().includes('auth') ||
                           err.message?.toLowerCase().includes('password') ||
                           err.level === 'client-authentication';
        
        if (isAuthError) {
          contents?.send("netcatty:auth:failed", { 
            sessionId, 
            error: err.message,
            hostname: options.hostname 
          });
        }
        
        contents?.send("netcatty:exit", { sessionId, exitCode: 1, error: err.message });
        sessions.delete(sessionId);
        for (const c of chainConnections) {
          try { c.end(); } catch {}
        }
        reject(err);
      });

      conn.on("timeout", () => {
        console.error(`[Chain] Final target ${options.hostname} connection timeout`);
        const err = new Error(`Connection timeout to ${options.hostname}`);
        const contents = electronModule.BrowserWindow.fromWebContents(event.sender)?.webContents;
        contents?.send("netcatty:exit", { sessionId, exitCode: 1, error: err.message });
        sessions.delete(sessionId);
        for (const c of chainConnections) {
          try { c.end(); } catch {}
        }
        reject(err);
      });

      conn.on("close", () => {
        const contents = electronModule.BrowserWindow.fromWebContents(event.sender)?.webContents;
        contents?.send("netcatty:exit", { sessionId, exitCode: 0 });
        sessions.delete(sessionId);
        for (const c of chainConnections) {
          try { c.end(); } catch {}
        }
      });

      console.log(`[Chain] Connecting to final target ${options.hostname}...`);
      conn.connect(connectOpts);
    });
  } catch (err) {
    console.error("[Chain] SSH chain connection error:", err.message);
    const contents = electronModule.BrowserWindow.fromWebContents(event.sender)?.webContents;
    contents?.send("netcatty:exit", { sessionId, exitCode: 1, error: err.message });
    throw err;
  }
}

/**
 * Execute a one-off command via SSH
 */
async function execCommand(event, payload) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = payload.timeout || 10000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error("SSH exec timeout"));
    }, timeoutMs);

    conn
      .on("ready", () => {
        conn.exec(payload.command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            settled = true;
            conn.end();
            return reject(err);
          }
          stream
            .on("data", (data) => {
              stdout += data.toString();
            })
            .stderr.on("data", (data) => {
              stderr += data.toString();
            })
            .on("close", (code) => {
              if (settled) return;
              clearTimeout(timer);
              settled = true;
              conn.end();
              resolve({ stdout, stderr, code: code ?? (stderr ? 1 : 0) });
            });
        });
      })
      .on("error", (err) => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        reject(err);
      })
      .on("end", () => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        if (stderr || stdout) {
          resolve({ stdout, stderr, code: 0 });
        } else {
          reject(new Error("SSH connection closed unexpectedly"));
        }
      });

    const hasCertificate = typeof payload.certificate === "string" && payload.certificate.trim().length > 0;

    const connectOpts = {
      host: payload.hostname,
      port: payload.port || 22,
      username: payload.username,
      readyTimeout: timeoutMs,
      keepaliveInterval: 0,
    };

    let authAgent = null;
    if (hasCertificate) {
      authAgent = new NetcattyAgent({
        mode: "certificate",
        webContents: event.sender,
        meta: {
          label: payload.keyId || payload.username || "",
          certificate: payload.certificate,
          privateKey: payload.privateKey,
          passphrase: payload.passphrase,
        },
      });
      connectOpts.agent = authAgent;
    } else if (payload.privateKey) {
      connectOpts.privateKey = payload.privateKey;
      if (payload.passphrase) connectOpts.passphrase = payload.passphrase;
    }

    if (payload.password) connectOpts.password = payload.password;

    if (authAgent) {
      const order = ["agent"];
      if (connectOpts.password) order.push("password");
      connectOpts.authHandler = order;
    }

    conn.connect(connectOpts);
  });
}

/**
 * Generate SSH key pair
 */
async function generateKeyPair(event, options) {
  const { type, bits, comment } = options;
  
  try {
    let keyType;
    let keyBits = bits;
    
    switch (type) {
      case 'ED25519':
        keyType = 'ed25519';
        keyBits = undefined;
        break;
      case 'ECDSA':
        keyType = 'ecdsa';
        keyBits = bits || 256;
        break;
      case 'RSA':
      default:
        keyType = 'rsa';
        keyBits = bits || 4096;
        break;
    }
    
    const result = sshUtils.generateKeyPairSync(keyType, {
      bits: keyBits,
      comment: comment || 'netcatty-generated-key',
    });
    
    const privateKey = result.private;
    const publicKey = result.public;
    
    return {
      success: true,
      privateKey,
      publicKey,
    };
  } catch (err) {
    console.error('Key generation failed:', err);
    return {
      success: false,
      error: err.message || 'Key generation failed',
    };
  }
}

/**
 * Register IPC handlers for SSH operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:start", startSSHSession);
  ipcMain.handle("netcatty:ssh:exec", execCommand);
  ipcMain.handle("netcatty:key:generate", generateKeyPair);
}

module.exports = {
  init,
  registerHandlers,
  createProxySocket,
  startSSHSession,
  execCommand,
  generateKeyPair,
};
