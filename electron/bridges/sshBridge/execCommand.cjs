/* eslint-disable no-undef */
const { runWhenProxyConnectionReady } = require("../proxyUtils.cjs");
const { executeBoundedSshCommand } = require("../boundedSshExec.cjs");

const SSH_EXEC_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

function createExecCommandApi(ctx) {
  with (ctx) {
    async function execCommand(event, payload) {
      const enableKeyboardInteractive = !!payload.enableKeyboardInteractive;
      const commandTimeoutMs = payload.timeout || 10000;
      const { tcpConnectTimeoutMs, authReadyTimeoutMs } = resolveSshConnectionTimeouts(payload);
      const sender = event.sender;
      const sessionId = payload.sessionId || randomUUID();
      const hasCertificate = typeof payload.certificate === "string" && payload.certificate.trim().length > 0;
      const fallbackAgentSocket = payload.useSshAgent === false
        ? null
        : payload.useSshAgent === true
          ? undefined
          : await getAvailableAgentSocket();
      const { enhanceAuthOptionsForFido } = require("../sshAuthHelper.cjs");
      const prep = await enhanceAuthOptionsForFido(payload, sender);
      const isFido = prep.useFidoAgent === true;
      const systemAuthAgent = (hasCertificate && !isFido)
        ? null
        : await prepareSystemSshAgentForAuth(prep, "[SSH Exec]");
      const defaultKeys = enableKeyboardInteractive && !(systemAuthAgent && payload.identitiesOnly)
        ? await findAllDefaultPrivateKeysFromHelper()
        : [];
      let identityFilePrivateKey = null;
      let identityFilePassphrase = null;
      const inlineKey = payload.privateKey && !systemAuthAgent
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
    
      if (!payload.privateKey && !systemAuthAgent && payload.identityFilePaths?.length > 0) {
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
        let settled = false;
        let authReadyTimer = null;
        let commandController = null;
        const clearTimers = () => {
          if (authReadyTimer) clearTimeout(authReadyTimer);
          authReadyTimer = null;
        };
        const rejectConnection = (err) => {
          if (settled) return;
          settled = true;
          clearTimers();
          commandController?.abort?.(err);
          conn.end();
          reject(err);
        };
    
        conn
          .once("connect", () => {
            runWhenProxyConnectionReady(conn._sock, () => {
              try { conn._sock?.setTimeout?.(0); } catch { /* ignore */ }
              authReadyTimer = setTimeout(() => {
                rejectConnection(new Error(`SSH authentication timeout to ${payload.hostname}`));
              }, authReadyTimeoutMs);
              authReadyTimer.unref?.();
            });
          })
          .once("ready", () => {
            if (authReadyTimer) clearTimeout(authReadyTimer);
            authReadyTimer = null;
            commandController = new AbortController();
            void executeBoundedSshCommand(conn, payload.command, {
              signal: commandController.signal,
              openingTimeoutMs: commandTimeoutMs,
              runTimeoutMs: commandTimeoutMs,
              maxOutputBytes: SSH_EXEC_COMMAND_MAX_OUTPUT_BYTES,
            }).then((result) => {
              if (settled) return;
              settled = true;
              clearTimers();
              conn.end();
              resolve({
                stdout: result.stdout,
                stderr: result.stderr,
                code: result.code ?? (result.stderr ? 1 : 0),
              });
            }, rejectConnection);
          })
          .on("error", (err) => {
            rejectConnection(err);
          })
          .once("timeout", () => {
            rejectConnection(new Error(`SSH connection timeout to ${payload.hostname}`));
          })
          .once("end", () => {
            if (settled) return;
            rejectConnection(new Error("SSH connection closed unexpectedly"));
          });
    
        const connectOpts = {
          host: payload.hostname,
          port: payload.port || 22,
          username: payload.username,
          timeout: tcpConnectTimeoutMs,
          readyTimeout: 0,
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
        if (systemAuthAgent) {
          connectOpts.agent = systemAuthAgent;
          require("../attachFidoAgentRelease.cjs").attachFidoAgentRelease(conn, systemAuthAgent);
        } else if (hasCertificate && !isFido) {
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
        } else if (effectivePrivateKey && !isFido) {
          connectOpts.privateKey = effectivePrivateKey;
          if (effectivePassphrase) {
            connectOpts.passphrase = effectivePassphrase;
          }
        }
    
        if (payload.password) connectOpts.password = payload.password;
    
        let authBanner = "";
        if (enableKeyboardInteractive) {
          connectOpts.tryKeyboard = true;
    
          const authConfig = buildAuthHandler({
            authMethod: payload.authMethod,
            requiresMfa: !!payload.requiresMfa,
            privateKey: connectOpts.privateKey,
            password: connectOpts.password,
            passphrase: connectOpts.passphrase,
            agent: connectOpts.agent,
            username: connectOpts.username,
            logPrefix: "[SSH Exec]",
            defaultKeys,
            sshAgentSocketOverride: fallbackAgentSocket,
            allowAgentFallback: payload.useSshAgent !== false,
          });
    
          applyAuthToConnOpts(connectOpts, authConfig);
          const execAuthPhase = authConfig.authPhase || { hadPartialSuccess: false };

          conn.on("banner", (message) => {
            authBanner = String(message || "").trim();
          });
          conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
            sender,
            sessionId,
            hostId: payload.hostId,
            hostname: payload.hostname,
            password: payload.password,
            logPrefix: "[SSH Exec]",
            scope: "external",
            getAuthBanner: () => authBanner,
            shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(execAuthPhase),
          }));
        } else if (connectOpts.agent) {
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

module.exports = { createExecCommandApi, SSH_EXEC_COMMAND_MAX_OUTPUT_BYTES };
