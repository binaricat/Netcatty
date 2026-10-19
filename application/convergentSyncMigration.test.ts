import { installBrowserLockFixture } from "./testSupport/browserLockFixture";
import assert from 'node:assert/strict';
import test from 'node:test';

import type { SyncPayload } from '../domain/sync.ts';
import type { CloudSyncManager } from '../infrastructure/services/CloudSyncManager.ts';

installBrowserLockFixture();

const NOW = 1_700_000_000_000;
const localStorageValues = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
    removeItem: (key: string) => localStorageValues.delete(key),
    clear: () => localStorageValues.clear(),
  },
});

const {
  planConvergentSyncMigration,
  stripConvergentSyncEnvelope,
} = await import('../domain/convergentSync/index.ts');
const { getConvergentSyncLocalConfig } = await import('../infrastructure/services/convergentSyncConfig.ts');
const {
  initializePreparedConvergentMigration,
  prepareConvergentSyncMigration,
} = await import('./convergentSyncMigration.ts');

function payload(): SyncPayload {
  return {
    hosts: [],
    keys: [],
    snippets: [],
    customGroups: [],
    syncedAt: NOW,
  };
}

test.beforeEach(() => {
  localStorageValues.clear();
});

test('preparation seeds a trusted baseline for an unchanged v1 provider', async () => {
  const remotePayload: SyncPayload = {
    ...payload(),
    hosts: [{
      id: 'host-1',
      label: 'Legacy host',
      hostname: 'legacy.example.com',
      port: 22,
      username: 'root',
      tags: [],
      os: 'linux',
    }],
  };
  const manager = {
    isUnlocked: () => true,
    getAllProviders: () => ({
      github: { provider: 'github', status: 'connected' },
    }),
    loadConvergentProviderBaseline: async () => null,
    loadSyncBase: async () => null,
    downloadFromProvider: async () => ({
      provider: 'github',
      payload: remotePayload,
      remoteFile: {
        meta: {
          version: 7,
          updatedAt: NOW - 1,
          deviceId: 'legacy-device',
          deviceName: 'Legacy device',
          appVersion: '1.0.0',
          iv: '',
          salt: '',
          algorithm: 'AES-256-GCM',
          kdf: 'PBKDF2',
          kdfIterations: 1,
        },
        payload: 'ciphertext',
      },
    }),
    getState: () => ({ deviceId: 'local-device' }),
  } as unknown as CloudSyncManager;

  const prepared = await prepareConvergentSyncMigration(payload(), manager, NOW);

  assert.equal(prepared.plan.preview.canInitialize, true);
  assert.equal(prepared.providerBaselines.length, 1);
  const baseline = prepared.providerBaselines[0]!;
  assert.equal(baseline.provider, 'github');
  assert.equal(baseline.remoteVersion, 7);
  assert.equal(baseline.remoteDeviceId, 'legacy-device');
  assert.deepEqual(baseline.materializedPayload, remotePayload);
  assert.deepEqual(baseline.state, prepared.plan.state);
});

test('initialization applies the protected preview before persisting and enabling the replica', async () => {
  const localPayload = payload();
  const liveLocalPayload = { ...payload(), knownHosts: [] };
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [],
    deviceId: 'device-a',
    now: NOW,
  });
  assert.equal(plan.preview.canInitialize, true);
  const calls: string[] = [];
  const manager = {
    isUnlocked: () => true,
    withConvergentSyncLock: async (task: () => Promise<void>) => {
      calls.push('lock');
      return task();
    },
    saveConvergentReplica: async () => {
      calls.push('replica');
    },
    saveConvergentProviderBaseline: async () => {
      calls.push('baseline');
    },
    syncConvergentProvidersUnderLock: async (incoming: SyncPayload) => {
      calls.push('publish');
      assert.equal(incoming.convergentSync?.schemaVersion, 2);
      return new Map();
    },
  } as unknown as CloudSyncManager;

  await initializePreparedConvergentMigration({
    prepared: { plan, providerBaselines: [], localSnapshot: localPayload },
    manager,
    now: NOW,
    buildCurrentPayload: () => localPayload,
    buildPreApplyPayload: () => {
      calls.push('snapshot');
      return liveLocalPayload;
    },
    translateProtectiveBackupFailure: (message) => message,
    preparePayloadApply: async (incoming) => async () => {
      calls.push('apply');
      assert.equal(incoming.convergentSync?.schemaVersion, 2);
    },
    runProtectedApply: async (options) => {
      calls.push('protect');
      if (!options.prepareApply) throw new Error('Expected prepared migration apply');
      const apply = await options.prepareApply();
      assert.equal(options.buildPreApplyPayload(), liveLocalPayload);
      await apply();
    },
  });

  assert.deepEqual(calls, ['lock', 'protect', 'snapshot', 'apply', 'replica', 'publish']);
  assert.deepEqual(getConvergentSyncLocalConfig(), { enabled: true, initialized: true });
});

test('initialization applies a concurrent provider merge before releasing the migration lock', async () => {
  const localPayload = payload();
  const mergedPayload: SyncPayload = {
    ...payload(),
    hosts: [{
      id: 'remote-host',
      label: 'Remote host',
      hostname: 'remote.example.com',
      port: 22,
      username: 'root',
      tags: [],
      os: 'linux',
    }],
  };
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [],
    deviceId: 'device-a',
    now: NOW,
  });
  const applied: SyncPayload[] = [];
  let currentPayload = localPayload;
  let lockHeld = false;
  const manager = {
    isUnlocked: () => true,
    withConvergentSyncLock: async (task: () => Promise<void>) => {
      lockHeld = true;
      try {
        return await task();
      } finally {
        lockHeld = false;
      }
    },
    saveConvergentReplica: async () => {},
    saveConvergentProviderBaseline: async () => {},
    syncConvergentProvidersUnderLock: async (_incoming, applyPayload) => {
      assert.equal(lockHeld, true);
      await applyPayload(mergedPayload, async () => {});
      return new Map([[
        'github',
        {
          success: true,
          provider: 'github',
          action: 'merge',
          mergedPayload,
          mergedPayloadApplied: true,
        },
      ]]);
    },
  } as unknown as CloudSyncManager;

  await initializePreparedConvergentMigration({
    prepared: { plan, providerBaselines: [], localSnapshot: localPayload },
    manager,
    now: NOW,
    buildCurrentPayload: () => currentPayload,
    buildPreApplyPayload: () => currentPayload,
    translateProtectiveBackupFailure: (message) => message,
    preparePayloadApply: async (incoming) => async () => {
      assert.equal(lockHeld, true);
      applied.push(incoming);
      currentPayload = stripConvergentSyncEnvelope(incoming);
    },
    runProtectedApply: async (options) => {
      if (!options.prepareApply) throw new Error('Expected prepared migration apply');
      const apply = await options.prepareApply();
      await apply();
    },
  });

  assert.equal(applied.length, 2);
  assert.equal(applied[0]?.convergentSync?.schemaVersion, 2);
  assert.equal(applied[1]?.hosts[0]?.label, 'Remote host');
  assert.equal(lockHeld, false);
});

test('initialization rejects a stale preview before backup or apply', async () => {
  const localPayload = payload();
  const changedPayload: SyncPayload = {
    ...payload(),
    hosts: [{
      id: 'host-after-preview',
      label: 'Added after preview',
      hostname: 'new.example.com',
      port: 22,
      username: 'root',
      tags: [],
      os: 'linux',
    }],
  };
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [],
    deviceId: 'device-a',
    now: NOW,
  });
  let protectedApplyEntered = false;
  let applied = false;
  const manager = {
    isUnlocked: () => true,
    withConvergentSyncLock: async (task: () => Promise<void>) => task(),
  } as unknown as CloudSyncManager;

  await assert.rejects(
    () => initializePreparedConvergentMigration({
      prepared: { plan, providerBaselines: [], localSnapshot: localPayload },
      manager,
      buildCurrentPayload: () => changedPayload,
      buildPreApplyPayload: () => changedPayload,
      translateProtectiveBackupFailure: (message) => message,
      preparePayloadApply: async () => async () => {
        applied = true;
      },
      runProtectedApply: async (options) => {
        protectedApplyEntered = true;
        if (!options.prepareApply) throw new Error('Expected prepared migration apply');
        await options.prepareApply();
      },
    }),
    /changed after the migration preview/i,
  );

  assert.equal(protectedApplyEntered, true);
  assert.equal(applied, false);
  assert.deepEqual(getConvergentSyncLocalConfig(), { enabled: false, initialized: false });
});

test('blocked previews cannot enter the protected initialization transaction', async () => {
  const localPayload = payload();
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [{ provider: 'github', status: 'unavailable', message: 'offline' }],
    deviceId: 'device-a',
    now: NOW,
  });
  let entered = false;

  await assert.rejects(
    () => initializePreparedConvergentMigration({
      prepared: { plan, providerBaselines: [], localSnapshot: localPayload },
      manager: {} as CloudSyncManager,
      buildCurrentPayload: () => localPayload,
      buildPreApplyPayload: () => localPayload,
      translateProtectiveBackupFailure: (message) => message,
      preparePayloadApply: async () => async () => {},
      runProtectedApply: async () => {
        entered = true;
      },
    }),
    /migration is blocked/,
  );
  assert.equal(entered, false);
  assert.deepEqual(getConvergentSyncLocalConfig(), { enabled: false, initialized: false });
});

test('a locked manager cannot enter the protected initialization transaction', async () => {
  const localPayload = payload();
  const plan = planConvergentSyncMigration({
    localPayload,
    localTrustedBaseline: null,
    providers: [],
    deviceId: 'device-a',
    now: NOW,
  });
  let entered = false;
  let applied = false;
  let snapshotBuilt = false;
  const manager = {
    isUnlocked: () => false,
  } as unknown as CloudSyncManager;

  await assert.rejects(
    () => initializePreparedConvergentMigration({
      prepared: { plan, providerBaselines: [], localSnapshot: localPayload },
      manager,
      buildCurrentPayload: () => localPayload,
      buildPreApplyPayload: () => {
        snapshotBuilt = true;
        return localPayload;
      },
      translateProtectiveBackupFailure: (message) => message,
      preparePayloadApply: async () => async () => {
        applied = true;
      },
      runProtectedApply: async () => {
        entered = true;
      },
    }),
    /Unlock cloud sync before initializing convergent migration/,
  );

  assert.equal(entered, false);
  assert.equal(snapshotBuilt, false);
  assert.equal(applied, false);
  assert.deepEqual(getConvergentSyncLocalConfig(), { enabled: false, initialized: false });
});

for (const failDuringPublish of [false, true]) {
  test(`migration header failure precedes protected writes (${failDuringPublish ? 'publish' : 'initialize'})`, async () => {
    const { prepareSyncPayloadApply } = await import('./syncPayload.ts');
    const { readInterruptedVaultApply } = await import('./localVaultBackups.ts');
    const headers = { ai: { providers: [{ id: 'custom', customHeaders: { 'X-Tenant': 'secret' } }] } };
    const localPayload: SyncPayload = { ...payload(), ...(failDuringPublish ? {} : { settings: headers }) };
    let currentPayload = localPayload;
    let imports = 0;
    let replicaCommits = 0;
    let snapshots = 0;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      netcatty: { credentialsEncrypt: async () => {
        assert.equal(readInterruptedVaultApply(), null);
        throw new Error('keychain locked');
      } },
      dispatchEvent: () => true,
    } });
    const plan = planConvergentSyncMigration({
      localPayload, localTrustedBaseline: null, providers: [], deviceId: 'device-a', now: NOW,
    });
    const manager = {
      isUnlocked: () => true,
      withConvergentSyncLock: async (task: () => Promise<void>) => task(),
      saveConvergentReplica: async () => { replicaCommits++; },
      saveConvergentProviderBaseline: async () => {},
      syncConvergentProvidersUnderLock: async (
        _incoming: SyncPayload,
        apply: (incoming: SyncPayload, commit: () => Promise<void>) => Promise<void>,
      ) => {
        await apply({ ...currentPayload, settings: headers }, async () => { replicaCommits++; });
        return new Map();
      },
    } as unknown as CloudSyncManager;
    await assert.rejects(initializePreparedConvergentMigration({
      prepared: { plan, providerBaselines: [], localSnapshot: localPayload }, manager, now: NOW,
      buildCurrentPayload: () => currentPayload,
      buildPreApplyPayload: () => { snapshots++; return payload(); },
      translateProtectiveBackupFailure: (message) => message,
      preparePayloadApply: async (incoming) => {
        const apply = await prepareSyncPayloadApply(incoming, { importVaultData: () => { imports++; } });
        return async () => {
          await apply();
          currentPayload = stripConvergentSyncEnvelope(incoming);
        };
      },
    }));
    assert.equal(readInterruptedVaultApply(), null);
    assert.equal(imports, failDuringPublish ? 1 : 0);
    assert.equal(replicaCommits, failDuringPublish ? 1 : 0);
    assert.equal(snapshots, failDuringPublish ? 1 : 0);
  });
}
