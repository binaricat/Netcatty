import { useCallback, useEffect, useRef, useState } from 'react';
import { checkForUpdates, getReleaseUrl, type ReleaseInfo, type UpdateCheckResult } from '../../infrastructure/services/updateService';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_UPDATE_DISMISSED_VERSION, STORAGE_KEY_UPDATE_LAST_CHECK, STORAGE_KEY_UPDATE_LATEST_RELEASE, STORAGE_KEY_AUTO_UPDATE_ENABLED } from '../../infrastructure/config/storageKeys';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

// Check for updates at most once per hour
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Delay startup check to avoid slowing down app launch.
// 8s gives electron-updater's startAutoCheck(5000) time to emit
// 'update-available' first.  The `onUpdateAvailable` handler also cancels
// any pending startup timeout, so even on slow networks where the event
// arrives after 8s the duplicate check is avoided.
const STARTUP_CHECK_DELAY_MS = 8000;
// Enable demo mode for development (set via localStorage: localStorage.setItem('debug.updateDemo', '1'))
const IS_UPDATE_DEMO_MODE = typeof window !== 'undefined' && 
  window.localStorage?.getItem('debug.updateDemo') === '1';

// Debug logging for update checks (no-op in production)
const debugLog = (..._args: unknown[]) => {};

export type AutoDownloadStatus = 'idle' | 'downloading' | 'ready' | 'error';

export type ManualCheckStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'error';

export interface UpdateState {
  isChecking: boolean;
  hasUpdate: boolean;
  currentVersion: string;
  latestRelease: ReleaseInfo | null;
  error: string | null;
  lastCheckedAt: number | null;
  // Auto-download state — driven by electron-updater IPC events
  autoDownloadStatus: AutoDownloadStatus;
  downloadPercent: number;
  downloadError: string | null;
  /** Manual check state — driven by user clicking "Check for Updates" */
  manualCheckStatus: ManualCheckStatus;
}

export interface UseUpdateCheckResult {
  updateState: UpdateState;
  checkNow: () => Promise<UpdateCheckResult | null>;
  dismissUpdate: () => void;
  openReleasePage: () => void;
  installUpdate: () => void;
}

/**
 * Hook for managing update checks
 * - Automatically checks for updates on startup (with delay)
 * - Respects dismissed version to avoid nagging
 * - Provides manual check capability
 */
export function useUpdateCheck(options?: { autoUpdateEnabled?: boolean }): UseUpdateCheckResult {
  // Accept auto-update toggle from the caller (e.g. useSettingsState) so it
  // reacts immediately in the same window. Falls back to reading localStorage
  // when no caller provides the value (e.g. in non-settings contexts).
  const autoUpdateEnabled = options?.autoUpdateEnabled ??
    (localStorageAdapter.readString(STORAGE_KEY_AUTO_UPDATE_ENABLED) !== 'false');

  const [updateState, setUpdateState] = useState<UpdateState>({
    isChecking: false,
    hasUpdate: false,
    currentVersion: '',
    latestRelease: null,
    error: null,
    lastCheckedAt: null,
    autoDownloadStatus: 'idle',
    downloadPercent: 0,
    downloadError: null,
    manualCheckStatus: 'idle',
  });

  const hasCheckedOnStartupRef = useRef(false);
  const isCheckingRef = useRef(false);
  const startupCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track current version in a ref to avoid stale closure in checkNow
  const currentVersionRef = useRef(updateState.currentVersion);
  // Track autoDownloadStatus in a ref so checkNow always reads the latest value
  const autoDownloadStatusRef = useRef<AutoDownloadStatus>('idle');
  // Timer ref for auto-resetting manualCheckStatus='up-to-date' back to 'idle'
  const manualCheckResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flag: true when we suppressed auto-download because the version was dismissed.
  // Used to distinguish "idle because dismissed" from "idle because not hydrated yet"
  // in the progress/downloaded/error callbacks.
  const dismissedAutoDownloadRef = useRef(false);

  // Keep currentVersionRef in sync so checkNow always reads the latest version
  useEffect(() => {
    currentVersionRef.current = updateState.currentVersion;
  }, [updateState.currentVersion]);

  // Keep autoDownloadStatusRef in sync so checkNow always reads the latest download state
  useEffect(() => {
    autoDownloadStatusRef.current = updateState.autoDownloadStatus;
  }, [updateState.autoDownloadStatus]);

  // Cleanup: clear any pending manualCheckStatus reset timer on unmount
  useEffect(() => {
    return () => {
      if (manualCheckResetTimeoutRef.current) {
        clearTimeout(manualCheckResetTimeoutRef.current);
      }
    };
  }, []);

  // Get current app version
  useEffect(() => {
    const loadVersion = async () => {
      try {
        const bridge = netcattyBridge.get();
        const info = await bridge?.getAppInfo?.();
        if (info?.version) {
          setUpdateState((prev) => ({ ...prev, currentVersion: info.version }));
        }
      } catch {
        // Ignore - running without Electron bridge
      }
    };
    void loadVersion();
  }, []);

  // Hydrate auto-download status from the main process so windows opened
  // after the download started (e.g. Settings) immediately reflect the
  // current state instead of showing stale 'idle'.
  useEffect(() => {
    const bridge = netcattyBridge.get();
    void bridge?.getUpdateStatus?.().then((snapshot) => {
      if (!snapshot || snapshot.status === 'idle') return;

      // Respect dismissed versions: if the user dismissed this release,
      // don't surface download progress/ready state in late-opening windows.
      // Also set the dismissed ref so subsequent IPC events are suppressed.
      const dismissedVersion = localStorageAdapter.readString(STORAGE_KEY_UPDATE_DISMISSED_VERSION);
      if (snapshot.version && snapshot.version === dismissedVersion) {
        dismissedAutoDownloadRef.current = true;
        return;
      }

      // 'available' means an update was found but auto-download is disabled.
      // Surface the version info (hasUpdate + latestRelease) but keep
      // autoDownloadStatus at 'idle' so the manual download path shows.
      const isAvailableOnly = snapshot.status === 'available';

      setUpdateState((prev) => {
        // Don't overwrite if the renderer already has a newer state
        if (prev.autoDownloadStatus !== 'idle') return prev;
        return {
          ...prev,
          hasUpdate: isAvailableOnly ? true : prev.hasUpdate,
          autoDownloadStatus: isAvailableOnly ? 'idle' : snapshot.status,
          downloadPercent: isAvailableOnly ? 0 : snapshot.percent,
          downloadError: isAvailableOnly ? null : snapshot.error,
          // Use snapshot version if no release data or if versions differ
          latestRelease: (!prev.latestRelease || (snapshot.version && prev.latestRelease.version !== snapshot.version)) ? (snapshot.version ? {
            version: snapshot.version,
            tagName: `v${snapshot.version}`,
            name: `v${snapshot.version}`,
            body: '',
            htmlUrl: '',
            publishedAt: new Date().toISOString(),
            assets: [],
          } : prev.latestRelease) : prev.latestRelease,
        };
      });
    });
  }, []);

  // Subscribe to electron-updater auto-download IPC events.
  // These fire automatically when autoDownload=true in the main process.
  useEffect(() => {
    const bridge = netcattyBridge.get();

    // When electron-updater confirms no update in its feed, don't write
    // STORAGE_KEY_UPDATE_LAST_CHECK — that would throttle the GitHub API
    // fallback for an hour.  Let performCheck write it on success so the
    // GitHub check can still discover releases not yet in the updater feed.
    const cleanupNotAvailable = bridge?.onUpdateNotAvailable?.(() => {
      // No-op for now — the GitHub fallback will handle lastCheckedAt.
    });

    const cleanupAvailable = bridge?.onUpdateAvailable?.((info) => {
      // Cancel any pending startup GitHub API check — electron-updater is
      // now authoritative and we don't want a duplicate toast.
      if (startupCheckTimeoutRef.current) {
        clearTimeout(startupCheckTimeoutRef.current);
        startupCheckTimeoutRef.current = null;
      }

      // Check if this version was dismissed by the user
      const dismissedVersion = localStorageAdapter.readString(STORAGE_KEY_UPDATE_DISMISSED_VERSION);
      const isDismissed = dismissedVersion === info.version;
      if (isDismissed) {
        dismissedAutoDownloadRef.current = true;
      }
      // When auto-update is disabled, autoDownload=false in the main process
      // so no download will start. Don't transition to 'downloading' or the
      // UI will be stuck at 0%. Keep status idle and let the manual download
      // link surface instead.
      const isAutoUpdateOff = localStorageAdapter.readString(STORAGE_KEY_AUTO_UPDATE_ENABLED) === 'false';
      const shouldTrackDownload = !isDismissed && !isAutoUpdateOff;
      setUpdateState((prev) => ({
        ...prev,
        hasUpdate: !isDismissed,
        autoDownloadStatus: shouldTrackDownload ? 'downloading' : prev.autoDownloadStatus,
        downloadPercent: shouldTrackDownload ? 0 : prev.downloadPercent,
        downloadError: shouldTrackDownload ? null : prev.downloadError,
        // Use electron-updater's version if GitHub API hasn't resolved yet or
        // if the updater reports a different version than the cached release.
        latestRelease: (!prev.latestRelease || prev.latestRelease.version !== info.version) ? {
          version: info.version,
          tagName: `v${info.version}`,
          name: `v${info.version}`,
          body: info.releaseNotes || '',
          htmlUrl: '',
          publishedAt: info.releaseDate || new Date().toISOString(),
          assets: [],
        } : prev.latestRelease,
      }));
    });

    const cleanupProgress = bridge?.onUpdateDownloadProgress?.((p) => {
      // If we suppressed the download for a dismissed version, ignore progress.
      if (dismissedAutoDownloadRef.current) return;
      setUpdateState((prev) => ({
        ...prev,
        autoDownloadStatus: 'downloading',
        downloadPercent: Math.round(p.percent),
      }));
    });

    const cleanupDownloaded = bridge?.onUpdateDownloaded?.(() => {
      // If the download was for a dismissed version, don't transition to
      // 'ready' — that would trigger the "Update ready" toast.
      if (dismissedAutoDownloadRef.current) return;
      setUpdateState((prev) => ({
        ...prev,
        autoDownloadStatus: 'ready',
        downloadPercent: 100,
      }));
    });

    const cleanupError = bridge?.onUpdateError?.((payload) => {
      // If we suppressed the download for a dismissed version, ignore errors.
      if (dismissedAutoDownloadRef.current) return;
      setUpdateState((prev) => ({
        ...prev,
        autoDownloadStatus: 'error',
        downloadError: payload.error,
      }));
    });

    return () => {
      cleanupNotAvailable?.();
      cleanupAvailable?.();
      cleanupProgress?.();
      cleanupDownloaded?.();
      cleanupError?.();
    };
  }, []);

  const performCheck = useCallback(async (currentVersion: string): Promise<UpdateCheckResult | null> => {
    debugLog('performCheck called', { currentVersion, IS_UPDATE_DEMO_MODE });
    
    // In demo mode, use a fake version to allow checking
    const effectiveVersion = IS_UPDATE_DEMO_MODE ? '0.0.1' : currentVersion;
    
    if (!effectiveVersion || effectiveVersion === '0.0.0') {
      debugLog('Skipping check - invalid version:', effectiveVersion);
      // Skip check for dev builds
      return null;
    }

    if (isCheckingRef.current) {
      debugLog('Already checking, skipping');
      return null;
    }

    isCheckingRef.current = true;
    setUpdateState((prev) => ({ ...prev, isChecking: true, error: null }));

    try {
      let result: UpdateCheckResult;
      
      if (IS_UPDATE_DEMO_MODE) {
        debugLog('Demo mode: creating fake update result');
        // Simulate a short delay like a real API call
        await new Promise(resolve => setTimeout(resolve, 500));
        // In demo mode, create a fake update result
        result = {
          hasUpdate: true,
          currentVersion: '0.0.1',
          latestRelease: {
            version: '1.0.0',
            tagName: 'v1.0.0',
            name: 'Netcatty v1.0.0',
            body: 'Demo release for testing update notification',
            htmlUrl: 'https://github.com/binaricat/Netcatty/releases',
            publishedAt: new Date().toISOString(),
            assets: [],
          },
        };
      } else {
        result = await checkForUpdates(currentVersion);
      }
      debugLog('Check result:', result);
      debugLog('Latest release version:', result.latestRelease?.version);
      const now = Date.now();

      // Only advance last-check time and cache release on successful checks.
      // Failed checks (result.error set, no latestRelease) must not update
      // the timestamp — otherwise stale cached release data persists for an
      // hour while the throttle prevents re-checking.
      if (!result.error) {
        localStorageAdapter.writeNumber(STORAGE_KEY_UPDATE_LAST_CHECK, now);
        if (result.latestRelease) {
          localStorageAdapter.writeString(STORAGE_KEY_UPDATE_LATEST_RELEASE, JSON.stringify(result.latestRelease));
        }
      }

      // Check if this version was dismissed
      const dismissedVersion = localStorageAdapter.readString(STORAGE_KEY_UPDATE_DISMISSED_VERSION);
      const showUpdate = result.hasUpdate && 
        result.latestRelease?.version !== dismissedVersion;
      
      debugLog('Show update:', showUpdate, 'dismissed version:', dismissedVersion);
      debugLog('Setting state with hasUpdate:', showUpdate);

      setUpdateState((prev) => {
        debugLog('State updated:', { ...prev, hasUpdate: showUpdate, latestRelease: result.latestRelease });
        return {
          ...prev,
          isChecking: false,
          hasUpdate: showUpdate,
          latestRelease: result.latestRelease,
          error: result.error || null,
          lastCheckedAt: now,
        };
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      setUpdateState((prev) => ({
        ...prev,
        isChecking: false,
        error: errorMsg,
      }));
      return null;
    } finally {
      isCheckingRef.current = false;
    }
  }, []);

  const checkNow = useCallback(async (): Promise<UpdateCheckResult | null> => {
    // Prevent concurrent checks (performCheck owns isCheckingRef)
    if (isCheckingRef.current) {
      debugLog('checkNow: already checking, skipping');
      return null;
    }

    // Cancel any pending startup auto-check to avoid racing with
    // electron-updater's startAutoCheck — concurrent checkForUpdates()
    // calls are rejected by electron-updater and would surface a false error.
    if (startupCheckTimeoutRef.current) {
      clearTimeout(startupCheckTimeoutRef.current);
      startupCheckTimeoutRef.current = null;
    }

    // Clear any pending "up-to-date" auto-reset timer
    if (manualCheckResetTimeoutRef.current) {
      clearTimeout(manualCheckResetTimeoutRef.current);
      manualCheckResetTimeoutRef.current = null;
    }

    // Reset dismissed flag so a manual retry can surface download events again
    dismissedAutoDownloadRef.current = false;

    // Immediately reflect 'checking' in the UI; reset download error so the user can retry
    setUpdateState((prev) => {
      // Eagerly sync the ref so the checkForUpdate gate below reads the updated value
      if (prev.autoDownloadStatus === 'error') {
        autoDownloadStatusRef.current = 'idle';
      }
      return {
        ...prev,
        manualCheckStatus: 'checking',
        error: null,
        // P2: reset download error state so auto-download can retry on next available update
        autoDownloadStatus: prev.autoDownloadStatus === 'error' ? 'idle' : prev.autoDownloadStatus,
        downloadError: prev.autoDownloadStatus === 'error' ? null : prev.downloadError,
      };
    });

    // Skip check for dev/invalid builds (demo mode overrides to '0.0.1' inside performCheck)
    const effectiveVersion = IS_UPDATE_DEMO_MODE ? '0.0.1' : currentVersionRef.current;
    if (!effectiveVersion || effectiveVersion === '0.0.0') {
      // Dev/invalid build — can't determine update status, reset to idle
      setUpdateState((prev) => ({
        ...prev,
        manualCheckStatus: 'idle',
      }));
      return null;
    }

    // Delegate to performCheck (GitHub API) — completely independent of
    // electron-updater's startAutoCheck() in the main process.
    // performCheck sets isCheckingRef, isChecking, hasUpdate, latestRelease.
    const result = await performCheck(effectiveVersion);

    // Determine manual check status.  performCheck already suppressed dismissed
    // versions in state (hasUpdate=false), so we must respect that here too —
    // otherwise a dismissed release would be reported as 'available' and could
    // trigger a background download via checkForUpdate below.
    const dismissedVersion = localStorageAdapter.readString(STORAGE_KEY_UPDATE_DISMISSED_VERSION);
    const isAvailable = result !== null && !result.error && result.hasUpdate &&
      result.latestRelease?.version !== dismissedVersion;
    const nextStatus: ManualCheckStatus =
      result === null || result.error ? 'error' : isAvailable ? 'available' : 'up-to-date';

    setUpdateState((prev) => ({
      ...prev,
      manualCheckStatus: nextStatus,
    }));

    if (nextStatus === 'up-to-date') {
      // Auto-reset "up-to-date" badge back to idle after 5s
      manualCheckResetTimeoutRef.current = setTimeout(() => {
        setUpdateState((prev) => ({ ...prev, manualCheckStatus: 'idle' }));
      }, 5000);
    } else if ((nextStatus === 'available' || nextStatus === 'error') && autoDownloadStatusRef.current === 'idle') {
      // Trigger electron-updater as a fallback. This covers two cases:
      // 1. 'available': GitHub found an update but electron-updater hasn't
      //    started a download yet — kick it off.
      // 2. 'error': GitHub API failed (blocked/rate-limited), but the
      //    electron-updater feed may still be reachable. Without this,
      //    environments where api.github.com is blocked would never attempt
      //    the auto-download path.
      void netcattyBridge.get()?.checkForUpdate?.().then((res) => {
        if (res?.error && res?.supported !== false) {
          // Surface actual download-feed errors; unsupported platforms
          // (res.supported === false) should keep autoDownloadStatus at
          // 'idle' so the manual download link shows.
          setUpdateState((prev) => ({
            ...prev,
            autoDownloadStatus: 'error',
            downloadError: res.error,
          }));
        } else if (res?.checking) {
          // Another check is already in flight — don't change status; the
          // in-flight check will resolve via IPC events.
        } else if (nextStatus === 'error' && res?.available) {
          // GitHub API failed but electron-updater found an update.
          // Respect dismissed versions before surfacing.
          const dismissed = localStorageAdapter.readString(STORAGE_KEY_UPDATE_DISMISSED_VERSION);
          if (res.version && res.version === dismissed) {
            // User dismissed this version — don't re-surface
          } else {
            setUpdateState((prev) => ({
              ...prev,
              manualCheckStatus: 'available',
              hasUpdate: true,
              error: null,
            }));
          }
        } else if (nextStatus === 'error' && !res?.error && !res?.available) {
          // GitHub API failed but electron-updater says no update available.
          // Clear the error status so Settings doesn't stay stuck in error state.
          setUpdateState((prev) => ({
            ...prev,
            manualCheckStatus: 'up-to-date',
          }));
          manualCheckResetTimeoutRef.current = setTimeout(() => {
            setUpdateState((prev) => ({ ...prev, manualCheckStatus: 'idle' }));
          }, 5000);
        }
      }).catch(() => {
        // Bridge unavailable — ignore; the manual download link remains visible
      });
    }

    return result;
  }, [performCheck]);

  const dismissUpdate = useCallback(() => {
    if (updateState.latestRelease?.version) {
      localStorageAdapter.writeString(
        STORAGE_KEY_UPDATE_DISMISSED_VERSION,
        updateState.latestRelease.version
      );
    }
    setUpdateState((prev) => ({ ...prev, hasUpdate: false }));
  }, [updateState.latestRelease?.version]);

  const openReleasePage = useCallback(async () => {
    const url = updateState.latestRelease
      ? getReleaseUrl(updateState.latestRelease.version)
      : getReleaseUrl();

    try {
      const bridge = netcattyBridge.get();
      if (bridge?.openExternal) {
        await bridge.openExternal(url);
        return;
      }
    } catch {
      // Fallback to window.open
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [updateState.latestRelease]);

  const installUpdate = useCallback(() => {
    netcattyBridge.get()?.installUpdate?.();
  }, []);

  // Startup check with delay - runs once on mount
  useEffect(() => {
    debugLog('Startup check effect mounted, IS_UPDATE_DEMO_MODE:', IS_UPDATE_DEMO_MODE);
    
    // In demo mode, trigger check immediately after a short delay
    if (IS_UPDATE_DEMO_MODE) {
      debugLog('Demo mode: scheduling update check in', STARTUP_CHECK_DELAY_MS, 'ms');
      
      startupCheckTimeoutRef.current = setTimeout(() => {
        debugLog('=== Demo mode: Triggering update check ===');
        void performCheck('0.0.1');
      }, STARTUP_CHECK_DELAY_MS);
      
      return () => {
        if (startupCheckTimeoutRef.current) {
          clearTimeout(startupCheckTimeoutRef.current);
        }
      };
    }
    
    // Normal mode: wait for version to be loaded, then check
    // This is handled by the version-dependent effect below
  }, [performCheck]);

  // Normal mode startup check - depends on currentVersion
  useEffect(() => {
    // Skip in demo mode (handled above)
    if (IS_UPDATE_DEMO_MODE) {
      return;
    }

    debugLog('Version check effect', {
      hasChecked: hasCheckedOnStartupRef.current,
      currentVersion: updateState.currentVersion
    });

    if (hasCheckedOnStartupRef.current) {
      return;
    }

    if (!updateState.currentVersion || updateState.currentVersion === '0.0.0') {
      return;
    }

    // Hydrate cached release info so update status is visible across windows.
    // When auto-update is disabled, hydrate release data (for the Settings UI)
    // but don't set hasUpdate (which would trigger the toast in App.tsx).
    const lastCheck = localStorageAdapter.readNumber(STORAGE_KEY_UPDATE_LAST_CHECK);
    if (lastCheck) {
      const cachedRelease = localStorageAdapter.readString(STORAGE_KEY_UPDATE_LATEST_RELEASE);
      if (cachedRelease) {
        try {
          const release = JSON.parse(cachedRelease) as ReleaseInfo;
          const dismissedVersion = localStorageAdapter.readString(STORAGE_KEY_UPDATE_DISMISSED_VERSION);
          const isNewer = updateState.currentVersion.localeCompare(release.version, undefined, { numeric: true, sensitivity: 'base' }) < 0;
          const showUpdate = isNewer && release.version !== dismissedVersion;
          setUpdateState((prev) => ({
            ...prev,
            latestRelease: prev.latestRelease ?? release,
            hasUpdate: prev.hasUpdate || showUpdate,
            lastCheckedAt: lastCheck,
          }));
        } catch {
          // Ignore corrupted cache
        }
      }
    }

    // Respect auto-update toggle — skip automatic check when disabled.
    // Don't set hasCheckedOnStartupRef so re-enabling (which changes the
    // autoUpdateEnabled dependency) can re-trigger this effect.
    if (!autoUpdateEnabled) {
      return;
    }

    // Check if we've checked recently
    const now = Date.now();
    if (lastCheck && now - lastCheck < UPDATE_CHECK_INTERVAL_MS) {
      hasCheckedOnStartupRef.current = true;
      return;
    }

    hasCheckedOnStartupRef.current = true;
    debugLog('Starting delayed update check for version:', updateState.currentVersion);

    startupCheckTimeoutRef.current = setTimeout(async () => {
      // Re-check the toggle at fire time — the user may have toggled it
      // after the timer was scheduled.
      const stillEnabled = localStorageAdapter.readString(STORAGE_KEY_AUTO_UPDATE_ENABLED);
      if (stillEnabled === 'false') {
        debugLog('Skipping startup check — auto-update disabled after timer was scheduled');
        return;
      }
      // If electron-updater's auto-check already started a download, skip the
      // redundant GitHub API check to avoid duplicate toast notifications.
      if (autoDownloadStatusRef.current !== 'idle') {
        debugLog('Skipping startup check — auto-download already active');
        return;
      }
      // If the main process check is still in flight, reschedule the
      // fallback instead of permanently skipping it — the auto-check may
      // fail silently (check-phase errors aren't broadcast to the renderer).
      try {
        const snapshot = await netcattyBridge.get()?.getUpdateStatus?.();
        if (snapshot?.isChecking) {
          debugLog('Main process check still in flight — rescheduling fallback');
          startupCheckTimeoutRef.current = setTimeout(async () => {
            if (autoDownloadStatusRef.current !== 'idle') return;
            // Re-check if the main process check is still running to avoid
            // duplicate notifications on very slow networks.
            try {
              const snap = await netcattyBridge.get()?.getUpdateStatus?.();
              if (snap?.isChecking || (snap?.status && snap.status !== 'idle')) return;
            } catch { /* fall through */ }
            debugLog('=== Rescheduled fallback check triggered ===');
            void performCheck(updateState.currentVersion);
          }, 5000);
          return;
        }
      } catch {
        // Bridge unavailable — fall through to GitHub check
      }
      debugLog('=== Delayed check triggered ===');
      void performCheck(updateState.currentVersion);
    }, STARTUP_CHECK_DELAY_MS);

    return () => {
      if (startupCheckTimeoutRef.current) {
        clearTimeout(startupCheckTimeoutRef.current);
      }
    };
  }, [updateState.currentVersion, autoUpdateEnabled, performCheck]);

  return {
    updateState,
    checkNow,
    dismissUpdate,
    openReleasePage,
    installUpdate,
  };
}
