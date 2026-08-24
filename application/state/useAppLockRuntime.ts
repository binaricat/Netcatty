import { useCallback, useEffect, useState } from 'react';

export type RuntimeAppLockReason = 'startup' | 'idle' | 'manual' | 'background' | null;

export interface RuntimeAppLockState {
  initialized: boolean;
  locked: boolean;
  reason: RuntimeAppLockReason;
  version: number;
  lastLockedAt: number | null;
  lastUnlockedAt: number | null;
  lastActivityAt: number | null;
}

export function normalizeRuntimeAppLockState(input: unknown): RuntimeAppLockState {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  const reason = record?.reason;

  return {
    initialized: record?.initialized === true,
    locked: record?.locked === true,
    reason:
      reason === 'startup' ||
      reason === 'idle' ||
      reason === 'manual' ||
      reason === 'background'
        ? reason
        : null,
    version: typeof record?.version === 'number' && Number.isFinite(record.version) ? record.version : 0,
    lastLockedAt: typeof record?.lastLockedAt === 'number' && Number.isFinite(record.lastLockedAt) ? record.lastLockedAt : null,
    lastUnlockedAt: typeof record?.lastUnlockedAt === 'number' && Number.isFinite(record.lastUnlockedAt) ? record.lastUnlockedAt : null,
    lastActivityAt: typeof record?.lastActivityAt === 'number' && Number.isFinite(record.lastActivityAt) ? record.lastActivityAt : null,
  };
}

const DEFAULT_RUNTIME_APP_LOCK_STATE: RuntimeAppLockState = normalizeRuntimeAppLockState(null);

export function selectPreferredRuntimeAppLockState(
  current: RuntimeAppLockState,
  incoming: RuntimeAppLockState,
): RuntimeAppLockState {
  if (incoming.version > current.version) return incoming;
  if (incoming.version < current.version) return current;
  if (incoming.initialized && !current.initialized) return incoming;
  if (!incoming.initialized && current.initialized) return current;
  return incoming;
}

export function useAppLockRuntime(
  bridge: Pick<
    NonNullable<NetcattyBridge>,
    'getAppLockRuntimeState' | 'onAppLockRuntimeStateChanged'
  > | null | undefined,
) {
  const [runtimeState, setRuntimeState] = useState<RuntimeAppLockState>(DEFAULT_RUNTIME_APP_LOCK_STATE);
  const refreshRuntimeState = useCallback(async () => {
    const nextState = await bridge?.getAppLockRuntimeState?.();
    const normalized = normalizeRuntimeAppLockState(nextState);
    setRuntimeState((current) => selectPreferredRuntimeAppLockState(current, normalized));
    return normalized;
  }, [bridge]);

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = bridge?.onAppLockRuntimeStateChanged?.((nextState) => {
      if (cancelled) return;
      const normalized = normalizeRuntimeAppLockState(nextState);
      setRuntimeState((current) => selectPreferredRuntimeAppLockState(current, normalized));
    }) ?? (() => {});

    void refreshRuntimeState().catch(() => {
      if (cancelled) return;
      setRuntimeState((current) => selectPreferredRuntimeAppLockState(
        current,
        DEFAULT_RUNTIME_APP_LOCK_STATE,
      ));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, refreshRuntimeState]);

  return {
    runtimeState,
    setRuntimeState,
    refreshRuntimeState,
  };
}
