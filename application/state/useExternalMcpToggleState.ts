import { useCallback, useEffect, useState } from 'react';
import {
  STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED,
  STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN,
  STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
  STORAGE_KEY_AI_EXTERNAL_MCP_MODE,
  STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS,
  STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES,
} from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { AI_STATE_CHANGED_EVENT, emitAIStateChanged } from './aiStateEvents';

export type ExternalMcpMode = 'temporary' | 'persistent';

const DEFAULT_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 10;
const MIN_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 1;
const MAX_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 24 * 60;
const DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 30;
/** Keep top-bar / settings switch state aligned with runtime auto-disable. */
export const EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS = 3000;

// Always-mounted top-bar consumers can poll before App finishes startup reconcile.
// Gate runtime auto-clear until that reconcile has run on the main window.
let externalMcpStartupReady = false;
let externalMcpStartupReadyWaitPromise: Promise<void> | null = null;
let externalMcpStartupReadyWaitResolve: (() => void) | null = null;
/** Bumps on every intentional enable/disable so stale startup applies lose. */
let externalMcpEnableGeneration = 0;

function getWindowHash(hash?: string): string {
  if (typeof hash === 'string') return hash;
  return typeof window !== 'undefined' ? window.location.hash : '';
}

function isPeerSessionWindowLocation(hash?: string): boolean {
  return getWindowHash(hash).startsWith('#/session-window');
}

/** Only the main App shell runs startup reconcile and owns the ready gate. */
export function shouldWaitForExternalMcpStartupReady(hash?: string): boolean {
  const current = getWindowHash(hash);
  if (!current || current === '#' || current === '#/') return true;
  // Peer windows never own External MCP lifecycle.
  if (current.startsWith('#/session-window')) return false;
  // Settings / tray / popup windows mount the shared hook but never run App reconcile.
  if (current.startsWith('#/settings')) return false;
  if (current.startsWith('#/tray')) return false;
  if (current.startsWith('#/terminal-popup')) return false;
  return true;
}

export function markExternalMcpStartupReady(): void {
  if (externalMcpStartupReady) return;
  externalMcpStartupReady = true;
  const resolve = externalMcpStartupReadyWaitResolve;
  externalMcpStartupReadyWaitResolve = null;
  externalMcpStartupReadyWaitPromise = null;
  resolve?.();
}

export function resetExternalMcpStartupReadyForTests(): void {
  externalMcpStartupReady = false;
  externalMcpStartupReadyWaitPromise = null;
  externalMcpStartupReadyWaitResolve = null;
  externalMcpEnableGeneration = 0;
}

export function getExternalMcpEnableGenerationForTests(): number {
  return externalMcpEnableGeneration;
}

export function bumpExternalMcpEnableGenerationForTests(): number {
  externalMcpEnableGeneration += 1;
  return externalMcpEnableGeneration;
}

export function isExternalMcpStartupReady(): boolean {
  return externalMcpStartupReady;
}

/** Exposed for tests: single-flight waiter count is 0 or 1. */
export function getExternalMcpStartupReadyWaiterCountForTests(): number {
  return externalMcpStartupReadyWaitResolve ? 1 : 0;
}

export function waitForExternalMcpStartupReady(hash?: string): Promise<void> {
  // Non-main routes intentionally skip App reconcile; do not block forever there.
  if (!shouldWaitForExternalMcpStartupReady(hash) || externalMcpStartupReady) {
    return Promise.resolve();
  }
  if (!externalMcpStartupReadyWaitPromise) {
    externalMcpStartupReadyWaitPromise = new Promise<void>((resolve) => {
      externalMcpStartupReadyWaitResolve = resolve;
    });
  }
  return externalMcpStartupReadyWaitPromise;
}

type ExternalMcpConfig = {
  mode: ExternalMcpMode;
  idleTimeoutMinutes: number;
  sessionIdleTimeoutMinutes: number;
};

type ExternalMcpBridge = {
  externalMcpSetConfig?: (config: ExternalMcpConfig) => Promise<unknown> | unknown;
  externalMcpSetEnabled?: (enabled: boolean) => Promise<unknown> | unknown;
  externalMcpGetStatus?: () => Promise<{
    ok?: boolean;
    enabled?: boolean;
    state?: string;
    error?: string | null;
  } | undefined>;
};

export type ExternalMcpStartupSyncPlan = {
  config: ExternalMcpConfig;
  runtimeEnabled: boolean;
  storedEnabled: boolean;
  shouldPersistStoredEnabled: boolean;
};

export function normalizeExternalMcpMode(value: string | null): ExternalMcpMode {
  return value === 'persistent' ? 'persistent' : 'temporary';
}

export function normalizeExternalMcpIdleTimeoutMinutes(value: number | null): number {
  if (!Number.isFinite(value)) return DEFAULT_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES;
  return Math.min(
    MAX_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
    Math.max(
      MIN_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
      Math.round(value ?? DEFAULT_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES),
    ),
  );
}

export function readExternalMcpStoredEnabled(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED) ?? false;
}

export function readExternalMcpMode(): ExternalMcpMode {
  return normalizeExternalMcpMode(localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE));
}

export function readExternalMcpIdleTimeoutMinutes(): number {
  return normalizeExternalMcpIdleTimeoutMinutes(
    localStorageAdapter.readNumber(STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES),
  );
}

/** Whether host_open should surface/focus the main window. Defaults to true (existing behavior). */
export function readExternalMcpFocusOnHostOpen(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN) ?? true;
}

export function writeExternalMcpFocusOnHostOpen(focusOnHostOpen: boolean): void {
  localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN, focusOnHostOpen);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN);
}

/** Whether host_open sessions stay hidden from the tab bar. Defaults to false (existing behavior). */
export function readExternalMcpSilentSessions(): boolean {
  return localStorageAdapter.readBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS) ?? false;
}

export function writeExternalMcpSilentSessions(silentSessions: boolean): void {
  localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS, silentSessions);
  emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_SILENT_SESSIONS);
}

export function normalizeSessionIdleTimeoutMinutes(value: number | null): number {
  if (!Number.isFinite(value)) return DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES;
  return Math.min(
    MAX_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
    Math.max(
      MIN_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
      Math.round(value ?? DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES),
    ),
  );
}

export function readSessionIdleTimeoutMinutes(): number {
  return normalizeSessionIdleTimeoutMinutes(
    localStorageAdapter.readNumber(STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES),
  );
}

export function shouldStartExternalMcpOnStartup({
  enabled,
  mode,
}: {
  enabled: boolean;
  mode: ExternalMcpMode;
}): boolean {
  return mode === 'persistent' && enabled;
}

export function readExternalMcpStartupEnabled(): boolean {
  return shouldStartExternalMcpOnStartup({
    enabled: readExternalMcpStoredEnabled(),
    mode: readExternalMcpMode(),
  });
}

export function createExternalMcpStartupSyncPlan({
  enabled,
  mode,
  idleTimeoutMinutes,
  sessionIdleTimeoutMinutes,
}: {
  enabled: boolean;
  mode: ExternalMcpMode;
  idleTimeoutMinutes: number;
  sessionIdleTimeoutMinutes: number;
}): ExternalMcpStartupSyncPlan {
  const runtimeEnabled = shouldStartExternalMcpOnStartup({ enabled, mode });
  const storedEnabled = runtimeEnabled;
  return {
    config: {
      mode,
      idleTimeoutMinutes,
      sessionIdleTimeoutMinutes,
    },
    runtimeEnabled,
    storedEnabled,
    shouldPersistStoredEnabled: storedEnabled !== enabled,
  };
}

export function readExternalMcpStartupSyncPlan(): ExternalMcpStartupSyncPlan {
  return createExternalMcpStartupSyncPlan({
    enabled: readExternalMcpStoredEnabled(),
    mode: readExternalMcpMode(),
    idleTimeoutMinutes: readExternalMcpIdleTimeoutMinutes(),
    sessionIdleTimeoutMinutes: readSessionIdleTimeoutMinutes(),
  });
}

export function syncExternalMcpConfig(bridge: ExternalMcpBridge | undefined = netcattyBridge.get()): void {
  void bridge?.externalMcpSetConfig?.({
    mode: readExternalMcpMode(),
    idleTimeoutMinutes: readExternalMcpIdleTimeoutMinutes(),
    sessionIdleTimeoutMinutes: readSessionIdleTimeoutMinutes(),
  });
}

/**
 * App-startup reconcile: only persistent+enabled starts the runtime.
 * Temporary mode never auto-starts, and we clear a stale stored enabled flag
 * so Settings remounts cannot accidentally re-enable temporary mode.
 */
export async function syncExternalMcpStartupState(
  bridge: ExternalMcpBridge | undefined = netcattyBridge.get(),
): Promise<ExternalMcpStartupSyncPlan> {
  // Snapshot once for config push; re-read after awaits so a concurrent top-bar
  // toggle during boot wins over a stale enable/disable decision.
  const startupGeneration = externalMcpEnableGeneration;
  const initialPlan = readExternalMcpStartupSyncPlan();
  try {
    await Promise.resolve(bridge?.externalMcpSetConfig?.(initialPlan.config));
  } catch {
    // Config sync is best-effort; continue with enable/disable reconcile.
  }

  // A user toggle during config await invalidates this startup apply.
  if (externalMcpEnableGeneration !== startupGeneration) {
    return readExternalMcpStartupSyncPlan();
  }

  const plan = readExternalMcpStartupSyncPlan();
  if (plan.shouldPersistStoredEnabled) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, plan.storedEnabled);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
  }

  // Capture generation again immediately before applying runtime enable/disable.
  const applyGeneration = externalMcpEnableGeneration;
  if (applyGeneration !== startupGeneration) {
    return plan;
  }
  try {
    await Promise.resolve(bridge?.externalMcpSetEnabled?.(plan.runtimeEnabled));
  } catch {
    // Keep stored preference on transient enable failure; runtime status + error
    // surface can recover without wiping always-on intent.
  }
  return plan;
}

export function useExternalMcpToggleState() {
  // UI mirrors the stored switch. Startup reconcile (App mount, main window only)
  // decides whether temporary mode should clear/persist and start the runtime.
  const isPeerSessionWindow = isPeerSessionWindowLocation();
  const [enabled, setEnabledRaw] = useState<boolean>(() => readExternalMcpStoredEnabled());

  const persistEnabled = useCallback((nextEnabled: boolean) => {
    setEnabledRaw(nextEnabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, nextEnabled);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    persistEnabled(nextEnabled);
    // Peer session windows can mirror the stored switch, but they must not own
    // the main-process External MCP lifecycle.
    if (isPeerSessionWindow) return;
    externalMcpEnableGeneration += 1;
    void netcattyBridge.get()?.externalMcpSetEnabled?.(nextEnabled);
  }, [isPeerSessionWindow, persistEnabled]);

  useEffect(() => {
    const syncFromStorage = () => {
      const nextEnabled = readExternalMcpStoredEnabled();
      setEnabledRaw(nextEnabled);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED) return;
      syncFromStorage();
    };
    const handleLocalStateChanged = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (key !== STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED) return;
      syncFromStorage();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged);
    };
  }, []);

  useEffect(() => {
    // Peer windows must never auto-clear the shared stored switch from runtime status.
    if (isPeerSessionWindow || !enabled) return;
    let cancelled = false;

    const syncRuntimeStatus = async () => {
      try {
        // Wait until App has finished startup reconcile so a still-disabled runtime
        // is not mistaken for "user turned it off / idle timeout".
        await waitForExternalMcpStartupReady();
        if (cancelled) return;
        const status = await netcattyBridge.get()?.externalMcpGetStatus?.();
        if (cancelled) return;
        // Only clear the shared switch for an intentional runtime-off (idle /
        // explicit disable). Start failures set error and should keep preference.
        if (status?.ok && !status.enabled && !status.error) {
          persistEnabled(false);
        }
      } catch {
        // Keep the user's stored switch state during transient bridge errors.
      }
    };

    const intervalId = window.setInterval(() => {
      void syncRuntimeStatus();
    }, EXTERNAL_MCP_RUNTIME_STATUS_POLL_MS);
    void syncRuntimeStatus();
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, isPeerSessionWindow, persistEnabled]);

  return { enabled, setEnabled };
}
