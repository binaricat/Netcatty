const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const marker = 'NETCATTY_WSL_DIRECTORY_SESSION';
const unavailable = Object.freeze({ success: false, error: 'unavailable' });
const isPath = value => typeof value === 'string' && value.startsWith('/') && value.length <= 8192
  && !/[\x00-\x1f\x7f]|[\uD800-\uDFFF]/u.test(value);

function getWslDirectoryArgs(args, discovered) {
  // A named distro is required so the helper cannot follow a changed default.
  if (!['-d', '--distribution'].includes(args[0]) || args[1] !== discovered || !discovered) return null;
  const target = ['--distribution', discovered];
  for (let index = 2; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--cd' && value && !value.startsWith('-')) continue;
    if (['-u', '--user'].includes(option) && /^[a-z_][a-z0-9_.-]*\$?$/i.test(value ?? '')
      && !target.includes('--user')) {
      target.push('--user', value);
    } else return null;
  }
  return target;
}

function createWslDirectoryReader(probe) {
  let identity = '';
  let revision = 0;
  let pendingRead;
  let generation = new AbortController();
  let closed = false;

  async function query(operation, target = '') {
    const { signal } = generation;
    if (closed) return unavailable;
    try {
      const result = await probe(operation, identity, target, signal);
      if (signal.aborted) return unavailable;
      if (result.error) return ['readFailed', 'accessDenied'].includes(result.error)
        ? { success: false, error: result.error } : unavailable;
      if (!/^\d+:\d+$/.test(result.identity) || (identity && identity !== result.identity) || !isPath(result.cwd)) {
        return unavailable;
      }
      identity = result.identity;
      const home = isPath(result.home) ? result.home : null;
      if (operation === 'list') return { success: true, files: result.files, home };
      if (operation === 'realpath') return isPath(result.path) ? { success: true, path: result.path } : unavailable;
      const cwd = result.cwd;
      return { success: true, cwd, directoryState: { cwd, home, provider: 'FileSystem',
        revision: ++revision, shellKind: 'wsl', pathFlavor: 'posix' } };
    } catch {
      return signal.aborted ? unavailable : { success: false, error: 'readFailed' };
    }
  }

  function invalidate() {
    generation.abort();
    generation = new AbortController();
    pendingRead = undefined;
  }

  return {
    invalidate,
    close() { closed = true; invalidate(); },
    read() {
      if (pendingRead) return pendingRead;
      const result = query('cwd').finally(() => { if (pendingRead === result) pendingRead = undefined; });
      pendingRead = result;
      return result;
    },
    readPath(operation, target) {
      if (!['list', 'realpath'].includes(operation) || !isPath(target)) return unavailable;
      return query(operation, target);
    },
  };
}

function prepareWslDirectoryIntegration(shell, args, env, discovered) {
  if (process.platform !== 'win32' || !discovered || shell.toLowerCase() !== discovered.command.toLowerCase()) return null;
  const target = getWslDirectoryArgs(args, discovered.args?.[1]);
  if (!target) return null;
  let script;
  try { script = fs.readFileSync(path.join(__dirname, 'shellIntegration', 'directory-wsl.py'), 'utf8'); }
  catch { return null; }
  const nonce = randomBytes(24).toString('hex');
  const wslEnvKey = Object.keys(env).find(key => key.toUpperCase() === 'WSLENV') || 'WSLENV';
  const forwarded = (env[wslEnvKey] || '').split(':').filter(entry => entry && entry.split('/')[0] !== marker);
  const reader = createWslDirectoryReader(async (operation, identity, targetPath, signal) => {
    // Encode the path as data. Only the fixed Python program is executable.
    const encoded = Buffer.from(targetPath, 'utf8').toString('base64');
    const { stdout } = await run(shell, [...target, '--cd', '/', '--exec', '/usr/bin/python3', '-I', '-c',
      script, operation, nonce, identity, encoded], { encoding: 'utf8', windowsHide: true,
      timeout: 2500, maxBuffer: 512 * 1024, signal, env });
    return JSON.parse(stdout);
  });
  return { reader, env: { [wslEnvKey]: [...forwarded, `${marker}/u`].join(':'), [marker]: nonce }, cleanup: reader.close };
}

module.exports = { prepareWslDirectoryIntegration, createWslDirectoryReader, getWslDirectoryArgs };
