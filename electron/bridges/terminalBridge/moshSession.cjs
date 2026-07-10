/* eslint-disable no-undef */
const { emitTerminalSessionData } = require("../emitTerminalSessionData.cjs");
const {
  setBufferedOutputBytes,
  shouldAcceptSessionOutput,
  shouldProcessSessionOutput,
} = require("../terminalFlowAck.cjs");
const { createSshConnExecProbe } = require("../ai/sessionShellKind.cjs");

// MoshCatty normally emits this cleanup together with an alternate-screen
// exit. Netcatty keeps the primary screen, so restore only terminal modes that
// can leak from a full-screen remote program and leave scrollback untouched.
const MOSH_PRIMARY_SCREEN_RESET = "\x1b[?1l\x1b[0m\x1b[?25h"
  + "\x1b[?1003l\x1b[?1002l\x1b[?1001l\x1b[?1000l"
  + "\x1b[?1015l\x1b[?1006l\x1b[?1005l";

function withShellProbeTimeout(promise, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createMoshSessionApi(ctx) {
  with (ctx) {
    function resolveBareMoshClient(_options, opts = {}) {
      return bundledMoshClient(opts);
    }

    // MoshCatty is a pure single binary (no Cygwin DLL bag, no terminfo).
    // Runtime env only needs MOSH_KEY / TERM / LANG from the handshake path.
    function addBundledMoshRuntimeEnv(env, _bareClient, _opts = {}) {
      return env;
    }

    function createMoshUtf8Decoder() {
      const decoder = new StringDecoder("utf8");
      return (chunk) => {
        if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
        if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk));
        return chunk == null ? "" : String(chunk);
      };
    }
    
    function stripMoshPromptControls(text) {
      // eslint-disable-next-line no-control-regex
      return stripAnsi(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    }
    
    function isMoshPassphrasePrompt(tail) {
      return /(^|[\r\n]).*passphrase.*:\s*$/i.test(stripMoshPromptControls(tail));
    }
    
    function isMoshPasswordPrompt(tail) {
      return /(^|[\r\n]).*password:\s*$/i.test(stripMoshPromptControls(tail));
    }
    
    function createMoshSshPasswordResponder(sshPty, password, passphrase) {
      if (
        (typeof password !== "string" || password.length === 0) &&
        (typeof passphrase !== "string" || passphrase.length === 0)
      ) {
        return () => {};
      }
    
      let answeredPassword = false;
      let answeredPassphrase = false;
      let tail = "";
    
      return (chunk) => {
        if (answeredPassword && answeredPassphrase) return;
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
        if (!text) return;
    
        tail = (tail + text).slice(-512);
        if (typeof passphrase === "string" && passphrase.length > 0 && !answeredPassphrase && isMoshPassphrasePrompt(tail)) {
          answeredPassphrase = true;
          sshPty.write(`${passphrase}\r`);
          return;
        }
    
        if (typeof password !== "string" || password.length === 0 || answeredPassword) return;
        if (!isMoshPasswordPrompt(tail)) return;
    
        answeredPassword = true;
        sshPty.write(`${password}\r`);
      };
    }
    
    function normalizeMoshIdentityPath(keyPath) {
      if (typeof keyPath !== "string") return null;
      const trimmed = keyPath.trim();
      if (!trimmed) return null;
      if (trimmed === "~") return os.homedir();
      if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
      return trimmed;
    }
    
    function safeMoshAuthFileName(sessionId, keyId, suffix) {
      const safeId = String(keyId || sessionId || randomUUID())
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 80);
      return `mosh-auth-${safeId}-${randomUUID()}${suffix}`;
    }
    
    async function writeMoshAuthTempFile(fileName, content) {
      const target = tempDirBridge.getTempFilePath(fileName);
      const normalized = content.endsWith("\n") ? content : `${content}\n`;
      let created = false;
      try {
        const handle = await fs.promises.open(target, "wx", 0o600);
        created = true;
        await handle.close();
        await restrictMoshAuthFilePermissions(target, { failClosed: true });
        await fs.promises.writeFile(target, normalized, { flag: "w", mode: 0o600 });
        try {
          await fs.promises.chmod(target, 0o600);
        } catch {
          // Best effort on Windows; ACL hardening above is the security boundary.
        }
      } catch (err) {
        if (created) cleanupMoshAuthTempFiles([target]);
        throw err;
      }
      return target;
    }
    
    async function restrictMoshAuthFilePermissions(target, opts = {}) {
      if (process.platform !== "win32") return true;
    
      let username = process.env.USERNAME;
      if (!username) {
        try {
          username = os.userInfo().username;
        } catch {
          username = "";
        }
      }
      if (!username) {
        if (opts.failClosed) {
          throw new Error("Failed to restrict private key ACLs: unable to resolve current Windows user");
        }
        return false;
      }
    
      const identities = [];
      if (process.env.USERDOMAIN) identities.push(`${process.env.USERDOMAIN}\\${username}`);
      identities.push(username);
    
      let lastError = null;
      for (const identity of identities) {
        try {
          await execFileAsync("icacls.exe", [target, "/grant:r", `${identity}:F`], { windowsHide: true });
          await execFileAsync("icacls.exe", [target, "/inheritance:r"], { windowsHide: true });
          await execFileAsync("icacls.exe", [target, "/grant:r", `${identity}:F`], { windowsHide: true });
          return true;
        } catch (err) {
          lastError = err;
        }
      }
    
      const message = lastError?.message || String(lastError || "unknown error");
      if (opts.failClosed) {
        throw new Error(`Failed to restrict private key ACLs: ${message}`);
      }
      console.warn("[Mosh] Failed to restrict private key ACLs:", message);
      return false;
    }
    
    function cleanupMoshAuthTempFiles(files) {
      for (const file of files || []) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Best effort cleanup; Settings > System can clear Netcatty temp files.
        }
      }
    }
    
    async function buildMoshSshAuthArgs(options, sessionId) {
      const sshArgs = [];
      const tempFiles = [];
    
      try {
        if (typeof options.privateKey === "string" && options.privateKey.trim().length > 0) {
          const keyPath = await writeMoshAuthTempFile(
            safeMoshAuthFileName(sessionId, options.keyId, ".pem"),
            options.privateKey,
          );
          tempFiles.push(keyPath);
          sshArgs.push("-i", keyPath, "-o", "IdentitiesOnly=yes");
    
          if (typeof options.certificate === "string" && options.certificate.trim().length > 0) {
            const certPath = await writeMoshAuthTempFile(
              safeMoshAuthFileName(sessionId, options.keyId, "-cert.pub"),
              options.certificate,
            );
            tempFiles.push(certPath);
            sshArgs.push("-o", `CertificateFile=${certPath}`);
          }
        } else if (Array.isArray(options.identityFilePaths) && options.identityFilePaths.length > 0) {
          for (const keyPath of options.identityFilePaths) {
            const normalized = normalizeMoshIdentityPath(keyPath);
            if (normalized) sshArgs.push("-i", normalized);
          }
          if (sshArgs.length > 0) {
            sshArgs.push("-o", "IdentitiesOnly=yes");
          }
          if (typeof options.certificate === "string" && options.certificate.trim().length > 0) {
            const certPath = await writeMoshAuthTempFile(
              safeMoshAuthFileName(sessionId, options.keyId, "-cert.pub"),
              options.certificate,
            );
            tempFiles.push(certPath);
            sshArgs.push("-o", `CertificateFile=${certPath}`);
          }
        }
      } catch (err) {
        cleanupMoshAuthTempFiles(tempFiles);
        throw err;
      }
    
      return { sshArgs, tempFiles };
    }
    
    /**
     * Phase-2 / Phase-3b path: run the SSH bootstrap ourselves *inside the
     * user's terminal PTY* so password / 2FA / known-hosts prompts render
     * naturally, then swap to a bare `mosh-client` once `MOSH CONNECT` is
     * detected. Replaces both the upstream Mosh Perl wrapper and the
     * earlier non-PTY (BatchMode-style) implementation that couldn't show
     * prompts.
     *
     * State machine:
     *   ssh-spawn ──onData──▶ sniffer.feed ──visible──▶ renderer
     *                                  └──parsed──▶ remember port/key
     *   ssh-pty exits  ─────▶ if parsed: spawn mosh-client + swap
     *                          else: surface error
     *
     * The session keeps a stable sessionId across the swap. session.proc
     * is updated atomically before any user input arrives at the new
     * mosh-client (writeToSession / resizeSession route through
     * session.proc, so they automatically address the right process). The
     * ZMODEM sentry is recreated for the new proc because its
     * writeToRemote closure captures the previous handle.
     *
     * Caller has already validated that `bareClient` and `sshExe` exist.
     */
    async function startMoshSessionViaHandshake(event, options, { bareClient, sshExe }) {
      const sessionId = options.sessionId || randomUUID();
      const cols = options.cols || 80;
      const rows = options.rows || 24;
      const optionsEnv = options.env || {};
      const lang = optionsEnv.LANG || resolveLangFromCharsetForMosh(options.charset);
      const moshAuth = await buildMoshSshAuthArgs(options, sessionId);
    
      const { args: sshArgs } = moshHandshake.buildSshHandshakeCommand({
        host: options.hostname,
        port: options.port,
        username: options.username,
        lang,
        moshServer: moshHandshake.buildMoshServerCommand(options.moshServerPath),
        sshArgs: moshAuth.sshArgs,
      });
    
      const { buildTerminalProcessEnv } = require("../httpNetworkProxyBridge.cjs");
      const sshEnv = { ...buildTerminalProcessEnv(process.env), ...optionsEnv, TERM: "xterm-256color" };
      // macOS Terminal/iTerm export LC_CTYPE=UTF-8 (a bare value, not a real
      // locale name). System ssh_config has `SendEnv LC_*`, so without scrubbing
      // these the remote shell tries to setlocale("UTF-8") and prints a warning
      // on every connection. mosh-server sets the locale it needs separately.
      for (const key of Object.keys(sshEnv)) {
        if (key.startsWith("LC_")) delete sshEnv[key];
      }
      if (options.agentForwarding && process.env.SSH_AUTH_SOCK) {
        sshEnv.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
      }
    
      let sshPty;
      try {
        sshPty = pty.spawn(sshExe, sshArgs, {
          cols,
          rows,
          env: sshEnv,
          cwd: os.homedir(),
          encoding: null,
        });
      } catch (err) {
        cleanupMoshAuthTempFiles(moshAuth.tempFiles);
        throw err;
      }
    
      const session = {
        proc: sshPty,
        pty: sshPty,
        type: "mosh",
        protocol: "mosh",
        webContentsId: event.sender.id,
        hostname: options.hostname || "",
        username: options.username || "",
        label: options.label || options.hostname || "Mosh Session",
        // Leave unset so ensureSessionShellKind can probe via companion SSH
        // exec before AI wrappers (fish login shells — issue #1854).
        shellKind: undefined,
        _shellKindExecProbe: async (command, timeoutMs) => {
          if (typeof ensureMoshStatsConnection !== "function") return null;
          const contents = electronModule?.webContents?.fromId?.(session.webContentsId);
          const conn = await withShellProbeTimeout(
            ensureMoshStatsConnection(session, sessionId, contents),
            timeoutMs,
          );
          const probe = createSshConnExecProbe(conn);
          return probe ? probe(command, timeoutMs) : null;
        },
        shellExecutable: "remote-shell",
        flushPendingData: null,
        lastIdlePrompt: "",
        lastIdlePromptAt: 0,
        _promptTrackTail: "",
        cols,
        rows,
        moshHandshakePhase: "ssh",
        moshHandshakeResult: null,
        moshAuthTempFiles: moshAuth.tempFiles,
      };
      sessions.set(sessionId, session);
      openTerminalOutputSession?.(sessionId, event.sender);
    
      let logStreamToken = null;
      if (options.sessionLog?.enabled && options.sessionLog?.directory) {
        logStreamToken = sessionLogStreamManager.startStream(sessionId, {
          hostLabel: options.label || options.hostname,
          hostname: options.hostname,
          directory: options.sessionLog.directory,
          format: options.sessionLog.format || "txt",
          timestampsEnabled: Boolean(options.sessionLog.timestampsEnabled),
          startTime: Date.now(),
        });
      }
      // Expose the token so swapToMoshClient can keep using it after the
      // handshake hand-off; the new mc-pty's exit handler will also rely on
      // it to scope its stopStream call.
      session.logStreamToken = logStreamToken;
    
      const {
        bufferData,
        flush,
        flushPaced,
        discard,
      } = createPtyOutputBuffer((data, meta) => {
        const contents = electronModule.webContents.fromId(session.webContentsId);
        emitTerminalSessionData(contents, sessionId, data, {
          cols: session.cols,
          rows: session.rows,
          meta,
        });
      }, {
        onPendingBytesChange: (bytes) => setBufferedOutputBytes(session, bytes),
        shouldAcceptOutput: () => shouldAcceptSessionOutput(session),
      });
      session.flushPendingData = flushPaced;
      session.discardPendingData = discard;
    
      const sniffer = moshHandshake.createMoshConnectSniffer();
      const respondToPasswordPrompt = createMoshSshPasswordResponder(sshPty, options.password, options.passphrase);
    
      // Forward bytes from the ssh PTY to the renderer, redacting the
      // MOSH CONNECT magic line. ZMODEM is intentionally not enabled
      // during handshake — it can't appear during ssh login output and
      // would only complicate the swap.
      sshPty.onData((chunk) => {
        const { visible, parsed } = sniffer.feed(chunk);
        if (visible && (visible.length || (typeof visible === "string" && visible))) {
          const str = Buffer.isBuffer(visible) ? visible.toString("utf8") : visible;
          if (str.length > 0) {
            respondToPasswordPrompt(str);
            bufferData(str);
            sessionLogStreamManager.appendData(sessionId, str);
          }
        }
        if (parsed && session.moshHandshakePhase === "ssh") {
          session.moshHandshakePhase = "parsed";
          session.moshHandshakeResult = parsed;
        }
      });
    
      sshPty.onExit(({ exitCode, signal }) => {
        if (sessions.get(sessionId) !== session || session.closed) {
          cleanupMoshAuthTempFiles(moshAuth.tempFiles);
          return;
        }
        cleanupMoshAuthTempFiles(moshAuth.tempFiles);

        // Final chance: ConPTY / ssh often ends the stream on the MOSH CONNECT
        // line with no trailing newline. Flush the sniffer's pending buffer so
        // we still swap to mosh-client (issue #2025).
        if (session.moshHandshakePhase === "ssh") {
          const flushed = sniffer.flush();
          if (flushed.visible && (flushed.visible.length || (typeof flushed.visible === "string" && flushed.visible))) {
            const str = Buffer.isBuffer(flushed.visible) ? flushed.visible.toString("utf8") : flushed.visible;
            if (str.length > 0) {
              bufferData(str);
              sessionLogStreamManager.appendData(sessionId, str);
            }
          }
          if (flushed.parsed) {
            session.moshHandshakePhase = "parsed";
            session.moshHandshakeResult = flushed.parsed;
          }
        }
    
        if (session.moshHandshakePhase === "parsed" && session.moshHandshakeResult) {
          try {
            swapToMoshClient(session, options, {
              bareClient,
              optionsEnv,
              lang,
              parsed: session.moshHandshakeResult,
              bufferData,
              flush,
              flushPaced,
              sessionId,
            });
          } catch (err) {
            flushPaced(() => {
              sessionLogStreamManager.stopStream(sessionId, logStreamToken);
              const contents = electronModule.webContents.fromId(session.webContentsId);
              contents?.send("netcatty:exit", {
                sessionId,
                reason: "error",
                error: `Failed to spawn mosh-client: ${err.message}`,
              });
              closeTerminalOutputSession?.(sessionId);
              sessions.delete(sessionId);
            });
          }
          return;
        }
    
        // Handshake failed before MOSH CONNECT — ssh exited without parse.
        // The user has already seen the failure output (auth error, host
        // key warning, etc). Just surface a session-exit with the code so
        // the renderer can label the session "disconnected".
        flushPaced(() => {
          sessionLogStreamManager.stopStream(sessionId, logStreamToken);
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("netcatty:exit", {
            sessionId,
            exitCode,
            signal,
            reason: "error",
          });
          closeTerminalOutputSession?.(sessionId);
          sessions.delete(sessionId);
        });
      });
    
      return { sessionId };
    }
    
    /**
     * Mid-session PTY swap: replaces session.proc (currently the ssh
     * handshake PTY) with a freshly-spawned mosh-client PTY, re-wiring
     * the data / exit listeners and (on POSIX) recreating the ZMODEM
     * sentry whose writeToRemote closure captured the previous handle.
     */
    function swapToMoshClient(session, options, ctx) {
      const { bareClient, optionsEnv, lang, parsed, bufferData, flush, flushPaced, sessionId } = ctx;
    
      const { buildTerminalProcessEnv } = require("../httpNetworkProxyBridge.cjs");
      const env = moshHandshake.buildMoshClientEnv({
        baseEnv: { ...buildTerminalProcessEnv(process.env), ...optionsEnv, TERM: "xterm-256color" },
        key: parsed.key,
        lang,
      });
      // Netcatty owns the terminal buffer. Keeping MoshCatty on the primary
      // screen preserves scrollback and lets renderer features such as keyword
      // highlighting keep observing the active buffer.
      env.MOSH_NO_TERM_INIT = "1";
      addBundledMoshRuntimeEnv(env, bareClient);
      if (options.agentForwarding && process.env.SSH_AUTH_SOCK) {
        env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
      }
    
      const { command, args: clientArgs } = moshHandshake.buildMoshClientCommand({
        moshClientPath: bareClient,
        host: parsed.host || options.hostname,
        port: parsed.port,
      });
    
      const mcPty = pty.spawn(command, clientArgs, {
        cols: session.cols,
        rows: session.rows,
        env,
        cwd: os.homedir(),
        encoding: null,
      });
    
      // Atomic swap — writeToSession / resizeSession both read
      // session.proc lazily, so any keystroke that arrives after this
      // assignment goes to mosh-client, not the dead ssh PTY.
      session.proc = mcPty;
      session.pty = mcPty;
      session.moshHandshakePhase = "mosh-client";

      // The SSH handshake just succeeded, so these credentials are known
      // good. Stash them so sshBridge can lazily open a best-effort companion
      // SSH connection for host-info stats (CPU/mem/disk), which Mosh's UDP
      // channel cannot provide on its own (issue #1198). Only credentials
      // Netcatty already holds are kept — a password typed interactively into
      // the handshake PTY is not captured, so that case degrades gracefully.
      session.moshStatsAuth = {
        // Use the configured SSH host, NOT parsed.host: a `MOSH IP` line
        // advertises the UDP endpoint for mosh-client, which can differ from
        // the SSH endpoint on NAT / multi-homed hosts. The companion is an
        // SSH connection, so it must target the same host the handshake's ssh
        // did.
        hostname: options.hostname,
        port: options.port || 22,
        username: options.username,
        password: options.password,
        privateKey: options.privateKey,
        passphrase: options.passphrase,
        certificate: options.certificate,
        keyId: options.keyId,
        identityFilePaths: options.identityFilePaths,
        legacyAlgorithms: options.legacyAlgorithms,
        skipEcdsaHostKey: options.skipEcdsaHostKey,
        algorithmOverrides: options.algorithmOverrides,
        // Used to verify the host key before the companion sends a saved
        // password (see moshStatsConnection.cjs). Public-key / agent auth
        // does not depend on this.
        knownHosts: options.knownHosts,
        verifyHostKeys: options.verifyHostKeys,
      };
      session.systemManagerSudoPassword = typeof options.sudoAutofillPassword === "string" && options.sudoAutofillPassword.length > 0
        ? options.sudoAutofillPassword
        : undefined;
    
      if (process.platform !== "win32") {
        const decoder = new StringDecoder("utf8");
        const sentry = createZmodemSentry({
          sessionId,
          onData(buf) {
            const str = decoder.write(buf);
            if (!str) return;
            trackSessionIdlePrompt(session, str);
            bufferData(str);
            sessionLogStreamManager.appendData(sessionId, str);
          },
          writeToRemote(buf) {
            try { return mcPty.write(buf); } catch { return true; }
          },
          getWebContents() { return electronModule.webContents.fromId(session.webContentsId); },
          selectUploadFiles: selectZmodemUploadFiles
            ? () => selectZmodemUploadFiles(session.webContentsId)
            : undefined,
          selectDownloadDirectory: selectZmodemDownloadDirectory
            ? () => selectZmodemDownloadDirectory(session.webContentsId)
            : undefined,
          protocolLabel: "Mosh",
        });
        session.zmodemSentry = sentry;
        mcPty.onData((data) => {
          if (!shouldProcessSessionOutput(session, sentry)) return;
          sentry.consume(data);
        });
      } else {
        const decodeMoshOutput = createMoshUtf8Decoder();
        mcPty.onData((data) => {
          if (!shouldProcessSessionOutput(session)) return;
          const str = decodeMoshOutput(data);
          if (!str) return;
          trackSessionIdlePrompt(session, str);
          bufferData(str);
          sessionLogStreamManager.appendData(sessionId, str);
        });
      }
    
      mcPty.onExit(({ exitCode, signal }) => {
        if (sessions.get(sessionId) !== session || session.closed) {
          return;
        }
        // Tear down the host-info stats companion ssh2 connection (issue
        // #1198) if one was opened — it lives on moshStatsConn and outlives
        // the mosh-client PTY otherwise.
        try { session.moshStatsConn?.end(); } catch { /* ignore */ }
        bufferData(MOSH_PRIMARY_SCREEN_RESET);
        flushPaced(() => {
          sessionLogStreamManager.stopStream(sessionId, session.logStreamToken);
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("netcatty:exit", {
            sessionId,
            exitCode,
            signal,
            reason: exitCode !== 0 ? "error" : "exited",
          });
          closeTerminalOutputSession?.(sessionId);
          sessions.delete(sessionId);
        });
      });
    }
    
    function resolveLangFromCharsetForMosh(charset) {
      if (!charset) return "en_US.UTF-8";
      const trimmed = String(charset).trim();
      if (/^utf-?8$/i.test(trimmed) || /^utf8$/i.test(trimmed)) return "en_US.UTF-8";
      return trimmed;
    }
    
    /**
     * Start a Mosh session.
     *
     * Netcatty only uses its bundled `mosh-client` binary here. System
     * `mosh` / `mosh-client` installs are intentionally ignored so dev,
     * CI, and release builds exercise the same binary.
     */
    async function startMoshSession(event, options, opts = {}) {
      const optionsEnv = options.env || {};
      // Program discovery must consider the same PATH the spawned PTY will
      // receive, including host-level terminal environment overrides.
      const mergedPathForResolution = Object.prototype.hasOwnProperty.call(optionsEnv, "PATH")
        ? optionsEnv.PATH
        : process.env.PATH;
    
      const bareClient = resolveBareMoshClient(options, opts.moshClientLookup || {});
      if (!bareClient) {
        throw new Error(
          "Bundled mosh-client not found. Run `npm run fetch:mosh:dev` for local dev, " +
          "or ensure release packaging downloads the mosh binary release before building.",
        );
      }
    
      const sshExe = moshHandshake.resolveSshExecutable({
        findExecutable: (name) => (
          process.platform === "win32"
            ? findExecutable(name, { pathOverride: mergedPathForResolution })
            : resolvePosixExecutable(name, { pathOverride: mergedPathForResolution })
        ),
        fileExists: (p) => isExecutableFile(p) || fs.existsSync(p),
      });
      if (!sshExe) {
        throw new Error("OpenSSH client not found. Netcatty needs ssh to start the remote mosh-server handshake.");
      }
    
      return startMoshSessionViaHandshake(event, options, { bareClient, sshExe });
    }

    return {
      resolveBareMoshClient,
      addBundledMoshRuntimeEnv,
      createMoshUtf8Decoder,
      buildMoshSshAuthArgs,
      cleanupMoshAuthTempFiles,
      startMoshSessionViaHandshake,
      swapToMoshClient,
      resolveLangFromCharsetForMosh,
      startMoshSession,
    };
  }
}

module.exports = { createMoshSessionApi };
