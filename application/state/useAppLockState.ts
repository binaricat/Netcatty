import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  normalizeAppLockSettings,
  type AppLockSettings,
} from '../../domain/appLock';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  normalizeRuntimeAppLockState,
  useAppLockRuntime,
  type RuntimeAppLockReason,
  type RuntimeAppLockState,
} from './useAppLockRuntime';

export type AppLockReason = RuntimeAppLockReason;
export type AppLockUnlockResult =
  | { ok: true }
  | { ok: false; error: 'empty' | 'incorrect' };
export interface AppLockSystemUnlockStatus {
  supported: boolean;
  available: boolean;
  enabled: boolean;
  platform: 'darwin' | 'win32' | 'unsupported';
  label: 'Touch ID' | 'Windows Hello' | null;
  reason: string | null;
}
export type AppLockSystemUnlockResult =
  | { ok: true }
  | { ok: false; error: 'disabled' | 'not-locked' | 'unsupported' | 'unavailable' | 'cancelled' | 'failed' };

export const DEFAULT_APP_LOCK_SYSTEM_UNLOCK_STATUS: AppLockSystemUnlockStatus = {
  supported: false,
  available: false,
  enabled: false,
  platform: 'unsupported',
  label: null,
  reason: null,
};

export function normalizeAppLockSystemUnlockStatus(input: unknown): AppLockSystemUnlockStatus {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  const platform = record?.platform === 'darwin' || record?.platform === 'win32'
    ? record.platform
    : 'unsupported';
  const label = record?.label === 'Touch ID' || record?.label === 'Windows Hello'
    ? record.label
    : null;
  return {
    supported: record?.supported === true,
    available: record?.available === true,
    enabled: record?.enabled === true,
    platform,
    label,
    reason: typeof record?.reason === 'string' && record.reason ? record.reason : null,
  };
}

export function normalizeAppLockSystemUnlockResult(input: unknown): AppLockSystemUnlockResult {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  if (record?.ok === true) return { ok: true };
  const error = record?.error;
  if (
    error === 'disabled' ||
    error === 'not-locked' ||
    error === 'unsupported' ||
    error === 'unavailable' ||
    error === 'cancelled' ||
    error === 'failed'
  ) {
    return { ok: false, error };
  }
  return { ok: false, error: 'failed' };
}

export function shouldLockOnStartup(settings: AppLockSettings): boolean {
  const normalized = normalizeAppLockSettings(settings);
  return normalized.enabled && normalized.passwordVerifier !== null;
}

export function shouldLockAfterIdle(
  settings: AppLockSettings,
  lastActivityAt: number,
  now: number,
): boolean {
  const normalized = normalizeAppLockSettings(settings);
  if (!normalized.enabled || !normalized.passwordVerifier) return false;
  if (normalized.timeoutMinutes <= 0) return false;
  return now - lastActivityAt >= normalized.timeoutMinutes * 60_000;
}

export function getIdleLockDelayMs(
  settings: AppLockSettings,
  lastActivityAt: number,
  now: number,
): number | null {
  const normalized = normalizeAppLockSettings(settings);
  if (!normalized.enabled || !normalized.passwordVerifier) return null;
  if (normalized.timeoutMinutes <= 0) return null;
  const timeoutMs = normalized.timeoutMinutes * 60_000;
  return Math.max(0, timeoutMs - (now - lastActivityAt));
}

export async function resolveUnlockAttempt(password: string): Promise<AppLockUnlockResult> {
  if (!password) return { ok: false, error: 'empty' };
  try {
    return await netcattyBridge.get()?.requestAppLockUnlock?.(password) ?? { ok: false, error: 'incorrect' };
  } catch {
    return { ok: false, error: 'incorrect' };
  }
}

export function createOptimisticUnlockedRuntimeState(
  input: RuntimeAppLockState,
  now: number,
): RuntimeAppLockState {
  const current = normalizeRuntimeAppLockState(input);
  if (current.initialized && !current.locked && current.reason === null) {
    return current;
  }

  return {
    ...current,
    initialized: true,
    locked: false,
    reason: null,
    // Keep the observed main-process version. Bumping here can outrank a real
    // concurrent re-lock and leave the renderer unlocked after refresh (Codex P2).
    version: current.version,
    lastUnlockedAt: now,
    lastActivityAt: now,
  };
}

export function useAppLockState(settings: AppLockSettings) {
  const normalizedSettings = useMemo(() => normalizeAppLockSettings(settings), [settings]);
  const systemUnlockRefreshKey = `${normalizedSettings.enabled}:${normalizedSettings.systemUnlockEnabled}:${Boolean(normalizedSettings.passwordVerifier)}`;
  const bridge = netcattyBridge.get();
  const { runtimeState, refreshRuntimeState, setRuntimeState } = useAppLockRuntime(bridge);
  const [systemUnlockStatus, setSystemUnlockStatus] = useState<AppLockSystemUnlockStatus>(
    DEFAULT_APP_LOCK_SYSTEM_UNLOCK_STATUS,
  );
  const normalizedRuntimeState = useMemo(
    () => normalizeRuntimeAppLockState(runtimeState),
    [runtimeState],
  );
  const effectiveRuntimeState = useMemo(() => {
    if (normalizedRuntimeState.initialized) return normalizedRuntimeState;
    if (shouldLockOnStartup(normalizedSettings)) {
      return {
        ...normalizedRuntimeState,
        locked: true,
        reason: 'startup' as const,
      };
    }
    return normalizedRuntimeState;
  }, [normalizedRuntimeState, normalizedSettings]);

  const lockNow = useCallback((reason: AppLockReason = 'manual') => {
    if (!shouldLockOnStartup(normalizedSettings) || !reason) return;
    void bridge?.setAppLockRuntimeLocked?.(reason);
  }, [bridge, normalizedSettings]);

  const recordActivity = useCallback(() => {
    if (effectiveRuntimeState.locked) return;
    void bridge?.reportAppLockActivity?.();
  }, [bridge, effectiveRuntimeState.locked]);

  const unlock = useCallback(async (password: string): Promise<AppLockUnlockResult> => {
    const result = await resolveUnlockAttempt(password);
    if (result.ok) {
      const unlockedAt = Date.now();
      setRuntimeState((current) => createOptimisticUnlockedRuntimeState(current, unlockedAt));
      await refreshRuntimeState().catch(() => {});
    }
    return result;
  }, [refreshRuntimeState, setRuntimeState]);

  const refreshSystemUnlockStatus = useCallback(async () => {
    try {
      const nextStatus = await bridge?.getAppLockSystemUnlockStatus?.();
      const normalized = normalizeAppLockSystemUnlockStatus(nextStatus);
      setSystemUnlockStatus(normalized);
      return normalized;
    } catch {
      setSystemUnlockStatus(DEFAULT_APP_LOCK_SYSTEM_UNLOCK_STATUS);
      return DEFAULT_APP_LOCK_SYSTEM_UNLOCK_STATUS;
    }
  }, [bridge]);

  const unlockWithSystemAuth = useCallback(async (): Promise<AppLockSystemUnlockResult> => {
    const result = normalizeAppLockSystemUnlockResult(await bridge?.requestAppLockSystemUnlock?.());
    if (result.ok) {
      const unlockedAt = Date.now();
      setRuntimeState((current) => createOptimisticUnlockedRuntimeState(current, unlockedAt));
      await refreshRuntimeState().catch(() => {});
    }
    await refreshSystemUnlockStatus().catch(() => {});
    return result;
  }, [bridge, refreshRuntimeState, refreshSystemUnlockStatus, setRuntimeState]);

  const reset = useCallback(async (currentPassword: string) => {
    if (typeof bridge?.requestAppLockReset !== 'function') {
      throw new Error('App Lock reset bridge is unavailable');
    }
    const result = await bridge.requestAppLockReset(currentPassword);
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
      throw new Error(result.error);
    }
    const unlockedAt = Date.now();
    setRuntimeState((current) => createOptimisticUnlockedRuntimeState(current, unlockedAt));
    await refreshRuntimeState().catch(() => {});
  }, [bridge, refreshRuntimeState, setRuntimeState]);

  useEffect(() => {
    if (!shouldLockOnStartup(normalizedSettings) && effectiveRuntimeState.locked) {
      const unlockedAt = Date.now();
      void bridge?.requestAppLockUnlock?.('')
        ?.then((result) => {
          if (result?.ok !== true) return;
          setRuntimeState((current) => createOptimisticUnlockedRuntimeState(current, unlockedAt));
          return refreshRuntimeState();
        })
        .catch(() => {});
    }
  }, [bridge, effectiveRuntimeState.locked, normalizedSettings, refreshRuntimeState, setRuntimeState]);

  useEffect(() => {
    if (!shouldLockOnStartup(normalizedSettings)) return undefined;

    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'];
    for (const eventName of events) {
      window.addEventListener(eventName, recordActivity, { passive: true });
    }

    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, recordActivity);
      }
    };
  }, [normalizedSettings, recordActivity]);

  useEffect(() => {
    if (!shouldLockOnStartup(normalizedSettings)) return undefined;
    void bridge?.reportAppLockActivity?.();
    return undefined;
  }, [bridge, normalizedSettings]);

  useEffect(() => {
    void refreshSystemUnlockStatus();
  }, [refreshSystemUnlockStatus, systemUnlockRefreshKey]);

  return {
    initialized: effectiveRuntimeState.initialized,
    locked: effectiveRuntimeState.locked,
    lockReason: effectiveRuntimeState.reason,
    lockNow,
    unlock,
    unlockWithSystemAuth,
    systemUnlockStatus,
    refreshSystemUnlockStatus,
    reset,
    recordActivity,
    resync: refreshRuntimeState,
  };
}
