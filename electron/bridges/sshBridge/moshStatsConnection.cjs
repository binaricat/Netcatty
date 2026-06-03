/* eslint-disable no-undef */

/**
 * Companion SSH connection for Mosh sessions.
 *
 * A Mosh session runs over UDP via a local `mosh-client` PTY and therefore
 * has no ssh2 `Client` (`session.conn`) — the very thing `getServerStats`
 * needs to run its periodic `/proc`-based stats command on an exec channel.
 * Without it the terminal's host-info bar (CPU / memory / disk / network)
 * stays empty for Mosh, while SSH sessions show it (issue #1198).
 *
 * This module lazily opens a *second*, stats-only ssh2 connection to the
 * same host using the same credentials the Mosh handshake already used, and
 * stores it as `session.conn` so the existing `getServerStats` code path
 * works unchanged. It is intentionally best-effort and non-interactive:
 *
 *   - It never prompts the user for a password or key passphrase. The Mosh
 *     handshake (driven by the system `ssh` in the user's PTY) is where the
 *     real, interactive auth happens; this companion only reuses credentials
 *     Netcatty already holds (stored password, parseable private key,
 *     unencrypted / stored-passphrase identity files, ssh-agent).
 *   - If it cannot authenticate or connect, it fails silently and records
 *     the failure so it does not hammer the host on every stats poll. Mosh
 *     keeps working; only the stats bar stays empty (graceful degradation).
 *
 * Security — host-key handling:
 *   - When the companion authenticates with a *password* (plain or via
 *     keyboard-interactive), the plaintext secret is sent to the server, so
 *     the companion MUST verify the host key first. It does so silently and
 *     non-interactively against Netcatty's known-hosts store: it proceeds
 *     only when the live key is already "trusted", and otherwise aborts
 *     without ever offering the password and without prompting (the user
 *     drives host-key trust through the real interactive session, not a
 *     background stats poll). This prevents leaking a saved password to a
 *     spoofed / MITM host whose key Netcatty has not vetted.
 *   - Public-key / ssh-agent auth proves possession via a signature and
 *     never discloses a reusable secret to the server, so — like the
 *     existing one-off `execCommand` path — it does not gate on host-key
 *     verification. (The handshake already vetted the host via system ssh's
 *     known_hosts.)
 */
function createMoshStatsConnectionApi(ctx) {
  with (ctx) {
    // Resolve a usable, non-interactive private key (+ passphrase) for the
    // companion connection. Returns null when the key is missing, encrypted
    // without a usable stored passphrase, or otherwise unparseable — the
    // caller then falls back to password / agent auth or gives up.
    function resolveNonInteractiveKey(privateKey, passphrase) {
      if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
        return null;
      }
      try {
        const parsed = sshUtils.parseKey(privateKey, passphrase);
        if (parsed && !(parsed instanceof Error)) {
          return { privateKey, passphrase: passphrase || undefined };
        }
      } catch {
        // parseKey throws on malformed input — treat as unusable.
      }
      return null;
    }

    // Read identity files from disk without prompting. Only unencrypted keys
    // (or keys whose stored passphrase parses them) are returned.
    async function resolveNonInteractiveIdentityFile(identityFilePaths, passphrase) {
      if (!Array.isArray(identityFilePaths) || identityFilePaths.length === 0) {
        return null;
      }
      for (const rawPath of identityFilePaths) {
        if (typeof rawPath !== "string" || rawPath.trim().length === 0) continue;
        const resolvedPath = expandIdentityFilePath(rawPath);
        let content;
        try {
          content = await readFileNoFollow(resolvedPath);
        } catch {
          continue;
        }
        if (!content) continue;
        const key = resolveNonInteractiveKey(content, passphrase);
        if (key) return key;
      }
      return null;
    }

    // A non-interactive ssh2 hostVerifier that accepts ONLY a host key
    // already trusted in Netcatty's known-hosts store. Unknown / changed keys
    // are rejected outright — no user prompt — so a background stats poll can
    // never disclose a password to an unvetted host, and never pops a
    // host-key dialog of its own.
    function createTrustedOnlyHostVerifier({ hostname, port, knownHosts }) {
      return (rawKey, callback) => {
        try {
          const keyInfo = hostKeyVerifier.describeHostKey(rawKey);
          const decision = hostKeyVerifier.classifyHostKey({
            knownHosts: Array.isArray(knownHosts) ? knownHosts : [],
            hostname,
            port,
            keyType: keyInfo.keyType,
            fingerprint: keyInfo.fingerprint,
          });
          callback(decision.status === "trusted");
        } catch (err) {
          log("[Mosh] stats companion host-key check failed:", err?.message || String(err));
          callback(false);
        }
      };
    }

    async function buildStatsConnectOpts(auth) {
      const connectOpts = {
        host: auth.hostname,
        port: auth.port || 22,
        username: auth.username || "root",
        // Stats are a background nicety — keep the timeout short so a slow or
        // firewalled host fails fast instead of holding a poll for 30s+.
        readyTimeout: 10000,
        keepaliveInterval: 0,
        // Honor the host's algorithm settings so the companion negotiates the
        // same KEX / cipher / host-key set as the interactive session would.
        algorithms: buildAlgorithms(auth.legacyAlgorithms, {
          skipEcdsaHostKey: auth.skipEcdsaHostKey,
          algorithmOverrides: auth.algorithmOverrides,
        }),
      };

      const hasCertificate =
        typeof auth.certificate === "string" && auth.certificate.trim().length > 0;
      const key =
        resolveNonInteractiveKey(auth.privateKey, auth.passphrase) ||
        await resolveNonInteractiveIdentityFile(auth.identityFilePaths, auth.passphrase);

      let agent = null;
      if (hasCertificate && key) {
        try {
          agent = new NetcattyAgent({
            mode: "certificate",
            webContents: auth.webContents,
            meta: {
              label: auth.keyId || auth.username || "",
              certificate: auth.certificate,
              privateKey: key.privateKey,
              passphrase: key.passphrase,
            },
          });
          connectOpts.agent = agent;
        } catch {
          // Certificate could not be parsed non-interactively — fall through
          // to plain key / password auth below.
          agent = null;
        }
      }

      if (!agent && key) {
        connectOpts.privateKey = key.privateKey;
        if (key.passphrase) connectOpts.passphrase = key.passphrase;
      }

      if (typeof auth.password === "string" && auth.password.length > 0) {
        connectOpts.password = auth.password;
        // Many SSH servers (PAM-backed) only offer password auth through
        // keyboard-interactive, not the plain "password" method. The Mosh
        // handshake's system ssh handles that via its PTY responder, so the
        // companion must too — otherwise stats stay empty on those hosts
        // despite a saved password. The handler (attached at connect time)
        // auto-fills non-interactively and never shows a prompt.
        connectOpts.tryKeyboard = true;
      }

      // ssh-agent fallback whenever a socket is available and no *explicit*
      // key / certificate-agent was resolved. The Mosh handshake runs the
      // system `ssh` with the inherited environment, so it authenticates via
      // the local ssh-agent by default — independent of agentForwarding
      // (which only controls *remote* forwarding). This is offered alongside
      // any saved password (ssh2 tries agent before password), so a
      // public-key host that also happens to have a stored password still
      // authenticates via the agent instead of failing on password-only.
      if (!agent && !connectOpts.privateKey) {
        const agentSocket = getSshAgentSocket();
        if (agentSocket) {
          connectOpts.agent = agentSocket;
        }
      }

      // Sending a plaintext password (directly or via keyboard-interactive)
      // to an unverified host would disclose it to a possible MITM. Gate
      // password auth behind a silent, trusted-only host-key check against
      // Netcatty's known-hosts store. Public-key / agent auth never reveals a
      // reusable secret, so it is not gated (see the module header).
      if (connectOpts.password) {
        connectOpts.hostVerifier = createTrustedOnlyHostVerifier({
          hostname: connectOpts.host,
          port: connectOpts.port,
          knownHosts: auth.knownHosts,
        });
      }

      const hasAnyAuth = Boolean(
        connectOpts.agent || connectOpts.privateKey || connectOpts.password,
      );

      return { connectOpts, hasAnyAuth };
    }

    /**
     * Ensure a Mosh session has a usable stats companion connection.
     *
     * Returns the ssh2 Client on success (also assigned to `session.conn`),
     * or null when one could not be established. Safe to call repeatedly:
     * concurrent calls share a single in-flight attempt, and a permanent
     * failure is cached so later polls don't reconnect on every tick.
     *
     * @param {object} session - the shared session record
     * @param {string} sessionId - the session's key in the shared sessions map
     * @param {Electron.WebContents} [webContents] - sender of the stats IPC,
     *   used only for certificate-agent construction.
     */
    function ensureMoshStatsConnection(session, sessionId, webContents) {
      if (!session) return Promise.resolve(null);
      // Already connected (either a real SSH session or a previously
      // established companion).
      if (session.conn) return Promise.resolve(session.conn);
      // A prior attempt permanently failed — don't keep retrying every poll.
      if (session.moshStatsConnFailed) return Promise.resolve(null);
      // Reuse an in-flight attempt so two near-simultaneous polls don't open
      // two connections.
      if (session.moshStatsConnPromise) return session.moshStatsConnPromise;

      const promise = establishMoshStatsConnection(session, sessionId, webContents).finally(() => {
        session.moshStatsConnPromise = null;
      });
      session.moshStatsConnPromise = promise;
      return promise;
    }

    // True once the session has gone away — either explicitly closed or
    // dropped from the shared map (e.g. the mosh-client PTY exited while we
    // were still connecting the companion).
    function sessionGone(session, sessionId) {
      return session.closed || sessions.get(sessionId) !== session;
    }

    async function establishMoshStatsConnection(session, sessionId, webContents) {
      const auth = session.moshStatsAuth;
      if (!auth || !auth.hostname) {
        // moshStatsAuth is only assigned once the handshake completes and the
        // session swaps to mosh-client. The renderer can mark a session
        // "connected" (and start polling) from the SSH bootstrap's visible
        // PTY output *before* that swap, so a missing auth here is transient —
        // do NOT permanently disable stats, or the companion would never be
        // attempted after the handshake finishes.
        return null;
      }

      const { connectOpts, hasAnyAuth } = await buildStatsConnectOpts({
        ...auth,
        webContents,
      });
      if (!hasAnyAuth) {
        // Nothing we can authenticate with non-interactively (e.g. the user
        // typed a password into the Mosh handshake PTY that we never stored).
        session.moshStatsConnFailed = true;
        return null;
      }

      // The session may have been closed while we were reading identity files.
      if (sessionGone(session, sessionId)) {
        return null;
      }

      return new Promise((resolve) => {
        const conn = new SSHClient();
        let settled = false;

        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        // Non-interactive keyboard-interactive auth: auto-fill the saved
        // password for a single password prompt and never show a modal. On a
        // 2FA / multi-prompt / OTP challenge we finish empty so ssh2 moves on
        // to the next method (or fails) instead of hanging on a prompt the
        // user can't answer for a background connection.
        if (connectOpts.tryKeyboard && connectOpts.password) {
          // Only auto-fill once. If the password was wrong, ssh2 may re-issue
          // the challenge; finishing empty on the retry lets auth fail cleanly
          // instead of looping on the same wrong password.
          let autoFilledOnce = false;
          conn.on("keyboard-interactive", (_name, _instr, _lang, prompts, finishKbd) => {
            if (!autoFilledOnce && isAutoFillablePasswordChallenge(prompts, connectOpts.password)) {
              autoFilledOnce = true;
              finishKbd([connectOpts.password]);
            } else {
              finishKbd([]);
            }
          });
        }

        // `permanent` distinguishes futile retries (auth rejected, or a throw
        // building the connection) from transient ones (network blip,
        // timeout). Only the former disables stats for the session's
        // lifetime; transient errors just skip this poll and let the next one
        // retry.
        const fail = (err, permanent) => {
          try { conn.end(); } catch { /* ignore */ }
          if (permanent) session.moshStatsConnFailed = true;
          finish(null);
        };

        conn.once("ready", () => {
          // The session may have been closed while we were connecting.
          if (sessionGone(session, sessionId)) {
            try { conn.end(); } catch { /* ignore */ }
            finish(null);
            return;
          }
          session.conn = conn;
          session.moshStatsConn = conn;
          finish(conn);
        });

        conn.on("error", (err) => {
          log("[Mosh] stats companion connection error:", err?.message || String(err));
          // If this fired after we already adopted the connection, drop the
          // stale handle so the next poll can rebuild a fresh one.
          if (session.conn === conn) session.conn = null;
          if (session.moshStatsConn === conn) session.moshStatsConn = null;
          // Auth rejection won't change with the same stored credentials, so
          // stop retrying. Everything else may be transient.
          fail(err, err?.level === "client-authentication");
        });

        conn.on("close", () => {
          if (session.conn === conn) session.conn = null;
          if (session.moshStatsConn === conn) session.moshStatsConn = null;
          // If the socket closed mid-handshake without ever emitting "ready"
          // or "error", settle the attempt here so the awaiting getServerStats
          // call (and session.moshStatsConnPromise) don't hang forever. This
          // is treated as transient — the next poll may retry.
          finish(null);
        });

        try {
          conn.connect(connectOpts);
        } catch (err) {
          log("[Mosh] stats companion connect threw:", err?.message || String(err));
          // A synchronous throw from connect() (e.g. malformed options) won't
          // succeed on retry either.
          fail(err, true);
        }
      });
    }

    return { ensureMoshStatsConnection };
  }
}

module.exports = { createMoshStatsConnectionApi };
