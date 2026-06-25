import test from 'node:test';
import assert from 'node:assert/strict';

import type { Host } from './models.ts';
import {
  applyVaultHostCreates,
  buildVaultHostFromDraft,
  buildVaultHostsFromDrafts,
  parseVaultHostDraftsInput,
} from './vaultHostCreate.ts';

test('buildVaultHostFromDraft maps minimal unstructured fields to a vault host', () => {
  const built = buildVaultHostFromDraft({
    hostname: '192.168.1.10',
    username: 'ubuntu',
    label: 'prod web',
    group: 'infra/prod',
    tags: 'web, nginx',
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.host.hostname, '192.168.1.10');
  assert.equal(built.host.username, 'ubuntu');
  assert.equal(built.host.group, 'infra/prod');
  assert.deepEqual(built.host.tags, ['web', 'nginx']);
});

test('parseVaultHostDraftsInput accepts JSON array strings', () => {
  const parsed = parseVaultHostDraftsInput(JSON.stringify([
    { hostname: '10.0.0.1', username: 'root' },
    { hostname: '10.0.0.2', username: 'deploy', port: 2222 },
  ]));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.drafts.length, 2);
});

test('applyVaultHostCreates writes sanitized hosts into the vault list', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'db',
    hostname: '10.0.0.99',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
  };
  const { hosts: built } = buildVaultHostsFromDrafts([
    { hostname: '10.0.0.10', username: 'deploy', group: 'prod' },
  ]);
  const merged = applyVaultHostCreates([existing], ['legacy'], built);

  assert.equal(merged.addedCount, 1);
  assert.equal(merged.hosts.length, 2);
  assert.ok(merged.customGroups.includes('prod'));
});
