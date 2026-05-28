/* eslint-disable no-undef */
function createMoshSessionApi(ctx) {
  with (ctx) {
    function resolveBareMoshClient(_options, opts = {}) {
      return bundledMoshClient(opts);
    }
    
    function getEnvPathKey(env) {
      const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
      if (pathKeys.length === 0) return "PATH";
      return pathKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
    }
    
    function getEnvPathDelimiter(opts = {}) {
      return (opts.platform || process.platform) === "win32" ? ";" : path.delimiter;
    }
    
    function normalizeEnvPathPart(part, opts = {}) {
      const pathApi = (opts.platform || process.platform) === "win32" ? path.win32 : path;
      return pathApi.normalize(part).toLowerCase();
    }
    
    function prependEnvPath(env, dir, opts = {}) {
      if (!dir) return env;
      const pathKey = getEnvPathKey(env);
      const duplicatePathKeys = Object.keys(env)
        .filter((key) => key.toLowerCase() === "path" && key !== pathKey);
      for (const key of duplicatePathKeys) {
        delete env[key];
      }
      const current = env[pathKey] || "";
      const delimiter = getEnvPathDelimiter(opts);
      const parts = String(current).split(delimiter).filter(Boolean);
      const normalizedDir = normalizeEnvPathPart(dir, opts);
      if (!parts.some((part) => normalizeEnvPathPart(part, opts) === normalizedDir)) {
        env[pathKey] = current ? `${dir}${delimiter}${current}` : dir;
      }
      return env;
    }
    
    function findBundledMoshDllDir(bareClient, opts = {}) {
      const platform = opts.platform || process.platform;
      if (platform !== "win32" || !bareClient) return null;
    
      const clientDir = path.dirname(bareClient);
      const arch = opts.arch || process.arch;
      const preferred = path.join(clientDir, `mosh-client-win32-${arch}-dlls`);
      if (fs.existsSync(preferred) && fs.statSync(preferred).isDirectory()) {
        return preferred;
      }
    
      try {
        const match = fs.readdirSync(clientDir)
          .map((name) => path.join(clientDir, name))
          .find((candidate) => {
            const name = path.basename(candidate);
            return /^mosh-client-win32-.+-dlls$/.test(name)
              && fs.existsSync(candidate)
              && fs.statSync(candidate).isDirectory();
          });
        return match || null;
      } catch {
        return null;
      }
    }
    
    function addBundledMoshDllPath(env, bareClient, opts = {}) {
      const dllDir = findBundledMoshDllDir(bareClient, opts);
      return dllDir ? prependEnvPath(env, dllDir, opts) : env;
    }
    
    function findBundledMoshTerminfoDir(bareClient, _opts = {}) {
      if (!bareClient) return null;
      const terminfoDir = path.join(path.dirname(bareClient), "terminfo");
      const hasXterm256 =
        fs.existsSync(path.join(terminfoDir, "x", "xterm-256color")) ||
        fs.existsSync(path.join(terminfoDir, "78", "xterm-256color"));
      return hasXterm256 ? terminfoDir : null;
    }
    
    // Standard locations where distros / package managers install the compiled
    // terminfo database. Used as a fallback only — the bundled directory ships
    // with the mosh release and is preferred. See issue #890 for context.
    const LINUX_SYSTEM_TERMINFO_DIRS = [
      "/etc/terminfo",
      "/lib/terminfo",
      "/usr/share/terminfo",
      "/usr/lib/terminfo",
    ];
    
    const DARWIN_SYSTEM_TERMINFO_DIRS = [
      "/usr/share/terminfo",
      "/opt/homebrew/share/terminfo",
      "/usr/local/share/terminfo",
      "/opt/local/share/terminfo",
    ];
    
    function addBundledMoshTerminfoEnv(env, bareClient, opts = {}) {
      const platform = opts.platform || process.platform;
      const terminfoDir = findBundledMoshTerminfoDir(bareClient, opts);
    
      if (platform === "win32") {
        if (!terminfoDir) return env;
        env.TERMINFO = terminfoDir;
        env.TERMINFO_DIRS = terminfoDir;
        return env;
      }
    
      // POSIX. The bundled terminfo is the source of truth — our static
      // ncurses' compiled-in default points at a build-time temp dir that no
      // longer exists on the user's machine. Fall back to standard distro
      // paths when the bundle is absent (e.g. running against an older mosh
      // binary release that pre-dates the bundle). A caller-supplied
      // TERMINFO_DIRS is preserved between the bundle and the system defaults.
      const existing = (typeof env.TERMINFO_DIRS === "string" && env.TERMINFO_DIRS.length > 0)
        ? env.TERMINFO_DIRS.split(":").filter(Boolean)
        : [];
      const systemDirs = platform === "darwin" ? DARWIN_SYSTEM_TERMINFO_DIRS : LINUX_SYSTEM_TERMINFO_DIRS;
      const dirs = [];
      if (terminfoDir) dirs.push(terminfoDir);
      for (const dir of existing) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
      for (const dir of systemDirs) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
      if (terminfoDir) {
        env.TERMINFO = terminfoDir;
      }
      env.TERMINFO_DIRS = dirs.join(":");
      return env;
    }
    
    function addBundledMoshRuntimeEnv(env, bareClient, opts = {}) {
      addBundledMoshDllPath(env, bareClient, opts);
      addBundledMoshTerminfoEnv(env, bareClient, opts);
      return env;
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
    
      const sshEnv = { ...process.env, ...optionsEnv, TERM: "xterm-256color" };
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
        shellKind: "posix",
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
    
      let logStreamToken = null;
      if (options.sessionLog?.enabled && options.sessionLog?.directory) {
        logStreamToken = sessionLogStreamManager.startStream(sessionId, {
          hostLabel: options.label || options.hostname,
          hostname: options.hostname,
          directory: options.sessionLog.directory,
          format: options.sessionLog.format || "txt",
          startTime: Date.now(),
        });
      }
      // Expose the token so swapToMoshClient can keep using it after the
      // handshake hand-off; the new mc-pty's exit handler will also rely on
      // it to scope its stopStream call.
      session.logStreamToken = logStreamToken;
    
      const { bufferData, flush } = createPtyOutputBuffer((data) => {
        const contents = electronModule.webContents.fromId(session.webContentsId);
        contents?.send("netcatty:data", { sessionId, data });
      });
      session.flushPendingData = flush;
    
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
    
        if (session.moshHandshakePhase === "parsed" && session.moshHandshakeResult) {
          try {
            swapToMoshClient(session, options, {
              bareClient,
              optionsEnv,
              lang,
              parsed: session.moshHandshakeResult,
              bufferData,
              flush,
              sessionId,
            });
          } catch (err) {
            flush();
            sessionLogStreamManager.stopStream(sessionId, logStreamToken);
            const contents = electronModule.webContents.fromId(session.webContentsId);
            contents?.send("netcatty:exit", {
              sessionId,
              reason: "error",
              error: `Failed to spawn mosh-client: ${err.message}`,
            });
            sessions.delete(sessionId);
          }
          return;
        }
    
        // Handshake failed before MOSH CONNECT — ssh exited without parse.
        // The user has already seen the failure output (auth error, host
        // key warning, etc). Just surface a session-exit with the code so
        // the renderer can label the session "disconnected".
        flush();
        sessionLogStreamManager.stopStream(sessionId, logStreamToken);
        const contents = electronModule.webContents.fromId(session.webContentsId);
        contents?.send("netcatty:exit", {
          sessionId,
          exitCode,
          signal,
          reason: "error",
        });
        sessions.delete(sessionId);
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
      const { bareClient, optionsEnv, lang, parsed, bufferData, flush, sessionId } = ctx;
    
      const env = moshHandshake.buildMoshClientEnv({
        baseEnv: { ...process.env, ...optionsEnv, TERM: "xterm-256color" },
        key: parsed.key,
        lang,
      });
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
          protocolLabel: "Mosh",
        });
        session.zmodemSentry = sentry;
        mcPty.onData((data) => sentry.consume(data));
      } else {
        mcPty.onData((data) => {
          const str = data.toString("utf8");
          trackSessionIdlePrompt(session, str);
          bufferData(str);
          sessionLogStreamManager.appendData(sessionId, str);
        });
      }
    
      mcPty.onExit(({ exitCode, signal }) => {
        if (sessions.get(sessionId) !== session || session.closed) {
          return;
        }
        flush();
        sessionLogStreamManager.stopStream(sessionId, session.logStreamToken);
        const contents = electronModule.webContents.fromId(session.webContentsId);
        contents?.send("netcatty:exit", {
          sessionId,
          exitCode,
          signal,
          reason: exitCode !== 0 ? "error" : "exited",
        });
        sessions.delete(sessionId);
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
      addBundledMoshDllPath,
      addBundledMoshTerminfoEnv,
      addBundledMoshRuntimeEnv,
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
