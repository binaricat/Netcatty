const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const tempDirBridge = require('./tempDirBridge.cjs');
const { MAX_REPORT, createDirectoryReportStream } = require('./directoryReportStream.cjs');

// A private property on the existing OSC 633 property channel. Its payload is
// consumed in the PTY owner, before logging, replay, prompt tracking or output.
const PREFIX = '\x1b]633;P;NetcattyDirectory=';

function nativePath(value) {
  return typeof value === 'string' && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value)
    && !/^\\\\[?.]\\/.test(value)
    && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value));
}

function createDirectoryReportReader(nonce) {
  let revision = 0;
  let state = null;
  let processId = null;
  let sequence = 0;
  return {
    setProcessId(pid) { processId = pid; },
    invalidate() { state = null; },
    read() {
      if (!state) return { success: false, error: 'PowerShell directory integration is not ready' };
      return { success: state.provider === 'FileSystem', cwd: state.cwd ?? undefined,
        error: state.provider === 'FileSystem' ? undefined : 'PowerShell location is not a filesystem',
        directoryState: { ...state, revision, shellKind: 'powershell', pathFlavor: 'win32' } };
    },
    consume: createDirectoryReportStream(PREFIX, payload => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return;
      try {
        const report = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        if (report.version !== 1 || report.nonce !== nonce || report.pid !== processId
          || !Number.isSafeInteger(report.sequence) || report.sequence <= sequence
          || typeof report.provider !== 'string' || report.provider.length > 128) return;
        if (report.provider === 'FileSystem' && !nativePath(report.cwd)) return;
        sequence = report.sequence;
        revision++;
        state = { provider: report.provider, cwd: report.provider === 'FileSystem' ? report.cwd : null,
          home: nativePath(report.home) ? report.home : null };
      } catch { /* Retain capability state only for validated reports. */ }
    }),
  };
}

/** Only ordinary native Windows PowerShell launches have a proven namespace. */
function canIntegratePowerShell(shell, args, platform = process.platform) {
  return platform === 'win32' && /^(powershell|pwsh)(\.exe)?$/i.test(path.win32.basename(shell))
    && Array.isArray(args) && args.every(arg => /^-(NoLogo|NoProfile|NoExit)$/i.test(arg));
}

function preparePowerShellDirectoryIntegration(shell, args, deps = {}) {
  if (!canIntegratePowerShell(shell, args, deps.platform)) return null;
  const nonce = randomBytes(32).toString('hex');
  let file;
  try {
    file = (deps.getTempFilePath || tempDirBridge.getTempFilePath)(`powershell-directory-${nonce}.ps1`);
    const source = fs.readFileSync(path.join(__dirname, 'shellIntegration', 'directory.ps1'), 'utf8');
    // Windows PowerShell 5.1 needs a BOM to read UTF-8 scripts reliably.
    fs.writeFileSync(file, '\ufeff' + source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch {
    return null; // Preserve ordinary shell startup when setup is unavailable.
  }
  const reader = createDirectoryReportReader(nonce);
  return {
    args: [...args, ...(args.some(arg => /^-NoExit$/i.test(arg)) ? [] : ['-NoExit']),
      '-Command', `. '${file.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`],
    env: { NETCATTY_DIRECTORY_NONCE: nonce },
    reader,
    cleanup() { try { fs.unlinkSync(file); } catch { /* Managed temp cleanup also reaps leftovers. */ } },
  };
}

module.exports = { PREFIX, MAX_REPORT, createDirectoryReportReader, canIntegratePowerShell, preparePowerShellDirectoryIntegration };
