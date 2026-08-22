"use strict";

/**
 * Netcatty-owned ssh-agent for FIDO2 sk-* keys.
 *
 * System agents started at login often lack SSH_ASKPASS, so PIN/touch prompts
 * never reach our GUI. Spawning a short-lived agent as our child with askpass
 * env makes sk-helper prompts work inside Netcatty.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const {
  buildFidoAskpassEnv,
  releaseFidoAskpassLease,
  shutdownFidoAskpass,
} = require("./fidoAskpass.cjs");

const execFileAsync = promisify(execFile);

/** @type {{ killed: boolean, pid: number, kill: (sig?: string) => void }|null} */
let agentChild = null;
/** @type {string|null} */
let agentSocket = null;
/** @type {string|null} */
let agentDir = null;
let refCount = 0;
/**
 * Monotonic id for the currently tracked agent. Cleared/restarted agents bump
 * this so stale release callbacks from earlier acquisitions cannot kill a newer
 * agent that reused the singleton slot.
 */
let agentGeneration = 0;
/** @type {Promise<{ socketPath: string, askpassEnv: Record<string, string>, owned: boolean, generation: number }>|null} */
let startingPromise = null;

function getTempBase() {
  const tempDirBridge = require("./tempDirBridge.cjs");
  if (typeof tempDirBridge.getTempDir !== "function") {
    throw new Error("FIDO agent requires Netcatty temp directory (tempDirBridge unavailable).");
  }
  return tempDirBridge.getTempDir();
}

const WIN_SYSTEM_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * User-mode ssh-agent binaries on Windows (not the Win32-OpenSSH service host).
 * These can run as our child with SSH_ASKPASS so verify-required sk-helper
 * prompts reach the Netcatty modal.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function listWindowsUserModeSshAgentCandidates(env = process.env) {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA || "";
  const userProfile = env.USERPROFILE || "";
  return [
    path.join(programFiles, "Git", "usr", "bin", "ssh-agent.exe"),
    path.join(programFilesX86, "Git", "usr", "bin", "ssh-agent.exe"),
    path.join(localAppData, "Programs", "Git", "usr", "bin", "ssh-agent.exe"),
    path.join(userProfile, "scoop", "apps", "git", "current", "usr", "bin", "ssh-agent.exe"),
  ];
}

/**
 * Pair ssh-add with a user-mode ssh-agent (same directory) when possible.
 * @param {string} sshAgentPath
 * @returns {string|null}
 */
function companionSshAddPath(sshAgentPath) {
  if (typeof sshAgentPath !== "string" || !sshAgentPath.trim()) return null;
  const dir = path.dirname(sshAgentPath);
  const base = path.basename(sshAgentPath).toLowerCase().replace(/\.exe$/i, "");
  if (base !== "ssh-agent") return null;
  const candidate = path.join(dir, path.basename(sshAgentPath).replace(/ssh-agent/i, "ssh-add"));
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return null;
}

function resolveSshAgentBinary(env = process.env, platform = process.platform) {
  if (typeof env.NETCATTY_SSH_AGENT_PATH === "string" && env.NETCATTY_SSH_AGENT_PATH.trim()) {
    return env.NETCATTY_SSH_AGENT_PATH.trim();
  }
  if (platform === "darwin") {
    for (const candidate of [
      "/opt/homebrew/bin/ssh-agent",
      "/usr/local/bin/ssh-agent",
      "/usr/bin/ssh-agent",
    ]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // continue
      }
    }
  }
  if (platform === "win32") {
    // Prefer Git/MSYS (or similar) user-mode agents over System32's service binary.
    for (const candidate of listWindowsUserModeSshAgentCandidates(env)) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // continue
      }
    }
  }
  return "ssh-agent";
}

function parseAgentStdout(stdout) {
  const sockMatch = /SSH_AUTH_SOCK=([^;\s]+)/.exec(stdout || "");
  const pidMatch = /SSH_AGENT_PID=(\d+)/.exec(stdout || "");
  return {
    socketPath: sockMatch?.[1] || null,
    agentPid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWindowsNamedPipe(socketPath) {
  return typeof socketPath === "string"
    && /^\\\\[.,]\\pipe\\/i.test(socketPath);
}

function isAgentLive() {
  if (!agentSocket) return false;
  // Named pipes are not reliable with existsSync; rely on PID / child state.
  if (!isWindowsNamedPipe(agentSocket)) {
    try {
      if (!fs.existsSync(agentSocket)) return false;
    } catch {
      return false;
    }
  }
  if (agentChild?.pid) return isProcessAlive(agentChild.pid);
  // Socket exists but no PID tracking — treat as live until connect fails.
  // System-pipe fallback sets agentChild=null; treat that as live while socket is set.
  if (!agentChild) return isWindowsNamedPipe(agentSocket);
  return !agentChild.killed;
}

function clearAgentState({ kill = true } = {}) {
  if (kill && agentChild) {
    const ownedPid = agentChild.pid;
    // Only kill OUR tracked pid. Never run `ssh-agent -k` with the ambient
    // process.env SSH_AGENT_PID — that can kill the user's login agent.
    try {
      if (ownedPid && isProcessAlive(ownedPid)) {
        process.kill(ownedPid, "TERM");
      }
    } catch {
      // ignore
    }
    if (ownedPid && agentSocket) {
      try {
        const sshAgent = resolveSshAgentBinary();
        // Isolate env: only our sock + pid, no inheritance of login agent vars.
        execFile(sshAgent, ["-k"], {
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            SSH_AUTH_SOCK: agentSocket,
            SSH_AGENT_PID: String(ownedPid),
          },
          windowsHide: true,
          timeout: 3000,
        }, () => {});
      } catch {
        // ignore
      }
    }
    try {
      agentChild.kill?.("TERM");
    } catch {
      // ignore
    }
  }
  agentChild = null;
  agentSocket = null;
  if (agentDir) {
    fs.promises.rm(agentDir, { recursive: true, force: true }).catch(() => {});
    agentDir = null;
  }
  refCount = 0;
  agentGeneration += 1;
}

/**
 * Env for the long-lived ssh-agent process. Must not include a caller-bound
 * NETCATTY_FIDO_ASKPASS_LEASE: ssh-sk-helper for later verify-required signing
 * is a descendant of the agent and would inherit that lease, routing a second
 * window's PIN/touch prompt to the starter forever. Callers still receive a
 * per-acquire lease via askpassEnv for ssh-add. Agent-spawned prompts route to
 * the last leased signing window in fidoAskpass (not the sticky last acquire).
 * @param {Record<string, string>|null|undefined} askpassEnv
 * @returns {Record<string, string>}
 */
function askpassEnvForAgentProcess(askpassEnv) {
  if (!askpassEnv || typeof askpassEnv !== "object") return {};
  const { NETCATTY_FIDO_ASKPASS_LEASE: _callerLease, ...agentAskpassEnv } = askpassEnv;
  return agentAskpassEnv;
}

/**
 * Acquire a Netcatty FIDO agent socket. Multiple callers share one agent.
 * Concurrent acquires are serialized via startingPromise.
 */
async function acquireFidoAgent(options = {}) {
  if (startingPromise) {
    const shared = await startingPromise;
    if (isAgentLive()) {
      refCount += 1;
      // Caller-specific askpass lease — never reuse the starter's resolver.
      return {
        socketPath: shared.socketPath,
        askpassEnv: buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents }),
        owned: shared.owned,
        generation: shared.generation,
        sshAddPath: shared.sshAddPath || null,
      };
    }
  }

  if (isAgentLive() && agentSocket) {
    refCount += 1;
    return {
      socketPath: agentSocket,
      askpassEnv: buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents }),
      // Preserve ownership of the live singleton (Windows system-pipe fallback is not owned).
      owned: Boolean(agentChild),
      generation: agentGeneration,
      sshAddPath: companionSshAddPath(resolveSshAgentBinary(options.env || process.env, options.platform || process.platform)),
    };
  }

  // Dead leftover state
  if (agentSocket || agentChild) clearAgentState({ kill: true });

  startingPromise = (async () => {
    const run = options.execFile || execFileAsync;
    const env = options.env || process.env;
    const askpassEnv = buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents });
    const platform = options.platform || process.platform;
    const releaseStarterAskpassLease = () => {
      try {
        releaseFidoAskpassLease(askpassEnv?.NETCATTY_FIDO_ASKPASS_LEASE);
      } catch {
        // ignore
      }
    };

    try {
      const sshAgent = resolveSshAgentBinary(env, platform);
      const sshAddPath = companionSshAddPath(sshAgent);

      agentDir = path.join(getTempBase(), `netcatty-fido-agent-${randomUUID().slice(0, 8)}`);
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

      // Keep SSH_ASKPASS on the agent so verify-required sk-helper prompts work,
      // but never bake the starter's caller lease into the shared process env.
      const agentProcessEnv = { ...env, ...askpassEnvForAgentProcess(askpassEnv) };

      // Windows: try a Netcatty-owned named pipe first (ssh2 speaks it natively),
      // then a filesystem socket for MSYS/Git user-mode agents.
      const sockCandidates = platform === "win32"
        ? [
          `\\\\.\\pipe\\netcatty-fido-agent-${randomUUID().slice(0, 8)}`,
          path.join(agentDir, "agent.sock"),
        ]
        : [path.join(agentDir, "agent.sock")];

      let stdout = "";
      let boundSockPath = sockCandidates[0];
      let started = false;
      /** @type {Error|null} */
      let lastStartError = null;

      for (const sockPath of sockCandidates) {
        boundSockPath = sockPath;
        try {
          const result = await run(sshAgent, ["-a", sockPath, "-s"], {
            timeout: 10000,
            windowsHide: true,
            env: agentProcessEnv,
          });
          stdout = result.stdout?.toString?.() || result.stdout || "";
          started = true;
          break;
        } catch (error) {
          lastStartError = error instanceof Error ? error : new Error(String(error));
        }
      }

      if (!started) {
        try {
          const result = await run(sshAgent, ["-s"], {
            timeout: 10000,
            windowsHide: true,
            env: agentProcessEnv,
          });
          stdout = result.stdout?.toString?.() || result.stdout || "";
          started = true;
        } catch (fallbackError) {
          lastStartError = fallbackError instanceof Error
            ? fallbackError
            : new Error(String(fallbackError));
        }
      }

      if (started) {
        const parsed = parseAgentStdout(stdout);
        const fallbackSock = isWindowsNamedPipe(boundSockPath)
          ? boundSockPath
          : (fs.existsSync(boundSockPath) ? boundSockPath : null);
        agentSocket = parsed.socketPath || fallbackSock;
        if (!agentSocket) {
          clearAgentState({ kill: true });
          const err = new Error("ssh-agent started but SSH_AUTH_SOCK was not reported.");
          err.code = "ERR_FIDO_AGENT_SOCK";
          throw err;
        }

        // In-box Win32-OpenSSH `ssh-agent -s` often just advertises the system
        // service pipe — that is not a Netcatty child and must not be killed.
        const isSystemServicePipe = typeof agentSocket === "string"
          && /openssh-ssh-agent$/i.test(agentSocket.replace(/\//g, "\\"));
        if (isSystemServicePipe) {
          agentChild = null;
          agentDir = null;
          refCount = 1;
          return {
            socketPath: agentSocket,
            askpassEnv,
            owned: false,
            generation: agentGeneration,
            sshAddPath: null,
          };
        }

        if (parsed.agentPid && Number.isFinite(parsed.agentPid) && parsed.agentPid > 0) {
          const pid = parsed.agentPid;
          agentChild = {
            killed: false,
            pid,
            kill(sig = "TERM") {
              try { process.kill(pid, sig); } catch { /* ignore */ }
              this.killed = true;
            },
          };
        } else {
          // No PID — still usable via socket; kill via ssh-agent -k on release.
          agentChild = {
            killed: false,
            pid: 0,
            kill() { this.killed = true; },
          };
        }

        refCount = 1;
        return {
          socketPath: agentSocket,
          askpassEnv,
          owned: true,
          generation: agentGeneration,
          sshAddPath,
        };
      }

      // Win32-OpenSSH's in-box ssh-agent is a service bound to a fixed named
      // pipe and usually rejects `ssh-agent -a`. Fall back to that pipe so
      // non-verify-required keys still work, but mark owned:false so callers
      // remove any identities they ssh-add (see prepareSystemSshAgentForAuth).
      // verify-required signing still needs a prompt-capable child agent above.
      if (platform === "win32") {
        clearAgentState({ kill: false });
        agentSocket = WIN_SYSTEM_AGENT_PIPE;
        agentChild = null;
        agentDir = null;
        refCount = 1;
        return {
          socketPath: WIN_SYSTEM_AGENT_PIPE,
          askpassEnv,
          owned: false,
          generation: agentGeneration,
          sshAddPath: null,
        };
      }

      clearAgentState({ kill: false });
      const message = lastStartError instanceof Error ? lastStartError.message : String(lastStartError || "unknown");
      const err = new Error(
        `Could not start a FIDO-capable ssh-agent (${message}). Install OpenSSH with libfido2 (macOS: brew install openssh libfido2).`,
      );
      err.code = "ERR_FIDO_AGENT_START";
      throw err;
    } catch (error) {
      // Starter allocated a caller-specific askpass lease before launch; drop it
      // whenever startup fails so WebContents resolvers are not retained.
      releaseStarterAskpassLease();
      throw error;
    }
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

/**
 * Release one acquisition. Pass the `generation` returned by acquireFidoAgent so
 * a late close after the agent was replaced cannot decrement/kill the newer agent.
 */
function releaseFidoAgent(generation) {
  if (generation !== agentGeneration) return;
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  clearAgentState({ kill: true });
}

function getActiveFidoAgentSocket() {
  return isAgentLive() ? agentSocket : null;
}

function shutdownFidoAgentSubsystem() {
  clearAgentState({ kill: true });
  try {
    shutdownFidoAskpass();
  } catch {
    // ignore
  }
}

let quitHookInstalled = false;
function installFidoAgentQuitHook() {
  if (quitHookInstalled) return;
  quitHookInstalled = true;
  const shutdown = () => {
    try { shutdownFidoAgentSubsystem(); } catch { /* ignore */ }
  };
  // Terminal/auth often runs in a utilityProcess where `app` is unavailable.
  // Use only the `exit` hook so we do not swallow SIGTERM/SIGINT default exit
  // behavior (installing those handlers without process.exit leaves workers hung).
  process.once("exit", shutdown);
  try {
    const { app } = require("electron");
    app.once("before-quit", shutdown);
    app.once("will-quit", shutdown);
  } catch {
    // non-electron / utility process
  }
}

// Best-effort install when module loads in Electron main or worker.
try { installFidoAgentQuitHook(); } catch { /* ignore */ }

module.exports = {
  acquireFidoAgent,
  releaseFidoAgent,
  getActiveFidoAgentSocket,
  resolveSshAgentBinary,
  parseAgentStdout,
  shutdownFidoAgentSubsystem,
  installFidoAgentQuitHook,
  isAgentLive,
  askpassEnvForAgentProcess,
  listWindowsUserModeSshAgentCandidates,
  companionSshAddPath,
  WIN_SYSTEM_AGENT_PIPE,
  // exposed for tests
  getTempBase,
};
