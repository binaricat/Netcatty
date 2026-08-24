/* eslint-disable no-undef */
const { resolveSshConnectionTimeouts } = require("../sshBridge/startSession.cjs");
const { runWhenProxyConnectionReady } = require("../proxyUtils.cjs");
const { normalizeFileProtocol } = require("./scpShell.cjs");
const { getScpBackendForClient } = require("./scpBackend.cjs");
const {
  executeBoundedSshCommand,
  openBoundedSshExecStreamCallback,
  terminateSshExecStream,
} = require("../boundedSshExec.cjs");
const { openBoundedSftpChannel } = require("../boundedSftpOpen.cjs");
const { openBoundedForwardOutCallback } = require("../boundedSshChannelOpen.cjs");

/** Bound shell/scp probes so a hung remote exec cannot leave the panel connecting forever. */
const SCP_PROBE_TIMEOUT_MS = 15_000;

/**
 * AbortSignal that fires on parent abort or after timeoutMs.
 * Caller must dispose() to clear the timer.
 */
function createBoundedProbeSignal(parentSignal = null, timeoutMs = SCP_PROBE_TIMEOUT_MS) {
  const ac = new AbortController();
  let timedOut = false;
  let timer = null;
  const onParentAbort = () => {
    try { ac.abort(); } catch { /* ignore */ }
  };
  if (parentSignal?.aborted) {
    ac.abort();
  } else {
    if (parentSignal && typeof parentSignal.addEventListener === "function") {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { ac.abort(); } catch { /* ignore */ }
    }, Math.max(1, Number(timeoutMs) || SCP_PROBE_TIMEOUT_MS));
    if (typeof timer.unref === "function") timer.unref();
  }
  return {
    signal: ac.signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (parentSignal && typeof parentSignal.removeEventListener === "function") {
        try { parentSignal.removeEventListener("abort", onParentAbort); } catch { /* ignore */ }
      }
    },
  };
}

/** Return true when ssh2 reports an authentication-stage failure. */
function isSftpAuthError(err) {
  const level = String(err?.level || "").toLowerCase();
  const message = String(err?.message || "").toLowerCase();
  return level.includes("authentication") || message.includes("authentication");
}

/** Decide whether the SFTP target should retry with keyboard-interactive before password. */
function shouldRetrySftpKeyboardInteractiveFirst(options, authConfig, err) {
  return Boolean(
    options?.password &&
    !options?._skipPasswordMethod &&
    isSftpAuthError(err) &&
    authConfig?.authPhase?.retryKeyboardInteractiveFirst,
  );
}

function shouldRegisterFreshSftpTransport(options) {
  return options?.reuseTransport !== false && !options?.sudo;
}

function createOpenConnectionApi(ctx) {
  with (ctx) {
    /**
     * Mark a session client as SCP-mode and optionally probe shell access.
     */
    async function activateScpMode(client, { probe = true, signal = null, timeoutMs = SCP_PROBE_TIMEOUT_MS } = {}) {
      client.__netcattyFileProtocol = "scp";
      client.sftp = null;
      // Ensure closeSftp can tear down owned SSH sockets even when sftp is null.
      // Never end a shared terminal session socket.
      if (typeof client.end === "function" && !client.__netcattyScpEndWrapped) {
        const prevEnd = client.end.bind(client);
        client.end = async (...args) => {
          const ownsSocket = !client.__netcattySessionBacked
            && !client.__netcattySourceSessionId
            && !client.__netcattyTransportManaged;
          if (ownsSocket) {
            try { client.client?.end?.(); } catch { /* ignore */ }
            try { client.client?.destroy?.(); } catch { /* ignore */ }
          }
          return prevEnd(...args);
        };
        client.__netcattyScpEndWrapped = true;
      }
      if (probe) {
        const bounded = createBoundedProbeSignal(signal, timeoutMs);
        try {
          const backend = getScpBackendForClient(client);
          // Require a working shell AND scp binary — transfers need `scp -t/-f`.
          await backend.homeDir({ signal: bounded.signal }).catch(async () => {
            if (bounded.signal.aborted) throw new Error("SCP mode shell probe aborted");
            const adapters = require("./scpBackend.cjs").createSshExecAdapters(client.client);
            const pwd = await adapters.exec("pwd", { signal: bounded.signal });
            if (pwd.code !== 0 || !(pwd.stdout || "").trim()) {
              throw new Error("SCP mode shell probe failed");
            }
          });
          const adapters = require("./scpBackend.cjs").createSshExecAdapters(client.client);
          const scpProbe = await adapters.exec(
            "command -v scp >/dev/null 2>&1 || which scp >/dev/null 2>&1",
            { signal: bounded.signal },
          );
          if (scpProbe.code !== 0) {
            throw new Error("SCP binary not available on remote host (command -v scp failed)");
          }
        } catch (err) {
          if (bounded.timedOut && !signal?.aborted) {
            throw new Error(`SCP mode probe timed out after ${timeoutMs}ms`);
          }
          throw err;
        } finally {
          bounded.dispose();
        }
      }
      return client;
    }

    const hasUsableProxy = (proxy) => {
      if (!proxy) return false;
      if (proxy.type === "command") return !!proxy.command?.trim();
      return !!(proxy.host && proxy.port);
    };

    async function connectThroughChainForSftp(event, options, jumpHosts, targetHost, targetPort, connId) {
      const sender = event.sender;
      const connections = [];
      let currentSocket = null;
      let activeConn = null;
      const defaultAgentSocket = await getAvailableAgentSocket();
    
      const cleanupSocket = (socket) => {
        if (!socket) return;
        try { socket.end?.(); } catch { /* ignore */ }
        try { socket.destroy?.(); } catch { /* ignore */ }
      };
    
      try {
        // Connect through each jump host
        for (let i = 0; i < jumpHosts.length; i++) {
          const jump = jumpHosts[i];
          const isFirst = i === 0;
          const isLast = i === jumpHosts.length - 1;
          const hopLabel = jump.label || (jump.hostname.includes(':') && !jump.hostname.startsWith('[') ? `[${jump.hostname}]:${jump.port || 22}` : `${jump.hostname}:${jump.port || 22}`);
    
          console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: Connecting to ${hopLabel}...`);
          sendSftpProgress(sender, connId, hopLabel, 'connecting');
    
          const conn = new SSHClient();
          activeConn = conn;
          // Increase max listeners to prevent Node.js warning
          // Set to 0 (unlimited) since complex operations add many temp listeners
          conn.setMaxListeners(0);
    
          // Per-hop keepalive. The renderer's resolver returns either a positive
          // number (use it) or 0 (the host explicitly opted out, e.g. a router
          // whose SSH stack doesn't reply to keepalive@openssh.com). Only when
          // BOTH the per-hop and the target-call fields are undefined do we
          // fall back to 10s/3 — that path exists for older serializers that
          // pre-date per-host plumbing, preserving the #669 idle-NAT protection
          // for callers that haven't yet been updated.
          const hopInterval = jump.keepaliveInterval != null
            ? jump.keepaliveInterval
            : options.keepaliveInterval;
          const hopCountMax = jump.keepaliveCountMax != null
            ? jump.keepaliveCountMax
            : options.keepaliveCountMax;
          const hopIntervalMs = hopInterval == null
            ? 10000
            : (hopInterval > 0 ? hopInterval * 1000 : 0);
          const hopCountMaxEffective = hopInterval == null
            ? 3
            : (hopInterval > 0 ? (hopCountMax ?? 3) : 0);
          const hopConnectionTimeouts = resolveSshConnectionTimeouts(jump);
          // Build connection options
          const connOpts = {
            host: jump.hostname,
            port: jump.port || 22,
            username: jump.username || 'root',
            timeout: hopConnectionTimeouts.tcpConnectTimeoutMs,
            readyTimeout: 0,
            keepaliveInterval: hopIntervalMs,
            keepaliveCountMax: hopCountMaxEffective,
            // Enable keyboard-interactive authentication (required for 2FA/MFA)
            tryKeyboard: true,
            // Per-hop algorithm settings, mirroring sshBridge.cjs:
            //   - `legacyAlgorithms` falls back to the target's setting
            //     (append-only — safe to widen the hop's offer for chain
            //     convenience).
            //   - `skipEcdsaHostKey` and `algorithmOverrides` are strictly
            //     per-host. They *narrow* the offered list (drop ecdsa-* or
            //     replace a category), so propagating the leaf's setting
            //     would break an ECDSA-required or Ed25519-only bastion.
            algorithms: buildSftpAlgorithms(
              jump.legacyAlgorithms ?? options.legacyAlgorithms,
              {
                skipEcdsaHostKey: jump.skipEcdsaHostKey,
                algorithmOverrides: jump.algorithmOverrides,
              },
            ),
          };
          connOpts.hostVerifier = hostKeyVerifier.createHostVerifier({
            sender,
            sessionId: connId,
            hostname: jump.hostname,
            port: jump.port || 22,
            knownHosts: options.knownHosts,
            verifyHostKeys: jump.verifyHostKeys ?? options.verifyHostKeys,
          });
    
          // Auth - support agent (certificate), key, and password fallback
          const hasCertificate =
            typeof jump.certificate === "string" && jump.certificate.trim().length > 0;

          const systemAuthAgent = hasCertificate
            ? null
            : await prepareSystemSshAgentForAuth(jump, `[SFTP Chain] Hop ${i + 1}:`);
    
          const identityFile = !jump.privateKey && !systemAuthAgent
            ? await loadFirstIdentityFileForAuth({
              sender,
              identityFilePaths: jump.identityFilePaths,
              hostname: hopLabel,
              initialPassphrase: jump.passphrase,
              logPrefix: `[SFTP Chain] Hop ${i + 1}:`,
              onLoaded: (loaded) => {
                console.log(`[SFTP Chain] Hop ${i + 1}: loaded identity file ${loaded.keyPath}`);
              },
              onError: (err, keyPath) => {
                console.warn(`[SFTP Chain] Hop ${i + 1}: failed to read identity file ${keyPath}:`, err.message);
              },
            })
            : null;
          const inlineKey = jump.privateKey && !systemAuthAgent
            ? await preparePrivateKeyForAuth({
              sender,
              privateKey: jump.privateKey,
              keyId: jump.keyId,
              keyName: jump.keyId || jump.label || jump.username,
              hostname: hopLabel,
              initialPassphrase: jump.passphrase,
              logPrefix: `[SFTP Chain] Hop ${i + 1}:`,
            })
            : null;
          const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
          const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;
    
          let authAgent = null;
          if (systemAuthAgent) {
            connOpts.agent = systemAuthAgent;
          }
          if (hasCertificate) {
            authAgent = new NetcattyAgent({
              mode: "certificate",
              webContents: event.sender,
              meta: {
                label: jump.keyId || jump.username || "",
                certificate: jump.certificate,
                privateKey: effectivePrivateKey,
                passphrase: effectivePassphrase,
              },
            });
            connOpts.agent = authAgent;
          } else if (effectivePrivateKey) {
            connOpts.privateKey = effectivePrivateKey;
            if (effectivePassphrase) {
              connOpts.passphrase = effectivePassphrase;
            } else if (isKeyEncrypted(effectivePrivateKey)) {
              // Key is encrypted but no passphrase provided — prompt the user
              console.log(`[SFTP Chain] Hop ${i + 1}: key is encrypted, requesting passphrase`);
              const keyLabel = jump.label || hopLabel;
              const result = await passphraseHandler.requestPassphrase(
                sender,
                `SSH key for ${keyLabel}`,
                keyLabel,
                hopLabel
              );
              if (result?.passphrase) {
                connOpts.passphrase = result.passphrase;
              } else {
                delete connOpts.privateKey;
                if (result?.cancelled) {
                  throw new Error(`Passphrase entry cancelled for ${hopLabel}`);
                }
              }
            }
          }
    
          if (jump.password) connOpts.password = jump.password;
    
          // Get default keys (either from options if pre-fetched, or fetch them now)
          const defaultKeys = systemAuthAgent && jump.identitiesOnly
            ? []
            : options._defaultKeys || await findAllDefaultPrivateKeysFromHelper();
    
          // Build auth handler using shared helper
          // Pass unlocked encrypted keys from options so jump hosts can use them for retry
          const authConfig = buildAuthHandler({
            authMethod: jump.authMethod,
            requiresMfa: !!jump.requiresMfa,
            privateKey: connOpts.privateKey,
            password: connOpts.password,
            passphrase: connOpts.passphrase,
            agent: connOpts.agent,
            username: connOpts.username,
            logPrefix: `[SFTP Chain] Hop ${i + 1}`,
            unlockedEncryptedKeys: systemAuthAgent && jump.identitiesOnly
              ? []
              : options._unlockedEncryptedKeys || [],
            defaultKeys,
            sshAgentSocketOverride: defaultAgentSocket,
            allowAgentFallback: jump.useSshAgent !== false,
            onAuthAttempt: (method) => {
              sendSftpProgress(sender, connId, hopLabel, 'auth-attempt', method);
            },
          });
          applyAuthToConnOpts(connOpts, authConfig);
          const hopAuthPhase = authConfig.authPhase || { hadPartialSuccess: false };
    
          // If first hop and proxy is configured, connect through proxy
          const hasUsableJumpProxy = hasUsableProxy(jump.proxy);
          const effectiveHopProxy = isFirst ? ((hasUsableJumpProxy ? jump.proxy : null) || options.proxy) : null;
          if (effectiveHopProxy) {
            currentSocket = await createProxySocket(effectiveHopProxy, jump.hostname, jump.port || 22, {
              timeoutMs: hopConnectionTimeouts.tcpConnectTimeoutMs,
            });
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
            let settled = false;
            let authReadyTimer = null;
            const clearAuthReadyTimer = () => {
              if (!authReadyTimer) return;
              clearTimeout(authReadyTimer);
              authReadyTimer = null;
            };
            conn.once('connect', () => {
              runWhenProxyConnectionReady(conn._sock, () => {
                try { conn._sock?.setTimeout?.(0); } catch { /* ignore */ }
                clearAuthReadyTimer();
                authReadyTimer = setTimeout(
                  () => conn.emit('timeout'),
                  hopConnectionTimeouts.authReadyTimeoutMs,
                );
                authReadyTimer.unref?.();
              });
            });
            conn.once('handshake', () => {
              sendSftpProgress(sender, connId, hopLabel, 'authenticating');
            });
            conn.once('ready', () => {
              if (settled) return;
              settled = true;
              clearAuthReadyTimer();
              console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} connected`);
              sendSftpProgress(sender, connId, hopLabel, 'connected');
              resolve();
            });
            conn.on('error', (err) => {
              // Filter out non-fatal agent auth errors (same as in openSftp)
              if (err.level === 'agent') {
                console.log(`[SFTP Chain] Hop ${i + 1} non-fatal agent auth error (will try next method):`, err.message);
                return;
              }
              if (settled) return;
              settled = true;
              clearAuthReadyTimer();
              console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} error:`, err.message);
              sendSftpProgress(sender, connId, hopLabel, 'error', err.message);
              reject(err);
            });
            conn.once('timeout', () => {
              if (settled) return;
              settled = true;
              clearAuthReadyTimer();
              console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} timeout`);
              reject(new Error(`Connection timeout to ${hopLabel}`));
            });
            conn.once('close', () => {
              if (settled) return;
              settled = true;
              clearAuthReadyTimer();
              reject(new Error(`Connection closed before authentication completed for ${hopLabel}`));
            });
            let authBanner = "";
            conn.on('banner', (message) => {
              authBanner = String(message || "").trim();
            });
            // Handle keyboard-interactive authentication for jump hosts (2FA/MFA)
            const sftpChainKiHandler = createKeyboardInteractiveHandler({
              sender,
              sessionId: connId,
              hostId: jump.hostId,
              hostname: hopLabel,
              password: jump.password,
              logPrefix: `[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}`,
              scope: "external",
              getAuthBanner: () => authBanner,
              shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(hopAuthPhase),
            });
            conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
              if (prompts && prompts.length > 0) {
                sendSftpProgress(sender, connId, hopLabel, 'auth-attempt', 'waiting for user input...');
              }
              const wrappedFinish = (...args) => {
                sendSftpProgress(sender, connId, hopLabel, 'auth-attempt', 'user responded');
                finish(...args);
              };
              sftpChainKiHandler(name, instructions, lang, prompts, wrappedFinish);
            });
            conn.connect(connOpts);
          });
    
          connections.push(conn);
          activeConn = null;
    
          // Determine next target
          let nextHost, nextPort, nextConnectionTimeouts;
          if (isLast) {
            // Last jump host, forward to final target
            nextHost = targetHost;
            nextPort = targetPort;
            nextConnectionTimeouts = resolveSshConnectionTimeouts(options);
          } else {
            // Forward to next jump host
            const nextJump = jumpHosts[i + 1];
            nextHost = nextJump.hostname;
            nextPort = nextJump.port || 22;
            nextConnectionTimeouts = resolveSshConnectionTimeouts(nextJump);
          }
    
          // Create forward stream to next hop
          console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: Forwarding to ${nextHost}:${nextPort}...`);
          currentSocket = await new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
              if (settled) return;
              settled = true;
              reject(new Error(`Connection timeout to ${nextHost}:${nextPort}`));
            }, nextConnectionTimeouts.tcpConnectTimeoutMs);
            timeout.unref?.();
            openBoundedForwardOutCallback(conn, '127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
              if (settled) {
                try { stream?.end?.(); } catch { /* ignore */ }
                return;
              }
              settled = true;
              clearTimeout(timeout);
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
        if (activeConn && !connections.includes(activeConn)) {
          try { activeConn.end(); } catch (cleanupErr) { console.warn('[SFTP Chain] Cleanup error:', cleanupErr.message); }
        }
        cleanupSocket(currentSocket);
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
          const result = await executeBoundedSshCommand(client, `test -x ${p}`, {
            openingTimeoutMs: SCP_PROBE_TIMEOUT_MS,
            runTimeoutMs: SCP_PROBE_TIMEOUT_MS,
            maxOutputBytes: 16 * 1024,
          });
          if (result.code !== 0) throw new Error('Not found');
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
        openBoundedSshExecStreamCallback(client, cmd, { pty: false }, (err, stream) => {
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
          let initDelayId = null;
          const timeoutMs = 20000;
          const timeoutId = setTimeout(() => {
            if (sftpInitialized || settled) return;
            settled = true;
            stream.stderr?.removeListener('data', onStderr);
            stream.removeListener('data', onStdout);
            if (initDelayId) clearTimeout(initDelayId);
            terminateSshExecStream(stream);
            const error = new Error("SFTP sudo handshake timed out. This may happen if: (1) the password is incorrect, (2) sudo requires a TTY, or (3) the user does not have sudo privileges.");
            reject(error);
          }, timeoutMs);
          timeoutId.unref?.();
    
          const finalize = (err, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            if (initDelayId) clearTimeout(initDelayId);
            initDelayId = null;
            stream.stderr?.removeListener('data', onStderr);
            stream.removeListener('data', onStdout);
            if (err) {
              terminateSshExecStream(stream);
              reject(err);
            }
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
              initDelayId = setTimeout(() => {
                initDelayId = null;
                initSftp();
              }, 1000);
              initDelayId.unref?.();
            } else if (stdoutBuffer.length > 256) {
              stdoutBuffer = stdoutBuffer.subarray(stdoutBuffer.length - 256);
            }
          };
    
          const onStderr = (data) => {
            const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
            const chunk = raw.subarray(Math.max(0, raw.length - 1024)).toString();
            // Only log that we received stderr data, not the content (may contain sensitive prompts)
            stderrBuffer = (stderrBuffer + chunk).slice(-1024);
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
            } else if (stderrBuffer.length > 256) stderrBuffer = stderrBuffer.slice(-256);
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
          stream.on('error', (error) => {
            if (!sftpInitialized) finalize(error);
          });
          stream.on('close', () => {
            if (!sftpInitialized) finalize(new Error("SFTP sudo stream closed before protocol initialization"));
          });
          stream.on('end', () => {
            if (!sftpInitialized) finalize(new Error("SFTP sudo stream ended before protocol initialization"));
          });
          }, { openingTimeoutMs: 20_000 });
      });
    }
    
    /**
     * Open a new SFTP connection
     * Supports jump host connections when options.jumpHosts is provided
     */
    async function openSftp(event, options) {
      const connId = options.sessionId || randomUUID();
      const reuseEndpoint = buildConnectionReuseEndpoint(options, {
        sftpSudo: Boolean(options.sudo),
      });
      let pendingDialCoordination = options._pendingDialCoordination || null;

      const openOnSharedTransport = async (transport, detail = "reusing shared SSH transport") => {
        const refHolder = {
          id: connId,
          __sshLeaseKind: "sftp",
          webContentsId: event.sender?.id,
        };
        acquireConnectionRef?.(refHolder, transport);
        const reusedClient = createSessionBackedSftpClient(connId, transport.conn, {
          refHolder,
          sourceSessionId: options.sourceSessionId || null,
        });
        reusedClient.__netcattyEndpointKey = transport.endpointKey || buildEndpointKey(reuseEndpoint);
        reusedClient.__netcattyTransportManaged = true;
        const fileProtocol = normalizeFileProtocol(options.fileProtocol);
        try {
          sendSftpProgress(event.sender, connId, options.hostname, "connecting", detail);
          if (fileProtocol === "scp") {
            await activateScpMode(reusedClient);
            reusedClient.__netcattySudoMode = false;
            sftpClients.set(connId, reusedClient);
            sendSftpProgress(event.sender, connId, options.hostname, "connected", `${detail} (SCP mode)`);
            return { sftpId: connId, fileProtocol: "scp" };
          }
          try {
            await requireSftpChannel(reusedClient);
            reusedClient.__netcattyFileProtocol = "sftp";
            reusedClient.__netcattySudoMode = false;
            sftpClients.set(connId, reusedClient);
            sendSftpProgress(event.sender, connId, options.hostname, "connected", detail);
            return { sftpId: connId, fileProtocol: "sftp" };
          } catch (sftpErr) {
            if (fileProtocol === "sftp") throw sftpErr;
            await activateScpMode(reusedClient);
            reusedClient.__netcattySudoMode = false;
            sftpClients.set(connId, reusedClient);
            sendSftpProgress(event.sender, connId, options.hostname, "connected", `${detail} (SCP mode)`);
            return { sftpId: connId, fileProtocol: "scp" };
          }
        } catch (err) {
          try { await reusedClient.end(); } catch { /* ignore */ }
          throw err;
        }
      };

      // Parked / shared transport without a live terminal session: open an SFTP
      // channel on the registry transport (no second MFA).
      // Dedicated bulk transfer / restart-resume passes reuseTransport:false so
      // a transfer never silently attaches to a terminal/parked conn.
      if (
        !pendingDialCoordination
        && options.reuseTransport !== false
        && !options.sudo
        && typeof findTransportByEndpoint === "function"
        && typeof createSessionBackedSftpClient === "function"
      ) {
        const transport = findTransportByEndpoint(reuseEndpoint);
        if (transport?.conn) {
          try {
            return await openOnSharedTransport(transport, "reused parked transport");
          } catch (parkErr) {
            console.warn(
              `[SFTP] Parked transport reuse failed for ${connId}; connecting fresh:`,
              parkErr?.message || String(parkErr),
            );
          }
        }
      }

      if (
        !pendingDialCoordination
        && options.reuseTransport !== false
        && !options.sudo
        && typeof beginTransportDial === "function"
      ) {
        const coordination = beginTransportDial(reuseEndpoint, { kind: "channel" });
        if (coordination.role === "reuse" || coordination.role === "join") {
          try {
            const transport = coordination.role === "reuse"
              ? coordination.transport
              : await waitForTransportDial(coordination);
            return await openOnSharedTransport(transport, "reused coordinated transport");
          } catch (coordinationErr) {
            if (coordination.role === "join") throw coordinationErr;
            console.warn(
              `[SFTP] Coordinated transport reuse failed for ${connId}; connecting fresh:`,
              coordinationErr?.message || String(coordinationErr),
            );
          }
        } else {
          pendingDialCoordination = coordination;
        }
      }

      try {
        return await openFreshSftp();
      } catch (err) {
        if (pendingDialCoordination) failTransportDial(pendingDialCoordination, err);
        throw err;
      }

      async function openFreshSftp() {
      const client = new SftpClient();
      client.__netcattyEndpointKey = buildEndpointKey(reuseEndpoint);
      let freshClientClosed = false;
      const closeFreshClient = () => {
        if (freshClientClosed) return;
        freshClientClosed = true;
        // A failure after SSH authentication but before registration in
        // sftpClients/the transport pool otherwise leaves an unreachable live
        // socket. This is deliberately low-level: there may be no SFTP channel
        // for ssh2-sftp-client.end() to close yet.
        try { client.client?.end?.(); } catch { /* ignore */ }
        try { client.client?.destroy?.(); } catch { /* ignore */ }
      };
    
      // Get default keys early to use for both chain and target
      const defaultKeys = await findAllDefaultPrivateKeysFromHelper();
    
      // Check if we need to connect through jump hosts
      const jumpHosts = options.jumpHosts || [];
      const hasJumpHosts = jumpHosts.length > 0;
      const hasProxy = hasUsableProxy(options.proxy);
      const targetConnectionTimeouts = resolveSshConnectionTimeouts(options);
    
      let chainConnections = [];
      let connectionSocket = null;
      const cleanupPendingConnection = () => {
        for (const conn of chainConnections) {
          try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP] Cleanup error on connect failure:', cleanupErr.message); }
        }
        if (connectionSocket) {
          try { connectionSocket.end?.(); } catch { /* ignore */ }
          try { connectionSocket.destroy?.(); } catch { /* ignore */ }
        }
      };
    
      // Pre-fetch agent socket (async check for Windows SSH Agent service)
      // This is used by both jump host chain auth and final host auth
      const agentSocket = await getAvailableAgentSocket(options.identityAgent);
    
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
          options.port || 22,
          { timeoutMs: targetConnectionTimeouts.tcpConnectTimeoutMs },
        );
      }
    
      const keepalivePolicy = resolveConnectionKeepalivePolicy(options);
      const connectOpts = {
        host: options.hostname,
        port: options.port || 22,
        username: options.username || "root",
        // Enable keyboard-interactive authentication (required for 2FA/MFA)
        tryKeyboard: true,
        timeout: targetConnectionTimeouts.tcpConnectTimeoutMs,
        readyTimeout: 0,
        // Keepalive policy:
        //   - positive value: honor it (in seconds, convert to ms)
        //   - explicit 0: truly disabled (host opted out via per-host override —
        //     critical for routers/switches that don't reply to keepalive
        //     @openssh.com and would otherwise be killed by ssh2 after countMax
        //     unanswered probes)
        //   - undefined: legacy caller path, fall back to 10s/3 so an idle SFTP
        //     browse over a NAT doesn't drop (the original #669 protection)
        keepaliveInterval: keepalivePolicy.keepaliveIntervalMs,
        keepaliveCountMax: keepalivePolicy.keepaliveCountMax,
        algorithms: buildSftpAlgorithms(options.legacyAlgorithms, {
          skipEcdsaHostKey: options.skipEcdsaHostKey,
          algorithmOverrides: options.algorithmOverrides,
        }),
      };
      connectOpts.hostVerifier = hostKeyVerifier.createHostVerifier({
        sender: event.sender,
        sessionId: connId,
        hostId: options.hostId,
        hostname: options.hostname,
        port: options.port || 22,
        knownHosts: options.knownHosts,
        verifyHostKeys: options.verifyHostKeys,
      });
    
      // Use the tunneled socket if we have one
      if (connectionSocket) {
        connectOpts.sock = connectionSocket;
        // When using sock, we should not set host/port as the connection is already established
        delete connectOpts.host;
        delete connectOpts.port;
      }
    
      const hasCertificate = typeof options.certificate === "string" && options.certificate.trim().length > 0;
    
      let identityFile = null;
      let inlineKey = null;
      let systemAuthAgent = null;
      try {
        systemAuthAgent = hasCertificate
          ? null
          : await prepareSystemSshAgentForAuth(options, "[SFTP]");
        identityFile = !options.privateKey && !systemAuthAgent
          ? await loadFirstIdentityFileForAuth({
            sender: event.sender,
            identityFilePaths: options.identityFilePaths,
            hostname: options.hostname,
            initialPassphrase: options.passphrase,
            logPrefix: "[SFTP]",
            onLoaded: (loaded) => {
              console.log(`[SFTP] Loaded identity file ${loaded.keyPath}`);
            },
            onError: (err, keyPath) => {
              console.warn(`[SFTP] Failed to read identity file ${keyPath}:`, err.message);
            },
          })
          : null;
        inlineKey = options.privateKey && !systemAuthAgent
          ? await preparePrivateKeyForAuth({
            sender: event.sender,
            privateKey: options.privateKey,
            keyId: options.keyId,
            keyName: options.keyId || options.username,
            hostname: options.hostname,
            initialPassphrase: options.passphrase,
            logPrefix: "[SFTP]",
          })
          : null;
      } catch (err) {
        cleanupPendingConnection();
        throw err;
      }
      const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
      const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;
    
      let authAgent = null;
      if (systemAuthAgent) {
        connectOpts.agent = systemAuthAgent;
      }
      if (hasCertificate) {
        authAgent = new NetcattyAgent({
          mode: "certificate",
          webContents: event.sender,
          meta: {
            label: options.keyId || options.username || "",
            certificate: options.certificate,
            privateKey: effectivePrivateKey,
            passphrase: effectivePassphrase,
          },
        });
        connectOpts.agent = authAgent;
      } else if (effectivePrivateKey) {
        connectOpts.privateKey = effectivePrivateKey;
        if (effectivePassphrase) {
          connectOpts.passphrase = effectivePassphrase;
        } else if (isKeyEncrypted(effectivePrivateKey)) {
          // Key is encrypted but no passphrase provided — prompt the user
          console.log(`[SFTP] Key is encrypted, requesting passphrase for ${options.hostname}`);
          const result = await passphraseHandler.requestPassphrase(
            event.sender,
            `SSH key for ${options.hostname}`,
            options.hostname,
            options.hostname
          );
          if (result?.passphrase) {
            connectOpts.passphrase = result.passphrase;
          } else {
            delete connectOpts.privateKey;
            if (result?.cancelled) {
              // Clean up any chain/proxy connections and proxy socket opened earlier
              for (const c of chainConnections) {
                try { c.end(); } catch {}
              }
              if (connectionSocket) {
                try { connectionSocket.destroy(); } catch {}
              }
              // Use "authentication" in the message so the SFTP frontend's
              // isAuthError() check recognizes this and falls back to password.
              const err = new Error(`Authentication cancelled — passphrase not provided for ${options.hostname}`);
              err.level = 'client-authentication';
              throw err;
            }
          }
        }
      }
    
      if (options.password) connectOpts.password = options.password;
    
      // Build auth handler using shared helper
      // Use pre-fetched agentSocket (validated async, including Windows service check)
      const authConfig = buildAuthHandler({
        authMethod: options.authMethod,
        requiresMfa: !!options.requiresMfa,
        privateKey: connectOpts.privateKey,
        password: connectOpts.password,
        passphrase: connectOpts.passphrase,
        agent: connectOpts.agent,
        username: connectOpts.username,
        logPrefix: "[SFTP]",
        skipPasswordMethod: options._skipPasswordMethod === true,
        defaultKeys: systemAuthAgent && options.identitiesOnly ? [] : defaultKeys,
        sshAgentSocketOverride: agentSocket,
        allowAgentFallback: options.useSshAgent !== false,
        onAuthAttempt: (method) => {
          sendSftpProgress(event.sender, connId, options.hostname, 'auth-attempt', method);
        },
      });
      applyAuthToConnOpts(connectOpts, authConfig);
      const sftpAuthPhase = authConfig.authPhase || { hadPartialSuccess: false };
      let authBanner = "";
    
      // Create keyboard-interactive handler using shared helper
      const kiHandler = createKeyboardInteractiveHandler({
        sender: event.sender,
        sessionId: connId,
        hostId: options.hostId,
        hostname: options.hostname,
        password: options.password,
        logPrefix: "[SFTP]",
        scope: "external",
        getAuthBanner: () => authBanner,
        shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(sftpAuthPhase),
      });
    
      // Add keyboard-interactive listener BEFORE connecting
      // Wrap to emit progress events for the SFTP connection log
      client.on("banner", (message) => {
        authBanner = String(message || "").trim();
      });
      client.on("keyboard-interactive", (name, instructions, lang, prompts, finish) => {
        if (prompts && prompts.length > 0) {
          sendSftpProgress(event.sender, connId, options.hostname, 'auth-attempt', 'waiting for user input...');
        }
        const wrappedFinish = (...args) => {
          sendSftpProgress(event.sender, connId, options.hostname, 'auth-attempt', 'user responded');
          finish(...args);
        };
        kiHandler(name, instructions, lang, prompts, wrappedFinish);
      });
    
      try {
        // IMPORTANT: We bypass ssh2-sftp-client's connect() method and use the
        // underlying ssh2 Client directly. This is because ssh2-sftp-client adds
        // temporary error listeners that reject the entire connect promise on ANY
        // error, including non-fatal auth errors (e.g. 'Failed to connect to agent'
        // when ssh2 tries agent auth and falls through to the next method).
        // By connecting directly, we can filter these non-fatal errors and allow
        // the auth flow to continue to keyboard-interactive/password/etc.
        const sshClient = client.client;
    
        await new Promise((resolve, reject) => {
          let settled = false;
          let authReadyTimer = null;
          const clearAuthReadyTimer = () => {
            if (!authReadyTimer) return;
            clearTimeout(authReadyTimer);
            authReadyTimer = null;
          };
          const settle = (fn, val) => {
            if (settled) return;
            settled = true;
            clearAuthReadyTimer();
            cleanup();
            fn(val);
          };
    
          const onError = (err) => {
            // Filter out non-fatal authentication errors.
            // ssh2 sets err.level = 'agent' when agent auth fails — it then
            // internally calls tryNextAuth() to proceed with the next method.
            // We must NOT reject here, or the fallback won't execute.
            if (err.level === 'agent') {
              console.log('[SFTP] Non-fatal agent auth error (will try next method):', err.message);
              return;
            }
            settle(reject, err);
          };
    
          const onEnd = () => {
            settle(reject, new Error('Connection closed before SFTP session was ready'));
          };
    
          const onClose = () => {
            settle(reject, new Error('Connection closed before SFTP session was ready'));
          };
    
          const cleanup = () => {
            sshClient.removeListener('error', onError);
            sshClient.removeListener('end', onEnd);
            sshClient.removeListener('close', onClose);
            sshClient.removeListener('timeout', onTimeout);
            // Keep a catch-all error listener so post-ready errors (e.g. connection
            // drops during an active SFTP session) don't become uncaught exceptions.
            sshClient.on('error', (err) => {
              console.error(`[SFTP] Post-ready SSH error for ${connId}:`, err.message);
            });
          };
    
          sshClient.on('error', onError);
          sshClient.on('end', onEnd);
          sshClient.on('close', onClose);
          const onTimeout = () => {
            settle(reject, new Error(`Connection timeout to ${options.hostname}`));
            try { sshClient.end?.(); } catch { /* ignore */ }
            try { sshClient.destroy?.(); } catch { /* ignore */ }
          };
          sshClient.on('timeout', onTimeout);
          sshClient.once('connect', () => {
            runWhenProxyConnectionReady(sshClient._sock, () => {
              try { sshClient._sock?.setTimeout?.(0); } catch { /* ignore */ }
              clearAuthReadyTimer();
              authReadyTimer = setTimeout(
                () => sshClient.emit('timeout'),
                targetConnectionTimeouts.authReadyTimeoutMs,
              );
              authReadyTimer.unref?.();
            });
          });
    
          sshClient.once('handshake', () => {
            sendSftpProgress(event.sender, connId, options.hostname, 'authenticating');
          });
    
          sshClient.once('ready', () => {
            clearAuthReadyTimer();
            cleanup();
            sendSftpProgress(event.sender, connId, options.hostname, 'connected');

            const fileProtocol = normalizeFileProtocol(options.fileProtocol);

            const finishSftp = (sftp) => {
              client.sftp = sftp;
              client.__netcattyFileProtocol = "sftp";
              resolve();
            };

            const finishScp = async (reason) => {
              try {
                if (reason) {
                  console.warn(`[SFTP] ${reason}; activating SCP mode for ${connId}`);
                }
                await activateScpMode(client);
                resolve();
              } catch (scpErr) {
                closeFreshClient();
                reject(scpErr);
              }
            };

            if (fileProtocol === "scp") {
              if (options.sudo) {
                // Forced SCP cannot provide sudo elevation; reject contradictory host data.
                closeFreshClient();
                reject(new Error(
                  "Sudo Mode is not supported with File Protocol set to SCP. Disable Sudo Mode or use Auto/SFTP.",
                ));
                return;
              }
              console.log(`[SFTP] Forced SCP mode for connection: ${connId}`);
              void finishScp(null);
              return;
            }

            // When the host asks for sudo SFTP, never silently fall through to
            // unprivileged SCP on Auto — that would look "connected" without elevation.
            if (options.sudo) {
              console.log(`[SFTP] Using sudo mode for connection: ${connId}`);
              (async () => {
                try {
                  const sudoPass = options.password || "";
                  const sftpWrapper = await connectSudoSftp(sshClient, sudoPass);
                  sftpWrapper.on('close', () => client.end());
                  finishSftp(sftpWrapper);
                } catch (e) {
                  // Fallback: if sftp-server binary is missing (exit code 127),
                  // try standard SFTP subsystem instead of failing completely.
                  // This handles systems like ESXi that don't have sftp-server
                  // but support the SFTP subsystem natively.
                  if (e.message && e.message.includes('exit code 127')) {
                    console.warn('[SFTP] sftp-server not found, falling back to standard SFTP subsystem');
                    options.sudo = false; // Mark as non-sudo for downstream logic
                    openBoundedSftpChannel(sshClient).then((sftp) => {
                      finishSftp(sftp);
                    }).catch((sftpErr) => {
                        // Do not drop to SCP after a sudo-mode open: elevation was requested.
                        closeFreshClient();
                        reject(sftpErr);
                    });
                  } else {
                    closeFreshClient();
                    reject(e);
                  }
                }
              })();
            } else {
              // Open standard SFTP subsystem channel
              openBoundedSftpChannel(sshClient).then((sftp) => {
                finishSftp(sftp);
              }).catch((err) => {
                  if (fileProtocol === "auto") {
                    void finishScp(`SFTP subsystem unavailable (${err.message})`);
                    return;
                  }
                  reject(err);
              });
            }
          });
    
          sendSftpProgress(event.sender, connId, options.hostname, 'connecting');
          try {
            sshClient.connect(connectOpts);
          } catch (e) {
            settle(reject, e);
          }
        });
        // Increase max listeners AFTER connect, when the internal ssh2 Client exists
        // This prevents Node.js MaxListenersExceededWarning when performing many operations
        // ssh2-sftp-client adds temporary listeners for each operation, so we need a high limit
        if (client.client && typeof client.client.setMaxListeners === 'function') {
          client.client.setMaxListeners(0); // 0 means unlimited
        }
    
        // Used by transferBridge to decide whether isolated fast-transfer channels are safe.
        client.__netcattySudoMode = !!options.sudo && client.__netcattyFileProtocol !== "scp";
        if (!client.__netcattyFileProtocol) {
          client.__netcattyFileProtocol = "sftp";
        }

        // Register dedicated dials in the shared SSH transport registry so
        // later terminal/SFTP/transfer/port-forward work can borrow without MFA.
        const sshConn = client.client;
        if (
          sshConn
          && shouldRegisterFreshSftpTransport(options)
          && typeof createTransport === "function"
          && typeof borrowTransport === "function"
        ) {
          try {
            const refHolder = {
              id: connId,
              __sshLeaseKind: "sftp",
              webContentsId: event.sender?.id,
            };
            const transport = createTransport({
              conn: sshConn,
              chainConnections,
              endpoint: reuseEndpoint,
            });
            borrowTransport(transport, {
              kind: "sftp",
              holder: refHolder,
              leaseId: `sftp:${connId}`,
              meta: { source: "openSftp-dedicated" },
            });
            client.__netcattyRefHolder = refHolder;
            client.__netcattyTransportManaged = true;
            if (pendingDialCoordination) {
              completeTransportDial(pendingDialCoordination, transport);
            }
            // Chain lifetime is owned by the transport; do not double-end on close.
            chainConnections = [];
          } catch (regErr) {
            if (pendingDialCoordination) {
              failTransportDial(pendingDialCoordination, regErr);
            }
            console.warn(
              `[SFTP] Failed to register dedicated transport for ${connId}:`,
              regErr?.message || String(regErr),
            );
          }
        }

        sftpClients.set(connId, client);
    
        // Store jump connections for cleanup when SFTP is closed (legacy path
        // only — transport-managed connections park chain on the registry).
        if (chainConnections.length > 0 && !client.__netcattyTransportManaged) {
          jumpConnectionsMap.set(connId, {
            connections: chainConnections,
            socket: connectionSocket
          });
        }
    
        console.log(`[SFTP] Connection established: ${connId} (protocol=${client.__netcattyFileProtocol})`);
        return { sftpId: connId, fileProtocol: client.__netcattyFileProtocol };
      } catch (err) {
        // Cleanup jump connections on error
        cleanupPendingConnection();
        closeFreshClient();
        if (shouldRetrySftpKeyboardInteractiveFirst(options, authConfig, err)) {
          console.log("[SFTP] Password auth removed keyboard-interactive; retrying with keyboard-interactive first...");
          return openSftp(event, {
            ...options,
            _skipPasswordMethod: true,
            _pendingDialCoordination: pendingDialCoordination,
          });
        }
        if (pendingDialCoordination) failTransportDial(pendingDialCoordination, err);
        throw err;
      }
      }
    }
    return { connectThroughChainForSftp, connectSudoSftp, openSftp };
  }
}

module.exports = {
  createOpenConnectionApi,
  createBoundedProbeSignal,
  shouldRegisterFreshSftpTransport,
  SCP_PROBE_TIMEOUT_MS,
};
