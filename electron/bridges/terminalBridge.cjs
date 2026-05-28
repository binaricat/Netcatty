/**
 * Terminal Bridge - Handles local shell, telnet/mosh, and serial port sessions
 * Extracted from main.cjs for single responsibility
 */

const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const { StringDecoder } = require("node:string_decoder");
const pty = require("node-pty");
const { SerialPort } = require("serialport");
const iconv = require("iconv-lite");
const ptyProcessTree = require("./ptyProcessTree.cjs");

const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
const { detectShellKind } = require("./ai/ptyExec.cjs");
const { stripAnsi, trackSessionIdlePrompt } = require("./ai/shellUtils.cjs");
const { createZmodemSentry } = require("./zmodemHelper.cjs");
const { discoverShells } = require("./shellDiscovery.cjs");
const moshHandshake = require("./moshHandshake.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const { createTelnetAutoLogin } = require("./telnetAutoLogin.cjs");
const telnetProtocol = require("./telnetProtocol.cjs");
const { createPtyOutputBuffer } = require("./ptyOutputBuffer.cjs");
const { enableTcpNoDelay } = require("./tcpNoDelay.cjs");

const execFileAsync = promisify(execFile);

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

function findExecutable(name, opts = {}) {
  if (process.platform !== "win32") return name;
  
  const { execFileSync } = require("child_process");
  try {
    const pathOverride = Object.prototype.hasOwnProperty.call(opts, "pathOverride")
      ? opts.pathOverride
      : process.env.PATH;
    const env = { ...process.env, PATH: pathOverride || "" };
    const whereExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
    const result = execFileSync(fs.existsSync(whereExe) ? whereExe : "where.exe", [name], { encoding: "utf8", env });
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

  // Start real-time session log stream if configured. The token returned
  // by startStream is captured so the corresponding stopStream below only
  // tears down THIS stream — a stale exit event from a previous session
  // that reused this sessionId would no-op instead of killing a freshly
  // started stream after a "Restart" reconnect (issue #916).
  let logStreamToken = null;
  if (payload?.sessionLog?.enabled && payload?.sessionLog?.directory) {
    logStreamToken = sessionLogStreamManager.startStream(sessionId, {
      hostLabel: "Local",
      hostname: "localhost",
      directory: payload.sessionLog.directory,
      format: payload.sessionLog.format || "txt",
      startTime: Date.now(),
    });
  }

  const { bufferData: bufferLocalData, flush: flushLocal } = createPtyOutputBuffer((data) => {
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
    sessionLogStreamManager.stopStream(sessionId, logStreamToken);
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
const { createTelnetSessionApi } = require("./terminalBridge/telnetSession.cjs");
const telnetSessionApi = createTelnetSessionApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  net, randomUUID, StringDecoder, iconv, Buffer, console, setTimeout, clearTimeout,
  normalizeTerminalEncoding, createTelnetAutoLogin, telnetProtocol,
  createPtyOutputBuffer, sessionLogStreamManager, createZmodemSentry, ptyProcessTree,
  enableTcpNoDelay, trackSessionIdlePrompt, stripAnsi,
});
const { startTelnetSession } = telnetSessionApi;

/**
 * Resolve Netcatty's bundled bare `mosh-client` binary.
 *
 * Returns the absolute path or null.
 */
const { createMoshSessionApi } = require("./terminalBridge/moshSession.cjs");
const moshSessionApi = createMoshSessionApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  os, fs, net, path, pty, iconv, Buffer, StringDecoder, process, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  randomUUID, execFileAsync, ptyProcessTree, sessionLogStreamManager,
  stripAnsi, trackSessionIdlePrompt, createZmodemSentry, moshHandshake, tempDirBridge,
  createPtyOutputBuffer, enableTcpNoDelay, normalizeTerminalEncoding,
  resolvePosixExecutable, findExecutable, isExecutableFile,
  bundledMoshClient: (...args) => bundledMoshClient(...args),
});
const {
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
} = moshSessionApi;

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
    // Token for the log stream we open on this connection. Captured here so
    // the close/error handlers can pass it to stopStream and avoid
    // tearing down a freshly started stream after a "Restart" reconnect on
    // the same sessionId (issue #916).
    let logStreamToken = null;
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
          logStreamToken = sessionLogStreamManager.startStream(sessionId, {
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
          sessionLogStreamManager.stopStream(sessionId, logStreamToken);
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("netcatty:exit", { sessionId, exitCode: 1, error: err.message, reason: "error" });
          ptyProcessTree.unregisterPid(sessionId);
          sessions.delete(sessionId);
        });

        serialPort.on('close', () => {
          console.log(`[Serial] Port closed`);
          session.zmodemSentry?.cancel();
          sessionLogStreamManager.stopStream(sessionId, logStreamToken);
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
    if (session.type === 'telnet-native' && !payload.automated) {
      session.autoLogin?.handleUserInput();
    }

    if (session.stream) {
      session.stream.write(payload.data);
    } else if (session.proc) {
      session.proc.write(payload.data);
    } else if (session.socket) {
      // Telnet only: any 0xFF byte going out the wire must be doubled, or
      // the peer will treat it as the start of an IAC command sequence and
      // eat the next byte (RFC 854 §"Data Stream"). UTF-8 keyboard input
      // never produces 0xFF, but paste of binary content and some legacy
      // encodings do. Cheap no-op when there is no 0xFF.
      let outgoing = payload.data;
      if (session.type === 'telnet-native' && session.telnetProtocolActive) {
        if (typeof outgoing === 'string') {
          outgoing = Buffer.from(outgoing, 'utf8');
        }
        outgoing = telnetProtocol.escapeIacForWire(outgoing);
      }
      session.socket.write(outgoing);
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
 * Pause or resume a session's source stream for output back-pressure.
 * The renderer asks for this when its write backlog crosses a watermark, so a
 * flooding source can't outrun the terminal renderer. Works across session
 * kinds: ssh2 channel (stream), node-pty (proc), telnet socket, serial port —
 * all expose pause()/resume().
 */
function setSessionFlowPaused(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  const target = session.stream || session.proc || session.socket || session.serialPort;
  if (!target) return;
  try {
    if (payload.paused) {
      target.pause?.();
    } else {
      target.resume?.();
    }
  } catch (err) {
    if (err?.code !== 'EPIPE' && err?.code !== 'ERR_STREAM_DESTROYED') {
      console.warn("Flow control toggle failed", err);
    }
  }
}

/**
 * Resize a session terminal
 */
function resizeSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  if (Number.isFinite(payload.cols)) session.cols = payload.cols;
  if (Number.isFinite(payload.rows)) session.rows = payload.rows;
  
  try {
    if (session.stream) {
      session.stream.setWindow(payload.rows, payload.cols, 0, 0);
    } else if (session.proc) {
      session.proc.resize(payload.cols, payload.rows);
    } else if (session.socket && session.type === 'telnet-native') {
      session.cols = payload.cols;
      session.rows = payload.rows;
      // Only push a NAWS update once the peer has activated the protocol;
      // sending an IAC sequence to a raw-TCP server would corrupt its stream.
      if (session.telnetProtocolActive) {
        const colsByte = Buffer.from([
          (payload.cols >> 8) & 0xff, payload.cols & 0xff,
          (payload.rows >> 8) & 0xff, payload.rows & 0xff,
        ]);
        session.socket.write(Buffer.concat([
          Buffer.from([telnetProtocol.IAC, telnetProtocol.SB, telnetProtocol.OPT.NAWS]),
          telnetProtocol.escapeIacForWire(colsByte),
          Buffer.from([telnetProtocol.IAC, telnetProtocol.SE]),
        ]));
      }
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
  session.closed = true;
  
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
  } finally {
    cleanupMoshAuthTempFiles(session.moshAuthTempFiles);
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
  ipcMain.handle("netcatty:serial:start", startSerialSession);
  ipcMain.handle("netcatty:serial:list", listSerialPorts);
  ipcMain.handle("netcatty:local:defaultShell", getDefaultShell);
  ipcMain.handle("netcatty:local:validatePath", validatePath);
  ipcMain.handle("netcatty:shells:discover", () => discoverShells());
  ipcMain.handle("netcatty:terminal:setEncoding", setSessionEncoding);
  ipcMain.on("netcatty:write", writeToSession);
  ipcMain.on("netcatty:resize", resizeSession);
  ipcMain.on("netcatty:flow", setSessionFlowPaused);
  ipcMain.on("netcatty:close", closeSession);
}

/**
 * Get the default shell for the current platform
 */
const { createPathValidationApi } = require("./terminalBridge/pathValidation.cjs");
const pathValidationApi = createPathValidationApi({
  getDefaultLocalShell, expandHomePath, path, fs, process, console, findExecutable,
});
const { getDefaultShell, validatePath } = pathValidationApi;

/**
 * Locate the mosh-client binary bundled by electron-builder via
 * `extraResources` (see electron-builder.config.cjs and
 * .github/workflows/build-mosh-binaries.yml).
 *
 * Returns an absolute path when the binary is on disk, otherwise null.
 * In dev / non-packaged runs the path is computed against the project
 * root so the helper is testable without packaging the app.
 *
 * Note this returns the network-protocol `mosh-client`, not the `mosh`
 * wrapper script. Netcatty drives the SSH bootstrap itself and then
 * launches this bundled client directly.
 */
function bundledMoshClient(opts = {}) {
  const isWin = (opts.platform || process.platform) === "win32";
  const basename = isWin ? "mosh-client.exe" : "mosh-client";

  // Packaged: <Resources>/mosh/mosh-client[.exe]
  const resourcesPath = opts.resourcesPath || process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "mosh", basename);
    if (fs.existsSync(packaged) && isExecutableFile(packaged)) return packaged;
  }

  // Dev fallback: resources/mosh/<platform-arch>/mosh-client[.exe] under
  // the project root. Useful for `npm run start` after running
  // `npm run fetch:mosh` locally.
  const projectRoot = opts.projectRoot || path.resolve(__dirname, "..", "..");
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(path.join(projectRoot, "resources", "mosh", "darwin-universal", basename));
  } else {
    candidates.push(path.join(projectRoot, "resources", "mosh", `${platform}-${arch}`, basename));
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && isExecutableFile(c)) return c;
  }
  return null;
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
  bundledMoshClient,
  resolveBareMoshClient,
  addBundledMoshDllPath,
  addBundledMoshTerminfoEnv,
  addBundledMoshRuntimeEnv,
  startSerialSession,
  listSerialPorts,
  writeToSession,
  resizeSession,
  setSessionFlowPaused,
  closeSession,
  cleanupAllSessions,
  getDefaultShell,
  validatePath,
};
