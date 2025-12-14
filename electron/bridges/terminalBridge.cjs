/**
 * Terminal Bridge - Handles local shell and telnet/mosh sessions
 * Extracted from main.cjs for single responsibility
 */

const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const pty = require("node-pty");

// Shared references
let sessions = null;
let electronModule = null;

/**
 * Initialize the terminal bridge with dependencies
 */
function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule;
}

/**
 * Find executable path on Windows
 */
function findExecutable(name) {
  if (process.platform !== "win32") return name;
  
  const { execFileSync } = require("child_process");
  try {
    const result = execFileSync("where.exe", [name], { encoding: "utf8" });
    const firstLine = result.split(/\r?\n/)[0].trim();
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch (err) {
    console.warn(`Could not find ${name} via where.exe:`, err.message);
  }
  
  // Fallback to common locations
  const path = require("node:path");
  const commonPaths = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSH", `${name}.exe`),
  ];
  
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  
  return name;
}

/**
 * Start a local terminal session
 */
function startLocalSession(event, payload) {
  const sessionId =
    payload?.sessionId ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const defaultShell = process.platform === "win32" 
    ? findExecutable("powershell") || "powershell.exe"
    : process.env.SHELL || "/bin/bash";
  const shell = payload?.shell || defaultShell;
  const env = {
    ...process.env,
    ...(payload?.env || {}),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  
  const proc = pty.spawn(shell, [], {
    cols: payload?.cols || 80,
    rows: payload?.rows || 24,
    env,
  });
  
  const session = {
    proc,
    webContentsId: event.sender.id,
  };
  sessions.set(sessionId, session);
  
  proc.onData((data) => {
    const contents = electronModule.webContents.fromId(session.webContentsId);
    contents?.send("netcatty:data", { sessionId, data });
  });
  
  proc.onExit((evt) => {
    sessions.delete(sessionId);
    const contents = electronModule.webContents.fromId(session.webContentsId);
    contents?.send("netcatty:exit", { sessionId, ...evt });
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
      };
      sessions.set(sessionId, session);

      resolve({ sessionId });
    });

    socket.on('data', (data) => {
      const session = sessions.get(sessionId);
      if (!session) return;

      const cleanData = handleTelnetNegotiation(data);
      
      if (cleanData.length > 0) {
        const contents = electronModule.webContents.fromId(session.webContentsId);
        contents?.send("netcatty:data", { sessionId, data: cleanData.toString('binary') });
      }
    });

    socket.on('error', (err) => {
      console.error(`[Telnet] Socket error: ${err.message}`);
      clearTimeout(connectTimeout);
      
      if (!connected) {
        reject(new Error(`Failed to connect: ${err.message}`));
      } else {
        const session = sessions.get(sessionId);
        if (session) {
          const contents = electronModule.webContents.fromId(session.webContentsId);
          contents?.send("netcatty:exit", { sessionId, exitCode: 1, error: err.message });
        }
        sessions.delete(sessionId);
      }
    });

    socket.on('close', (hadError) => {
      console.log(`[Telnet] Connection closed${hadError ? ' with error' : ''}`);
      clearTimeout(connectTimeout);
      
      const session = sessions.get(sessionId);
      if (session) {
        const contents = electronModule.webContents.fromId(session.webContentsId);
        contents?.send("netcatty:exit", { sessionId, exitCode: hadError ? 1 : 0 });
      }
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
    });

    const session = {
      proc,
      type: 'mosh',
      webContentsId: event.sender.id,
    };
    sessions.set(sessionId, session);

    proc.onData((data) => {
      const contents = electronModule.webContents.fromId(session.webContentsId);
      contents?.send("netcatty:data", { sessionId, data });
    });

    proc.onExit((evt) => {
      sessions.delete(sessionId);
      const contents = electronModule.webContents.fromId(session.webContentsId);
      contents?.send("netcatty:exit", { sessionId, ...evt });
    });

    return { sessionId };
  } catch (err) {
    console.error("[Mosh] Failed to start mosh session:", err.message);
    throw err;
  }
}

/**
 * Write data to a session
 */
function writeToSession(event, payload) {
  const session = sessions.get(payload.sessionId);
  if (!session) return;
  
  try {
    if (session.stream) {
      session.stream.write(payload.data);
    } else if (session.proc) {
      session.proc.write(payload.data);
    } else if (session.socket) {
      session.socket.write(payload.data);
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
    if (session.stream) {
      session.stream.close();
      session.conn?.end();
    } else if (session.proc) {
      session.proc.kill();
    } else if (session.socket) {
      session.socket.destroy();
    }
    if (session.chainConnections) {
      for (const c of session.chainConnections) {
        try { c.end(); } catch {}
      }
    }
  } catch (err) {
    console.warn("Close failed", err);
  }
  sessions.delete(payload.sessionId);
}

/**
 * Register IPC handlers for terminal operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:local:start", startLocalSession);
  ipcMain.handle("netcatty:telnet:start", startTelnetSession);
  ipcMain.handle("netcatty:mosh:start", startMoshSession);
  ipcMain.on("netcatty:write", writeToSession);
  ipcMain.on("netcatty:resize", resizeSession);
  ipcMain.on("netcatty:close", closeSession);
}

/**
 * Cleanup all sessions - call before app quit
 */
function cleanupAllSessions() {
  console.log(`[Terminal] Cleaning up ${sessions.size} sessions before quit`);
  for (const [sessionId, session] of sessions) {
    try {
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
  sessions.clear();
}

module.exports = {
  init,
  registerHandlers,
  findExecutable,
  startLocalSession,
  startTelnetSession,
  startMoshSession,
  writeToSession,
  resizeSession,
  closeSession,
  cleanupAllSessions,
};
