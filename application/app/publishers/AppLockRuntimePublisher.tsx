import { useLayoutEffect, useMemo, type ReactNode } from 'react';

import {
  AppLockChromeContext,
  registerAppAppLockRuntime,
  type AppAppLockRuntime,
} from '../../state/appRuntimeBridge';

export type AppLockRuntimePublisherProps = {
  /** App-lock runtime owned by `AppLockGate` (index.tsx render prop). */
  appLock: AppAppLockRuntime;
  /** `settings.appLockSettings.enabled` from the gate's settings instance. */
  appLockEnabled: boolean;
  children?: ReactNode;
};

/**
 * Publishes the gate-owned app-lock runtime the same way SettingsPublisher
 * publishes settings: the full runtime goes on the `appRuntimeBridge` slot for
 * imperative callers (`getAppAppLockRuntime()`), and a narrow memoized chrome
 * slice goes on context so TopTabs / AppSideEffects re-render only when the
 * lock state actually changes — the full runtime changes identity on every
 * gate render.
 */
export function AppLockRuntimePublisher({
  appLock,
  appLockEnabled,
  children,
}: AppLockRuntimePublisherProps) {
  useLayoutEffect(() => {
    registerAppAppLockRuntime(appLock);
  }, [appLock]);

  // Only a real unmount clears the slot; see VaultPublisher for why.
  useLayoutEffect(() => () => {
    registerAppAppLockRuntime(null);
  }, []);

  const chrome = useMemo(
    () => ({
      appLockEnabled,
      locked: appLock.locked,
      initialized: appLock.initialized,
    }),
    [appLockEnabled, appLock.locked, appLock.initialized],
  );

  return (
    <AppLockChromeContext.Provider value={chrome}>
      {children}
    </AppLockChromeContext.Provider>
  );
}
