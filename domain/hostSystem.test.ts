import assert from 'node:assert/strict';
import test from 'node:test';
import { getHostOsSelection, resolveHostOs, sanitizeHost } from './host';
import { buildAITerminalSessionInfo } from './buildAITerminalSessionInfo';
import { applyVaultHostUpdate, buildVaultHostFromDraft } from './vaultHostCreate';
import type { Host } from './models';

const host = (changes: Partial<Host> = {}): Host => ({
  id: 'host', label: 'Host', hostname: 'example.test', username: 'user', tags: [], os: 'linux', ...changes,
});

test('legacy Linux defaults are not evidence; Windows and macOS corrections survive loading', () => {
  for (const os of ['linux', 'windows', 'macos'] as const) {
    const restored = sanitizeHost(host({ os }));
    assert.equal(getHostOsSelection(restored), os === 'linux' ? 'auto' : os);
    assert.equal(resolveHostOs(restored), os === 'linux' ? 'unknown' : os);
    assert.deepEqual(sanitizeHost(restored), restored);
  }
});

test('detected facts drive AI and ignore cosmetic icon overrides', () => {
  for (const [distro, expected] of [['ubuntu','linux'],['windows','windows'],['darwin','macos'],['freebsd','freebsd'],['cisco','unknown']]) {
    const target = host({ distro, manualDistro: 'macos', distroMode: 'manual' });
    assert.equal(resolveHostOs(target), expected);
    assert.equal(buildAITerminalSessionInfo(undefined, target, 'macos').os, expected);
  }
});

test('explicit corrections survive detection and can return to automatic', () => {
  const target = host({ os: 'windows', osOverride: 'linux', distro: 'windows' });
  assert.equal(resolveHostOs(target), 'linux');
  assert.equal(resolveHostOs({ ...target, osOverride: 'auto' }), 'windows');
  assert.equal(resolveHostOs({ ...target, osOverride: 'unknown' }), 'unknown');
});

test('network device protection is independent of a chosen operating system', () => {
  const target = host({ deviceType: 'network', distro: 'ubuntu' });
  assert.equal(resolveHostOs(target), 'unknown');
  const info = buildAITerminalSessionInfo(undefined, {...target, osOverride: 'linux'}, 'macos');
  assert.equal(info.os, 'linux');
  assert.equal(info.deviceType, 'network');
});

test('local sessions report the actual local OS rather than a saved default', () => {
  assert.equal(buildAITerminalSessionInfo(undefined, host({protocol:'local'}), 'windows').os, 'windows');
});

test('vault create and update share explicit selection and auto reset', () => {
  const created = buildVaultHostFromDraft({hostname:'example.test',username:'user',os:'freebsd'});
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(resolveHostOs(created.host), 'freebsd');
  const updated = applyVaultHostUpdate([created.host], [], created.host.id, {os:'auto'});
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(resolveHostOs(updated.updatedHost), 'unknown');
});

test('manual selections retain compatible OS values for older readers', () => {
  assert.equal(sanitizeHost(host({osOverride:'windows'})).os, 'windows');
  const restored = sanitizeHost(host({os:'windows',osOverride:'auto'}));
  assert.equal(getHostOsSelection(restored), 'auto');
  assert.equal(resolveHostOs(restored), 'unknown');
});
