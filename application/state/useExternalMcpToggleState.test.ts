import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSessionIdleManager } from '../../electron/bridges/mcpServerBridge/sessionIdleManager.cjs';
import { STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS,
  bumpExternalMcpEnableGenerationForTests,
  createExternalMcpStartupSyncPlan,
  getExternalMcpEnableGenerationForTests,
  getExternalMcpStartupReadyWaiterCountForTests,
  isExternalMcpStartupReady,
  markExternalMcpStartupReady,
  normalizeExternalMcpIdleTimeoutMinutes,
  normalizeExternalMcpMode,
  normalizeSessionIdleTimeoutMinutes,
  readExternalMcpFocusOnHostOpen,
  readExternalMcpSilentSessions,
  readExternalMcpStoredEnabled,
  resetExternalMcpStartupReadyForTests,
  resetExternalMcpStartupSyncOnceForTests,
  shouldStartExternalMcpOnStartup,
  shouldWaitForExternalMcpStartupReady,
  syncExternalMcpConfig,
  syncExternalMcpStartupState,
  syncExternalMcpStartupStateOnce,
  waitForExternalMcpStartupReady,
  writeExternalMcpFocusOnHostOpen,
  writeExternalMcpSilentSessions,
} from './useExternalMcpToggleState.ts';

function installMemoryLocalStorage() {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousDispatchEvent = Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent');
  const backing = new Map<string, string>();

  const storage: Storage = {
    get length() { return backing.size; },
    clear() { backing.clear(); },
    getItem(key: string) { return backing.get(key) ?? null; },
    key(index: number) { return Array.from(backing.keys())[index] ?? null; },
    removeItem(key: string) { backing.delete(key); },
    setItem(key: string, value: string) { backing.set(key, value); },
  };

  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'dispatchEvent', { value: () => true, configurable: true });

  return () => {
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
    if (previousDispatchEvent) {
      Object.defineProperty(globalThis, 'dispatchEvent', previousDispatchEvent);
    } else {
      Reflect.deleteProperty(globalThis, 'dispatchEvent');
    }
  };
}

describe('useExternalMcpToggleState helpers', () => {
  it('normalizes mode and idle timeout', () => {
    assert.equal(normalizeExternalMcpMode('persistent'), 'persistent');
    assert.equal(normalizeExternalMcpMode('other'), 'temporary');
    assert.equal(normalizeExternalMcpIdleTimeoutMinutes(null), 10);
    assert.equal(normalizeExternalMcpIdleTimeoutMinutes(0), 1);
    assert.equal(normalizeExternalMcpIdleTimeoutMinutes(99999), 24 * 60);
    assert.equal(normalizeSessionIdleTimeoutMinutes(null), 8 * 60);
    assert.equal(normalizeSessionIdleTimeoutMinutes(0), 1);
  });

  for (const savedMinutes of [null, 30]) {
    it(`syncs the session idle timeout without replacing saved value ${savedMinutes}`, async () => {
      const restore = installMemoryLocalStorage();
      const manager = createSessionIdleManager();
      try {
        assert.equal(manager.getTimeoutMinutes(), 8 * 60, 'main-process default');
        if (savedMinutes !== null) {
          localStorageAdapter.writeNumber(STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES, savedMinutes);
        }
        const expected = savedMinutes ?? manager.getTimeoutMinutes();
        const received: number[] = [];
        const bridge = {
          externalMcpSetConfig: (config: { sessionIdleTimeoutMinutes: number }) => {
            received.push(config.sessionIdleTimeoutMinutes);
            manager.setTimeoutMinutes(config.sessionIdleTimeoutMinutes);
          },
        };
        await syncExternalMcpStartupState(bridge);
        assert.equal(manager.getTimeoutMinutes(), expected, 'startup keeps the intended timeout');
        syncExternalMcpConfig(bridge);
        assert.deepEqual(received, [expected, expected]);
        assert.equal(manager.getTimeoutMinutes(), expected, 'config sync keeps the intended timeout');
        assert.equal(
          localStorageAdapter.readNumber(STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES),
          savedMinutes,
          'sync does not migrate or overwrite the stored preference',
        );
      } finally {
        manager.clearAll();
        restore();
      }
    });
  }

  it('only starts on launch for persistent+enabled', () => {
    assert.equal(shouldStartExternalMcpOnStartup({ enabled: true, mode: 'persistent' }), true);
    assert.equal(shouldStartExternalMcpOnStartup({ enabled: true, mode: 'temporary' }), false);
    assert.equal(shouldStartExternalMcpOnStartup({ enabled: false, mode: 'persistent' }), false);
  });

  it('startup sync plan clears temporary stored enabled', () => {
    const plan = createExternalMcpStartupSyncPlan({
      enabled: true,
      mode: 'temporary',
      idleTimeoutMinutes: 15,
      sessionIdleTimeoutMinutes: 30,
    });
    assert.equal(plan.runtimeEnabled, false);
    assert.equal(plan.storedEnabled, false);
    assert.equal(plan.shouldPersistStoredEnabled, true);
    assert.equal(plan.config.idleTimeoutMinutes, 15);
    assert.equal(plan.config.sessionIdleTimeoutMinutes, 30);
  });

  it('startup sync plan keeps persistent enabled', () => {
    const plan = createExternalMcpStartupSyncPlan({
      enabled: true,
      mode: 'persistent',
      idleTimeoutMinutes: 20,
      sessionIdleTimeoutMinutes: 45,
    });
    assert.equal(plan.runtimeEnabled, true);
    assert.equal(plan.storedEnabled, true);
    assert.equal(plan.shouldPersistStoredEnabled, false);
  });

  it('focus-on-host-open defaults to true and round-trips through storage', () => {
    const restore = installMemoryLocalStorage();
    try {
      assert.equal(readExternalMcpFocusOnHostOpen(), true);
      writeExternalMcpFocusOnHostOpen(false);
      assert.equal(readExternalMcpFocusOnHostOpen(), false);
      writeExternalMcpFocusOnHostOpen(true);
      assert.equal(readExternalMcpFocusOnHostOpen(), true);
    } finally {
      restore();
    }
  });

  it('polls runtime status on a short interval for the top-bar switch', () => {
    assert.equal(EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS, 3000);
  });

  it('silent-sessions defaults to false and round-trips through storage', () => {
    const restore = installMemoryLocalStorage();
    try {
      assert.equal(readExternalMcpSilentSessions(), false);
      writeExternalMcpSilentSessions(true);
      assert.equal(readExternalMcpSilentSessions(), true);
      writeExternalMcpSilentSessions(false);
      assert.equal(readExternalMcpSilentSessions(), false);
    } finally {
      restore();
    }
  });
});

describe('useExternalMcpToggleState runtime poll wiring', () => {
  it('uses the shared poll interval constant', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./useExternalMcpToggleState.ts', import.meta.url), 'utf8'),
    );
    assert.match(source, /EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS = 3000/);
    assert.match(source, /setInterval\([\s\S]*EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS\)/);
    assert.doesNotMatch(source, /setInterval\([\s\S]*,\s*30000\)/);
  });
});


describe('useExternalMcpToggleState startup ready gate', () => {
  it('blocks main-window runtime poll consumers until startup reconcile marks ready', async () => {
    resetExternalMcpStartupReadyForTests();
    assert.equal(isExternalMcpStartupReady(), false);
    assert.equal(shouldWaitForExternalMcpStartupReady(''), true);
    assert.equal(shouldWaitForExternalMcpStartupReady('#/settings'), false);
    assert.equal(shouldWaitForExternalMcpStartupReady('#/tray'), false);
    assert.equal(shouldWaitForExternalMcpStartupReady('#/session-window'), false);

    let resolved = false;
    const pending = waitForExternalMcpStartupReady('').then(() => {
      resolved = true;
    });
    // Single-flight: repeated waits share one waiter.
    const pending2 = waitForExternalMcpStartupReady('');
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(getExternalMcpStartupReadyWaiterCountForTests(), 1);

    markExternalMcpStartupReady();
    await pending;
    await pending2;
    assert.equal(isExternalMcpStartupReady(), true);
    assert.equal(resolved, true);
    assert.equal(getExternalMcpStartupReadyWaiterCountForTests(), 0);
    await waitForExternalMcpStartupReady('');
  });

  it('does not block settings/tray consumers on the App-only gate', async () => {
    resetExternalMcpStartupReadyForTests();
    await waitForExternalMcpStartupReady('#/settings');
    await waitForExternalMcpStartupReady('#/tray');
    assert.equal(isExternalMcpStartupReady(), false);
    assert.equal(getExternalMcpStartupReadyWaiterCountForTests(), 0);
  });

  it('wires App startup reconcile to release the gate after enable settles', async () => {
    const appSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../app/AppSideEffects.tsx', import.meta.url), 'utf8'),
    );
    const hookSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./useExternalMcpToggleState.ts', import.meta.url), 'utf8'),
    );
    assert.match(appSource, /await syncExternalMcpStartupStateOnce\(netcattyBridge\.get\(\)\)/);
    assert.match(appSource, /markExternalMcpStartupReady\(\)/);
    assert.ok(
      appSource.indexOf('await syncExternalMcpStartupStateOnce(netcattyBridge.get())')
        < appSource.indexOf('markExternalMcpStartupReady()'),
      'startup ready must be marked only after await syncExternalMcpStartupStateOnce',
    );
    assert.match(hookSource, /export async function syncExternalMcpStartupState/);
    assert.match(hookSource, /await Promise\.resolve\(bridge\?\.externalMcpSetEnabled\?\.\(plan\.runtimeEnabled\)\)/);
    assert.match(hookSource, /shouldWaitForExternalMcpStartupReady/);
    assert.match(hookSource, /!status\.enabled && !status\.error/);
    assert.match(hookSource, /if \(isPeerSessionWindow \|\| !enabled\) return;/);
  });

  it('restores saved permission before enabling persistent External MCP', async () => {
    const restore = installMemoryLocalStorage();
    try {
      const storageKeys = await import('../../infrastructure/config/storageKeys.ts');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'true');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_PERMISSION_MODE, 'auto');

      const calls: string[] = [];
      await syncExternalMcpStartupState({
        aiMcpSetPermissionMode: async (mode) => {
          calls.push(`permission:${mode}`);
          return { ok: true };
        },
        externalMcpSetConfig: async () => {
          calls.push('config');
          return { ok: true };
        },
        externalMcpSetEnabled: async (enabled) => {
          calls.push(`enabled:${enabled}`);
          return { ok: true, enabled };
        },
      });

      assert.deepEqual(calls, ['permission:auto', 'config', 'enabled:true']);
    } finally {
      restore();
    }
  });

  it('re-reads storage after config await so concurrent top-bar toggles win', async () => {
    const restore = installMemoryLocalStorage();
    try {
      const storageKeys = await import('../../infrastructure/config/storageKeys.ts');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'true');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');

      let enabledCalls: boolean[] = [];
      const plan = await syncExternalMcpStartupState({
        externalMcpSetConfig: async () => {
          // Simulate a user turning the top-bar switch off while config sync is in flight.
          globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'false');
          return { ok: true };
        },
        externalMcpSetEnabled: async (enabled) => {
          enabledCalls.push(enabled);
          return { ok: true, enabled };
        },
      });

      assert.equal(plan.runtimeEnabled, false);
      assert.deepEqual(enabledCalls, [false]);
      assert.equal(readExternalMcpStoredEnabled(), false);
    } finally {
      restore();
    }
  });

  it('keeps stored switch when startup enable reports disabled with error', async () => {
    const restore = installMemoryLocalStorage();
    try {
      const storageKeys = await import('../../infrastructure/config/storageKeys.ts');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'true');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');
      assert.equal(readExternalMcpStoredEnabled(), true);

      const plan = await syncExternalMcpStartupState({
        externalMcpSetConfig: async () => ({ ok: true }),
        externalMcpSetEnabled: async () => ({ ok: true, enabled: false, state: 'error', error: 'boom' }),
      });

      assert.equal(plan.runtimeEnabled, true);
      assert.equal(plan.storedEnabled, true);
      assert.equal(readExternalMcpStoredEnabled(), true);
    } finally {
      restore();
    }
  });
});

describe('syncExternalMcpStartupStateOnce single-flight', () => {
  it('reaches the bridge once when the startup effect is invoked twice', async () => {
    const restore = installMemoryLocalStorage();
    try {
      resetExternalMcpStartupReadyForTests();
      resetExternalMcpStartupSyncOnceForTests();
      const storageKeys = await import('../../infrastructure/config/storageKeys.ts');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'true');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');

      const configCalls: unknown[] = [];
      const enabledCalls: boolean[] = [];
      const bridge = {
        externalMcpSetConfig: async (config: unknown) => {
          configCalls.push(config);
          return { ok: true };
        },
        externalMcpSetEnabled: async (enabled: boolean) => {
          enabledCalls.push(enabled);
          return { ok: true, enabled };
        },
      };

      // Mount, cleanup, mount again: both effect runs share one reconcile.
      const first = syncExternalMcpStartupStateOnce(bridge);
      const second = syncExternalMcpStartupStateOnce(bridge);
      assert.equal(first, second);

      const [firstPlan, secondPlan] = await Promise.all([first, second]);
      assert.equal(firstPlan, secondPlan);
      assert.equal(firstPlan.runtimeEnabled, true);
      assert.equal(configCalls.length, 1);
      assert.deepEqual(enabledCalls, [true]);

      // A later remount awaits the settled promise instead of re-sending IPC.
      await syncExternalMcpStartupStateOnce(bridge);
      assert.equal(configCalls.length, 1);
      assert.deepEqual(enabledCalls, [true]);
    } finally {
      resetExternalMcpStartupSyncOnceForTests();
      restore();
    }
  });
});

describe('syncExternalMcpStartupState generation guard', () => {
  it('skips stale startup enable after concurrent top-bar toggle generation bump', async () => {
    const restore = installMemoryLocalStorage();
    try {
      resetExternalMcpStartupReadyForTests();
      const storageKeys = await import('../../infrastructure/config/storageKeys.ts');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'true');
      globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');

      const enabledCalls: boolean[] = [];
      const plan = await syncExternalMcpStartupState({
        externalMcpSetConfig: async () => {
          // Simulate a top-bar toggle landing during config await.
          globalThis.localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'false');
          bumpExternalMcpEnableGenerationForTests();
          return { ok: true };
        },
        externalMcpSetEnabled: async (enabled) => {
          enabledCalls.push(enabled);
          return { ok: true, enabled };
        },
      });

      assert.equal(plan.runtimeEnabled, false);
      // Generation changed during config await, so stale startup enable is skipped.
      assert.deepEqual(enabledCalls, []);
      assert.equal(readExternalMcpStoredEnabled(), false);
      assert.ok(getExternalMcpEnableGenerationForTests() > 0);
    } finally {
      restore();
    }
  });
});
