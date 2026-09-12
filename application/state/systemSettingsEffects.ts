import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  STORAGE_KEY_AUTO_UPDATE_ENABLED,
  STORAGE_KEY_CLOSE_TO_TRAY,
  STORAGE_KEY_AUTO_LAUNCH_ENABLED,
  STORAGE_KEY_GLOBAL_HOTKEY_ENABLED,
  STORAGE_KEY_TOGGLE_WINDOW_HOTKEY,
  STORAGE_KEY_WINDOW_OPACITY,
  STORAGE_KEY_APP_ICON_VARIANT,
  STORAGE_KEY_HTTP_NETWORK_PROXY,
} from '../../infrastructure/config/storageKeys';
import { resolveAppIconVariant, type AppIconVariant } from '../../domain/appIconVariant';
import {
  normalizeHttpNetworkProxySettings,
  type HttpNetworkProxySettings,
} from '../../domain/httpNetworkProxy';
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

/**
 * A getAutoLaunch/setAutoLaunch IPC result is only safe to apply to state
 * when the main process could actually determine the OS's login-item state.
 * success:false means "unknown" (a transient read/write failure), not a
 * confirmed disabled state — applying enabled:false in that case would
 * overwrite a valid cached value and, via the push effect, cascade into an
 * unwanted disable write that could remove a working login item.
 */
export function isAutoLaunchResultTrustworthy(result: { success?: boolean }): boolean {
  return result.success !== false;
}

interface UseSystemSettingsEffectsParams {
  enabled?: boolean;
  toggleWindowHotkey: string;
  globalHotkeyEnabled: boolean;
  closeToTray: boolean;
  autoLaunchEnabled: boolean;
  windowOpacityRecord: WindowOpacityRecord;
  windowOpacityMutationSourceRef: MutableRefObject<WindowOpacityMutationSource>;
  appIconVariant: AppIconVariant;
  autoUpdateEnabled: boolean;
  httpNetworkProxy: HttpNetworkProxySettings;
  persistMountedRef: MutableRefObject<boolean>;
  setHotkeyRegistrationError: (error: string | null) => void;
  setAutoUpdateEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  setAppIconVariant: (variant: AppIconVariant | ((prev: AppIconVariant) => AppIconVariant)) => void;
  setAutoLaunchEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  setAutoLaunchSupported: (supported: boolean) => void;
  notifySettingsChanged: (key: string, value: unknown) => void;
}

export function useSystemSettingsEffects({
  enabled = true,
  toggleWindowHotkey,
  globalHotkeyEnabled,
  closeToTray,
  autoLaunchEnabled,
  windowOpacityRecord,
  windowOpacityMutationSourceRef,
  appIconVariant,
  autoUpdateEnabled,
  httpNetworkProxy,
  persistMountedRef,
  setHotkeyRegistrationError,
  setAutoUpdateEnabled,
  setAppIconVariant,
  setAutoLaunchEnabled,
  setAutoLaunchSupported,
  notifySettingsChanged,
}: UseSystemSettingsEffectsParams) {
  const appIconApplyRequestIdRef = useRef(0);
  // True once the push effect has issued a real OS write (i.e. after mount,
  // when persistMountedRef is set — see below). If the user toggles
  // auto-launch while the mount-time hydration read is still in flight, the
  // hydration effect must not let its now-stale response overwrite that
  // choice, or the adjacent push effect reacts to the overwrite and issues
  // the opposite OS write right after the user's own request lands.
  const autoLaunchWriteStartedRef = useRef(false);
  // Incremented on every push-effect invocation. If the user toggles again
  // before an in-flight bridge.setAutoLaunch(...) resolves, that older
  // call's response is stale by the time it arrives — comparing its own
  // request against its own result is self-consistent but says nothing
  // about whether a newer request has since superseded it, so a delayed
  // response could otherwise "correct" state the user has already moved
  // past (undoing a toggle they made after this specific request started).
  const autoLaunchWriteGenerationRef = useRef(0);

  // Persist and sync toggle window hotkey setting
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let didRegister = false;
    // Register/unregister the global hotkey in main process (needed on mount)
    const bridge = netcattyBridge.get();
    if (bridge?.registerGlobalHotkey) {
      if (toggleWindowHotkey && globalHotkeyEnabled) {
        setHotkeyRegistrationError(null);
        didRegister = true;
        bridge
          .registerGlobalHotkey(toggleWindowHotkey)
          .then((result) => {
            if (cancelled) return;
            if (result?.success === false) {
              console.warn('[GlobalHotkey] Hotkey registration failed:', result.error);
              setHotkeyRegistrationError(result.error || 'Failed to register hotkey');
            }
          })
          .catch((err) => {
            if (cancelled) return;
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
    // Skip settings-sync IPC on initial mount; still return cleanup below.
    if (persistMountedRef.current) {
      notifySettingsChanged(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY, toggleWindowHotkey);
    }
    return () => {
      cancelled = true;
      // Drop Mount1's registration before Mount2 re-registers (StrictMode), and
      // release the accelerator on real unmount / disable transitions.
      if (didRegister) {
        bridge?.unregisterGlobalHotkey?.().catch((err) => {
          console.warn('[GlobalHotkey] Failed to unregister hotkey on cleanup', err);
        });
      }
    };
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

  // Hydrate auto-launch from the main process on mount — the OS login item
  // is the real source of truth (the user may have toggled it outside the
  // app), localStorage is only an optimistic cache for first paint.
  useEffect(() => {
    if (!enabled) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.getAutoLaunch) return;
    let cancelled = false;
    bridge.getAutoLaunch().then((result) => {
      if (cancelled) return;
      setAutoLaunchSupported(result.supported);
      // The user (or an already-issued write) may have moved state on while
      // this request was in flight — a stale hydration response must not
      // clobber it, or the push effect below reacts to the clobber and
      // fires an unwanted OS write right after the user's own request.
      if (autoLaunchWriteStartedRef.current) return;
      if (!isAutoLaunchResultTrustworthy(result)) return;
      setAutoLaunchEnabled(result.enabled);
      localStorageAdapter.writeString(STORAGE_KEY_AUTO_LAUNCH_ENABLED, result.enabled ? 'true' : 'false');
    }).catch((err) => {
      console.warn('[AutoLaunch] Failed to read login item state:', err);
    });
    return () => {
      cancelled = true;
    };
    // Runs once per mount — this is a one-shot hydration, not a sync loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Push auto-launch changes to the main process and cache the result.
  useEffect(() => {
    if (!enabled) return;
    if (!persistMountedRef.current) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.setAutoLaunch) return;
    // A real write is now in flight — permanently disqualify the mount-time
    // hydration effect above from applying a (now possibly stale) response.
    autoLaunchWriteStartedRef.current = true;
    const requestGeneration = ++autoLaunchWriteGenerationRef.current;
    bridge.setAutoLaunch(autoLaunchEnabled).then((result) => {
      setAutoLaunchSupported(result.supported);
      // The user toggled again before this request resolved — a newer
      // request (and its own response, once it arrives) is authoritative;
      // reconciling this stale one could undo a choice made after it fired.
      if (autoLaunchWriteGenerationRef.current !== requestGeneration) return;
      if (!isAutoLaunchResultTrustworthy(result)) return;
      if (result.enabled !== autoLaunchEnabled) setAutoLaunchEnabled(result.enabled);
      localStorageAdapter.writeString(STORAGE_KEY_AUTO_LAUNCH_ENABLED, result.enabled ? 'true' : 'false');
    }).catch((err) => {
      console.warn('[AutoLaunch] Failed to update login item state:', err);
    });
    notifySettingsChanged(STORAGE_KEY_AUTO_LAUNCH_ENABLED, autoLaunchEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, autoLaunchEnabled]);

  // Persist and apply app-level HTTP(S) network proxy (cloud sync / AI)
  useEffect(() => {
    if (!enabled) return;
    const normalized = normalizeHttpNetworkProxySettings(httpNetworkProxy);
    localStorageAdapter.write(STORAGE_KEY_HTTP_NETWORK_PROXY, normalized);
    const bridge = netcattyBridge.get();
    if (bridge?.setHttpNetworkProxy) {
      // Apply to main process; empty custom is treated as system there.
      // Persist draft custom+empty so the URL field remains visible.
      bridge.setHttpNetworkProxy(normalized).catch((err) => {
        console.warn('[NetworkProxy] Failed to apply HTTP network proxy:', err);
      });
    }
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_HTTP_NETWORK_PROXY, normalized);
  }, [enabled, httpNetworkProxy, notifySettingsChanged, persistMountedRef]);

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
