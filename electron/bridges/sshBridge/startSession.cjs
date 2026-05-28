/* eslint-disable no-undef */
function createStartSessionApi(ctx) {
  with (ctx) {
    async function startSSHSession(event, options) {
      const sessionId = options.sessionId || randomUUID();
    
      const cols = options.cols || 80;
      const rows = options.rows || 24;
      const sender = event.sender;
    
      const sendProgress = (hop, total, label, status, error) => {
        if (!sender.isDestroyed()) {
          sender.send("netcatty:chain:progress", { sessionId, hop, total, label, status, error });
        }
      };
    
      try {
        const conn = new SSHClient();
        let chainConnections = [];
        let connectionSocket = null;
        // Token returned by sessionLogStreamManager.startStream when (and if)
        // a real-time log stream is opened. Captured here so every close /
        // error / timeout handler below can pass it back to stopStream and
        // avoid tearing down a stream that a subsequent reconnect on the same
        // sessionId may have already started (issue #916).
        let logStreamToken = null;
    
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
          readyTimeout: 20000, // Fast failure for non-interactive auth
          // Resolved keepalive (caller decides whether host override or global
          // applies). interval is in seconds; 0 means truly disabled, so
          // countMax also goes to 0 to skip ssh2's dead-connection check.
          keepaliveInterval: options.keepaliveInterval > 0 ? options.keepaliveInterval * 1000 : 0,
          keepaliveCountMax: options.keepaliveInterval > 0 ? (options.keepaliveCountMax ?? 10) : 0,
          // Enable keyboard-interactive authentication (required for 2FA/MFA)
          tryKeyboard: true,
          algorithms: buildAlgorithms(options.legacyAlgorithms, {
            skipEcdsaHostKey: options.skipEcdsaHostKey,
            algorithmOverrides: options.algorithmOverrides,
          }),
        };
        attachSshDebugLogger(connectOpts);
        logSshAlgorithms("Target host", connectOpts.algorithms, {
          hostname: options.hostname,
          port: options.port || 22,
          legacyAlgorithms: !!options.legacyAlgorithms,
          skipEcdsaHostKey: !!options.skipEcdsaHostKey,
          hasAlgorithmOverrides: !!options.algorithmOverrides,
        });
    
        connectOpts.hostVerifier = hostKeyVerifier.createHostVerifier({
          sender,
          sessionId,
          hostname: options.hostname,
          port: options.port || 22,
          knownHosts: options.knownHosts,
        });
    
        // Authentication for final target
        const hasCertificate = typeof options.certificate === "string" && options.certificate.trim().length > 0;
        const effectivePassphrase = options.passphrase;
    
        console.log("[SSH] Auth configuration:", {
          hasCertificate,
          keySource: options.keySource,
          hasPublicKey: !!options.publicKey,
          hasPrivateKey: !!options.privateKey,
          hasPassword: !!options.password,
          hasEffectivePassphrase: !!effectivePassphrase,
        });
    
        log("Auth configuration", {
          hasCertificate,
          keySource: options.keySource,
          hasPublicKey: !!options.publicKey,
          hasPrivateKey: !!options.privateKey,
        });
    
        let authAgent = null;
        const identityFile = !options.privateKey
          ? await loadFirstIdentityFileForAuth({
            sender,
            identityFilePaths: options.identityFilePaths,
            hostname: options.hostname,
            initialPassphrase: options.passphrase,
            logPrefix: "[SSH]",
            onLoaded: (loaded) => {
              log("Loaded identity file", { keyPath: loaded.keyPath, encrypted: !!loaded.passphrase });
            },
            onError: (err, keyPath) => {
              log("Failed to read identity file", { keyPath, error: err.message });
            },
          })
          : null;
        const inlineKey = options.privateKey
          ? await preparePrivateKeyForAuth({
            sender,
            privateKey: options.privateKey,
            keyId: options.keyId,
            keyName: options.keyId || options.username,
            hostname: options.hostname,
            initialPassphrase: effectivePassphrase,
            logPrefix: "[SSH]",
          })
          : null;
        const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
        const effectiveIdentityPassphrase = inlineKey?.passphrase || identityFile?.passphrase;
    
        if (hasCertificate) {
          authAgent = new NetcattyAgent({
            mode: "certificate",
            webContents: event.sender,
            meta: {
              label: options.keyId || options.username || "",
              certificate: options.certificate,
              privateKey: effectivePrivateKey,
              passphrase: effectiveIdentityPassphrase,
            },
          });
          connectOpts.agent = authAgent;
        } else if (effectivePrivateKey) {
          connectOpts.privateKey = effectivePrivateKey;
          if (effectiveIdentityPassphrase) {
            connectOpts.passphrase = effectiveIdentityPassphrase;
          }
        }
    
        if (options.password && typeof options.password === "string" && options.password.trim().length > 0) {
          connectOpts.password = options.password;
        }
    
        // Always try to find default SSH keys for fallback authentication
        // This allows fallback even when password auth fails
        let defaultKeyInfo = null;
        let allDefaultKeys = [];
        let usedDefaultKeyAsPrimary = false;
        const defaultKey = await findDefaultPrivateKey();
        if (defaultKey) {
          defaultKeyInfo = defaultKey;
          log("Found default SSH key for fallback", { keyPath: defaultKey.keyPath, keyName: defaultKey.keyName });
        }
        // Also find ALL default keys for comprehensive fallback
        allDefaultKeys = await findAllDefaultPrivateKeys();
    
        // Use unlocked encrypted keys if provided (from retry after auth failure)
        // These are passed via _unlockedEncryptedKeys from startSSHSessionWrapper
        const unlockedEncryptedKeys = options._unlockedEncryptedKeys || [];
        if (unlockedEncryptedKeys.length > 0) {
          log("Using unlocked encrypted keys from retry", {
            count: unlockedEncryptedKeys.length,
            keyNames: unlockedEncryptedKeys.map(k => k.keyName)
          });
        }
    
        // If no primary auth method configured, try ssh-agent first, then ALL default keys
        if (!connectOpts.privateKey && !connectOpts.password && !connectOpts.agent) {
          // First, try to use ssh-agent if available (this is what regular SSH does)
          const sshAgentSocket = await getAvailableAgentSocket();
    
          if (sshAgentSocket) {
            log("No auth method configured, trying ssh-agent first", { agentSocket: sshAgentSocket });
            connectOpts.agent = sshAgentSocket;
          }
    
          // Mark that we need to try all default keys (handled in authMethods below)
          if (allDefaultKeys.length > 0) {
            log("Will try all default SSH keys as fallback", { count: allDefaultKeys.length, keyNames: allDefaultKeys.map(k => k.keyName) });
            // Set first key for connectOpts.privateKey (required for ssh2 to allow publickey auth)
            connectOpts.privateKey = allDefaultKeys[0].privateKey;
            usedDefaultKeyAsPrimary = true;
          } else {
            log("No default SSH key found in ~/.ssh directory");
          }
        }
    
        log("Final auth configuration", {
          hasPrivateKey: !!connectOpts.privateKey,
          hasPassword: !!connectOpts.password,
          hasAgent: !!connectOpts.agent,
          hasDefaultKeyFallback: !!defaultKeyInfo,
        });
    
        // Agent forwarding
        if (options.agentForwarding) {
          if (!connectOpts.agent) {
            connectOpts.agent = await getAvailableAgentSocket();
          }
          // Only enable forwarding when an agent is actually available
          if (connectOpts.agent) {
            connectOpts.agentForward = true;
          } else {
            log("Agent forwarding requested but no agent available, skipping");
          }
        }
    
        // Build authentication handler with fallback support
        // ssh2 authHandler can be a function that returns the next auth method to try
    
        // Check if we have a cached successful auth method for this host
        const cachedMethod = getCachedAuthMethod(connectOpts.username, options.hostname, options.port);
    
        // Track which method succeeded for caching
        let lastTriedMethod = null;
    
        if (authAgent) {
          const order = ["none", "agent"];
          if (connectOpts.password) order.push("password");
          // Add default key fallback if available and no user key configured
          // Must also set connectOpts.privateKey for ssh2 to actually try publickey auth
          if (defaultKeyInfo && !options.privateKey) {
            connectOpts.privateKey = defaultKeyInfo.privateKey;
            order.push("publickey");
          }
          order.push("keyboard-interactive");
          connectOpts.authHandler = order;
          log("Auth order (agent mode)", { order });
        } else {
          // Build dynamic auth handler for fallback support
          const authMethods = [];
    
          // First try user-configured key if available (explicit user choice)
          if (connectOpts.privateKey && !usedDefaultKeyAsPrimary) {
            authMethods.push({ type: "publickey", key: connectOpts.privateKey, passphrase: connectOpts.passphrase, id: "publickey-user" });
          }
    
          // Then try agent if configured (try agent before password since it's usually faster)
          if (connectOpts.agent) {
            authMethods.push({ type: "agent", id: "agent" });
          }
    
          // Then try password if available (explicit user choice)
          if (connectOpts.password) {
            authMethods.push({ type: "password", id: "password" });
          }
    
          // Then try ALL default SSH keys as fallback (not just the first one!)
          // This is critical because different servers may have different keys in authorized_keys
          if (usedDefaultKeyAsPrimary && allDefaultKeys.length > 0) {
            for (const keyInfo of allDefaultKeys) {
              authMethods.push({
                type: "publickey",
                key: keyInfo.privateKey,
                isDefault: true,
                id: `publickey-default-${keyInfo.keyName}`
              });
            }
          } else if (defaultKeyInfo && !options.privateKey && !usedDefaultKeyAsPrimary) {
            // Single default key fallback (when user has configured other auth methods)
            authMethods.push({ type: "publickey", key: defaultKeyInfo.privateKey, isDefault: true, id: "publickey-default" });
          }
    
          // Add unlocked encrypted default keys (user provided passphrases for these)
          for (const keyInfo of unlockedEncryptedKeys) {
            authMethods.push({
              type: "publickey",
              key: keyInfo.privateKey,
              passphrase: keyInfo.passphrase,
              isDefault: true,
              id: `publickey-encrypted-${keyInfo.keyName}`
            });
          }
    
          // Finally try keyboard-interactive
          authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });
    
          log("Auth methods configured", {
            methods: authMethods.map(m => ({ type: m.type, id: m.id, isDefault: m.isDefault || false })),
            cachedMethod,
            usedDefaultKeyAsPrimary
          });
    
          // Reorder methods based on cached successful method
          if (cachedMethod) {
            const cachedIndex = authMethods.findIndex(m => m.id === cachedMethod);
            if (cachedIndex > 0) {
              const [cachedAuthMethod] = authMethods.splice(cachedIndex, 1);
              authMethods.unshift(cachedAuthMethod);
              log("Reordered auth methods based on cache", {
                methods: authMethods.map(m => m.id)
              });
            }
          }
    
          // Always use dynamic authHandler to ensure consistent "none" probing
          // and auth method logging regardless of how many methods are configured
          if (authMethods.length >= 1) {
            let authIndex = 0;
            // Track methods that have been attempted (to avoid re-trying on failure)
            // This prevents reusing the same key when server requires multiple publickey auth steps
            // and also prevents re-attempting failed methods
            const attemptedMethodIds = new Set();
            // Track the first successful method for caching (not the last one in multi-step flows)
            let firstSuccessfulMethod = null;
            // Track if we've gone through a partialSuccess flow (multi-step auth)
            let hadPartialSuccess = false;
    
            connectOpts.authHandler = (methodsLeft, partialSuccess, callback) => {
              log("authHandler called", { methodsLeft, partialSuccess, authIndex, attemptedMethodIds: Array.from(attemptedMethodIds) });
    
              // Log rejection of previous method
              if (lastTriedMethod && !partialSuccess) {
                sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', `${lastTriedMethod} rejected`);
              }
    
              // On the very first call (methodsLeft === null), try "none" auth.
              // Per RFC 4252, the "none" request is how the client discovers which
              // methods the server supports.  It also allows passwordless login on
              // embedded devices.  This matches the behavior of OpenSSH and Tabby.
              if (methodsLeft === null && !attemptedMethodIds.has("none")) {
                attemptedMethodIds.add("none");
                lastTriedMethod = "none";
                sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', 'none (no credentials)');
                return callback("none");
              }
    
              // methodsLeft can be null on first call (before server responds with available methods)
              // Include "agent" for SSH agent-based auth (used with agentForwarding)
              const availableMethods = methodsLeft || ["publickey", "password", "keyboard-interactive", "agent"];
    
              // Handle partialSuccess case (e.g., password succeeded but server requires additional auth like MFA)
              // When partialSuccess is true, we should try the remaining methods the server is asking for
              if (partialSuccess && methodsLeft && methodsLeft.length > 0) {
                hadPartialSuccess = true;
                // Record the first successful method (the one that triggered partialSuccess)
                if (lastTriedMethod && !firstSuccessfulMethod) {
                  firstSuccessfulMethod = lastTriedMethod;
                  log("Recorded first successful method for caching", { method: firstSuccessfulMethod });
                }
                // Mark the last tried method as attempted (it succeeded, so we shouldn't retry it)
                if (lastTriedMethod) {
                  attemptedMethodIds.add(lastTriedMethod);
                  log("Marked method as attempted (partial success)", { method: lastTriedMethod });
                }
    
                log("Partial success - server requires additional auth", { methodsLeft, attemptedMethodIds: Array.from(attemptedMethodIds) });
    
                // Find a method from our list that matches what the server wants
                // Skip methods that have already been attempted
                for (const serverMethod of methodsLeft) {
                  // Map server method names to our method types
                  const matchingMethod = authMethods.find(m => {
                    // Skip already attempted methods
                    if (attemptedMethodIds.has(m.id)) return false;
                    if (serverMethod === "keyboard-interactive" && m.type === "keyboard-interactive") return true;
                    if (serverMethod === "password" && m.type === "password") return true;
                    if (serverMethod === "publickey" && (m.type === "publickey" || m.type === "agent")) return true;
                    return false;
                  });
    
                  if (matchingMethod) {
                    log("Found matching method for partial success", { serverMethod, matchingMethod: matchingMethod.id });
                    // Mark as attempted BEFORE returning to prevent re-use on failure
                    attemptedMethodIds.add(matchingMethod.id);
                    lastTriedMethod = matchingMethod.id;
    
                    if (matchingMethod.type === "keyboard-interactive") {
                      log("Trying keyboard-interactive auth (partial success)", { id: matchingMethod.id });
                      return callback("keyboard-interactive");
                    } else if (matchingMethod.type === "password") {
                      log("Trying password auth (partial success)", { id: matchingMethod.id });
                      return callback({
                        type: "password",
                        username: connectOpts.username,
                        password: connectOpts.password,
                      });
                    } else if (matchingMethod.type === "agent") {
                      const agentType = typeof connectOpts.agent === "string" ? "path" : "NetcattyAgent";
                      log("Trying agent auth (partial success)", { id: matchingMethod.id, agentType });
                      return callback("agent");
                    } else if (matchingMethod.type === "publickey") {
                      log("Trying publickey auth (partial success)", { id: matchingMethod.id });
                      return callback({
                        type: "publickey",
                        username: connectOpts.username,
                        key: matchingMethod.key,
                        passphrase: matchingMethod.passphrase,
                      });
                    }
                  }
                }
                // No matching method found for partial success
                log("No matching method found for partial success requirements", { methodsLeft });
                return callback(false);
              }
    
              while (authIndex < authMethods.length) {
                const method = authMethods[authIndex];
                authIndex++;
    
                // Skip methods that have already been attempted (e.g., during partial success handling)
                if (attemptedMethodIds.has(method.id)) {
                  log("Skipping already attempted method", { method: method.id });
                  continue;
                }
    
                // Check if this method is still available on server
                // Note: "agent" uses "publickey" as the underlying method type
                const methodName = method.type === "password" ? "password" :
                  method.type === "publickey" ? "publickey" :
                    method.type === "agent" ? "publickey" : "keyboard-interactive";
                if (!availableMethods.includes(methodName) && !availableMethods.includes(method.type)) {
                  log("Auth method not available on server, skipping", { method: method.id });
                  continue;
                }
    
                // Mark as attempted BEFORE returning
                attemptedMethodIds.add(method.id);
                lastTriedMethod = method.id;
    
                if (method.type === "agent") {
                  // Only log safe identifier, not the full agent object which may contain private keys
                  const agentType = typeof connectOpts.agent === "string" ? "path" : "NetcattyAgent";
                  log("Trying agent auth", { id: method.id, agentType });
                  sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', 'SSH agent');
                  // Return "agent" string to use SSH agent for authentication
                  return callback("agent");
                } else if (method.type === "publickey") {
                  log("Trying publickey auth", { id: method.id, isDefault: method.isDefault || false });
                  const keyLabel = method.id.startsWith("publickey-default-")
                    ? `key ${method.id.replace("publickey-default-", "")}`
                    : method.id.startsWith("publickey-encrypted-")
                      ? `key ${method.id.replace("publickey-encrypted-", "")} (encrypted)`
                      : method.id === "publickey-user"
                        ? "configured key"
                        : method.id;
                  sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', keyLabel);
                  return callback({
                    type: "publickey",
                    username: connectOpts.username,
                    key: method.key,
                    passphrase: method.passphrase,
                  });
                } else if (method.type === "password") {
                  log("Trying password auth", { id: method.id });
                  sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', 'password');
                  return callback({
                    type: "password",
                    username: connectOpts.username,
                    password: connectOpts.password,
                  });
                } else if (method.type === "keyboard-interactive") {
                  log("Trying keyboard-interactive auth", { id: method.id });
                  sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', 'keyboard-interactive');
                  // Return string instead of object - ssh2 requires a prompt function
                  // for keyboard-interactive objects. Returning the string lets ssh2
                  // use its default handling and trigger the keyboard-interactive event.
                  return callback("keyboard-interactive");
                }
              }
    
              log("All auth methods exhausted");
              sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', 'all methods exhausted');
              return callback(false);
            };
    
            // Store method reference for success callback
            // For multi-step auth (partialSuccess), cache the first successful method, not the last
            // This ensures next connection starts with the correct first factor
            connectOpts._lastTriedMethodRef = () => {
              if (hadPartialSuccess && firstSuccessfulMethod) {
                log("Using first successful method for cache (multi-step auth)", { firstSuccessfulMethod });
                return firstSuccessfulMethod;
              }
              return lastTriedMethod;
            };
          }
        }
    
        // Handle chain/proxy connections
        if (hasJumpHosts) {
          // Pass fetched keys to chain connection to avoid re-reading files
          options._defaultKeys = allDefaultKeys;
    
          const chainResult = await connectThroughChain(
            event,
            options,
            jumpHosts,
            options.hostname,
            options.port || 22,
            sessionId
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
        } else {
          // Direct connection (no jump hosts, no proxy)
          sendProgress(1, 1, options.hostname, 'connecting');
        }
    
        return new Promise((resolve, reject) => {
          const logPrefix = hasJumpHosts ? '[Chain]' : '[SSH]';
          let settled = false;
          let detachX11Forwarding = null;
    
          conn.once("connect", () => enableSshNoDelay(conn));
          if (connectOpts.sock) enableTcpNoDelay(connectOpts.sock);
    
          conn.once("handshake", () => {
            console.log(`${logPrefix} ${options.hostname} handshake complete`);
            sendProgress(totalHops, totalHops, options.hostname, 'authenticating');
          });
    
          conn.once("ready", () => {
            console.log(`${logPrefix} ${options.hostname} ready`);
    
            // Cache the successful auth method
            if (connectOpts._lastTriedMethodRef) {
              const successMethod = connectOpts._lastTriedMethodRef();
              if (successMethod) {
                setCachedAuthMethod(connectOpts.username, options.hostname, options.port, successMethod);
              }
            }
    
            sendProgress(totalHops, totalHops, options.hostname, 'authenticated');
            sendProgress(totalHops, totalHops, options.hostname, 'shell');
    
            const sendTerminalMessage = (data) => {
              safeSend(event.sender, "netcatty:data", { sessionId, data });
            };
    
            const x11FakeCookie = options.x11Forwarding
              ? crypto.randomBytes(16).toString("hex")
              : null;
    
            if (options.x11Forwarding) {
              detachX11Forwarding = attachX11Forwarding(conn, {
                display: options.x11Display,
                fakeCookie: x11FakeCookie,
                sendMessage: sendTerminalMessage,
              });
            }
    
            const shellOptions = {
              env: {
                LANG: resolveLangFromCharset(options.charset),
                COLORTERM: "truecolor",
                ...(options.env || {}),
              },
            };
    
            if (options.x11Forwarding) {
              shellOptions.x11 = {
                protocol: "MIT-MAGIC-COOKIE-1",
                cookie: x11FakeCookie,
                screen: 0,
                single: false,
              };
            }
    
            conn.shell(
              {
                term: "xterm-256color",
                cols,
                rows,
              },
              shellOptions,
              (err, stream) => {
                if (err) {
                  if (detachX11Forwarding) detachX11Forwarding();
                  settled = true;
                  conn.end();
                  for (const c of chainConnections) {
                    try { c.end(); } catch { }
                  }
                  if (options.x11Forwarding && /x11/i.test(err.message || "")) {
                    sendTerminalMessage("\r\n[X11] Could not enable X11 forwarding. Make sure X11 forwarding is allowed on the server and xauth is installed.\r\n");
                  }
                  sendProgress(totalHops, totalHops, options.hostname, 'error', `Failed to open shell: ${err.message}`);
                  reject(err);
                  return;
                }
    
                sendProgress(totalHops, totalHops, options.hostname, 'connected');
    
                const session = {
                  conn,
                  stream,
                  chainConnections,
                  webContentsId: event.sender.id,
                  // Store connection info for MCP host discovery
                  hostname: options.host || options.hostname || '',
                  username: options.username || '',
                  label: options.label || '',
                  lastIdlePrompt: '',
                  lastIdlePromptAt: 0,
                  _promptTrackTail: '',
                  // SSH server identification string (the `software` part of
                  // `SSH-2.0-<software>`). ssh2 captures this during the header
                  // exchange and stores it on the client as `_remoteVer` — it
                  // is available by the time 'ready' fires, so the renderer can
                  // use it to detect network-device vendors without running any
                  // additional exec channels. See domain/host.ts
                  // `detectVendorFromSshVersion`.
                  remoteSshVersion: (conn && typeof conn._remoteVer === 'string') ? conn._remoteVer : '',
                };
                sessions.set(sessionId, session);
    
                // Start real-time session log stream if configured
                if (options.sessionLog?.enabled && options.sessionLog?.directory) {
                  logStreamToken = sessionLogStreamManager.startStream(sessionId, {
                    hostLabel: options.hostLabel || options.hostname || '',
                    hostname: options.hostname || '',
                    directory: options.sessionLog.directory,
                    format: options.sessionLog.format || 'txt',
                    startTime: Date.now(),
                  });
                }
    
                // Coalesce shell output and deliver it to the renderer on the next
                // event-loop turn (see ptyOutputBuffer) rather than on a fixed timer,
                // so interactive echo isn't held back by the batch interval. A size
                // cap still forces an immediate flush for bursts of output.
                const { bufferData, flush: flushBuffer } = createPtyOutputBuffer((data) => {
                  const contents = event.sender;
                  safeSend(contents, "netcatty:data", { sessionId, data });
                });
    
                const sshZmodemSentry = createZmodemSentry({
                  sessionId,
                  onData(buf) {
                    const decoder = getSessionDecoder(sessionId, "stdout");
                    const decoded = decoder.write(buf);
                    trackSessionIdlePrompt(session, decoded);
                    bufferData(decoded);
                    sessionLogStreamManager.appendData(sessionId, decoded);
                  },
                  writeToRemote(buf) {
                    try { return stream.write(buf); } catch { return true; /* ignore */ }
                  },
                  interruptRemote() {
                    try { stream.signal?.("INT"); } catch { /* ignore */ }
                  },
                  probeReceiveConflicts(names) {
                    return probeReceiveConflicts(sessions.get(sessionId), names);
                  },
                  removeRemoteFiles(paths) {
                    return removeRemoteFiles(sessions.get(sessionId), paths);
                  },
                  restoreRemoteModes(entries) {
                    return restoreRemoteModes(sessions.get(sessionId), entries);
                  },
                  requestOverwriteDecision(filename) {
                    return new Promise((resolve) => {
                      const requestId = randomUUID();
                      const timer = setTimeout(() => {
                        zmodemOverwritePending.delete(requestId);
                        resolve({ action: "skip", applyToRest: false });
                      }, 120000);
                      zmodemOverwritePending.set(requestId, (payload) => {
                        clearTimeout(timer);
                        resolve({ action: payload.action, applyToRest: !!payload.applyToRest });
                      });
                      safeSend(event.sender, "netcatty:zmodem:overwrite-request", {
                        sessionId, requestId, filename,
                      });
                    });
                  },
                  getWebContents() {
                    return event.sender;
                  },
                  label: "SSH",
                });
                session.zmodemSentry = sshZmodemSentry;
    
                stream.on("data", (data) => {
                  // data is Buffer from ssh2 — feed raw bytes to ZMODEM sentry.
                  // In normal mode, sentry's onData callback handles decoding and buffering.
                  sshZmodemSentry.consume(data);
                });
    
                stream.stderr?.on("data", (data) => {
                  // stderr is not used for ZMODEM — decode normally
                  const decoder = getSessionDecoder(sessionId, "stderr");
                  const decoded = decoder.write(data);
                  bufferData(decoded);
                  sessionLogStreamManager.appendData(sessionId, decoded);
                });
    
                // Capture the real exit code from the remote process.
                // "exit" fires when the remote shell/process exits normally;
                // "close" fires whenever the channel closes (could be network drop).
                // Only treat it as user-initiated exit if "exit" fired with a numeric
                // code and no signal. Signal terminations (e.g. server kill, idle
                // timeout) have code=null and signal set — those are not user exits.
                let streamExitCode = 0;
                let streamExited = false;
                stream.on("exit", (code, signal) => {
                  streamExitCode = typeof code === "number" ? code : 0;
                  streamExited = typeof code === "number" && !signal;
                });
    
                stream.on("close", () => {
                  // Always flush buffered data regardless of session state.
                  // flushBuffer() cancels any pending scheduled flush internally.
                  flushBuffer();
                  sessionLogStreamManager.stopStream(sessionId, logStreamToken);
                  if (detachX11Forwarding) {
                    detachX11Forwarding();
                    detachX11Forwarding = null;
                  }
    
                  // Only send exit if session hasn't already been cleaned up by
                  // conn.once("close") — which fires before stream.on("close")
                  // in ssh2 when the transport drops.
                  if (sessions.has(sessionId)) {
                    const contents = event.sender;
                    const session = sessions.get(sessionId);
                    const transportError = session?._transportError;
                    if (transportError) {
                      safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: transportError, reason: "error" });
                    } else {
                      // A shell TMOUT auto-logout is a clean exit (numeric code, no
                      // signal) — identical to a user-typed `exit` by code/signal —
                      // so detect it via the banner the shell prints just before
                      // exiting and report it as a timeout. That keeps the tab open
                      // for reconnect instead of auto-closing it (#1062 / #977).
                      const idleTimedOut = streamExited && looksLikeIdleAutoLogout(session?._promptTrackTail);
                      const reason = idleTimedOut ? "timeout" : (streamExited ? "exited" : "closed");
                      safeSend(contents, "netcatty:exit", { sessionId, exitCode: streamExitCode, reason });
                    }
                    sessions.get(sessionId)?.zmodemSentry?.cancel();
                    sessions.delete(sessionId);
                    sessionEncodings.delete(sessionId);
                    sessionDecoders.delete(sessionId);
                  }
                  conn.end();
                  for (const c of chainConnections) {
                    try { c.end(); } catch { }
                  }
                });
    
                // Pre-seed encoding from host charset if it's a GB variant
                if (options.charset && /^gb/i.test(String(options.charset).trim())) {
                  sessionEncodings.set(sessionId, "gb18030");
                }
    
                // Run startup command if specified
                if (options.startupCommand) {
                  setTimeout(() => {
                    stream.write(`${options.startupCommand}\n`);
                  }, 300);
                }
    
                settled = true;
                resolve({ sessionId });
              }
            );
          });
    
          conn.on("error", (err) => {
            // After the promise is settled, we can't reject again. But if the
            // session was already established (resolved), we still need to notify
            // the renderer about transport errors so the session shows as failed
            // rather than silently closing.
            // Don't send netcatty:exit here — the stream close handler will flush
            // any buffered data first and then send exit with this error info.
            if (settled) {
              console.warn(`${logPrefix} ${options.hostname} post-settle error:`, err.message);
              // Store the error so the close handler can include it in the exit event
              if (sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                if (session) session._transportError = err.message;
              }
              return;
            }
    
            const contents = event.sender;
    
            const isAuthError = err.message?.toLowerCase().includes('authentication') ||
              err.message?.toLowerCase().includes('auth') ||
              err.message?.toLowerCase().includes('password') ||
              err.level === 'client-authentication';
    
            // Clear cached auth method on auth failure so next attempt tries all methods
            if (isAuthError) {
              clearCachedAuthMethod(connectOpts.username, options.hostname, options.port);
              console.log(`${logPrefix} ${options.hostname} auth failed:`, err.message);
              safeSend(contents, "netcatty:auth:failed", {
                sessionId,
                error: err.message,
                hostname: options.hostname
              });
            } else {
              console.error(`${logPrefix} ${options.hostname} error:`, err.message);
            }
    
            sendProgress(totalHops, totalHops, options.hostname, 'error', err.message);
            safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: err.message, reason: "error" });
            sessionLogStreamManager.stopStream(sessionId, logStreamToken);
            if (detachX11Forwarding) {
              detachX11Forwarding();
              detachX11Forwarding = null;
            }
            sessions.get(sessionId)?.zmodemSentry?.cancel();
            sessions.delete(sessionId);
            sessionEncodings.delete(sessionId);
            sessionDecoders.delete(sessionId);
            for (const c of chainConnections) {
              try { c.end(); } catch { }
            }
            // Destroy the connection to prevent further socket errors from leaking
            // as uncaught exceptions (e.g. ECONNRESET on embedded devices).
            try { conn.destroy(); } catch { }
            settled = true;
            reject(err);
          });
    
          conn.once("timeout", () => {
            console.error(`${logPrefix} ${options.hostname} connection timeout`);
            const err = new Error(`Connection timeout to ${options.hostname}`);
            const contents = event.sender;
            sendProgress(totalHops, totalHops, options.hostname, 'error', err.message);
            safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: err.message, reason: "timeout" });
            sessionLogStreamManager.stopStream(sessionId, logStreamToken);
            sessions.get(sessionId)?.zmodemSentry?.cancel();
            sessions.delete(sessionId);
            sessionEncodings.delete(sessionId);
            sessionDecoders.delete(sessionId);
            for (const c of chainConnections) {
              try { c.end(); } catch { }
            }
            try { conn.destroy(); } catch { }
            settled = true;
            reject(err);
          });
    
          conn.once("close", () => {
            const contents = event.sender;
            if (!settled) {
              sendProgress(totalHops, totalHops, options.hostname, 'error', `Connection to ${options.hostname} closed unexpectedly`);
            }
            // Only send exit if the session hasn't already been cleaned up by the
            // error handler (avoids sending a misleading exitCode:0 "closed" after
            // a real transport error was already reported).
            if (sessions.has(sessionId)) {
              const session = sessions.get(sessionId);
              const transportError = session?._transportError;
              if (transportError) {
                // A transport error was recorded — report it as an error exit
                safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: transportError, reason: "error" });
              } else {
                safeSend(contents, "netcatty:exit", { sessionId, exitCode: 0, reason: "closed" });
              }
            }
            sessionLogStreamManager.stopStream(sessionId, logStreamToken);
            sessions.get(sessionId)?.zmodemSentry?.cancel();
            sessions.delete(sessionId);
            sessionEncodings.delete(sessionId);
            sessionDecoders.delete(sessionId);
            for (const c of chainConnections) {
              try { c.end(); } catch { }
            }
            if (!settled) {
              settled = true;
              reject(new Error(`Connection to ${options.hostname} closed unexpectedly`));
            }
          });
    
          // Handle keyboard-interactive authentication (2FA/MFA). Uses the shared
          // factory so PAM-wrapped single-password prompts get auto-filled from
          // the saved host password (#969) — same path the chain/SFTP/port-
          // forwarding bridges go through.
          conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
            sender,
            sessionId,
            hostname: options.hostname,
            password: options.password,
            logPrefix,
            onAutoFill: () => sendProgress(
              totalHops, totalHops, options.hostname, 'auth-attempt', 'using saved password',
            ),
            onPromptShown: () => sendProgress(
              totalHops, totalHops, options.hostname, 'auth-attempt', 'waiting for user input...',
            ),
            onUserResponded: () => sendProgress(
              totalHops, totalHops, options.hostname, 'auth-attempt', 'user responded',
            ),
          }));
    
    
          // Enable keyboard-interactive authentication in authHandler
          // Note: If authHandler is a function (for fallback support), keyboard-interactive
          // is already included in the auth methods list
          if (Array.isArray(connectOpts.authHandler)) {
            // Add keyboard-interactive after the existing methods
            if (!connectOpts.authHandler.includes("keyboard-interactive")) {
              connectOpts.authHandler.push("keyboard-interactive");
            }
          } else if (typeof connectOpts.authHandler !== "function") {
            // Create authHandler with keyboard-interactive support
            // This path is taken when usedDefaultKeyAsPrimary=true (only keyboard-interactive in authMethods)
            // Using array format is more reliable - ssh2 uses connectOpts credentials directly
            const authMethods = [];
            // Try agent FIRST (this is what regular SSH does - it checks ssh-agent before key files)
            if (connectOpts.agent) authMethods.push("agent");
            if (connectOpts.privateKey) authMethods.push("publickey");
            if (connectOpts.password) authMethods.push("password");
            authMethods.push("keyboard-interactive");
            connectOpts.authHandler = authMethods;
            log("Using simple array authHandler", { authMethods, usedDefaultKeyAsPrimary });
          }
          // If authHandler is a function, it already handles keyboard-interactive
    
          // Increase timeout to allow for keyboard-interactive auth
          connectOpts.readyTimeout = 120000; // 2 minutes for 2FA input
    
          console.log(`${logPrefix} Connecting to ${options.hostname}...`);
          conn.connect(connectOpts);
        });
      } catch (err) {
        console.error("[Chain] SSH chain connection error:", err.message);
        const contents = event.sender;
        safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: err.message });
        throw err;
      }
    }
    return { startSSHSession };
  }
}

module.exports = { createStartSessionApi };
