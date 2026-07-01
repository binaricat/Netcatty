"use strict";

const { createExecOnSessionApi } = require("./systemManager/execOnSession.cjs");
const { createTmuxOpsApi } = require("./systemManager/tmuxOps.cjs");
const { createDockerOpsApi } = require("./systemManager/dockerOps.cjs");

const CAPABILITY_SCRIPT_POSIX = [
  "exec sh -c ",
  "'",
  'printf "%s\\n" "__NC_OS__=$(uname -s)"; ',
  'command -v tmux >/dev/null 2>&1 && printf "%s\\n" __NC_TMUX__=1; ',
  'command -v docker >/dev/null 2>&1 && printf "%s\\n" __NC_DOCKER__=1',
  "'",
].join("");

const PROCESS_LIST_SCRIPT_POSIX = [
  "exec sh -c ",
  "'",
  // Safety cap: head -n 2000 prevents maxBuffer/timeout on process-dense hosts.
  // This is NOT a functional limit — monitored processes still show accurate metrics.
  "ps -eo pid= -o ppid= -o user= -o stat= -o pcpu= -o pmem= -o rss= -o vsz= -o etime= -o args= 2>/dev/null | head -n 2000",
  "'",
].join("");

function parseCapabilities(stdout, isLocal, localPlatform) {
  const text = stdout || "";
  let targetOs = "unknown";
  if (isLocal) {
    if (localPlatform === "linux") targetOs = "linux";
    else if (localPlatform === "darwin") targetOs = "darwin";
    else if (localPlatform === "win32") targetOs = "win32";
  } else {
    const osMatch = text.match(/__NC_OS__=([^\r\n]+)/);
    const uname = (osMatch?.[1] || "").trim().toLowerCase();
    if (uname.includes("linux")) targetOs = "linux";
    else if (uname.includes("darwin")) targetOs = "darwin";
    else if (uname.includes("windows") || uname.includes("mingw")) targetOs = "win32";
  }
  const hasTmux = text.includes("__NC_TMUX__=1");
  const hasDocker = text.includes("__NC_DOCKER__=1");
  return { targetOs, hasTmux, hasDocker, probedAt: Date.now() };
}

function parseProcessLines(stdout) {
  const processes = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    processes.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      stat: m[4],
      cpuPercent: Number(m[5]),
      memPercent: Number(m[6]),
      rssKb: Number(m[7]),
      vszKb: Number(m[8]),
      elapsed: m[9],
      command: m[10],
    });
  }
  return processes;
}

const ALLOWED_SIGNALS = new Set([
  "TERM", "KILL", "STOP", "CONT", "HUP", "INT", "USR1", "USR2",
  "1", "2", "9", "15", "18", "19",
]);

function buildProcessSignalCommand(pid, signal, nice) {
  if (nice !== undefined && nice !== null) {
    const n = Number(nice);
    if (!Number.isFinite(n) || n < -20 || n > 19) {
      return { error: "Invalid nice value" };
    }
    return { command: `renice ${Math.trunc(n)} -p ${Number(pid)}` };
  }
  const sig = String(signal || "TERM").toUpperCase();
  if (!ALLOWED_SIGNALS.has(sig)) {
    return { error: "Invalid signal" };
  }
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return { error: "Invalid pid" };
  }
  if (sig === "KILL" || sig === "9") {
    return { command: `kill -9 ${numericPid}` };
  }
  if (sig === "TERM" || sig === "15") {
    return { command: `kill -15 ${numericPid}` };
  }
  if (/^\d+$/.test(sig)) {
    return { command: `kill -${sig} ${numericPid}` };
  }
  return { command: `kill -s ${sig} ${numericPid}` };
}

function createSystemManagerBridge(deps) {
  const {
    getSessions,
    execOnEtSession,
    ensureMoshStatsConnection,
    process,
  } = deps;

  const execApi = createExecOnSessionApi({
    sessions: { get: (id) => getSessions()?.get(id) },
    execOnEtSession,
    ensureMoshStatsConnection,
  });

  const { execOnSession, execOnLocalMachine, isLocalSession, getSession } = execApi;

  const tmuxOps = createTmuxOpsApi({ execOnSession });
  const dockerOps = createDockerOpsApi({ execOnSession, getSession });

  async function probeCapabilities(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };

    if (isLocalSession(sessionId)) {
      const platform = process.platform;
      let script = CAPABILITY_SCRIPT_POSIX;
      if (platform === "win32") {
        const result = await execOnLocalMachine(
          "$os=[System.Environment]::OSVersion.Platform; Write-Output \"__NC_OS__=Windows\"; if (Get-Command tmux -ErrorAction SilentlyContinue) { Write-Output '__NC_TMUX__=1' }; docker info 2>$null; if ($LASTEXITCODE -eq 0) { Write-Output '__NC_DOCKER__=1' }",
          8000,
        );
        if (!result.success) return { success: false, error: result.error || "Probe failed" };
        return { success: true, capabilities: parseCapabilities(result.stdout, true, platform) };
      }
      const result = await execOnLocalMachine(
        script.replace(/^exec sh -c '/, "").replace(/'$/, ""),
        8000,
      );
      if (!result.success) {
        const fallback = await execOnLocalMachine("uname -s; command -v tmux; command -v docker >/dev/null 2>&1 && echo docker_ok", 8000);
        if (!fallback.success) return { success: false, error: fallback.error || "Probe failed" };
        const text = fallback.stdout || "";
        return {
          success: true,
          capabilities: {
            targetOs: platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : "unknown",
            hasTmux: text.includes("tmux") && !text.includes("not found"),
            hasDocker: text.includes("docker_ok"),
            probedAt: Date.now(),
          },
        };
      }
      return { success: true, capabilities: parseCapabilities(result.stdout, true, platform) };
    }

    const result = await execOnSession(event, sessionId, CAPABILITY_SCRIPT_POSIX, 8000);
    if (result.pending) return { success: false, pending: true };
    if (!result.success) return { success: false, error: result.error || "Probe failed" };
    return {
      success: true,
      capabilities: parseCapabilities(result.stdout, false, process.platform),
    };
  }

  async function listProcesses(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };

    if (isLocalSession(sessionId) && process.platform === "win32") {
      // Safety cap: -First 2000 prevents maxBuffer/timeout on process-dense hosts.
      // This is NOT a functional limit — monitored processes still show accurate metrics.
      const result = await execOnLocalMachine(
        "Get-CimInstance Win32_Process | Sort-Object KernelModeTime -Descending | Select-Object -First 2000 ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress",
        10000,
      );
      if (!result.success) return { success: false, error: result.error };
      try {
        const raw = JSON.parse(result.stdout || "[]");
        const list = Array.isArray(raw) ? raw : [raw];
        const processes = list.map((p) => ({
          pid: Number(p.ProcessId),
          ppid: Number(p.ParentProcessId) || 0,
          user: "",
          stat: "R",
          cpuPercent: 0,
          memPercent: 0,
          rssKb: Math.round((Number(p.WorkingSetSize) || 0) / 1024),
          vszKb: 0,
          elapsed: "",
          command: String(p.Name || ""),
        }));
        return { success: true, processes };
      } catch {
        return { success: false, error: "Failed to parse process list" };
      }
    }

    const result = await execOnSession(event, sessionId, PROCESS_LIST_SCRIPT_POSIX, 12000);
    if (result.pending) return { success: false, pending: true };
    if (!result.success) return { success: false, error: result.error || "Failed to list processes" };
    return { success: true, processes: parseProcessLines(result.stdout) };
  }

  async function signalProcess(event, payload) {
    const { sessionId, pid, signal = "TERM", nice } = payload || {};
    if (!sessionId || !pid) return { success: false, error: "Missing sessionId or pid" };
    const built = buildProcessSignalCommand(pid, signal, nice);
    if (built.error) return { success: false, error: built.error };
    const result = await execOnSession(event, sessionId, `exec sh -c ${JSON.stringify(built.command)}`, 5000);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, code: result.code };
  }

  async function setupOsc7Tracking(event, payload) {
    const sessionId = payload?.sessionId;
    const command = payload?.command;
    if (!sessionId || typeof command !== "string" || !command.trim()) {
      return { success: false, error: "Missing sessionId or command" };
    }

    const result = await execOnSession(event, sessionId, command, 10000);
    if (result.pending) return { success: false, pending: true, error: result.error };
    if (!result.success) return { success: false, error: result.error || "Directory tracking setup failed" };
    if (typeof result.code === "number" && result.code !== 0) {
      const error = String(result.stderr || result.error || `Directory tracking setup failed with exit code ${result.code}`).trim();
      return {
        success: false,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        code: result.code,
        error,
      };
    }
    return {
      success: true,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      code: result.code ?? 0,
    };
  }

  async function listTmuxSessions(event, payload) {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return tmuxOps.listSessions(event, sessionId);
  }

  async function createTmuxSession(event, payload) {
    return tmuxOps.createSession(event, payload);
  }

  async function listTmuxWindows(event, payload) {
    return tmuxOps.listWindows(event, payload);
  }

  async function listTmuxPanes(event, payload) {
    return tmuxOps.listPanes(event, payload);
  }

  async function listTmuxClients(event, payload) {
    return tmuxOps.listClients(event, payload);
  }

  async function tmuxAction(event, payload) {
    const result = await tmuxOps.tmuxAction(event, payload);
    if (result.success === false && result.error) {
      return { success: false, error: result.error || result.stderr };
    }
    if (result.success === false) {
      return { success: false, error: result.stderr || "tmux command failed" };
    }
    return { success: true };
  }

  async function listDockerContainers(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return dockerOps.listContainers(event, sessionId);
  }

  async function listDockerImages(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return dockerOps.listImages(event, sessionId);
  }

  async function dockerStats(event, payload) {
    return dockerOps.getStats(event, payload);
  }

  async function dockerInspect(event, payload) {
    return dockerOps.inspectContainer(event, payload);
  }

  async function dockerImageInspect(event, payload) {
    return dockerOps.inspectImage(event, payload);
  }

  async function dockerAction(event, payload) {
    const result = await dockerOps.containerAction(event, payload);
    if (result.success === false) {
      return { success: false, error: result.error || result.stderr || "docker command failed" };
    }
    return { success: true };
  }

  async function dockerImageAction(event, payload) {
    const result = await dockerOps.imageAction(event, payload);
    if (result.success === false) {
      return { success: false, error: result.error || result.stderr || "docker command failed" };
    }
    return { success: true, output: result.stdout };
  }

  function registerWorkerHandle(ipcMain, terminalWorkerManager, channel) {
    ipcMain.handle(channel, (event, payload) => terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    }));
  }

  function registerHandlers(ipcMain, options = {}) {
    const terminalWorkerManager = options.terminalWorkerManager || null;
    if (terminalWorkerManager) {
      [
        "netcatty:system:probeCapabilities",
        "netcatty:system:listProcesses",
        "netcatty:system:signalProcess",
        "netcatty:system:setupOsc7Tracking",
        "netcatty:system:listTmuxSessions",
        "netcatty:system:createTmuxSession",
        "netcatty:system:listTmuxWindows",
        "netcatty:system:listTmuxPanes",
        "netcatty:system:listTmuxClients",
        "netcatty:system:tmuxAction",
        "netcatty:system:listDockerContainers",
        "netcatty:system:listDockerImages",
        "netcatty:system:dockerStats",
        "netcatty:system:dockerInspect",
        "netcatty:system:dockerImageInspect",
        "netcatty:system:dockerAction",
        "netcatty:system:dockerImageAction",
      ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel));
      return;
    }
    ipcMain.handle("netcatty:system:probeCapabilities", probeCapabilities);
    ipcMain.handle("netcatty:system:listProcesses", listProcesses);
    ipcMain.handle("netcatty:system:signalProcess", signalProcess);
    ipcMain.handle("netcatty:system:setupOsc7Tracking", setupOsc7Tracking);
    ipcMain.handle("netcatty:system:listTmuxSessions", listTmuxSessions);
    ipcMain.handle("netcatty:system:createTmuxSession", createTmuxSession);
    ipcMain.handle("netcatty:system:listTmuxWindows", listTmuxWindows);
    ipcMain.handle("netcatty:system:listTmuxPanes", listTmuxPanes);
    ipcMain.handle("netcatty:system:listTmuxClients", listTmuxClients);
    ipcMain.handle("netcatty:system:tmuxAction", tmuxAction);
    ipcMain.handle("netcatty:system:listDockerContainers", listDockerContainers);
    ipcMain.handle("netcatty:system:listDockerImages", listDockerImages);
    ipcMain.handle("netcatty:system:dockerStats", dockerStats);
    ipcMain.handle("netcatty:system:dockerInspect", dockerInspect);
    ipcMain.handle("netcatty:system:dockerImageInspect", dockerImageInspect);
    ipcMain.handle("netcatty:system:dockerAction", dockerAction);
    ipcMain.handle("netcatty:system:dockerImageAction", dockerImageAction);
  }

  return { registerHandlers, probeCapabilities, listProcesses, setupOsc7Tracking };
}

module.exports = { createSystemManagerBridge };
