import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Host, VaultNote } from '../../domain/models';
import { handleVaultAgentOp, type VaultAgentApiDeps } from './vaultAgentBridgeClient';

function createDeps(overrides: Partial<VaultAgentApiDeps> = {}): VaultAgentApiDeps {
  return {
    hosts: [],
    snippets: [],
    portForwardingRules: [],
    keys: [],
    identities: [],
    resolveEffectiveHost: (host) => host,
    updateHostNotes: () => {},
    customGroups: [],
    updateCustomGroups: () => {},
    updateHosts: () => {},
    notes: [],
    updateNotes: () => {},
    startTunnel: async () => ({ success: true }),
    stopTunnel: async () => ({ success: true }),
    ...overrides,
  };
}

describe('handleVaultAgentOp vault notes', () => {
  it('note.create persists to updateNotes and returns the new note', async () => {
    const updated: VaultNote[][] = [];
    const deps = createDeps({
      notes: [],
      updateNotes: (notes) => {
        updated.push(notes);
      },
    });

    const result = await handleVaultAgentOp(
      'note.create',
      { title: 'Deploy runbook', content: '# Steps\n1. Connect' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.length, 1);
    assert.equal(updated[0]?.[0]?.title, 'Deploy runbook');
    assert.equal(updated[0]?.[0]?.content, '# Steps\n1. Connect');
    assert.equal((result as { note?: VaultNote }).note?.id, updated[0]?.[0]?.id);
  });

  it('note.list returns summaries without full content', async () => {
    const note: VaultNote = {
      id: 'note-1',
      title: 'Existing',
      content: 'secret body',
      createdAt: 1,
      updatedAt: 2,
    };
    const result = await handleVaultAgentOp('note.list', {}, createDeps({ notes: [note] }));

    assert.equal(result.ok, true);
    const notes = (result as { notes?: Array<{ id: string; contentLength: number; title: string }> }).notes;
    assert.equal(notes?.length, 1);
    assert.equal(notes?.[0]?.title, 'Existing');
    assert.equal(notes?.[0]?.contentLength, 'secret body'.length);
    assert.equal('content' in (notes?.[0] ?? {}), false);
  });

  it('note.update replaces content and bumps updatedAt', async () => {
    const existing: VaultNote = {
      id: 'note-1',
      title: 'Old title',
      content: 'old',
      createdAt: 100,
      updatedAt: 100,
    };
    const updated: VaultNote[][] = [];
    const deps = createDeps({
      notes: [existing],
      updateNotes: (notes) => {
        updated.push(notes);
      },
    });

    const result = await handleVaultAgentOp(
      'note.update',
      { noteId: 'note-1', title: 'New title', content: 'new body' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(updated[0]?.[0]?.title, 'New title');
    assert.equal(updated[0]?.[0]?.content, 'new body');
    assert.ok((updated[0]?.[0]?.updatedAt ?? 0) >= 100);
  });

  it('host.notes.set still updates host metadata separately from vault notes', async () => {
    const host: Host = {
      id: 'host-1',
      label: 'prod',
      hostname: '10.0.0.1',
      username: 'root',
      notes: '',
    };
    let hostNotes = '';
    const deps = createDeps({
      hosts: [host],
      updateHosts: undefined as never,
      updateHostNotes: (hostId, notes) => {
        assert.equal(hostId, 'host-1');
        hostNotes = notes;
      },
    });

    const result = await handleVaultAgentOp(
      'host.notes.set',
      { hostId: 'host-1', notes: 'host detail memo' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(hostNotes, 'host detail memo');
  });
});

describe('handleVaultAgentOp vault hosts', () => {
  const csvText = [
    'Label,Hostname,Port,Username,Groups',
    'web-1,10.0.0.10,22,deploy,prod/web',
    'db-1,10.0.0.20,22,root,prod/db',
  ].join('\n');

  it('host.list returns metadata without passwords', async () => {
    const host: Host = {
      id: 'host-1',
      label: 'prod',
      hostname: '10.0.0.1',
      username: 'root',
      password: 'secret',
      port: 22,
    };
    const result = await handleVaultAgentOp('host.list', {}, createDeps({ hosts: [host] }));
    assert.equal(result.ok, true);
    const hosts = (result as { hosts?: Array<Record<string, unknown>> }).hosts;
    assert.equal(hosts?.length, 1);
    assert.equal(hosts?.[0]?.hostname, '10.0.0.1');
    assert.equal('password' in (hosts?.[0] ?? {}), false);
  });

  it('hosts.create maps structured JSON from arbitrary text into vault hosts', async () => {
    const updatedHosts: Host[][] = [];
    const unstructuredMapped = JSON.stringify([
      { label: 'Prod API', hostname: 'api.example.com', username: 'deploy', port: 22, group: 'prod/api' },
      { label: 'Staging DB', hostname: '10.20.0.5', username: 'postgres', tags: ['db', 'staging'] },
    ]);

    const result = await handleVaultAgentOp(
      'hosts.create',
      { hosts: unstructuredMapped },
      createDeps({
        updateHosts: (hosts) => {
          updatedHosts.push(hosts);
        },
        updateCustomGroups: () => {},
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(updatedHosts[0]?.length, 2);
    assert.equal((result as { addedCount?: number }).addedCount, 2);
  });

  it('host.import dryRun previews parsed hosts without writing', async () => {
    const updatedHosts: Host[][] = [];
    const result = await handleVaultAgentOp(
      'host.import',
      { format: 'csv', text: csvText, dryRun: 'true' },
      createDeps({
        updateHosts: (hosts) => {
          updatedHosts.push(hosts);
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal((result as { dryRun?: boolean }).dryRun, true);
    assert.equal(updatedHosts.length, 0);
    assert.equal((result as { previewHosts?: unknown[] }).previewHosts?.length, 2);
  });

  it('host.import applies hosts to the vault', async () => {
    const updatedHosts: Host[][] = [];
    const updatedGroups: string[][] = [];
    const result = await handleVaultAgentOp(
      'host.import',
      { format: 'auto', text: csvText },
      createDeps({
        updateHosts: (hosts) => {
          updatedHosts.push(hosts);
        },
        updateCustomGroups: (groups) => {
          updatedGroups.push(groups);
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(updatedHosts[0]?.length, 2);
    assert.ok(updatedGroups[0]?.includes('prod/web'));
    assert.equal((result as { addedCount?: number }).addedCount, 2);
  });
});
