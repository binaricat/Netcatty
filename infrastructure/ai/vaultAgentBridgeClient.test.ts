import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Host, Snippet, VaultNote } from '../../domain/models';
import { handleVaultAgentOp, runSerializedVaultAgentRequest, type VaultAgentApiDeps } from './vaultAgentBridgeClient';

type DepsSeed = {
  hosts?: Host[];
  notes?: VaultNote[];
  snippets?: Snippet[];
  customGroups?: string[];
};

function createDeps(
  overrides: Partial<VaultAgentApiDeps> & DepsSeed = {},
): VaultAgentApiDeps {
  let hosts = overrides.hosts ?? [];
  let notes = overrides.notes ?? [];
  let snippets = overrides.snippets ?? [];
  let customGroups = overrides.customGroups ?? [];

  const base: VaultAgentApiDeps = {
    getHosts: () => hosts,
    getNotes: () => notes,
    getCustomGroups: () => customGroups,
    snippets,
    portForwardingRules: [],
    keys: [],
    identities: [],
    resolveEffectiveHost: (host) => host,
    updateHostNotes: () => {},
    updateCustomGroups: (groups) => {
      customGroups = groups;
    },
    updateHosts: (nextHosts) => {
      hosts = nextHosts;
    },
    updateNotes: (nextNotes) => {
      notes = nextNotes;
    },
    updateSnippets: (nextSnippets) => {
      snippets = nextSnippets;
    },
    startTunnel: async () => ({ success: true }),
    stopTunnel: async () => ({ success: true }),
  };

  return {
    ...base,
    ...overrides,
    get snippets() {
      return snippets;
    },
    getHosts: overrides.getHosts ?? base.getHosts,
    getNotes: overrides.getNotes ?? base.getNotes,
    getCustomGroups: overrides.getCustomGroups ?? base.getCustomGroups,
    updateHosts: (nextHosts) => {
      base.updateHosts(nextHosts);
      overrides.updateHosts?.(nextHosts);
    },
    updateNotes: (nextNotes) => {
      base.updateNotes(nextNotes);
      overrides.updateNotes?.(nextNotes);
    },
    updateSnippets: (nextSnippets) => {
      base.updateSnippets(nextSnippets);
      overrides.updateSnippets?.(nextSnippets);
    },
    updateCustomGroups: (groups) => {
      base.updateCustomGroups(groups);
      overrides.updateCustomGroups?.(groups);
    },
  };
}

describe('handleVaultAgentOp vault notes', () => {
  it('note.create persists to updateNotes and returns the new note', async () => {
    const updated: VaultNote[][] = [];
    const deps = createDeps({
      notes: [],
      updateNotes: (nextNotes) => {
        updated.push(nextNotes);
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
    const listed = (result as { notes?: Array<{ id: string; contentLength: number; title: string }> }).notes;
    assert.equal(listed?.length, 1);
    assert.equal(listed?.[0]?.title, 'Existing');
    assert.equal(listed?.[0]?.contentLength, 'secret body'.length);
    assert.equal('content' in (listed?.[0] ?? {}), false);
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
      updateNotes: (nextNotes) => {
        updated.push(nextNotes);
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

  it('sequential note.create calls accumulate instead of overwriting prior notes', async () => {
    const deps = createDeps({ notes: [] });

    const first = await handleVaultAgentOp(
      'note.create',
      { title: 'First', content: 'one' },
      deps,
    );
    const second = await handleVaultAgentOp(
      'note.create',
      { title: 'Second', content: 'two' },
      deps,
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(deps.getNotes().length, 2);
    assert.deepEqual(deps.getNotes().map((note) => note.title), ['First', 'Second']);
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

  it('sequential hosts.create calls accumulate instead of dropping prior hosts', async () => {
    const deps = createDeps({ hosts: [], customGroups: [] });

    const first = await handleVaultAgentOp(
      'hosts.create',
      { hosts: JSON.stringify([{ hostname: '10.0.0.1', username: 'root', label: 'first' }]) },
      deps,
    );
    const second = await handleVaultAgentOp(
      'hosts.create',
      { hosts: JSON.stringify([{ hostname: '10.0.0.2', username: 'root', label: 'second' }]) },
      deps,
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(deps.getHosts().length, 2);
    assert.deepEqual(deps.getHosts().map((host) => host.hostname), ['10.0.0.1', '10.0.0.2']);
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

describe('handleVaultAgentOp snippets and scripts', () => {
  it('snippets.create persists script metadata via updateSnippets', async () => {
    const updated: Snippet[][] = [];
    const deps = createDeps({
      snippets: [],
      updateSnippets: (nextSnippets) => {
        updated.push(nextSnippets);
      },
    });

    const result = await handleVaultAgentOp(
      'snippets.create',
      {
        label: 'Deploy',
        content: 'await nct.screen.sendLine("echo ok");',
        kind: 'script',
        trigger: 'manual',
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.[0]?.kind, 'script');
    assert.equal(updated[0]?.[0]?.label, 'Deploy');
  });

  it('snippets.list returns kind and trigger fields', async () => {
    const deps = createDeps({
      snippets: [{
        id: 's1',
        label: 'Auto',
        command: 'nct.log(1)',
        kind: 'script',
        trigger: 'onConnect',
        targetsAllHosts: true,
      }],
    });

    const result = await handleVaultAgentOp('snippets.list', {}, deps);
    assert.equal(result.ok, true);
    const listed = (result as { snippets?: Array<{ kind?: string; trigger?: string; targetsAllHosts?: boolean }> }).snippets;
    assert.equal(listed?.[0]?.kind, 'script');
    assert.equal(listed?.[0]?.trigger, 'onConnect');
    assert.equal(listed?.[0]?.targetsAllHosts, true);
  });

  it('scripts.reference returns nct syntax reference', async () => {
    const result = await handleVaultAgentOp('scripts.reference', {}, createDeps());
    assert.equal(result.ok, true);
    const reference = (result as { reference?: string }).reference ?? '';
    assert.match(reference, /nct\.screen\.waitForPrompt/);
  });

  it('host.connectScripts.set updates host queue', async () => {
    const host: Host = {
      id: 'host-a',
      label: 'A',
      hostname: 'a.example',
      username: 'root',
      os: 'linux',
      protocol: 'ssh',
      tags: [],
    };
    const snippets: Snippet[] = [{
      id: 'run',
      label: 'Run',
      command: 'nct.log(1)',
      kind: 'script',
      trigger: 'onConnect',
      targets: ['host-a'],
    }];
    const deps = createDeps({ hosts: [host], snippets });

    const result = await handleVaultAgentOp(
      'host.connectScripts.set',
      { hostId: 'host-a', scriptIds: JSON.stringify(['run']) },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(deps.getHosts()[0]?.connectScriptIds, ['run']);
  });

  it('scripts.delete removes script from vault', async () => {
    const snippets: Snippet[] = [{
      id: 'run',
      label: 'Run',
      command: 'nct.log(1)',
      kind: 'script',
    }];
    const updated: Snippet[][] = [];
    const deps = createDeps({
      snippets,
      updateSnippets: (next) => {
        updated.push(next);
      },
    });

    const result = await handleVaultAgentOp('scripts.delete', { scriptId: 'run' }, deps);
    assert.equal(result.ok, true);
    assert.equal(updated[0]?.length, 0);
  });

  it('scripts.delete rejects text snippets', async () => {
    const deps = createDeps({
      snippets: [{ id: 'cmd', label: 'Cmd', command: 'ls', kind: 'snippet' }],
    });
    const result = await handleVaultAgentOp('scripts.delete', { scriptId: 'cmd' }, deps);
    assert.equal(result.ok, false);
  });
});

describe('runSerializedVaultAgentRequest', () => {
  it('runs concurrent tasks sequentially without losing updates', async () => {
    let value = 0;
    const results = await Promise.all([
      runSerializedVaultAgentRequest(async () => {
        const snapshot = value;
        await new Promise((resolve) => setTimeout(resolve, 5));
        value = snapshot + 1;
        return value;
      }),
      runSerializedVaultAgentRequest(async () => {
        const snapshot = value;
        await new Promise((resolve) => setTimeout(resolve, 1));
        value = snapshot + 1;
        return value;
      }),
    ]);

    assert.deepEqual(results, [1, 2]);
    assert.equal(value, 2);
  });
});
