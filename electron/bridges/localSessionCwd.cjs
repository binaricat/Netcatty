const fs = require("node:fs");
const { execFile } = require("node:child_process");

const LSOF_TIMEOUT_MS = 2000;
const LSOF_MAX_BUFFER_BYTES = 64 * 1024;

const isAbsolutePosixPath = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.includes("\0");

/**
 * lsof appends "(readlink: Permission denied)" style notes to names it could
 * not resolve. Those are not directories the shell can `cd` into.
 */
const isAnnotatedLsofName = (name) =>
  /\s\([A-Za-z][A-Za-z0-9]*: .*\)$/.test(name);

/**
 * Parse `lsof -F n` (optionally with `t` type records) and return the cwd
 * name when lsof reports a directory.
 */
function parseLsofCwdOutput(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return null;
  let name = null;
  let isDir = true;
  let sawType = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("f")) {
      sawType = false;
      isDir = true;
      continue;
    }
    if (line.startsWith("t")) {
      sawType = true;
      isDir = line === "tDIR" || line === "tVDIR";
      continue;
    }
    if (line.startsWith("n") && (!sawType || isDir)) {
      name = line.slice(1);
    }
  }
  if (!isAbsolutePosixPath(name) || isAnnotatedLsofName(name)) return null;
  return name;
}

function localSessionPid(session) {
  const pid = session?.proc?.pid ?? session?.pty?.pid;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readlinkProcCwd(pid, readlink) {
  return Promise.resolve(readlink(`/proc/${pid}/cwd`)).then(
    (cwd) => (isAbsolutePosixPath(cwd) ? cwd : null),
    () => null,
  );
}

function execFileText(execFileFn, file, args) {
  return new Promise((resolve, reject) => {
    execFileFn(
      file,
      args,
      {
        timeout: LSOF_TIMEOUT_MS,
        maxBuffer: LSOF_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (err, stdout) => {
        if (typeof stdout === "string" && stdout.length > 0) {
          resolve(stdout);
          return;
        }
        reject(err || new Error("lsof produced no output"));
      },
    );
  });
}

async function readLsofCwd(pid, execFileFn, binaries) {
  const args = ["-a", "-p", String(pid), "-d", "cwd", "-Fn"];
  for (const bin of binaries) {
    try {
      const stdout = await execFileText(execFileFn, bin, args);
      const cwd = parseLsofCwdOutput(stdout);
      if (cwd) return cwd;
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
    }
  }
  return null;
}

function lsofBinaries(platform) {
  if (platform === "darwin") return ["/usr/sbin/lsof", "lsof"];
  return ["lsof"];
}

/**
 * Working directory of the local PTY shell Netcatty spawned.
 *
 * `cd` is a shell builtin, so the spawned process cwd changes even when the
 * shell never prints OSC 7. Linux reads `/proc/<pid>/cwd`; macOS uses lsof
 * because it has no procfs. Windows shells are not probed here.
 */
async function readLocalSessionCwd(session, deps = {}) {
  if ((deps.platform || process.platform) === 'win32' && session?.directoryIntegration) {
    return session.directoryIntegration.read();
  }
  const pid = localSessionPid(session);
  if (!pid) return { success: false, error: "Local session has no process" };

  const platform = deps.platform || process.platform;
  const readlink = deps.readlink || fs.promises.readlink.bind(fs.promises);
  const execFileFn = deps.execFile || execFile;

  let cwd = null;
  if (platform === "linux") {
    cwd = await readlinkProcCwd(pid, readlink);
  }
  if (!cwd && (platform === "linux" || platform === "darwin")) {
    cwd = await readLsofCwd(pid, execFileFn, deps.lsofBinaries || lsofBinaries(platform));
  }
  if (!cwd) return { success: false, error: "Could not determine cwd" };
  return { success: true, cwd };
}

module.exports = {
  parseLsofCwdOutput,
  readLocalSessionCwd,
};
