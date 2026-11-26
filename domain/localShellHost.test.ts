import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLocalShellHost,
  getLocalShellHostSubtitle,
  getVaultHostRowSubtitle,
  resolveHostDefaultLocalShell,
} from './localShellHost';

test('createLocalShellHost builds a grouped local-protocol host', () => {
  const host = createLocalShellHost({
    label: 'Project A CMD',
    shell: 'powershell',
    shellName: 'Windows PowerShell',
    shellIcon: 'powershell',
    group: 'Projects/A',
    startDir: ' /home/user/work ',
    startupCommand: 'npm run dev',
    tags: ['local', 'build'],
  });

  assert.equal(host.protocol, 'local');
  assert.equal(host.hostname, 'localhost');
  assert.equal(host.username, '');
  assert.equal(host.label, 'Project A CMD');
  assert.equal(host.group, 'Projects/A');
  assert.equal(host.localShell, 'powershell');
  assert.equal(host.localShellName, 'Windows PowerShell');
  assert.equal(host.localShellIcon, 'powershell');
  assert.equal(host.localStartDir, '/home/user/work');
  assert.equal(host.startupCommand, 'npm run dev');
  assert.deepEqual(host.tags, ['local', 'build']);
  assert.ok(host.id.startsWith('local-'));
});

test('createLocalShellHost preserves startupCommand verbatim when non-empty and clears blank input', () => {
  const withLeadingSpace = createLocalShellHost({ startupCommand: ' echo secret' });
  assert.equal(withLeadingSpace.startupCommand, ' echo secret');

  const multiLine = createLocalShellHost({ startupCommand: 'source .venv/bin/activate\npytest' });
  assert.equal(multiLine.startupCommand, 'source .venv/bin/activate\npytest');

  assert.equal(createLocalShellHost({ startupCommand: '' }).startupCommand, undefined);
  assert.equal(createLocalShellHost({ startupCommand: '   \n\t  ' }).startupCommand, undefined);
});

test('createLocalShellHost falls back to defaults for empty input', () => {
  const host = createLocalShellHost({});
  assert.equal(host.label, 'Local Shell');
  assert.equal(host.localShell, undefined);
  assert.equal(host.localShellName, undefined);
  assert.equal(host.localStartDir, undefined);
  assert.deepEqual(host.tags, ['local']);
  assert.equal(host.group, '');
  assert.equal(host.os, 'linux');
});

test('createLocalShellHost preserves explicit id when editing', () => {
  const host = createLocalShellHost({ id: 'local-existing', label: 'Renamed' });
  assert.equal(host.id, 'local-existing');
});

test('getVaultHostRowSubtitle uses shell name for local hosts', () => {
  assert.equal(
    getVaultHostRowSubtitle({ protocol: 'local', localShellName: 'CMD', username: '', hostname: 'localhost' }),
    'CMD',
  );
  assert.equal(
    getVaultHostRowSubtitle({ protocol: 'local', username: '', hostname: 'localhost' }),
    'Local Shell',
  );
  assert.equal(
    getVaultHostRowSubtitle(
      { protocol: 'local', username: '', hostname: 'localhost' },
      { localFallback: '本地终端' },
    ),
    '本地终端',
  );
});

test('getVaultHostRowSubtitle keeps user@host for remote hosts', () => {
  assert.equal(
    getVaultHostRowSubtitle({ protocol: 'ssh', username: 'root', hostname: 'example.com' }),
    'root@example.com',
  );
  assert.equal(
    getVaultHostRowSubtitle({ protocol: 'telnet', username: '', hostname: '10.0.0.1' }),
    '@10.0.0.1',
  );
});

test('getVaultHostRowSubtitle formats RDP and VNC subtitles cleanly without stray leading @', () => {
  assert.equal(
    getVaultHostRowSubtitle({
      protocol: 'rdp',
      username: 'Administrator',
      hostname: '10.0.0.5',
      port: 3389,
      rdpConfig: { domain: 'CORP' },
    }),
    'CORP\\Administrator@10.0.0.5',
  );
  assert.equal(
    getVaultHostRowSubtitle({
      protocol: 'rdp',
      username: 'alice|token-uuid',
      hostname: 'razor.example.com',
      port: 33890,
    }),
    'alice|token-uuid@razor.example.com:33890',
  );
  assert.equal(
    getVaultHostRowSubtitle({
      protocol: 'rdp',
      username: '',
      hostname: '10.0.0.5',
      port: 3389,
    }),
    '10.0.0.5',
  );
  assert.equal(
    getVaultHostRowSubtitle({
      protocol: 'vnc',
      username: '',
      hostname: '10.0.0.9',
      port: 5900,
    }),
    '10.0.0.9',
  );
  assert.equal(
    getVaultHostRowSubtitle({
      protocol: 'vnc',
      username: '',
      hostname: '10.0.0.9',
      port: 5901,
    }),
    '10.0.0.9:5901',
  );
  assert.equal(
    getVaultHostRowSubtitle({
      protocol: 'vnc',
      username: 'alice',
      hostname: 'mac-mini.local',
      port: 5900,
    }),
    'alice@mac-mini.local',
  );
});

test('getLocalShellHostSubtitle ignores whitespace-only names and allows a fallback', () => {
  assert.equal(getLocalShellHostSubtitle({ protocol: 'local', localShellName: '  ' }), 'Local Shell');
  assert.equal(
    getLocalShellHostSubtitle({ protocol: 'local', localShellName: '' }, '本地终端'),
    '本地终端',
  );
});

test('clearing the configured executable does not pass its old custom args to the backend default', () => {
  const effective = resolveHostDefaultLocalShell(createLocalShellHost({}), {
    terminalSettings: { localShell: '', localShellArgs: ['--norc'] },
    resolveShellSetting: () => null,
  });
  assert.equal(effective.localShell, '');
  assert.equal(effective.localShellArgs, undefined);
});
