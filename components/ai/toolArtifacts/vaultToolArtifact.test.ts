import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVaultToolArtifact } from './vaultToolArtifact.ts';

test('parseVaultToolArtifact maps note create results', () => {
  const artifact = parseVaultToolArtifact('vault_notes_create', {
    ok: true,
    note: { id: 'note-1', title: 'Runbook', group: 'ops/prod' },
  });
  assert.deepEqual(artifact, {
    kind: 'vault.note',
    noteId: 'note-1',
    title: 'Runbook',
    group: 'ops/prod',
  });
});

test('parseVaultToolArtifact maps single host create to host artifact', () => {
  const artifact = parseVaultToolArtifact('vault_hosts_create', {
    ok: true,
    addedCount: 1,
    previewHosts: [
      { id: 'host-1', label: 'Dokploy', hostname: '10.2.0.209' },
    ],
  });
  assert.deepEqual(artifact, {
    kind: 'vault.host',
    hostId: 'host-1',
    label: 'Dokploy',
    hostname: '10.2.0.209',
  });
});

test('parseVaultToolArtifact maps host batch import results', () => {
  const artifact = parseVaultToolArtifact('vault_hosts_create', {
    ok: true,
    addedCount: 2,
    previewHosts: [
      { id: 'host-1', label: 'Web', hostname: '10.0.0.1' },
      { id: 'host-2', hostname: 'db.internal' },
    ],
  });
  assert.equal(artifact?.kind, 'vault.hosts.batch');
  if (artifact?.kind !== 'vault.hosts.batch') return;
  assert.equal(artifact.addedCount, 2);
  assert.equal(artifact.preview.length, 2);
});

test('parseVaultToolArtifact maps host get results', () => {
  const artifact = parseVaultToolArtifact('host_get', {
    ok: true,
    host: { id: 'host-9', label: 'Prod', hostname: 'prod.example.com', port: 22 },
  });
  assert.deepEqual(artifact, {
    kind: 'vault.host',
    hostId: 'host-9',
    label: 'Prod',
    hostname: 'prod.example.com',
    port: 22,
    group: undefined,
  });
});

test('parseVaultToolArtifact maps errors', () => {
  const artifact = parseVaultToolArtifact('vault_notes_get', {
    ok: false,
    error: 'Vault note "missing" was not found.',
  });
  assert.deepEqual(artifact, {
    kind: 'error',
    message: 'Vault note "missing" was not found.',
  });
});

test('parseVaultToolArtifact maps script create results', () => {
  const artifact = parseVaultToolArtifact('scripts_create', {
    ok: true,
    script: {
      id: 'script-1',
      label: 'Disk cleanup',
      language: 'javascript',
      package: 'maintenance',
    },
  });
  assert.deepEqual(artifact, {
    kind: 'vault.script',
    scriptId: 'script-1',
    label: 'Disk cleanup',
    package: 'maintenance',
    language: 'javascript',
  });
});

test('parseVaultToolArtifact maps snippet list results', () => {
  const artifact = parseVaultToolArtifact('snippets_list', {
    ok: true,
    snippets: [{ id: 's1', label: 'Restart nginx' }],
  });
  assert.deepEqual(artifact, {
    kind: 'vault.summary',
    section: 'snippets',
    count: 1,
  });
});

test('parseVaultToolArtifact maps script run results', () => {
  const artifact = parseVaultToolArtifact('scripts_run', {
    ok: true,
    snippetId: 'script-1',
    runId: 'run-9',
    kind: 'script',
  });
  assert.deepEqual(artifact, {
    kind: 'vault.script.run',
    scriptId: 'script-1',
    runId: 'run-9',
    status: undefined,
  });
});

test('parseVaultToolArtifact unwraps Claude MCP text result envelopes', () => {
  const artifact = parseVaultToolArtifact('mcp__netcatty-remote-hosts__vault_notes_list', JSON.stringify([
    {
      type: 'text',
      text: JSON.stringify({
        ok: true,
        notes: [
          { id: 'note-1', title: 'Docker Compose' },
          { id: 'note-2', title: 'Dokploy' },
        ],
      }),
    },
  ]));

  assert.deepEqual(artifact, {
    kind: 'vault.summary',
    section: 'notes',
    count: 2,
  });
});
