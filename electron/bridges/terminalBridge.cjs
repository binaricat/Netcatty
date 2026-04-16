/**
 * Terminal Bridge - Handles local shell, telnet/mosh, and serial port sessions
 * Extracted from main.cjs for single responsibility
 */

const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const pty = require("node-pty");
const { SerialPort } = require("serialport");
const ptyProcessTree = require("./ptyProcessTree.cjs");

const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
const { detectShellKind } = require("./ai/ptyExec.cjs");
const { trackSessionIdlePrompt } = require("./ai/shellUtils.cjs");
const { createZmodemSentry } = require("./zmodemHelper.cjs");
const { discoverShells } = require("./shellDiscovery.cjs");

// Shared references
let sessions = null;
let electronModule = null;

// Map user-facing charset names to Node.js StringDecoder/Buffer encoding names.
// Falls back to utf8 for unrecognized charsets (StringDecoder only supports a
// small set; for CJK encodings like GB18030/Big5 we'd need iconv-lite, which
// is out of scope for this change — utf8 is still the safer default).
function charsetToNodeEncoding(charset) {
  if (!charset) return 'utf8';
  const normalized = String(charset).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['utf8', 'utf-8'].includes(normalized)) return 'utf8';
  if (['latin1', 'iso88591', 'iso-8859-1', 'binary'].includes(normalized)) return 'latin1';
  if (normalized === 'ascii') return 'ascii';
  if (['utf16le', 'ucs2'].includes(normalized)) return 'utf16le';
  return 'utf8';
}

const DEFAULT_UTF8_LOCALE = "en_US.UTF-8";
const LOGIN_SHELLS = new Set(["bash", "zsh", "fish", "ksh"]);
const POWERSHELL_SHELLS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

function expandHomePath(targetPath) {
  if (!targetPath) return targetPath;
  if (targetPath === "~") return os.homedir();
  if (targetPath.startsWith("~/")) return path.join(os.homedir(), targetPath.slice(2));
  return targetPath;
}

function normalizeExecutablePath(targetPath) {
  const expanded = expandHomePath(targetPath);
  if (!expanded) return expanded;
  if (expanded.includes(path.sep) || expanded.startsWith(".")) {
    return path.resolve(expanded);
  }
  return expanded;
}

const getLoginShellArgs = (shellPath) => {
  if (!shellPath || process.platform === "win32") return [];
  const shellName = path.basename(shellPath);
  return LOGIN_SHELLS.has(shellName) ? ["-l"] : [];
};

/**
 * Initialize the terminal bridge with dependencies
 */
function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule;
}

/**
 * Create an 8ms/16KB PTY data buffer for reduced IPC overhead.
 * Mirrors the SSH stream buffering strategy in sshBridge.cjs.
 * @param {Function} sendFn - called with the accumulated string to deliver
 * @returns {{ bufferData: (data: string) => void, flush: () => void }}
 */
function createPtyBuffer(sendFn) {
  const FLUSH_INTERVAL = 8;      // ms - flush every 8ms (~120fps equivalent)
  const MAX_BUFFER_SIZE = 16384; // 16KB - flush immediately if buffer grows too large

  let dataBuffer = '';
  let flushTimeout = null;

  const flushBuffer = () => {
    if (dataBuffer.length > 0) {
      sendFn(dataBuffer);
      dataBuffer = '';
    }
    flushTimeout = null;
  };

  const flush = () => {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    flushBuffer();
  };

  const bufferData = (data) => {
    dataBuffer += data;
    if (dataBuffer.length >= MAX_BUFFER_SIZE) {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }
      flushBuffer();
    } else if (!flushTimeout) {
      flushTimeout = setTimeout(flushBuffer, FLUSH_INTERVAL);
    }
  };

  return { bufferData, flush };
}

/**
 * Find executable path on Windows
 */
function isWindowsAppExecutionAlias(filePath) {
  if (!filePath || process.platform !== "win32") return false;

  const normalizedPath = path.normalize(filePath).toLowerCase();
  const windowsAppsDir = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "WindowsApps",
  ).toLowerCase();

  return !!windowsAppsDir && normalizedPath.startsWith(`${windowsAppsDir}${path.sep}`);
}

function findExecutable(name) {
  if (process.platform !== "win32") return name;
  
  const { execFileSync } = require("child_process");
  try {
    const result = execFileSync("where.exe", [name], { encoding: "utf8" });
    const candidates = result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      if (name === "pwsh" && isWindowsAppExecutionAlias(candidate)) continue;
      return candidate;
    }
  } catch (err) {
    console.warn(`Could not find ${name} via where.exe:`, err.message);
  }
  
  // Fallback to common locations
  const path = require("node:path");
  const commonPaths = [];

  if (name === "pwsh") {
    commonPaths.push(
      path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
      path.join(process.env.ProgramW6432 || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    );
  }

  if (name === "powershell") {
    commonPaths.push(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    );
  }

  commonPaths.push(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSH", `${name}.exe`),
  );
  
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  
  return name;
}

function getDefaultLocalShell() {
  if (process.platform !== "win32") {
    return process.env.SHELL || "/bin/bash";
  }

  const pwsh = findExecutable("pwsh");
  if (pwsh && pwsh.toLowerCase() !== "pwsh") {
    return pwsh;
  }

  const powershell = findExecutable("powershell");
  if (powershell && powershell.toLowerCase() !== "powershell") {
    return powershell;
  }

  return "powershell.exe";
}

function getLocalShellArgs(shellPath) {
  if (!shellPath) return [];

  if (process.platform !== "win32") {
    return getLoginShellArgs(shellPath);
  }

  const shellName = path.basename(shellPath).toLowerCase();
  if (POWERSHELL_SHELLS.has(shellName)) {
    return ["-NoLogo"];
  }

  return [];
}

const isUtf8Locale = (value) => typeof value === "string" && /utf-?8/i.test(value);

const isEmptyLocale = (value) => {
  if (value === undefined || value === null) return true;
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  return trimmed === "C" || trimmed === "POSIX";
};

const applyLocaleDefaults = (env) => {
  const hasUtf8 =
    isUtf8Locale(env.LC_ALL) || isUtf8Locale(env.LC_CTYPE) || isUtf8Locale(env.LANG);
  if (hasUtf8) return env;

  const hasAnyLocale =
    !isEmptyLocale(env.LC_ALL) || !isEmptyLocale(env.LC_CTYPE) || !isEmptyLocale(env.LANG);
  if (hasAnyLocale) return env;

  return {
    ...env,
    LANG: DEFAULT_UTF8_LOCALE,
    LC_CTYPE: DEFAULT_UTF8_LOCALE,
    LC_ALL: DEFAULT_UTF8_LOCALE,
  };
};

/**
 * Start a local terminal session
 */
function startLocalSession(event, payload) {
  const sessionId =
    payload?.sessionId ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const defaultShell = getDefaultLocalShell();
  // payload.shell may be a discovered shell ID (e.g., "wsl-ubuntu") — resolve it
  let resolvedShell = payload?.shell;
  let resolvedArgs = payload?.shellArgs;
  if (resolvedShell && !/[/\\]/.test(resolvedShell)) {
    // Looks like a shell ID, not a path — try to resolve from discovery cache
    const shells = discoverShells();
    const match = shells.find((s) => s.id === resolvedShell);
    if (match) {
      resolvedShell = match.command;
      resolvedArgs = resolvedArgs ?? match.args;
    }
  }
  const shell = normalizeExecutablePath(resolvedShell) || defaultShell;
  const shellArgs = resolvedArgs ?? getLocalShellArgs(shell);
  const shellKind = detectShellKind(shell);
  const env = applyLocaleDefaults({
    ...process.env,
    ...(payload?.env || {}),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
  
  // Determine the starting directory
  // Default to home directory if not specified or if specified path is invalid
  const defaultCwd = os.homedir();
  let cwd = defaultCwd;
  
  if (payload?.cwd) {
    try {
      // Resolve to absolute path and check if it exists and is a directory
      const resolvedPath = path.resolve(expandHomePath(payload.cwd));
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
        cwd = resolvedPath;
      } else {
        console.warn(`[Terminal] Specified cwd "${payload.cwd}" is not a valid directory, using home directory`);
      }
    } catch (err) {
      console.warn(`[Terminal] Error validating cwd "${payload.cwd}":`, err.message);
    }
  }
  
  const proc = pty.spawn(shell, shellArgs, {
    name: env.TERM || "xterm-256color",
    cols: payload?.cols || 80,
    rows: payload?.rows || 24,
    env,
    cwd,
    encoding: null, // Return Buffer for ZMODEM binary support
  });
  
  const session = {
    proc,
    pty: proc,
    type: "local",
    protocol: "local",
    webContentsId: event.sender.id,
    hostname: "localhost",
    username: (() => {
      try {
        return os.userInfo().username || "local";
      } catch {
        return "local";
      }
    })(),
    label: "Local Terminal",
    shellExecutable: shell,
    shellKind,
    flushPendingData: null,
    lastIdlePrompt: "",
    lastIdlePromptAt: 0,
    _promptTrackTail: "",
  };
  sessions.set(sessionId, session);
  ptyProcessTree.registerPid(sessionId, proc.pid);

  // Start real-time session log stream if configured
  if (payload?.sessionLog?.enabled && payload?.sessionLog?.directory) {
    sessionLogStreamManager.startStream(sessionId, {
      hostLabel: "Local",
      hostname: "localhost",
      directory: payload.sessionLog.directory,
      format: payload.sessionLog.format || "txt",
      startTime: Date.now(),
    });
  }

  const { bufferData: bufferLocalData, flush: flushLocal } = createPtyBuffer((data) => {
    const contents = electronModule.webContents.fromId(session.webContentsId);
    contents?.send("netcatty:data", { sessionId, data });
  });
  session.flushPendingData = flushLocal;

  // On Windows, node-pty ignores encoding: null and still emits UTF-8
  // strings, making raw-byte ZMODEM impossible for local PTY sessions.
  // Only wire up the sentry on platforms where encoding: null works.
  if (process.platform !== "win32") {
    const localDecoder = new StringDecoder("utf8");
    const zmodemSentry = createZmodemSentry({
      sessionId,
      onData(buf) {
        const str = localDecoder.write(buf);
        if (!str) return;
        trackSessionIdlePrompt(session, str);
        bufferLocalData(str);
        sessionLogStreamManager.appendData(sessionId, str);
      },
      writeToRemote(buf) {
        try { return proc.write(buf); } catch { return true; }
      },
      getWebContents() {
        return electronModule.webContents.fromId(session.webContentsId);
      },
      label: "Local",
    });
    session.zmodemSentry = zmodemSentry;

    proc.onData((data) => {
      zmodemSentry.consume(data);
    });
  } else {
    proc.onData((data) => {
      trackSessionIdlePrompt(session, data);
      bufferLocalData(data);
      sessionLogStreamManager.appendData(sessionId, data);
    });
  }

  proc.onExit((evt) => {
    flushLocal();
    sessionLogStreamManager.stopStream(sessionId);
    ptyProcessTree.unregisterPid(sessionId);
    sessions.delete(sessionId);
    const contents = electronModule.webContents.fromId(session.webContentsId);
    // Signal present = killed externally (show disconnected UI).
    // No signal = process exited normally, even with non-zero code
    // (e.g. user typed `exit` after a failed command), so auto-close.
    const reason = evt.signal ? "error" : "exited";
    contents?.send("netcatty:exit", { sessionId, ...evt, reason });
  });

  return { sessionId };
}

/**
 * Start a Telnet session using native Node.js net module
 */
async function startTelnetSession(event, options) {
  const sessionId =
    options.sessionId ||
    `telnet-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const hostname = options.hostname;
  const port = options.port || 23;
  const cols = options.cols || 80;
  const rows = options.rows || 24;

  console.log(`[Telnet] Starting connection to ${hostname}:${port}`);

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let connected = false;

    // Telnet protocol constants
    const TELNET = {
      IAC: 255,
      DONT: 254,
      DO: 253,
      WONT: 252,
      WILL: 251,
      SB: 250,
      SE: 240,
      ECHO: 1,
      SUPPRESS_GO_AHEAD: 3,
      STATUS: 5,
      TERMINAL_TYPE: 24,
      NAWS: 31,
      TERMINAL_SPEED: 32,
      LINEMODE: 34,
      NEW_ENVIRON: 39,
    };

    const sendWindowSize = () => {
      const buf = Buffer.from([
        TELNET.IAC, TELNET.SB, TELNET.NAWS,
        (cols >> 8) & 0xff, cols & 0xff,
        (rows >> 8) & 0xff, rows & 0xff,
        TELNET.IAC, TELNET.SE
      ]);
      socket.write(buf);
    };

    const handleTelnetNegotiation = (data) => {
      const output = [];
      let i = 0;

      while (i < data.length) {
        if (data[i] === TELNET.IAC) {
          if (i + 1 >= data.length) break;
          
          const cmd = data[i + 1];
          
          if (cmd === TELNET.IAC) {
            output.push(255);
            i += 2;
            continue;
          }

          if (cmd === TELNET.DO || cmd === TELNET.DONT || cmd === TELNET.WILL || cmd === TELNET.WONT) {
            if (i + 2 >= data.length) break;
            
            const opt = data[i + 2];
            console.log(`[Telnet] Received: ${cmd === TELNET.DO ? 'DO' : cmd === TELNET.DONT ? 'DONT' : cmd === TELNET.WILL ? 'WILL' : 'WONT'} ${opt}`);

            if (cmd === TELNET.DO) {
              if (opt === TELNET.NAWS) {
                socket.write(Buffer.from([TELNET.IAC, TELNET.WILL, opt]));
                sendWindowSize();
              } else if (opt === TELNET.TERMINAL_TYPE) {
                socket.write(Buffer.from([TELNET.IAC, TELNET.WILL, opt]));
              } else if (opt === TELNET.SUPPRESS_GO_AHEAD) {
                socket.write(Buffer.from([TELNET.IAC, TELNET.WILL, opt]));
              } else {
                socket.write(Buffer.from([TELNET.IAC, TELNET.WONT, opt]));
              }
            } else if (cmd === TELNET.WILL) {
              if (opt === TELNET.ECHO || opt === TELNET.SUPPRESS_GO_AHEAD) {
                socket.write(Buffer.from([TELNET.IAC, TELNET.DO, opt]));
              } else {
                socket.write(Buffer.from([TELNET.IAC, TELNET.DONT, opt]));
              }
            } else if (cmd === TELNET.DONT) {
              socket.write(Buffer.from([TELNET.IAC, TELNET.WONT, opt]));
            } else if (cmd === TELNET.WONT) {
              socket.write(Buffer.from([TELNET.IAC, TELNET.DONT, opt]));
            }

            i += 3;
            continue;
          }

          if (cmd === TELNET.SB) {
            let seIndex = i + 2;
            while (seIndex < data.length - 1) {
              if (data[seIndex] === TELNET.IAC && data[seIndex + 1] === TELNET.SE) {
                break;
              }
              seIndex++;
            }

            if (seIndex < data.length - 1) {
              const subOpt = data[i + 2];
              console.log(`[Telnet] Sub-negotiation for option ${subOpt}`);
              
              if (subOpt === TELNET.TERMINAL_TYPE && data[i + 3] === 1) {
                const termType = 'xterm-256color';
                const response = Buffer.concat([
                  Buffer.from([TELNET.IAC, TELNET.SB, TELNET.TERMINAL_TYPE, 0]),
                  Buffer.from(termType),
                  Buffer.from([TELNET.IAC, TELNET.SE])
                ]);
                socket.write(response);
              }
              
              i = seIndex + 2;
              continue;
            }
          }

          i += 2;
          continue;
        }

        output.push(data[i]);
        i++;
      }

      return Buffer.from(output);
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
      };
      session.flushPendingData = flushTelnet;
      sessions.set(sessionId, session);

      // Start real-time session log stream if configured
      if (options.sessionLog?.enabled && options.sessionLog?.directory) {
        sessionLogStreamManager.startStream(sessionId, {
          hostLabel: options.label || hostname,
          hostname,
          directory: options.sessionLog.directory,
          format: options.sessionLog.format || "txt",
          startTime: Date.now(),
        });
      }

      resolve({ sessionId });
    });

    const telnetDecoder = new StringDecoder(charsetToNodeEncoding(options.charset));

    const telnetWebContentsId = event.sender.id;
    const { bufferData: bufferTelnetData, flush: flushTelnet } = createPtyBuffer((data) => {
      const contents = electronModule.webContents.fromId(telnetWebContentsId);
      contents?.send("netcatty:data", { sessionId, data });
    });

    const telnetZmodemSentry = createZmodemSentry({
      sessionId,
      onData(buf) {
        const decoded = telnetDecoder.write(buf);
        if (!decoded) return;
        const session = sessions.get(sessionId);
        if (session) trackSessionIdlePrompt(session, decoded);
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
      const cleanData = handleTelnetNegotiation(data);
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
        sessionLogStreamManager.stopStream(sessionId);
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
      sessionLogStreamManager.stopStream(sessionId);
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

/**
 * Start a Mosh session using system mosh-client
 */
async function startMoshSession(event, options) {
  const sessionId =
    options.sessionId ||
    `mosh-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const cols = options.cols || 80;
  const rows = options.rows || 24;

  let moshCmd = 'mosh';
  if (process.platform === 'win32') {
    moshCmd = findExecutable('mosh') || 'mosh.exe';
  }

  const args = [];
  
  if (options.port && options.port !== 22) {
    args.push('--ssh=ssh -p ' + options.port);
  }

  if (options.moshServerPath) {
    args.push('--server=' + options.moshServerPath);
  }

  const userHost = options.username 
    ? `${options.username}@${options.hostname}`
    : options.hostname;
  args.push(userHost);

  const resolveLangFromCharset = (charset) => {
    if (!charset) return 'en_US.UTF-8';
    const trimmed = String(charset).trim();
    if (/^utf-?8$/i.test(trimmed) || /^utf8$/i.test(trimmed)) {
      return 'en_US.UTF-8';
    }
    return trimmed;
  };

  const env = {
    ...process.env,
    ...(options.env || {}),
    TERM: 'xterm-256color',
    LANG: resolveLangFromCharset(options.charset),
  };

  if (options.agentForwarding && process.env.SSH_AUTH_SOCK) {
    env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  }

  try {
    const proc = pty.spawn(moshCmd, args, {
      cols,
      rows,
      env,
      cwd: os.homedir(),
      encoding: null, // Return Buffer for ZMODEM binary support
    });

    const session = {
      proc,
      pty: proc,
      type: 'mosh',
      protocol: 'mosh',
      webContentsId: event.sender.id,
      hostname: options.hostname || '',
      username: options.username || '',
      label: options.label || options.hostname || 'Mosh Session',
      shellKind: 'posix',
      shellExecutable: 'remote-shell',
      flushPendingData: null,
      lastIdlePrompt: "",
      lastIdlePromptAt: 0,
      _promptTrackTail: "",
    };
    sessions.set(sessionId, session);

    // Start real-time session log stream if configured
    if (options.sessionLog?.enabled && options.sessionLog?.directory) {
      sessionLogStreamManager.startStream(sessionId, {
        hostLabel: options.label || options.hostname,
        hostname: options.hostname,
        directory: options.sessionLog.directory,
        format: options.sessionLog.format || "txt",
        startTime: Date.now(),
      });
    }

    const { bufferData: bufferMoshData, flush: flushMosh } = createPtyBuffer((data) => {
      const contents = electronModule.webContents.fromId(session.webContentsId);
      contents?.send("netcatty:data", { sessionId, data });
    });
    session.flushPendingData = flushMosh;

    if (process.platform !== "win32") {
      const moshDecoder = new StringDecoder("utf8");
      const moshZmodemSentry = createZmodemSentry({
        sessionId,
        onData(buf) {
          const str = moshDecoder.write(buf);
          if (!str) return;
          trackSessionIdlePrompt(session, str);
          bufferMoshData(str);
          sessionLogStreamManager.appendData(sessionId, str);
        },
        writeToRemote(buf) {
          try { return proc.write(buf); } catch { return true; }
        },
        getWebContents() {
          return electronModule.webContents.fromId(session.webContentsId);
        },
        label: "Mosh",
      });
      session.zmodemSentry = moshZmodemSentry;

      proc.onData((data) => {
        moshZmodemSentry.consume(data);
      });
    } else {
      proc.onData((data) => {
        trackSessionIdlePrompt(session, data);
        bufferMoshData(data);
        sessionLogStreamManager.appendData(sessionId, data);
      });
    }

    proc.onExit((evt) => {
      flushMosh();
      sessionLogStreamManager.stopStream(sessionId);
      ptyProcessTree.unregisterPid(sessionId);
      sessions.delete(sessionId);
      const contents = electronModule.webContents.fromId(session.webContentsId);
      // Mosh non-zero exit typically means connection/auth failure — show error UI
      contents?.send("netcatty:exit", { sessionId, ...evt, reason: evt.exitCode === 0 ? "exited" : "error" });
    });

    return { sessionId };
  } catch (err) {
    console.error("[Mosh] Failed to start mosh session:", err.message);
    throw err;
  }
}

/**
 * List available serial ports (hardware only)
 */
async function listSerialPorts() {
  try {
    const ports = await SerialPort.list();
    return ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer || '',
      serialNumber: port.serialNumber || '',
      vendorId: port.vendorId || '',
      productId: port.productId || '',
      pnpId: port.pnpId || '',
      type: 'hardware',
    }));
  } catch (err) {
    console.error("[Serial] Failed to list ports:", err.message);
    return [];
  }
}

/**
 * Start a serial port session (supports both hardware serial ports and PTY devices)
 * Note: SerialPort library can open PTY devices directly, they just won't appear in list()
 */
async function startSerialSession(event, options) {
  const sessionId =
    options.sessionId ||
    `serial-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const portPath = options.path;
  const baudRate = options.baudRate || 115200;
  const dataBits = options.dataBits || 8;
  const stopBits = options.stopBits || 1;
  const parity = options.parity || 'none';
  const flowControl = options.flowControl || 'none';

  console.log(`[Serial] Starting connection to ${portPath} at ${baudRate} baud`);

  return new Promise((resolve, reject) => {
    try {
      const serialPort = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        dataBits: dataBits,
        stopBits: stopBits,
        parity: parity,
        rtscts: flowControl === 'rts/cts',
        xon: flowControl === 'xon/xoff',
        xoff: flowControl === 'xon/xoff',
        autoOpen: false,
      });

      serialPort.open((err) => {
        if (err) {
          console.error(`[Serial] Failed to open port ${portPath}:`, err.message);
          reject(new Error(`Failed to open serial port: ${err.message}`));
          return;
        }

        console.log(`[Serial] Connected to ${portPath}`);

        const serialEncoding = charsetToNodeEncoding(options.charset);
        const serialDecoder = new StringDecoder(serialEncoding);

        const session = {
          serialPort,
          type: 'serial',
          protocol: 'serial',
          shellKind: 'raw',
          serialEncoding,
          webContentsId: event.sender.id,
        };
        sessions.set(sessionId, session);

        // Start real-time session log stream if configured
        if (options.sessionLog?.enabled && options.sessionLog?.directory) {
          sessionLogStreamManager.startStream(sessionId, {
            hostLabel: options.label || portPath,
            hostname: portPath,
            directory: options.sessionLog.directory,
            format: options.sessionLog.format || "txt",
            startTime: Date.now(),
          });
        }

        const serialZmodemSentry = createZmodemSentry({
          sessionId,
          onData(buf) {
            const decoded = serialDecoder.write(buf);
            if (!decoded) return;
            const contents = electronModule.webContents.fromId(session.webContentsId);
            contents?.send("netcatty:data", { sessionId, data: decoded });
            sessionLogStreamManager.appendData(sessionId, decoded);
          },
          writeToRemote(buf) {
            try { return serialPort.write(buf); } catch { return true; }
          },
          getWebContents() {
            return electronModule.webContents.fromId(session.webContentsId);
          },
          label: "Serial",
        });
        session.zmodemSentry = serialZmodemSentry;

        serialPort.on('data', (data) => {
          // data is already Buffer from serialport — feed to sentry
          serialZmodemSentry.consume(data);
        });

        serialPort.on('error', (err) => {
          console.error(`[Serial] Port error: ${err.message}`);
          session.zmodemSentry?.cancel();
          sessionLogStreamManager.stopStream(sessionId);
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("netcatty:exit", { sessionId, exitCode: 1, error: err.message, reason: "error" });
          ptyProcessTree.unregisterPid(sessionId);
          sessions.delete(sessionId);
        });

        serialPort.on('close', () => {
          console.log(`[Serial] Port closed`);
          session.zmodemSentry?.cancel();
          sessionLogStreamManager.stopStream(sessionId);
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("netcatty:exit", { sessionId, exitCode: 0, reason: "closed" });
          ptyProcessTree.unregisterPid(sessionId);
          sessions.delete(sessionId);
        });

        resolve({ sessionId });
      });
    } catch (err) {
      console.error("[Serial] Failed to start serial session:", err.message);
      reject(err);
    }
  });
}

/**
 * Write data to a session
 */
function writeToSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;

  // During ZMODEM transfer, block terminal input (Ctrl+C cancels the transfer)
  if (session.zmodemSentry?.isActive()) {
    if (payload.data === '\x03') {
      session.zmodemSentry.cancel();
    }
    return;
  }

  try {
    if (session.stream) {
      session.stream.write(payload.data);
    } else if (session.proc) {
      session.proc.write(payload.data);
    } else if (session.socket) {
      session.socket.write(payload.data);
    } else if (session.serialPort) {
      session.serialPort.write(payload.data);
    }
  } catch (err) {
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
      console.warn("Write failed", err);
    }
  }
}

/**
 * Resize a session terminal
 */
function resizeSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  
  try {
    if (session.stream) {
      session.stream.setWindow(payload.rows, payload.cols, 0, 0);
    } else if (session.proc) {
      session.proc.resize(payload.cols, payload.rows);
    } else if (session.socket && session.type === 'telnet-native') {
      session.cols = payload.cols;
      session.rows = payload.rows;
      const TELNET = { IAC: 255, SB: 250, SE: 240, NAWS: 31 };
      const buf = Buffer.from([
        TELNET.IAC, TELNET.SB, TELNET.NAWS,
        (payload.cols >> 8) & 0xff, payload.cols & 0xff,
        (payload.rows >> 8) & 0xff, payload.rows & 0xff,
        TELNET.IAC, TELNET.SE
      ]);
      session.socket.write(buf);
    }
  } catch (err) {
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
      console.warn("Resize failed", err);
    }
  }
}

/**
 * Close a session
 */
function closeSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  
  try {
    session.zmodemSentry?.cancel();
    session.flushPendingData?.();
    if (session.stream) {
      session.stream.close();
      session.conn?.end();
    } else if (session.proc) {
      session.proc.kill();
    } else if (session.socket) {
      session.socket.destroy();
    } else if (session.serialPort) {
      session.serialPort.close();
    }
    if (session.chainConnections) {
      for (const c of session.chainConnections) {
        try { c.end(); } catch {}
      }
    }
  } catch (err) {
    console.warn("Close failed", err);
  }
  ptyProcessTree.unregisterPid(payload.sessionId);
  sessions.delete(payload.sessionId);
}

/**
 * Register IPC handlers for terminal operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:local:start", startLocalSession);
  ipcMain.handle("netcatty:telnet:start", startTelnetSession);
  ipcMain.handle("netcatty:mosh:start", startMoshSession);
  ipcMain.handle("netcatty:serial:start", startSerialSession);
  ipcMain.handle("netcatty:serial:list", listSerialPorts);
  ipcMain.handle("netcatty:local:defaultShell", getDefaultShell);
  ipcMain.handle("netcatty:local:validatePath", validatePath);
  ipcMain.handle("netcatty:shells:discover", () => discoverShells());
  ipcMain.on("netcatty:write", writeToSession);
  ipcMain.on("netcatty:resize", resizeSession);
  ipcMain.on("netcatty:close", closeSession);
}

/**
 * Get the default shell for the current platform
 */
function getDefaultShell() {
  return getDefaultLocalShell();
}

/**
 * Validate a path - check if it exists and whether it's a file or directory
 * @param {object} event - IPC event
 * @param {object} payload - Contains { path: string, type?: 'file' | 'directory' | 'any' }
 * @returns {{ exists: boolean, isFile: boolean, isDirectory: boolean }}
 */
function validatePath(event, payload) {
  const targetPath = payload?.path;
  const type = payload?.type || 'any';
  if (!targetPath) {
    return { exists: false, isFile: false, isDirectory: false };
  }
  
  try {
    // Resolve path (handle ~, etc.)
    let resolvedPath = expandHomePath(targetPath);
    resolvedPath = path.resolve(resolvedPath);
    
    if (fs.existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      return {
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
      };
    }
    
    // If type is 'file' and path doesn't exist, try to resolve via PATH (for executables like cmd.exe, powershell.exe)
    if (type === 'file') {
      const resolvedExecutable = findExecutable(targetPath);
      // findExecutable returns the original name if not found, so check if it actually resolves to a real path
      if (resolvedExecutable !== targetPath && fs.existsSync(resolvedExecutable)) {
        const stat = fs.statSync(resolvedExecutable);
        return {
          exists: true,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
        };
      }
      // Also try with .exe extension on Windows if not already present
      if (process.platform === 'win32' && !targetPath.toLowerCase().endsWith('.exe')) {
        const withExe = findExecutable(targetPath + '.exe');
        if (withExe !== targetPath + '.exe' && fs.existsSync(withExe)) {
          const stat = fs.statSync(withExe);
          return {
            exists: true,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
          };
        }
      }
    }
    
    return { exists: false, isFile: false, isDirectory: false };
  } catch (err) {
    console.warn(`[Terminal] Error validating path "${targetPath}":`, err.message);
    return { exists: false, isFile: false, isDirectory: false };
  }
}

/**
 * Cleanup all sessions - call before app quit
 */
function cleanupAllSessions() {
  console.log(`[Terminal] Cleaning up ${sessions.size} sessions before quit`);
  for (const [sessionId, session] of sessions) {
    try {
      session.zmodemSentry?.cancel();
      if (session.stream) {
        session.stream.close();
        session.conn?.end();
      } else if (session.proc) {
        // For node-pty on Windows, we need to kill more gracefully
        try {
          session.proc.kill();
        } catch (e) {
          // Ignore errors during cleanup
        }
      } else if (session.socket) {
        session.socket.destroy();
      } else if (session.serialPort) {
        try {
          session.serialPort.close();
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
      if (session.chainConnections) {
        for (const c of session.chainConnections) {
          try { c.end(); } catch {}
        }
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
  for (const [sessionId] of sessions) {
    ptyProcessTree.unregisterPid(sessionId);
  }
  sessions.clear();
}

module.exports = {
  init,
  registerHandlers,
  findExecutable,
  startLocalSession,
  startTelnetSession,
  startMoshSession,
  startSerialSession,
  listSerialPorts,
  writeToSession,
  resizeSession,
  closeSession,
  cleanupAllSessions,
  getDefaultShell,
  validatePath,
};
