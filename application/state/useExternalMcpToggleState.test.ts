import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS,
  createExternalMcpStartupSyncPlan,
  normalizeExternalMcpIdleTimeoutMinutes,
  normalizeExternalMcpMode,
  normalizeSessionIdleTimeoutMinutes,
  readExternalMcpFocusOnHostOpen,
  readExternalMcpSilentSessions,
  shouldStartExternalMcpOnStartup,
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
    assert.equal(normalizeSessionIdleTimeoutMinutes(null), 30);
    assert.equal(normalizeSessionIdleTimeoutMinutes(0), 1);
  });

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
