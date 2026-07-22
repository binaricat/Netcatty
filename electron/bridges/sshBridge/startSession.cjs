/* eslint-disable no-undef */
const { emitTerminalSessionData } = require("../emitTerminalSessionData.cjs");
const {
  setBufferedOutputBytes,
  shouldAcceptSessionOutput,
  shouldProcessSessionOutput,
} = require("../terminalFlowAck.cjs");
const {
  filterTerminalInterruptOutput,
  takePendingInterruptOutputMeta,
} = require("../terminalInterruptOutputGate.cjs");
const {
  logTerminalInterruptDrainDropSample,
  logTerminalOutputDropSample,
} = require("../terminalInterruptDiagnostics.cjs");
const { runWhenProxyConnectionReady } = require("../proxyUtils.cjs");
const { getAttachHomeWebContentsId } = require("../terminalAttachRestore.cjs");

const SSH_TCP_CONNECT_TIMEOUT_MS = 20000;
const SSH_AUTH_READY_TIMEOUT_MS = 120000;
const MAX_SSH_CONNECTION_TIMEOUT_MS = 3600000;

/**
 * Fan out netcatty:exit to the primary contents plus any attach-home owner
 * (AI observe popup rebind) so neither side is left stale.
 */
function safeSendSessionExit(ctx, primaryContents, sessionId, payload) {
  const { safeSend, electronModule, sessions } = ctx;
  const seen = new Set();
  const sendTo = (contents) => {
    if (!contents || typeof contents.id !== "number" || seen.has(contents.id)) return;
    seen.add(contents.id);
    try {
      safeSend(contents, "netcatty:exit", payload);
    } catch {
      // ignore destroyed renderers
    }
  };
  sendTo(primaryContents);
  try {
    const live = sessions?.get?.(sessionId);
    if (typeof live?.webContentsId === "number") {
      sendTo(electronModule?.webContents?.fromId?.(live.webContentsId));
    }
  } catch {
    // ignore
  }
  try {
    const homeId = getAttachHomeWebContentsId(sessionId);
    if (typeof homeId === "number") {
      sendTo(electronModule?.webContents?.fromId?.(homeId));
    }
  } catch {
    // ignore
  }
}

function normalizeSshConnectionTimeoutMs(value, fallback) {
  return Number.isFinite(value) && value >= 1000 && value <= MAX_SSH_CONNECTION_TIMEOUT_MS
    ? Math.round(value)
    : fallback;
}

function resolveSshConnectionTimeouts(options = {}) {
  return {
    tcpConnectTimeoutMs: normalizeSshConnectionTimeoutMs(
      options.sshTcpConnectTimeoutMs,
      SSH_TCP_CONNECT_TIMEOUT_MS,
    ),
    authReadyTimeoutMs: normalizeSshConnectionTimeoutMs(
      options.sshAuthReadyTimeoutMs,
      SSH_AUTH_READY_TIMEOUT_MS,
    ),
  };
}

function isSshAuthFailure(err) {
  const message = err?.message?.toLowerCase() || "";
  return err?.level === "client-authentication" ||
    message.includes("all configured authentication methods failed") ||
    message.includes("authentication failed") ||
    message.includes("too many authentication failures") ||
    /permission denied\s*\(/.test(message) ||
    message.includes("no authentication methods available");
}

function hasSelectedAgentIdentity(options) {
  const hasInlinePublicKey = Array.isArray(options?.agentPublicKeys)
    && options.agentPublicKeys.some((key) => typeof key === "string" && key.trim().length > 0);
  const hasReferencedIdentity = Array.isArray(options?.identityFilePaths)
    && options.identityFilePaths.some((filePath) => typeof filePath === "string" && filePath.trim().length > 0);
  return hasInlinePublicKey || hasReferencedIdentity;
}

function shouldOfferAgentForLogin(options, connectOpts) {
  const selectedMethod = options?.authMethod;
  const hasRestrictedSelectedAgent = selectedMethod === "key"
    && options?.useSshAgent === true
    && options?.identitiesOnly === true
    && hasSelectedAgentIdentity(options);
  const isStrictMethod = selectedMethod === "password"
    || selectedMethod === "key"
    || selectedMethod === "certificate";
  return (!isStrictMethod || hasRestrictedSelectedAgent)
    && options?.useSshAgent !== false
    && Boolean(connectOpts?.agent);
}

function shouldPrepareSystemAgentForLogin(options) {
  if (options?.authMethod === "password" || options?.authMethod === "certificate") return false;
  if (options?.authMethod !== "key") return true;
  return options?.useSshAgent === true
    && options?.identitiesOnly === true
    && hasSelectedAgentIdentity(options);
}

function resolveUnlockedEncryptedKeysForAuth(options, strictAgentSelection) {
  const selectedMethod = options?.authMethod;
  const hasStrictMethod = selectedMethod === "password"
    || selectedMethod === "key"
    || selectedMethod === "certificate";
  return strictAgentSelection || hasStrictMethod ? [] : (options?._unlockedEncryptedKeys || []);
}

function shouldPromoteCachedAuthMethod(authMethod, cachedMethod) {
  if (!cachedMethod) return false;
  if (authMethod === "auto") {
    return cachedMethod === "agent" || cachedMethod.startsWith("publickey");
  }
  if (authMethod === "password" || authMethod === "key" || authMethod === "certificate") {
    return false;
  }
  return true;
}

function createStartSessionApi(ctx) {
  with (ctx) {
    const listInteractiveShellPids = (conn) => {
      if (!conn || typeof conn.exec !== "function") {
        return Promise.resolve({ available: false, pids: [] });
      }

      const scanCompleteMarker = "__NETCATTY_SHELL_SCAN_COMPLETE__";
      const script = `SELF=$$
ps_output=$(ps -e -o pid=,ppid=,tty=,comm= 2>/dev/null) || exit 69
{
  printf '%s\n' "$ps_output" | awk -v pp="$PPID" -v self="$SELF" '
    $1 != self && $2 == pp && $3 != "?" && $4 ~ /^-?(ba|z|fi|k|da|a|c|tc)?sh$/ { print $1 }
  '
  if [ -r /proc/$SELF/environ ]; then
    conn=$(tr '\\0' '\\n' < /proc/$SELF/environ 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
    if [ -n "$conn" ]; then
      for d in /proc/[0-9]*; do
        pid=$(basename "$d")
        [ "$pid" = "$SELF" ] && continue
        [ -r "$d/environ" ] || continue
        conn2=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
        [ "$conn2" = "$conn" ] || continue
        comm=$(cat "$d/comm" 2>/dev/null)
        case "$comm" in sh|bash|zsh|fish|ksh|dash|ash|csh|tcsh) ;; *) continue ;; esac
        ppid=$(awk '{ print $4 }' "$d/stat" 2>/dev/null)
        pcomm=$(cat "/proc/$ppid/comm" 2>/dev/null)
        case "$pcomm" in sshd|dropbear|dropbearmulti) ;; *) continue ;; esac
        tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d '[:space:]')
        [ -n "$tty" ] && [ "$tty" != "?" ] && printf '%s\\n' "$pid"
      done
    fi
  fi
} | awk '/^[0-9]+$/ && !seen[$1]++ { print $1 }'
printf '%s\n' '${scanCompleteMarker}'`;

      return new Promise((resolve) => {
        let settled = false;
        let activeStream = null;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          try { activeStream?.close?.(); } catch { /* ignore */ }
          settle({ available: false, pids: [] });
        }, 1500);

        try {
          conn.exec(`exec sh -c ${quoteShellArg(script)}`, (err, stream) => {
            if (err || !stream) {
              settle({ available: false, pids: [] });
              return;
            }
            activeStream = stream;
            let stdout = "";
            let exitStatus = null;
            stream.on("data", (chunk) => { stdout += chunk.toString(); });
            stream.stderr?.on("data", () => {});
            stream.on("exit", (code) => {
              if (typeof code === "number") exitStatus = code;
            });
            stream.on("close", (code) => {
              const effectiveExitStatus = typeof code === "number" ? code : exitStatus;
              const lines = stdout.split(/\r?\n/);
              const completed = lines.includes(scanCompleteMarker);
              const available = completed && (effectiveExitStatus === null || effectiveExitStatus === 0);
              settle({
                available,
                pids: available ? lines.filter((value) => /^\d+$/.test(value)) : [],
              });
            });
          });
        } catch {
          settle({ available: false, pids: [] });
        }
      });
    };

    const waitForNewInteractiveShellPid = async (conn, previousPids) => {
      const previous = new Set(previousPids);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const discovery = await listInteractiveShellPids(conn);
        if (!discovery.available) return null;
        const newPids = discovery.pids.filter((pid) => !previous.has(pid));
        if (newPids.length === 1) return newPids[0];
        if (newPids.length > 1) return null;
        if (attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
      return null;
    };

    /**
     * Wire up a freshly-opened shell channel (PTY stream) for a session:
     * output buffering, ZMODEM handling, encoding, exit/close reporting and
     * teardown. Shared by both the fresh-connection path and the connection
     * reuse path (issue #1204) so duplicated tabs behave identically to the
     * original tab once their channel is open.
     *
     * `isReused` only affects diagnostics/log labelling; lifecycle correctness
     * is governed entirely by the reference-counted connection descriptor
     * (sshConnectionPool.cjs). The stream "close"/transport handlers always
     * release this session's hold via releaseConnectionRef, which tears the
     * shared transport down only when the last channel is gone.
     */
    function setupShellSession({
      conn,
      stream,
      options,
      sessionId,
      event,
      log,
      detachX11Forwarding,
      chainConnections,
      isReused,
    }) {
      const session = {
        conn,
        stream,
        // Only the owning (fresh) session is responsible for the jump-host
        // chain; reused channels share it via the connRef descriptor and must
        // not carry their own copy (otherwise closing a reused tab would end
        // the chain out from under its siblings).
        chainConnections: isReused ? [] : chainConnections,
        webContentsId: event.sender.id,
        // Store connection info for MCP host discovery
        hostname: options.host || options.hostname || '',
        username: options.username || '',
        label: options.label || '',
        // Host file-transfer preference for session-backed SFTP/SCP opens
        // (Catty/MCP/clipboard paste call openSftpForSession without protocol).
        sftpFileProtocol: options.sftpFileProtocol || options.fileProtocol || 'auto',
        systemManagerSudoPassword: typeof options.sudoAutofillPassword === 'string' && options.sudoAutofillPassword.length > 0
          ? options.sudoAutofillPassword
          : undefined,
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
        // The actual SSH target this connection authenticated to. Used to make
        // sure a "Copy Tab" reuse opens its channel on a connection going to the
        // *same* host — a saved host edited after the source connected must not
        // silently run commands on the old machine (issue #1204 review).
        _reuseEndpoint: {
          hostname: options.hostname || '',
          port: options.port || 22,
          username: options.username || 'root',
        },
        tcpLatencyDirect:
          !Array.isArray(options.jumpHosts) || options.jumpHosts.length === 0
            ? !options.proxy
            : false,
        cols: options.cols || 80,
        rows: options.rows || 24,
      };
      sessions.set(sessionId, session);
      openTerminalOutputSession?.(sessionId, event.sender);

      // Attach the shared connection descriptor to this session. The caller owns
      // the reference *count*: the fresh-connection path calls createConnectionRef
      // after this returns; the reuse path calls acquireConnectionRef *before*
      // issuing the async shell request (so the connection can't be released out
      // from under a pending channel open). We only record the descriptor here.
      if (options._connRef) {
        session.connRef = options._connRef;
      }

      // Start real-time session log stream if configured. The token is stored
      // on the session so the connection-level error/timeout/close handlers can
      // stop the stream when they clean up the owner session directly.
      let logStreamToken = null;
      if (options.sessionLog?.enabled && options.sessionLog?.directory) {
        logStreamToken = sessionLogStreamManager.startStream(sessionId, {
          hostLabel: options.hostLabel || options.hostname || '',
          hostname: options.hostname || '',
          directory: options.sessionLog.directory,
          format: options.sessionLog.format || 'txt',
          timestampsEnabled: Boolean(options.sessionLog.timestampsEnabled),
          startTime: Date.now(),
        });
      }
      session._logStreamToken = logStreamToken;

      // Coalesce shell output and deliver it to the renderer on the next
      // event-loop turn (see ptyOutputBuffer) rather than on a fixed timer,
      // so interactive echo isn't held back by the batch interval. A size
      // cap still forces an immediate flush for bursts of output.
      const {
        bufferData,
        flushPaced: flushBufferPaced,
        takePendingEntry: takePendingBuffer,
        discard: discardBuffer,
      } = createPtyOutputBuffer((data, meta) => {
        const contents = event.sender;
        const current = sessions.get(sessionId);
        emitTerminalSessionData(contents, sessionId, data, {
          cols: current?.cols,
          rows: current?.rows,
          meta,
        });
      }, {
        onPendingBytesChange: (bytes) => {
          if (sessions.get(sessionId) === session) setBufferedOutputBytes(session, bytes);
        },
        shouldAcceptOutput: () => shouldAcceptSessionOutput(sessions.get(sessionId)),
      });
      session.flushPendingData = flushBufferPaced;
      session.takePendingData = takePendingBuffer;
      session.discardPendingData = discardBuffer;

      const getCurrentSessionWebContents = () => {
        const currentId = sessions.get(sessionId)?.webContentsId;
        if (typeof currentId === "number") {
          const current = electronModule?.webContents?.fromId?.(currentId);
          if (current) return current;
        }
        return event.sender;
      };
      const getCurrentSessionWebContentsId = () =>
        getCurrentSessionWebContents()?.id ?? event.sender.id;

      const sshZmodemSentry = createZmodemSentry({
        sessionId,
        onData(buf) {
          const decoder = getSessionDecoder(sessionId, "stdout");
          const decoded = decoder.write(buf);
          const output = filterTerminalInterruptOutput(session, decoded);
          if (!output.accepted) {
            logTerminalInterruptDrainDropSample(session, {
              sessionId,
              stream: "stdout",
              droppedBytes: output.droppedBytes,
              reason: output.reason,
              accepted: false,
            });
            return;
          }
          if (output.droppedBytes > 0) {
            logTerminalInterruptDrainDropSample(session, {
              sessionId,
              stream: "stdout",
              droppedBytes: output.droppedBytes,
              reason: output.reason,
              accepted: true,
            });
          }
          if (!output.data) return;
          const outputMeta = takePendingInterruptOutputMeta(session);
          trackSessionIdlePrompt(session, output.data);
          bufferData(output.data, outputMeta);
          sessionLogStreamManager.appendData(sessionId, output.data);
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
            safeSend(getCurrentSessionWebContents(), "netcatty:zmodem:overwrite-request", {
              sessionId, requestId, filename,
            });
          });
        },
        getWebContents() {
          return getCurrentSessionWebContents();
        },
        selectUploadFiles: selectZmodemUploadFiles
          ? () => selectZmodemUploadFiles(getCurrentSessionWebContentsId())
          : undefined,
        selectDownloadDirectory: selectZmodemDownloadDirectory
          ? () => selectZmodemDownloadDirectory(getCurrentSessionWebContentsId())
          : undefined,
        label: "SSH",
      });
      session.zmodemSentry = sshZmodemSentry;

      stream.on("data", (data) => {
        const currentSession = sessions.get(sessionId);
        if (!shouldProcessSessionOutput(currentSession, sshZmodemSentry)) {
          logTerminalOutputDropSample(currentSession, {
            sessionId,
            stream: "stdout",
            bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data)),
          });
          return;
        }
        // data is Buffer from ssh2 — feed raw bytes to ZMODEM sentry.
        // In normal mode, sentry's onData callback handles decoding and buffering.
        sshZmodemSentry.consume(data);
      });

      stream.stderr?.on("data", (data) => {
        const currentSession = sessions.get(sessionId);
        if (!shouldProcessSessionOutput(currentSession)) {
          logTerminalOutputDropSample(currentSession, {
            sessionId,
            stream: "stderr",
            bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data)),
          });
          return;
        }
        // stderr is not used for ZMODEM — decode normally
        const decoder = getSessionDecoder(sessionId, "stderr");
        const decoded = decoder.write(data);
        const output = filterTerminalInterruptOutput(currentSession, decoded);
        if (!output.accepted) {
          logTerminalInterruptDrainDropSample(currentSession, {
            sessionId,
            stream: "stderr",
            droppedBytes: output.droppedBytes,
            reason: output.reason,
            accepted: false,
          });
          return;
        }
        if (output.droppedBytes > 0) {
          logTerminalInterruptDrainDropSample(currentSession, {
            sessionId,
            stream: "stderr",
            droppedBytes: output.droppedBytes,
            reason: output.reason,
            accepted: true,
          });
        }
        if (!output.data) return;
        const outputMeta = takePendingInterruptOutputMeta(currentSession);
        bufferData(output.data, outputMeta);
        sessionLogStreamManager.appendData(sessionId, output.data);
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
        log("shell exit", { sessionId, hostname: options.hostname, code, signal, reused: !!isReused });
        streamExitCode = typeof code === "number" ? code : 0;
        streamExited = typeof code === "number" && !signal;
      });

      let closeFinalized = false;
      stream.on("close", () => {
        log("shell stream closed", {
          sessionId,
          hostname: options.hostname,
          streamExitCode,
          streamExited,
          reused: !!isReused,
          transportError: sessions.get(sessionId)?._transportError,
        });
        const finalizeClose = () => {
          if (closeFinalized) return;
          closeFinalized = true;
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
            const liveSession = sessions.get(sessionId);
            const transportError = liveSession?._transportError;
            if (liveSession?.closed) {
              // Explicit close already notified every attached renderer.
            } else if (transportError) {
              safeSendSessionExit({ safeSend, electronModule, sessions }, contents, sessionId, { sessionId, exitCode: 1, error: transportError, reason: "error" });
            } else {
              // A shell TMOUT auto-logout is a clean exit (numeric code, no
              // signal) — identical to a user-typed `exit` by code/signal —
              // so detect it via the banner the shell prints just before
              // exiting and report it as a timeout. That keeps the tab open
              // for reconnect instead of auto-closing it (#1062 / #977).
              const idleTimedOut = streamExited && looksLikeIdleAutoLogout(liveSession?._promptTrackTail);
              const reason = idleTimedOut ? "timeout" : (streamExited ? "exited" : "closed");
              safeSendSessionExit({ safeSend, electronModule, sessions }, contents, sessionId, { sessionId, exitCode: streamExitCode, reason });
            }
            liveSession?.zmodemSentry?.cancel();
            // Release this channel's hold on the shared connection. The transport
            // (and any jump-host chain) is only ended once the last channel is
            // gone, so closing a reused tab — or the original tab while a copy is
            // still open — leaves the siblings connected.
            releaseConnectionRef(liveSession);
            closeTerminalOutputSession?.(sessionId);
            sessions.delete(sessionId);
            sessionEncodings.delete(sessionId);
            sessionDecoders.delete(sessionId);
          }
        };
        flushBufferPaced(finalizeClose);
      });

      // Pre-seed encoding from host charset if it's a GB variant. Seed BOTH the
      // output decoder (sessionEncodings) and the terminal input encoder
      // (session.encoding, read by terminalBridge.writeToSession) so they agree
      // from the first byte — otherwise a GB18030 host decoded output as GB18030
      // while encoding keystrokes as UTF-8 until the user re-picked the encoding
      // (issue #1216). The gate matches the renderer's two-value encoding state
      // (Terminal.tsx) so behavior for other/arbitrary charsets is unchanged:
      // the renderer pushes the effective encoding via setEncoding on attach,
      // and that handler keeps both halves in sync.
      const initialEncoding = normalizeTerminalEncoding(options.charset);
      if (initialEncoding === "gb18030") {
        sessionEncodings.set(sessionId, "gb18030");
        session.encoding = "gb18030";
      }

      // Run startup command if specified. Encode it with the same charset the
      // interactive input path uses (issue #1216) so a startup command with
      // non-ASCII characters reaches a GB18030 host correctly too.
      if (options.startupCommand) {
        setTimeout(() => {
          stream.write(encodeTerminalInput(`${options.startupCommand}\n`, session.encoding));
        }, 300);
      }

      return session;
    }

    /**
     * Open a new interactive shell channel on an already-authenticated SSH
     * connection borrowed from `sourceSession`, instead of dialing a fresh
     * connection. This is what makes "Copy Tab" skip a second MFA prompt
     * (issue #1204): the SSH transport and its authentication are reused; only
     * a new session channel is requested.
     *
     * Resolves with `{ sessionId }` on success. Throws on failure so the caller
     * can fall back to a normal fresh connection.
     */
    async function openReusedShellSerialized(
      event,
      options,
      sourceSession,
      sessionId,
      log,
      connRef,
      refHolder,
    ) {
      const cols = options.cols || 80;
      const rows = options.rows || 24;
      const sender = event.sender;
      const conn = sourceSession.conn;
      let discoveryConnectionError = null;
      const onDiscoveryConnectionError = (err) => {
        discoveryConnectionError = err;
      };
      let shellDiscoveryBeforeOpen = { available: false, pids: [] };
      if (!options.skipShellPidDiscovery) {
        conn.once("error", onDiscoveryConnectionError);
        shellDiscoveryBeforeOpen = await listInteractiveShellPids(conn);
        conn.removeListener("error", onDiscoveryConnectionError);
      }
      const shellPidsBeforeOpen = shellDiscoveryBeforeOpen.pids;
      if (discoveryConnectionError) {
        releaseConnectionRef(refHolder);
        throw discoveryConnectionError;
      }
      const assignedPids = new Set(
        [...sessions.values()]
          .filter((candidate) => candidate?.connRef === connRef && candidate.shellPid)
          .map((candidate) => String(candidate.shellPid)),
      );
      const unclaimedPids = shellPidsBeforeOpen.filter((pid) => !assignedPids.has(pid));
      const unassignedSessions = [...sessions.values()].filter(
        (candidate) => candidate?.connRef === connRef && !candidate.shellPid,
      );
      if (unclaimedPids.length === 1 && unassignedSessions.length === 1) {
        unassignedSessions[0].shellPid = unclaimedPids[0];
      }

      log("reusing existing connection for new shell channel", {
        sessionId,
        sourceSessionId: options.sourceSessionId,
        hostname: options.hostname,
      });

      const sendProgress = (status, error) => {
        if (!sender.isDestroyed()) {
          sender.send("netcatty:chain:progress", {
            sessionId, hop: 1, total: 1, label: options.hostname, status, error,
          });
        }
      };

      sendProgress('shell');

      const shellOptions = {
        env: {
          COLORTERM: "truecolor",
          ...(options.env || {}),
        },
      };

      // Pin the shared connection *before* issuing the async shell request.
      // Otherwise, if the source tab is closed while conn.shell() is pending,
      // releaseConnectionRef could drop the count to zero and end the connection
      // out from under the channel we're opening. We hold a temporary session
      // object as the ref holder, then hand the ref over to the real session
      // once the channel opens. On any failure we release this hold so the count
      // is restored.
      return new Promise((resolve, reject) => {
        let settled = false;

        const failReuse = (err) => {
          if (settled) return;
          settled = true;
          // Release the hold we took up-front so the source's reference count is
          // not leaked when we fall back to a fresh connection.
          releaseConnectionRef(refHolder);
          reject(err);
        };

        // If the borrowed connection dies before the channel opens, surface it
        // as a normal failure so the caller's catch can fall back to a fresh
        // connection. Removed once the channel opens so we don't leave a stray
        // listener on the shared connection (the owner's own error handler stays
        // responsible thereafter).
        const onConnError = (connErr) => {
          failReuse(connErr);
        };
        conn.once("error", onConnError);

        try {
          conn.shell(
            {
              term: "xterm-256color",
              cols,
              rows,
            },
            shellOptions,
            (err, stream) => {
              conn.removeListener("error", onConnError);
              if (settled) {
                // Connection already failed; close any channel that still opened
                // and drop the hold (failReuse already released, so guard with the
                // settled check above means we only get here post-failure).
                if (stream) { try { stream.close(); } catch { /* ignore */ } }
                return;
              }
              if (err) {
                log("reused shell open failed", { sessionId, hostname: options.hostname, error: err.message });
                sendProgress('error', `Failed to open shell: ${err.message}`);
                failReuse(err);
                return;
              }

              sendProgress('connected');

              // Hand the up-front ref hold over to the real session: detach it from
              // the temporary holder (without ending the transport) and attach the
              // descriptor to the session. The count already includes this channel.
              refHolder.connRef = null;
              setupShellSession({
                conn,
                stream,
                options: { ...options, _connRef: connRef },
                sessionId,
                event,
                log,
                detachX11Forwarding: null,
                chainConnections: [],
                isReused: true,
              });
              const newShellPidPromise = shellDiscoveryBeforeOpen.available
                ? waitForNewInteractiveShellPid(conn, shellPidsBeforeOpen)
                : Promise.resolve(null);
              void newShellPidPromise.then((newShellPid) => {
                const copiedSession = sessions.get(sessionId);
                if (copiedSession && newShellPid) {
                  copiedSession.shellPid = newShellPid;
                }
                settled = true;
                resolve({ sessionId });
              });
            }
          );
        } catch (syncErr) {
          // ssh2 can throw synchronously (e.g. "Not connected") if the borrowed
          // transport dropped between findReusableSession and conn.shell(). Make
          // sure we drop the listener and release the up-front ref so the count
          // isn't leaked, then fall back to a fresh connection.
          conn.removeListener("error", onConnError);
          log("reused shell threw synchronously", { sessionId, hostname: options.hostname, error: syncErr?.message });
          failReuse(syncErr);
        }
      });
    }

    function reuseShellSession(event, options, sourceSession, sessionId, log) {
      const connRef = sourceSession.connRef;
      const refHolder = {};
      // Pin while queued as well as while opening: the source tab may close
      // before this copy reaches the front of the per-connection queue.
      acquireConnectionRef(refHolder, connRef);

      const previous = connRef.shellOpenQueue || Promise.resolve();
      const operation = previous
        .catch(() => {})
        .then(() => openReusedShellSerialized(
          event,
          options,
          sourceSession,
          sessionId,
          log,
          connRef,
          refHolder,
        ));
      const tail = operation.then(() => undefined, () => undefined);
      connRef.shellOpenQueue = tail;

      return operation.finally(() => {
        if (connRef.shellOpenQueue === tail) {
          delete connRef.shellOpenQueue;
        }
      });
    }

    async function startSSHSession(event, options) {
      const sessionId = options.sessionId || randomUUID();
      const sender = event.sender;
      const log = createSshDiagnosticLogger(
        !!options.sshDebugLogEnabled || process.env.NETCATTY_SSH_DEBUG === "1",
      );
      const sendConnectionReuseFallback = () => {
        if (!sender.isDestroyed()) {
          sender.send("netcatty:connection-reuse:fallback", {
            sessionId,
            sourceSessionId: options.sourceSessionId,
          });
        }
      };

      // Connection reuse (issue #1204): when a tab is duplicated we try to open
      // a new shell channel on the source tab's already-authenticated
      // connection. This skips key exchange + authentication entirely, so an
      // MFA-protected host does not prompt for a second factor. Only applies to
      // a live, interactive SSH shell source; anything else falls through to a
      // normal fresh connection below.
      //
      // X11 forwarding is negotiated per shell channel using a fresh fake
      // cookie wired up at connection time, so a reused channel would not carry
      // X11. For X11 hosts we deliberately skip reuse and make a fresh
      // connection so the duplicate keeps working X11 forwarding.
      if (options.sourceSessionId && !options.x11Forwarding) {
        const sourceSession = findReusableSession(sessions, options.sourceSessionId, {
          hostname: options.hostname,
          port: options.port || 22,
          username: options.username || "root",
        });
        if (sourceSession) {
          try {
            return await reuseShellSession(event, options, sourceSession, sessionId, log);
          } catch (reuseErr) {
            log("connection reuse failed, falling back to fresh connection", {
              sessionId,
              sourceSessionId: options.sourceSessionId,
              error: reuseErr?.message,
            });
            sendConnectionReuseFallback();
            // Fall through to establish a fresh connection.
          }
        } else {
          log("connection reuse requested but source not reusable, connecting fresh", {
            sessionId,
            sourceSessionId: options.sourceSessionId,
          });
          sendConnectionReuseFallback();
        }
      }

      const cols = options.cols || 80;
      const rows = options.rows || 24;

      const sendProgress = (hop, total, label, status, error) => {
        if (!sender.isDestroyed()) {
          sender.send("netcatty:chain:progress", { sessionId, hop, total, label, status, error });
        }
      };

      try {
        const { tcpConnectTimeoutMs, authReadyTimeoutMs } = resolveSshConnectionTimeouts(options);
        log("session starting", {
          sessionId,
          hostname: options.hostname,
          port: options.port || 22,
          username: options.username || "root",
          hostLabel: options.hostLabel || options.label,
          hasJumpHosts: (options.jumpHosts || []).length > 0,
          hasProxy: !!options.proxy,
          tcpConnectTimeoutMs,
          authReadyTimeoutMs,
        });
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
          // `timeout` covers TCP dial silence; `readyTimeout` covers the full
          // SSH handshake/auth flow so MFA still has enough time.
          timeout: tcpConnectTimeoutMs,
          // ssh2 starts readyTimeout before TCP connects. The auth-ready timer
          // below starts explicitly from the connection event instead.
          readyTimeout: 0,
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
        attachSshDebugLogger(connectOpts, log);
        logSshAlgorithms("Target host", connectOpts.algorithms, {
          hostname: options.hostname,
          port: options.port || 22,
          legacyAlgorithms: !!options.legacyAlgorithms,
          skipEcdsaHostKey: !!options.skipEcdsaHostKey,
          hasAlgorithmOverrides: !!options.algorithmOverrides,
        }, log);

        connectOpts.hostVerifier = hostKeyVerifier.createHostVerifier({
          sender,
          sessionId,
          hostname: options.hostname,
          port: options.port || 22,
          knownHosts: options.knownHosts,
          verifyHostKeys: options.verifyHostKeys,
        });

        // Authentication for final target
        const hasCertificate = options.authMethod !== "password"
          && typeof options.certificate === "string"
          && options.certificate.trim().length > 0;
        const isAutomaticAuth = options.authMethod === "auto";
        const isSelectedKeyAuth = options.authMethod === "key" || options.authMethod === "certificate";
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
        const systemAuthAgent = shouldPrepareSystemAgentForLogin(options)
          ? await prepareSystemSshAgentForAuth(options, "[SSH]")
          : null;
        // Kick off the default-key scan now so it overlaps the identity-file /
        // inline-key preparation below instead of running serially after it.
        // findAllDefaultPrivateKeys swallows its own fs errors and never rejects,
        // so leaving this promise briefly unawaited cannot surface an unhandled
        // rejection even if the key prep throws first.
        const defaultKeysPromise = findAllDefaultPrivateKeys();
        const identityFile = options.authMethod !== "password" && !options.privateKey && !systemAuthAgent
          ? await loadFirstIdentityFileForAuth({
            sender,
            identityFilePaths: options.identityFilePaths,
            hostname: options.hostname,
            initialPassphrase: options.passphrase,
            logPrefix: "[SSH]",
            onPassphrasePromptShown: () => sendProgress(
              totalHops, totalHops, options.hostname, "auth-attempt", "waiting for user input...",
            ),
            onPassphrasePromptResolved: () => sendProgress(
              totalHops, totalHops, options.hostname, "auth-attempt", "user responded",
            ),
            onLoaded: (loaded) => {
              log("Loaded identity file", { keyPath: loaded.keyPath, encrypted: !!loaded.passphrase });
            },
            onError: (err, keyPath) => {
              log("Failed to read identity file", { keyPath, error: err.message });
            },
          })
          : null;
        const inlineKey = options.authMethod !== "password" && options.privateKey && !systemAuthAgent
          ? await preparePrivateKeyForAuth({
            sender,
            privateKey: options.privateKey,
            keyId: options.keyId,
            keyName: options.keyId || options.username,
            hostname: options.hostname,
            initialPassphrase: effectivePassphrase,
            logPrefix: "[SSH]",
            onPassphrasePromptShown: () => sendProgress(
              totalHops, totalHops, options.hostname, "auth-attempt", "waiting for user input...",
            ),
            onPassphrasePromptResolved: () => sendProgress(
              totalHops, totalHops, options.hostname, "auth-attempt", "user responded",
            ),
          })
          : null;
        const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
        const effectiveIdentityPassphrase = inlineKey?.passphrase || identityFile?.passphrase;

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

        // Whitespace-only passwords are valid SSH secrets (issue #2036).
        if (isPasswordProvided(options.password)) {
          connectOpts.password = options.password;
        }

        // Default ~/.ssh keys are a fallback for hosts that have no explicit
        // credentials. Password-only hosts must NOT silently fall back to local
        // keys: jump-host / SFTP paths already honor that rule via
        // buildAuthHandler (issue #266), and falling back only on the direct
        // terminal path makes a wrong saved password look fine until ProxyJump
        // or SFTP fails (issue #2079).
        //
        // The full list is scanned exactly once (kicked off above); its first
        // entry is the preferred default key — identical to what a separate
        // findDefaultPrivateKey() scan would return — so derive it here instead
        // of walking ~/.ssh a second time. (Pinned by
        // sshBridge.defaultKeyEquivalence.test.cjs.)
        let usedDefaultKeyAsPrimary = false;
        const discoveredDefaultKeys = await defaultKeysPromise;
        const allDefaultKeys = isSelectedKeyAuth || options.authMethod === "password" || (systemAuthAgent && options.identitiesOnly)
          ? []
          : discoveredDefaultKeys;
        const defaultKeyInfo = allDefaultKeys[0] ?? null;
        // Explicit password without a user-configured key/certificate/agent is
        // password-only — same predicate buildAuthHandler uses for isPasswordOnly.
        const isPasswordOnlyAuth =
          options.authMethod === "password" || (
            !isAutomaticAuth &&
            isPasswordProvided(connectOpts.password) &&
            !connectOpts.privateKey &&
            !hasCertificate &&
            !systemAuthAgent &&
            !hasUserConfiguredKey(options)
          );
        if (defaultKeyInfo && !isPasswordOnlyAuth) {
          log("Found default SSH key for fallback", { keyPath: defaultKeyInfo.keyPath, keyName: defaultKeyInfo.keyName });
        } else if (defaultKeyInfo && isPasswordOnlyAuth) {
          log("Skipping default SSH key fallback for password-only auth", {
            keyPath: defaultKeyInfo.keyPath,
            keyName: defaultKeyInfo.keyName,
          });
        }

        // Use unlocked encrypted keys if provided (from retry after auth failure)
        // These are passed via _unlockedEncryptedKeys from startSSHSessionWrapper
        const unlockedEncryptedKeys = resolveUnlockedEncryptedKeysForAuth(
          options,
          Boolean(isSelectedKeyAuth || (systemAuthAgent && options.identitiesOnly)),
        );
        if (unlockedEncryptedKeys.length > 0) {
          log("Using unlocked encrypted keys from retry", {
            count: unlockedEncryptedKeys.length,
            keyNames: unlockedEncryptedKeys.map(k => k.keyName)
          });
        }

        // Automatic mode intentionally mirrors OpenSSH-style discovery even
        // when a saved password exists: agent and default keys are tried first,
        // then the password. Password-only mode never enters this path.
        if (isAutomaticAuth && !connectOpts.agent && options.useSshAgent !== false) {
          const automaticAgentSocket = await getAvailableAgentSocket();
          if (automaticAgentSocket) {
            connectOpts.agent = automaticAgentSocket;
            log("Automatic auth found SSH agent", { agentSocket: automaticAgentSocket });
          }
        }

        // If no primary auth method configured, try ssh-agent first, then ALL default keys.
        // Skip default-key primaries when the user explicitly chose a key (inline or
        // identityFilePaths) even if loading that key failed (issue #1614).
        if (!connectOpts.privateKey && !connectOpts.password && !connectOpts.agent) {
          // First, try to use ssh-agent if available (this is what regular SSH does)
          const sshAgentSocket = options.useSshAgent !== false
            ? await getAvailableAgentSocket()
            : null;

          if (sshAgentSocket) {
            log("No auth method configured, trying ssh-agent first", { agentSocket: sshAgentSocket });
            connectOpts.agent = sshAgentSocket;
          }

          // Mark that we need to try all default keys (handled in authMethods below)
          if (!hasUserConfiguredKey(options) && allDefaultKeys.length > 0) {
            log("Will try all default SSH keys as fallback", { count: allDefaultKeys.length, keyNames: allDefaultKeys.map(k => k.keyName) });
            // Set first key for connectOpts.privateKey (required for ssh2 to allow publickey auth)
            connectOpts.privateKey = allDefaultKeys[0].privateKey;
            usedDefaultKeyAsPrimary = true;
          } else if (allDefaultKeys.length === 0) {
            log("No default SSH key found in ~/.ssh directory");
          }
        }

        log("Final auth configuration", {
          hasPrivateKey: !!connectOpts.privateKey,
          hasPassword: !!connectOpts.password,
          hasAgent: !!connectOpts.agent,
          hasDefaultKeyFallback: !!defaultKeyInfo && !isPasswordOnlyAuth,
          isPasswordOnlyAuth,
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
        // Shared with keyboard-interactive auto-fill. A completed password or
        // keyboard-interactive factor suppresses reuse of the saved host
        // password for a later KI factor (EDR step-up). publickey partialSuccess
        // still allows Password: auto-fill.
        const authPhase = createAuthPhase();

        if (authAgent) {
          const order = ["none", "agent"];
          if (options.requiresMfa && !options._skipPasswordMethod) {
            order.push("keyboard-interactive");
          }
          if (connectOpts.password && !options._skipPasswordMethod) {
            order.push("password");
          }
          // Default key fallback only when this is not password-only (issue #266 / #2079).
          // Must also set connectOpts.privateKey for ssh2 to actually try publickey auth.
          if (defaultKeyInfo && !hasUserConfiguredKey(options) && !isPasswordOnlyAuth) {
            connectOpts.privateKey = defaultKeyInfo.privateKey;
            order.push("publickey");
          }
          if (!order.includes("keyboard-interactive")) order.push("keyboard-interactive");
          // Function form so authPhase.hadPartialSuccess updates for cert/agent
          // first-factor + keyboard-interactive second-factor (#2150).
          connectOpts.authHandler = createOrderedStringAuthHandler(order, authPhase);
          connectOpts._shouldRetryKeyboardInteractiveFirst = () => Boolean(authPhase.retryKeyboardInteractiveFirst);
          log("Auth order (agent mode)", { order, skipPasswordMethod: !!options._skipPasswordMethod });
        } else {
          // Build dynamic auth handler for fallback support
          const authMethods = [];

          if (isAutomaticAuth) {
            if (options.requiresMfa && !connectOpts.password && !options._skipPasswordMethod) {
              authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });
            }
            if (shouldOfferAgentForLogin(options, connectOpts)) {
              authMethods.push({ type: "agent", id: "agent" });
            }
            if (connectOpts.privateKey && !usedDefaultKeyAsPrimary) {
              authMethods.push({ type: "publickey", key: connectOpts.privateKey, passphrase: connectOpts.passphrase, id: "publickey-user" });
            }
            for (const keyInfo of allDefaultKeys) {
              authMethods.push({
                type: "publickey",
                key: keyInfo.privateKey,
                isDefault: true,
                id: `publickey-default-${keyInfo.keyName}`
              });
            }
            if (options.requiresMfa && connectOpts.password && !options._skipPasswordMethod) {
              authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });
            }
            if (connectOpts.password && !options._skipPasswordMethod) {
              authMethods.push({ type: "password", id: "password" });
            }
          } else {
            // First try user-configured key if available (explicit user choice)
            if (connectOpts.privateKey && !usedDefaultKeyAsPrimary) {
              authMethods.push({ type: "publickey", key: connectOpts.privateKey, passphrase: connectOpts.passphrase, id: "publickey-user" });
            }

            // Then try agent if configured (try agent before password since it's usually faster)
            if (shouldOfferAgentForLogin(options, connectOpts)) {
              authMethods.push({ type: "agent", id: "agent" });
            }

            // MFA/PAM hosts can reject the SSH "password" method while accepting
            // the login password through keyboard-interactive.
            if (options.requiresMfa && !options._skipPasswordMethod) {
              authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });
            }

            // Then try password if available (explicit user choice).
            if (connectOpts.password && !options._skipPasswordMethod) {
              authMethods.push({ type: "password", id: "password" });
            }

            // Then try ALL default SSH keys as fallback (not just the first one!)
            // Password-only hosts skip automatic default-key probing so terminal/SFTP/jump agree.
            if (!isPasswordOnlyAuth && usedDefaultKeyAsPrimary && allDefaultKeys.length > 0) {
              for (const keyInfo of allDefaultKeys) {
                authMethods.push({
                  type: "publickey",
                  key: keyInfo.privateKey,
                  isDefault: true,
                  id: `publickey-default-${keyInfo.keyName}`
                });
              }
            } else if (!isSelectedKeyAuth && defaultKeyInfo && !hasUserConfiguredKey(options) && !usedDefaultKeyAsPrimary) {
              // Single default key fallback (when user has configured other non-password auth)
              authMethods.push({ type: "publickey", key: defaultKeyInfo.privateKey, isDefault: true, id: "publickey-default" });
            }
          }

          // Unlocked default keys remain eligible only for automatic and
          // legacy fallback modes. Explicit modes must not probe unrelated keys.
          for (const keyInfo of unlockedEncryptedKeys) {
            authMethods.push({
              type: "publickey",
              key: keyInfo.privateKey,
              passphrase: keyInfo.passphrase,
              isDefault: true,
              id: `publickey-encrypted-${keyInfo.keyName}`
            });
          }

          // Keyboard-interactive as last resort, or already placed before password
          // as last-resort fallback for multi-factor / EDR.
          if (!authMethods.some((method) => method.type === "keyboard-interactive")) {
            authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });
          }

          log("Auth methods configured", {
            methods: authMethods.map(m => ({ type: m.type, id: m.id, isDefault: m.isDefault || false })),
            cachedMethod,
            usedDefaultKeyAsPrimary
          });

          // Reorder methods based on cached successful method
          if (shouldPromoteCachedAuthMethod(options.authMethod, cachedMethod)) {
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
            // Track methods that have been attempted (to avoid re-trying on failure)
            // This prevents reusing the same key when server requires multiple publickey auth steps
            // and also prevents re-attempting failed methods
            let attemptedMethodIds = new Set();
            // Methods that contributed a successful factor; never retried.
            const succeededMethodIds = new Set();
            // Methods actually rejected by the server. Keep these blocked when
            // a later factor makes previously unavailable methods eligible.
            const failedMethodIds = new Set();
            // Track the first successful method for caching (not the last one in multi-step flows)
            let firstSuccessfulMethod = null;
            // Track if we've gone through a partialSuccess flow (multi-step auth)
            let hadPartialSuccess = false;
            // Some EDR servers advertise keyboard-interactive next to password,
            // then remove it after a rejected password request. The wrapper can
            // recover by retrying once with the password method omitted so the
            // login password flows through keyboard-interactive.
            let passwordAttemptSawKeyboardInteractive = false;
            let shouldRetryKeyboardInteractiveFirst = false;

            connectOpts.authHandler = (methodsLeft, partialSuccess, callback) => {
              log("authHandler called", { methodsLeft, partialSuccess, attemptedMethodIds: Array.from(attemptedMethodIds) });

              // Log rejection of previous method
              if (lastTriedMethod && !partialSuccess) {
                sendProgress(totalHops, totalHops, options.hostname, 'auth-attempt', `${lastTriedMethod} rejected`);
                if (
                  lastTriedMethod === "password" &&
                  passwordAttemptSawKeyboardInteractive &&
                  Array.isArray(methodsLeft) &&
                  !methodsLeft.includes("keyboard-interactive")
                ) {
                  shouldRetryKeyboardInteractiveFirst = true;
                  log("password rejection removed keyboard-interactive; scheduling KI-first retry", {
                    methodsLeft,
                  });
                }
                if (lastTriedMethod !== "none") {
                  failedMethodIds.add(lastTriedMethod);
                }
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
                // password method id is "password"; key ids start with publickey-
                const succeededType =
                  lastTriedMethod === "password"
                    ? "password"
                    : lastTriedMethod === "agent"
                      ? "agent"
                      : lastTriedMethod === "keyboard-interactive"
                        ? "keyboard-interactive"
                        : "publickey";
                markAuthPhasePartialSuccess(authPhase, succeededType);
                // Record the first successful method (the one that triggered partialSuccess)
                if (lastTriedMethod && !firstSuccessfulMethod) {
                  firstSuccessfulMethod = lastTriedMethod;
                  log("Recorded first successful method for caching", { method: firstSuccessfulMethod });
                }
                // Reconsider methods that were unavailable in the previous
                // factor, but preserve credentials already rejected or used.
                if (lastTriedMethod) {
                  succeededMethodIds.add(lastTriedMethod);
                  log("Recorded successful auth factor (partial success)", { method: lastTriedMethod });
                }
                attemptedMethodIds = new Set([...failedMethodIds, ...succeededMethodIds]);
                // PAM/EDR can require two consecutive keyboard-interactive
                // factors (login password, then a separate secondary password).
                // A partial-success response explicitly advertising KI again is
                // permission to repeat that method with a fresh server prompt.
                // Keep keys/passwords de-duplicated, but do not suppress this
                // second interactive factor (#2150).
                if (
                  methodsLeft.includes("keyboard-interactive") &&
                  canRepeatKeyboardInteractive(authPhase, failedMethodIds)
                ) {
                  attemptedMethodIds.delete("keyboard-interactive");
                }

                log("Partial success - server requires additional auth", { methodsLeft, succeeded: Array.from(succeededMethodIds), attemptedMethodIds: Array.from(attemptedMethodIds) });

                // Next-factor selection: prefer keyboard-interactive when the
                // server still allows it (automatic KI fallback after any
                // partial success). Otherwise walk authMethods in order.
                const partialCandidates = [];
                for (const matchingMethod of authMethods) {
                  if (attemptedMethodIds.has(matchingMethod.id)) continue;
                  const serverMethod =
                    matchingMethod.type === "agent" || matchingMethod.type === "publickey"
                      ? "publickey"
                      : matchingMethod.type;
                  if (!methodsLeft.includes(serverMethod) && !methodsLeft.includes(matchingMethod.type)) {
                    continue;
                  }
                  partialCandidates.push(matchingMethod);
                }
                const preferredPartial =
                  partialCandidates.find((method) => method.type === "keyboard-interactive")
                  || partialCandidates[0];
                if (preferredPartial) {
                  const matchingMethod = preferredPartial;
                  const serverMethod =
                    matchingMethod.type === "agent" || matchingMethod.type === "publickey"
                      ? "publickey"
                      : matchingMethod.type;
                  log("Found matching method for partial success", { serverMethod, matchingMethod: matchingMethod.id });
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
                // No matching method found for partial success
                log("No matching method found for partial success requirements", { methodsLeft });
                return callback(false);
              }

              for (const method of authMethods) {
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
                  passwordAttemptSawKeyboardInteractive = availableMethods.includes("keyboard-interactive");
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
            connectOpts._shouldRetryKeyboardInteractiveFirst = () => shouldRetryKeyboardInteractiveFirst;
          }
        }

        // Handle chain/proxy connections
        if (hasJumpHosts) {
          // Pass fetched keys to chain connection to avoid re-reading files
          options._defaultKeys = discoveredDefaultKeys;
          options._sshDiagnosticLogger = log;

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
            options.port || 22,
            { timeoutMs: tcpConnectTimeoutMs }
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
          const connectionStartedAt = Date.now();
          let connectionStage = "connecting";
          let authBanner = "";
          let detachX11Forwarding = null;
          // Reference-counted descriptor for this connection. Created when the
          // shell channel opens; shared with any tabs that later reuse this
          // connection (issue #1204). Tearing the transport down is funneled
          // through releaseConnectionRef so the last channel — not whichever
          // channel happens to close first — ends the connection + chain.
          let connRef = null;
          let authReadyTimer = null;
          const clearAuthReadyTimer = () => {
            if (authReadyTimer) {
              clearTimeout(authReadyTimer);
              authReadyTimer = null;
            }
          };
          // Session-log stream token for THIS connection's owner channel,
          // captured in the closure so the connection-level error/timeout/close
          // handlers stop only this connection's stream. Reading it back off the
          // session map would risk stopping a *newer* same-sessionId stream
          // after a reconnect (the token guard from #916). Stays null until the
          // owner shell opens.
          let ownerLogStreamToken = null;

          // End the shared transport directly when we fail *before* a session
          // (and its connRef) exists; once connRef exists, teardown goes through
          // releaseConnectionRef via the stream close handler instead.
          const teardownTransport = () => {
            if (connRef) return;
            try { conn.end(); } catch { }
            for (const c of chainConnections) {
              try { c.end(); } catch { }
            }
          };

          conn.once("connect", () => {
            runWhenProxyConnectionReady(conn._sock, () => {
              try { conn._sock?.setTimeout?.(0); } catch { }
              clearAuthReadyTimer();
              connectionStage = "tcp-connected";
              authReadyTimer = setTimeout(() => conn.emit("timeout"), authReadyTimeoutMs);
              authReadyTimer.unref?.();
              log("target tcp connected", {
                sessionId,
                hostname: options.hostname,
                elapsedMs: Date.now() - connectionStartedAt,
                authReadyTimeoutMs,
              });
              sendProgress(totalHops, totalHops, options.hostname, 'tcp-connected');
              enableSshNoDelay(conn);
            });
          });
          if (connectOpts.sock) enableTcpNoDelay(connectOpts.sock);

          conn.once("handshake", () => {
            connectionStage = "handshake";
            console.log(`${logPrefix} ${options.hostname} handshake complete`);
            log("target handshake complete", {
              sessionId,
              hostname: options.hostname,
              elapsedMs: Date.now() - connectionStartedAt,
            });
            sendProgress(totalHops, totalHops, options.hostname, 'authenticating');
          });

          conn.on("banner", (message) => {
            authBanner = String(message || "").trim();
            log("auth banner received", {
              sessionId,
              hostname: options.hostname,
              length: authBanner.length,
            });
          });

          conn.once("ready", () => {
            clearAuthReadyTimer();
            connectionStage = "ready";
            console.log(`${logPrefix} ${options.hostname} ready`);
            log("target ready", {
              sessionId,
              hostname: options.hostname,
              elapsedMs: Date.now() - connectionStartedAt,
              remoteSshVersion: (conn && typeof conn._remoteVer === 'string') ? conn._remoteVer : '',
            });

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
              const current = sessions.get(sessionId);
              emitTerminalSessionData(event.sender, sessionId, data, {
                cols: current?.cols,
                rows: current?.rows,
              });
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
                  log("shell open failed", { sessionId, hostname: options.hostname, error: err.message });
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

                // Create the shared reference-counted descriptor for this
                // connection now that the owning channel is open, then wire the
                // shell up through the shared helper.
                const ownerSession = setupShellSession({
                  conn,
                  stream,
                  options,
                  sessionId,
                  event,
                  log,
                  detachX11Forwarding,
                  chainConnections,
                  isReused: false,
                });
                connRef = createConnectionRef(ownerSession, conn, chainConnections);
                // Capture this connection's log stream token in the closure so
                // the connection-level handlers below stop the right stream even
                // after a same-sessionId reconnect (#916).
                ownerLogStreamToken = ownerSession._logStreamToken;

                settled = true;
                resolve({ sessionId });
              }
            );
          });

          conn.on("error", (err) => {
            clearAuthReadyTimer();
            // After the promise is settled, we can't reject again. But if the
            // session was already established (resolved), we still need to notify
            // the renderer about transport errors so the session shows as failed
            // rather than silently closing.
            // Don't send netcatty:exit here — the stream close handler will flush
            // any buffered data first and then send exit with this error info.
            if (settled) {
              console.warn(`${logPrefix} ${options.hostname} post-settle error:`, err.message);
              log("post-connect transport error", {
                sessionId,
                hostname: options.hostname,
                error: err.message,
                code: err.code,
                level: err.level,
              });
              // Store the error so the close handler can include it in the exit event.
              // ssh2 closes every channel when the transport errors, so each
              // affected session (the owner and any reused siblings) gets the
              // flag and reports the error via its own stream close handler.
              const currentSession = sessions.get(sessionId);
              const ownsCurrentSession = Boolean(connRef && currentSession?.connRef === connRef);
              if (ownsCurrentSession) {
                currentSession._transportError = err.message;
              }
              if (connRef) {
                for (const sibling of sessions.values()) {
                  if (sibling !== currentSession && sibling.connRef === connRef) {
                    sibling._transportError = err.message;
                  }
                }
              }
              return;
            }

            const contents = event.sender;

            const isAuthError = isSshAuthFailure(err);

            // Clear cached auth method on auth failure so next attempt tries all methods
            if (isAuthError) {
              if (
                !options._skipPasswordMethod &&
                connectOpts.password &&
                connectOpts._shouldRetryKeyboardInteractiveFirst?.()
              ) {
                err.retryKeyboardInteractiveFirst = true;
                log("auth failure marked for KI-first retry", {
                  sessionId,
                  hostname: options.hostname,
                });
              }
              clearCachedAuthMethod(connectOpts.username, options.hostname, options.port);
              console.log(`${logPrefix} ${options.hostname} auth failed:`, err.message);
              log("authentication failed", {
                sessionId,
                hostname: options.hostname,
                error: err.message,
                code: err.code,
                level: err.level,
              });
              safeSend(contents, "netcatty:auth:failed", {
                sessionId,
                error: err.message,
                hostname: options.hostname
              });
            } else {
              console.error(`${logPrefix} ${options.hostname} error:`, err.message);
              log("connection error", {
                sessionId,
                hostname: options.hostname,
                error: err.message,
                code: err.code,
                level: err.level,
              });
            }

            sendProgress(totalHops, totalHops, options.hostname, 'error', err.message);
            const suppressPreShellAuthExit = Boolean(options._suppressPreShellAuthExit && isAuthError);
            if (suppressPreShellAuthExit) {
              log("suppressing pre-shell auth exit for wrapper-managed retry", {
                sessionId,
                hostname: options.hostname,
              });
            } else {
              safeSendSessionExit({ safeSend, electronModule, sessions }, contents, sessionId, { sessionId, exitCode: 1, error: err.message, reason: "error" });
            }
            sessionLogStreamManager.stopStream(sessionId, ownerLogStreamToken);
            if (detachX11Forwarding) {
              detachX11Forwarding();
              detachX11Forwarding = null;
            }
            sessions.get(sessionId)?.zmodemSentry?.cancel();
            closeTerminalOutputSession?.(sessionId);
            sessions.delete(sessionId);
            sessionEncodings.delete(sessionId);
            sessionDecoders.delete(sessionId);
            teardownTransport();
            // Destroy the connection to prevent further socket errors from leaking
            // as uncaught exceptions (e.g. ECONNRESET on embedded devices).
            try { conn.destroy(); } catch { }
            settled = true;
            reject(err);
          });

          conn.once("timeout", () => {
            clearAuthReadyTimer();
            console.error(`${logPrefix} ${options.hostname} connection timeout`);
            const err = new Error(`Connection timeout to ${options.hostname}`);
            log("connection timeout", {
              sessionId,
              hostname: options.hostname,
              error: err.message,
              stage: connectionStage,
              elapsedMs: Date.now() - connectionStartedAt,
              tcpConnectTimeoutMs,
              authReadyTimeoutMs,
            });
            const contents = event.sender;
            sendProgress(totalHops, totalHops, options.hostname, 'error', err.message);
            safeSendSessionExit({ safeSend, electronModule, sessions }, contents, sessionId, { sessionId, exitCode: 1, error: err.message, reason: "timeout" });
            sessionLogStreamManager.stopStream(sessionId, ownerLogStreamToken);
            sessions.get(sessionId)?.zmodemSentry?.cancel();
            closeTerminalOutputSession?.(sessionId);
            sessions.delete(sessionId);
            sessionEncodings.delete(sessionId);
            sessionDecoders.delete(sessionId);
            teardownTransport();
            try { conn.destroy(); } catch { }
            settled = true;
            reject(err);
          });

          conn.once("close", () => {
            clearAuthReadyTimer();
            const contents = event.sender;
            const currentSession = sessions.get(sessionId);
            const ownsCurrentSession = Boolean(connRef && currentSession?.connRef === connRef);
            log("connection closed", {
              sessionId,
              hostname: options.hostname,
              settled,
              staleForCurrentSession: Boolean(currentSession && !ownsCurrentSession),
              transportError: ownsCurrentSession ? currentSession?._transportError : undefined,
            });
            if (!settled) {
              sendProgress(totalHops, totalHops, options.hostname, 'error', `Connection to ${options.hostname} closed unexpectedly`);
            }
            // This handler owns teardown for the *owner* session only. ssh2
            // fires conn "close" before the owner's stream "close" on a
            // transport drop, so we clean the owner up here; the owner's stream
            // close then no-ops because the session is already gone. Reused
            // sibling channels each clean themselves up via their own stream
            // "close" (ssh2 closes every channel when the transport drops).
            if (ownsCurrentSession) {
              const session = currentSession;
              const transportError = session?._transportError;
              if (transportError) {
                // A transport error was recorded — report it as an error exit
                safeSendSessionExit({ safeSend, electronModule, sessions }, contents, sessionId, { sessionId, exitCode: 1, error: transportError, reason: "error" });
              } else {
                safeSendSessionExit({ safeSend, electronModule, sessions }, contents, sessionId, { sessionId, exitCode: 0, reason: "closed" });
              }
              // Use this connection's captured token so a late close from an
              // old transport can't stop a newer same-sessionId stream (#916).
              sessionLogStreamManager.stopStream(sessionId, ownerLogStreamToken);
              session?.zmodemSentry?.cancel();
              // Release the owner's hold on the shared connection. The transport
              // is already closing, but this decrements the reference count and,
              // when it is the last holder, ends the jump-host chain. Reused
              // siblings (if any) keep the count above zero until their own
              // stream close handlers run.
              releaseConnectionRef(session);
              closeTerminalOutputSession?.(sessionId);
              sessions.delete(sessionId);
              sessionEncodings.delete(sessionId);
              sessionDecoders.delete(sessionId);
            } else {
              // Owner already cleaned up (e.g. its stream closed first). Ensure
              // this connection's log stream is stopped defensively, scoped by
              // the captured token so a reconnect's fresh stream is left alone.
              if (ownerLogStreamToken) {
                sessionLogStreamManager.stopStream(sessionId, ownerLogStreamToken);
              }
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
            hostId: options.hostId,
            hostname: options.hostname,
            password: options.password,
            logPrefix,
            scope: "terminal",
            getAuthBanner: () => authBanner,
            shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(authPhase),
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
            if (connectOpts.password && !options._skipPasswordMethod) {
              authMethods.push("password");
            }
            authMethods.push("keyboard-interactive");
            const dedupedAuthMethods = Array.from(new Set(authMethods));
            connectOpts.authHandler = dedupedAuthMethods;
            log("Using simple array authHandler", {
              authMethods: dedupedAuthMethods,
              usedDefaultKeyAsPrimary,
              });
          }
          // If authHandler is a function, it already handles keyboard-interactive

          console.log(`${logPrefix} Connecting to ${options.hostname}...`);
          log("connect options prepared", {
            sessionId,
            hostname: options.hostname,
            port: options.port || 22,
            hasSocket: !!connectOpts.sock,
            hasProxy,
            jumpHostCount: jumpHosts.length,
            timeout: connectOpts.timeout,
            readyTimeout: connectOpts.readyTimeout,
            tryKeyboard: connectOpts.tryKeyboard,
            hasPassword: !!connectOpts.password,
            hasPrivateKey: !!connectOpts.privateKey,
            hasAgent: !!connectOpts.agent,
            authHandlerType: Array.isArray(connectOpts.authHandler) ? "array" : typeof connectOpts.authHandler,
            authMethods: Array.isArray(connectOpts.authHandler)
              ? connectOpts.authHandler
              : undefined,
          });
          conn.connect(connectOpts);
        });
      } catch (err) {
        console.error("[Chain] SSH chain connection error:", err.message);
        const isAuthError = isSshAuthFailure(err);
        const suppressPreShellAuthExit = Boolean(options._suppressPreShellAuthExit && isAuthError);
        if (!suppressPreShellAuthExit) {
          const contents = event.sender;
          safeSendSessionExit({ safeSend, electronModule, sessions }, contents, sessionId, { sessionId, exitCode: 1, error: err.message });
        }
        throw err;
      }
    }
    return { startSSHSession };
  }
}

module.exports = {
  SSH_AUTH_READY_TIMEOUT_MS,
  SSH_TCP_CONNECT_TIMEOUT_MS,
  createStartSessionApi,
  resolveSshConnectionTimeouts,
  shouldOfferAgentForLogin,
  shouldPrepareSystemAgentForLogin,
  resolveUnlockedEncryptedKeysForAuth,
  shouldPromoteCachedAuthMethod,
};
