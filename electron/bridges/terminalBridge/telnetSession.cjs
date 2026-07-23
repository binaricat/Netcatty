/* eslint-disable no-undef */
const { emitTerminalSessionData } = require("../emitTerminalSessionData.cjs");
const {
  setBufferedOutputBytes,
  shouldAcceptSessionOutput,
  shouldProcessSessionOutput,
} = require("../terminalFlowAck.cjs");
const { fanoutSessionExit } = require("../terminalAttachRestore.cjs");

const TELNET_SESSION_REPLACED_ERROR = "Telnet session start was replaced";

function createTelnetSessionApi(ctx) {
  with (ctx) {
    const telnetStartCounters = new Map();
    const telnetActiveGenerations = new Map();

    const closeReplacedTelnetSession = (sessionId) => {
      const existing = sessions.get(sessionId);
      if (!existing || existing.type !== 'telnet-native') return;
      existing.closed = true;
      try { existing.zmodemSentry?.cancel(); } catch {}
      try { existing.discardPendingData?.(); } catch {}
      try { clearPendingAutomatedWrites(existing); } catch {}
      try { existing.releaseTelnetGeneration?.(); } catch {}
      try { sessionLogStreamManager.stopStream(sessionId); } catch {}
      try { existing.socket?.destroy(); } catch {}
      try { closeTerminalOutputSession?.(sessionId); } catch {}
      sessions.delete(sessionId);
      try { ptyProcessTree.unregisterPid(sessionId); } catch {}
    };

    async function startTelnetSession(event, options) {
      const sessionId = options.sessionId || randomUUID();
      const generation = (telnetStartCounters.get(sessionId) || 0) + 1;
      telnetStartCounters.set(sessionId, generation);
      telnetActiveGenerations.set(sessionId, generation);
      closeReplacedTelnetSession(sessionId);
    
      const hostname = options.hostname;
      const port = options.port || 23;
      const cols = options.cols || 80;
      const rows = options.rows || 24;
    
      console.log(`[Telnet] Starting connection to ${hostname}:${port}`);
    
      return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        enableTcpNoDelay(socket);
        let connected = false;
        let activeSession = null;
        // Token for the log stream we open on this connection. Captured here so
        // the close/error handlers below can pass it back to stopStream and
        // avoid tearing down a fresh stream that a subsequent reconnect on the
        // same sessionId may have started (issue #916).
        let logStreamToken = null;
        let telnetExitFinalized = false;
        const initialTelnetEncoding = normalizeTerminalEncoding(options.charset);
        const telnetDecoderRef = { current: iconv.getDecoder(initialTelnetEncoding) };

        // Telnet protocol state. Negotiation only activates once we see an IAC
        // byte from the peer — if the remote never speaks the protocol (some
        // legacy raw-TCP services on port 23), we fall back to passthrough so we
        // do not corrupt their stream by misreading stray 0xFF bytes as IAC.
        let telnetProtocolActive = false;
        let telnetCleanData = Buffer.alloc(0);
        let remoteEchoEnabled = true;
        let localEchoEnabled = false;
        const publishEchoMode = () => {
          const session = sessions.get(sessionId);
          if (session?.socket === socket) {
            session.telnetEchoMode = {
              sessionId,
              remoteEcho: remoteEchoEnabled,
              localEcho: localEchoEnabled,
            };
          }
          const contents = electronModule.webContents.fromId(session?.webContentsId ?? event.sender.id);
          contents?.send("netcatty:telnet:echo-mode", {
            sessionId,
            remoteEcho: remoteEchoEnabled,
            localEcho: localEchoEnabled,
          });
        };
        const sendEchoMode = (remoteEcho) => {
          remoteEchoEnabled = remoteEcho;
          publishEchoMode();
        };
        const sendLocalEchoMode = (localEcho) => {
          localEchoEnabled = localEcho;
          publishEchoMode();
        };
        const isCurrentStart = () => telnetActiveGenerations.get(sessionId) === generation;
        const isCurrentSocket = () => isCurrentStart() && sessions.get(sessionId)?.socket === socket;
        const releaseTelnetGeneration = () => {
          if (telnetActiveGenerations.get(sessionId) === generation) {
            telnetActiveGenerations.delete(sessionId);
          }
        };
        const encodeTelnetInputForWire = (data) => {
          const normalized = telnetProtocol.normalizeNvtNewlines(data);
          const session = sessions.get(sessionId);
          let outgoing = encodeTerminalInput(normalized, session?.encoding ?? initialTelnetEncoding);
          if (telnetProtocolActive) {
            if (typeof outgoing === "string") outgoing = Buffer.from(outgoing, "utf8");
            outgoing = telnetProtocol.escapeIacForWire(outgoing);
          }
          return outgoing;
        };
        const telnetAutoLogin = createTelnetAutoLogin({
          username: options.username,
          password: options.password,
          write(data) {
            if (!socket.destroyed) socket.write(encodeTelnetInputForWire(data));
          },
          onComplete() {
            const contents = electronModule.webContents.fromId(event.sender.id);
            contents?.send("netcatty:telnet:auto-login-complete", { sessionId });
          },
          onUserInput() {
            const contents = electronModule.webContents.fromId(event.sender.id);
            contents?.send("netcatty:telnet:auto-login-cancelled", { sessionId });
          },
        });
    
        const writeRawTelnetCommand = (cmd, opt) => {
          if (socket.destroyed) return;
          socket.write(Buffer.from([telnetProtocol.IAC, cmd, opt]));
        };
    
        const writeRawSubnegotiation = (opt, payload) => {
          if (socket.destroyed) return;
          socket.write(Buffer.concat([
            Buffer.from([telnetProtocol.IAC, telnetProtocol.SB, opt]),
            payload,
            Buffer.from([telnetProtocol.IAC, telnetProtocol.SE]),
          ]));
        };
    
        const negotiator = telnetProtocol.createTelnetNegotiator({
          writeCommand: writeRawTelnetCommand,
          writeSubnegotiation: writeRawSubnegotiation,
          getWindowSize: () => {
            const session = sessions.get(sessionId);
            return { cols: session?.cols ?? cols, rows: session?.rows ?? rows };
          },
          onRemoteEchoChange: sendEchoMode,
          onLocalEchoChange: sendLocalEchoMode,
        });
    
        const telnetParser = telnetProtocol.createTelnetParser({
          onData: (clean) => {
            if (clean.length === 0) return;
            telnetCleanData = telnetCleanData.length === 0
              ? clean
              : Buffer.concat([telnetCleanData, clean]);
          },
          onCommand: (cmd, opt) => negotiator.handleCommand(cmd, opt),
          onSubnegotiation: (opt, payload) => negotiator.handleSubnegotiation(opt, payload),
        });
    
        const processIncomingTelnet = (data) => {
          // Lazy protocol activation: only flip on once we see an IAC from the
          // peer. Until then we just hand bytes back as-is so true raw-TCP-on-23
          // services (the long tail of embedded devices) are not corrupted.
          if (!telnetProtocolActive) {
            if (data.indexOf(0xff) < 0) return data;
            telnetProtocolActive = true;
            negotiator.start();
          }
          telnetCleanData = Buffer.alloc(0);
          telnetParser.feed(data);
          const out = telnetCleanData;
          telnetCleanData = Buffer.alloc(0);
          return out;
        };
    
        const connectTimeout = setTimeout(() => {
          if (!connected) {
            if (!isCurrentStart()) {
              socket.destroy();
              reject(new Error(TELNET_SESSION_REPLACED_ERROR));
              return;
            }
            console.error(`[Telnet] Connection timeout to ${hostname}:${port}`);
            socket.destroy();
            reject(new Error(`Connection timeout to ${hostname}:${port}`));
          }
        }, 10000);
    
        socket.on('connect', () => {
          connected = true;
          enableTcpNoDelay(socket);
          clearTimeout(connectTimeout);
          if (!isCurrentStart()) {
            socket.destroy();
            reject(new Error(TELNET_SESSION_REPLACED_ERROR));
            return;
          }
          console.log(`[Telnet] Connected to ${hostname}:${port}`);
    
          const session = {
            socket,
            type: 'telnet-native',
            webContentsId: event.sender.id,
            cols,
            rows,
            flushPendingData: null,
            lastIdlePrompt: "",
            lastIdlePromptAt: 0,
            _promptTrackTail: "",
            encoding: initialTelnetEncoding,
            decoderRef: telnetDecoderRef,
            autoLogin: telnetAutoLogin,
            releaseTelnetGeneration,
            telnetEchoMode: {
              sessionId,
              remoteEcho: remoteEchoEnabled,
              localEcho: localEchoEnabled,
            },
            sendTelnetWindowSize: () => negotiator.sendWindowSize(),
            // Mirror of the closure-local `telnetProtocolActive` so the resize
            // handler can avoid sending Telnet control bytes to raw-TCP peers.
            get telnetProtocolActive() {
              return telnetProtocolActive;
            },
          };
          activeSession = session;
          session.flushPendingData = flushTelnetPaced;
          sessions.set(sessionId, session);
          openTerminalOutputSession?.(sessionId, event.sender);
    
          // Start real-time session log stream if configured
          if (options.sessionLog?.enabled && options.sessionLog?.directory) {
            logStreamToken = sessionLogStreamManager.startStream(sessionId, {
              hostLabel: options.label || hostname,
              hostname,
              directory: options.sessionLog.directory,
              format: options.sessionLog.format || "txt",
              timestampsEnabled: Boolean(options.sessionLog.timestampsEnabled),
              startTime: Date.now(),
            });
          }
    
          resolve({ sessionId });
        });
    
        const getCurrentTelnetWebContentsId = () =>
          sessions.get(sessionId)?.webContentsId ?? event.sender.id;
        const getCurrentTelnetWebContents = () =>
          electronModule.webContents.fromId(getCurrentTelnetWebContentsId());
        const {
          bufferData: bufferTelnetData,
          flushPaced: flushTelnetPaced,
          discard: discardTelnet,
        } = createPtyOutputBuffer((data, meta) => {
          const contents = getCurrentTelnetWebContents();
          emitTerminalSessionData(contents, sessionId, data, {
            session: activeSession,
            cols,
            rows,
            meta,
          });
        }, {
          onPendingBytesChange: (bytes) => {
            const activeSession = sessions.get(sessionId);
            if (activeSession?.socket === socket) setBufferedOutputBytes(activeSession, bytes);
          },
          shouldAcceptOutput: () => activeSession != null
            && sessions.get(sessionId) === activeSession
            && shouldAcceptSessionOutput(activeSession),
        });
    
        const telnetZmodemSentry = createZmodemSentry({
          sessionId,
          onData(buf) {
            const decoded = telnetDecoderRef.current.write(buf);
            if (!decoded) return;
            const session = sessions.get(sessionId);
            if (session) trackSessionIdlePrompt(session, decoded);
            telnetAutoLogin.handleText(decoded);
            bufferTelnetData(decoded);
            sessionLogStreamManager.appendData(sessionId, decoded);
          },
          writeToRemote(buf) {
            // Escape 0xFF bytes as 0xFF 0xFF per Telnet spec so binary
            // ZMODEM data passes through without being treated as IAC.
            try {
              let hasFF = false;
              for (let i = 0; i < buf.length; i++) {
                if (buf[i] === 0xff) { hasFF = true; break; }
              }
              if (hasFF) {
                const escaped = [];
                for (let i = 0; i < buf.length; i++) {
                  escaped.push(buf[i]);
                  if (buf[i] === 0xff) escaped.push(0xff);
                }
                return socket.write(Buffer.from(escaped));
              } else {
                return socket.write(buf);
              }
            } catch { return true; }
          },
          getWebContents() {
            return getCurrentTelnetWebContents();
          },
          selectUploadFiles: selectZmodemUploadFiles
            ? () => selectZmodemUploadFiles(getCurrentTelnetWebContentsId(), sessionId)
            : undefined,
          selectDownloadDirectory: selectZmodemDownloadDirectory
            ? () => selectZmodemDownloadDirectory(getCurrentTelnetWebContentsId(), sessionId)
            : undefined,
          label: "Telnet",
        });
        // Attach sentry to session once created (connect callback runs after this)
        const attachTelnetSentry = () => {
          const session = sessions.get(sessionId);
          if (session?.socket === socket) {
            session.zmodemSentry = telnetZmodemSentry;
            session.discardPendingData = discardTelnet;
          }
        };
        socket.once('connect', attachTelnetSentry);
    
        socket.on('data', (data) => {
          if (!isCurrentSocket()) return;
    
          // Always run Telnet negotiation — even during ZMODEM, the Telnet
          // layer still escapes 0xFF as IAC IAC and sends control sequences.
          const cleanData = processIncomingTelnet(data);
          if (cleanData.length > 0 && shouldProcessSessionOutput(sessions.get(sessionId), telnetZmodemSentry)) {
            telnetZmodemSentry.consume(cleanData);
          }
        });
    
        socket.on('error', (err) => {
          console.error(`[Telnet] Socket error: ${err.message}`);
          clearTimeout(connectTimeout);
    
          if (!connected) {
            if (!isCurrentStart()) {
              reject(new Error(TELNET_SESSION_REPLACED_ERROR));
            } else {
              reject(new Error(`Failed to connect: ${err.message}`));
            }
          } else {
            if (!isCurrentSocket()) {
              sessionLogStreamManager.stopStream(sessionId, logStreamToken);
              return;
            }
            flushTelnetPaced(() => {
              if (telnetExitFinalized) return;
              if (!activeSession || sessions.get(sessionId) !== activeSession) return;
              telnetExitFinalized = true;
              sessionLogStreamManager.stopStream(sessionId, logStreamToken);
              const session = activeSession;
              if (session) {
                session.zmodemSentry?.cancel();
                const contents = electronModule.webContents.fromId(session.webContentsId);
                fanoutSessionExit(sessionId, contents, {
                  sessionId,
                  exitCode: 1,
                  error: err.message,
                  reason: "error",
                  _terminalSessionGeneration: session._terminalSessionGeneration,
                });
              }
              ptyProcessTree.unregisterPid(sessionId);
              closeTerminalOutputSession?.(sessionId);
              sessions.delete(sessionId);
              releaseTelnetGeneration();
            });
          }
        });
    
        socket.on('close', (hadError) => {
          console.log(`[Telnet] Connection closed${hadError ? ' with error' : ''}`);
          clearTimeout(connectTimeout);
    
          if (!isCurrentSocket()) {
            sessionLogStreamManager.stopStream(sessionId, logStreamToken);
            return;
          }
          flushTelnetPaced(() => {
            if (telnetExitFinalized) return;
            if (!activeSession || sessions.get(sessionId) !== activeSession) return;
            telnetExitFinalized = true;
            sessionLogStreamManager.stopStream(sessionId, logStreamToken);
            const session = activeSession;
            if (session) {
              session.zmodemSentry?.cancel();
              const contents = electronModule.webContents.fromId(session.webContentsId);
              fanoutSessionExit(sessionId, contents, {
                sessionId,
                exitCode: hadError ? 1 : 0,
                reason: hadError ? "error" : "closed",
                _terminalSessionGeneration: session._terminalSessionGeneration,
              });
            }
            ptyProcessTree.unregisterPid(sessionId);
            closeTerminalOutputSession?.(sessionId);
            sessions.delete(sessionId);
            releaseTelnetGeneration();
          });
        });
    
        console.log(`[Telnet] Connecting to ${hostname}:${port}...`);
        socket.connect(port, hostname);
      });
    }

    return { startTelnetSession };
  }
}

module.exports = { createTelnetSessionApi };
