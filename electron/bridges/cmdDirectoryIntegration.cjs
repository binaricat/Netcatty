const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { createDirectoryReportStream } = require('./directoryReportStream.cjs');

const PROPERTY = '633;P;NetcattyCmdDirectory=';
const PREFIX = '\x1b]' + PROPERTY;

function drivePath(value) {
  return typeof value === 'string' && value.length <= 8192 && /^[a-z]:\\/i.test(value)
    && !/[\x00-\x1f\x7f<>"|?*/:]/.test(value.slice(2));
}

function readWindowsProcessTree(pid, callback, {
  loadNative = () => require('@vscode/windows-process-tree'), execFileFn = execFile, readFallback,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return callback(null);
  const fallback = () => {
    if (readFallback) return readFallback(pid, callback);
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
      'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = `$ErrorActionPreference = 'Stop'; `
      + `$processes = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid} OR ParentProcessId = ${pid}"); `
      + `if (@($processes | Where-Object { $_.ProcessId -eq ${pid} -and $_.Name -eq 'cmd.exe' }).Count -eq 1 `
      + `-and $processes.Count -eq 1) { [Console]::WriteLine('idle') }`;
    execFileFn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 2800, maxBuffer: 64 * 1024,
    }, (error, stdout) => callback(!error && stdout.trim() === 'idle' ? { pid, children: [] } : null));
  };
  try {
    loadNative().getProcessTree(pid, tree => {
      if (tree?.pid === pid && Array.isArray(tree.children)) callback(tree);
      else fallback();
    });
  } catch { fallback(); }
}

function isOriginalShellIdle(pid, getProcessTree) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 3000);
    const finish = ok => { clearTimeout(timer); resolve(ok); };
    try {
      getProcessTree(pid, tree => finish(tree?.pid === pid && tree.children?.length === 0));
    } catch { finish(false); }
  });
}

function createCmdDirectoryReader(nonce, home, getProcessTree = readWindowsProcessTree) {
  let processId = null;
  let revision = 0;
  let state = null;
  let pendingCheck = null;
  return {
    setProcessId(pid) { processId = pid; },
    invalidate() { state = null; },
    async read() {
      const candidate = state;
      const pid = processId;
      // Nested CMD inherits PROMPT. Verify the original process has no active
      // children and discard the result if the prompt changed during the check.
      if (candidate && pid) {
        if (pendingCheck?.candidate !== candidate || pendingCheck.pid !== pid) {
          const promise = isOriginalShellIdle(pid, getProcessTree).finally(() => {
            if (pendingCheck?.promise === promise) pendingCheck = null;
          });
          pendingCheck = { candidate, pid, promise };
        }
        if (await pendingCheck.promise && candidate === state && pid === processId) {
          return { success: true, cwd: candidate.cwd, directoryState: candidate };
        }
      }
      return { success: false, error: 'CMD directory integration is not ready' };
    },
    consume: createDirectoryReportStream(PREFIX, value => {
      const header = nonce + ';';
      if (!value.startsWith(header)) return;
      const cwd = value.slice(header.length);
      state = drivePath(cwd) ? { cwd, home: drivePath(home) ? home : null, provider: 'FileSystem',
        revision: ++revision, shellKind: 'cmd', pathFlavor: 'win32' } : null;
    }),
  };
}

function prepareCmdDirectoryIntegration(shell, args, env, deps = {}) {
  if ((deps.platform ?? process.platform) !== 'win32' || !/^cmd(\.exe)?$/i.test(path.win32.basename(shell))
    || !Array.isArray(args) || !args.every(arg => /^\/(d|q|e:on|v:(on|off))$/i.test(arg))) return null;
  const nonce = randomBytes(32).toString('hex');
  // PROMPT expansion happens in CMD itself, preserving status and Unicode paths.
  const key = Object.keys(env).find(name => name.toLowerCase() === 'prompt') ?? 'PROMPT';
  const prompt = env[key] || '$P$G';
  return {
    args,
    env: { [key]: `$E]${PROPERTY}${nonce};$P$E\\${prompt}` },
    reader: createCmdDirectoryReader(nonce, deps.home ?? os.homedir(), deps.getProcessTree),
  };
}

module.exports = { PREFIX, createCmdDirectoryReader, prepareCmdDirectoryIntegration, readWindowsProcessTree };
