// Make sure the helper processes do not get forced into Node-only mode.
// Presence of ELECTRON_RUN_AS_NODE (even "0") makes helpers parse Chromium
// switches as Node flags, leading to "bad option: --type=renderer".
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// Handle uncaught exceptions for EPIPE errors (when writing to closed streams)
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
    // Ignore EPIPE errors - these happen when terminal is closed while data is being written
    console.warn('Ignored stream error:', err.code);
    return;
  }
  // Re-throw other errors
  console.error('Uncaught exception:', err);
  throw err;
});

let electronModule;
try {
  electronModule = require("node:electron");
} catch {
  electronModule = require("electron");
}
console.log("electron module raw:", electronModule);
console.log("process.versions:", process.versions);
console.log("env ELECTRON_RUN_AS_NODE:", process.env.ELECTRON_RUN_AS_NODE);
const { app, BrowserWindow, nativeTheme, Menu } = electronModule || {};
if (!app || !BrowserWindow) {
  throw new Error("Failed to load Electron runtime. Ensure the app is launched with the Electron binary.");
}
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const pty = require("node-pty");
const SftpClient = require("ssh2-sftp-client");
const { Client: SSHClient, utils: sshUtils } = require("ssh2");

// GPU: keep hardware acceleration enabled for smoother rendering
// (If you hit GPU issues, you can restore these switches.)
// app.commandLine.appendSwitch("disable-gpu");
// app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isDev = !!devServerUrl;
const preload = path.join(__dirname, "preload.cjs");
const isMac = process.platform === "darwin";
const appIcon = path.join(__dirname, "../public/icon.png");

// Production static file server (for WebAuthn secure context requirement)
let productionServer = null;
let productionServerUrl = null;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
};

// Start a local HTTP server for production to enable WebAuthn (requires secure context)
async function startProductionServer() {
  const distPath = path.join(__dirname, "../dist");
  
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(distPath, req.url === '/' ? 'index.html' : req.url);
      
      // Security: prevent directory traversal
      if (!filePath.startsWith(distPath)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      
      // Handle SPA routing - serve index.html for non-file routes
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distPath, 'index.html');
      }
      
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      
      fs.readFile(filePath, (err, data) => {
        if (err) {
          if (err.code === 'ENOENT') {
            // Fallback to index.html for SPA
            fs.readFile(path.join(distPath, 'index.html'), (err2, data2) => {
              if (err2) {
                res.writeHead(404);
                res.end('Not Found');
                return;
              }
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(data2);
            });
            return;
          }
          res.writeHead(500);
          res.end('Server Error');
          return;
        }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
      });
    });
    
    // Find an available port starting from 17789
    const tryPort = (port) => {
      server.listen(port, '127.0.0.1', () => {
        productionServer = server;
        productionServerUrl = `http://127.0.0.1:${port}`;
        console.log(`Production server started at ${productionServerUrl}`);
        resolve(productionServerUrl);
      }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
    };
    
    tryPort(17789);
  });
}

const sessions = new Map();
const sftpClients = new Map();
const keyRoot = path.join(os.homedir(), ".nebula-ssh", "keys");

// On Windows, node-pty with conpty needs full paths to executables
const findExecutable = (name) => {
  if (process.platform !== "win32") return name;
  
  const { execSync } = require("child_process");
  try {
    const result = execSync(`where.exe ${name}`, { encoding: "utf8" });
    const firstLine = result.split(/\r?\n/)[0].trim();
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch (err) {
    console.warn(`Could not find ${name} via where.exe:`, err.message);
  }
  
  // Fallback to common locations
  const commonPaths = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSH", `${name}.exe`),
  ];
  
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  
  return name; // Fall back to bare name
};

const ensureKeyDir = () => {
  try {
    fs.mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn("Unable to ensure key cache dir", err);
  }
};

const writeKeyToDisk = (keyId, privateKey) => {
  if (!privateKey) return null;
  ensureKeyDir();
  const filename = `${keyId || "temp"}.pem`;
  const target = path.join(keyRoot, filename);
  const normalized = privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`;
  try {
    fs.writeFileSync(target, normalized, { mode: 0o600 });
    return target;
  } catch (err) {
    console.error("Failed to persist private key", err);
    return null;
  }
};

const registerSSHBridge = (win) => {
  if (registerSSHBridge._registered) return;
  registerSSHBridge._registered = true;

  // Helper: Create a socket through a proxy (HTTP CONNECT or SOCKS5)
  const createProxySocket = (proxy, targetHost, targetPort) => {
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
  };

  // Helper: Connect through a chain of jump hosts
  const connectThroughChain = async (event, options, jumpHosts, targetHost, targetPort) => {
    const sender = event.sender;
    const connections = [];
    let currentSocket = null;
    
    const sendProgress = (hop, total, label, status) => {
      if (!sender.isDestroyed()) {
        sender.send("nebula:chain:progress", { hop, total, label, status });
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
          readyTimeout: 60000,
          keepaliveInterval: 5000,
          algorithms: {
            cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes256-ctr'],
            compress: ['none'],
          },
        };
        
        // Auth - support both key and password for fallback
        if (jump.privateKey) {
          connOpts.privateKey = jump.privateKey;
          if (jump.passphrase) connOpts.passphrase = jump.passphrase;
        }
        if (jump.password) {
          connOpts.password = jump.password;
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
  };

  // Pure ssh2-based SSH session (no external ssh.exe required)
  const start = async (event, options) => {
    const sessionId =
      options.sessionId ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const sender = event.sender;
    
    const sendProgress = (hop, total, label, status) => {
      if (!sender.isDestroyed()) {
        sender.send("nebula:chain:progress", { hop, total, label, status });
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
        readyTimeout: 60000,
        keepaliveInterval: 5000,
        algorithms: {
          cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes256-ctr'],
          compress: ['none'],
        },
      };

      // Authentication for final target - support both key and password for fallback
      // ssh2 will try methods in order: publickey first, then password
      if (options.privateKey) {
        connectOpts.privateKey = options.privateKey;
        if (options.passphrase) {
          connectOpts.passphrase = options.passphrase;
        }
      }
      // Always include password if available for fallback authentication
      if (options.password) {
        connectOpts.password = options.password;
      }

      // Agent forwarding
      if (options.agentForwarding) {
        connectOpts.agentForward = true;
        if (process.platform === "win32") {
          connectOpts.agent = "\\\\.\\pipe\\openssh-ssh-agent";
        } else {
          connectOpts.agent = process.env.SSH_AUTH_SOCK;
        }
      }

      // Handle chain/proxy connections
      if (hasJumpHosts) {
        // Connect through jump host chain
        const chainResult = await connectThroughChain(
          event, 
          options, 
          jumpHosts, 
          options.hostname, 
          options.port || 22
        );
        connectionSocket = chainResult.socket;
        chainConnections = chainResult.connections;
        
        // Use the forwarded socket for final connection
        connectOpts.sock = connectionSocket;
        delete connectOpts.host;
        delete connectOpts.port;
        
        // Progress for final target
        sendProgress(totalHops, totalHops, options.hostname, 'connecting');
      } else if (hasProxy) {
        // Direct connection through proxy (no jump hosts)
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
                LANG: options.charset || "en_US.UTF-8",
                COLORTERM: "truecolor",
                // Merge user-defined environment variables
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
                chainConnections, // Store chain connections for cleanup
                webContentsId: event.sender.id,
              };
              sessions.set(sessionId, session);

              stream.on("data", (data) => {
                const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
                contents?.send("nebula:data", { sessionId, data: data.toString("utf8") });
              });

              stream.stderr?.on("data", (data) => {
                const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
                contents?.send("nebula:data", { sessionId, data: data.toString("utf8") });
              });

              stream.on("close", () => {
                const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
                contents?.send("nebula:exit", { sessionId, exitCode: 0 });
                sessions.delete(sessionId);
                conn.end();
                // Cleanup chain connections
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
          const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
          
          // Check if this is an authentication failure
          const isAuthError = err.message?.toLowerCase().includes('authentication') ||
                             err.message?.toLowerCase().includes('auth') ||
                             err.message?.toLowerCase().includes('password') ||
                             err.level === 'client-authentication';
          
          if (isAuthError) {
            // Send auth failed event so frontend can prompt for re-entry
            contents?.send("nebula:auth:failed", { 
              sessionId, 
              error: err.message,
              hostname: options.hostname 
            });
          }
          
          contents?.send("nebula:exit", { sessionId, exitCode: 1, error: err.message });
          sessions.delete(sessionId);
          // Cleanup chain connections
          for (const c of chainConnections) {
            try { c.end(); } catch {}
          }
          reject(err);
        });

        conn.on("timeout", () => {
          console.error(`[Chain] Final target ${options.hostname} connection timeout`);
          const err = new Error(`Connection timeout to ${options.hostname}`);
          const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
          contents?.send("nebula:exit", { sessionId, exitCode: 1, error: err.message });
          sessions.delete(sessionId);
          for (const c of chainConnections) {
            try { c.end(); } catch {}
          }
          reject(err);
        });

        conn.on("close", () => {
          const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
          contents?.send("nebula:exit", { sessionId, exitCode: 0 });
          sessions.delete(sessionId);
          // Cleanup chain connections
          for (const c of chainConnections) {
            try { c.end(); } catch {}
          }
        });

        console.log(`[Chain] Connecting to final target ${options.hostname}...`);
        conn.connect(connectOpts);
      });
    } catch (err) {
      console.error("[Chain] SSH chain connection error:", err.message);
      const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
      contents?.send("nebula:exit", { sessionId, exitCode: 1, error: err.message });
      throw err;
    }
  };

  const write = (_event, payload) => {
    const session = sessions.get(payload.sessionId);
    if (!session) return;
    try {
      // SSH sessions use stream, local terminal uses proc, telnet-native uses socket
      if (session.stream) {
        session.stream.write(payload.data);
      } else if (session.proc) {
        session.proc.write(payload.data);
      } else if (session.socket) {
        session.socket.write(payload.data);
      }
    } catch (err) {
      // Ignore EPIPE errors when process is already closed
      if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        console.warn("Write failed", err);
      }
    }
  };

  const resize = (_event, payload) => {
    const session = sessions.get(payload.sessionId);
    if (!session) return;
    try {
      if (session.stream) {
        // SSH session - use setWindow
        session.stream.setWindow(payload.rows, payload.cols, 0, 0);
      } else if (session.proc) {
        // Local terminal - use resize
        session.proc.resize(payload.cols, payload.rows);
      } else if (session.socket && session.type === 'telnet-native') {
        // Telnet native - send NAWS if supported
        session.cols = payload.cols;
        session.rows = payload.rows;
        // Send NAWS sub-negotiation
        const TELNET = { IAC: 255, SB: 250, SE: 240, NAWS: 31 };
        const buf = Buffer.from([
          TELNET.IAC, TELNET.SB, TELNET.NAWS,
          (payload.cols >> 8) & 0xff, payload.cols & 0xff,
          (payload.rows >> 8) & 0xff, payload.rows & 0xff,
          TELNET.IAC, TELNET.SE
        ]);
        session.socket.write(buf);
      }
    } catch (err) {
      // Ignore errors when process is already closed
      if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        console.warn("Resize failed", err);
      }
    }
  };

  const close = (_event, payload) => {
    const session = sessions.get(payload.sessionId);
    if (!session) return;
    try {
      if (session.stream) {
        session.stream.close();
        session.conn?.end();
      } else if (session.proc) {
        session.proc.kill();
      } else if (session.socket) {
        session.socket.destroy();
      }
      // Cleanup chain connections if any
      if (session.chainConnections) {
        for (const c of session.chainConnections) {
          try { c.end(); } catch {}
        }
      }
    } catch (err) {
      console.warn("Close failed", err);
    }
    sessions.delete(payload.sessionId);
  };

  // Telnet session using native Node.js net module (no system telnet dependency)
  const startTelnet = async (event, options) => {
    const sessionId =
      options.sessionId ||
      `telnet-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const hostname = options.hostname;
    const port = options.port || 23;
    const cols = options.cols || 80;
    const rows = options.rows || 24;

    console.log(`[Telnet] Starting connection to ${hostname}:${port}`);

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let connected = false;

      // Telnet protocol constants
      const TELNET = {
        IAC: 255,   // Interpret As Command
        DONT: 254,
        DO: 253,
        WONT: 252,
        WILL: 251,
        SB: 250,    // Sub-negotiation Begin
        SE: 240,    // Sub-negotiation End
        // Options
        ECHO: 1,
        SUPPRESS_GO_AHEAD: 3,
        STATUS: 5,
        TERMINAL_TYPE: 24,
        NAWS: 31,   // Negotiate About Window Size
        TERMINAL_SPEED: 32,
        LINEMODE: 34,
        NEW_ENVIRON: 39,
      };

      // Send NAWS (window size) sub-negotiation
      const sendWindowSize = () => {
        const buf = Buffer.from([
          TELNET.IAC, TELNET.SB, TELNET.NAWS,
          (cols >> 8) & 0xff, cols & 0xff,
          (rows >> 8) & 0xff, rows & 0xff,
          TELNET.IAC, TELNET.SE
        ]);
        socket.write(buf);
      };

      // Handle Telnet protocol negotiation
      const handleTelnetNegotiation = (data) => {
        const output = [];
        let i = 0;

        while (i < data.length) {
          if (data[i] === TELNET.IAC) {
            if (i + 1 >= data.length) break;
            
            const cmd = data[i + 1];
            
            if (cmd === TELNET.IAC) {
              // Escaped IAC (255 255) -> output single 255
              output.push(255);
              i += 2;
              continue;
            }

            if (cmd === TELNET.DO || cmd === TELNET.DONT || cmd === TELNET.WILL || cmd === TELNET.WONT) {
              if (i + 2 >= data.length) break;
              
              const opt = data[i + 2];
              console.log(`[Telnet] Received: ${cmd === TELNET.DO ? 'DO' : cmd === TELNET.DONT ? 'DONT' : cmd === TELNET.WILL ? 'WILL' : 'WONT'} ${opt}`);

              // Respond to negotiation
              if (cmd === TELNET.DO) {
                if (opt === TELNET.NAWS) {
                  // We support NAWS
                  socket.write(Buffer.from([TELNET.IAC, TELNET.WILL, opt]));
                  sendWindowSize();
                } else if (opt === TELNET.TERMINAL_TYPE) {
                  socket.write(Buffer.from([TELNET.IAC, TELNET.WILL, opt]));
                } else if (opt === TELNET.SUPPRESS_GO_AHEAD) {
                  socket.write(Buffer.from([TELNET.IAC, TELNET.WILL, opt]));
                } else {
                  // Refuse other options
                  socket.write(Buffer.from([TELNET.IAC, TELNET.WONT, opt]));
                }
              } else if (cmd === TELNET.WILL) {
                if (opt === TELNET.ECHO || opt === TELNET.SUPPRESS_GO_AHEAD) {
                  socket.write(Buffer.from([TELNET.IAC, TELNET.DO, opt]));
                } else {
                  socket.write(Buffer.from([TELNET.IAC, TELNET.DONT, opt]));
                }
              } else if (cmd === TELNET.DONT) {
                socket.write(Buffer.from([TELNET.IAC, TELNET.WONT, opt]));
              } else if (cmd === TELNET.WONT) {
                socket.write(Buffer.from([TELNET.IAC, TELNET.DONT, opt]));
              }

              i += 3;
              continue;
            }

            if (cmd === TELNET.SB) {
              // Sub-negotiation - find SE
              let seIndex = i + 2;
              while (seIndex < data.length - 1) {
                if (data[seIndex] === TELNET.IAC && data[seIndex + 1] === TELNET.SE) {
                  break;
                }
                seIndex++;
              }

              if (seIndex < data.length - 1) {
                const subOpt = data[i + 2];
                console.log(`[Telnet] Sub-negotiation for option ${subOpt}`);
                
                // Handle terminal type request
                if (subOpt === TELNET.TERMINAL_TYPE && data[i + 3] === 1) {
                  // Server is asking for terminal type (SEND = 1)
                  const termType = 'xterm-256color';
                  const response = Buffer.concat([
                    Buffer.from([TELNET.IAC, TELNET.SB, TELNET.TERMINAL_TYPE, 0]), // 0 = IS
                    Buffer.from(termType),
                    Buffer.from([TELNET.IAC, TELNET.SE])
                  ]);
                  socket.write(response);
                }
                
                i = seIndex + 2;
                continue;
              }
            }

            // Unknown command, skip
            i += 2;
            continue;
          }

          // Regular data
          output.push(data[i]);
          i++;
        }

        return Buffer.from(output);
      };

      // Connection timeout
      const connectTimeout = setTimeout(() => {
        if (!connected) {
          console.error(`[Telnet] Connection timeout to ${hostname}:${port}`);
          socket.destroy();
          reject(new Error(`Connection timeout to ${hostname}:${port}`));
        }
      }, 10000);

      socket.on('connect', () => {
        connected = true;
        clearTimeout(connectTimeout);
        console.log(`[Telnet] Connected to ${hostname}:${port}`);

        const session = {
          socket,
          type: 'telnet-native',
          webContentsId: event.sender.id,
          cols,
          rows,
        };
        sessions.set(sessionId, session);

        resolve({ sessionId });
      });

      socket.on('data', (data) => {
        const session = sessions.get(sessionId);
        if (!session) return;

        // Process Telnet protocol and extract clean data
        const cleanData = handleTelnetNegotiation(data);
        
        if (cleanData.length > 0) {
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("nebula:data", { sessionId, data: cleanData.toString('binary') });
        }
      });

      socket.on('error', (err) => {
        console.error(`[Telnet] Socket error: ${err.message}`);
        clearTimeout(connectTimeout);
        
        if (!connected) {
          reject(new Error(`Failed to connect: ${err.message}`));
        } else {
          const session = sessions.get(sessionId);
          if (session) {
            const contents = electronModule.webContents.fromId(session.webContentsId);
            contents?.send("nebula:exit", { sessionId, exitCode: 1, error: err.message });
          }
          sessions.delete(sessionId);
        }
      });

      socket.on('close', (hadError) => {
        console.log(`[Telnet] Connection closed${hadError ? ' with error' : ''}`);
        clearTimeout(connectTimeout);
        
        const session = sessions.get(sessionId);
        if (session) {
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("nebula:exit", { sessionId, exitCode: hadError ? 1 : 0 });
        }
        sessions.delete(sessionId);
      });

      // Connect
      console.log(`[Telnet] Connecting to ${hostname}:${port}...`);
      socket.connect(port, hostname);
    });
  };

  // Mosh session using node-pty to spawn system mosh-client
  const startMosh = async (event, options) => {
    const sessionId =
      options.sessionId ||
      `mosh-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const cols = options.cols || 80;
    const rows = options.rows || 24;

    // Find mosh executable
    let moshCmd = 'mosh';
    if (process.platform === 'win32') {
      // Mosh is less common on Windows, try to find it
      moshCmd = findExecutable('mosh') || 'mosh.exe';
    }

    // Build mosh command arguments
    const args = [];
    
    // SSH port (for initial connection)
    if (options.port && options.port !== 22) {
      args.push('--ssh=ssh -p ' + options.port);
    }

    // Mosh server path if specified
    if (options.moshServerPath) {
      args.push('--server=' + options.moshServerPath);
    }

    // Add user@host
    const userHost = options.username 
      ? `${options.username}@${options.hostname}`
      : options.hostname;
    args.push(userHost);

    const env = {
      ...process.env,
      ...(options.env || {}),
      TERM: 'xterm-256color',
      LANG: options.charset || 'en_US.UTF-8',
    };

    // For key-based auth, set SSH_AUTH_SOCK if available
    if (options.agentForwarding && process.env.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    }

    try {
      const proc = pty.spawn(moshCmd, args, {
        cols,
        rows,
        env,
        cwd: os.homedir(),
      });

      const session = {
        proc,
        type: 'mosh',
        webContentsId: event.sender.id,
      };
      sessions.set(sessionId, session);

      proc.onData((data) => {
        const contents = electronModule.webContents.fromId(session.webContentsId);
        contents?.send("nebula:data", { sessionId, data });
      });

      proc.onExit((evt) => {
        sessions.delete(sessionId);
        const contents = electronModule.webContents.fromId(session.webContentsId);
        contents?.send("nebula:exit", { sessionId, ...evt });
      });

      return { sessionId };
    } catch (err) {
      console.error("[Mosh] Failed to start mosh session:", err.message);
      throw err;
    }
  };

  electronModule.ipcMain.handle("nebula:start", start);
  electronModule.ipcMain.handle("nebula:telnet:start", startTelnet);
  electronModule.ipcMain.handle("nebula:mosh:start", startMosh);
  electronModule.ipcMain.handle("nebula:local:start", (event, payload) => {
    const sessionId =
      payload?.sessionId ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const defaultShell = process.platform === "win32" 
      ? findExecutable("powershell") || "powershell.exe"
      : process.env.SHELL || "/bin/bash";
    const shell = payload?.shell || defaultShell;
    const env = {
      ...process.env,
      ...(payload?.env || {}),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    const proc = pty.spawn(shell, [], {
      cols: payload?.cols || 80,
      rows: payload?.rows || 24,
      env,
    });
    const session = {
      proc,
      webContentsId: event.sender.id,
    };
    sessions.set(sessionId, session);
    proc.onData((data) => {
      const contents = electronModule.webContents.fromId(session.webContentsId);
      contents?.send("nebula:data", { sessionId, data });
    });
    proc.onExit((evt) => {
      sessions.delete(sessionId);
      const contents = electronModule.webContents.fromId(session.webContentsId);
      contents?.send("nebula:exit", { sessionId, ...evt });
    });
    return { sessionId };
  });
  electronModule.ipcMain.on("nebula:write", write);
  electronModule.ipcMain.on("nebula:resize", resize);
  electronModule.ipcMain.on("nebula:close", close);

  // One-off hidden exec (for probes like distro detection)
  const execOnce = async (_event, payload) => {
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
                // code can be undefined in some cases, treat as 0 if no stderr
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
          // Connection ended before command close - likely an auth failure or connection issue
          // If we have stderr output, use it; otherwise this is likely an error
          if (stderr || stdout) {
            resolve({ stdout, stderr, code: 0 });
          } else {
            reject(new Error("SSH connection closed unexpectedly"));
          }
        });

      conn.connect({
        host: payload.hostname,
        port: payload.port || 22,
        username: payload.username,
        password: payload.password,
        privateKey: payload.privateKey,
        readyTimeout: timeoutMs,
        keepaliveInterval: 0,
      });
    });
  };

  electronModule.ipcMain.handle("nebula:ssh:exec", execOnce);

  // SSH Key Generation handler
  electronModule.ipcMain.handle("nebula:key:generate", async (_event, options) => {
    const { type, bits, comment } = options;
    
    try {
      // Map key type to ssh2 format
      let keyType;
      let keyBits = bits;
      
      switch (type) {
        case 'ED25519':
          keyType = 'ed25519';
          keyBits = undefined; // ED25519 doesn't use bits
          break;
        case 'ECDSA':
          keyType = 'ecdsa';
          keyBits = bits || 256; // 256, 384, or 521
          break;
        case 'RSA':
        default:
          keyType = 'rsa';
          keyBits = bits || 4096;
          break;
      }
      
      // Generate key pair synchronously
      const result = sshUtils.generateKeyPairSync(keyType, {
        bits: keyBits,
        comment: comment || 'netcatty-generated-key',
      });
      
      // Convert to OpenSSH format strings
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
  });

  // SFTP handlers
  const openSftp = async (_event, options) => {
    const client = new SftpClient();
    const connId = options.sessionId || `${Date.now()}-sftp-${Math.random().toString(16).slice(2)}`;
    const connectOpts = {
      host: options.hostname,
      port: options.port || 22,
      username: options.username || "root",
    };
    // Support both key and password for fallback authentication
    if (options.privateKey) {
      connectOpts.privateKey = options.privateKey;
    }
    if (options.password) {
      connectOpts.password = options.password;
    }
    await client.connect(connectOpts);
    sftpClients.set(connId, client);
    return { sftpId: connId };
  };

  const listSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    const list = await client.list(payload.path || ".");
    return list.map((item) => ({
      name: item.name,
      type: item.type === "d" ? "directory" : "file",
      size: `${item.size} bytes`,
      lastModified: new Date(item.modifyTime || Date.now()).toISOString(),
    }));
  };

  const readSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    const buffer = await client.get(payload.path);
    return buffer.toString();
  };

  const writeSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.put(Buffer.from(payload.content, "utf-8"), payload.path);
    return true;
  };

  // Write binary data with progress callback
  const writeSftpBinaryWithProgress = async (event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    
    const { sftpId, path: remotePath, content, transferId } = payload;
    const buffer = Buffer.from(content);
    const totalBytes = buffer.length;
    let transferredBytes = 0;
    let lastProgressTime = Date.now();
    let lastTransferredBytes = 0;
    
    // Create a readable stream from the buffer
    const { Readable } = require("stream");
    const readableStream = new Readable({
      read() {
        // Push data in chunks of 64KB for progress updates
        const chunkSize = 65536;
        if (transferredBytes < totalBytes) {
          const end = Math.min(transferredBytes + chunkSize, totalBytes);
          const chunk = buffer.slice(transferredBytes, end);
          transferredBytes = end;
          
          // Calculate speed
          const now = Date.now();
          const elapsed = (now - lastProgressTime) / 1000;
          let speed = 0;
          if (elapsed >= 0.1) {
            speed = (transferredBytes - lastTransferredBytes) / elapsed;
            lastProgressTime = now;
            lastTransferredBytes = transferredBytes;
          }
          
          // Send progress update
          const contents = electronModule.webContents.fromId(event.sender.id);
          contents?.send("nebula:upload:progress", {
            transferId,
            transferred: transferredBytes,
            totalBytes,
            speed,
          });
          
          this.push(chunk);
        } else {
          this.push(null); // End of stream
        }
      }
    });
    
    try {
      await client.put(readableStream, remotePath);
      
      // Send completion
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("nebula:upload:complete", { transferId });
      
      return { success: true, transferId };
    } catch (err) {
      // Send error
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("nebula:upload:error", { transferId, error: err.message });
      throw err;
    }
  };

  const closeSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) return;
    try {
      await client.end();
    } catch (err) {
      console.warn("SFTP close failed", err);
    }
    sftpClients.delete(payload.sftpId);
  };

  const mkdirSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.mkdir(payload.path, true);
    return true;
  };

  // Delete file or directory via SFTP
  const deleteSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    
    // Check if it's a directory or file
    const stat = await client.stat(payload.path);
    if (stat.isDirectory) {
      await client.rmdir(payload.path, true); // recursive delete
    } else {
      await client.delete(payload.path);
    }
    return true;
  };

  // Rename file or directory via SFTP
  const renameSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.rename(payload.oldPath, payload.newPath);
    return true;
  };

  // Stat file via SFTP
  const statSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    const stat = await client.stat(payload.path);
    return {
      name: path.basename(payload.path),
      type: stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file",
      size: stat.size,
      lastModified: stat.modifyTime,
      permissions: stat.mode ? (stat.mode & 0o777).toString(8) : undefined,
    };
  };

  // Change permissions via SFTP
  const chmodSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.chmod(payload.path, parseInt(payload.mode, 8));
    return true;
  };

  // Local filesystem operations
  const listLocalDir = async (_event, payload) => {
    const dirPath = payload.path;
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const result = [];
    
    for (const entry of entries) {
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = await fs.promises.stat(fullPath);
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          size: `${stat.size} bytes`,
          lastModified: stat.mtime.toISOString(),
        });
      } catch (err) {
        // Skip files we can't stat (permission denied, etc.)
        console.warn(`Could not stat ${entry.name}:`, err.message);
      }
    }
    return result;
  };

  const readLocalFile = async (_event, payload) => {
    const buffer = await fs.promises.readFile(payload.path);
    return buffer;
  };

  const writeLocalFile = async (_event, payload) => {
    await fs.promises.writeFile(payload.path, Buffer.from(payload.content));
    return true;
  };

  const deleteLocalFile = async (_event, payload) => {
    const stat = await fs.promises.stat(payload.path);
    if (stat.isDirectory()) {
      await fs.promises.rm(payload.path, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(payload.path);
    }
    return true;
  };

  const renameLocalFile = async (_event, payload) => {
    await fs.promises.rename(payload.oldPath, payload.newPath);
    return true;
  };

  const mkdirLocal = async (_event, payload) => {
    await fs.promises.mkdir(payload.path, { recursive: true });
    return true;
  };

  const statLocal = async (_event, payload) => {
    const stat = await fs.promises.stat(payload.path);
    return {
      name: path.basename(payload.path),
      type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
      size: stat.size,
      lastModified: stat.mtime.getTime(),
    };
  };

  const getHomeDir = async () => {
    return os.homedir();
  };

  // Read system known_hosts file
  const readKnownHosts = async () => {
    const homeDir = os.homedir();
    const knownHostsPaths = [];
    
    if (process.platform === "win32") {
      // Windows: ~/.ssh/known_hosts
      knownHostsPaths.push(path.join(homeDir, ".ssh", "known_hosts"));
      // Also check OpenSSH system path
      knownHostsPaths.push(path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ssh", "known_hosts"));
    } else if (process.platform === "darwin") {
      // macOS
      knownHostsPaths.push(path.join(homeDir, ".ssh", "known_hosts"));
      knownHostsPaths.push("/etc/ssh/ssh_known_hosts");
    } else {
      // Linux and others
      knownHostsPaths.push(path.join(homeDir, ".ssh", "known_hosts"));
      knownHostsPaths.push("/etc/ssh/ssh_known_hosts");
    }
    
    let combinedContent = "";
    
    for (const knownHostsPath of knownHostsPaths) {
      try {
        if (fs.existsSync(knownHostsPath)) {
          const content = fs.readFileSync(knownHostsPath, "utf8");
          if (content.trim()) {
            combinedContent += content + "\n";
          }
        }
      } catch (err) {
        console.warn(`Failed to read known_hosts from ${knownHostsPath}:`, err.message);
      }
    }
    
    return combinedContent || null;
  };

  electronModule.ipcMain.handle("nebula:sftp:open", openSftp);
  electronModule.ipcMain.handle("nebula:sftp:list", listSftp);
  electronModule.ipcMain.handle("nebula:sftp:read", readSftp);
  electronModule.ipcMain.handle("nebula:sftp:write", writeSftp);
  electronModule.ipcMain.handle("nebula:sftp:writeBinaryWithProgress", writeSftpBinaryWithProgress);
  electronModule.ipcMain.handle("nebula:sftp:close", closeSftp);
  electronModule.ipcMain.handle("nebula:sftp:mkdir", mkdirSftp);
  electronModule.ipcMain.handle("nebula:sftp:delete", deleteSftp);
  electronModule.ipcMain.handle("nebula:sftp:rename", renameSftp);
  electronModule.ipcMain.handle("nebula:sftp:stat", statSftp);
  electronModule.ipcMain.handle("nebula:sftp:chmod", chmodSftp);
  
  // Local filesystem handlers
  electronModule.ipcMain.handle("nebula:local:list", listLocalDir);
  electronModule.ipcMain.handle("nebula:local:read", readLocalFile);
  electronModule.ipcMain.handle("nebula:local:write", writeLocalFile);
  electronModule.ipcMain.handle("nebula:local:delete", deleteLocalFile);
  electronModule.ipcMain.handle("nebula:local:rename", renameLocalFile);
  electronModule.ipcMain.handle("nebula:local:mkdir", mkdirLocal);
  electronModule.ipcMain.handle("nebula:local:stat", statLocal);
  electronModule.ipcMain.handle("nebula:local:homedir", getHomeDir);
  electronModule.ipcMain.handle("nebula:known-hosts:read", readKnownHosts);
  
  // Streaming transfer with progress and cancellation support
  const activeTransfers = new Map(); // transferId -> { cancelled: boolean, abortController?: AbortController }
  
  const startTransfer = async (event, payload) => {
    const { transferId, sourcePath, targetPath, sourceType, targetType, sourceSftpId, targetSftpId, totalBytes } = payload;
    const sender = event.sender;
    
    // Register transfer for cancellation
    activeTransfers.set(transferId, { cancelled: false });
    
    let lastTime = Date.now();
    let lastTransferred = 0;
    let speed = 0;
    
    const sendProgress = (transferred, total) => {
      if (activeTransfers.get(transferId)?.cancelled) return;
      
      // Calculate speed
      const now = Date.now();
      const elapsed = now - lastTime;
      if (elapsed >= 100) {
        speed = Math.round((transferred - lastTransferred) / (elapsed / 1000));
        lastTime = now;
        lastTransferred = transferred;
      }
      
      sender.send("nebula:transfer:progress", { transferId, transferred, speed, totalBytes: total });
    };
    
    const sendComplete = () => {
      activeTransfers.delete(transferId);
      sender.send("nebula:transfer:complete", { transferId });
    };
    
    const sendError = (error) => {
      activeTransfers.delete(transferId);
      sender.send("nebula:transfer:error", { transferId, error: error.message || String(error) });
    };
    
    const isCancelled = () => activeTransfers.get(transferId)?.cancelled;
    
    try {
      let fileSize = totalBytes || 0;
      
      // Get file size if not provided
      if (!fileSize) {
        if (sourceType === 'local') {
          const stat = await fs.promises.stat(sourcePath);
          fileSize = stat.size;
        } else if (sourceType === 'sftp') {
          const client = sftpClients.get(sourceSftpId);
          if (!client) throw new Error("Source SFTP session not found");
          const stat = await client.stat(sourcePath);
          fileSize = stat.size;
        }
      }
      
      // Send initial progress
      sendProgress(0, fileSize);
      
      // Handle different transfer scenarios
      if (sourceType === 'local' && targetType === 'sftp') {
        // Upload: Local -> SFTP (use fastPut with step callback)
        const client = sftpClients.get(targetSftpId);
        if (!client) throw new Error("Target SFTP session not found");
        
        // Ensure remote directory exists
        const dir = path.dirname(targetPath).replace(/\\/g, '/');
        try { await client.mkdir(dir, true); } catch {}
        
        await client.fastPut(sourcePath, targetPath, {
          step: (totalTransferred, chunk, total) => {
            if (isCancelled()) {
              throw new Error('Transfer cancelled');
            }
            sendProgress(totalTransferred, total);
          }
        });
        
      } else if (sourceType === 'sftp' && targetType === 'local') {
        // Download: SFTP -> Local (use fastGet with step callback)
        const client = sftpClients.get(sourceSftpId);
        if (!client) throw new Error("Source SFTP session not found");
        
        // Ensure local directory exists
        const dir = path.dirname(targetPath);
        await fs.promises.mkdir(dir, { recursive: true });
        
        await client.fastGet(sourcePath, targetPath, {
          step: (totalTransferred, chunk, total) => {
            if (isCancelled()) {
              throw new Error('Transfer cancelled');
            }
            sendProgress(totalTransferred, total);
          }
        });
        
      } else if (sourceType === 'local' && targetType === 'local') {
        // Local copy: use streams
        const dir = path.dirname(targetPath);
        await fs.promises.mkdir(dir, { recursive: true });
        
        await new Promise((resolve, reject) => {
          const readStream = fs.createReadStream(sourcePath);
          const writeStream = fs.createWriteStream(targetPath);
          let transferred = 0;
          
          const transfer = activeTransfers.get(transferId);
          if (transfer) {
            transfer.readStream = readStream;
            transfer.writeStream = writeStream;
          }
          
          readStream.on('data', (chunk) => {
            if (isCancelled()) {
              readStream.destroy();
              writeStream.destroy();
              reject(new Error('Transfer cancelled'));
              return;
            }
            transferred += chunk.length;
            sendProgress(transferred, fileSize);
          });
          
          readStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('finish', resolve);
          
          readStream.pipe(writeStream);
        });
        
      } else if (sourceType === 'sftp' && targetType === 'sftp') {
        // SFTP to SFTP: download to temp then upload
        const tempPath = path.join(os.tmpdir(), `nebula-transfer-${transferId}`);
        
        const sourceClient = sftpClients.get(sourceSftpId);
        const targetClient = sftpClients.get(targetSftpId);
        if (!sourceClient) throw new Error("Source SFTP session not found");
        if (!targetClient) throw new Error("Target SFTP session not found");
        
        // Download phase (0-50%)
        await sourceClient.fastGet(sourcePath, tempPath, {
          step: (totalTransferred, chunk, total) => {
            if (isCancelled()) {
              throw new Error('Transfer cancelled');
            }
            // Report as 0-50% of total
            sendProgress(Math.floor(totalTransferred / 2), fileSize);
          }
        });
        
        if (isCancelled()) {
          try { await fs.promises.unlink(tempPath); } catch {}
          throw new Error('Transfer cancelled');
        }
        
        // Upload phase (50-100%)
        const dir = path.dirname(targetPath).replace(/\\/g, '/');
        try { await targetClient.mkdir(dir, true); } catch {}
        
        await targetClient.fastPut(tempPath, targetPath, {
          step: (totalTransferred, chunk, total) => {
            if (isCancelled()) {
              throw new Error('Transfer cancelled');
            }
            // Report as 50-100% of total
            sendProgress(Math.floor(fileSize / 2) + Math.floor(totalTransferred / 2), fileSize);
          }
        });
        
        // Cleanup temp file
        try { await fs.promises.unlink(tempPath); } catch {}
        
      } else {
        throw new Error("Invalid transfer configuration");
      }
      
      // Send final 100% progress
      sendProgress(fileSize, fileSize);
      sendComplete();
      
      return { transferId, totalBytes: fileSize };
    } catch (err) {
      if (err.message === 'Transfer cancelled') {
        activeTransfers.delete(transferId);
        sender.send("nebula:transfer:cancelled", { transferId });
      } else {
        sendError(err);
      }
      return { transferId, error: err.message };
    }
  };
  
  const cancelTransfer = async (_event, payload) => {
    const { transferId } = payload;
    const transfer = activeTransfers.get(transferId);
    if (transfer) {
      transfer.cancelled = true;
      if (transfer.readStream) {
        try { transfer.readStream.destroy(); } catch {}
      }
      if (transfer.writeStream) {
        try { transfer.writeStream.destroy(); } catch {}
      }
      activeTransfers.delete(transferId);
    }
    return { success: true };
  };
  
  electronModule.ipcMain.handle("nebula:transfer:start", startTransfer);
  electronModule.ipcMain.handle("nebula:transfer:cancel", cancelTransfer);

  // ============================================
  // PORT FORWARDING HANDLERS
  // ============================================
  
  // Store active port forwarding tunnels
  const portForwardingTunnels = new Map();
  
  // Start a port forwarding tunnel
  const startPortForward = async (event, payload) => {
    const { 
      tunnelId, 
      type, // 'local' | 'remote' | 'dynamic'
      localPort, 
      bindAddress = '127.0.0.1',
      remoteHost,
      remotePort,
      // SSH connection details
      hostname,
      port = 22,
      username,
      password,
      privateKey,
    } = payload;
    
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      const sender = event.sender;
      
      const sendStatus = (status, error = null) => {
        if (!sender.isDestroyed()) {
          sender.send("nebula:portforward:status", { tunnelId, status, error });
        }
      };
      
      const connectOpts = {
        host: hostname,
        port: port,
        username: username || 'root',
        readyTimeout: 30000,
        keepaliveInterval: 10000,
      };
      
      if (privateKey) {
        connectOpts.privateKey = privateKey;
      } else if (password) {
        connectOpts.password = password;
      }
      
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
          conn.on('tcp connection', (info, accept, reject) => {
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
              // SOCKS5 greeting: version, number of methods, methods
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
                  0, // Let the SSH server pick source port
                  targetHost,
                  targetPort,
                  (err, stream) => {
                    if (err) {
                      // Connection refused
                      socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                      socket.end();
                      return;
                    }
                    
                    // Success reply
                    const reply = Buffer.alloc(10);
                    reply[0] = 0x05; // version
                    reply[1] = 0x00; // success
                    reply[2] = 0x00; // reserved
                    reply[3] = 0x01; // IPv4
                    reply.writeUInt16BE(0, 8); // port
                    socket.write(reply);
                    
                    // Pipe data
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
            try { tunnel.server.close(); } catch {}
          }
          sendStatus('inactive');
          portForwardingTunnels.delete(tunnelId);
        }
      });
      
      sendStatus('connecting');
      conn.connect(connectOpts);
    });
  };
  
  // Stop a port forwarding tunnel
  const stopPortForward = async (_event, payload) => {
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
  };
  
  // Get status of all active tunnels
  const getPortForwardStatus = async (_event, payload) => {
    const { tunnelId } = payload;
    const tunnel = portForwardingTunnels.get(tunnelId);
    
    if (!tunnel) {
      return { tunnelId, status: 'inactive' };
    }
    
    return { tunnelId, status: 'active', type: tunnel.type };
  };
  
  // List all active port forwards
  const listPortForwards = async () => {
    const list = [];
    for (const [tunnelId, tunnel] of portForwardingTunnels) {
      list.push({
        tunnelId,
        type: tunnel.type,
        status: 'active',
      });
    }
    return list;
  };
  
  electronModule.ipcMain.handle("nebula:portforward:start", startPortForward);
  electronModule.ipcMain.handle("nebula:portforward:stop", stopPortForward);
  electronModule.ipcMain.handle("nebula:portforward:status", getPortForwardStatus);
  electronModule.ipcMain.handle("nebula:portforward:list", listPortForwards);
};

// Store reference to main window for theme updates
let mainWindow = null;

// Theme colors configuration
const THEME_COLORS = {
  dark: {
    background: "#0b1220",
    titleBarColor: "#0b1220",
    symbolColor: "#ffffff",
  },
  light: {
    background: "#ffffff",
    titleBarColor: "#f8fafc",
    symbolColor: "#1e293b",
  },
};

// Read initial theme from a simple approach - default to light
let currentTheme = "light";

async function createWindow() {
  const themeConfig = THEME_COLORS[currentTheme];
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: themeConfig.background,
    icon: appIcon,
    // macOS: use hiddenInset for native traffic lights
    // Windows/Linux: use frameless window with custom controls
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;

  // Window control handlers (for custom title bar on Windows/Linux)
  electronModule.ipcMain.handle("nebula:window:minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  electronModule.ipcMain.handle("nebula:window:maximize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
        return false;
      } else {
        mainWindow.maximize();
        return true;
      }
    }
    return false;
  });

  electronModule.ipcMain.handle("nebula:window:close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  electronModule.ipcMain.handle("nebula:window:isMaximized", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.isMaximized();
    }
    return false;
  });

  // Handle theme change requests from renderer
  electronModule.ipcMain.handle("nebula:setTheme", (_event, theme) => {
    currentTheme = theme;
    nativeTheme.themeSource = theme;
    const themeConfig = THEME_COLORS[theme] || THEME_COLORS.light;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(themeConfig.background);
    }
    return true;
  });

  if (isDev) {
    try {
      await win.loadURL(devServerUrl);
      win.webContents.openDevTools({ mode: "detach" });
      registerSSHBridge(win);
      return;
    } catch (e) {
      console.warn("Dev server not reachable, falling back to bundled dist.", e);
    }
  }

  // In production, use local HTTP server for WebAuthn support (requires secure context)
  // WebAuthn (Windows Hello, Touch ID, FIDO2) requires either HTTPS or localhost
  try {
    if (!productionServerUrl) {
      await startProductionServer();
    }
    await win.loadURL(productionServerUrl);
  } catch (e) {
    console.warn("Failed to start production server, falling back to file://", e);
    const indexPath = path.join(__dirname, "../dist/index.html");
    await win.loadFile(indexPath);
  }
  registerSSHBridge(win);
}

app.whenReady().then(() => {
  if (isMac && appIcon && app.dock?.setIcon) {
    try {
      app.dock.setIcon(appIcon);
    } catch (err) {
      console.warn("Failed to set dock icon", err);
    }
  }

  // Set a minimal menu to prevent function keys from being intercepted
  // This is especially important for F10 in htop and similar applications
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }]
          : [{ role: "close" }]),
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Cleanup production server
  if (productionServer) {
    productionServer.close();
    productionServer = null;
    productionServerUrl = null;
  }
  if (process.platform !== "darwin") app.quit();
});
