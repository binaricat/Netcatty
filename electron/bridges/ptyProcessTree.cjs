const { execFile } = require("node:child_process");

function createProcessTree({ platform, listPosix, listWindows } = {}) {
  const sessionPidMap = new Map();

  function registerPid(sessionId, pid) {
    if (!sessionId || typeof pid !== "number") return;
    if (sessionPidMap.has(sessionId) && sessionPidMap.get(sessionId) !== pid) {
      console.warn(
        `[ptyProcessTree] sessionId "${sessionId}" already registered with pid ${sessionPidMap.get(sessionId)}; overwriting with ${pid}.`,
      );
    }
    sessionPidMap.set(sessionId, pid);
  }

  function unregisterPid(sessionId) {
    sessionPidMap.delete(sessionId);
  }

  async function getChildProcesses(sessionId) {
    const pid = sessionPidMap.get(sessionId);
    if (!pid) return [];
    if (platform === "win32") {
      return listWindows ? listWindows(pid) : [];
    }
    return listPosix ? listPosix(pid) : [];
  }

  return { registerPid, unregisterPid, getChildProcesses };
}

function defaultListPosix(ppid) {
  return new Promise((resolve) => {
    // `ps -A -o pid=,ppid=,args=` works on both BSD (macOS) and GNU (Linux).
    // `args=` shows the full command line (not truncated like `comm=`).
    // The trailing `=` on each column suppresses the header row.
    execFile("ps", ["-A", "-o", "pid=,ppid=,args="], (err, stdout) => {
      if (err || typeof stdout !== "string") return resolve([]);
      const out = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        if (Number(m[2]) !== ppid) continue;
        out.push({ pid: Number(m[1]), command: m[3].trim() });
      }
      resolve(out);
    });
  });
}

function defaultListWindows(ppid) {
  return new Promise((resolve) => {
    let wpt;
    try {
      wpt = require("@vscode/windows-process-tree");
    } catch {
      return resolve([]);
    }
    try {
      wpt.getProcessTree(ppid, (tree) => {
        if (!tree || !Array.isArray(tree.children)) return resolve([]);
        resolve(tree.children.map((c) => ({ pid: c.pid, command: c.name })));
      });
    } catch {
      resolve([]);
    }
  });
}

function createDefaultProcessTree() {
  const platform = process.platform;
  return createProcessTree({
    platform,
    listPosix: platform === "win32" ? undefined : defaultListPosix,
    listWindows: platform === "win32" ? defaultListWindows : undefined,
  });
}

const defaultTree = createDefaultProcessTree();

module.exports = {
  createProcessTree,
  processTree: defaultTree,
  registerPid: (id, pid) => defaultTree.registerPid(id, pid),
  unregisterPid: (id) => defaultTree.unregisterPid(id),
  getChildProcesses: (id) => defaultTree.getChildProcesses(id),
};
