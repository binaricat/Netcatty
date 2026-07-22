import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GroupConfig, Host, ManagedSource, PortForwardingRule, ProxyProfile, Snippet, VaultNote } from '../../domain/models';
import { handleVaultAgentOp, runSerializedVaultAgentRequest, type VaultAgentApiDeps } from './vaultAgentBridgeClient';

type DepsSeed = {
  hosts?: Host[];
  notes?: VaultNote[];
  snippets?: Snippet[];
  customGroups?: string[];
  groupConfigs?: GroupConfig[];
  portForwardingRules?: PortForwardingRule[];
  proxyProfiles?: ProxyProfile[];
  managedSources?: ManagedSource[];
};

function createDeps(
  overrides: Partial<VaultAgentApiDeps> & DepsSeed = {},
): VaultAgentApiDeps {
  let hosts = overrides.hosts ?? [];
  let notes = overrides.notes ?? [];
  let snippets = overrides.snippets ?? [];
  let customGroups = overrides.customGroups ?? [];
  let groupConfigs = overrides.groupConfigs ?? [];
  let portForwardingRules = overrides.portForwardingRules ?? [];
  let managedSources = overrides.managedSources ?? [];

  const base: VaultAgentApiDeps = {
    getHosts: () => hosts,
    getNotes: () => notes,
    getCustomGroups: () => customGroups,
    snippets,
    getGroupConfigs: () => groupConfigs,
    getPortForwardingRules: () => portForwardingRules,
    getManagedSources: () => managedSources,
    proxyProfiles: overrides.proxyProfiles ?? [],
    keys: [],
    identities: [],
    knownHosts: [],
    resolveEffectiveHost: (host) => host,
    updateHostNotes: () => {},
    updateCustomGroups: (groups) => {
      customGroups = groups;
    },
    updateGroupConfigs: (configs) => {
      groupConfigs = configs;
    },
    updatePortForwardingRules: (rules) => {
      portForwardingRules = rules;
    },
    updateManagedSources: (sources) => {
      managedSources = sources;
    },
    updateHosts: (nextHosts) => {
      hosts = nextHosts;
    },
    saveKeyPassphrase: async () => {},
    resolveKeyPassphraseAliases: async (keyPath) => [keyPath],
    readKeyPassphrases: async () => ({ values: [], unreadable: false }),
    removeKeyPassphrases: () => {},
    updateNotes: (nextNotes) => {
      notes = nextNotes;
    },
    updateSnippets: (nextSnippets) => {
      snippets = nextSnippets;
    },
    startTunnel: async () => ({ success: true }),
    stopTunnel: async () => ({ success: true }),
    stopRuleTunnels: async () => ({ success: true }),
    openHost: (host) => {
      return { ok: true, sessionId: `session-${host.id}`, host };
    },
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
    updateGroupConfigs: (configs) => {
      base.updateGroupConfigs(configs);
      overrides.updateGroupConfigs?.(configs);
    },
    updatePortForwardingRules: (rules) => {
      base.updatePortForwardingRules(rules);
      overrides.updatePortForwardingRules?.(rules);
    },
    updateManagedSources: (sources) => {
      base.updateManagedSources(sources);
      overrides.updateManagedSources?.(sources);
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

  it('note.delete removes the selected vault note', async () => {
    const deps = createDeps({
      notes: [
        { id: 'note-1', title: 'One', content: 'a', createdAt: 1, updatedAt: 1 },
        { id: 'note-2', title: 'Two', content: 'b', createdAt: 2, updatedAt: 2 },
      ],
    });

    const result = await handleVaultAgentOp('note.delete', { noteId: 'note-1' }, deps);

    assert.equal(result.ok, true);
    assert.deepEqual(deps.getNotes().map((note) => note.id), ['note-2']);
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

  it('host.open creates a terminal session for a vault host', async () => {
    const host: Host = {
      id: 'host-open-1',
      label: 'edge',
      hostname: 'edge.example.com',
      username: 'ops',
      port: 22,
    };
    const result = await handleVaultAgentOp(
      'host.open',
      { hostId: 'host-open-1', chatSessionId: 'chat-1' },
      createDeps({ hosts: [host] }),
    );
    assert.equal(result.ok, true);
    assert.equal((result as { sessionId?: string }).sessionId, 'session-host-open-1');
    assert.equal((result as { hostId?: string }).hostId, 'host-open-1');
    assert.equal((result as { status?: string }).status, 'connecting');
    assert.equal((result as { host?: { hostname?: string } }).host?.hostname, 'edge.example.com');
  });

  it('host.open marks in-app chat opens (with chatSessionId) as not an external MCP call', async () => {
    const host: Host = {
      id: 'host-open-2',
      label: 'edge',
      hostname: 'edge.example.com',
      username: 'ops',
      port: 22,
    };
    let receivedIsExternalMcpCall: boolean | undefined;
    const deps = createDeps({
      hosts: [host],
      openHost: (hostToOpen, isExternalMcpCall) => {
        receivedIsExternalMcpCall = isExternalMcpCall;
        return { ok: true, sessionId: `session-${hostToOpen.id}`, host: hostToOpen };
      },
    });

    await handleVaultAgentOp('host.open', { hostId: 'host-open-2', chatSessionId: 'chat-1' }, deps);

    assert.equal(receivedIsExternalMcpCall, false);
  });

  it('host.open marks calls under the reserved external-MCP scope as an external MCP call', async () => {
    // The TCP bridge forces every authenticated external-MCP socket's
    // chatSessionId to '__external_mcp__' (electron/bridges/mcpServerBridge.cjs),
    // so that reserved value — not a missing chatSessionId — is what identifies
    // a real external MCP client.
    const host: Host = {
      id: 'host-open-3',
      label: 'edge',
      hostname: 'edge.example.com',
      username: 'ops',
      port: 22,
    };
    let receivedIsExternalMcpCall: boolean | undefined;
    const deps = createDeps({
      hosts: [host],
      openHost: (hostToOpen, isExternalMcpCall) => {
        receivedIsExternalMcpCall = isExternalMcpCall;
        return { ok: true, sessionId: `session-${hostToOpen.id}`, host: hostToOpen };
      },
    });

    await handleVaultAgentOp('host.open', { hostId: 'host-open-3', chatSessionId: '__external_mcp__' }, deps);

    assert.equal(receivedIsExternalMcpCall, true);
  });

  it('host.open does not treat a missing chatSessionId as an external MCP call', async () => {
    const host: Host = {
      id: 'host-open-4',
      label: 'edge',
      hostname: 'edge.example.com',
      username: 'ops',
      port: 22,
    };
    let receivedIsExternalMcpCall: boolean | undefined;
    const deps = createDeps({
      hosts: [host],
      openHost: (hostToOpen, isExternalMcpCall) => {
        receivedIsExternalMcpCall = isExternalMcpCall;
        return { ok: true, sessionId: `session-${hostToOpen.id}`, host: hostToOpen };
      },
    });

    await handleVaultAgentOp('host.open', { hostId: 'host-open-4' }, deps);

    assert.equal(receivedIsExternalMcpCall, false);
  });

  it('session.close closes the matching terminal session', async () => {
    const closed: string[] = [];
    const result = await handleVaultAgentOp(
      'session.close',
      { sessionId: 'session-host-open-1' },
      createDeps({
        closeSession: (sessionId) => {
          closed.push(sessionId);
          return { ok: true };
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal((result as { status?: string }).status, 'closed');
    assert.deepEqual(closed, ['session-host-open-1']);
  });

  it('session.close reports unavailable sessions without claiming success', async () => {
    const result = await handleVaultAgentOp(
      'session.close',
      { sessionId: 'missing' },
      createDeps({
        closeSession: () => ({ ok: false, error: 'Session "missing" was not found.' }),
      }),
    );

    assert.equal(result.ok, false);
    assert.match(String((result as { error?: string }).error), /not found/i);
  });

  it('opens a host created by the immediately preceding request', async () => {
    let openedHost: Host | undefined;
    const deps = createDeps({
      openHost: (hostToOpen: Host) => {
        openedHost = hostToOpen;
        return { ok: true, sessionId: `session-${hostToOpen.id}`, host: hostToOpen };
      },
    });
    const created = await handleVaultAgentOp('hosts.create', {
      hosts: JSON.stringify([{
        label: 'New host', hostname: 'new.example.com', username: 'deploy',
      }]),
    }, deps);
    const hostId = (created as { previewHosts?: Array<{ id?: string }> }).previewHosts?.[0]?.id ?? '';

    const opened = await handleVaultAgentOp('host.open', { hostId }, deps);

    assert.equal(opened.ok, true);
    assert.equal(openedHost?.id, hostId);
    assert.equal(openedHost?.hostname, 'new.example.com');
  });

  it('opens a host with group defaults changed by the immediately preceding request', async () => {
    const groupedHost: Host = {
      id: 'grouped-host', label: 'Grouped', hostname: 'grouped.example.com',
      username: 'root', group: 'production', tags: [], os: 'linux',
    };
    let openedHost: Host | undefined;
    let deps: VaultAgentApiDeps;
    deps = createDeps({
      hosts: [groupedHost],
      customGroups: ['production'],
      groupConfigs: [{ path: 'production', username: 'old-user' }],
      resolveEffectiveHost: (hostToResolve) => ({
        ...hostToResolve,
        username: deps.getGroupConfigs().find((config) => config.path === hostToResolve.group)?.username
          ?? hostToResolve.username,
      }),
      openHost: (hostToOpen) => {
        openedHost = hostToOpen;
        return { ok: true, sessionId: `session-${hostToOpen.id}`, host: hostToOpen };
      },
    });

    assert.equal((await handleVaultAgentOp('group.update', {
      path: 'production',
      defaults: '{"username":"new-user"}',
    }, deps)).ok, true);
    assert.equal((await handleVaultAgentOp('host.open', { hostId: groupedHost.id }, deps)).ok, true);

    assert.equal(openedHost?.username, 'new-user');
  });

  it('host.open fails for missing host ids', async () => {
    const result = await handleVaultAgentOp(
      'host.open',
      { hostId: 'missing' },
      createDeps({ hosts: [] }),
    );
    assert.equal(result.ok, false);
    assert.match(String((result as { error?: string }).error), /not found/i);
  });

  it('host.open requires hostId', async () => {
    const result = await handleVaultAgentOp('host.open', {}, createDeps({ hosts: [] }));
    assert.equal(result.ok, false);
    assert.match(String((result as { error?: string }).error), /hostId/i);
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

  it('hosts.create stores a referenced key path without private key content', async () => {
    const deps = createDeps({ hosts: [] });
    const result = await handleVaultAgentOp(
      'hosts.create',
      {
        hosts: JSON.stringify([
          { hostname: 'key.example.com', username: 'deploy', keyPath: '~/.ssh/id_ed25519' },
        ]),
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(deps.getHosts()[0]?.identityFilePaths, ['~/.ssh/id_ed25519']);
    assert.equal(deps.getHosts()[0]?.authMethod, 'key');
    const preview = (result as { previewHosts?: Array<Record<string, unknown>> }).previewHosts?.[0];
    assert.equal('privateKey' in (preview ?? {}), false);
  });

  it('hosts.create saves a referenced key passphrase without returning it', async () => {
    const savedPassphrases: Array<{ keyPath: string; passphrase: string }> = [];
    const deps = createDeps({ hosts: [] });
    Object.assign(deps, {
      saveKeyPassphrase: async (keyPath: string, passphrase: string) => {
        savedPassphrases.push({ keyPath, passphrase });
      },
    });

    const result = await handleVaultAgentOp(
      'hosts.create',
      {
        hosts: JSON.stringify([
          {
            hostname: 'encrypted-key.example.com',
            username: 'deploy',
            keyPath: '~/.ssh/id_encrypted',
            passphrase: 'correct horse battery staple',
          },
        ]),
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(savedPassphrases, [{
      keyPath: '~/.ssh/id_encrypted',
      passphrase: 'correct horse battery staple',
    }]);
    assert.equal('passphrase' in (deps.getHosts()[0] ?? {}), false);
    const preview = (result as { previewHosts?: Array<Record<string, unknown>> }).previewHosts?.[0];
    assert.equal('passphrase' in (preview ?? {}), false);
  });

  it('hosts.create dry run never saves a referenced key passphrase', async () => {
    const savedPassphrases: string[] = [];
    const deps = createDeps({
      hosts: [],
      saveKeyPassphrase: async (_keyPath, passphrase) => {
        savedPassphrases.push(passphrase);
      },
    });

    const result = await handleVaultAgentOp(
      'hosts.create',
      {
        dryRun: true,
        hosts: JSON.stringify([{
          hostname: 'encrypted-key.example.com',
          keyPath: '~/.ssh/id_encrypted',
          passphrase: 'must not be saved',
        }]),
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal((result as { dryRun?: boolean }).dryRun, true);
    assert.deepEqual(savedPassphrases, []);
    assert.equal(deps.getHosts().length, 0);
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

  it('host.update changes selected fields and preserves unrelated host data', async () => {
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'old',
        hostname: '10.0.0.1',
        username: 'root',
        port: 22,
        tags: ['keep'],
        os: 'linux',
      }],
      customGroups: [],
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', name: 'new', ip: '10.0.0.2', group: 'prod' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(deps.getHosts()[0]?.label, 'new');
    assert.equal(deps.getHosts()[0]?.hostname, '10.0.0.2');
    assert.equal(deps.getHosts()[0]?.username, 'root');
    assert.deepEqual(deps.getHosts()[0]?.tags, ['keep']);
    assert.ok(deps.getCustomGroups().includes('prod'));
  });

  it('host.update saves a passphrase for the host key path without returning it', async () => {
    const savedPassphrases: Array<{ keyPath: string; passphrase: string }> = [];
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'encrypted key',
        hostname: 'key.example.com',
        username: 'deploy',
        port: 22,
        tags: [],
        os: 'linux',
        identityFilePaths: ['~/.ssh/id_encrypted'],
        authMethod: 'key',
      }],
      saveKeyPassphrase: async (keyPath, passphrase) => {
        savedPassphrases.push({ keyPath, passphrase });
      },
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', passphrase: 'updated secret' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(savedPassphrases, [{
      keyPath: '~/.ssh/id_encrypted',
      passphrase: 'updated secret',
    }]);
    assert.equal('passphrase' in ((result as { host?: Record<string, unknown> }).host ?? {}), false);
  });

  it('host.update clears a saved passphrase for the host key path', async () => {
    const removedKeyPaths: string[][] = [];
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'encrypted key',
        hostname: 'key.example.com',
        username: 'deploy',
        port: 22,
        tags: [],
        os: 'linux',
        identityFilePaths: ['~/.ssh/id_encrypted'],
        authMethod: 'key',
      }],
      removeKeyPassphrases: (keyPaths) => {
        removedKeyPaths.push(keyPaths);
      },
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', passphrase: '' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(removedKeyPaths, [['~/.ssh/id_encrypted']]);
  });

  it('host.update can clear the key path and its saved passphrase together', async () => {
    const removedKeyPaths: string[][] = [];
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'encrypted key',
        hostname: 'key.example.com',
        username: 'deploy',
        port: 22,
        tags: [],
        os: 'linux',
        identityFilePaths: ['~/.ssh/id_encrypted'],
        authMethod: 'key',
      }],
      removeKeyPassphrases: (keyPaths) => {
        removedKeyPaths.push(keyPaths);
      },
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', keyPath: '', passphrase: '' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(removedKeyPaths, [['~/.ssh/id_encrypted']]);
    assert.deepEqual(deps.getHosts()[0]?.identityFilePaths, []);
  });

  it('host.update clears the removed local key passphrase without touching a shared identity key', async () => {
    const removedKeyPaths: string[][] = [];
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'identity with old local key',
        hostname: 'key.example.com',
        username: 'deploy',
        port: 22,
        tags: [],
        os: 'linux',
        identityId: 'identity-1',
        identityFilePaths: ['~/.ssh/id_old_local'],
        authMethod: 'key',
      }],
      keys: [{
        id: 'shared-key',
        label: 'shared key',
        type: 'ED25519',
        category: 'key',
        source: 'reference',
        filePath: '~/.ssh/id_shared',
        privateKey: '',
        created: 1,
      }],
      identities: [{
        id: 'identity-1',
        label: 'shared identity',
        username: 'deploy',
        authMethod: 'key',
        keyId: 'shared-key',
        created: 1,
      }],
      removeKeyPassphrases: (keyPaths) => {
        removedKeyPaths.push(keyPaths);
      },
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', keyPath: '', passphrase: '' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(removedKeyPaths, [['~/.ssh/id_old_local']]);
    assert.deepEqual(deps.getHosts()[0]?.identityFilePaths, []);
    assert.equal(deps.getHosts()[0]?.identityId, 'identity-1');
  });

  it('host.update treats a whitespace-only key path as clearing the old local key', async () => {
    const removedKeyPaths: string[][] = [];
    const deps = createDeps({
      hosts: [{
        id: 'host-1', label: 'host', hostname: 'key.example.com', username: 'deploy',
        tags: [], os: 'linux', identityFilePaths: ['~/.ssh/id_old'], authMethod: 'key',
      }],
      removeKeyPassphrases: (keyPaths) => removedKeyPaths.push(keyPaths),
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', keyPath: '   ', passphrase: '' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(removedKeyPaths, [['~/.ssh/id_old']]);
    assert.deepEqual(deps.getHosts()[0]?.identityFilePaths, []);
  });

  it('host.update gives keyPath priority over an empty keypath alias', async () => {
    const removedKeyPaths: string[][] = [];
    const deps = createDeps({
      hosts: [{
        id: 'host-1', label: 'host', hostname: 'key.example.com', username: 'deploy',
        tags: [], os: 'linux', identityFilePaths: ['~/.ssh/id_old'], authMethod: 'key',
      }],
      removeKeyPassphrases: (keyPaths) => removedKeyPaths.push(keyPaths),
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', keyPath: '~/.ssh/id_new', keypath: '', passphrase: '' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(removedKeyPaths, [['~/.ssh/id_new']]);
    assert.deepEqual(deps.getHosts()[0]?.identityFilePaths, ['~/.ssh/id_new']);
  });

  it('host.update uses a newly selected key path for the saved passphrase', async () => {
    const savedKeyPaths: string[] = [];
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'encrypted key',
        hostname: 'key.example.com',
        username: 'deploy',
        port: 22,
        tags: [],
        os: 'linux',
        identityFilePaths: ['~/.ssh/id_old'],
        authMethod: 'key',
      }],
      saveKeyPassphrase: async (keyPath) => {
        savedKeyPaths.push(keyPath);
      },
    });

    const result = await handleVaultAgentOp(
      'host.update',
      {
        hostId: 'host-1',
        keyPath: '~/.ssh/id_new',
        passphrase: 'new secret',
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(savedKeyPaths, ['~/.ssh/id_new']);
    assert.deepEqual(deps.getHosts()[0]?.identityFilePaths, ['~/.ssh/id_new']);
  });

  it('host.update rejects a passphrase without a key path before changing the host', async () => {
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'original',
        hostname: 'password.example.com',
        username: 'deploy',
        port: 22,
        tags: [],
        os: 'linux',
      }],
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', label: 'must not change', passphrase: 'orphan secret' },
      deps,
    );

    assert.equal(result.ok, false);
    assert.match(String((result as { error?: string }).error), /keyPath/i);
    assert.equal(deps.getHosts()[0]?.label, 'original');
  });

  it('host.update applies effective inherited credential settings', async () => {
    const host: Host = {
      id: 'host-1',
      label: 'inherited',
      hostname: '10.0.0.1',
      username: 'root',
      port: 22,
      tags: [],
      os: 'linux',
    };
    const passwordDeps = createDeps({
      hosts: [host],
      resolveEffectiveHost: (current) => ({ ...current, savePassword: false }),
    });
    const identityDeps = createDeps({
      hosts: [host],
      resolveEffectiveHost: (current) => ({ ...current, identityId: 'identity-from-group' }),
    });

    const passwordResult = await handleVaultAgentOp(
      'host.update',
      { hostId: host.id, password: 'do-not-persist' },
      passwordDeps,
    );
    const usernameResult = await handleVaultAgentOp(
      'host.update',
      { hostId: host.id, username: 'deploy' },
      identityDeps,
    );

    assert.equal(passwordResult.ok, false);
    assert.equal(passwordDeps.getHosts()[0]?.password, undefined);
    assert.equal(usernameResult.ok, true);
    assert.equal(identityDeps.getHosts()[0]?.username, 'deploy');
    assert.equal(identityDeps.getHosts()[0]?.identityId, '');
  });

  it('host.update aligns managed-source ownership when moving groups', async () => {
    const deps = createDeps({
      hosts: [{
        id: 'host-1',
        label: 'managed host',
        hostname: '10.0.0.1',
        username: 'root',
        group: 'managed',
        tags: [],
        os: 'linux',
        managedSourceId: 'source-1',
      }],
      managedSources: [{
        id: 'source-1',
        type: 'ssh_config',
        filePath: '~/.ssh/config',
        groupName: 'managed',
        lastSyncedAt: 1,
      }],
    });

    const result = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', group: '' },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(deps.getHosts()[0]?.group, undefined);
    assert.equal(deps.getHosts()[0]?.managedSourceId, undefined);
  });

  it('host.delete removes the requested host', async () => {
    const deps = createDeps({
      hosts: [
        { id: 'host-1', label: 'one', hostname: 'one', username: 'root', tags: [], os: 'linux' },
        { id: 'host-2', label: 'two', hostname: 'two', username: 'root', tags: [], os: 'linux' },
      ],
    });

    const result = await handleVaultAgentOp('host.delete', { hostId: 'host-1' }, deps);

    assert.equal(result.ok, true);
    assert.deepEqual(deps.getHosts().map((host) => host.id), ['host-2']);
    assert.equal((result as { deletedHost?: { id?: string } }).deletedHost?.id, 'host-1');
  });

  it('host.delete keeps jump hosts referenced by empty group defaults', async () => {
    const jump: Host = {
      id: 'jump', label: 'jump', hostname: 'jump.example.com', username: 'root',
      protocol: 'ssh', tags: [], os: 'linux',
    };
    const deps = createDeps({
      hosts: [jump],
      groupConfigs: [{ path: 'prod', hostChain: { hostIds: [jump.id] } }],
    });

    const result = await handleVaultAgentOp('host.delete', { hostId: jump.id }, deps);

    assert.equal(result.ok, false);
    assert.deepEqual(deps.getHosts().map((current) => current.id), [jump.id]);
  });

  it('host.update and host.delete never return nested proxy passwords', async () => {
    const host: Host = {
      id: 'host-1',
      label: 'proxied',
      hostname: '10.0.0.1',
      username: 'root',
      tags: [],
      os: 'linux',
      proxyConfig: {
        type: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'proxy-user',
        password: 'proxy-secret',
      },
    };
    const updateDeps = createDeps({ hosts: [host] });
    const deleteDeps = createDeps({ hosts: [host] });

    const updateResult = await handleVaultAgentOp(
      'host.update',
      { hostId: host.id, notes: 'updated' },
      updateDeps,
    );
    const deleteResult = await handleVaultAgentOp(
      'host.delete',
      { hostId: host.id },
      deleteDeps,
    );

    assert.equal(updateResult.ok, true);
    assert.equal(deleteResult.ok, true);
    const updatedProxy = (updateResult as {
      host?: { proxyConfig?: Record<string, unknown> };
    }).host?.proxyConfig;
    const deletedProxy = (deleteResult as {
      deletedHost?: { proxyConfig?: Record<string, unknown> };
    }).deletedHost?.proxyConfig;
    assert.equal(updatedProxy?.host, 'proxy.example.com');
    assert.equal(deletedProxy?.host, 'proxy.example.com');
    assert.equal('password' in (updatedProxy ?? {}), false);
    assert.equal('password' in (deletedProxy ?? {}), false);
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

  it('host.import dryRun reports path-alias passphrase conflicts without writing', async () => {
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        dryRun: true,
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'first,first.example.com,root,~/.ssh/shared,first-secret',
          'second,second.example.com,root,/Users/alice/.ssh/shared,second-secret',
        ].join('\n'),
      },
      createDeps({
        resolveKeyPassphraseAliases: async (keyPath) => (
          keyPath.startsWith('~/')
            ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
            : [keyPath, `~/${keyPath.slice('/Users/alice/'.length)}`]
        ),
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal((result as { dryRun?: boolean }).dryRun, true);
    assert.deepEqual(saved, []);
    assert.match(
      (result as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? '',
      /conflicting passphrases/u,
    );
  });

  it('host.import blocks alias conflicts involving a skipped duplicate host', async () => {
    const existing: Host = {
      id: 'existing',
      label: 'old',
      hostname: 'old.example.com',
      username: 'root',
      port: 22,
    };
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const params = {
      format: 'csv',
      text: [
        'Label,Hostname,Port,Username,KeyPath,Passphrase',
        'old,old.example.com,22,root,~/.ssh/shared,old-secret',
        'new,new.example.com,22,root,/Users/alice/.ssh/shared,new-secret',
      ].join('\n'),
    };
    const aliases = async (keyPath: string) => (
      keyPath.startsWith('~/')
        ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
        : [keyPath, `~/${keyPath.slice('/Users/alice/'.length)}`]
    );

    const preview = await handleVaultAgentOp(
      'host.import',
      { ...params, dryRun: true },
      createDeps({ hosts: [existing], resolveKeyPassphraseAliases: aliases }),
    );
    const imported = await handleVaultAgentOp(
      'host.import',
      params,
      createDeps({
        hosts: [existing],
        resolveKeyPassphraseAliases: aliases,
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(preview.ok, true);
    assert.equal(imported.ok, true);
    assert.deepEqual(saved, []);
    assert.match(
      (preview as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? '',
      /conflicting passphrases/u,
    );
    assert.match(
      (imported as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? '',
      /conflicting passphrases/u,
    );
  });

  it('host.import keeps a new host credential when a skipped alias has the same passphrase', async () => {
    const existing: Host = {
      id: 'existing',
      label: 'old',
      hostname: 'old.example.com',
      username: 'root',
      port: 22,
    };
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Port,Username,KeyPath,Passphrase',
          'old,old.example.com,22,root,~/.ssh/shared,same-secret',
          'new,new.example.com,22,root,/Users/alice/.ssh/shared,same-secret',
        ].join('\n'),
      },
      createDeps({
        hosts: [existing],
        resolveKeyPassphraseAliases: async (keyPath) => (
          keyPath.startsWith('~/')
            ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
            : [keyPath, `~/${keyPath.slice('/Users/alice/'.length)}`]
        ),
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(saved, [{
      keyPath: '/Users/alice/.ssh/shared',
      passphrase: 'same-secret',
    }]);
  });

  it('host.import blocks an alias after an exact-path conflict', async () => {
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'one,one.example.com,root,~/.ssh/shared,one',
          'two,two.example.com,root,~/.ssh/shared,two',
          'three,three.example.com,root,/Users/alice/.ssh/shared,three',
        ].join('\n'),
      },
      createDeps({
        resolveKeyPassphraseAliases: async (keyPath) => (
          keyPath.startsWith('~/')
            ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
            : [keyPath, `~/${keyPath.slice('/Users/alice/'.length)}`]
        ),
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(saved, []);
    assert.ok(
      (result as { issues?: Array<{ message: string }> }).issues
        ?.some((issue) => /conflicting passphrases/u.test(issue.message)),
    );
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

  it('host.import saves CSV key passphrases only for newly added hosts', async () => {
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'key-host,key.example.com,ubuntu,~/.ssh/id_ed25519,secret',
        ].join('\n'),
      },
      createDeps({
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(saved, [{ keyPath: '~/.ssh/id_ed25519', passphrase: 'secret' }]);

    saved.length = 0;
    const duplicate = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'key-host,key.example.com,ubuntu,~/.ssh/id_ed25519,replacement',
        ].join('\n'),
      },
      createDeps({
        hosts: [{
          id: 'existing-key-host',
          label: 'key-host',
          hostname: 'key.example.com',
          username: 'ubuntu',
          port: 22,
          tags: [],
          os: 'linux',
        }],
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(duplicate.ok, true);
    assert.deepEqual(saved, []);
  });

  it('host.import does not save conflicting passphrases for a shared key path', async () => {
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'first,first.example.com,root,~/.ssh/id_shared,first-secret',
          'second,second.example.com,root,~/.ssh/id_shared,second-secret',
        ].join('\n'),
      },
      createDeps({
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(saved, []);
    assert.equal(
      (result as { issues?: Array<{ message: string }> }).issues
        ?.filter((issue) => /conflicting passphrases/u.test(issue.message)).length,
      1,
    );
    assert.match(
      (result as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? '',
      /conflicting passphrases/u,
    );
  });

  it('host.import resolves path aliases before saving passphrases', async () => {
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'first,first.example.com,root,~/.ssh/shared,first-secret',
          'second,second.example.com,root,/Users/alice/.ssh/shared,second-secret',
        ].join('\n'),
      },
      createDeps({
        resolveKeyPassphraseAliases: async (keyPath) => (
          keyPath.startsWith('~/')
            ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
            : [keyPath, `~/${keyPath.slice('/Users/alice/'.length)}`]
        ),
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(saved, []);
    assert.match(
      (result as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? '',
      /conflicting passphrases/u,
    );
  });

  it('host.import reports passphrase persistence failures as partial success', async () => {
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'key-host,key.example.com,root,~/.ssh/id_ed25519,secret',
        ].join('\n'),
      },
      createDeps({
        saveKeyPassphrase: async () => {
          throw new Error('storage unavailable');
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.match(
      (result as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? '',
      /Could not save the passphrase/u,
    );
  });

  it('host.import keeps a different existing saved key passphrase', async () => {
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'new,new.example.com,root,~/.ssh/shared,stale-import',
        ].join('\n'),
      },
      createDeps({
        readKeyPassphrases: async () => ({
          values: ['current-saved'],
          unreadable: false,
        }),
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(saved, []);
    assert.ok(
      (result as { issues?: Array<{ message: string }> }).issues
        ?.some((issue) => /existing saved passphrase/u.test(issue.message)),
    );
  });

  it('host.import keeps a passphrase corrected after the initial check', async () => {
    const saved: Array<{ keyPath: string; passphrase: string }> = [];
    const result = await handleVaultAgentOp(
      'host.import',
      {
        format: 'csv',
        text: [
          'Label,Hostname,Username,KeyPath,Passphrase',
          'new,new.example.com,root,~/.ssh/shared,stale-import',
        ].join('\n'),
      },
      createDeps({
        readKeyPassphrases: async () => ({ values: [], unreadable: false }),
        saveImportedKeyPassphrase: async () => 'conflict',
        saveKeyPassphrase: async (keyPath, passphrase) => {
          saved.push({ keyPath, passphrase });
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(saved, []);
    assert.ok(
      (result as { issues?: Array<{ message: string }> }).issues
        ?.some((issue) => /existing saved passphrase/u.test(issue.message)),
    );
  });
});

describe('handleVaultAgentOp vault management gaps', () => {
  const host: Host = {
    id: 'host-1',
    label: 'prod',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
  };

  it('lists safe identity metadata and binds an existing identity to a host', async () => {
    const deps = createDeps({
      hosts: [host],
      identities: [{
        id: 'identity-1',
        label: 'Production deploy',
        username: 'deploy',
        authMethod: 'password',
        password: 'must-not-leak',
        created: 1,
      }],
    });

    const listed = await handleVaultAgentOp('identity.list', {}, deps);
    assert.equal(listed.ok, true);
    assert.equal(JSON.stringify(listed).includes('must-not-leak'), false);

    const updated = await handleVaultAgentOp(
      'host.update',
      { hostId: 'host-1', identityId: 'identity-1' },
      deps,
    );
    assert.equal(updated.ok, true);
    assert.equal(deps.getHosts()[0]?.identityId, 'identity-1');
    assert.equal(deps.getHosts()[0]?.username, 'deploy');
  });

  it('updates advanced connection settings on a host', async () => {
    const jump: Host = { ...host, id: 'jump-1', label: 'jump', hostname: 'jump.test' };
    const deps = createDeps({
      hosts: [host, jump],
      proxyProfiles: [{
        id: 'proxy-1',
        label: 'Office proxy',
        config: { type: 'socks5', host: '127.0.0.1', port: 1080, password: 'hidden' },
        createdAt: 1,
      }],
    });

    const result = await handleVaultAgentOp('host.update', {
      hostId: 'host-1',
      jumpHostIds: '["jump-1"]',
      proxyProfileId: 'proxy-1',
      startupCommand: 'tmux attach || tmux',
      environmentVariables: '{"APP_ENV":"production"}',
      moshEnabled: 'true',
      moshServerPath: '/usr/local/bin/mosh-server',
      etEnabled: 'false',
      etPort: 2022,
    }, deps);

    assert.equal(result.ok, true);
    assert.deepEqual(deps.getHosts()[0]?.hostChain?.hostIds, ['jump-1']);
    assert.equal(deps.getHosts()[0]?.proxyProfileId, 'proxy-1');
    assert.deepEqual(deps.getHosts()[0]?.environmentVariables, [{ name: 'APP_ENV', value: 'production' }]);
    assert.equal(JSON.stringify(result).includes('hidden'), false);
  });

  it('creates, updates, and deletes port forwarding rules', async () => {
    const deps = createDeps({ hosts: [host] });
    const created = await handleVaultAgentOp('portforward.rules.create', {
      label: 'Web', type: 'local', localPort: 8080, bindAddress: '127.0.0.1',
      remoteHost: '127.0.0.1', remotePort: 80, hostId: 'host-1',
    }, deps);
    assert.equal(created.ok, true);
    const ruleId = (created as { rule?: { id?: string } }).rule?.id ?? '';

    assert.equal((await handleVaultAgentOp('portforward.rules.update', { ruleId, localPort: 8081 }, deps)).ok, true);
    assert.equal((await handleVaultAgentOp('portforward.rules.duplicate', { ruleId }, deps)).ok, true);
    assert.equal(deps.getPortForwardingRules().length, 2);
    assert.equal((await handleVaultAgentOp('portforward.rules.delete', { ruleId }, deps)).ok, true);
    assert.equal(deps.getPortForwardingRules().length, 1);
  });

  it('reports an inactive rule after changing a running forwarding connection', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'active', createdAt: 1,
    };
    let stopCalls = 0;
    const deps = createDeps({
      hosts: [host],
      portForwardingRules: [rule],
      stopRuleTunnels: async () => {
        stopCalls += 1;
        return { success: true };
      },
    });

    const result = await handleVaultAgentOp('portforward.rules.update', {
      ruleId: rule.id,
      localPort: 8081,
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(stopCalls, 1);
    assert.equal((result as { rule?: { status?: string } }).rule?.status, 'inactive');
    assert.equal(deps.getPortForwardingRules()[0]?.status, 'inactive');
  });

  it('preserves forwarding rule changes made while an old tunnel is stopping', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'active', createdAt: 1,
    };
    const concurrentRule: PortForwardingRule = {
      id: 'rule-2', label: 'Database', type: 'local', localPort: 5432,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 5432,
      hostId: host.id, status: 'inactive', createdAt: 2,
    };
    let deps: VaultAgentApiDeps;
    deps = createDeps({
      hosts: [host],
      portForwardingRules: [rule],
      stopRuleTunnels: async () => {
        deps.updatePortForwardingRules([...deps.getPortForwardingRules(), concurrentRule]);
        return { success: true };
      },
    });

    const result = await handleVaultAgentOp('portforward.rules.update', {
      ruleId: rule.id,
      localPort: 8081,
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(deps.getPortForwardingRules().find((entry) => entry.id === rule.id)?.localPort, 8081);
    assert.equal(deps.getPortForwardingRules().find((entry) => entry.id === concurrentRule.id)?.label, 'Database');
  });

  it('reports a stopped rule as inactive when the same connection was saved concurrently', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'active', createdAt: 1,
    };
    let deps: VaultAgentApiDeps;
    deps = createDeps({
      hosts: [host],
      portForwardingRules: [rule],
      stopRuleTunnels: async () => {
        deps.updatePortForwardingRules([{
          ...rule,
          localPort: 8081,
          status: 'active',
          error: 'stale error',
        }]);
        return { success: true };
      },
    });

    const result = await handleVaultAgentOp('portforward.rules.update', {
      ruleId: rule.id,
      localPort: 8081,
    }, deps);

    assert.equal(result.ok, true);
    assert.equal((result as { rule?: { status?: string; error?: string } }).rule?.status, 'inactive');
    assert.equal((result as { rule?: { status?: string; error?: string } }).rule?.error, undefined);
    assert.equal(deps.getPortForwardingRules()[0]?.status, 'inactive');
    assert.equal(deps.getPortForwardingRules()[0]?.error, undefined);
  });

  it('does not restore a forwarding rule deleted while its old tunnel is stopping', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'active', createdAt: 1,
    };
    let deps: VaultAgentApiDeps;
    deps = createDeps({
      hosts: [host],
      portForwardingRules: [rule],
      stopRuleTunnels: async () => {
        deps.updatePortForwardingRules([]);
        return { success: true };
      },
    });

    const result = await handleVaultAgentOp('portforward.rules.update', {
      ruleId: rule.id,
      localPort: 8081,
    }, deps);

    assert.equal(result.ok, false);
    assert.deepEqual(deps.getPortForwardingRules(), []);
  });

  it('cleans up backend tunnels before editing an inactive forwarding rule', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'inactive', createdAt: 1,
    };
    let cleanupCalls = 0;
    const deps = createDeps({
      hosts: [host],
      portForwardingRules: [rule],
      stopRuleTunnels: async () => {
        cleanupCalls += 1;
        return { success: true };
      },
    });

    const result = await handleVaultAgentOp('portforward.rules.update', {
      ruleId: rule.id,
      localPort: 8081,
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(cleanupCalls, 1);
  });

  it('keeps a running forwarding rule unchanged when stopping its old tunnel fails', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'active', createdAt: 1,
    };
    const deps = createDeps({
      hosts: [host],
      portForwardingRules: [rule],
      stopRuleTunnels: async () => ({ success: false, error: 'stop failed' }),
    });

    const result = await handleVaultAgentOp('portforward.rules.update', {
      ruleId: rule.id,
      localPort: 8081,
    }, deps);

    assert.equal(result.ok, false);
    assert.equal(deps.getPortForwardingRules()[0]?.localPort, 8080);
    assert.equal(deps.getPortForwardingRules()[0]?.status, 'active');
  });

  it('passes trusted host records when the agent starts port forwarding', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'inactive', createdAt: 1,
    };
    const knownHosts = [{
      id: 'known-1',
      hostname: host.hostname,
      port: 22,
      keyType: 'ssh-ed25519',
      publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAITest',
      discoveredAt: 1,
    }];
    let forwardedKnownHosts: VaultAgentApiDeps['knownHosts'] | undefined;
    const deps = createDeps({
      hosts: [host],
      knownHosts,
      portForwardingRules: [rule],
      startTunnel: async (
        _rule,
        _host,
        _hosts,
        _keys,
        _identities,
        _onStatusChange,
        _enableReconnect,
        _terminalSettings,
        receivedKnownHosts,
      ) => {
        forwardedKnownHosts = receivedKnownHosts;
        return { success: true };
      },
    });

    const result = await handleVaultAgentOp('portforward.start', { ruleId: rule.id }, deps);

    assert.equal(result.ok, true);
    assert.equal(forwardedKnownHosts, knownHosts);
  });

  it('does not start a forwarding rule whose host was changed to serial', async () => {
    const serialHost: Host = { ...host, protocol: 'serial' };
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'inactive', createdAt: 1,
    };
    let startCalls = 0;
    const deps = createDeps({
      hosts: [serialHost],
      portForwardingRules: [rule],
      startTunnel: async () => {
        startCalls += 1;
        return { success: true };
      },
    });

    const result = await handleVaultAgentOp('portforward.start', { ruleId: rule.id }, deps);

    assert.equal(result.ok, false);
    assert.equal(startCalls, 0);
  });

  it('rejects forwarding rules when the host inherits an unsupported protocol', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'inactive', createdAt: 1,
    };
    let startCalls = 0;
    const deps = createDeps({
      hosts: [host],
      portForwardingRules: [rule],
      resolveEffectiveHost: (current) => ({ ...current, protocol: 'telnet' }),
      startTunnel: async () => {
        startCalls += 1;
        return { success: true };
      },
    });

    const createResult = await handleVaultAgentOp('portforward.rules.create', {
      label: 'Inherited', type: 'local', localPort: 8081,
      remoteHost: '127.0.0.1', remotePort: 81, hostId: host.id,
    }, deps);
    const updateResult = await handleVaultAgentOp('portforward.rules.update', {
      ruleId: rule.id, label: 'Renamed',
    }, deps);
    const duplicateResult = await handleVaultAgentOp('portforward.rules.duplicate', {
      ruleId: rule.id,
    }, deps);
    const startResult = await handleVaultAgentOp('portforward.start', { ruleId: rule.id }, deps);

    for (const result of [createResult, updateResult, duplicateResult, startResult]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(String(result.error), /does not support port forwarding/i);
    }
    assert.equal(startCalls, 0);
    assert.deepEqual(deps.getPortForwardingRules(), [rule]);
  });

  it('persists an inactive status after stopping a forwarding rule', async () => {
    const rule: PortForwardingRule = {
      id: 'rule-1', label: 'Web', type: 'local', localPort: 8080,
      bindAddress: '127.0.0.1', remoteHost: '127.0.0.1', remotePort: 80,
      hostId: host.id, status: 'active', error: 'stale', createdAt: 1,
    };
    const deps = createDeps({ hosts: [host], portForwardingRules: [rule] });

    const stopped = await handleVaultAgentOp('portforward.stop', { ruleId: rule.id }, deps);
    const listed = await handleVaultAgentOp('portforward.rules.list', {}, deps);

    assert.equal(stopped.ok, true);
    assert.equal(deps.getPortForwardingRules()[0]?.status, 'inactive');
    assert.equal(deps.getPortForwardingRules()[0]?.error, undefined);
    assert.equal((listed as { rules?: Array<{ status?: string }> }).rules?.[0]?.status, 'inactive');
  });

  it('manages groups and applies reusable defaults without exposing secrets', async () => {
    const deps = createDeps({
      hosts: [{ ...host, group: 'prod' }],
      identities: [{ id: 'identity-1', label: 'Deploy', username: 'deploy', authMethod: 'key', keyId: 'key-1', created: 1 }],
      proxyProfiles: [{ id: 'proxy-1', label: 'Proxy', config: { type: 'http', host: 'proxy.test', port: 8080, password: 'hidden' }, createdAt: 1 }],
      customGroups: ['prod'],
      groupConfigs: [{
        path: 'prod',
        startupCommand: 'echo startup-secret',
        environmentVariables: [{ name: 'TOKEN', value: 'environment-secret' }],
        identityFileId: 'key-1',
        identityFilePaths: ['/Users/alice/.ssh/id_prod'],
        moshServerPath: '/Users/alice/bin/mosh-server',
        proxyConfig: {
          type: 'command', host: 'proxy.internal', port: 22, command: 'proxy-command-secret',
        },
      }],
    });

    const updated = await handleVaultAgentOp('group.update', {
      path: 'prod',
      defaults: '{"username":"deploy","identityId":"identity-1","proxyProfileId":"proxy-1"}',
    }, deps);
    assert.equal(updated.ok, true);
    assert.equal(deps.getGroupConfigs()[0]?.username, 'deploy');
    assert.equal(JSON.stringify(updated).includes('hidden'), false);

    const listed = await handleVaultAgentOp('group.list', {}, deps);
    const serializedList = JSON.stringify(listed);
    assert.equal(serializedList.includes('startup-secret'), false);
    assert.equal(serializedList.includes('environment-secret'), false);
    assert.equal(serializedList.includes('proxy-command-secret'), false);
    assert.equal(serializedList.includes('id_prod'), false);
    assert.equal(serializedList.includes('/Users/alice/bin/mosh-server'), true);
    assert.equal(serializedList.includes('key-1'), false);
    assert.equal(serializedList.includes('deploy'), true);

    const invalidDelete = await handleVaultAgentOp('group.delete', {
      path: 'prod', deleteHosts: 'ture',
    }, deps);
    assert.equal(invalidDelete.ok, false);
    assert.equal(deps.getCustomGroups().includes('prod'), true);

    const removed = await handleVaultAgentOp('group.delete', { path: 'prod' }, deps);
    assert.equal(removed.ok, true);
    assert.equal(deps.getCustomGroups().includes('prod'), false);
    assert.equal(deps.getHosts()[0]?.group, undefined);
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

  it('snippets.create persists multi-line run mode', async () => {
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
        label: 'Login',
        content: 'admin\npassword',
        multiLineRunMode: 'lineDelay',
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(updated[0]?.[0]?.multiLineRunMode, 'lineDelay');
  });

  it('snippets.update persists multi-line run mode', async () => {
    const updated: Snippet[][] = [];
    const deps = createDeps({
      snippets: [{ id: 'snippet-1', label: 'Login', command: 'admin\npassword', kind: 'snippet' }],
      updateSnippets: (nextSnippets) => {
        updated.push(nextSnippets);
      },
    });

    const result = await handleVaultAgentOp(
      'snippets.update',
      {
        snippetId: 'snippet-1',
        multiLineRunMode: 'lineDelay',
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(updated[0]?.[0]?.multiLineRunMode, 'lineDelay');
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
