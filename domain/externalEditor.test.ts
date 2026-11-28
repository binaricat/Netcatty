import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_EXTERNAL_EDITOR_SETTINGS,
  EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX,
  EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER,
  EXTERNAL_EDITOR_OSC_CODE,
  EXTERNAL_EDITOR_SHELL_MARKER_END,
  EXTERNAL_EDITOR_SHELL_MARKER_START,
  SSH_BRIDGE_HOSTNAME_SUFFIX,
  buildDirectSshTarget,
  buildExternalEditorAutoSetupCommand,
  buildExternalEditorLaunchSpec,
  buildExternalEditorSessionActivateCommand,
  buildExternalEditorShellSnippet,
  buildSshBridgeHostname,
  encodeBase64UrlUtf8,
  encodeRemoteSshPath,
  formatExternalEditorOscSequence,
  getHostKeyForExternalEditor,
  isSshBridgeHostname,
  normalizeExternalEditorSettings,
  parseExternalEditorAutoSetupShell,
  parseExternalEditorOscPayload,
  resolveExternalEditorTrustPolicy,
  shouldAutoSetupExternalEditorShell,
  validateAndNormalizeRemotePath,
} from './externalEditor.ts';

test('normalizeExternalEditorSettings applies safe defaults and preserves valid fields', () => {
  const normalized = normalizeExternalEditorSettings(undefined);
  assert.equal(normalized.defaultEditor, 'zed');
  assert.equal(normalized.terminalRequestsEnabled, true);
  assert.equal(normalized.defaultTrustPolicy, 'ask');
  assert.equal(normalized.connectionMode, 'bridge');
  assert.deepEqual(normalized.trustedHosts, {});

  const custom = normalizeExternalEditorSettings({
    defaultEditor: 'cursor',
    connectionMode: 'direct',
    defaultTrustPolicy: 'deny',
    terminalRequestsEnabled: false,
    editors: {
      ...DEFAULT_EXTERNAL_EDITOR_SETTINGS.editors,
      zed: { id: 'zed', executablePath: '  C:\\Program Files\\Zed\\Zed.exe  ' },
      custom: { id: 'custom', executablePath: '/usr/bin/my-ed', customArgs: ['--ssh', '{sshTarget}', '{remotePath}'] },
    },
    trustedHosts: {
      'host:prod-1': 'allow',
      '': 'allow',
      // @ts-expect-error verifying invalid policy rejection
      'host:bad': 'super-allow',
    },
  });
  assert.equal(custom.defaultEditor, 'cursor');
  assert.equal(custom.connectionMode, 'direct');
  assert.equal(custom.editors.zed.executablePath, 'C:\\Program Files\\Zed\\Zed.exe');
  assert.deepEqual(custom.editors.custom.customArgs, ['--ssh', '{sshTarget}', '{remotePath}']);
  assert.deepEqual(custom.trustedHosts, { 'host:prod-1': 'allow' });
});

test('buildSshBridgeHostname generates deterministic DNS-safe .netcatty hostnames', () => {
  const h1 = buildSshBridgeHostname({
    hostId: 'host-123',
    label: 'Prod API (us-east) / ; rm -rf /',
    hostname: '10.0.0.5',
    port: 2222,
    username: 'deploy',
  });
  const h2 = buildSshBridgeHostname({
    hostId: 'host-123',
    label: 'Prod API (us-east) / ; rm -rf /',
    hostname: '10.0.0.5',
    port: 2222,
    username: 'deploy',
  });
  assert.equal(h1, h2);
  assert.ok(h1.endsWith(SSH_BRIDGE_HOSTNAME_SUFFIX));
  assert.ok(isSshBridgeHostname(h1));
  assert.doesNotMatch(h1, /[\s;/()]/);

  const differentHost = buildSshBridgeHostname({
    hostId: 'host-456',
    label: 'Prod API (us-east) / ; rm -rf /',
    hostname: '10.0.0.5',
    port: 2222,
    username: 'deploy',
  });
  assert.notEqual(h1, differentHost);
});

test('validateAndNormalizeRemotePath resolves relative paths and rejects control characters', () => {
  assert.deepEqual(validateAndNormalizeRemotePath('/home/user/project'), {
    ok: true,
    path: '/home/user/project',
  });
  assert.deepEqual(validateAndNormalizeRemotePath('../other/file.ts', '/home/user/project'), {
    ok: true,
    path: '/home/user/other/file.ts',
  });
  assert.deepEqual(validateAndNormalizeRemotePath('.', '/home/user/project'), {
    ok: true,
    path: '/home/user/project',
  });
  assert.deepEqual(validateAndNormalizeRemotePath('~/work/../code'), {
    ok: true,
    path: '~/code',
  });
  assert.deepEqual(validateAndNormalizeRemotePath('C:\\Users\\dev\\app'), {
    ok: true,
    path: '/C:/Users/dev/app',
  });
  // Valid POSIX filenames with leading or trailing whitespace must be preserved verbatim.
  assert.deepEqual(validateAndNormalizeRemotePath('/home/dev/report.txt '), {
    ok: true,
    path: '/home/dev/report.txt ',
  });
  assert.deepEqual(validateAndNormalizeRemotePath('/home/dev/ leading.txt'), {
    ok: true,
    path: '/home/dev/ leading.txt',
  });
  assert.deepEqual(validateAndNormalizeRemotePath('report.txt ', '/home/dev/dir '), {
    ok: true,
    path: '/home/dev/dir /report.txt ',
  });
  assert.equal(encodeRemoteSshPath('/home/dev/report.txt '), '/home/dev/report.txt%20');

  // Security rejections
  assert.equal(validateAndNormalizeRemotePath('/tmp/bad\npath').ok, false);
  assert.equal(validateAndNormalizeRemotePath('/tmp/bad\0path').ok, false);
  assert.equal(validateAndNormalizeRemotePath('/tmp/bad\x1bpath').ok, false);
  assert.equal(validateAndNormalizeRemotePath('~/../etc/passwd').ok, false);
  assert.equal(validateAndNormalizeRemotePath('relative/no-cwd').ok, false);
  assert.equal(validateAndNormalizeRemotePath('').ok, false);
});

test('encodeRemoteSshPath safely encodes special characters while preserving slashes', () => {
  assert.equal(encodeRemoteSshPath('/home/alice/my project/a#b?c.ts'), '/home/alice/my%20project/a%23b%3Fc.ts');
  assert.equal(encodeRemoteSshPath('~/my proj'), '/~/my%20proj');
  assert.equal(encodeRemoteSshPath('/C:/Users/Alice Smith/app'), '/C:/Users/Alice%20Smith/app');
});

test('buildDirectSshTarget rejects option injection and builds safe authority', () => {
  assert.equal(buildDirectSshTarget({ hostname: 'example.com', username: 'alice', port: 22 }), 'alice@example.com');
  assert.equal(buildDirectSshTarget({ hostname: 'example.com', username: 'alice', port: 2222 }), 'alice@example.com:2222');
  assert.equal(buildDirectSshTarget({ hostname: '2001:db8::1', username: 'root', port: 22 }), 'root@[2001:db8::1]');
  assert.equal(buildDirectSshTarget({ hostname: '-oProxyCommand=calc', username: 'alice', port: 22 }), null);
  assert.equal(buildDirectSshTarget({ hostname: 'host;rm -rf /', username: 'alice', port: 22 }), null);
  assert.equal(buildDirectSshTarget({ hostname: 'example.com', username: '-bad', port: 22 }), null);
});

test('buildExternalEditorLaunchSpec constructs structured argv for Zed, VS Code, Cursor, and macOS .app', () => {
  const zedWin = buildExternalEditorLaunchSpec({
    editorId: 'zed',
    executablePath: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Zed\\Zed.exe',
    sshTarget: 'prod-12345678.netcatty',
    remotePath: '/srv/my app/src/main.rs',
    kind: 'file',
    platform: 'win32',
  });
  assert.equal(zedWin.command, 'C:\\Users\\dev\\AppData\\Local\\Programs\\Zed\\Zed.exe');
  assert.deepEqual(zedWin.args, ['ssh://prod-12345678.netcatty/srv/my%20app/src/main.rs']);

  const zedMacApp = buildExternalEditorLaunchSpec({
    editorId: 'zed',
    executablePath: '/Applications/Zed.app',
    sshTarget: 'prod-12345678.netcatty',
    remotePath: '/srv/app',
    kind: 'dir',
    platform: 'darwin',
  });
  assert.equal(zedMacApp.command, 'open');
  assert.deepEqual(zedMacApp.args, ['-a', '/Applications/Zed.app', '--args', 'ssh://prod-12345678.netcatty/srv/app']);

  // Custom placeholders expand in a single literal pass without reinterpreting `$&` or `{kind}`.
  const customSpec = buildExternalEditorLaunchSpec({
    editorId: 'custom',
    executablePath: '/usr/bin/my-ed',
    customArgs: ['--remote', '{sshTarget}', '--path', '{remotePath}', '--kind', '{kind}'],
    sshTarget: 'prod-12345678.netcatty',
    remotePath: '/tmp/report$&/{kind}',
    kind: 'file',
    platform: 'linux',
  });
  assert.deepEqual(customSpec.args, [
    '--remote',
    'prod-12345678.netcatty',
    '--path',
    '/tmp/report$&/{kind}',
    '--kind',
    'file',
  ]);

  const vscodeDir = buildExternalEditorLaunchSpec({
    editorId: 'vscode',
    executablePath: '/usr/bin/code',
    sshTarget: 'prod-12345678.netcatty',
    remotePath: '/srv/app',
    kind: 'dir',
    platform: 'linux',
  });
  assert.deepEqual(vscodeDir.args, ['--folder-uri', 'vscode-remote://ssh-remote+prod-12345678.netcatty/srv/app']);

  const vscodeFile = buildExternalEditorLaunchSpec({
    editorId: 'vscode',
    executablePath: '/usr/bin/code',
    sshTarget: 'prod-12345678.netcatty',
    remotePath: '/srv/app/index.ts',
    kind: 'file',
    platform: 'linux',
  });
  assert.deepEqual(vscodeFile.args, ['--file-uri', 'vscode-remote://ssh-remote+prod-12345678.netcatty/srv/app/index.ts']);
});

test('OSC 7337 parsing accepts valid payloads and strictly rejects unknown editors or injection', () => {
  const encoded = encodeBase64UrlUtf8('/home/dev/my project/src/main.py');
  const parsed = parseExternalEditorOscPayload(`open-editor;v=1;editor=zed;kind=file;path_b64=${encoded}`);
  assert.deepEqual(parsed, {
    editorId: 'zed',
    kind: 'file',
    path: '/home/dev/my project/src/main.py',
  });

  const defaultEd = parseExternalEditorOscPayload(`open-editor;v=1;editor=default;kind=dir;path=${encodeURIComponent('/var/www')}`);
  assert.deepEqual(defaultEd, {
    kind: 'dir',
    path: '/var/www',
  });

  // Reject arbitrary command / unknown editor / unknown key / control chars / wrong version
  assert.equal(parseExternalEditorOscPayload(`open-editor;v=1;editor=powershell;kind=dir;path_b64=${encoded}`), null);
  assert.equal(parseExternalEditorOscPayload(`open-editor;v=1;editor=/bin/sh;kind=dir;path_b64=${encoded}`), null);
  assert.equal(parseExternalEditorOscPayload(`open-editor;v=1;editor=zed;cmd=calc;path_b64=${encoded}`), null);
  assert.equal(parseExternalEditorOscPayload(`open-editor;v=2;editor=zed;path_b64=${encoded}`), null);
  assert.equal(parseExternalEditorOscPayload(`open-editor;v=1;editor=zed;path_b64=${encodeBase64UrlUtf8('/tmp/\nrm -rf /')}`), null);
  assert.equal(parseExternalEditorOscPayload('other-action;v=1;path=/tmp'), null);

  // Formatting + tmux passthrough
  const plain = formatExternalEditorOscSequence({ editorId: 'zed', kind: 'dir', path: '/srv/app' });
  assert.ok(plain.startsWith(`\x1b]${EXTERNAL_EDITOR_OSC_CODE};open-editor;v=1;editor=zed;kind=dir;path_b64=`));
  assert.ok(plain.endsWith('\x07'));

  const tmux = formatExternalEditorOscSequence(
    { editorId: 'zed', kind: 'dir', path: '/srv/app' },
    { tmuxPassthrough: true },
  );
  assert.ok(tmux.startsWith('\x1bPtmux;\x1b\x1b]7337;'));
  assert.ok(tmux.endsWith('\x07\x1b\\'));
});

test('trust policy resolves per-host override then falls back to default', () => {
  const settings = normalizeExternalEditorSettings({
    defaultTrustPolicy: 'ask',
    trustedHosts: {
      [getHostKeyForExternalEditor({ hostId: 'h1' })]: 'allow',
      [getHostKeyForExternalEditor({ hostname: 'evil.example', port: 22, username: 'root' })]: 'deny',
    },
  });
  assert.equal(resolveExternalEditorTrustPolicy(settings, { hostId: 'h1', hostname: 'x' }), 'allow');
  assert.equal(resolveExternalEditorTrustPolicy(settings, { hostname: 'evil.example', port: 22, username: 'root' }), 'deny');
  assert.equal(resolveExternalEditorTrustPolicy(settings, { hostId: 'h2', hostname: 'new.example' }), 'ask');
});

test('buildExternalEditorShellSnippet produces POSIX and fish helpers with tmux passthrough', () => {
  const posix = buildExternalEditorShellSnippet('posix');
  assert.ok(posix.includes('__netcatty_open_editor()'));
  assert.ok(posix.includes('zed() { __netcatty_open_editor "zed" "$@"; }'));
  assert.ok(posix.includes('TMUX'));
  assert.ok(posix.includes('7337;open-editor'));

  const fish = buildExternalEditorShellSnippet('fish');
  assert.ok(fish.includes('function __netcatty_open_editor'));
  assert.ok(fish.includes('function zed'));
  assert.ok(fish.includes('set -q TMUX'));
});

test('POSIX shell integration snippet emits valid OSC 7337 sequences for plain shells and tmux', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX sh integration test runs on POSIX hosts');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shell-shim-'));
  const projDir = path.join(tmpDir, 'my project');
  const filePath = path.join(projDir, 'main.rs');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(filePath, 'fn main() {}\n');

  try {
    const snippet = buildExternalEditorShellSnippet('posix');

    // Directory request (`zed .`)
    const dirOut = execFileSync(
      'sh',
      ['-c', `${snippet}\ncd ${JSON.stringify(projDir)} && zed .`],
      { encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    assert.ok(dirOut.startsWith('\x1b]7337;') && dirOut.endsWith('\x07'));
    const parsedDir = parseExternalEditorOscPayload(dirOut.slice('\x1b]7337;'.length, -1));
    assert.deepEqual(parsedDir, {
      editorId: 'zed',
      kind: 'dir',
      path: fs.realpathSync(projDir),
    });

    // File request inside tmux (`TMUX=... zed ./main.rs`)
    const fileOut = execFileSync(
      'sh',
      ['-c', `${snippet}\ncd ${JSON.stringify(projDir)} && zed ./main.rs`],
      { encoding: 'utf8', env: { PATH: process.env.PATH, TMUX: '/tmp/tmux-1000/default,42,0' } },
    );
    assert.ok(fileOut.startsWith('\x1bPtmux;\x1b\x1b]7337;') && fileOut.endsWith('\x07\x1b\\'));
    // Unwrap tmux DCS passthrough just as tmux does before forwarding to xterm.js
    const unwrapped = fileOut.slice('\x1bPtmux;'.length, -2).split('\x1b\x1b').join('\x1b');
    const parsedFile = parseExternalEditorOscPayload(unwrapped.slice('\x1b]7337;'.length, -1));
    assert.deepEqual(parsedFile, {
      editorId: 'zed',
      kind: 'file',
      path: fs.realpathSync(filePath),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('shouldAutoSetupExternalEditorShell respects host override and global fallback', () => {
  const globalOff = normalizeExternalEditorSettings({ autoSetupShellIntegration: false });
  assert.equal(shouldAutoSetupExternalEditorShell(globalOff, {}), false);
  assert.equal(shouldAutoSetupExternalEditorShell(globalOff, { externalEditorShellIntegration: true }), true);

  const globalOn = normalizeExternalEditorSettings({ autoSetupShellIntegration: true });
  assert.equal(shouldAutoSetupExternalEditorShell(globalOn, {}), true);
  assert.equal(shouldAutoSetupExternalEditorShell(globalOn, { externalEditorShellIntegration: false }), false);

  const requestsOff = normalizeExternalEditorSettings({
    terminalRequestsEnabled: false,
    autoSetupShellIntegration: true,
  });
  assert.equal(shouldAutoSetupExternalEditorShell(requestsOff, { externalEditorShellIntegration: true }), false);
});

test('buildExternalEditorAutoSetupCommand installs session-scoped ~/.netcatty/bin helpers without touching ~/.bashrc', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX sh auto-setup test runs on POSIX hosts');
    return;
  }
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-auto-setup-'));
  const bashrc = path.join(fakeHome, '.bashrc');
  const originalBashrc = '# existing user bashrc\nexport FOO=bar\n';
  fs.writeFileSync(bashrc, originalBashrc);
  const projDir = path.join(fakeHome, 'work');
  fs.mkdirSync(projDir);

  try {
    const cmd = buildExternalEditorAutoSetupCommand('zed');
    const env = { PATH: process.env.PATH, HOME: fakeHome, SHELL: '/bin/bash' };

    // First run installs executable ~/.netcatty/bin/zed & ncedit, emits markers,
    // and leaves ~/.bashrc completely untouched.
    const firstOut = execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env });
    assert.ok(firstOut.includes(EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER));
    assert.ok(firstOut.includes(`${EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX}posix`));
    assert.equal(parseExternalEditorAutoSetupShell(firstOut), 'posix');

    const zedBin = path.join(fakeHome, '.netcatty', 'bin', 'zed');
    const nceditBin = path.join(fakeHome, '.netcatty', 'bin', 'ncedit');
    assert.ok(fs.existsSync(zedBin));
    assert.ok(fs.existsSync(nceditBin));
    assert.equal(fs.readFileSync(bashrc, 'utf8'), originalBashrc);

    // Second run is idempotent (no updated marker).
    const secondOut = execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env });
    assert.ok(!secondOut.includes(EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER));
    assert.equal(parseExternalEditorAutoSetupShell(secondOut), 'posix');
    assert.equal(fs.readFileSync(bashrc, 'utf8'), originalBashrc);

    // Fish login shell detection.
    const fishOut = execFileSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      env: { ...env, SHELL: '/usr/bin/fish' },
    });
    assert.equal(parseExternalEditorAutoSetupShell(fishOut), 'fish');

    // Activating the session PATH makes `zed .` emit valid OSC 7337 in that shell (and tmux).
    const activatePosix = buildExternalEditorSessionActivateCommand('posix').trim();
    const zedOut = execFileSync(
      'sh',
      ['-c', `${activatePosix} && cd ${JSON.stringify(projDir)} && zed .`],
      { encoding: 'utf8', env },
    );
    assert.ok(zedOut.startsWith('\x1b]7337;') && zedOut.endsWith('\x07'));
    const parsed = parseExternalEditorOscPayload(zedOut.slice('\x1b]7337;'.length, -1));
    assert.deepEqual(parsed, {
      editorId: 'zed',
      kind: 'dir',
      path: fs.realpathSync(projDir),
    });

    // Inside tmux with a fake $TMUX (no live tmux server), falls back to DCS passthrough cleanly.
    const tmuxOut = execFileSync(
      'sh',
      ['-c', `${activatePosix} && cd ${JSON.stringify(projDir)} && zed .`],
      { encoding: 'utf8', env: { ...env, TMUX: '/tmp/tmux-1000/nonexistent,42,0' } },
    );
    assert.ok(tmuxOut.startsWith('\x1bPtmux;\x1b\x1b]7337;') && tmuxOut.endsWith('\x07\x1b\\'));

    // Running the helper outside a Netcatty session (without NETCATTY_EXTERNAL_EDITOR) refuses safely.
    assert.throws(() => {
      execFileSync(zedBin, [projDir], { encoding: 'utf8', env });
    });

    // Legacy rc hook cleanup: if an earlier version wrote the external-editor.sh hook, it is removed cleanly.
    fs.writeFileSync(
      bashrc,
      `${originalBashrc}\n${EXTERNAL_EDITOR_SHELL_MARKER_START}\n[ -r "$HOME/.netcatty/external-editor.sh" ] && . "$HOME/.netcatty/external-editor.sh"\n${EXTERNAL_EDITOR_SHELL_MARKER_END}\n`,
    );
    execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env });
    const cleanedBashrc = fs.readFileSync(bashrc, 'utf8');
    assert.ok(cleanedBashrc.includes('export FOO=bar'));
    assert.ok(!cleanedBashrc.includes('external-editor.sh'));
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
