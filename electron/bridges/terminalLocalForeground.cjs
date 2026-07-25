const path = require("node:path");

function isLocalShellForegroundFromPs(stdout, shellPid) {
  const processes = new Map();
  for (const line of String(stdout || "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    processes.set(Number(match[1]), {
      ppid: Number(match[2]),
      stat: match[3],
      command: path.basename(match[4]).replace(/^-/, ""),
    });
  }
  const isDescendant = (pid) => {
    for (let depth = 0; pid && depth < 64; depth += 1) {
      if (pid === shellPid) return true;
      pid = processes.get(pid)?.ppid;
    }
    return false;
  };
  const isShell = (command) => /^(?:ba|z|fi|k|da|a|c|tc)?sh$/u.test(command);
  let foregroundShell = false;
  let foregroundJob = false;
  for (const [pid, processInfo] of processes) {
    if (!isDescendant(pid) || !processInfo.stat.includes("+")) continue;
    if (isShell(processInfo.command)) foregroundShell = true;
    else foregroundJob = true;
  }
  return foregroundShell && !foregroundJob;
}

module.exports = { isLocalShellForegroundFromPs };
