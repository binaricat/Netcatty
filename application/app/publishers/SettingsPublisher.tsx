import { useLayoutEffect, type ReactNode } from 'react';

import {
  AppSettingsRuntimeContext,
  registerAppSettingsRuntime,
  type AppSettingsRuntime,
} from '../../state/appRuntimeBridge';

export type SettingsPublisherProps = {
  /**
   * Pre-built settings runtime owned by an ancestor. `AppLockGate` (index.tsx)
   * owns `useSettingsState` so the lock overlay can render before app children
   * mount; the publisher only binds the runtime slot and context.
   */
  settings: AppSettingsRuntime;
  children?: ReactNode;
};

/**
 * Publishes the gate-owned settings runtime the same way `VaultPublisher` /
 * `SessionPublisher` hand over their runtimes: a context for render-time reads
 * and the `appRuntimeBridge` slot for imperative callers.
 *
 * The store fan-out (`settingsChromeStore` / `appearanceChromeStore`) already
 * happens inside `useSettingsState`, so this publisher only relocates the
 * binding out of the component that also builds the shell's domain bags.
 */
export function SettingsPublisher({ settings, children }: SettingsPublisherProps) {
  useLayoutEffect(() => {
    registerAppSettingsRuntime(settings);
  }, [settings]);

  // Only a real unmount clears the slot; see VaultPublisher for why.
  useLayoutEffect(() => () => {
    registerAppSettingsRuntime(null);
  }, []);

  return (
    <AppSettingsRuntimeContext.Provider value={settings}>
      {children}
    </AppSettingsRuntimeContext.Provider>
  );
}
