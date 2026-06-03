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
 *   - The companion connects ONLY to a host whose live key is already
 *     "trusted" in Netcatty's known-hosts store. A host verifier classifies
 *     the key during the transport handshake and REJECTS the connection for an
 *     unknown / changed key — for every auth method, not just password. This is
 *     done silently and never prompts: the user vets and trusts a host key
 *     through the real interactive session (#1191), and this background stats
 *     poll only ever rides on a host that vetting already approved. An
 *     untrusted host just leaves the stats bar empty (graceful degradation).
 *   - Rejecting outright (rather than merely withholding the password) is
 *     deliberate. Even though public-key / ssh-agent auth discloses no reusable
 *     secret and its signature is session-bound, a *background, user-invisible*
 *     connection that authenticated against an unverified host would still run
 *     the stats command there — letting a MITM / DNS-spoofed host feed bogus
 *     host-info to the user and enumerate the agent's public keys. That breaks
 *     the same host-key guarantee the interactive session enforces, so the
 *     companion refuses unvetted hosts regardless of auth method.
 *   - A gated authHandler additionally withholds the plaintext password until
 *     the verifier has confirmed trust, as defense in depth.
 */
function createMoshStatsConnectionApi(ctx) {
  // Read off ctx (not via the `with` scope) so an absent dependency reads as
  // `undefined` instead of throwing a ReferenceError under `with`. Optional:
  // when not wired in (e.g. older callers / some unit tests) the verifier
  // simply skips the system-known_hosts fallback.
  const isHostKeyTrustedBySystem = ctx.isHostKeyTrustedBySystem;
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

    // An ssh2 hostVerifier that ACCEPTS the transport only when the live host
    // key is already trusted — by Netcatty's in-app known-hosts store OR by the
    // user's *system* OpenSSH known_hosts — and REJECTS it for an unknown /
    // changed key. It never prompts — an untrusted host fails the background
    // companion silently (stats stay empty) instead of popping a modal the user
    // can't meaningfully answer for a stats poll.
    //
    // Why also consult the system known_hosts: a Mosh session is bootstrapped
    // by the system `ssh`, which records (and vets, via its own prompt) the
    // host key in `~/.ssh/known_hosts`. Netcatty's vault snapshot is NOT updated
    // by that handshake, so a host the user trusted purely through system ssh
    // would otherwise be misread as "unknown" and the companion permanently
    // disabled — leaving the stats bar empty even though the system already
    // trusts the exact key. We match the LIVE key's SHA-256 fingerprint against
    // those files, so this only ever grants trust for the precise key the user's
    // own OpenSSH already trusts; it never accepts an arbitrary or mismatched
    // key. Unknown / changed keys stay rejected.
    //
    // Rejecting (not merely gating password auth) is required: a background,
    // user-invisible connection that completed key/agent auth against an
    // unverified host would still run the stats command there, letting a MITM /
    // DNS-spoofed host feed bogus host-info and enumerate the agent's public
    // keys. `trust.trusted` additionally gates the password method in the
    // authHandler (defense in depth); `trust.rejected` lets the caller treat an
    // untrusted host as a permanent failure so it stops reconnecting every poll.
    function createTrustEnforcingHostVerifier({ hostname, port, knownHosts, trust }) {
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
          trust.trusted = decision.status === "trusted";
          // Fall back to the system OpenSSH known_hosts (Mosh's real trust
          // source) only when Netcatty's snapshot does not already vouch for
          // the key. Matching is by the live key's fingerprint, so this can
          // only confirm — never override a mismatch into acceptance.
          if (!trust.trusted && isHostKeyTrustedBySystem) {
            trust.trusted = isHostKeyTrustedBySystem({
              hostname,
              port,
              fingerprint: keyInfo.fingerprint,
            }) === true;
          }
        } catch (err) {
          log("[Mosh] stats companion host-key check failed:", err?.message || String(err));
          trust.trusted = false;
        }
        if (!trust.trusted) trust.rejected = true;
        callback(trust.trusted);
      };
    }

    // A function-form ssh2 authHandler that offers, in order: none, agent (if
    // available), publickey (if a key was resolved), and — only when the host
    // key is trusted — password and keyboard-interactive. Returning method
    // name strings lets ssh2 pull the credential data from connectOpts. This
    // is what actually withholds the password from an untrusted host while
    // still letting key/agent auth succeed.
    function createGatedAuthHandler({ hasAgent, hasKey, hasPassword, trust }) {
      const methods = ["none"];
      if (hasAgent) methods.push("agent");
      if (hasKey) methods.push("publickey");
      let index = 0;
      let trustedMethodsAppended = false;
      return (_methodsLeft, _partialSuccess, callback) => {
        // Append the password methods lazily, the first time we run out of the
        // always-allowed ones, so the trust flag (set by the verifier during
        // the transport handshake) is up to date.
        if (index >= methods.length && !trustedMethodsAppended) {
          trustedMethodsAppended = true;
          if (hasPassword && trust.trusted) {
            methods.push("password", "keyboard-interactive");
          }
        }
        if (index >= methods.length) {
          callback(false);
          return;
        }
        callback(methods[index++]);
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

      const hasAnyAuth = Boolean(
        connectOpts.agent || connectOpts.privateKey || connectOpts.password,
      );

      // Always install a host verifier that refuses an untrusted host, for
      // EVERY auth method — a background, user-invisible companion must never
      // authenticate to or run commands against a host Netcatty has not vetted
      // (it could feed bogus host-info or enumerate agent keys), even though
      // key/agent auth discloses no reusable secret.
      const trust = { trusted: false, rejected: false };
      connectOpts.hostVerifier = createTrustEnforcingHostVerifier({
        hostname: connectOpts.host,
        port: connectOpts.port,
        knownHosts: auth.knownHosts,
        trust,
      });

      // When a plaintext password is in play, also gate it behind the trust
      // flag in the authHandler (defense in depth): key/agent methods are
      // offered first, and the password / keyboard-interactive methods only
      // once the verifier has confirmed the host key is trusted.
      if (connectOpts.password) {
        connectOpts.authHandler = createGatedAuthHandler({
          hasAgent: Boolean(connectOpts.agent),
          hasKey: Boolean(connectOpts.privateKey),
          hasPassword: true,
          trust,
        });
      }

      return { connectOpts, hasAnyAuth, trust };
    }

    /**
     * Ensure a Mosh session has a usable stats companion connection.
     *
     * Returns the ssh2 Client on success (also stored on
     * `session.moshStatsConn`), or null when one could not be established.
     *
     * The companion is stored ONLY on `session.moshStatsConn`, deliberately
     * NOT on `session.conn`: other bridges treat `session.conn` as the
     * session's primary interactive SSH connection (getSessionPwd assumes its
     * exec channel is a sibling of the interactive shell; SFTP / MCP exec run
     * over it). A Mosh session's interactive shell lives on the UDP
     * mosh-client, not on this background stats connection, so exposing it as
     * `session.conn` would make those paths return bogus results or run over
     * the wrong connection. Only getServerStats reads `session.moshStatsConn`.
     *
     * Safe to call repeatedly: concurrent calls share a single in-flight
     * attempt, and a permanent failure is cached so later polls don't
     * reconnect on every tick.
     *
     * @param {object} session - the shared session record
     * @param {string} sessionId - the session's key in the shared sessions map
     * @param {Electron.WebContents} [webContents] - sender of the stats IPC,
     *   used only for certificate-agent construction.
     */
    function ensureMoshStatsConnection(session, sessionId, webContents) {
      if (!session) return Promise.resolve(null);
      // A previously established companion is reused.
      if (session.moshStatsConn) return Promise.resolve(session.moshStatsConn);
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

      const { connectOpts, hasAnyAuth, trust } = await buildStatsConnectOpts({
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
          // Stored only on moshStatsConn — never on session.conn (see the
          // ensureMoshStatsConnection docstring for why).
          session.moshStatsConn = conn;
          finish(conn);
        });

        conn.on("error", (err) => {
          log("[Mosh] stats companion connection error:", err?.message || String(err));
          // If this fired after we already adopted the connection, drop the
          // stale handle so the next poll can rebuild a fresh one.
          if (session.moshStatsConn === conn) session.moshStatsConn = null;
          // Auth rejection won't change with the same stored credentials, and a
          // host-key rejection (untrusted host) won't either until the user
          // vets the host via a real session — treat both as permanent so we
          // stop reconnecting on every poll. Everything else may be transient.
          fail(err, err?.level === "client-authentication" || trust.rejected);
        });

        conn.on("close", () => {
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
