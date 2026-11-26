const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isDiscoveredGitBash } = require('../../lib/localShell.cjs');
const { readWindowsProcessTree } = require('./cmdDirectoryIntegration.cjs');

const run = promisify(execFile);
const probeOptions = { encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 128 * 1024 };
const unavailable = { success: false, error: 'Git Bash directory integration is not ready' };

// Git for Windows starts a launcher followed by its MSYS bash process.
function idleBashPid(tree, rootPid) {
  if (tree?.pid !== rootPid || tree.name?.toLowerCase() !== 'bash.exe' || tree.children?.length !== 1) return null;
  const [bash] = tree.children;
  return bash.name?.toLowerCase() === 'bash.exe' && bash.children?.length === 0 ? bash.pid : null;
}

function readGitBashTreeFallback(pid, callback) {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference = 'Stop'; `
    + `$processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name); `
    + `$root = @($processes | Where-Object { $_.ProcessId -eq ${pid} -and $_.Name -eq 'bash.exe' }); `
    + `$children = @($processes | Where-Object { $_.ParentProcessId -eq ${pid} }); `
    + `if ($root.Count -eq 1 -and $children.Count -eq 1 -and $children[0].Name -eq 'bash.exe') { `
    + `$child = $children[0].ProcessId; if (-not ($processes | Where-Object { $_.ParentProcessId -eq $child })) { [Console]::WriteLine($child) } }`;
  execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { ...probeOptions, timeout: 3000 }, (error, stdout) => {
      const child = error ? 0 : Number(stdout.trim());
      callback(Number.isSafeInteger(child) && child > 0
        ? { pid, name: 'bash.exe', children: [{ pid: child, name: 'bash.exe', children: [] }] } : null);
    });
}

function getShellTree(pid) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 3200);
    readWindowsProcessTree(pid, tree => { clearTimeout(timer); resolve(tree); }, { readFallback: readGitBashTreeFallback });
  });
}

function findMsysPid(stdout, windowsPid) {
  const rows = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 8 && /^[1-9]\d*$/.test(fields[0]));
  const matches = rows.filter(fields => fields[3] === String(windowsPid) && fields[7] === '/usr/bin/bash');
  if (matches.length !== 1) return null;
  const [pid] = matches[0];
  // MSYS maintains its own parentage across fork and exec.
  return rows.some(fields => fields[1] === pid) ? null : pid;
}

async function probeDirectory(rootPid, bin, env, getTree) {
  const options = { ...probeOptions, env };
  const [tree, processes] = await Promise.all([
    getTree(rootPid), run(path.win32.join(bin, 'ps.exe'), ['-e', '-l'], options),
  ]);
  const windowsPid = idleBashPid(tree, rootPid);
  const msysPid = windowsPid ? findMsysPid(processes.stdout, windowsPid) : null;
  if (!msysPid) return null;
  const { stdout: link } = await run(path.win32.join(bin, 'readlink.exe'), [`/proc/${msysPid}/cwd`], options);
  const posixCwd = link.replace(/\r?\n$/, '');
  if (!posixCwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(posixCwd)
    || /^\/(?:dev|proc)(?:\/|$)/.test(posixCwd)) return null;
  const { stdout } = await run(path.win32.join(bin, 'cygpath.exe'), ['-w', '--', posixCwd], options);
  const cwd = stdout.replace(/\r?\n$/, '');
  if (!/^[a-z]:\\/i.test(cwd) || /[\x00-\x1f\x7f<>"|?*]/.test(cwd) || cwd.length > 8192) return null;
  return (await fs.promises.stat(cwd)).isDirectory() ? cwd : null;
}

function createGitBashDirectoryReader(probe) {
  let pid;
  let revision = 0;
  let pending;
  return {
    setProcessId(value) { pid = value; pending = undefined; },
    invalidate() { pending = undefined; },
    read() {
      if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(unavailable);
      if (pending) return pending;
      const processId = pid;
      const query = Promise.resolve().then(() => probe(processId)).then(cwd => {
        if (!cwd || pending !== query) return unavailable;
        return { success: true, cwd, directoryState: { cwd, home: null, provider: 'FileSystem',
          revision: ++revision, shellKind: 'git-bash', pathFlavor: 'win32' } };
      }).catch(() => unavailable).finally(() => { if (pending === query) pending = undefined; });
      pending = query;
      return query;
    },
  };
}

function prepareGitBashDirectoryIntegration(shell, args, env, discoveredCommand) {
  if (process.platform !== 'win32' || !isDiscoveredGitBash(shell, discoveredCommand)
    || !args.every(arg => ['--login', '-l', '-i', '--noprofile', '--norc'].includes(arg))) return null;
  const bin = path.win32.resolve(path.win32.dirname(shell), '..', 'usr', 'bin');
  if (!['ps.exe', 'readlink.exe', 'cygpath.exe'].every(tool => fs.existsSync(path.win32.join(bin, tool)))) return null;
  return { reader: createGitBashDirectoryReader(pid => probeDirectory(pid, bin, env, getShellTree)) };
}

module.exports = { createGitBashDirectoryReader, findMsysPid, idleBashPid, prepareGitBashDirectoryIntegration };
