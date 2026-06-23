/* eslint-disable no-undef */

function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\"'\"'`)}'`;
}

function sanitizeDockerId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
}

function sanitizeContainerName(name) {
  const trimmed = String(name || "").trim().slice(0, 128);
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9_.-]/g, "") || null;
}

function sanitizeImageRef(ref) {
  const trimmed = String(ref || "").trim().slice(0, 256);
  return trimmed || null;
}

function isSuccessfulCommandResult(result) {
  return result?.success && (result.code === 0 || result.code === null || result.code === undefined);
}

function dockerCommandError(result, fallback) {
  return (result?.stderr || result?.error || "").trim() || fallback;
}

function isDockerSocketPermissionError(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}\n${result?.error || ""}`.toLowerCase();
  if (!text.includes("permission denied")) return false;
  return text.includes("docker daemon")
    || text.includes("docker.sock")
    || text.includes("/var/run/docker.sock")
    || text.includes("connect to the docker daemon");
}

function getSessionSudoPassword(session) {
  return typeof session?.systemManagerSudoPassword === "string" && session.systemManagerSudoPassword.length > 0
    ? session.systemManagerSudoPassword
    : null;
}

function buildDockerCommand(args) {
  return `docker ${args}`.trim();
}

function buildPasswordlessSudoDockerCommand(args) {
  return `sudo ${buildDockerCommand(args)}`;
}

function buildSudoDockerCommand(args) {
  return `sudo -S -p '' ${buildDockerCommand(args)}`;
}

function parseDockerContainers(stdout) {
  const containers = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      containers.push({
        id: row.ID || row.Id || "",
        name: (row.Names || row.Name || "").replace(/^\//, ""),
        image: row.Image || "",
        status: row.Status || row.State || "",
        state: row.State || "",
        ports: row.Ports || "",
        createdAt: row.CreatedAt || row.Created || "",
      });
    } catch {
      // skip malformed line
    }
  }
  return containers;
}

function parseDockerStats(stdout) {
  const stats = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      stats.push({
        id: row.ID || row.Container || "",
        name: row.Name || "",
        cpuPercent: parseFloat(String(row.CPUPerc || "0").replace("%", "")) || 0,
        memUsage: row.MemUsage || "",
        memPercent: parseFloat(String(row.MemPerc || "0").replace("%", "")) || 0,
        netIO: row.NetIO || "",
        blockIO: row.BlockIO || "",
        pids: Number(row.PIDs || row.Pids || 0) || 0,
      });
    } catch {
      // skip
    }
  }
  return stats;
}

function parseDockerImages(stdout) {
  const images = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const repository = row.Repository || "";
      const tag = row.Tag || "";
      images.push({
        id: row.ID || row.Id || "",
        repository,
        tag,
        size: row.Size || "",
        createdAt: row.CreatedAt || row.CreatedSince || "",
        digest: row.Digest || "",
        name: repository && tag ? `${repository}:${tag}` : repository || tag || row.ID || "",
      });
    } catch {
      // skip
    }
  }
  return images;
}

function summarizeImageInspect(info) {
  if (!info) return null;
  return {
    id: info.Id,
    repoTags: info.RepoTags,
    repoDigests: info.RepoDigests,
    created: info.Created,
    size: info.Size,
    architecture: info.Architecture,
    os: info.Os,
    config: {
      env: info.Config?.Env,
      cmd: info.Config?.Cmd,
      entrypoint: info.Config?.Entrypoint,
      workingDir: info.Config?.WorkingDir,
      exposedPorts: info.Config?.ExposedPorts,
      labels: info.Config?.Labels,
    },
    rootfs: info.RootFS,
    history: Array.isArray(info.History) ? info.History.slice(0, 5) : undefined,
  };
}

function summarizeContainerInspect(info) {
  if (!info) return null;
  return {
    id: info.Id,
    name: info.Name,
    image: info.Config?.Image,
    state: info.State,
    network: info.NetworkSettings,
    mounts: info.Mounts,
    env: info.Config?.Env,
    labels: info.Config?.Labels,
    created: info.Created,
    path: info.Path,
    args: info.Args,
    restartPolicy: info.HostConfig?.RestartPolicy,
  };
}

function createDockerOpsApi({ execOnSession, getSession }) {
  async function runDocker(event, sessionId, args, timeoutMs = 15000) {
    const cmd = buildDockerCommand(args);
    const result = await execOnSession(event, sessionId, cmd, timeoutMs);
    if (isSuccessfulCommandResult(result)) return result;

    if (isDockerSocketPermissionError(result)) {
      const sudoPassword = getSessionSudoPassword(getSession?.(sessionId));
      let lastSudoResult = null;

      const nopasswdResult = await execOnSession(
        event,
        sessionId,
        buildPasswordlessSudoDockerCommand(args),
        timeoutMs,
      );
      if (isSuccessfulCommandResult(nopasswdResult)) return nopasswdResult;
      lastSudoResult = nopasswdResult;

      if (sudoPassword) {
        const sudoResult = await execOnSession(
          event,
          sessionId,
          buildSudoDockerCommand(args),
          timeoutMs,
          { stdin: `${sudoPassword}\n` },
        );
        if (isSuccessfulCommandResult(sudoResult)) return sudoResult;
        lastSudoResult = sudoResult;
      }

      return {
        success: false,
        error: dockerCommandError(lastSudoResult, `sudo docker exited with code ${lastSudoResult?.code}`),
        stderr: lastSudoResult?.stderr,
      };
    }

    if (!result.success) return result;
    if (result.code !== 0 && result.code !== null && result.code !== undefined) {
      return {
        success: false,
        error: dockerCommandError(result, `docker exited with code ${result.code}`),
        stderr: result.stderr,
      };
    }
    return result;
  }

  async function listContainers(event, sessionId) {
    const result = await runDocker(event, sessionId, "ps -a --format '{{json .}}'", 12000);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, containers: parseDockerContainers(result.stdout) };
  }

  async function listImages(event, sessionId) {
    const result = await runDocker(event, sessionId, "images --format '{{json .}}'", 12000);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, images: parseDockerImages(result.stdout) };
  }

  async function getStats(event, payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const ids = Array.isArray(payload?.ids) ? payload.ids.filter(Boolean) : [];
    const idArg = ids.map((id) => sanitizeDockerId(id)).filter(Boolean).join(" ");
    const result = await runDocker(
      event,
      sessionId,
      `stats --no-stream --format '{{json .}}' ${idArg}`.trim(),
      15000,
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true, stats: parseDockerStats(result.stdout) };
  }

  async function inspectContainer(event, payload) {
    const { sessionId, containerId } = payload || {};
    if (!sessionId || !containerId) return { success: false, error: "Missing params" };
    const safeId = sanitizeDockerId(containerId);
    const result = await runDocker(event, sessionId, `inspect ${safeId}`, 10000);
    if (!result.success) return { success: false, error: result.error };
    try {
      const parsed = JSON.parse(result.stdout || "[]");
      const info = Array.isArray(parsed) ? parsed[0] : parsed;
      return { success: true, inspect: summarizeContainerInspect(info) };
    } catch {
      return { success: false, error: "Failed to parse inspect output" };
    }
  }

  async function inspectImage(event, payload) {
    const { sessionId, imageId } = payload || {};
    if (!sessionId || !imageId) return { success: false, error: "Missing params" };
    const safeId = sanitizeDockerId(imageId);
    const result = await runDocker(event, sessionId, `image inspect ${safeId}`, 10000);
    if (!result.success) return { success: false, error: result.error };
    try {
      const parsed = JSON.parse(result.stdout || "[]");
      const info = Array.isArray(parsed) ? parsed[0] : parsed;
      return { success: true, inspect: summarizeImageInspect(info) };
    } catch {
      return { success: false, error: "Failed to parse image inspect output" };
    }
  }

  async function containerAction(event, payload) {
    const { sessionId, containerId, action, newName } = payload || {};
    if (!sessionId || !containerId || !action) return { success: false, error: "Missing params" };
    const safeId = sanitizeDockerId(containerId);

    switch (action) {
      case "start":
        return runDocker(event, sessionId, `start ${safeId}`);
      case "stop":
        return runDocker(event, sessionId, `stop ${safeId}`);
      case "restart":
        return runDocker(event, sessionId, `restart ${safeId}`);
      case "rm":
        return runDocker(event, sessionId, `rm -f ${safeId}`);
      case "pause":
        return runDocker(event, sessionId, `pause ${safeId}`);
      case "unpause":
        return runDocker(event, sessionId, `unpause ${safeId}`);
      case "kill":
        return runDocker(event, sessionId, `kill ${safeId}`);
      case "rename": {
        const next = sanitizeContainerName(newName);
        if (!next) return { success: false, error: "Invalid container name" };
        return runDocker(event, sessionId, `rename ${safeId} ${shQuote(next)}`);
      }
      default:
        return { success: false, error: `Invalid container action: ${action}` };
    }
  }

  async function imageAction(event, payload) {
    const { sessionId, action, imageRef, imageId, force, all, repository, tag } = payload || {};
    if (!sessionId || !action) return { success: false, error: "Missing params" };

    switch (action) {
      case "pull": {
        const ref = sanitizeImageRef(imageRef);
        if (!ref) return { success: false, error: "Missing image reference" };
        return runDocker(event, sessionId, `pull ${shQuote(ref)}`, 600000);
      }
      case "rm": {
        const safeId = sanitizeDockerId(imageId);
        if (!safeId) return { success: false, error: "Missing image id" };
        const forceFlag = force ? " -f" : "";
        return runDocker(event, sessionId, `rmi${forceFlag} ${safeId}`);
      }
      case "prune": {
        const allFlag = all ? " -a" : "";
        return runDocker(event, sessionId, `image prune${allFlag} -f`, 120000);
      }
      case "tag": {
        const safeId = sanitizeDockerId(imageId);
        const repo = sanitizeImageRef(repository);
        const tagName = String(tag || "").trim().slice(0, 128) || "latest";
        if (!safeId || !repo) return { success: false, error: "Missing params" };
        return runDocker(
          event,
          sessionId,
          `tag ${safeId} ${shQuote(`${repo}:${tagName}`)}`,
        );
      }
      default:
        return { success: false, error: `Invalid image action: ${action}` };
    }
  }

  return {
    listContainers,
    listImages,
    getStats,
    inspectContainer,
    inspectImage,
    containerAction,
    imageAction,
    parseDockerContainers,
    parseDockerStats,
    parseDockerImages,
  };
}

module.exports = {
  createDockerOpsApi,
  parseDockerContainers,
  parseDockerStats,
  parseDockerImages,
};
