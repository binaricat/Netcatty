import { useEffect, type MutableRefObject } from 'react';
import {
  STORAGE_KEY_AUTO_UPDATE_ENABLED,
  STORAGE_KEY_CLOSE_TO_TRAY,
  STORAGE_KEY_GLOBAL_HOTKEY_ENABLED,
  STORAGE_KEY_TOGGLE_WINDOW_HOTKEY,
} from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

interface UseSystemSettingsEffectsParams {
  toggleWindowHotkey: string;
  globalHotkeyEnabled: boolean;
  closeToTray: boolean;
  autoUpdateEnabled: boolean;
  persistMountedRef: MutableRefObject<boolean>;
  setHotkeyRegistrationError: (error: string | null) => void;
  setAutoUpdateEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  notifySettingsChanged: (key: string, value: unknown) => void;
}

export function useSystemSettingsEffects({
  toggleWindowHotkey,
  globalHotkeyEnabled,
  closeToTray,
  autoUpdateEnabled,
  persistMountedRef,
  setHotkeyRegistrationError,
  setAutoUpdateEnabled,
  notifySettingsChanged,
}: UseSystemSettingsEffectsParams) {
  // Persist and sync toggle window hotkey setting
  useEffect(() => {
    // Register/unregister the global hotkey in main process (needed on mount)
    const bridge = netcattyBridge.get();
    if (bridge?.registerGlobalHotkey) {
      if (toggleWindowHotkey && globalHotkeyEnabled) {
        setHotkeyRegistrationError(null);
        bridge
          .registerGlobalHotkey(toggleWindowHotkey)
          .then((result) => {
            if (result?.success === false) {
              console.warn('[GlobalHotkey] Hotkey registration failed:', result.error);
              setHotkeyRegistrationError(result.error || 'Failed to register hotkey');
            }
          })
          .catch((err) => {
            console.warn('[GlobalHotkey] Failed to register hotkey:', err);
            setHotkeyRegistrationError(err?.message || 'Failed to register hotkey');
          });
      } else {
        setHotkeyRegistrationError(null);
        bridge.unregisterGlobalHotkey?.().catch((err) => {
          console.warn('[GlobalHotkey] Failed to unregister hotkey:', err);
        });
      }
    }
    localStorageAdapter.writeString(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY, toggleWindowHotkey);
    // Skip IPC on initial mount
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY, toggleWindowHotkey);
  }, [
    toggleWindowHotkey,
    globalHotkeyEnabled,
    notifySettingsChanged,
    persistMountedRef,
    setHotkeyRegistrationError,
  ]);

  // Persist global hotkey enabled setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_GLOBAL_HOTKEY_ENABLED, globalHotkeyEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_GLOBAL_HOTKEY_ENABLED, globalHotkeyEnabled);
  }, [globalHotkeyEnabled, notifySettingsChanged, persistMountedRef]);

  // Persist and sync close to tray setting
  useEffect(() => {
    // Update main process tray behavior (needed on mount)
    const bridge = netcattyBridge.get();
    if (bridge?.setCloseToTray) {
      bridge.setCloseToTray(closeToTray).catch((err) => {
        console.warn('[SystemTray] Failed to set close-to-tray:', err);
      });
    }
    localStorageAdapter.writeString(STORAGE_KEY_CLOSE_TO_TRAY, closeToTray ? 'true' : 'false');
    // Skip IPC on initial mount
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_CLOSE_TO_TRAY, closeToTray);
  }, [closeToTray, notifySettingsChanged, persistMountedRef]);

  // Hydrate auto-update state from the main-process preference file on mount.
  // This reconciles localStorage (renderer) with auto-update-pref.json (main)
  // in case localStorage was cleared or is stale.
  useEffect(() => {
    const bridge = netcattyBridge.get();
    void bridge?.getAutoUpdate?.().then((result) => {
      if (result && typeof result.enabled === 'boolean') {
        setAutoUpdateEnabled((prev) => {
          if (prev === result.enabled) return prev;
          // Sync localStorage with the main-process truth
          localStorageAdapter.writeString(STORAGE_KEY_AUTO_UPDATE_ENABLED, result.enabled ? 'true' : 'false');
          return result.enabled;
        });
      }
    }).catch(() => { /* bridge unavailable */ });
  }, [setAutoUpdateEnabled]);

  // Persist auto-update enabled setting.
  // Initial mount still writes localStorage, but skips cross-window/main-process IPC.
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_AUTO_UPDATE_ENABLED, autoUpdateEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_AUTO_UPDATE_ENABLED, autoUpdateEnabled);
    // Notify main process on user-initiated changes
    const bridge = netcattyBridge.get();
    bridge?.setAutoUpdate?.(autoUpdateEnabled).catch((err: unknown) => {
      console.warn('[AutoUpdate] Failed to set auto-update:', err);
    });
  }, [autoUpdateEnabled, notifySettingsChanged, persistMountedRef]);


}
