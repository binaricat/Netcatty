/* eslint-disable no-undef */
function createTelnetSessionApi(ctx) {
  with (ctx) {
    async function startTelnetSession(event, options) {
      const sessionId = options.sessionId || randomUUID();
    
      const hostname = options.hostname;
      const port = options.port || 23;
      const cols = options.cols || 80;
      const rows = options.rows || 24;
    
      console.log(`[Telnet] Starting connection to ${hostname}:${port}`);
    
      return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        enableTcpNoDelay(socket);
        let connected = false;
        // Token for the log stream we open on this connection. Captured here so
        // the close/error handlers below can pass it back to stopStream and
        // avoid tearing down a fresh stream that a subsequent reconnect on the
        // same sessionId may have started (issue #916).
        let logStreamToken = null;
        const telnetAutoLogin = createTelnetAutoLogin({
          username: options.username,
          password: options.password,
          write(data) {
            if (!socket.destroyed) socket.write(data);
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
    
        // Telnet protocol state. Negotiation only activates once we see an IAC
        // byte from the peer — if the remote never speaks the protocol (some
        // legacy raw-TCP services on port 23), we fall back to passthrough so we
        // do not corrupt their stream by misreading stray 0xFF bytes as IAC.
        let telnetProtocolActive = false;
        let telnetCleanData = Buffer.alloc(0);
    
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
            console.error(`[Telnet] Connection timeout to ${hostname}:${port}`);
            socket.destroy();
            reject(new Error(`Connection timeout to ${hostname}:${port}`));
          }
        }, 10000);
    
        socket.on('connect', () => {
          connected = true;
          enableTcpNoDelay(socket);
          clearTimeout(connectTimeout);
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
            // Mirror of the closure-local `telnetProtocolActive` so the resize
            // handler (which only sees the session record) can decide whether
            // to push a NAWS subnegotiation.
            get telnetProtocolActive() {
              return telnetProtocolActive;
            },
          };
          session.flushPendingData = flushTelnet;
          sessions.set(sessionId, session);
    
          // Start real-time session log stream if configured
          if (options.sessionLog?.enabled && options.sessionLog?.directory) {
            logStreamToken = sessionLogStreamManager.startStream(sessionId, {
              hostLabel: options.label || hostname,
              hostname,
              directory: options.sessionLog.directory,
              format: options.sessionLog.format || "txt",
              startTime: Date.now(),
            });
          }
    
          resolve({ sessionId });
        });
    
        // Wrap the iconv decoder in a mutable ref so the encoding switcher
        // (setSessionEncoding IPC) can swap in a fresh decoder mid-session
        // without having to rewrite the closures below.
        const initialTelnetEncoding = normalizeTerminalEncoding(options.charset);
        const telnetDecoderRef = { current: iconv.getDecoder(initialTelnetEncoding) };
    
        const telnetWebContentsId = event.sender.id;
        const { bufferData: bufferTelnetData, flush: flushTelnet } = createPtyOutputBuffer((data) => {
          const contents = electronModule.webContents.fromId(telnetWebContentsId);
          contents?.send("netcatty:data", { sessionId, data });
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
            return electronModule.webContents.fromId(telnetWebContentsId);
          },
          label: "Telnet",
        });
        // Attach sentry to session once created (connect callback runs after this)
        const attachTelnetSentry = () => {
          const session = sessions.get(sessionId);
          if (session) session.zmodemSentry = telnetZmodemSentry;
        };
        socket.once('connect', attachTelnetSentry);
    
        socket.on('data', (data) => {
          const session = sessions.get(sessionId);
          if (!session) return;
    
          // Always run Telnet negotiation — even during ZMODEM, the Telnet
          // layer still escapes 0xFF as IAC IAC and sends control sequences.
          const cleanData = processIncomingTelnet(data);
          if (cleanData.length > 0) {
            telnetZmodemSentry.consume(cleanData);
          }
        });
    
        socket.on('error', (err) => {
          console.error(`[Telnet] Socket error: ${err.message}`);
          clearTimeout(connectTimeout);
    
          if (!connected) {
            reject(new Error(`Failed to connect: ${err.message}`));
          } else {
            flushTelnet();
            sessionLogStreamManager.stopStream(sessionId, logStreamToken);
            const session = sessions.get(sessionId);
            if (session) {
              session.zmodemSentry?.cancel();
              const contents = electronModule.webContents.fromId(session.webContentsId);
              contents?.send("netcatty:exit", { sessionId, exitCode: 1, error: err.message, reason: "error" });
            }
            ptyProcessTree.unregisterPid(sessionId);
            sessions.delete(sessionId);
          }
        });
    
        socket.on('close', (hadError) => {
          console.log(`[Telnet] Connection closed${hadError ? ' with error' : ''}`);
          clearTimeout(connectTimeout);
    
          flushTelnet();
          sessionLogStreamManager.stopStream(sessionId, logStreamToken);
          const session = sessions.get(sessionId);
          if (session) {
            session.zmodemSentry?.cancel();
            const contents = electronModule.webContents.fromId(session.webContentsId);
            contents?.send("netcatty:exit", { sessionId, exitCode: hadError ? 1 : 0, reason: hadError ? "error" : "closed" });
          }
          ptyProcessTree.unregisterPid(sessionId);
          sessions.delete(sessionId);
        });
    
        console.log(`[Telnet] Connecting to ${hostname}:${port}...`);
        socket.connect(port, hostname);
      });
    }

    return { startTelnetSession };
  }
}

module.exports = { createTelnetSessionApi };
