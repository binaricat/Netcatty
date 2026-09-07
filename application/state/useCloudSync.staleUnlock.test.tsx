import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createDomRenderer, flushEffects, installDomEnvironment } from '../../components/test-support/renderReactDom';
import { EncryptionService } from '../../infrastructure/services/EncryptionService';
import type { SyncManagerState } from '../../infrastructure/services/CloudSyncManager';
import type { SyncPayload } from '../../domain/sync';

test('manual sync does not clear a newly shared password when an older unlock is superseded', async (t) => {
  const env = installDomEnvironment();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: env.window.localStorage });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  let sharedPassword: string | undefined;
  let clears = 0;
  Object.defineProperty(env.window, 'netcatty', { configurable: true, value: {
    cloudSyncGetSessionPassword: async () => sharedPassword,
    cloudSyncClearSessionPassword: async () => { clears += 1; sharedPassword = undefined; },
  } });
  const { getCloudSyncManager } = await import('../../infrastructure/services/CloudSyncManager');
  const manager = getCloudSyncManager();
  await manager.setupMasterKey('old-fixture-password');
  manager.lock();
  const newConfig = await EncryptionService.createMasterKeyConfig('new-fixture-password');
  const { useCloudSync } = await import('./useCloudSync');
  let current!: ReturnType<typeof useCloudSync>;
  const Probe = () => { current = useCloudSync(); return null; };
  const renderer = await createDomRenderer(env.document);
  const originalUnlock = EncryptionService.unlockMasterKey;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  try {
    await renderer.render(<Probe />);
    await flushEffects();
    EncryptionService.unlockMasterKey = async (...args) => {
      started();
      await gate;
      return originalUnlock(...args);
    };
    sharedPassword = 'old-fixture-password';
    const result = current.syncNow({} as SyncPayload).then(() => null, (error: unknown) => error);
    await entered;
    const state = Reflect.get(manager, 'state') as SyncManagerState;
    state.masterKeyConfig = newConfig;
    Reflect.get(manager, 'bumpSyncSecurityGeneration').call(manager);
    sharedPassword = 'new-fixture-password';
    release();
    const error = await result;
    assert.equal(clears, 0, 'stale work must not erase the new shared password');
    assert.equal(sharedPassword, 'new-fixture-password');
    assert.ok(error instanceof Error);
    assert.match(error.message, /changed while unlocking/i);
  } finally {
    release();
    EncryptionService.unlockMasterKey = originalUnlock;
    await renderer.unmount();
    manager.destroy();
    env.cleanup();
  }
});
