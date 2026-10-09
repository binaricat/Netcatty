import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLocalShellHost,
  getLocalShellHostSubtitle,
  getVaultHostRowSubtitle,
} from './localShellHost';

test('createLocalShellHost builds a grouped local-protocol host', () => {
  const host = createLocalShellHost({
    label: 'Project A CMD',
    shell: 'powershell',
    shellName: 'Windows PowerShell',
    shellIcon: 'powershell',
    group: 'Projects/A',
    startDir: ' /home/user/work ',
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
  assert.deepEqual(host.tags, ['local', 'build']);
  assert.ok(host.id.startsWith('local-'));
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

test('getLocalShellHostSubtitle ignores whitespace-only names and allows a fallback', () => {
  assert.equal(getLocalShellHostSubtitle({ protocol: 'local', localShellName: '  ' }), 'Local Shell');
  assert.equal(
    getLocalShellHostSubtitle({ protocol: 'local', localShellName: '' }, '本地终端'),
    '本地终端',
  );
});
