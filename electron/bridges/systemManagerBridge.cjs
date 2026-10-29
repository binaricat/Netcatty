"use strict";

const { createExecOnSessionApi } = require("./systemManager/execOnSession.cjs");
const { createTmuxOpsApi } = require("./systemManager/tmuxOps.cjs");
const { createZellijOpsApi } = require("./systemManager/zellijOps.cjs");
const { MUX_LIST_USERS_SCRIPT, parseListUsersOutput } = require("./systemManager/muxScope.cjs");
const { createDockerOpsApi } = require("./systemManager/dockerOps.cjs");
const { createKubectlOpsApi } = require("./systemManager/kubectlOps.cjs");
const { parseRuntimeProbe } = require("../../domain/systemManager/containerRuntime.shared.cjs");
const { createGpuOpsApi } = require("./systemManager/gpuOps.cjs");
const { createPortOpsApi } = require("./systemManager/portOps.cjs");
const { createServiceOpsApi } = require("./systemManager/serviceOps.cjs");

function nerdctlUsableClause(markCommand) {
  // Offer nerdctl only when `nerdctl info` works. A socket permission error
  // still counts: later commands can fall back to sudo. A dead containerd
  // (rootless not running, connection refused) does not.
  return [
    "if command -v nerdctl >/dev/null 2>&1; then ",
    "_nc_nerdctl_err=$( { if command -v timeout >/dev/null 2>&1; then timeout 3 nerdctl info; else nerdctl info; fi; } 2>&1 >/dev/null ); ",
    "_nc_nerdctl_code=$?; ",
    'if [ "$_nc_nerdctl_code" -eq 0 ] || printf "%s\\n" "$_nc_nerdctl_err" | grep -i "permission denied" >/dev/null 2>&1; then ',
    markCommand,
    "; fi; fi; ",
  ].join("");
}

const CAPABILITY_SCRIPT_POSIX = [
  "exec sh -c ",
  "'",
  'printf "%s\\n" "__NC_OS__=$(uname -s)"; ',
  'command -v tmux >/dev/null 2>&1 && printf "%s\\n" __NC_TMUX__=1; ',
  'command -v zellij >/dev/null 2>&1 && printf "%s\\n" __NC_ZELLIJ__=1; ',
  'command -v docker >/dev/null 2>&1 && printf "%s\\n" __NC_DOCKER__=1; ',
  'command -v podman >/dev/null 2>&1 && printf "%s\\n" __NC_PODMAN__=1; ',
  nerdctlUsableClause('printf "%s\\n" __NC_NERDCTL__=1'),
  'command -v kubectl >/dev/null 2>&1 && printf "%s\\n" __NC_KUBECTL__=1; ',
  'command -v nvidia-smi >/dev/null 2>&1 && printf "%s\\n" __NC_NVIDIA_SMI__=1; ',
  'command -v npu-smi >/dev/null 2>&1 && printf "%s\\n" __NC_NPU_SMI__=1; ',
  'command -v ss >/dev/null 2>&1 && printf "%s\\n" __NC_SS__=1; ',
  'command -v netstat >/dev/null 2>&1 && printf "%s\\n" __NC_NETSTAT__=1; ',
  'command -v lsof >/dev/null 2>&1 && printf "%s\\n" __NC_LSOF__=1; ',
  'command -v systemctl >/dev/null 2>&1 && printf "%s\\n" __NC_SYSTEMCTL__=1',
  "'",
].join("");

const PROCESS_LIST_SCRIPT_POSIX = [
  "exec sh -c ",
  "'",
  "ps -eo pid= -o ppid= -o user= -o stat= -o pcpu= -o pmem= -o rss= -o vsz= -o etime= -o args= 2>/dev/null || top -b -n 1 2>/dev/null || ps ww 2>/dev/null || ps 2>/dev/null",
  "'",
].join("");
const PROCESS_LIST_MAX_BUFFER = 64 * 1024 * 1024;

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
  // Line-anchored markers only — avoid matching probe-script source echoed by
  // noisy shells / vendor CLIs that reprint the command text.
  const hasFlag = (name) => new RegExp(`(?:^|\\r?\\n)${name}=1(?:\\r?\\n|$)`).test(text);
  const hasTmux = hasFlag("__NC_TMUX__");
  const hasZellij = hasFlag("__NC_ZELLIJ__");
  const runtimeProbe = parseRuntimeProbe(text);
  const hasDocker = runtimeProbe.docker;
  const hasPodman = runtimeProbe.podman;
  const hasNerdctl = runtimeProbe.nerdctl;
  const hasKubectl = runtimeProbe.kubernetes;
  const hasNvidiaSmi = hasFlag("__NC_NVIDIA_SMI__");
  const hasNpuSmi = hasFlag("__NC_NPU_SMI__");
  const hasSs = hasFlag("__NC_SS__");
  const hasNetstat = hasFlag("__NC_NETSTAT__");
  const hasLsof = hasFlag("__NC_LSOF__");
  const hasSystemctl = hasFlag("__NC_SYSTEMCTL__");
  return {
    targetOs,
    hasTmux,
    hasZellij,
    hasDocker,
    hasPodman,
    hasNerdctl,
    hasKubectl,
    hasNvidiaSmi,
    hasNpuSmi,
    hasSs,
    hasNetstat,
    hasLsof,
    hasSystemctl,
    probedAt: Date.now(),
  };
}

function parseProcessLines(stdout) {
  const processes = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (m) {
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
      continue;
    }

    const busyBoxTopMatch = trimmed.match(
      /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?[mgtpezy]?)\s+([\d.]+)%?\s+(?:\d+\s+)?([\d.]+)%?\s+(.+)$/i,
    );
    if (busyBoxTopMatch) {
      const suffix = busyBoxTopMatch[5].slice(-1).toLowerCase();
      const multipliers = { m: 1024, g: 1024 ** 2, t: 1024 ** 3, p: 1024 ** 4, e: 1024 ** 5, z: 1024 ** 6, y: 1024 ** 7 };
      const multiplier = multipliers[suffix] || 1;
      processes.push({
        pid: Number(busyBoxTopMatch[1]),
        ppid: Number(busyBoxTopMatch[2]),
        user: busyBoxTopMatch[3],
        stat: busyBoxTopMatch[4],
        cpuPercent: Number(busyBoxTopMatch[7]),
        memPercent: Number(busyBoxTopMatch[6]),
        rssKb: 0,
        vszKb: Math.round(Number.parseFloat(busyBoxTopMatch[5]) * multiplier),
        elapsed: "",
        command: busyBoxTopMatch[8],
      });
      continue;
    }

    const busyBoxMatch = trimmed.match(/^(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?[mgtpezy]?)\s+(\S+)\s+(.+)$/i);
    if (!busyBoxMatch) continue;
    const suffix = busyBoxMatch[3].slice(-1).toLowerCase();
    const multipliers = { m: 1024, g: 1024 ** 2, t: 1024 ** 3, p: 1024 ** 4, e: 1024 ** 5, z: 1024 ** 6, y: 1024 ** 7 };
    const multiplier = multipliers[suffix] || 1;
    processes.push({
      pid: Number(busyBoxMatch[1]),
      ppid: 0,
      user: busyBoxMatch[2],
      stat: busyBoxMatch[4],
      cpuPercent: 0,
      memPercent: 0,
      rssKb: 0,
      vszKb: Math.round(Number.parseFloat(busyBoxMatch[3]) * multiplier),
      elapsed: "",
      command: busyBoxMatch[5],
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
  const zellijOps = createZellijOpsApi({ execOnSession });
  const dockerOps = createDockerOpsApi({ execOnSession, getSession });
  const kubectlOps = createKubectlOpsApi({ execOnSession, isLocalSession, process });
  const gpuOps = createGpuOpsApi({
    execOnSession,
    execOnLocalMachine,
    isLocalSession,
    process,
  });
  const portOps = createPortOpsApi({
    execOnSession,
    execOnLocalMachine,
    isLocalSession,
    process,
  });
  const serviceOps = createServiceOpsApi({ execOnSession, getSession });

  async function probeCapabilities(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };

    if (isLocalSession(sessionId)) {
      const platform = process.platform;
      let script = CAPABILITY_SCRIPT_POSIX;
      if (platform === "win32") {
        const result = await execOnLocalMachine(
          [
            'Write-Output "__NC_OS__=Windows"; ',
            "if (Get-Command tmux -ErrorAction SilentlyContinue) { Write-Output '__NC_TMUX__=1' }; ",
            "if (Get-Command zellij -ErrorAction SilentlyContinue) { Write-Output '__NC_ZELLIJ__=1' }; ",
            "docker info 2>$null; if ($LASTEXITCODE -eq 0) { Write-Output '__NC_DOCKER__=1' }; ",
            "if (Get-Command podman -ErrorAction SilentlyContinue) { Write-Output '__NC_PODMAN__=1' }; ",
            "if (Get-Command nerdctl -ErrorAction SilentlyContinue) { nerdctl info 2>$null; if ($LASTEXITCODE -eq 0) { Write-Output '__NC_NERDCTL__=1' } }; ",
            "if (Get-Command kubectl -ErrorAction SilentlyContinue) { Write-Output '__NC_KUBECTL__=1' }; ",
            "if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { Write-Output '__NC_NVIDIA_SMI__=1' }; ",
            "if (Get-Command npu-smi -ErrorAction SilentlyContinue) { Write-Output '__NC_NPU_SMI__=1' }; ",
            // Local Windows uses Get-NetTCPConnection; treat as netstat-capable for tab visibility.
            "Write-Output '__NC_NETSTAT__=1'; ",
            "if (Get-Command ss -ErrorAction SilentlyContinue) { Write-Output '__NC_SS__=1' }; ",
            "if (Get-Command lsof -ErrorAction SilentlyContinue) { Write-Output '__NC_LSOF__=1' }; ",
            "if (Get-Command systemctl -ErrorAction SilentlyContinue) { Write-Output '__NC_SYSTEMCTL__=1' }",
          ].join(""),
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
        const fallback = await execOnLocalMachine(
          [
            "uname -s; ",
            "command -v tmux; ",
            "command -v zellij >/dev/null 2>&1 && echo zellij_ok; ",
            "command -v docker >/dev/null 2>&1 && echo docker_ok; ",
            "command -v podman >/dev/null 2>&1 && echo podman_ok; ",
            nerdctlUsableClause("echo nerdctl_ok"),
            "command -v kubectl >/dev/null 2>&1 && echo kubectl_ok; ",
            "command -v nvidia-smi >/dev/null 2>&1 && echo nvidia_ok; ",
            "command -v npu-smi >/dev/null 2>&1 && echo npu_ok; ",
            "command -v ss >/dev/null 2>&1 && echo ss_ok; ",
            "command -v netstat >/dev/null 2>&1 && echo netstat_ok; ",
            "command -v lsof >/dev/null 2>&1 && echo lsof_ok; ",
            "command -v systemctl >/dev/null 2>&1 && echo systemctl_ok",
          ].join(""),
          8000,
        );
        if (!fallback.success) return { success: false, error: fallback.error || "Probe failed" };
        const text = fallback.stdout || "";
        return {
          success: true,
          capabilities: {
            targetOs: platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : "unknown",
            hasTmux: text.includes("tmux") && !text.includes("not found"),
            hasZellij: text.includes("zellij_ok"),
            hasDocker: text.includes("docker_ok"),
            hasPodman: text.includes("podman_ok"),
            hasNerdctl: text.includes("nerdctl_ok"),
            hasKubectl: text.includes("kubectl_ok"),
            hasNvidiaSmi: text.includes("nvidia_ok"),
            hasNpuSmi: text.includes("npu_ok"),
            hasSs: text.includes("ss_ok"),
            hasNetstat: text.includes("netstat_ok"),
            hasLsof: text.includes("lsof_ok"),
            hasSystemctl: text.includes("systemctl_ok"),
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
      const result = await execOnLocalMachine(
        "Get-CimInstance Win32_Process | Sort-Object KernelModeTime -Descending | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress",
        10000,
        { maxBuffer: PROCESS_LIST_MAX_BUFFER },
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

    const result = await execOnSession(event, sessionId, PROCESS_LIST_SCRIPT_POSIX, 12000, {
      maxBuffer: PROCESS_LIST_MAX_BUFFER,
    });
    if (result.pending) return { success: false, pending: true };
    if (!result.success) return { success: false, error: result.error || "Failed to list processes" };
    return { success: true, processes: parseProcessLines(result.stdout) };
  }

  async function signalProcess(event, payload) {
    const { sessionId, pid, signal = "TERM", nice } = payload || {};
    if (!sessionId || !pid) return { success: false, error: "Missing sessionId or pid" };
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid) || numericPid <= 0) {
      return { success: false, error: "Invalid pid" };
    }

    // Local Windows has no POSIX kill; map only TERM/KILL onto Stop-Process.
    if (isLocalSession(sessionId) && process.platform === "win32") {
      if (nice !== undefined && nice !== null) {
        return { success: false, error: "renice is not supported on Windows" };
      }
      const sig = String(signal || "TERM").toUpperCase();
      if (!(sig === "TERM" || sig === "15" || sig === "KILL" || sig === "9")) {
        return { success: false, error: `signal ${sig} is not supported on Windows` };
      }
      const force = sig === "KILL" || sig === "9";
      const ps = force
        ? `Stop-Process -Id ${Math.trunc(numericPid)} -Force -ErrorAction Stop`
        : `Stop-Process -Id ${Math.trunc(numericPid)} -ErrorAction Stop`;
      const result = await execOnLocalMachine(ps, 5000);
      if (!result.success) return { success: false, error: result.error || "Stop-Process failed" };
      if (typeof result.code === "number" && result.code !== 0) {
        return {
          success: false,
          error: (result.stderr || result.error || `Stop-Process exited with code ${result.code}`).trim(),
          code: result.code,
        };
      }
      return { success: true, code: result.code };
    }

    const built = buildProcessSignalCommand(pid, signal, nice);
    if (built.error) return { success: false, error: built.error };
    const result = await execOnSession(event, sessionId, `exec sh -c ${JSON.stringify(built.command)}`, 5000);
    if (result.pending) return { success: false, pending: true, error: result.error };
    if (!result.success) return { success: false, error: result.error };
    if (typeof result.code === "number" && result.code !== 0) {
      return {
        success: false,
        error: (result.stderr || result.error || `kill exited with code ${result.code}`).trim(),
        code: result.code,
      };
    }
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
    const scope = typeof payload === "string" ? null : payload?.scope;
    return tmuxOps.listSessions(event, sessionId, scope);
  }

  async function listTmuxSnapshot(event, payload) {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const scope = typeof payload === "string" ? null : payload?.scope;
    return tmuxOps.listTmuxSnapshot(event, sessionId, scope);
  }

  async function listMultiplexerUsers(event, payload) {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const result = await execOnSession(event, sessionId, MUX_LIST_USERS_SCRIPT, 8000);
    if (result.pending) return { success: false, pending: true };
    if (!result.success) return { success: false, error: result.error || "Failed to list users" };
    const parsed = parseListUsersOutput(result.stdout);
    return { success: true, ...parsed };
  }

  async function listZellijSessions(event, payload) {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const scope = typeof payload === "string" ? null : payload?.scope;
    return zellijOps.listSessions(event, sessionId, scope);
  }

  async function zellijAction(event, payload) {
    const result = await zellijOps.zellijAction(event, payload);
    if (result.success === false) {
      return { success: false, error: result.error || "zellij command failed", errorCode: result.errorCode };
    }
    return { success: true };
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
      return { success: false, error: result.error || result.stderr, errorCode: result.errorCode };
    }
    if (result.success === false) {
      return { success: false, error: result.stderr || "tmux command failed", errorCode: result.errorCode };
    }
    return { success: true };
  }

  async function listDockerContainers(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return dockerOps.listContainers(event, sessionId, payload?.runtime);
  }

  async function listDockerImages(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return dockerOps.listImages(event, sessionId, payload?.runtime);
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
      if (result.errorCode === "nerdctlUnreachable") {
        return { success: false, errorCode: result.errorCode };
      }
      return { success: false, error: result.error || result.stderr || "docker command failed" };
    }
    return { success: true };
  }

  async function kubectl(event, payload) {
    return kubectlOps.run(event, payload);
  }

  async function dockerImageAction(event, payload) {
    const result = await dockerOps.imageAction(event, payload);
    if (result.success === false) {
      if (result.errorCode === "nerdctlUnreachable") {
        return { success: false, errorCode: result.errorCode };
      }
      return { success: false, error: result.error || result.stderr || "docker command failed" };
    }
    return { success: true, output: result.stdout };
  }

  async function listAccelerators(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return gpuOps.listAccelerators(event, sessionId);
  }

  async function listListeningPorts(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return portOps.listListeningPorts(event, sessionId);
  }

  async function listSystemServices(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    return serviceOps.listServices(event, sessionId);
  }

  async function systemServiceAction(event, payload) {
    return serviceOps.serviceAction(event, payload);
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
        "netcatty:system:listTmuxSnapshot",
        "netcatty:system:createTmuxSession",
        "netcatty:system:listTmuxWindows",
        "netcatty:system:listTmuxPanes",
        "netcatty:system:listTmuxClients",
        "netcatty:system:tmuxAction",
        "netcatty:system:listMultiplexerUsers",
        "netcatty:system:listZellijSessions",
        "netcatty:system:zellijAction",
        "netcatty:system:listDockerContainers",
        "netcatty:system:listDockerImages",
        "netcatty:system:dockerStats",
        "netcatty:system:dockerInspect",
        "netcatty:system:dockerImageInspect",
        "netcatty:system:dockerAction",
        "netcatty:system:dockerImageAction",
        "netcatty:system:kubectl",
        "netcatty:system:listAccelerators",
        "netcatty:system:listListeningPorts",
        "netcatty:system:listSystemServices",
        "netcatty:system:systemServiceAction",
      ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel));
      return;
    }
    ipcMain.handle("netcatty:system:probeCapabilities", probeCapabilities);
    ipcMain.handle("netcatty:system:listProcesses", listProcesses);
    ipcMain.handle("netcatty:system:signalProcess", signalProcess);
    ipcMain.handle("netcatty:system:setupOsc7Tracking", setupOsc7Tracking);
    ipcMain.handle("netcatty:system:listTmuxSessions", listTmuxSessions);
    ipcMain.handle("netcatty:system:listTmuxSnapshot", listTmuxSnapshot);
    ipcMain.handle("netcatty:system:createTmuxSession", createTmuxSession);
    ipcMain.handle("netcatty:system:listTmuxWindows", listTmuxWindows);
    ipcMain.handle("netcatty:system:listTmuxPanes", listTmuxPanes);
    ipcMain.handle("netcatty:system:listTmuxClients", listTmuxClients);
    ipcMain.handle("netcatty:system:tmuxAction", tmuxAction);
    ipcMain.handle("netcatty:system:listMultiplexerUsers", listMultiplexerUsers);
    ipcMain.handle("netcatty:system:listZellijSessions", listZellijSessions);
    ipcMain.handle("netcatty:system:zellijAction", zellijAction);
    ipcMain.handle("netcatty:system:listDockerContainers", listDockerContainers);
    ipcMain.handle("netcatty:system:listDockerImages", listDockerImages);
    ipcMain.handle("netcatty:system:dockerStats", dockerStats);
    ipcMain.handle("netcatty:system:dockerInspect", dockerInspect);
    ipcMain.handle("netcatty:system:dockerImageInspect", dockerImageInspect);
    ipcMain.handle("netcatty:system:dockerAction", dockerAction);
    ipcMain.handle("netcatty:system:dockerImageAction", dockerImageAction);
    ipcMain.handle("netcatty:system:kubectl", kubectl);
    ipcMain.handle("netcatty:system:listAccelerators", listAccelerators);
    ipcMain.handle("netcatty:system:listListeningPorts", listListeningPorts);
    ipcMain.handle("netcatty:system:listSystemServices", listSystemServices);
    ipcMain.handle("netcatty:system:systemServiceAction", systemServiceAction);
  }

  return { registerHandlers, probeCapabilities, listProcesses, signalProcess, setupOsc7Tracking };
}

module.exports = { createSystemManagerBridge };
