/**
 * SFTP Bridge - Handles SFTP connections and file operations
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { TextDecoder } = require("node:util");
const SftpClient = require("ssh2-sftp-client");
const { Client: SSHClient } = require("ssh2");
const iconv = require("iconv-lite");
let SFTPWrapper;
try {
  // Try to load SFTPWrapper from ssh2 internals for sudo support
  const sftpModule = require("ssh2/lib/protocol/SFTP");
  SFTPWrapper = sftpModule.SFTP || sftpModule;
} catch (e) {
  console.warn("[SFTP] Failed to load SFTPWrapper from ssh2, sudo mode will not work:", e.message);
}
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const fileWatcherBridge = require("./fileWatcherBridge.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const { 
  buildAuthHandler, 
  createKeyboardInteractiveHandler, 
  applyAuthToConnOpts,
  safeSend: authSafeSend,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
} = require("./sshAuthHelper.cjs");

// SFTP clients storage - shared reference passed from main
let sftpClients = null;
let electronModule = null;

// Storage for jump host connections that need to be cleaned up
const jumpConnectionsMap = new Map(); // connId -> { connections: SSHClient[], socket: stream }

// Storage for active SFTP uploads that can be cancelled
const activeSftpUploads = new Map(); // transferId -> { cancelled: boolean, stream: Readable }

// Track requested/resolved filename encoding per SFTP session
const sftpEncodingState = new Map(); // sftpId -> { requested: 'auto'|'utf-8'|'gb18030', resolved: 'utf-8'|'gb18030' }
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const normalizeEncoding = (encoding) => {
  if (!encoding) return "auto";
  const normalized = String(encoding).toLowerCase();
  if (normalized === "utf8") return "utf-8";
  return normalized;
};

const isValidUtf8 = (buffer) => {
  try {
    utf8Decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
};

const detectEncodingFromList = (items) => {
  // Return null if we can't definitively detect encoding (empty list or all valid UTF-8)
  // This allows the caller to preserve the previous encoding instead of defaulting to UTF-8
  if (!items || items.length === 0) {
    return null;
  }
  for (const item of items) {
    const raw = item?.filenameRaw || (item?.filename ? Buffer.from(item.filename, "utf8") : null);
    if (raw && !isValidUtf8(raw)) {
      return "gb18030";
    }
  }
  // All filenames are valid UTF-8, but we can't prove they're not GB18030-encoded ASCII
  // Return null to preserve previous encoding rather than forcing UTF-8
  return null;
};

const resolveEncodingForRequest = (sftpId, requestedEncoding) => {
  const requested = normalizeEncoding(requestedEncoding);
  if (requested && requested !== "auto") {
    sftpEncodingState.set(sftpId, { requested, resolved: requested });
    return requested;
  }
  const existing = sftpEncodingState.get(sftpId);
  const resolved = existing?.resolved || "utf-8";
  sftpEncodingState.set(sftpId, { requested: "auto", resolved });
  return resolved;
};

const updateResolvedEncoding = (sftpId, requestedEncoding, resolvedEncoding) => {
  const requested = normalizeEncoding(requestedEncoding);
  const resolved = normalizeEncoding(resolvedEncoding);
  const finalResolved = resolved === "auto" ? "utf-8" : resolved;
  sftpEncodingState.set(sftpId, {
    requested: requested || "auto",
    resolved: finalResolved,
  });
  return finalResolved;
};

const isAsciiString = (value) =>
  typeof value === "string" && /^[\x00-\x7F]*$/.test(value);

const encodePath = (input, encoding) => {
  if (input === undefined || input === null) return input;
  if (Buffer.isBuffer(input)) return input;
  if (encoding === "utf-8") return input;
  // Avoid Buffer paths when ASCII-only; keeps compatibility with unpatched ssh2
  if (isAsciiString(input)) return input;
  return iconv.encode(input, encoding);
};

const decodeName = (raw, encoding) => {
  if (!raw) return "";
  if (Buffer.isBuffer(raw)) {
    return encoding === "utf-8" ? raw.toString("utf8") : iconv.decode(raw, encoding);
  }
  return raw;
};

const encodePathForSession = (sftpId, inputPath, requestedEncoding) => {
  if (!sftpId) return inputPath;
  const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
  return encodePath(inputPath, encoding);
};

const getSftpChannel = (client) => client?.sftp || client?.client?.sftp;

const statAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.stat(targetPath, (err, stats) => (err ? reject(err) : resolve(stats)));
  });

const readdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.readdir(targetPath, (err, items) => (err ? reject(err) : resolve(items || [])));
  });

const mkdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.mkdir(targetPath, (err) => (err ? reject(err) : resolve()));
  });

const rmdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.rmdir(targetPath, (err) => (err ? reject(err) : resolve()));
  });

const unlinkAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.unlink(targetPath, (err) => (err ? reject(err) : resolve()));
  });

const normalizeRemotePathString = async (client, inputPath) => {
  if (typeof inputPath !== "string") return inputPath;
  if (inputPath.startsWith("..")) {
    const root = await client.realPath("..");
    return `${root}/${inputPath.slice(3)}`;
  }
  if (inputPath.startsWith(".")) {
    const root = await client.realPath(".");
    return `${root}/${inputPath.slice(2)}`;
  }
  return inputPath;
};

const ensureRemoteDirInternal = async (sftp, dirPath, encoding) => {
  if (!dirPath || dirPath === ".") return;
  const normalized = path.posix.normalize(dirPath);
  if (!normalized || normalized === ".") return;

  // Optimization: Check if the full path already exists to avoid O(N) round trips
  // This is the common case (e.g. uploading multiple files to the same directory)
  const encodedFull = encodePath(normalized, encoding);
  try {
    const stats = await statAsync(sftp, encodedFull);
    if (stats.isDirectory()) {
      return;
    }
  } catch (err) {
    // If path doesn't exist or other error, proceed to recursive check
  }

  const isAbsolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  let current = isAbsolute ? "/" : "";

  for (const part of parts) {
    current = current === "/" ? `/${part}` : (current ? `${current}/${part}` : part);
    const encodedCurrent = encodePath(current, encoding);
    try {
      const stats = await statAsync(sftp, encodedCurrent);
      if (!stats.isDirectory()) {
        throw new Error(`Remote path is not a directory: ${current}`);
      }
    } catch (err) {
      if (err && (err.code === 2 || err.code === 4)) {
        await mkdirAsync(sftp, encodedCurrent);
        continue;
      }
      throw err;
    }
  }
};

const removeRemotePathInternal = async (sftp, targetPath, encoding) => {
  const encodedTarget = encodePath(targetPath, encoding);
  let stats;
  try {
    stats = await statAsync(sftp, encodedTarget);
  } catch (err) {
    if (err && err.code === 2) return;
    throw err;
  }

  if (stats.isDirectory()) {
    const items = await readdirAsync(sftp, encodedTarget);
    for (const item of items) {
      const rawName =
        item?.filenameRaw ||
        (item?.filename ? Buffer.from(item.filename, "utf8") : null);
      const name = decodeName(rawName, encoding);
      if (!name || name === "." || name === "..") continue;
      const childPath = path.posix.join(targetPath, name);
      await removeRemotePathInternal(sftp, childPath, encoding);
    }
    await rmdirAsync(sftp, encodedTarget);
  } else {
    await unlinkAsync(sftp, encodedTarget);
  }
};

const ensureRemoteDirForSession = async (sftpId, dirPath, requestedEncoding) => {
  const client = sftpClients.get(sftpId);
  if (!client) throw new Error("SFTP session not found");

  if (!dirPath || dirPath === ".") return true;

  const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
  if (encoding === "utf-8") {
    const encodedPath = encodePath(dirPath, encoding);
    await client.mkdir(encodedPath, true);
    return true;
  }

  const sftp = getSftpChannel(client);
  if (!sftp) throw new Error("SFTP channel not ready");

  const normalizedPath = await normalizeRemotePathString(client, dirPath);
  await ensureRemoteDirInternal(sftp, normalizedPath, encoding);
  return true;
};

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
 * Initialize the SFTP bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
}

/**
 * Connect through a chain of jump hosts for SFTP
 */
async function connectThroughChainForSftp(event, options, jumpHosts, targetHost, targetPort, connId) {
  const sender = event.sender;
  const connections = [];
  let currentSocket = null;

  try {
    // Connect through each jump host
    for (let i = 0; i < jumpHosts.length; i++) {
      const jump = jumpHosts[i];
      const isFirst = i === 0;
      const isLast = i === jumpHosts.length - 1;
      const hopLabel = jump.label || `${jump.hostname}:${jump.port || 22}`;

      console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: Connecting to ${hopLabel}...`);

      const conn = new SSHClient();
      // Increase max listeners to prevent Node.js warning
      // Set to 0 (unlimited) since complex operations add many temp listeners
      conn.setMaxListeners(0);

      // Build connection options
      const connOpts = {
        host: jump.hostname,
        port: jump.port || 22,
        username: jump.username || 'root',
        readyTimeout: 120000, // 2 minutes to allow for keyboard-interactive (2FA/MFA)
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        // Enable keyboard-interactive authentication (required for 2FA/MFA)
        tryKeyboard: true,
        algorithms: {
          // Prioritize fastest ciphers (GCM modes are hardware-accelerated)
          cipher: [
            'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
            'chacha20-poly1305@openssh.com',
            'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
          ],
          // Prioritize modern key exchange algorithms for broad compatibility
          kex: [
            'curve25519-sha256', 'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
            'diffie-hellman-group-exchange-sha256',
          ],
          compress: ['none'],
        },
      };

      // Auth - support agent (certificate), key, and password fallback
      const hasCertificate =
        typeof jump.certificate === "string" && jump.certificate.trim().length > 0;

      let authAgent = null;
      if (hasCertificate) {
        authAgent = new NetcattyAgent({
          mode: "certificate",
          webContents: event.sender,
          meta: {
            label: jump.keyId || jump.username || "",
            certificate: jump.certificate,
            privateKey: jump.privateKey,
            passphrase: jump.passphrase,
          },
        });
        connOpts.agent = authAgent;
      } else if (jump.privateKey) {
        connOpts.privateKey = jump.privateKey;
        if (jump.passphrase) connOpts.passphrase = jump.passphrase;
      }

      if (jump.password) connOpts.password = jump.password;

      // Get default keys (either from options if pre-fetched, or fetch them now)
      const defaultKeys = options._defaultKeys || await findAllDefaultPrivateKeysFromHelper();

      // Build auth handler using shared helper
      // Pass unlocked encrypted keys from options so jump hosts can use them for retry
      const authConfig = buildAuthHandler({
        privateKey: connOpts.privateKey,
        password: connOpts.password,
        passphrase: connOpts.passphrase,
        agent: connOpts.agent,
        username: connOpts.username,
        logPrefix: `[SFTP Chain] Hop ${i + 1}`,
        unlockedEncryptedKeys: options._unlockedEncryptedKeys || [],
        defaultKeys,
      });
      applyAuthToConnOpts(connOpts, authConfig);

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
          console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} connected`);
          resolve();
        });
        conn.on('error', (err) => {
          console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} error:`, err.message);
          reject(err);
        });
        conn.on('timeout', () => {
          console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} timeout`);
          reject(new Error(`Connection timeout to ${hopLabel}`));
        });
        // Handle keyboard-interactive authentication for jump hosts (2FA/MFA)
        conn.on('keyboard-interactive', createKeyboardInteractiveHandler({
          sender,
          sessionId: connId,
          hostname: hopLabel,
          password: jump.password,
          logPrefix: `[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}`,
        }));
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
      console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: Forwarding to ${nextHost}:${nextPort}...`);
      currentSocket = await new Promise((resolve, reject) => {
        conn.forwardOut('127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
          if (err) {
            console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: forwardOut failed:`, err.message);
            reject(err);
            return;
          }
          console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: forwardOut success`);
          resolve(stream);
        });
      });
    }

    // Return the final forwarded stream and all connections for cleanup
    return {
      socket: currentSocket,
      connections
    };
  } catch (err) {
    // Cleanup on error
    for (const conn of connections) {
      try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP Chain] Cleanup error:', cleanupErr.message); }
    }
    throw err;
  }
}

/**
 * Establish an SFTP connection using sudo
 * @param {SSHClient} client - Connected SSH client
 * @param {string} password - User password for sudo
 */
async function connectSudoSftp(client, password) {
  if (!SFTPWrapper) {
    throw new Error("SFTP sudo mode is not available on this platform. Please disable sudo mode in host settings.");
  }

  // Known sftp-server paths to try
  const sftpPaths = [
    "/usr/lib/openssh/sftp-server",
    "/usr/libexec/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
    "/usr/libexec/sftp-server",
    "/usr/local/libexec/sftp-server",
    "/usr/local/lib/sftp-server"
  ];

  console.log("[SFTP] Probing sftp-server path for sudo mode...");

  let serverPath = null;
  // Try to find the path
  for (const p of sftpPaths) {
    try {
      await new Promise((resolve, reject) => {
        client.exec(`test -x ${p}`, (err, stream) => {
          if (err) return reject(err);
          stream.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error('Not found'));
          });
        });
      });
      serverPath = p;
      break;
    } catch (e) {
      // Continue probing
    }
  }

  if (!serverPath) {
    // Fallback: try to find it in path or assume standard location
    console.warn("[SFTP] Could not probe sftp-server, trying default /usr/lib/openssh/sftp-server");
    serverPath = "/usr/lib/openssh/sftp-server";
  } else {
    console.log(`[SFTP] Found sftp-server at ${serverPath}`);
  }

  return new Promise((resolve, reject) => {
    // Use sudo -S to read password from stdin
    // Use -p '' to set a specific prompt we can detect
    // Use sh -c 'printf SFTPREADY; exec ...' to synchronize the start of sftp-server
    // We use printf instead of echo to avoid trailing newline which could confuse SFTPWrapper
    const prompt = "SUDOPASSWORD:";
    const readyMarker = "SFTPREADY";
    const readyMarkerBuffer = Buffer.from(readyMarker);
    // Add -e to sftp-server to log to stderr for debugging
    const cmd = `sudo -S -p '${prompt}' sh -c 'printf ${readyMarker}; exec ${serverPath} -e'`;

    console.log(`[SFTP] Executing sudo command: ${cmd}`);

    // Disable pty to ensure clean binary stream for SFTP
    client.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return reject(err);

      // Add stream lifecycle logging
      stream.on('close', () => console.log("[SFTP] Stream closed"));
      stream.on('end', () => console.log("[SFTP] Stream ended"));
      stream.on('error', (e) => console.error("[SFTP] Stream error:", e.message));

      let sftpInitialized = false;
      let sftp = null;
      let settled = false;
      let stdoutBuffer = Buffer.alloc(0);
      let stderrBuffer = "";
      let pendingAfterMarker = null;
      let sftpCreated = false;
      const timeoutMs = 20000;
      const timeoutId = setTimeout(() => {
        if (sftpInitialized || settled) return;
        settled = true;
        stream.stderr?.removeListener('data', onStderr);
        stream.removeListener('data', onStdout);
        const error = new Error("SFTP sudo handshake timed out. This may happen if: (1) the password is incorrect, (2) sudo requires a TTY, or (3) the user does not have sudo privileges.");
        reject(error);
      }, timeoutMs);

      const finalize = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        stream.stderr?.removeListener('data', onStderr);
        stream.removeListener('data', onStdout);
        if (err) reject(err);
        else resolve(result);
      };

      const createSftp = () => {
        if (sftpCreated) return;
        sftpCreated = true;
        try {
          const chanInfo = {
            type: 'sftp',
            incoming: stream.incoming,
            outgoing: stream.outgoing
          };
          sftp = new SFTPWrapper(client, chanInfo, {
            // debug: (str) => console.log(`[SFTP DEBUG] ${str}`)
          });

          // Route any remaining channel data directly into the SFTP parser
          if (client._chanMgr && typeof stream.incoming?.id === "number") {
            client._chanMgr.update(stream.incoming.id, sftp);
          }

          sftp.on('ready', () => {
            sftpInitialized = true;
            console.log("[SFTP] Protocol ready");
            finalize(null, sftp);
          });

          sftp.on('error', (err) => {
            console.error("[SFTP] Protocol error:", err.message);
            if (!sftpInitialized) {
              finalize(err);
            }
          });

          stream.on('end', () => {
            try { sftp.push(null); } catch { }
          });
        } catch (e) {
          console.error("[SFTP] Initialization failed:", e.message);
          finalize(e);
        }
      };

      const initSftp = () => {
        if (sftpInitialized) return;
        console.log("[SFTP] Sudo success, initializing SFTP protocol...");
        if (!sftpCreated) createSftp();
        try {
          // Start the handshake
          console.log("[SFTP] Sending INIT packet...");
          sftp._init();
          if (pendingAfterMarker && pendingAfterMarker.length > 0) {
            try {
              sftp.push(pendingAfterMarker);
            } catch (pushErr) {
              console.warn("[SFTP] Failed to push buffered data:", pushErr.message);
            }
            pendingAfterMarker = null;
          }
        } catch (e) {
          console.error("[SFTP] Initialization failed:", e.message);
          finalize(e);
        }
      };

      const onStdout = (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stdoutBuffer = stdoutBuffer.length > 0 ? Buffer.concat([stdoutBuffer, chunk]) : chunk;
        const markerIndex = stdoutBuffer.indexOf(readyMarkerBuffer);
        if (markerIndex !== -1) {
          const afterMarkerIndex = markerIndex + readyMarkerBuffer.length;
          if (afterMarkerIndex < stdoutBuffer.length) {
            pendingAfterMarker = stdoutBuffer.subarray(afterMarkerIndex);
          }
          // Found marker, stop listening to stdout here so SFTPWrapper can take over
          stream.removeListener('data', onStdout);
          stdoutBuffer = Buffer.alloc(0);

          console.log("[SFTP] SFTPREADY detected, waiting for stream to stabilize...");

          // Delay SFTP initialization to ensure sftp-server is fully started and stream is clean
          // Increased timeout to 1000ms to be safe
          setTimeout(() => {
            initSftp();
          }, 1000);
        } else if (stdoutBuffer.length > 256) {
          stdoutBuffer = stdoutBuffer.subarray(stdoutBuffer.length - 256);
        }
      };

      const onStderr = (data) => {
        const chunk = data.toString();
        // Only log that we received stderr data, not the content (may contain sensitive prompts)
        stderrBuffer += chunk;
        if (stderrBuffer.includes(prompt)) {
          console.log("[SFTP] Sudo requested password, sending...");
          // Send password
          if (password) {
            stream.write(password + '\n');
          } else {
            console.warn('[SFTP] sudo requested password but none provided');
            stream.write('\n');
          }
          stderrBuffer = "";
        } else if (stderrBuffer.length > 256) {
          stderrBuffer = stderrBuffer.slice(-256);
        }
      };

      stream.on('data', onStdout);
      stream.stderr.on('data', onStderr);

      // Error handling
      stream.on('exit', (code) => {
        console.log(`[SFTP] Stream exited with code ${code}`);
        if (!sftpInitialized && code !== 0) {
          let errorMsg = `SFTP sudo failed with exit code ${code}.`;
          if (code === 1) {
            errorMsg += " The password may be incorrect or sudo privileges are denied.";
          } else if (code === 127) {
            errorMsg += " sftp-server was not found on the remote system.";
          }
          const error = new Error(errorMsg);
          finalize(error);
        }
      });
    });
  });
}

/**
 * Open a new SFTP connection
 * Supports jump host connections when options.jumpHosts is provided
 */
async function openSftp(event, options) {
  const client = new SftpClient();
  const connId = options.sessionId || `${Date.now()}-sftp-${Math.random().toString(16).slice(2)}`;

  // Get default keys early to use for both chain and target
  const defaultKeys = await findAllDefaultPrivateKeysFromHelper();

  // Check if we need to connect through jump hosts
  const jumpHosts = options.jumpHosts || [];
  const hasJumpHosts = jumpHosts.length > 0;
  const hasProxy = !!options.proxy;

  let chainConnections = [];
  let connectionSocket = null;

  // Handle chain/proxy connections
  if (hasJumpHosts) {
    console.log(`[SFTP] Opening connection through ${jumpHosts.length} jump host(s) to ${options.hostname}:${options.port || 22}`);

    // Pass default keys to chain connection
    options._defaultKeys = defaultKeys;

    const chainResult = await connectThroughChainForSftp(
      event,
      options,
      jumpHosts,
      options.hostname,
      options.port || 22,
      connId
    );
    connectionSocket = chainResult.socket;
    chainConnections = chainResult.connections;
  } else if (hasProxy) {
    console.log(`[SFTP] Opening connection through proxy to ${options.hostname}:${options.port || 22}`);
    connectionSocket = await createProxySocket(
      options.proxy,
      options.hostname,
      options.port || 22
    );
  }

  const connectOpts = {
    host: options.hostname,
    port: options.port || 22,
    username: options.username || "root",
    // Enable keyboard-interactive authentication (required for 2FA/MFA)
    tryKeyboard: true,
    readyTimeout: 120000, // 2 minutes for 2FA input
  };

  // Use the tunneled socket if we have one
  if (connectionSocket) {
    connectOpts.sock = connectionSocket;
    // When using sock, we should not set host/port as the connection is already established
    delete connectOpts.host;
    delete connectOpts.port;
  }

  const hasCertificate = typeof options.certificate === "string" && options.certificate.trim().length > 0;

  let authAgent = null;
  if (hasCertificate) {
    authAgent = new NetcattyAgent({
      mode: "certificate",
      webContents: event.sender,
      meta: {
        label: options.keyId || options.username || "",
        certificate: options.certificate,
        privateKey: options.privateKey,
        passphrase: options.passphrase,
      },
    });
    connectOpts.agent = authAgent;
  } else if (options.privateKey) {
    connectOpts.privateKey = options.privateKey;
    if (options.passphrase) connectOpts.passphrase = options.passphrase;
  }

  if (options.password) connectOpts.password = options.password;

  // Build auth handler using shared helper
  const authConfig = buildAuthHandler({
    privateKey: connectOpts.privateKey,
    password: connectOpts.password,
    passphrase: connectOpts.passphrase,
    agent: connectOpts.agent,
    username: connectOpts.username,
    logPrefix: "[SFTP]",
    defaultKeys,
  });
  applyAuthToConnOpts(connectOpts, authConfig);

  // Create keyboard-interactive handler using shared helper
  const kiHandler = createKeyboardInteractiveHandler({
    sender: event.sender,
    sessionId: connId,
    hostname: options.hostname,
    password: options.password,
    logPrefix: "[SFTP]",
  });

  // Add keyboard-interactive listener BEFORE connecting
  client.on("keyboard-interactive", kiHandler);

  // Increase timeout to allow for keyboard-interactive auth
  connectOpts.readyTimeout = 120000; // 2 minutes for 2FA input

  try {
    if (options.sudo) {
      console.log(`[SFTP] Using sudo mode for connection: ${connId}`);
      const sshClient = client.client;

      await new Promise((resolve, reject) => {
        // Set up error handler for initial connection
        const onConnectError = (err) => reject(err);
        sshClient.once('error', onConnectError);

        sshClient.once('ready', async () => {
          sshClient.removeListener('error', onConnectError);
          try {
            // Use provided password or try empty if using key auth (and hope for nopasswd sudo)
            const sudoPass = options.password || "";
            const sftpWrapper = await connectSudoSftp(sshClient, sudoPass);

            // Inject into sftp-client
            client.sftp = sftpWrapper;

            // Important: attach cleanup listener expected by sftp-client
            client.sftp.on('close', () => client.end());

            resolve();
          } catch (e) {
            sshClient.end();
            reject(e);
          }
        });

        try {
          sshClient.connect(connectOpts);
        } catch (e) {
          reject(e);
        }
      });
    } else {
      await client.connect(connectOpts);
    }
    // Increase max listeners AFTER connect, when the internal ssh2 Client exists
    // This prevents Node.js MaxListenersExceededWarning when performing many operations
    // ssh2-sftp-client adds temporary listeners for each operation, so we need a high limit
    if (client.client && typeof client.client.setMaxListeners === 'function') {
      client.client.setMaxListeners(0); // 0 means unlimited
    }

    sftpClients.set(connId, client);

    // Store jump connections for cleanup when SFTP is closed
    if (chainConnections.length > 0) {
      jumpConnectionsMap.set(connId, {
        connections: chainConnections,
        socket: connectionSocket
      });
    }

    console.log(`[SFTP] Connection established: ${connId}`);
    return { sftpId: connId };
  } catch (err) {
    // Cleanup jump connections on error
    for (const conn of chainConnections) {
      try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP] Cleanup error on connect failure:', cleanupErr.message); }
    }
    throw err;
  }
}

/**
 * List files in a directory
 * Properly handles symlinks by resolving their target type
 */
async function listSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const requestedEncoding = normalizeEncoding(payload.encoding);
  const basePath = payload.path || ".";
  const pathEncoding = resolveEncodingForRequest(payload.sftpId, requestedEncoding);
  const encodedPath = encodePath(basePath, pathEncoding);

  const sftp = getSftpChannel(client);
  if (!sftp) {
    throw new Error("SFTP channel not ready");
  }

  let list;
  try {
    list = await new Promise((resolve, reject) => {
      sftp.readdir(encodedPath, (err, items) => {
        if (err) return reject(err);
        resolve(items || []);
      });
    });
  } catch (err) {
    // Retry with string path when ASCII-only and a Buffer path caused issues
    if (Buffer.isBuffer(encodedPath) && isAsciiString(basePath)) {
      console.warn("[SFTP] Retrying readdir with string path after Buffer failure", {
        basePath,
        error: err?.message || String(err),
      });
      list = await new Promise((resolve, reject) => {
        sftp.readdir(basePath, (retryErr, items) => {
          if (retryErr) return reject(retryErr);
          resolve(items || []);
        });
      });
    } else {
      throw err;
    }
  }

  // When auto mode, try to detect encoding from list
  // If detection returns null (empty list or can't prove non-UTF-8), preserve the previous encoding
  let detectedEncoding;
  if (requestedEncoding === "auto") {
    const detected = detectEncodingFromList(list);
    if (detected) {
      // Definitive detection (e.g., found GB18030 bytes)
      detectedEncoding = detected;
    } else {
      // Can't detect - preserve existing session encoding
      const existing = sftpEncodingState.get(payload.sftpId);
      detectedEncoding = existing?.resolved || "utf-8";
    }
  } else {
    detectedEncoding = requestedEncoding;
  }
  const resolvedEncoding = updateResolvedEncoding(payload.sftpId, requestedEncoding, detectedEncoding);

  // Process items and resolve symlinks
  const results = await Promise.all(list.map(async (item) => {
    const filenameRaw = item.filenameRaw || (item.filename ? Buffer.from(item.filename, "utf8") : null);
    const longnameRaw = item.longnameRaw || (item.longname ? Buffer.from(item.longname, "utf8") : null);
    const name = decodeName(filenameRaw, resolvedEncoding) || item.filename || "";
    const longname = decodeName(longnameRaw, resolvedEncoding) || item.longname || "";

    let type;
    let linkTarget = null;

    if (item.attrs?.isDirectory?.()) {
      type = "directory";
    } else if (item.attrs?.isSymbolicLink?.()) {
      // This is a symlink - try to resolve its target type
      type = "symlink";
      try {
        // Use path.posix.join to properly construct the path and avoid double slashes
        const fullPath = path.posix.join(basePath === "." ? "/" : basePath, name);
        const encodedFullPath = encodePath(fullPath, resolvedEncoding);
        const stat = await client.stat(encodedFullPath);
        // stat follows symlinks, so we get the target's type
        if (stat.isDirectory) {
          linkTarget = "directory";
        } else {
          linkTarget = "file";
        }
      } catch (err) {
        // If we can't stat the symlink target (broken link), keep it as symlink
        console.warn(`Could not resolve symlink target for ${item.name}:`, err.message);
      }
    } else {
      type = "file";
    }

    const modeToPermissions = (mode) => {
      if (typeof mode !== "number") return undefined;
      const toTriplet = (bits) =>
        `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
      return `${toTriplet((mode >> 6) & 7)}${toTriplet((mode >> 3) & 7)}${toTriplet(mode & 7)}`;
    };

    // Extract permissions from longname or attrs.mode
    let permissions = undefined;
    if (longname) {
      // Fallback: parse from longname (e.g., "-rwxr-xr-x 1 root root ...")
      const match = longname.match(/^[dlsbc-]([rwxsStT-]{9})/);
      if (match) {
        permissions = match[1];
      }
    }
    if (!permissions && item.attrs?.mode) {
      permissions = modeToPermissions(item.attrs.mode);
    }

    const modifyTime = item.attrs?.mtime ? item.attrs.mtime * 1000 : Date.now();
    return {
      name,
      type,
      linkTarget,
      size: `${item.attrs?.size || 0} bytes`,
      lastModified: new Date(modifyTime).toISOString(),
      permissions,
    };
  }));

  return results;
}

/**
 * Read file content
 */
async function readSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  const buffer = await client.get(encodedPath);
  return buffer.toString();
}

/**
 * Read file as binary (returns ArrayBuffer for binary files like images)
 */
async function readSftpBinary(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  const buffer = await client.get(encodedPath);
  // Convert Node.js Buffer to ArrayBuffer
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Write file content
 */
async function writeSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  await client.put(Buffer.from(payload.content, "utf-8"), encodedPath);
  return true;
}

/**
 * Write binary data
 */
async function writeSftpBinary(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  await client.put(Buffer.from(payload.content), encodedPath);
  return true;
}

/**
 * Write binary data with progress callback
 * Supports cancellation via activeSftpUploads map
 * Optimized for performance with throttled progress updates
 */
async function writeSftpBinaryWithProgress(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const { sftpId, path: remotePath, content, transferId } = payload;
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(remotePath, encoding);

  // Extract callback functions from payload
  const onProgress = payload.onProgress;
  const onComplete = payload.onComplete;
  const onError = payload.onError;

  // Optimize: Use Buffer.isBuffer to avoid unnecessary copy if already a Buffer
  // For ArrayBuffer from renderer, we still need to convert but use a more efficient method
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const totalBytes = buffer.length;
  let transferredBytes = 0;
  let lastProgressTime = Date.now();
  let lastTransferredBytes = 0;
  let lastProgressSentTime = 0;

  // Throttle settings: send progress at most every 100ms or every 1MB
  const PROGRESS_THROTTLE_MS = 100;
  const PROGRESS_THROTTLE_BYTES = 1024 * 1024; // 1MB
  let lastProgressSentBytes = 0;

  const { Readable } = require("stream");
  const readableStream = new Readable({
    read() {
      // Check for cancellation
      const uploadState = activeSftpUploads.get(transferId);
      if (uploadState?.cancelled) {
        this.destroy(new Error("Upload cancelled"));
        return;
      }

      // Use larger chunk size for better performance (256KB instead of 64KB)
      const chunkSize = 262144;
      if (transferredBytes < totalBytes) {
        const end = Math.min(transferredBytes + chunkSize, totalBytes);
        // Use subarray instead of slice to avoid copying
        const chunk = buffer.subarray(transferredBytes, end);
        transferredBytes = end;

        const now = Date.now();
        const elapsed = (now - lastProgressTime) / 1000;
        let speed = 0;
        if (elapsed >= 0.1) {
          speed = (transferredBytes - lastTransferredBytes) / elapsed;
          lastProgressTime = now;
          lastTransferredBytes = transferredBytes;
        }

        // Throttle IPC progress events: only send if enough time or bytes have passed
        const timeSinceLastProgress = now - lastProgressSentTime;
        const bytesSinceLastProgress = transferredBytes - lastProgressSentBytes;
        const isComplete = transferredBytes >= totalBytes;

        if (isComplete || timeSinceLastProgress >= PROGRESS_THROTTLE_MS || bytesSinceLastProgress >= PROGRESS_THROTTLE_BYTES) {
          // Call the progress callback if provided, otherwise send IPC event
          if (typeof onProgress === 'function') {
            try {
              onProgress(transferredBytes, totalBytes, speed);
            } catch (err) {
              console.warn('[SFTP] Progress callback error:', err);
            }
          } else {
            const contents = electronModule.webContents.fromId(event.sender.id);
            contents?.send("netcatty:upload:progress", {
              transferId,
              transferred: transferredBytes,
              totalBytes,
              speed,
            });
          }
          lastProgressSentTime = now;
          lastProgressSentBytes = transferredBytes;
        }

        this.push(chunk);
      } else {
        this.push(null);
      }
    }
  });

  // Register this upload for potential cancellation
  activeSftpUploads.set(transferId, { cancelled: false, stream: readableStream });

  try {
    await client.put(readableStream, encodedPath);

    // Call the complete callback if provided, otherwise send IPC event
    if (typeof onComplete === 'function') {
      try {
        onComplete();
      } catch (err) {
        console.warn('[SFTP] Complete callback error:', err);
      }
    } else {
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("netcatty:upload:complete", { transferId });
    }

    return { success: true, transferId };
  } catch (err) {
    // Check if this upload was cancelled - the error might not be exactly "Upload cancelled"
    // when stream is destroyed, SFTP server may return different errors like "Write stream error"
    const uploadState = activeSftpUploads.get(transferId);
    if (uploadState?.cancelled || err.message === "Upload cancelled") {
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("netcatty:upload:cancelled", { transferId });
      return { success: false, transferId, cancelled: true };
    }

    // Call the error callback if provided, otherwise send IPC event
    if (typeof onError === 'function') {
      try {
        onError(err.message);
      } catch (callbackErr) {
        console.warn('[SFTP] Error callback error:', callbackErr);
      }
    } else {
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("netcatty:upload:error", { transferId, error: err.message });
    }
    throw err;
  } finally {
    // Cleanup
    activeSftpUploads.delete(transferId);
  }
}

/**
 * Cancel an in-progress SFTP upload
 * Note: We only set the cancelled flag and destroy the stream here.
 * The cleanup (deleting from activeSftpUploads) is handled by writeSftpBinaryWithProgress's finally block
 * to avoid race conditions.
 */
async function cancelSftpUpload(event, payload) {
  const { transferId } = payload;
  const uploadState = activeSftpUploads.get(transferId);
  if (uploadState) {
    uploadState.cancelled = true;
    try {
      uploadState.stream?.destroy();
    } catch (err) {
      // Log but continue - stream may already be destroyed
      console.warn("[SFTP] Error destroying upload stream:", err.message);
    }
    // Don't delete here - let the finally block in writeSftpBinaryWithProgress handle cleanup
    // This avoids race conditions where the upload might still be in progress
  }
  return { success: true };
}

/**
 * Close an SFTP connection
 * Also cleans up any jump host connections and file watchers if present
 */
async function closeSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) return;

  // Stop file watchers and clean up temp files for this SFTP session
  try {
    fileWatcherBridge.stopWatchersForSession(payload.sftpId, true);
  } catch (err) {
    console.warn("[SFTP] Error stopping file watchers:", err.message);
  }

  try {
    await client.end();
  } catch (err) {
    console.warn("SFTP close failed", err);
  }
  sftpClients.delete(payload.sftpId);
  sftpEncodingState.delete(payload.sftpId);

  // Clean up jump connections if any
  const jumpData = jumpConnectionsMap.get(payload.sftpId);
  if (jumpData) {
    for (const conn of jumpData.connections) {
      try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP] Cleanup error on close:', cleanupErr.message); }
    }
    jumpConnectionsMap.delete(payload.sftpId);
    console.log(`[SFTP] Cleaned up ${jumpData.connections.length} jump connection(s) for ${payload.sftpId}`);
  }
}

/**
 * Create a directory
 */
async function mkdirSftp(event, payload) {
  await ensureRemoteDirForSession(payload.sftpId, payload.path, payload.encoding);
  return true;
}

/**
 * Execute a command via SSH using the underlying ssh2 client
 * Returns { stdout, stderr, code }
 */
function execSshCommand(sshClient, command) {
  return new Promise((resolve, reject) => {
    sshClient.exec(command, (err, stream) => {
      if (err) {
        return reject(err);
      }

      let stdout = '';
      let stderr = '';

      stream.on('close', (code) => {
        resolve({ stdout, stderr, code });
      });

      stream.on('data', (data) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    });
  });
}

/**
 * Delete a file or directory
 * For directories, uses SSH exec with 'rm -rf' for much faster deletion
 */
async function deleteSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);

  if (encoding === "utf-8") {
    const encodedPath = encodePath(payload.path, encoding);
    const stat = await client.stat(encodedPath);
    if (stat.isDirectory) {
      // For directories, try to use SSH exec for faster deletion
      // The underlying ssh2 client is available as client.client
      const sshClient = client.client;
      if (sshClient && typeof sshClient.exec === 'function') {
        try {
          // Escape path for shell - wrap in single quotes and escape any single quotes in the path
          const escapedPath = payload.path.replace(/'/g, "'\\''");
          const command = `rm -rf '${escapedPath}'`;
          console.log(`[SFTP] Using SSH exec for fast directory deletion: ${command}`);

          const result = await execSshCommand(sshClient, command);

          if (result.code !== 0) {
            console.warn(`[SFTP] rm -rf returned code ${result.code}: ${result.stderr}`);
            // Fall back to SFTP rmdir if rm -rf fails (e.g., permission denied)
            await client.rmdir(encodedPath, true);
          }
          return true;
        } catch (execErr) {
          console.warn('[SFTP] SSH exec failed, falling back to SFTP rmdir:', execErr.message);
          // Fall back to slow SFTP rmdir
          await client.rmdir(encodedPath, true);
          return true;
        }
      } else {
        // No SSH client available, use SFTP rmdir
        await client.rmdir(encodedPath, true);
      }
    } else {
      await client.delete(encodedPath);
    }
    return true;
  }

  const sftp = getSftpChannel(client);
  if (!sftp) throw new Error("SFTP channel not ready");
  const normalizedPath = await normalizeRemotePathString(client, payload.path);
  await removeRemotePathInternal(sftp, normalizedPath, encoding);
  return true;
}

/**
 * Rename a file or directory
 */
async function renameSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedOldPath = encodePath(payload.oldPath, encoding);
  const encodedNewPath = encodePath(payload.newPath, encoding);
  await client.rename(encodedOldPath, encodedNewPath);
  return true;
}

/**
 * Get file statistics
 */
async function statSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  const stat = await client.stat(encodedPath);
  return {
    name: path.basename(payload.path),
    type: stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file",
    size: stat.size,
    lastModified: stat.modifyTime,
    permissions: stat.mode ? (stat.mode & 0o777).toString(8) : undefined,
  };
}

/**
 * Change file permissions
 */
async function chmodSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  await client.chmod(encodedPath, parseInt(payload.mode, 8));
  return true;
}

/**
 * Register IPC handlers for SFTP operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:sftp:open", openSftp);
  ipcMain.handle("netcatty:sftp:list", listSftp);
  ipcMain.handle("netcatty:sftp:read", readSftp);
  ipcMain.handle("netcatty:sftp:readBinary", readSftpBinary);
  ipcMain.handle("netcatty:sftp:write", writeSftp);
  ipcMain.handle("netcatty:sftp:writeBinary", writeSftpBinary);
  ipcMain.handle("netcatty:sftp:writeBinaryWithProgress", writeSftpBinaryWithProgress);
  ipcMain.handle("netcatty:sftp:cancelUpload", cancelSftpUpload);
  ipcMain.handle("netcatty:sftp:close", closeSftp);
  ipcMain.handle("netcatty:sftp:mkdir", mkdirSftp);
  ipcMain.handle("netcatty:sftp:delete", deleteSftp);
  ipcMain.handle("netcatty:sftp:rename", renameSftp);
  ipcMain.handle("netcatty:sftp:stat", statSftp);
  ipcMain.handle("netcatty:sftp:chmod", chmodSftp);
}

/**
 * Get the SFTP clients map (for external access)
 */
function getSftpClients() {
  return sftpClients;
}

module.exports = {
  init,
  registerHandlers,
  getSftpClients,
  encodePathForSession,
  ensureRemoteDirForSession,
  openSftp,
  listSftp,
  readSftp,
  readSftpBinary,
  writeSftp,
  writeSftpBinary,
  writeSftpBinaryWithProgress,
  cancelSftpUpload,
  closeSftp,
  mkdirSftp,
  deleteSftp,
  renameSftp,
  statSftp,
  chmodSftp,
};
