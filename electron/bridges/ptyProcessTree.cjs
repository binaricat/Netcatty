const { execFile } = require("node:child_process");

const POSIX_PROCESS_LIST_TIMEOUT_MS = 3_000;
const POSIX_PROCESS_LIST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

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

function defaultListPosix(ppid, { execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    // Separate `-o col=` options. A single `-o pid=,ppid=,args=` spec is
    // misread by procps-ng 3.3.x: the text after the first `=` becomes the
    // header, so only pid is printed. The split form works on BSD (macOS),
    // modern procps, and BusyBox. `args=` is the full command line.
    execFileFn("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], {
      timeout: POSIX_PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: POSIX_PROCESS_LIST_MAX_BUFFER_BYTES,
      windowsHide: true,
    }, (err, stdout) => {
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

function registerWorkerHandlers(ipcMain) {
  ipcMain.handle("netcatty:pty:childProcesses", async (_event, payload) => {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    if (typeof sessionId !== "string") return [];
    return defaultTree.getChildProcesses(sessionId);
  });
}

module.exports = {
  POSIX_PROCESS_LIST_TIMEOUT_MS,
  POSIX_PROCESS_LIST_MAX_BUFFER_BYTES,
  createProcessTree,
  defaultListPosix,
  registerWorkerHandlers,
  processTree: defaultTree,
  registerPid: (id, pid) => defaultTree.registerPid(id, pid),
  unregisterPid: (id) => defaultTree.unregisterPid(id),
  getChildProcesses: (id) => defaultTree.getChildProcesses(id),
};
