import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  STORAGE_KEY_AUTO_UPDATE_ENABLED,
  STORAGE_KEY_CLOSE_TO_TRAY,
  STORAGE_KEY_GLOBAL_HOTKEY_ENABLED,
  STORAGE_KEY_TOGGLE_WINDOW_HOTKEY,
  STORAGE_KEY_WINDOW_OPACITY,
  STORAGE_KEY_APP_ICON_VARIANT,
} from '../../infrastructure/config/storageKeys';
import { resolveAppIconVariant, type AppIconVariant } from '../../domain/appIconVariant';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  parseWindowOpacityRecord,
  serializeWindowOpacityRecord,
  shouldApplyWindowOpacityRecord,
  shouldBroadcastWindowOpacityChange,
  type WindowOpacityMutationSource,
  type WindowOpacityRecord,
} from './windowOpacitySync';

interface UseSystemSettingsEffectsParams {
  enabled?: boolean;
  toggleWindowHotkey: string;
  globalHotkeyEnabled: boolean;
  closeToTray: boolean;
  windowOpacityRecord: WindowOpacityRecord;
  windowOpacityMutationSourceRef: MutableRefObject<WindowOpacityMutationSource>;
  appIconVariant: AppIconVariant;
  autoUpdateEnabled: boolean;
  persistMountedRef: MutableRefObject<boolean>;
  setHotkeyRegistrationError: (error: string | null) => void;
  setAutoUpdateEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  setAppIconVariant: (variant: AppIconVariant | ((prev: AppIconVariant) => AppIconVariant)) => void;
  notifySettingsChanged: (key: string, value: unknown) => void;
}

export function useSystemSettingsEffects({
  enabled = true,
  toggleWindowHotkey,
  globalHotkeyEnabled,
  closeToTray,
  windowOpacityRecord,
  windowOpacityMutationSourceRef,
  appIconVariant,
  autoUpdateEnabled,
  persistMountedRef,
  setHotkeyRegistrationError,
  setAutoUpdateEnabled,
  setAppIconVariant,
  notifySettingsChanged,
}: UseSystemSettingsEffectsParams) {
  const appIconApplyRequestIdRef = useRef(0);

  // Persist and sync toggle window hotkey setting
  useEffect(() => {
    if (!enabled) return;
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
    enabled,
    globalHotkeyEnabled,
    notifySettingsChanged,
    persistMountedRef,
    setHotkeyRegistrationError,
  ]);

  // Persist global hotkey enabled setting
  useEffect(() => {
    if (!enabled) return;
    localStorageAdapter.writeString(STORAGE_KEY_GLOBAL_HOTKEY_ENABLED, globalHotkeyEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_GLOBAL_HOTKEY_ENABLED, globalHotkeyEnabled);
  }, [enabled, globalHotkeyEnabled, notifySettingsChanged, persistMountedRef]);

  // Persist and sync close to tray setting
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, closeToTray, notifySettingsChanged, persistMountedRef]);

  // Persist and sync window opacity
  useEffect(() => {
    if (!enabled) return;
    const bridge = netcattyBridge.get();
    bridge?.setWindowOpacity?.(windowOpacityRecord.opacity).catch((err) => {
      console.warn('[WindowOpacity] Failed to apply window opacity:', err);
    });
    // Never let a stale effect overwrite a newer revision already on disk.
    const stored = parseWindowOpacityRecord(
      localStorageAdapter.readString(STORAGE_KEY_WINDOW_OPACITY),
    );
    if (
      shouldApplyWindowOpacityRecord(stored, windowOpacityRecord)
      || stored.version === windowOpacityRecord.version
    ) {
      localStorageAdapter.writeString(
        STORAGE_KEY_WINDOW_OPACITY,
        serializeWindowOpacityRecord(windowOpacityRecord),
      );
    }
    const decision = shouldBroadcastWindowOpacityChange(
      windowOpacityMutationSourceRef.current,
      persistMountedRef.current,
    );
    windowOpacityMutationSourceRef.current = decision.nextSource;
    if (!decision.shouldBroadcast) return;
    notifySettingsChanged(STORAGE_KEY_WINDOW_OPACITY, windowOpacityRecord);
  }, [
    enabled,
    windowOpacityRecord,
    windowOpacityMutationSourceRef,
    notifySettingsChanged,
    persistMountedRef,
  ]);

  // Persist and sync app icon variant
  useEffect(() => {
    if (!enabled) return;
    const storedBefore = resolveAppIconVariant(
      localStorageAdapter.readString(STORAGE_KEY_APP_ICON_VARIANT) ?? '',
    );

    localStorageAdapter.writeString(STORAGE_KEY_APP_ICON_VARIANT, appIconVariant);
    if (!persistMountedRef.current) {
      // Still apply on initial mount before cross-window notify is enabled.
    } else {
      notifySettingsChanged(STORAGE_KEY_APP_ICON_VARIANT, appIconVariant);
    }

    const bridge = netcattyBridge.get();
    if (!bridge?.setAppIconVariant) return;

    const requestId = ++appIconApplyRequestIdRef.current;
    let cancelled = false;

    const revertVariant = () => {
      localStorageAdapter.writeString(STORAGE_KEY_APP_ICON_VARIANT, storedBefore);
      if (appIconVariant !== storedBefore) {
        setAppIconVariant(storedBefore);
      }
      if (persistMountedRef.current) {
        notifySettingsChanged(STORAGE_KEY_APP_ICON_VARIANT, storedBefore);
      }
    };

    void bridge.setAppIconVariant(appIconVariant)
      .then((applied) => {
        if (cancelled || requestId !== appIconApplyRequestIdRef.current) return;
        if (applied === false && storedBefore !== appIconVariant) {
          console.warn('[AppIcon] Failed to apply app icon variant:', appIconVariant);
          revertVariant();
        }
      })
      .catch((err) => {
        if (cancelled || requestId !== appIconApplyRequestIdRef.current) return;
        if (storedBefore !== appIconVariant) {
          console.warn('[AppIcon] Failed to apply app icon variant:', err);
          revertVariant();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, appIconVariant, notifySettingsChanged, persistMountedRef, setAppIconVariant]);

  // Hydrate auto-update state from the main-process preference file on mount.
  // This reconciles localStorage (renderer) with auto-update-pref.json (main)
  // in case localStorage was cleared or is stale.
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, setAutoUpdateEnabled]);

  // Persist auto-update enabled setting.
  // Initial mount still writes localStorage, but skips cross-window/main-process IPC.
  useEffect(() => {
    if (!enabled) return;
    localStorageAdapter.writeString(STORAGE_KEY_AUTO_UPDATE_ENABLED, autoUpdateEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_AUTO_UPDATE_ENABLED, autoUpdateEnabled);
    // Notify main process on user-initiated changes
    const bridge = netcattyBridge.get();
    bridge?.setAutoUpdate?.(autoUpdateEnabled).catch((err: unknown) => {
      console.warn('[AutoUpdate] Failed to set auto-update:', err);
    });
  }, [enabled, autoUpdateEnabled, notifySettingsChanged, persistMountedRef]);


}
