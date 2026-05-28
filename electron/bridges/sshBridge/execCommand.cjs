/* eslint-disable no-undef */
function createExecCommandApi(ctx) {
  with (ctx) {
    async function execCommand(event, payload) {
      const enableKeyboardInteractive = !!payload.enableKeyboardInteractive;
      const baseTimeoutMs = payload.timeout || 10000;
      const timeoutMs = enableKeyboardInteractive ? Math.max(baseTimeoutMs, 120000) : baseTimeoutMs;
      const sender = event.sender;
      const sessionId = payload.sessionId || randomUUID();
      const defaultKeys = enableKeyboardInteractive ? await findAllDefaultPrivateKeysFromHelper() : [];
      let identityFilePrivateKey = null;
      let identityFilePassphrase = null;
      const inlineKey = payload.privateKey
        ? await preparePrivateKeyForAuth({
          sender,
          privateKey: payload.privateKey,
          keyId: payload.keyId,
          keyName: payload.keyId || payload.username,
          hostname: payload.hostname,
          initialPassphrase: payload.passphrase,
          logPrefix: "[SSH Exec]",
        })
        : null;
    
      if (!payload.privateKey && payload.identityFilePaths?.length > 0) {
        for (const keyPath of payload.identityFilePaths) {
          try {
            const identityFile = await loadIdentityFileForAuth({
              sender,
              keyPath,
              hostname: payload.hostname,
              initialPassphrase: payload.passphrase,
              logPrefix: "[SSH Exec]",
            });
            if (!identityFile) {
              continue;
            }
            identityFilePrivateKey = identityFile.privateKey;
            identityFilePassphrase = identityFile.passphrase || null;
            break;
          } catch (err) {
            if (isPassphraseCancelledError(err)) {
              throw err;
            }
            console.warn("[SSH Exec] Failed to read identity file:", err?.message || err);
          }
        }
      }
    
      return new Promise((resolve, reject) => {
        const conn = new SSHClient();
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          conn.end();
          reject(new Error("SSH exec timeout"));
        }, timeoutMs);
    
        conn
          .once("ready", () => {
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
            conn.end();
            reject(err);
          })
          .once("end", () => {
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
          readyTimeout: enableKeyboardInteractive ? Math.max(timeoutMs, 120000) : timeoutMs,
          keepaliveInterval: 0,
          // Honor the host's algorithm settings so one-off commands (e.g. the
          // keychain "export public key to host" flow) negotiate with the same
          // KEX / cipher / host-key set as the interactive terminal. Without
          // this, a host that needs the ECDSA skip or legacy algorithms would
          // connect in the terminal but still fail the same handshake here.
          algorithms: buildAlgorithms(payload.legacyAlgorithms, {
            skipEcdsaHostKey: payload.skipEcdsaHostKey,
            algorithmOverrides: payload.algorithmOverrides,
          }),
        };
    
        let authAgent = null;
        const effectivePrivateKey = inlineKey?.privateKey || identityFilePrivateKey;
        const effectivePassphrase = inlineKey?.passphrase || identityFilePassphrase;
        if (hasCertificate) {
          authAgent = new NetcattyAgent({
            mode: "certificate",
            webContents: event.sender,
            meta: {
              label: payload.keyId || payload.username || "",
              certificate: payload.certificate,
              privateKey: effectivePrivateKey,
              passphrase: effectivePassphrase,
            },
          });
          connectOpts.agent = authAgent;
        } else if (effectivePrivateKey) {
          connectOpts.privateKey = effectivePrivateKey;
          if (effectivePassphrase) {
            connectOpts.passphrase = effectivePassphrase;
          }
        }
    
        if (payload.password) connectOpts.password = payload.password;
    
        if (enableKeyboardInteractive) {
          connectOpts.tryKeyboard = true;
    
          const authConfig = buildAuthHandler({
            privateKey: connectOpts.privateKey,
            password: connectOpts.password,
            passphrase: connectOpts.passphrase,
            agent: connectOpts.agent,
            username: connectOpts.username,
            logPrefix: "[SSH Exec]",
            defaultKeys,
          });
    
          applyAuthToConnOpts(connectOpts, authConfig);
    
          conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
            sender,
            sessionId,
            hostname: payload.hostname,
            password: payload.password,
            logPrefix: "[SSH Exec]",
          }));
        } else if (authAgent) {
          const order = ["agent"];
          if (connectOpts.password) order.push("password");
          connectOpts.authHandler = order;
        }
    
        conn.connect(connectOpts);
      });
    }

    return { execCommand };
  }
}

module.exports = { createExecCommandApi };
