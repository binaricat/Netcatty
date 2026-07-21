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

type ExternalMcpConfig = {
  mode: ExternalMcpMode;
  idleTimeoutMinutes: number;
  sessionIdleTimeoutMinutes: number;
};

type ExternalMcpBridge = {
  externalMcpSetConfig?: (config: ExternalMcpConfig) => Promise<unknown> | unknown;
  externalMcpSetEnabled?: (enabled: boolean) => Promise<unknown> | unknown;
  externalMcpGetStatus?: () => Promise<{ ok?: boolean; enabled?: boolean } | undefined>;
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
export function syncExternalMcpStartupState(
  bridge: ExternalMcpBridge | undefined = netcattyBridge.get(),
): ExternalMcpStartupSyncPlan {
  const plan = readExternalMcpStartupSyncPlan();
  void bridge?.externalMcpSetConfig?.(plan.config);
  if (plan.shouldPersistStoredEnabled) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, plan.storedEnabled);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
  }
  void bridge?.externalMcpSetEnabled?.(plan.runtimeEnabled);
  return plan;
}

export function useExternalMcpToggleState() {
  // UI mirrors the stored switch. Startup reconcile (App mount, main window only)
  // decides whether temporary mode should clear/persist and start the runtime.
  const [enabled, setEnabledRaw] = useState<boolean>(() => readExternalMcpStoredEnabled());

  const persistEnabled = useCallback((nextEnabled: boolean) => {
    setEnabledRaw(nextEnabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, nextEnabled);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED);
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    persistEnabled(nextEnabled);
    void netcattyBridge.get()?.externalMcpSetEnabled?.(nextEnabled);
  }, [persistEnabled]);

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
    if (!enabled) return;
    const syncRuntimeStatus = async () => {
      try {
        const status = await netcattyBridge.get()?.externalMcpGetStatus?.();
        if (status?.ok && !status.enabled) {
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
    return () => window.clearInterval(intervalId);
  }, [enabled, persistEnabled]);

  return { enabled, setEnabled };
}
