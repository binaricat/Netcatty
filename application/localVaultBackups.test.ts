import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { SyncPayload } from '../domain/sync.ts';

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
  applyProtectedSyncPayload,
  readInterruptedVaultApply,
} = await import('./localVaultBackups.ts');

function emptyPayload(): SyncPayload {
  return {
    hosts: [],
    keys: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
  };
}

test.beforeEach(() => {
  localStorageValues.clear();
});

test('protected apply preparation failure does not leave a partial-apply sentinel', async () => {
  let snapshotBuilt = false;

  await assert.rejects(
    () => applyProtectedSyncPayload({
      buildPreApplyPayload: () => {
        snapshotBuilt = true;
        return emptyPayload();
      },
      prepareApply: async () => {
        throw new Error('replica unavailable');
      },
      translateProtectiveBackupFailure: (message) => message,
    }),
    /replica unavailable/,
  );

  assert.equal(snapshotBuilt, false);
  assert.equal(readInterruptedVaultApply(), null);
});

test('prepared apply callback runs after the snapshot with sentinel protection', async () => {
  const calls: string[] = [];
  let observedSentinel = false;

  await applyProtectedSyncPayload({
    buildPreApplyPayload: () => {
      calls.push('snapshot');
      return emptyPayload();
    },
    prepareApply: async () => {
      calls.push('prepare');
      return async () => {
        calls.push('apply');
        observedSentinel = readInterruptedVaultApply() !== null;
      };
    },
    translateProtectiveBackupFailure: (message) => message,
  });

  assert.deepEqual(calls, ['prepare', 'snapshot', 'apply']);
  assert.equal(observedSentinel, true);
  assert.equal(readInterruptedVaultApply(), null);
});

for (const localRestore of [false, true]) {
  for (const encryptionFails of [false, true]) {
    test(`protected header preparation (${localRestore ? 'restore' : 'sync'}, ${encryptionFails ? 'failure' : 'success'})`, async () => {
      const { prepareSyncPayloadApply, prepareLocalVaultPayloadApply } = await import('./syncPayload.ts');
      const { STORAGE_KEY_THEME, STORAGE_KEY_AI_PROVIDERS } = await import('../infrastructure/config/storageKeys.ts');
      const sealed = `enc:v1:${Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 4)]).toString('base64')}`;
      const calls: string[] = [];
      Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        netcatty: { credentialsEncrypt: async () => {
          calls.push('encrypt');
          assert.equal(readInterruptedVaultApply(), null);
          if (encryptionFails) throw new Error('keychain locked');
          return sealed;
        } },
        dispatchEvent: () => true,
      } });
      localStorageValues.set(STORAGE_KEY_THEME, 'light');
      const payload: SyncPayload = { ...emptyPayload(), settings: {
        theme: 'dark', ai: { providers: [{ id: 'custom', customHeaders: { 'X-Tenant': 'secret' } }] },
      } };
      const original = JSON.stringify(payload);
      const importers = { importVaultData: () => {
        calls.push('import');
        assert.notEqual(readInterruptedVaultApply(), null);
      } };
      const applying = applyProtectedSyncPayload({
        buildPreApplyPayload: () => { calls.push('snapshot'); return emptyPayload(); },
        prepareApply: () => localRestore
          ? prepareLocalVaultPayloadApply(payload, importers, { prepareConvergentRestore: async () => {
            calls.push('prepareReplica');
            return async () => { calls.push('commitReplica'); };
          } })
          : prepareSyncPayloadApply(payload, importers),
        translateProtectiveBackupFailure: (message) => message,
      });
      if (encryptionFails) {
        await assert.rejects(applying);
        assert.deepEqual(calls, ['encrypt']);
        assert.equal(localStorageValues.get(STORAGE_KEY_THEME), 'light');
        assert.equal(localStorageValues.has(STORAGE_KEY_AI_PROVIDERS), false);
      } else {
        await applying;
        assert.deepEqual(calls, localRestore
          ? ['encrypt', 'prepareReplica', 'snapshot', 'import', 'commitReplica']
          : ['encrypt', 'snapshot', 'import']);
        assert.equal(localStorageValues.get(STORAGE_KEY_THEME), 'dark');
        assert.equal(JSON.parse(localStorageValues.get(STORAGE_KEY_AI_PROVIDERS)!)[0].customHeaders['X-Tenant'], sealed);
      }
      assert.equal(readInterruptedVaultApply(), null);
      assert.equal(JSON.stringify(payload), original);
    });
  }
}

function installBackupLocks(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let readers = 0;
  let writer: Promise<void> | null = null;
  const locks = {
    async request(_name: string, options: { mode: string; ifAvailable?: boolean }, callback: (lock: object | null) => Promise<unknown>) {
      if (options.mode === 'shared') {
        if (writer) await writer;
        readers += 1;
        try { return await callback({}); } finally { readers -= 1; }
      }
      assert.equal(options.ifAvailable, true, 'cleanup must refuse rather than queue behind a restore');
      if (readers || writer) return callback(null);
      let release!: () => void;
      writer = new Promise<void>((resolve) => { release = resolve; });
      try { return await callback({}); } finally { writer = null; release(); }
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}

function installClearBridge(t: TestContext, clearVaultBackups: () => Promise<unknown>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { netcatty: { clearVaultBackups } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
}

test('cleanup refuses while another restore is applying, including nested restore helpers', async (t) => {
  installBackupLocks(t);
  const { clearLocalVaultBackups, withRestoreBarrier, LocalVaultBackupBusyError } = await import('./localVaultBackups.ts');
  let clears = 0;
  installClearBridge(t, async () => { clears += 1; });
  let finish!: () => void;
  let entered!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const restoring = withRestoreBarrier(() => withRestoreBarrier(async () => { entered(); await gate; }));
  await active;
  try {
    await assert.rejects(clearLocalVaultBackups(), LocalVaultBackupBusyError);
    assert.equal(clears, 0);
  } finally {
    finish();
    await restoring;
  }
  await clearLocalVaultBackups();
  assert.equal(clears, 1);
});

test('restore waits for an in-progress cleanup before reading or applying data', async (t) => {
  installBackupLocks(t);
  const { clearLocalVaultBackups, withRestoreBarrier } = await import('./localVaultBackups.ts');
  let finish!: () => void;
  let entered!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  installClearBridge(t, async () => { entered(); await gate; });
  const clearing = clearLocalVaultBackups();
  await active;
  let applied = false;
  const restoring = withRestoreBarrier(async () => { applied = true; });
  await Promise.resolve();
  assert.equal(applied, false);
  finish();
  await Promise.all([clearing, restoring]);
  assert.equal(applied, true);
});

test('cleanup retains recovery backups after an interrupted protected apply', async (t) => {
  installBackupLocks(t);
  const { clearLocalVaultBackups, LocalVaultBackupBusyError } = await import('./localVaultBackups.ts');
  const { STORAGE_KEY_VAULT_APPLY_IN_PROGRESS } = await import('../infrastructure/config/storageKeys.ts');
  let clears = 0;
  installClearBridge(t, async () => { clears += 1; });
  localStorageValues.set(STORAGE_KEY_VAULT_APPLY_IN_PROGRESS, JSON.stringify({ startedAt: Date.now(), protectiveBackupId: 'recovery' }));
  await assert.rejects(clearLocalVaultBackups(), LocalVaultBackupBusyError);
  assert.equal(clears, 0);
});
