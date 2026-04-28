/**
 * Terminal Bridge - Handles local shell, telnet/mosh, and serial port sessions
 * Extracted from main.cjs for single responsibility
 */

const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const pty = require("node-pty");
const { SerialPort } = require("serialport");
const iconv = require("iconv-lite");
const ptyProcessTree = require("./ptyProcessTree.cjs");

const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
const { detectShellKind } = require("./ai/ptyExec.cjs");
const { trackSessionIdlePrompt } = require("./ai/shellUtils.cjs");
const { createZmodemSentry } = require("./zmodemHelper.cjs");
const { discoverShells } = require("./shellDiscovery.cjs");

// Shared references
let sessions = null;
let electronModule = null;

// Normalize user-facing charset names into an iconv-lite encoding identifier.
// iconv-lite accepts a wide range of aliases directly ("utf-8", "gbk", etc.),
// so mostly this just lowercases + collapses non-alphanumerics and maps a few
// obvious GB* variants to gb18030 which is the superset we ship the encoding
// switcher with. Anything iconv doesn't recognize falls back to utf-8.
function normalizeTerminalEncoding(charset) {
  if (!charset) return 'utf-8';
  const raw = String(charset).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]/g, '');
  if (['utf8', 'utf-8'].includes(normalized)) return 'utf-8';
  if (normalized === 'gb18030' || normalized === 'gbk' || normalized === 'gb2312') return 'gb18030';
  return iconv.encodingExists(raw) ? raw : 'utf-8';
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
 * Locate an executable on POSIX systems by name.
 *
 * macOS GUI Electron apps inherit launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), missing Homebrew and other common
 * package-manager directories. `pty.spawn(name)` then either fails
 * synchronously with ENOENT or spawns a child that immediately exits
 * with no useful error surfaced to the renderer (see issue #842 for the
 * Mosh case).
 *
 * Returns the absolute path on success, or null when the binary cannot
 * be located anywhere we know to look. Win32 callers should keep using
 * findExecutable() which handles `where.exe` + Windows-specific paths.
 */
const POSIX_EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/local/bin",
  "/opt/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function isExecutableFile(candidate) {
  try {
    const st = fs.statSync(candidate);
    if (!st.isFile()) return false;
    // Windows has no POSIX execute bit — Node returns mode 0o100666 even for
    // .exe / .bat / .cmd files, so 0o111 is unreliable there. Treat any
    // regular file as executable on Win32 and let spawn-time PATHEXT /
    // extension handling reject non-executables.
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolvePosixExecutable(name, opts = {}) {
  if (process.platform === "win32") return null;
  if (!name || typeof name !== "string") return null;

  // Already an absolute or relative path: validate as-is.
  if (name.includes("/")) {
    return isExecutableFile(name) ? name : null;
  }
  if (!/^[a-zA-Z0-9._+-]+$/.test(name)) return null;

  const seen = new Set();
  const dirs = [];

  // 1. Honor the caller-supplied PATH first so callers that have already
  //    merged a host-level environmentVariables.PATH override don't see the
  //    fallback decline a binary that the spawned process would have found.
  //    Falls back to the main process PATH when no override is provided.
  const pathOverride = Object.prototype.hasOwnProperty.call(opts, "pathOverride")
    ? opts.pathOverride
    : process.env.PATH;
  for (const dir of (pathOverride || "").split(":")) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }

  // 2. Add directories the GUI launcher's PATH typically misses on macOS/Linux.
  for (const dir of POSIX_EXTRA_PATH_DIRS) {
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }

  // 3. User-scoped install locations (nix-profile, cargo, ~/.local).
  const home = process.env.HOME;
  if (home) {
    for (const sub of [".nix-profile/bin", ".cargo/bin", ".local/bin"]) {
      const dir = path.join(home, sub);
      if (!seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
    }
  }

  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
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
  
  const path = require("node:path");
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return name;

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
  const sessionId = payload?.sessionId || randomUUID();
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
  const sessionId = options.sessionId || randomUUID();

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
        encoding: initialTelnetEncoding,
        decoderRef: telnetDecoderRef,
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

    // Wrap the iconv decoder in a mutable ref so the encoding switcher
    // (setSessionEncoding IPC) can swap in a fresh decoder mid-session
    // without having to rewrite the closures below.
    const initialTelnetEncoding = normalizeTerminalEncoding(options.charset);
    const telnetDecoderRef = { current: iconv.getDecoder(initialTelnetEncoding) };

    const telnetWebContentsId = event.sender.id;
    const { bufferData: bufferTelnetData, flush: flushTelnet } = createPtyBuffer((data) => {
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
  const sessionId = options.sessionId || randomUUID();

  const cols = options.cols || 80;
  const rows = options.rows || 24;

  // Resolve the mosh client to an absolute path before spawning. Bare names
  // rely on the spawn-time PATH search, which on macOS GUI apps is reduced to
  // `/usr/bin:/bin:/usr/sbin:/sbin` and silently fails for Homebrew installs
  // (see issue #842). On Windows keep the existing behaviour.
  //
  // Resolution must consider the same PATH the spawned process will see —
  // host-level `environmentVariables.PATH` is merged into the child env
  // below, so the resolver checks that merged value first to avoid
  // rejecting a binary the child would actually have found.
  const optionsEnv = options.env || {};
  const mergedPathForResolution = Object.prototype.hasOwnProperty.call(optionsEnv, "PATH")
    ? optionsEnv.PATH
    : process.env.PATH;

  let moshCmd;
  let resolvedMoshDir = null;
  // 1. Honor user-supplied moshClientPath (Settings → Terminal → Mosh).
  //    Strict failure: a missing/non-executable file produces a clear error
  //    instead of silently falling back, so users notice typos / stale paths.
  const explicitClient = typeof options.moshClientPath === "string" ? options.moshClientPath.trim() : "";
  if (explicitClient) {
    const expanded = expandHomePath(explicitClient);
    // Reject relative paths up front. validatePath in the renderer is shared
    // with localShell and resolves bare names through PATH (so "mosh.exe"
    // would look valid in the UI), but here moshClientPath is taken as a
    // literal filesystem path and any non-absolute value would be resolved
    // against the app's cwd and silently fail.
    if (!path.isAbsolute(expanded)) {
      throw new Error(
        `Mosh client path must be absolute: "${explicitClient}". Use Settings → Terminal → Mosh to pick the binary, leave it empty to auto-detect, or enter an absolute path.`,
      );
    }
    if (!isExecutableFile(expanded)) {
      throw new Error(
        `Configured Mosh client not usable: ${explicitClient}. Update Settings → Terminal → Mosh, leave it empty to auto-detect, or pick another binary.`,
      );
    }
    moshCmd = path.resolve(expanded);
    // Always remember the directory so we can extend PATH and locate
    // mosh-client / ssh helpers regardless of platform — Windows
    // installs outside %PATH% otherwise can't resolve siblings even
    // though the wrapper itself runs.
    resolvedMoshDir = path.dirname(moshCmd);
  } else if (process.platform === "win32") {
    moshCmd = findExecutable("mosh") || "mosh.exe";
  } else {
    const resolved = resolvePosixExecutable("mosh", { pathOverride: mergedPathForResolution });
    if (!resolved) {
      const installHint =
        process.platform === "darwin"
          ? "macOS: brew install mosh"
          : "Linux: sudo apt install mosh / sudo dnf install mosh / sudo pacman -S mosh";
      throw new Error(
        `Mosh client not found on PATH. Install it (${installHint}) or place the 'mosh' binary somewhere on PATH such as /opt/homebrew/bin or /usr/local/bin. You can also point Settings → Terminal → Mosh at an absolute path.`,
      );
    }
    moshCmd = resolved;
    resolvedMoshDir = path.dirname(resolved);
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
    ...optionsEnv,
    TERM: 'xterm-256color',
    LANG: resolveLangFromCharset(options.charset),
  };

  // The mosh wrapper is a Perl script that exec's `mosh-client` (and `ssh`)
  // by name, so it needs them on PATH. Prepend the resolved mosh's directory
  // to the env PATH (typical layout: mosh + mosh-client live side by side).
  // Also point MOSH_CLIENT at the absolute mosh-client when present, so the
  // wrapper picks it up even if PATH is overridden downstream.
  if (resolvedMoshDir) {
    const sep = path.delimiter; // ":" on POSIX, ";" on Win32
    const existingPath = env.PATH || "";
    const onPath = existingPath
      .split(sep)
      .some((p) => p && path.normalize(p) === path.normalize(resolvedMoshDir));
    if (!onPath) {
      env.PATH = existingPath ? `${resolvedMoshDir}${sep}${existingPath}` : resolvedMoshDir;
    }
    if (!env.MOSH_CLIENT) {
      const clientCandidates =
        process.platform === "win32"
          ? ["mosh-client.exe", "mosh-client.bat", "mosh-client.cmd", "mosh-client"]
          : ["mosh-client"];
      for (const name of clientCandidates) {
        const candidate = path.join(resolvedMoshDir, name);
        if (isExecutableFile(candidate)) {
          env.MOSH_CLIENT = candidate;
          break;
        }
      }
    }
  }

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
  const sessionId = options.sessionId || randomUUID();

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

        const initialSerialEncoding = normalizeTerminalEncoding(options.charset);
        const serialDecoderRef = { current: iconv.getDecoder(initialSerialEncoding) };

        const session = {
          serialPort,
          type: 'serial',
          protocol: 'serial',
          shellKind: 'raw',
          encoding: initialSerialEncoding,
          // Kept for backward compatibility with aiBridge / mcpServerBridge
          // which read session.serialEncoding for exec calls.
          serialEncoding: initialSerialEncoding,
          decoderRef: serialDecoderRef,
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
            const decoded = serialDecoderRef.current.write(buf);
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
 * Set terminal decoder encoding for an active telnet or serial session.
 * SSH sessions are handled by sshBridge's own setEncoding IPC — this one
 * only responds to sessions that carry a decoderRef (telnet + serial).
 */
function setSessionEncoding(_event, { sessionId, encoding }) {
  const session = sessions?.get(sessionId);
  if (!session || !session.decoderRef) {
    return { ok: false, encoding: encoding || 'utf-8' };
  }
  const enc = normalizeTerminalEncoding(encoding);
  if (!iconv.encodingExists(enc)) {
    return { ok: false, encoding: enc };
  }
  session.encoding = enc;
  // Keep serialEncoding mirror in sync so aiBridge / mcpServerBridge exec
  // calls pick up the new encoding too.
  if (session.type === 'serial') {
    session.serialEncoding = enc;
  }
  // iconv stateful decoders carry partial-byte state from the previous
  // encoding, so swap in a fresh decoder rather than reconfiguring.
  session.decoderRef.current = iconv.getDecoder(enc);
  return { ok: true, encoding: enc };
}

/**
 * Register IPC handlers for terminal operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:local:start", startLocalSession);
  ipcMain.handle("netcatty:telnet:start", startTelnetSession);
  ipcMain.handle("netcatty:mosh:start", startMoshSession);
  ipcMain.handle("netcatty:mosh:detectClient", () => detectMoshClient());
  ipcMain.handle("netcatty:mosh:pickClient", () => pickMoshClient());
  ipcMain.handle("netcatty:serial:start", startSerialSession);
  ipcMain.handle("netcatty:serial:list", listSerialPorts);
  ipcMain.handle("netcatty:local:defaultShell", getDefaultShell);
  ipcMain.handle("netcatty:local:validatePath", validatePath);
  ipcMain.handle("netcatty:shells:discover", () => discoverShells());
  ipcMain.handle("netcatty:terminal:setEncoding", setSessionEncoding);
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
 * @returns {{ exists: boolean, isFile: boolean, isDirectory: boolean, isExecutable: boolean }}
 *
 * `isExecutable` mirrors isExecutableFile(): POSIX requires the file mode
 * to have an execute bit; Win32 treats any regular file as executable
 * (NTFS lacks POSIX bits — extension/PATHEXT decides at spawn time).
 * Existing callers ignore the new field; consumers that need exec
 * semantics (e.g. Mosh client path) read it explicitly.
 */
function statIsExecutable(stat) {
  if (!stat || !stat.isFile()) return false;
  if (process.platform === "win32") return true;
  return (stat.mode & 0o111) !== 0;
}

function validatePath(event, payload) {
  const targetPath = payload?.path;
  const type = payload?.type || 'any';
  if (!targetPath) {
    return { exists: false, isFile: false, isDirectory: false, isExecutable: false };
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
        isExecutable: statIsExecutable(stat),
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
          isExecutable: statIsExecutable(stat),
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
            isExecutable: statIsExecutable(stat),
          };
        }
      }
    }

    return { exists: false, isFile: false, isDirectory: false, isExecutable: false };
  } catch (err) {
    console.warn(`[Terminal] Error validating path "${targetPath}":`, err.message);
    return { exists: false, isFile: false, isDirectory: false, isExecutable: false };
  }
}

/**
 * Run the same auto-discovery startMoshSession uses, surfacing the result
 * (and the search list when nothing was found) to the Settings UI.
 */
function detectMoshClient() {
  if (process.platform === "win32") {
    const resolved = findExecutable("mosh");
    const found = !!resolved && resolved !== "mosh" && fs.existsSync(resolved);
    return {
      platform: "win32",
      found,
      path: found ? resolved : null,
      searchedPaths: [],
    };
  }
  const dirs = [];
  const seen = new Set();
  for (const dir of (process.env.PATH || "").split(":")) {
    if (dir && !seen.has(dir)) { seen.add(dir); dirs.push(dir); }
  }
  for (const dir of POSIX_EXTRA_PATH_DIRS) {
    if (!seen.has(dir)) { seen.add(dir); dirs.push(dir); }
  }
  const home = process.env.HOME;
  if (home) {
    for (const sub of [".nix-profile/bin", ".cargo/bin", ".local/bin"]) {
      const dir = path.join(home, sub);
      if (!seen.has(dir)) { seen.add(dir); dirs.push(dir); }
    }
  }
  const resolved = resolvePosixExecutable("mosh");
  return {
    platform: process.platform,
    found: !!resolved,
    path: resolved,
    searchedPaths: dirs,
  };
}

/**
 * Open a native file picker so the user can select a Mosh client binary.
 * Returns { canceled, filePath } so the renderer can decide what to do.
 */
async function pickMoshClient() {
  const { dialog, BrowserWindow } = electronModule || {};
  if (!dialog) {
    return { canceled: true, filePath: null };
  }
  const win = BrowserWindow?.getFocusedWindow?.() || undefined;
  const isWin = process.platform === "win32";
  const result = await dialog.showOpenDialog(win, {
    title: "Select Mosh client",
    properties: ["openFile", "showHiddenFiles"],
    filters: isWin
      ? [
          { name: "Executables", extensions: ["exe", "bat", "cmd"] },
          { name: "All Files", extensions: ["*"] },
        ]
      : [{ name: "All Files", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true, filePath: null };
  }
  return { canceled: false, filePath: result.filePaths[0] };
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
  detectMoshClient,
  pickMoshClient,
  startSerialSession,
  listSerialPorts,
  writeToSession,
  resizeSession,
  closeSession,
  cleanupAllSessions,
  getDefaultShell,
  validatePath,
};
