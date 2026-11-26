import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSessionIdleManager } from '../../electron/bridges/mcpServerBridge/sessionIdleManager.cjs';
import { STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES, STORAGE_KEY_AI_PRIVACY, STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION, STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, STORAGE_KEY_AI_EXTERNAL_MCP_MODE } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  readExternalMcpHttpAllowCustomBind,
  readExternalMcpHttpEnabled,
  readExternalMcpHttpListenAddress,
  readExternalMcpHttpPort,
  readExternalMcpHttpSettings,
  writeExternalMcpHttpAllowCustomBind,
  writeExternalMcpHttpEnabled,
  writeExternalMcpHttpListenAddress,
  writeExternalMcpHttpPort,
} from "./useExternalMcpToggleState.ts";
import {
  EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS,
  applyAIPrivacySettings,
  readAIPrivacySettings,
  applyExternalMcpRedactionSettings,
  readExternalMcpRedactionSettings,
  bumpExternalMcpEnableGenerationForTests,
  createExternalMcpStartupSyncPlan,
  getExternalMcpEnableGenerationForTests,
  getExternalMcpStartupReadyWaiterCountForTests,
  isExternalMcpStartupReady,
  markExternalMcpStartupReady,
  normalizeExternalMcpApprovalAlertMode,
  normalizeExternalMcpIdleTimeoutMinutes,
  normalizeExternalMcpMode,
  normalizeSessionIdleTimeoutMinutes,
  readExternalMcpApprovalAlertMode,
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
  writeExternalMcpApprovalAlertMode,
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
    assert.equal(normalizeExternalMcpApprovalAlertMode(null), 'unfocused');
    assert.equal(normalizeExternalMcpApprovalAlertMode('always'), 'always');
    assert.equal(normalizeExternalMcpApprovalAlertMode('nope'), 'unfocused');
  });

  it('stores the approval alert preference and defaults to unfocused', () => {
    const restore = installMemoryLocalStorage();
    try {
      assert.equal(readExternalMcpApprovalAlertMode(), 'unfocused');
      assert.equal(writeExternalMcpApprovalAlertMode('off'), 'off');
      assert.equal(readExternalMcpApprovalAlertMode(), 'off');
      assert.equal(writeExternalMcpApprovalAlertMode('always'), 'always');
      assert.equal(readExternalMcpApprovalAlertMode(), 'always');
    } finally {
      restore();
    }
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
            return { ok: true };
          },
        };
        await syncExternalMcpStartupState(bridge);
        assert.equal(manager.getTimeoutMinutes(), expected, 'startup keeps the intended timeout');
        await syncExternalMcpConfig(bridge);
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

describe("external MCP HTTP settings", () => {
  it("defaults HTTP off on loopback and round-trips the explicit listen option", () => {
    const restore = installMemoryLocalStorage();
    try {
      assert.deepEqual(readExternalMcpHttpSettings(), {
        enabled: false,
        port: 47391,
        allowCustomBind: false,
        listenAddress: "0.0.0.0",
        clientHost: "",
      });
      assert.equal(readExternalMcpHttpEnabled(), false);
      writeExternalMcpHttpEnabled(true);
      assert.equal(writeExternalMcpHttpPort(80), 47391);
      assert.equal(writeExternalMcpHttpPort(48080), 48080);
      writeExternalMcpHttpAllowCustomBind(true);
      writeExternalMcpHttpListenAddress("172.22.0.1");
      assert.equal(readExternalMcpHttpEnabled(), true);
      assert.equal(readExternalMcpHttpPort(), 48080);
      assert.equal(readExternalMcpHttpAllowCustomBind(), true);
      assert.equal(readExternalMcpHttpListenAddress(), "172.22.0.1");
    } finally {
      restore();
    }
  });
});


describe('Shared AI privacy settings', () => {
  const settings = {
    enabled: true,
    redactPrivateIps: true,
    cidrs: ['192.0.2.0/24'],
    patterns: ['INTERNAL_[A-Z0-9]+'],
  };

  it('defaults off and persists only after successful bridge validation', async () => {
    const restore = installMemoryLocalStorage();
    try {
      assert.deepEqual(readExternalMcpRedactionSettings(), {
        enabled: false, redactPrivateIps: false, cidrs: [], patterns: [],
      });
      let resolveConfig: (value: unknown) => void;
      const apply = applyExternalMcpRedactionSettings(settings, {
        externalMcpSetConfig: async (config) => {
          assert.deepEqual(config, { redaction: settings });
          return new Promise((resolve) => { resolveConfig = resolve; });
        },
      });
      assert.equal(localStorageAdapter.readString(STORAGE_KEY_AI_PRIVACY), null);
      resolveConfig!({ ok: true });
      await apply;
      assert.deepEqual(readExternalMcpRedactionSettings(), settings);
      assert.deepEqual(localStorageAdapter.read(STORAGE_KEY_AI_PRIVACY), settings);
      assert.equal(localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION), null);
    } finally {
      restore();
    }
  });

  it('reads legacy privacy preferences until a validated shared preference is applied', async () => {
    const restore = installMemoryLocalStorage();
    try {
      localStorageAdapter.write(STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION, settings);
      assert.deepEqual(readAIPrivacySettings(), settings);
      assert.equal(localStorageAdapter.readString(STORAGE_KEY_AI_PRIVACY), null, 'reads must not migrate or discard data');
      const changed = { ...settings, redactPrivateIps: false };
      await applyAIPrivacySettings(changed, { externalMcpSetConfig: async () => ({ ok: true }) });
      assert.deepEqual(readAIPrivacySettings(), changed);
      assert.deepEqual(readExternalMcpRedactionSettings(), changed, 'legacy API must read the same shared policy');
      assert.deepEqual(localStorageAdapter.read(STORAGE_KEY_AI_PRIVACY), changed);
      assert.deepEqual(localStorageAdapter.read(STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION), settings, 'keep legacy storage intact');
    } finally {
      restore();
    }
  });

  it('never falls back to legacy settings when a shared preference exists, even if corrupt', () => {
    const restore = installMemoryLocalStorage();
    try {
      localStorageAdapter.write(STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION, settings);
      const disabled = { enabled: false, redactPrivateIps: false, cidrs: [], patterns: [] };
      localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, disabled);
      assert.deepEqual(readAIPrivacySettings(), disabled);
      localStorageAdapter.writeString(STORAGE_KEY_AI_PRIVACY, '{');
      assert.throws(readAIPrivacySettings, /Invalid saved AI privacy settings/);
      localStorageAdapter.remove(STORAGE_KEY_AI_PRIVACY);
      localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_REDACTION, '{');
      assert.throws(readAIPrivacySettings, /Invalid saved AI privacy settings/);
    } finally {
      restore();
    }
  });

  it('restores the shared policy even when External MCP is disabled', async () => {
    const restore = installMemoryLocalStorage();
    try {
      resetExternalMcpStartupReadyForTests();
      localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, false);
      localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, settings);
      const calls: string[] = [];
      const plan = await syncExternalMcpStartupState({
        externalMcpSetConfig: async (config) => {
          assert.deepEqual(config.redaction, settings);
          calls.push('shared-policy');
          return { ok: true };
        },
        externalMcpSetEnabled: async (enabled) => { calls.push(`external:${enabled}`); },
      });
      assert.deepEqual(calls, ['shared-policy', 'external:false']);
      assert.equal(plan.runtimeEnabled, false);
      assert.deepEqual(readAIPrivacySettings(), settings);
    } finally {
      restore();
    }
  });

  it('does not persist rejected, unverified or failed privacy changes', async () => {
    const restore = installMemoryLocalStorage();
    try {
      localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, settings);
      const changed = { ...settings, patterns: ['['] };
      for (const result of [{ ok: false, error: 'Invalid regular expression' }, { ok: false, error: '' }, undefined, {}]) {
        await assert.rejects(applyExternalMcpRedactionSettings(changed, {
          externalMcpSetConfig: async () => result,
        }));
        assert.deepEqual(readExternalMcpRedactionSettings(), settings);
      }
      await assert.rejects(applyExternalMcpRedactionSettings(changed, {
        externalMcpSetConfig: async () => { throw new Error('Disconnected'); },
      }), /Disconnected/);
      assert.deepEqual(readExternalMcpRedactionSettings(), settings);
    } finally {
      restore();
    }
  });

  it('syncs saved privacy settings before persistent startup enable', async () => {
    const restore = installMemoryLocalStorage();
    try {
      resetExternalMcpStartupReadyForTests();
      localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, true);
      localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');
      localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, settings);
      const calls: string[] = [];
      await syncExternalMcpStartupState({
        externalMcpSetConfig: async (config) => {
          assert.deepEqual(config.redaction, settings);
          calls.push('config');
          return { ok: true };
        },
        externalMcpSetEnabled: async (enabled) => { calls.push(`enabled:${enabled}`); },
      });
      assert.deepEqual(calls, ['config', 'enabled:true']);
    } finally {
      restore();
    }
  });

  it('fails closed at startup when saved privacy settings are malformed', async () => {
    const restore = installMemoryLocalStorage();
    try {
      for (const saved of ['{', 'null', '{}', '{"enabled":"true"}', '{"enabled":false,"redactPrivateIps":false,"cidrs":[],"patterns":[2]}', '{"enabled":false,"redactPrivateIps":false,"cidrs":[],"patterns":[],"unexpected":true}']) {
        resetExternalMcpStartupReadyForTests();
        localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, true);
        localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');
        localStorageAdapter.writeString(STORAGE_KEY_AI_PRIVACY, saved);
        const enabledCalls: boolean[] = [];
        let configCalls = 0;
        const bridge = {
          externalMcpSetConfig: async (config: unknown) => {
            assert.deepEqual(config, { redaction: null });
            configCalls += 1;
            return { ok: false, error: 'Shared AI privacy configuration is unavailable.' };
          },
          externalMcpSetEnabled: async (enabled: boolean) => { enabledCalls.push(enabled); },
        };
        const plan = await syncExternalMcpStartupState(bridge);
        assert.equal(plan.runtimeEnabled, false);
        assert.match(plan.configError!, /Invalid saved/);
        assert.equal(configCalls, 1, 'invalidate shared privacy instead of applying unprotected defaults');
        assert.deepEqual(enabledCalls, [false]);
        assert.equal(readExternalMcpStoredEnabled(), false);
        await assert.rejects(syncExternalMcpConfig(bridge), /Invalid saved/);
        assert.equal(configCalls, 2);
      }
    } finally {
      restore();
    }
  });

  it('fails closed when the backend rejects or cannot verify startup config', async () => {
    const restore = installMemoryLocalStorage();
    try {
      for (const result of [{ ok: false, error: 'Invalid CIDR' }, { ok: false, error: '' }, undefined, {}]) {
        resetExternalMcpStartupReadyForTests();
        localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, true);
        localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');
        localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, settings);
        const enabledCalls: boolean[] = [];
        const plan = await syncExternalMcpStartupState({
          externalMcpSetConfig: async () => result,
          externalMcpSetEnabled: async (enabled) => { enabledCalls.push(enabled); },
        });
        assert.equal(plan.runtimeEnabled, false);
        assert.ok(plan.configError);
        assert.deepEqual(enabledCalls, [false]);
        assert.deepEqual(readExternalMcpRedactionSettings(), settings);
      }
    } finally {
      restore();
    }
  });

  it('preserves the corrupt-settings error if shared policy invalidation cannot reach the bridge', async () => {
    const restore = installMemoryLocalStorage();
    try {
      resetExternalMcpStartupReadyForTests();
      localStorageAdapter.writeString(STORAGE_KEY_AI_PRIVACY, '{');
      const calls: boolean[] = [];
      const bridge = {
        externalMcpSetConfig: async (config: unknown) => {
          assert.deepEqual(config, { redaction: null });
          throw new Error('Disconnected');
        },
        externalMcpSetEnabled: async (enabled: boolean) => { calls.push(enabled); },
      };
      const plan = await syncExternalMcpStartupState(bridge);
      assert.match(plan.configError!, /Invalid saved AI privacy settings/);
      assert.deepEqual(calls, [false]);
      await assert.rejects(syncExternalMcpConfig(bridge), /Invalid saved AI privacy settings/);
      assert.equal(localStorageAdapter.readString(STORAGE_KEY_AI_PRIVACY), '{');
    } finally {
      restore();
    }
  });

  it('does not enable from a stale privacy snapshot changed during config sync', async () => {
    const restore = installMemoryLocalStorage();
    try {
      resetExternalMcpStartupReadyForTests();
      localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, true);
      localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');
      const calls: boolean[] = [];
      const plan = await syncExternalMcpStartupState({
        externalMcpSetConfig: async () => {
          localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, settings);
          return { ok: true };
        },
        externalMcpSetEnabled: async (enabled) => { calls.push(enabled); },
      });
      assert.deepEqual(calls, [false]);
      assert.match(plan.configError!, /changed during startup/);
      await assert.rejects(syncExternalMcpConfig({
        externalMcpSetConfig: async () => {
          localStorageAdapter.write(STORAGE_KEY_AI_PRIVACY, { ...settings, cidrs: [] });
          return { ok: true };
        },
      }), /settings changed/);
    } finally {
      restore();
    }
  });

  it('fails closed on a startup config transport failure', async () => {
    const restore = installMemoryLocalStorage();
    try {
      resetExternalMcpStartupReadyForTests();
      localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, true);
      localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE, 'persistent');
      const calls: boolean[] = [];
      const plan = await syncExternalMcpStartupState({
        externalMcpSetConfig: async () => { throw new Error('Disconnected'); },
        externalMcpSetEnabled: async (enabled) => { calls.push(enabled); },
      });
      assert.deepEqual(calls, [false]);
      assert.equal(plan.configError, 'Disconnected');
    } finally {
      restore();
    }
  });
});

describe('External MCP manual enable privacy gate', () => {
  it('waits for validated config and keeps rejected or superseded enables off', async () => {
    const React = await import('react');
    const { act, create } = await import('react-test-renderer');
    const { useExternalMcpToggleState } = await import('./useExternalMcpToggleState.ts');
    const restoreStorage = installMemoryLocalStorage();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    const events = new EventTarget();
    let resolveConfig!: (value: unknown) => void;
    const calls: string[] = [];
    const bridge = {
      externalMcpSetConfig: async () => {
        calls.push('config');
        return new Promise((resolve) => { resolveConfig = resolve; });
      },
      externalMcpSetEnabled: async (enabled: boolean) => {
        calls.push(`enabled:${enabled}`);
        return { ok: true, enabled };
      },
    };
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    Object.defineProperty(globalThis, 'window', {
      value: {
        netcatty: bridge,
        location: { hash: '#/settings' },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        setInterval,
        clearInterval,
      },
      configurable: true,
    });
    let hook!: ReturnType<typeof useExternalMcpToggleState>;
    const Capture = () => { hook = useExternalMcpToggleState(); return null; };
    let renderer: ReturnType<typeof create> | undefined;
    try {
      resetExternalMcpStartupReadyForTests();
      await act(async () => { renderer = create(React.createElement(Capture)); });
      let pending!: Promise<void>;
      await act(async () => { pending = hook.setEnabled(true); });
      assert.deepEqual(calls, ['config']);
      assert.equal(hook.enabled, false);
      assert.equal(readExternalMcpStoredEnabled(), false);
      await act(async () => { resolveConfig({ ok: false, error: 'Invalid privacy rules' }); await pending; });
      assert.deepEqual(calls, ['config', 'enabled:false']);
      assert.equal(hook.enabled, false);
      assert.match(hook.error!, /Invalid privacy rules/);

      calls.length = 0;
      await act(async () => { pending = hook.setEnabled(true); });
      await act(async () => { await hook.setEnabled(false); });
      await act(async () => { resolveConfig({ ok: true }); await pending; });
      assert.deepEqual(calls, ['config', 'enabled:false']);
      assert.equal(hook.enabled, false, 'a newer disable wins over a pending enable');

      calls.length = 0;
      await act(async () => { pending = hook.setEnabled(true); });
      await act(async () => { resolveConfig({ ok: true }); await pending; });
      assert.deepEqual(calls, ['config', 'enabled:true']);
      assert.equal(hook.enabled, true);
      assert.equal(readExternalMcpStoredEnabled(), true);
      assert.equal(hook.error, null);
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      restoreStorage();
    }
  });

  it('ref-counts a single 3s poller across multiple mounted hooks, pauses when hidden, and syncs on visible', async (t) => {
    const React = await import('react');
    const { act, create } = await import('react-test-renderer');
    const { useExternalMcpToggleState } = await import('./useExternalMcpToggleState.ts');
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
    const restoreStorage = installMemoryLocalStorage();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    const events = new EventTarget();
    const visibilityListeners = new Set<() => void>();
    let visibilityState: DocumentVisibilityState = 'visible';
    let statusCalls = 0;
    let runtimeEnabled = true;

    const bridge = {
      externalMcpGetStatus: async () => {
        statusCalls += 1;
        return { ok: true, enabled: runtimeEnabled, error: null };
      },
    };

    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    Object.defineProperty(globalThis, 'window', {
      value: {
        netcatty: bridge,
        location: { hash: '#/settings' },
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        setInterval,
        clearInterval,
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        get visibilityState() { return visibilityState; },
        get hidden() { return visibilityState === 'hidden'; },
        addEventListener(type: string, listener: () => void) {
          if (type === 'visibilitychange') visibilityListeners.add(listener);
        },
        removeEventListener(type: string, listener: () => void) {
          if (type === 'visibilitychange') visibilityListeners.delete(listener);
        },
      },
    });

    const setVisibility = async (next: DocumentVisibilityState) => {
      visibilityState = next;
      await act(async () => {
        for (const listener of [...visibilityListeners]) listener();
      });
    };

    let hookA!: ReturnType<typeof useExternalMcpToggleState>;
    let hookB!: ReturnType<typeof useExternalMcpToggleState>;
    const CaptureA = () => { hookA = useExternalMcpToggleState(); return null; };
    const CaptureB = () => { hookB = useExternalMcpToggleState(); return null; };
    const DualMount = ({ showSecond }: { showSecond: boolean }) => (
      React.createElement(
        React.Fragment,
        null,
        React.createElement(CaptureA),
        showSecond ? React.createElement(CaptureB) : null,
      )
    );

    let renderer: ReturnType<typeof create> | undefined;
    try {
      resetExternalMcpStartupReadyForTests();
      globalThis.localStorage.setItem(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'true');

      // Mount two instances simultaneously (AppView + Settings > AI): only 1 immediate poll + 1 3s interval
      await act(async () => {
        renderer = create(React.createElement(DualMount, { showSecond: true }));
      });
      assert.equal(hookA.enabled, true);
      assert.equal(hookB.enabled, true);
      assert.equal(statusCalls, 1, 'mounting two hooks must share one initial poll');

      await act(async () => t.mock.timers.tick(EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS));
      assert.equal(statusCalls, 2, 'one 3s tick must fire exactly one status check across both hooks');

      // Unmounting the second instance keeps the shared poller running
      await act(async () => {
        renderer!.update(React.createElement(DualMount, { showSecond: false }));
      });
      await act(async () => t.mock.timers.tick(EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS));
      assert.equal(statusCalls, 3);

      // Re-mount second instance, then hide document: polling pauses completely
      await act(async () => {
        renderer!.update(React.createElement(DualMount, { showSecond: true }));
      });
      await setVisibility('hidden');
      await act(async () => t.mock.timers.tick(30_000));
      assert.equal(statusCalls, 3, 'hidden document must not poll externalMcpGetStatus');

      // Runtime idles off while hidden; returning to visible immediately catches up and updates both hooks
      runtimeEnabled = false;
      await setVisibility('visible');
      assert.equal(statusCalls, 4, 'returning to visible must immediately check runtime status');
      assert.equal(hookA.enabled, false);
      assert.equal(hookB.enabled, false);
      assert.equal(readExternalMcpStoredEnabled(), false);

      // Once disabled, polling stops completely
      await act(async () => t.mock.timers.tick(30_000));
      assert.equal(statusCalls, 4, 'disabled switch must stop polling');
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      assert.equal(visibilityListeners.size, 0, 'visibility listener must detach when ref-count reaches 0');
      resetExternalMcpStartupReadyForTests();
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      restoreStorage();
      t.mock.timers.reset();
    }
  });
});
