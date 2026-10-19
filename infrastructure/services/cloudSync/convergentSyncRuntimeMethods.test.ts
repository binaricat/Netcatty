import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  CloudProvider,
  ConvergentProviderBaselineV2,
  ConvergentSyncStateV2,
  SyncPayload,
  SyncedFile,
} from '../../../domain/sync.ts';
import { ONEDRIVE_REAUTH_REQUIRED_MARKER } from '../../../domain/sync.ts';
import {
  applyLegacySyncPayload,
  cloudSyncPayloadsEqual,
  createConvergentSyncStateFromPayload,
  materializeConvergentSyncState,
  materializeSyncPayloadFromConvergentState,
  mergeConvergentSyncStates,
  validateConvergentSyncPayload,
  withConvergentSyncEnvelope,
} from '../../../domain/convergentSync/index.ts';
import { EncryptionService } from '../EncryptionService.ts';
import type { CloudAdapter } from '../adapters/index.ts';
import {
  downgradeConvergentSyncImpl,
  previewConvergentRecoveryImpl,
  resolveConvergentConflictAndSyncImpl,
  syncAllProvidersConvergentlyImpl,
  syncConvergentProvidersUnlockedImpl,
} from './convergentSyncRuntimeMethods.ts';

const NOW = 1_700_000_000_000;

function payload(label: string, username = 'root'): SyncPayload {
  return {
    hosts: [{
      id: 'host-1',
      label,
      hostname: 'example.com',
      port: 22,
      username,
      tags: [],
      os: 'linux',
    }],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    groupConfigs: [],
    syncedAt: NOW,
  };
}

function payloadWithHostCount(count: number): SyncPayload {
  return {
    ...payload('base'),
    hosts: Array.from({ length: count }, (_, index) => ({
      id: `host-${index}`,
      label: `Host ${index}`,
      hostname: `host-${index}.example.com`,
      port: 22,
      username: 'root',
      tags: [],
      os: 'linux' as const,
    })),
  };
}

function remoteState(
  base: ConvergentSyncStateV2,
  before: SyncPayload,
  after: SyncPayload,
  deviceId: string,
  now: number,
): ConvergentSyncStateV2 {
  return applyLegacySyncPayload(base, before, after, deviceId, now);
}

const applyAndCommit = async (
  _payload: SyncPayload,
  commitReplica: () => Promise<void>,
): Promise<void> => commitReplica();

interface MemoryAdapter extends CloudAdapter {
  uploads: number;
  remote: SyncedFile | null;
  failUpload?: boolean;
  failDownload?: boolean;
  downloadError?: Error;
  afterUpload?: (file: SyncedFile, adapter: MemoryAdapter) => void;
}

function adapter(initial: SyncedFile | null): MemoryAdapter {
  const result: MemoryAdapter = {
    isAuthenticated: true,
    accountInfo: null,
    resourceId: null,
    uploads: 0,
    remote: initial,
    signOut: () => {},
    initializeSync: async () => null,
    upload: async (file) => {
      if (result.failUpload) throw new Error('provider upload unavailable');
      result.uploads += 1;
      result.remote = file;
      result.afterUpload?.(file, result);
      return `resource-${result.uploads}`;
    },
    download: async () => {
      if (result.failDownload) throw result.downloadError ?? new Error('provider unavailable');
      return result.remote;
    },
    deleteSync: async () => {},
    getTokens: () => null,
  };
  return result;
}

function manager(
  replica: ConvergentSyncStateV2,
  adapters: Partial<Record<CloudProvider, MemoryAdapter>>,
  baselines: Partial<Record<CloudProvider, ConvergentProviderBaselineV2>> = {},
) {
  const persisted: ConvergentSyncStateV2[] = [];
  let currentReplica = replica;
  const events: unknown[] = [];
  const completedDowngrades: boolean[] = [];
  const legacyCommits: Array<{
    provider: CloudProvider;
    remoteFile: SyncedFile;
    payload: SyncPayload;
  }> = [];
  const providerConnections = Object.fromEntries(
    (['github', 'google', 'onedrive', 'webdav', 's3'] as CloudProvider[]).map((provider) => [
      provider,
      adapters[provider]
        ? { provider, status: 'connected' as const }
        : { provider, status: 'disconnected' as const },
    ]),
  ) as Record<CloudProvider, { provider: CloudProvider; status: 'connected' | 'disconnected'; resourceId?: string }>;
  return {
    masterPassword: 'pw',
    state: {
      securityState: 'UNLOCKED',
      syncState: 'IDLE',
      providers: providerConnections,
      deviceId: 'local-device',
      deviceName: 'Local device',
      syncStrategy: 'smartMerge',
      localVersion: 0,
      localUpdatedAt: 0,
      remoteVersion: 0,
      remoteUpdatedAt: 0,
      currentConflict: null,
      lastError: null,
      pendingLocalSync: false,
      convergentConflicts: materializeConvergentSyncState(replica).conflicts,
      syncHistory: [],
      lastShrinkFinding: undefined,
    },
    persisted,
    events,
    completedDowngrades,
    legacyCommits,
    getConnectedAdapter: async (provider: CloudProvider) => adapters[provider],
    loadConvergentReplica: async () => ({ schemaVersion: 2 as const, state: currentReplica, updatedAt: NOW }),
    saveConvergentReplica: async (record: { state: ConvergentSyncStateV2 }) => {
      currentReplica = record.state;
      persisted.push(record.state);
    },
    loadConvergentProviderBaseline: async (provider: CloudProvider) => baselines[provider] ?? null,
    saveConvergentProviderBaseline: async (baseline: ConvergentProviderBaselineV2) => {
      baselines[baseline.provider] = baseline;
    },
    commitRemoteInspection: async (
      provider: CloudProvider,
      remoteFile: SyncedFile,
      incoming: SyncPayload,
    ) => {
      legacyCommits.push({ provider, remoteFile, payload: incoming });
    },
    completeConvergentSyncDowngrade: (confirmed: boolean) => {
      completedDowngrades.push(confirmed);
    },
    updateProviderStatus(provider: CloudProvider, status: 'connected' | 'syncing' | 'error', error?: string) {
      this.state.providers[provider] = { ...this.state.providers[provider], status, ...(error ? { error } : {}) };
    },
    emit: (event: unknown) => events.push(event),
    notifyStateChange: () => {},
    addSyncHistoryEntry: () => {},
    saveProviderConnection: async () => {},
    saveSyncConfig: () => {},
    exitBlockedState: () => {},
  };
}

function installEncryptionDouble() {
  const originalEncrypt = EncryptionService.encryptPayload;
  const originalDecrypt = EncryptionService.decryptPayload;
  const payloads = new Map<string, SyncPayload>();
  let sequence = 0;
  const register = (value: SyncPayload, version = 1, deviceId = 'remote'): SyncedFile => {
    const ciphertext = `cipher-${sequence += 1}`;
    payloads.set(ciphertext, value);
    return {
      meta: {
        version,
        updatedAt: NOW + sequence,
        deviceId,
        deviceName: deviceId,
        appVersion: 'test',
        iv: '',
        salt: '',
        algorithm: 'AES-256-GCM',
        kdf: 'PBKDF2',
        kdfIterations: 1,
        ...(value.convergentSync ? { syncSchemaVersion: 2 as const } : {}),
      },
      payload: ciphertext,
    };
  };
  EncryptionService.encryptPayload = async (value, _password, deviceId, _deviceName, _version, existingVersion) =>
    register(value, (existingVersion ?? 0) + 1, deviceId);
  EncryptionService.decryptPayload = async (file) => {
    const value = payloads.get(file.payload);
    if (!value) throw new Error('unknown test ciphertext');
    return value;
  };
  return {
    register,
    payloads,
    restore: () => {
      EncryptionService.encryptPayload = originalEncrypt;
      EncryptionService.decryptPayload = originalDecrypt;
    },
  };
}

function chatSession(messageIds: string[], updatedAt = NOW): NonNullable<SyncPayload['aiSessions']>[number] {
  return {
    id: 'chat', title: 'Chat', agentId: 'catty', scope: { type: 'global' },
    createdAt: NOW, updatedAt,
    messages: messageIds.map((id, index) => ({ id, role: 'user', content: id, timestamp: NOW + index })),
  };
}

test('chat-only convergent changes merge both transcripts, apply them, and remain idle afterwards', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const state = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const remoteChats = [chatSession(['first', 'remote'], NOW + 2)];
    const github = adapter(encryption.register(withConvergentSyncEnvelope(state, { syncedAt: NOW, aiSessions: remoteChats })));
    const subject = manager(state, { github });
    const local = { ...basePayload, aiSessions: [chatSession(['first', 'local'], NOW + 1)] };
    let applied: SyncPayload | undefined;
    const results = await syncConvergentProvidersUnlockedImpl.call(subject, local, {
      now: () => NOW + 10, jitter: async () => {},
      applyPayload: async (incoming, commit) => { applied = incoming; await commit(); },
    });
    assert.equal(results.get('github')?.success, true);
    assert.deepEqual(new Set(applied?.aiSessions?.[0].messages.map((message) => message.id)), new Set(['first', 'local', 'remote']));
    const uploaded = await EncryptionService.decryptPayload(github.remote!, 'pw');
    assert.deepEqual(uploaded.aiSessions, applied?.aiSessions);
    assert.equal(uploaded.convergentSync?.state.collections.aiSessions, undefined, 'chats must not add an incompatible vault collection');
    assert.equal(github.uploads, 1);
    await syncConvergentProvidersUnlockedImpl.call(subject, applied!, { now: () => NOW + 20, jitter: async () => {}, applyPayload: applyAndCommit });
    assert.equal(github.uploads, 1);
  } finally { encryption.restore(); }
});

test('convergent verification rejects an upload whose chat history was dropped', async () => {
  const encryption = installEncryptionDouble();
  try {
    const local = { ...payload('base'), aiSessions: [chatSession(['local'])] };
    const state = createConvergentSyncStateFromPayload(local, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(state, { syncedAt: NOW })));
    github.afterUpload = (file, transport) => {
      const uploaded = encryption.payloads.get(file.payload)!;
      transport.remote = encryption.register({ ...uploaded, aiSessions: [] }, file.meta.version);
    };
    const subject = manager(state, { github });
    const results = await syncConvergentProvidersUnlockedImpl.call(subject, local, {
      now: () => NOW + 10, jitter: async () => {}, applyPayload: applyAndCommit,
    });
    assert.equal(results.get('github')?.success, false);
    assert.match(results.get('github')?.error ?? '', /expected chat history/);
  } finally { encryption.restore(); }
});

test('convergent downgrade retains cloud chats for an opted-out local device', async () => {
  const encryption = installEncryptionDouble();
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } },
    });
    const local = payload('base');
    const state = createConvergentSyncStateFromPayload(local, 'seed', NOW);
    const aiSessions = [chatSession(['remote'])];
    const github = adapter(encryption.register(withConvergentSyncEnvelope(state, { syncedAt: NOW, aiSessions })));
    const subject = manager(state, { github });
    let applied: SyncPayload | undefined;
    const results = await downgradeConvergentSyncImpl.call(subject, true, () => local, async (incoming, commit) => {
      applied = incoming;
      await commit();
    });
    assert.equal(results.get('github')?.success, true);
    assert.deepEqual(applied?.aiSessions, aiSessions);
    const uploaded = await EncryptionService.decryptPayload(github.remote!, 'pw');
    assert.deepEqual(uploaded.aiSessions, aiSessions);
    assert.equal(uploaded.convergentSync, undefined);
    assert.deepEqual(subject.legacyCommits[0].payload.aiSessions, aiSessions);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

for (const uploadFails of [false, true]) {
  test(`preserve strategy restores a survivor suppressed by a remote deletion${uploadFails ? ' even when upload fails' : ''}`, async () => {
    const encryption = installEncryptionDouble();
    try {
      const local = payloadWithHostCount(2);
      const state = createConvergentSyncStateFromPayload(local, 'seed', NOW);
      const remotePayload = { ...local, hosts: [{ ...local.hosts[0], label: 'Remote edit' }] };
      const deleted = remoteState(state, local, remotePayload, 'remote-device', NOW + 1);
      const github = adapter(encryption.register(withConvergentSyncEnvelope(deleted, { syncedAt: NOW + 1 })));
      github.failUpload = uploadFails;
      const subject = manager(state, { github });
      subject.state.syncStrategy = 'smartMergePreserve';
      let applied: SyncPayload | undefined;
      const results = await syncConvergentProvidersUnlockedImpl.call(subject, local, {
        now: () => NOW + 10, jitter: async () => {},
        applyPayload: async (incoming, commit) => { applied = incoming; await commit(); },
      });
      assert.equal(results.get('github')?.success, !uploadFails);
      assert.deepEqual(applied?.hosts.map((host) => host.id).sort(), ['host-0', 'host-1']);
      assert.equal(applied?.hosts[0].label, 'Remote edit');
      const persisted = materializeSyncPayloadFromConvergentState(subject.persisted.at(-1)!, { syncedAt: NOW });
      assert.deepEqual(persisted.hosts, applied?.hosts, 'the durable replica must match the protected local apply');
      if (!uploadFails) {
        const uploaded = await EncryptionService.decryptPayload(github.remote!, 'pw');
        assert.deepEqual(uploaded.hosts, applied?.hosts);
        await syncConvergentProvidersUnlockedImpl.call(subject, applied!, { now: () => NOW + 20, jitter: async () => {}, applyPayload: applyAndCommit });
        assert.equal(github.uploads, 1);
      }
    } finally { encryption.restore(); }
  });
}

test('unordered provider join preserves independent offline edits and persists before upload', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const githubState = remoteState(base, basePayload, payload('github-label'), 'github-device', NOW + 1);
    const googleState = remoteState(base, basePayload, payload('base', 'ubuntu'), 'google-device', NOW + 2);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(githubState, { syncedAt: NOW }), 2, 'github-device'));
    const google = adapter(encryption.register(withConvergentSyncEnvelope(googleState, { syncedAt: NOW }), 2, 'google-device'));
    const subject = manager(base, { github, google });
    let persistedBeforeUpload = false;
    const originalUpload = github.upload.bind(github);
    github.upload = async (file) => {
      persistedBeforeUpload = subject.persisted.length > 0;
      return originalUpload(file);
    };

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      basePayload,
      { jitter: async () => {}, now: () => NOW + 10, applyPayload: applyAndCommit },
    );

    assert.equal(persistedBeforeUpload, true);
    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('google')?.success, true);
    assert.equal(results.get('github')?.mergedPayloadApplied, true);
    const merged = results.get('github')?.mergedPayload;
    assert.equal(merged?.hosts[0]?.label, 'github-label');
    assert.equal(merged?.hosts[0]?.username, 'ubuntu');
    assert.equal(subject.state.convergentConflicts.length, 0);
  } finally {
    encryption.restore();
  }
});

test('a failed protected merged apply leaves the durable replica aligned with local data', async () => {
  const encryption = installEncryptionDouble();
  try {
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const remote = remoteState(
      base,
      localPayload,
      payload('local', 'remote-user'),
      'remote-device',
      NOW + 1,
    );
    const github = adapter(encryption.register(
      withConvergentSyncEnvelope(remote, { syncedAt: NOW + 1 }),
      2,
      'remote-device',
    ));
    const subject = manager(base, { github });

    await assert.rejects(
      () => syncConvergentProvidersUnlockedImpl.call(
        subject,
        localPayload,
        {
          jitter: async () => {},
          now: () => NOW + 10,
          applyPayload: async () => {
            throw new Error('protective merged apply failed');
          },
        },
      ),
      /protective merged apply failed/,
    );

    const durable = materializeSyncPayloadFromConvergentState(
      subject.persisted.at(-1)!,
      { syncedAt: NOW },
    );
    assert.equal(durable.hosts[0]?.username, 'root');
    assert.equal(github.uploads, 0);
    assert.equal(subject.state.syncState, 'ERROR');
    assert.equal(subject.state.pendingLocalSync, true);
  } finally {
    encryption.restore();
  }
});

test('an unchanged convergent check verifies without uploading or returning a payload apply', async () => {
  const encryption = installEncryptionDouble();
  try {
    const localPayload = payload('unchanged');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(
      withConvergentSyncEnvelope(base, { syncedAt: NOW }),
      3,
      'github-device',
    ));
    const subject = manager(base, { github });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('github')?.mergedPayload, undefined);
    assert.equal(github.uploads, 0);
    assert.equal(github.remote?.meta.version, 3);
  } finally {
    encryption.restore();
  }
});

test('recovery preview joins providers without persisting or uploading state', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const githubState = remoteState(base, basePayload, payload('remote-label'), 'github-device', NOW + 1);
    const googleState = remoteState(base, basePayload, payload('base', 'remote-user'), 'google-device', NOW + 2);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(githubState, { syncedAt: NOW, aiSessions: [chatSession(['github'])] }), 2));
    const google = adapter(encryption.register(withConvergentSyncEnvelope(googleState, { syncedAt: NOW, aiSessions: [chatSession(['google'], NOW + 1)] }), 2));
    const subject = manager(base, { github, google });

    const preview = await previewConvergentRecoveryImpl.call(subject);

    assert.equal(preview?.hosts[0]?.label, 'remote-label');
    assert.equal(preview?.hosts[0]?.username, 'remote-user');
    assert.deepEqual(new Set(preview?.aiSessions?.[0].messages.map((message) => message.id)), new Set(['github', 'google']));
    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(google.uploads, 0);
    assert.equal(subject.events.length, 0);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('a concurrent provider write discovered during verification is rejoined and propagated', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1, 'github-device'));
    const google = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1, 'google-device'));
    let injected = false;
    github.afterUpload = (file, target) => {
      if (injected) return;
      injected = true;
      const outgoing = encryption.payloads.get(file.payload)!;
      const outgoingState = validateConvergentSyncPayload(file.meta, outgoing)!;
      const outgoingMaterialized = materializeSyncPayloadFromConvergentState(outgoingState, { syncedAt: NOW });
      const concurrent = remoteState(
        outgoingState,
        outgoingMaterialized,
        payload('provider-race'),
        'racing-device',
        NOW + 20,
      );
      target.remote = encryption.register(
        withConvergentSyncEnvelope(concurrent, { syncedAt: NOW + 20 }),
        file.meta.version + 1,
        'racing-device',
      );
    };
    const subject = manager(base, { github, google });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      payload('local-write'),
      { jitter: async () => {}, now: () => NOW + 30, applyPayload: applyAndCommit },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('google')?.success, true);
    assert.equal(results.get('google')?.mergedPayload?.hosts[0]?.label, 'provider-race');
    assert.ok(google.uploads >= 2, 'the concurrent write should trigger another propagation round');
    const githubPayload = await EncryptionService.decryptPayload(github.remote!, 'pw');
    const googlePayload = await EncryptionService.decryptPayload(google.remote!, 'pw');
    const githubFinal = validateConvergentSyncPayload(github.remote!.meta, githubPayload)!;
    const googleFinal = validateConvergentSyncPayload(google.remote!.meta, googlePayload)!;
    assert.equal(
      cloudSyncPayloadsEqual(
        materializeSyncPayloadFromConvergentState(githubFinal, { syncedAt: NOW }),
        materializeSyncPayloadFromConvergentState(googleFinal, { syncedAt: NOW }),
      ),
      true,
    );
  } finally {
    encryption.restore();
  }
});

test('a failed provider does not roll back a provider that verified successfully', async () => {
  const encryption = installEncryptionDouble();
  try {
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1));
    const google = adapter(null);
    google.failDownload = true;
    const subject = manager(base, { github, google });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('google')?.success, false);
    assert.equal(subject.state.syncState, 'IDLE');
    assert.equal(subject.state.pendingLocalSync, true);
  } finally {
    encryption.restore();
  }
});

test('total upload failure keeps downloaded remote edits out of the durable local replica', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const localPayload = payload('local-write');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const remote = remoteState(
      base,
      basePayload,
      payload('base', 'remote-user'),
      'remote-device',
      NOW + 1,
    );
    const github = adapter(encryption.register(
      withConvergentSyncEnvelope(remote, { syncedAt: NOW + 1 }),
      2,
      'remote-device',
    ));
    github.failUpload = true;
    const subject = manager(base, { github });

    const failed = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      { maxRounds: 1, jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(failed.get('github')?.success, false);
    assert.equal(
      materializeSyncPayloadFromConvergentState(subject.persisted.at(-1)!, { syncedAt: NOW })
        .hosts[0]?.username,
      'root',
    );
    assert.equal(
      materializeSyncPayloadFromConvergentState(subject.persisted.at(-1)!, { syncedAt: NOW })
        .hosts[0]?.label,
      'local-write',
    );

    github.failUpload = false;
    subject.state.providers.github.status = 'connected';
    const retried = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      {
        maxRounds: 1,
        jitter: async () => {},
        now: () => NOW + 20,
        applyPayload: applyAndCommit,
      },
    );

    assert.equal(retried.get('github')?.success, true);
    assert.equal(retried.get('github')?.mergedPayload?.hosts[0]?.username, 'remote-user');
  } finally {
    encryption.restore();
  }
});

test('convergent provider failures delegate expired OneDrive credentials to reauth handling', async () => {
  const encryption = installEncryptionDouble();
  try {
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const onedrive = adapter(null);
    onedrive.failDownload = true;
    onedrive.downloadError = new Error(
      `${ONEDRIVE_REAUTH_REQUIRED_MARKER}: OneDrive session expired, please reconnect.`,
    );
    const subject = manager(base, { onedrive });
    subject.state.providers.onedrive = {
      ...subject.state.providers.onedrive,
      tokens: {
        accessToken: 'expired-access',
        refreshToken: 'expired-refresh',
        tokenType: 'Bearer',
      },
    } as typeof subject.state.providers.onedrive;
    let reauthCalls = 0;
    (subject as typeof subject & {
      handleProviderReauthRequired: (provider: CloudProvider, error: unknown) => boolean;
    }).handleProviderReauthRequired = (provider, error) => {
      if (
        provider !== 'onedrive'
        || !String(error).includes(ONEDRIVE_REAUTH_REQUIRED_MARKER)
      ) return false;
      reauthCalls += 1;
      subject.state.providers.onedrive = {
        provider: 'onedrive',
        status: 'error',
        error: 'OneDrive session expired, please reconnect.',
      };
      return true;
    };

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      { maxRounds: 1, jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('onedrive')?.success, false);
    assert.equal(reauthCalls, 1);
    assert.equal('tokens' in subject.state.providers.onedrive, false);
    assert.equal(subject.state.providers.onedrive.status, 'error');
    assert.equal(
      subject.state.providers.onedrive.error,
      'OneDrive session expired, please reconnect.',
    );
  } finally {
    encryption.restore();
  }
});

test('legacy cloud writes without a trusted provider baseline fail closed', async () => {
  const encryption = installEncryptionDouble();
  try {
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(payload('legacy'), 2, 'old-device'));
    const subject = manager(base, { github });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      localPayload,
      { maxRounds: 1, jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, false);
    assert.match(results.get('github')?.error ?? '', /no trusted convergent baseline/i);
    assert.equal(github.uploads, 0);
  } finally {
    encryption.restore();
  }
});

test('a migration-seeded v1 baseline allows the first sync to publish v2', async () => {
  const encryption = installEncryptionDouble();
  try {
    const legacyPayload = payload('legacy');
    const replica = createConvergentSyncStateFromPayload(legacyPayload, 'local-device', NOW);
    const github = adapter(encryption.register(legacyPayload, 7, 'legacy-device'));
    const baseline: ConvergentProviderBaselineV2 = {
      schemaVersion: 2,
      provider: 'github',
      remoteVersion: 7,
      remoteUpdatedAt: NOW,
      remoteDeviceId: 'legacy-device',
      materializedPayload: legacyPayload,
      state: replica,
    };
    const subject = manager(replica, { github }, { github: baseline });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      legacyPayload,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(github.uploads > 0, true);
    assert.equal(github.remote?.meta.syncSchemaVersion, 2);
    const uploaded = await EncryptionService.decryptPayload(github.remote!, 'pw');
    assert.ok(validateConvergentSyncPayload(github.remote!.meta, uploaded));
  } finally {
    encryption.restore();
  }
});

test('provider order cannot change the joined materialized result', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const left = remoteState(base, basePayload, payload('left'), 'left', NOW + 1);
    const right = remoteState(base, basePayload, payload('right'), 'right', NOW + 2);
    const joinedA = mergeConvergentSyncStates(left, right);
    const joinedB = mergeConvergentSyncStates(right, left);
    assert.deepEqual(joinedA, joinedB);
  } finally {
    encryption.restore();
  }
});

test('preferCloud adopts the joined remote replica without creating a local conflict', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const remote = remoteState(base, basePayload, payload('cloud'), 'cloud-device', NOW + 1);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(remote, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    subject.state.syncStrategy = 'preferCloud';

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      payload('unsaved-local'),
      { jitter: async () => {}, now: () => NOW + 10, applyPayload: applyAndCommit },
    );

    assert.equal(results.get('github')?.mergedPayload?.hosts[0]?.label, 'cloud');
    assert.equal(results.get('github')?.convergentConflictCount, 0);
  } finally {
    encryption.restore();
  }
});

test('preferLocal creates a causal write that dominates a remote edit', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const remote = remoteState(base, basePayload, payload('cloud'), 'cloud-device', NOW + 1);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(remote, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    subject.state.syncStrategy = 'preferLocal';

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      payload('local-wins'),
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.mergedPayload, undefined);
    assert.equal(results.get('github')?.convergentConflictCount, 0);
  } finally {
    encryption.restore();
  }
});

test('a trusted baseline converts an old-client v1 write into deterministic causal writes', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(payload('legacy-edit'), 2, 'old-device'));
    const baseline: ConvergentProviderBaselineV2 = {
      schemaVersion: 2,
      provider: 'github',
      remoteVersion: 1,
      remoteUpdatedAt: NOW,
      remoteDeviceId: 'old-device',
      materializedPayload: basePayload,
      state: base,
    };
    const subject = manager(base, { github }, { github: baseline });

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      basePayload,
      { jitter: async () => {}, now: () => NOW + 10, applyPayload: applyAndCommit },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('github')?.mergedPayload?.hosts[0]?.label, 'legacy-edit');
  } finally {
    encryption.restore();
  }
});

test('the production entry fails closed when another window owns the Web Lock', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) => callback(null),
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 1));
    const subject = manager(base, { github });

    const results = await syncAllProvidersConvergentlyImpl.call(subject, localPayload);

    assert.equal(results.get('github')?.success, false);
    assert.match(results.get('github')?.error ?? '', /already running in another window/i);
    assert.equal(github.uploads, 0);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('explicit downgrade replaces v2 only after a verified legacy write', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let lockHeld = false;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (
            _name: string,
            _options: unknown,
            callback: (lock: object) => unknown,
          ) => {
            lockHeld = true;
            try {
              return await callback({});
            } finally {
              lockHeld = false;
            }
          },
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    const completeDowngrade = subject.completeConvergentSyncDowngrade;
    subject.completeConvergentSyncDowngrade = (confirmed: boolean) => {
      assert.equal(lockHeld, true);
      assert.equal(subject.legacyCommits.length, 1);
      completeDowngrade(confirmed);
    };
    let appliedPayload: SyncPayload | null = null;

    const results = await downgradeConvergentSyncImpl.call(
      subject,
      true,
      async () => localPayload,
      async (incoming: SyncPayload, commitReplica: () => Promise<void>) => {
        appliedPayload = incoming;
        await commitReplica();
      },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(appliedPayload?.hosts[0]?.label, 'local');
    assert.deepEqual(subject.completedDowngrades, [true]);
    assert.equal(github.remote?.meta.syncSchemaVersion, undefined);
    const verified = await EncryptionService.decryptPayload(github.remote!, 'pw');
    assert.equal(verified.convergentSync, undefined);
    assert.equal(verified.hosts[0]?.label, 'local');
    assert.equal(subject.legacyCommits.length, 1);
    assert.equal(subject.legacyCommits[0]?.provider, 'github');
    assert.equal(subject.legacyCommits[0]?.remoteFile, github.remote);
    assert.equal(subject.legacyCommits[0]?.payload.hosts[0]?.label, 'local');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('downgrade reports cleanup failure instead of releasing a successful result', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    subject.completeConvergentSyncDowngrade = () => {
      throw new Error('local cleanup failed');
    };

    const results = await downgradeConvergentSyncImpl.call(
      subject,
      true,
      async () => localPayload,
      async (_incoming: SyncPayload, commitReplica: () => Promise<void>) => {
        await commitReplica();
      },
    );

    assert.equal(results.get('github')?.success, false);
    assert.match(results.get('github')?.error ?? '', /local cleanup failed/);
    assert.equal(github.uploads, 1);
    assert.equal(subject.state.syncState, 'ERROR');
    assert.equal(subject.state.pendingLocalSync, true);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('downgrade finalizes a local-only convergent replica without providers', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const pausedLocalPayload = payload('paused-local');
    const subject = manager(base, {});
    let appliedPayload: SyncPayload | null = null;

    const results = await downgradeConvergentSyncImpl.call(
      subject,
      true,
      async () => pausedLocalPayload,
      async (incoming: SyncPayload, commitReplica: () => Promise<void>) => {
        appliedPayload = incoming;
        await commitReplica();
      },
    );

    assert.equal(results.size, 0);
    assert.equal(appliedPayload?.hosts[0]?.label, 'paused-local');
    assert.deepEqual(subject.completedDowngrades, [true]);
    assert.equal(subject.state.syncState, 'IDLE');
    assert.equal(subject.state.pendingLocalSync, false);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('local-only downgrade reports cleanup failures instead of returning an empty success', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const subject = manager(base, {});
    subject.completeConvergentSyncDowngrade = () => {
      throw new Error('local cleanup failed');
    };

    await assert.rejects(
      () => downgradeConvergentSyncImpl.call(
        subject,
        true,
        async () => localPayload,
        async (_incoming: SyncPayload, commitReplica: () => Promise<void>) => {
          await commitReplica();
        },
      ),
      /local cleanup failed/,
    );

    assert.equal(subject.state.syncState, 'ERROR');
    assert.equal(subject.state.pendingLocalSync, true);
    assert.deepEqual(subject.completedDowngrades, []);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('local-only downgrade fails closed while the replica has unresolved conflicts', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const left = remoteState(base, basePayload, payload('left'), 'left-device', NOW + 1);
    const right = remoteState(base, basePayload, payload('right'), 'right-device', NOW + 2);
    const conflicted = mergeConvergentSyncStates(left, right);
    const subject = manager(conflicted, {});

    await assert.rejects(
      () => downgradeConvergentSyncImpl.call(
        subject,
        true,
        async () => materializeSyncPayloadFromConvergentState(conflicted, { syncedAt: NOW }),
        async (_incoming: SyncPayload, commitReplica: () => Promise<void>) => {
          await commitReplica();
        },
      ),
      /Resolve 1 convergent conflict/,
    );

    assert.equal(subject.state.syncState, 'CONFLICT');
    assert.deepEqual(subject.completedDowngrades, []);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('downgrade joins remote-only v2 edits before applying or writing v1', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const remote = remoteState(base, basePayload, payload('remote-only'), 'remote-device', NOW + 1);
    const github = adapter(encryption.register(
      withConvergentSyncEnvelope(remote, { syncedAt: NOW + 1 }),
      4,
      'remote-device',
    ));
    const baselines: Partial<Record<CloudProvider, ConvergentProviderBaselineV2>> = {};
    const subject = manager(base, { github }, baselines);
    let appliedPayload: SyncPayload | null = null;

    const results = await downgradeConvergentSyncImpl.call(
      subject,
      true,
      async () => basePayload,
      async (incoming: SyncPayload, commitReplica: () => Promise<void>) => {
        appliedPayload = incoming;
        await commitReplica();
      },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(appliedPayload?.hosts[0]?.label, 'remote-only');
    assert.deepEqual(subject.completedDowngrades, [true]);
    assert.equal(github.remote?.meta.syncSchemaVersion, undefined);
    const verified = await EncryptionService.decryptPayload(github.remote!, 'pw');
    assert.equal(verified.hosts[0]?.label, 'remote-only');
    assert.equal(
      materializeSyncPayloadFromConvergentState(subject.persisted.at(-1)!, { syncedAt: NOW }).hosts[0]?.label,
      'remote-only',
    );
    assert.equal(baselines.github?.materializedPayload.hosts[0]?.label, 'remote-only');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('downgrade folds paused local edits into the joined provider state', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const pausedLocalPayload = payload('paused-local');
    const remote = remoteState(
      base,
      basePayload,
      payload('base', 'remote-user'),
      'remote-device',
      NOW + 1,
    );
    const github = adapter(encryption.register(
      withConvergentSyncEnvelope(remote, { syncedAt: NOW + 1 }),
      4,
      'remote-device',
    ));
    const subject = manager(base, { github });
    let appliedPayload: SyncPayload | null = null;

    const results = await downgradeConvergentSyncImpl.call(
      subject,
      true,
      async () => pausedLocalPayload,
      async (incoming: SyncPayload, commitReplica: () => Promise<void>) => {
        appliedPayload = incoming;
        await commitReplica();
      },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(appliedPayload?.hosts[0]?.label, 'paused-local');
    assert.equal(appliedPayload?.hosts[0]?.username, 'remote-user');
    const verified = await EncryptionService.decryptPayload(github.remote!, 'pw');
    assert.equal(verified.hosts[0]?.label, 'paused-local');
    assert.equal(verified.hosts[0]?.username, 'remote-user');
    const persisted = materializeSyncPayloadFromConvergentState(
      subject.persisted.at(-1)!,
      { syncedAt: NOW },
    );
    assert.equal(persisted.hosts[0]?.label, 'paused-local');
    assert.equal(persisted.hosts[0]?.username, 'remote-user');
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('downgrade preflight failure writes neither local state nor another provider', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const google = adapter(null);
    google.failDownload = true;
    const subject = manager(base, { github, google });
    let applied = false;

    const results = await downgradeConvergentSyncImpl.call(
      subject,
      true,
      async () => localPayload,
      async () => {
        applied = true;
      },
    );

    assert.equal([...results.values()].every((result) => !result.success), true);
    assert.equal(applied, false);
    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(google.uploads, 0);
    assert.deepEqual(subject.completedDowngrades, []);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('failed protected downgrade apply uploads nothing and exits syncing state', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const localPayload = payload('local');
    const base = createConvergentSyncStateFromPayload(localPayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });

    await assert.rejects(
      () => downgradeConvergentSyncImpl.call(
        subject,
        true,
        async () => localPayload,
        async () => {
          throw new Error('protective downgrade apply failed');
        },
      ),
      /protective downgrade apply failed/,
    );

    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(subject.state.syncState, 'ERROR');
    assert.equal(subject.state.pendingLocalSync, true);
    assert.deepEqual(subject.completedDowngrades, []);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('downgrade preserves concurrent provider candidates and blocks legacy writes', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const githubState = remoteState(base, basePayload, payload('github-edit'), 'github-device', NOW + 1);
    const googleState = remoteState(base, basePayload, payload('google-edit'), 'google-device', NOW + 2);
    const github = adapter(encryption.register(
      withConvergentSyncEnvelope(githubState, { syncedAt: NOW + 1 }),
      2,
      'github-device',
    ));
    const google = adapter(encryption.register(
      withConvergentSyncEnvelope(googleState, { syncedAt: NOW + 2 }),
      2,
      'google-device',
    ));
    const subject = manager(base, { github, google });
    let appliedPayload: SyncPayload | null = null;

    const results = await downgradeConvergentSyncImpl.call(
      subject,
      true,
      async () => basePayload,
      async (incoming: SyncPayload, commitReplica: () => Promise<void>) => {
        appliedPayload = incoming;
        await commitReplica();
      },
    );

    assert.equal([...results.values()].every((result) => !result.success), true);
    assert.equal(appliedPayload, null);
    assert.equal(subject.state.convergentConflicts.length, 0);
    assert.equal(subject.state.syncState, 'CONFLICT');
    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(google.uploads, 0);
    assert.deepEqual(subject.completedDowngrades, []);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('conflict resolution and provider propagation share one Web Lock', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    let lockCalls = 0;
    let lockHeld = false;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => {
            lockCalls += 1;
            lockHeld = true;
            try {
              return await callback({});
            } finally {
              lockHeld = false;
            }
          },
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const left = remoteState(base, basePayload, payload('left'), 'left-device', NOW + 1);
    const right = remoteState(base, basePayload, payload('right'), 'right-device', NOW + 2);
    const conflicted = mergeConvergentSyncStates(left, right);
    const conflict = materializeConvergentSyncState(conflicted).conflicts.find(
      (entry) => entry.address.kind === 'entity-field' && entry.address.field === 'label',
    )!;
    const selected = conflict.candidates.find((candidate) => candidate.value === 'left')!;
    const github = adapter(encryption.register(withConvergentSyncEnvelope(conflicted, { syncedAt: NOW }), 2));
    let injected = false;
    github.afterUpload = (file, target) => {
      if (injected) return;
      injected = true;
      const outgoingPayload = encryption.payloads.get(file.payload)!;
      const outgoingState = validateConvergentSyncPayload(file.meta, outgoingPayload)!;
      const outgoingMaterialized = materializeSyncPayloadFromConvergentState(
        outgoingState,
        { syncedAt: NOW },
      );
      const concurrent = remoteState(
        outgoingState,
        outgoingMaterialized,
        payload('left', 'remote-user'),
        'racing-device',
        NOW + 20,
      );
      target.remote = encryption.register(
        withConvergentSyncEnvelope(concurrent, { syncedAt: NOW + 20 }),
        file.meta.version + 1,
        'racing-device',
      );
    };
    const subject = manager(conflicted, { github });
    const appliedPayloads: SyncPayload[] = [];

    const result = await resolveConvergentConflictAndSyncImpl.call(
      subject,
      JSON.stringify(['entity-field', 'hosts', 'host-1', 'label']),
      `${selected.dot.deviceId}:${selected.dot.counter}`,
      async (incoming: SyncPayload, commitReplica: () => Promise<void>) => {
        assert.equal(lockHeld, true);
        appliedPayloads.push(incoming);
        await commitReplica();
      },
    );

    assert.equal(lockCalls, 1);
    assert.equal(result.results.get('github')?.success, true);
    assert.equal(result.payload.hosts[0]?.label, 'left');
    assert.equal(result.payload.hosts[0]?.username, 'remote-user');
    assert.equal(appliedPayloads.length, 2);
    assert.equal(appliedPayloads[0]?.hosts[0]?.username, 'root');
    assert.equal(appliedPayloads[1]?.hosts[0]?.username, 'remote-user');
    assert.equal(subject.state.convergentConflicts.length, 0);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('a failed protected apply publishes neither the resolution replica nor a provider write', async () => {
  const encryption = installEncryptionDouble();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
        },
      },
    });
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const left = remoteState(base, basePayload, payload('left'), 'left-device', NOW + 1);
    const right = remoteState(base, basePayload, payload('right'), 'right-device', NOW + 2);
    const conflicted = mergeConvergentSyncStates(left, right);
    const conflict = materializeConvergentSyncState(conflicted).conflicts.find(
      (entry) => entry.address.kind === 'entity-field' && entry.address.field === 'label',
    )!;
    const selected = conflict.candidates[0]!;
    const github = adapter(encryption.register(withConvergentSyncEnvelope(conflicted, { syncedAt: NOW }), 2));
    const subject = manager(conflicted, { github });

    await assert.rejects(() => resolveConvergentConflictAndSyncImpl.call(
      subject,
      JSON.stringify(['entity-field', 'hosts', 'host-1', 'label']),
      `${selected.dot.deviceId}:${selected.dot.counter}`,
      async () => {
        throw new Error('protective apply failed');
      },
    ), /protective apply failed/);

    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(subject.state.convergentConflicts.length, 1);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    encryption.restore();
  }
});

test('suspicious local shrink is blocked before replica persistence or provider upload', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payloadWithHostCount(6);
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    const emptied = { ...basePayload, hosts: [] };

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      emptied,
      { jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.shrinkBlocked, true);
    assert.equal(subject.persisted.length, 0);
    assert.equal(github.uploads, 0);
    assert.equal(subject.state.syncState, 'BLOCKED');
  } finally {
    encryption.restore();
  }
});

test('one-shot shrink override produces causal deletions and verifies them', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payloadWithHostCount(6);
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const github = adapter(encryption.register(withConvergentSyncEnvelope(base, { syncedAt: NOW }), 2));
    const subject = manager(base, { github });
    subject.state.syncState = 'BLOCKED';
    subject.state.lastShrinkFinding = {
      suspicious: true,
      reason: 'bulk-shrink',
      entityType: 'hosts',
      baseCount: 6,
      outgoingCount: 0,
      lost: 6,
    };
    const emptied = { ...basePayload, hosts: [] };

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      emptied,
      { overrideShrink: true, jitter: async () => {}, now: () => NOW + 10 },
    );

    assert.equal(results.get('github')?.success, true);
    assert.equal(results.get('github')?.mergedPayload, undefined);
    const verifiedPayload = await EncryptionService.decryptPayload(github.remote!, 'pw');
    const verifiedState = validateConvergentSyncPayload(github.remote!.meta, verifiedPayload)!;
    assert.equal(
      materializeSyncPayloadFromConvergentState(verifiedState, { syncedAt: NOW }).hosts.length,
      0,
    );
    assert.equal(subject.state.syncState, 'IDLE');
    assert.equal(subject.state.lastShrinkFinding, undefined);
  } finally {
    encryption.restore();
  }
});

test('all five provider adapters converge independent field edits into one replica', async () => {
  const encryption = installEncryptionDouble();
  try {
    const basePayload = payload('base');
    const base = createConvergentSyncStateFromPayload(basePayload, 'seed', NOW);
    const edits: Array<[CloudProvider, SyncPayload]> = [
      ['github', payload('github-label')],
      ['google', payload('base', 'google-user')],
      ['onedrive', { ...basePayload, hosts: [{ ...basePayload.hosts[0]!, hostname: 'onedrive.example.com' }] }],
      ['webdav', { ...basePayload, hosts: [{ ...basePayload.hosts[0]!, port: 2200 }] }],
      ['s3', { ...basePayload, hosts: [{ ...basePayload.hosts[0]!, tags: ['s3-tag'] }] }],
    ];
    const adapters = Object.fromEntries(edits.map(([provider, edited], index) => {
      const state = remoteState(base, basePayload, edited, `${provider}-device`, NOW + index + 1);
      return [provider, adapter(encryption.register(
        withConvergentSyncEnvelope(state, { syncedAt: NOW }),
        2,
        `${provider}-device`,
      ))];
    })) as Record<CloudProvider, MemoryAdapter>;
    const subject = manager(base, adapters);

    const results = await syncConvergentProvidersUnlockedImpl.call(
      subject,
      basePayload,
      { jitter: async () => {}, now: () => NOW + 20, applyPayload: applyAndCommit },
    );

    assert.equal([...results.values()].every((result) => result.success), true);
    assert.equal(results.size, 5);
    const host = results.get('github')?.mergedPayload?.hosts[0];
    assert.equal(host?.label, 'github-label');
    assert.equal(host?.username, 'google-user');
    assert.equal(host?.hostname, 'onedrive.example.com');
    assert.equal(host?.port, 2200);
    assert.deepEqual(host?.tags, ['s3-tag']);
  } finally {
    encryption.restore();
  }
});
