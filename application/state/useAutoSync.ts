/**
 * useAutoSync - Auto-sync Hook for Cloud Sync
 * 
 * Provides automatic sync capabilities:
 * - Sync when data changes (hosts, keys, snippets, port forwarding rules)
 * - Check remote version on app startup
 * - Debounced sync to avoid too frequent API calls
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCloudSync } from './useCloudSync';
import { useI18n } from '../i18n/I18nProvider';
import { getCloudSyncManager } from '../../infrastructure/services/CloudSyncManager';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  findSyncPayloadEncryptedCredentialPaths,
} from '../../domain/credentials';
import { isProviderReadyForSync, type CloudProvider, type SyncPayload } from '../../domain/sync';
import { collectSyncableSettings } from '../syncPayload';
import { STORAGE_KEY_PORT_FORWARDING } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { getEffectiveKnownHosts } from '../../infrastructure/syncHelpers';
import { notify } from '../notification';

/**
 * Check whether a sync payload has any meaningful user data. Covers all
 * synced entity arrays so that edge cases (e.g. user has 0 hosts but 1
 * port forwarding rule) are not mistakenly treated as "empty".
 */
function isPayloadEffectivelyEmpty(payload: SyncPayload): boolean {
  // Check all synced entity arrays.
  const hasEntities =
    (payload.hosts?.length ?? 0) > 0 ||
    (payload.keys?.length ?? 0) > 0 ||
    (payload.snippets?.length ?? 0) > 0 ||
    (payload.identities?.length ?? 0) > 0 ||
    (payload.customGroups?.length ?? 0) > 0 ||
    (payload.snippetPackages?.length ?? 0) > 0 ||
    (payload.portForwardingRules?.length ?? 0) > 0 ||
    (payload.knownHosts?.length ?? 0) > 0 ||
    (payload.groupConfigs?.length ?? 0) > 0;
  if (hasEntities) return false;
  // Also consider settings: if any key has a defined value, the user has
  // customized something worth preserving.
  if (payload.settings && Object.values(payload.settings).some((v) => v !== undefined)) {
    return false;
  }
  return true;
}

interface AutoSyncConfig {
  // Data to sync
  hosts: SyncPayload['hosts'];
  keys: SyncPayload['keys'];
  identities?: SyncPayload['identities'];
  snippets: SyncPayload['snippets'];
  customGroups: SyncPayload['customGroups'];
  snippetPackages?: SyncPayload['snippetPackages'];
  portForwardingRules?: SyncPayload['portForwardingRules'];
  knownHosts?: SyncPayload['knownHosts'];
  groupConfigs?: SyncPayload['groupConfigs'];
  /** Opaque token that changes whenever a synced setting changes. */
  settingsVersion?: number;

  // Callbacks
  onApplyPayload: (payload: SyncPayload) => void;
}

// Get manager singleton for direct state access
const manager = getCloudSyncManager();
const AUTO_SYNC_PROVIDER_ORDER: CloudProvider[] = ['github', 'google', 'onedrive', 'webdav', 's3'];

type SyncTrigger = 'auto' | 'manual';

interface SyncNowOptions {
  trigger?: SyncTrigger;
}

export const useAutoSync = (config: AutoSyncConfig) => {
  const { t } = useI18n();
  const sync = useCloudSync();
  const { onApplyPayload } = config;
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncedDataRef = useRef<string>('');
  const hasCheckedRemoteRef = useRef(false);
  /** True once checkRemoteVersion has completed (success or failure). Until
   *  this is set, the debounced auto-sync effect will not fire, preventing
   *  an empty local vault from racing ahead and overwriting a non-empty
   *  cloud vault before the startup pull has run. See #679. */
  const remoteCheckDoneRef = useRef(false);
  const isInitializedRef = useRef(false);
  const isSyncRunningRef = useRef(false);
  const skipNextSyncRef = useRef(false);

  // State for the empty-vault-vs-cloud confirmation dialog (Fix D).
  // When checkRemoteVersion detects that the local vault is empty but
  // the cloud has data, it pauses and exposes this state so the root
  // component can render a confirmation dialog.
  const [emptyVaultConflict, setEmptyVaultConflict] = useState<{
    remotePayload: SyncPayload;
    hostCount: number;
    keyCount: number;
    snippetCount: number;
  } | null>(null);
  const emptyVaultResolveRef = useRef<((action: 'restore' | 'keep-empty') => void) | null>(null);

  // Listen for SFTP bookmark changes to trigger auto-sync
  const [bookmarksVersion, setBookmarksVersion] = useState(0);
  useEffect(() => {
    const handler = () => setBookmarksVersion((v) => v + 1);
    window.addEventListener('sftp-bookmarks-changed', handler);
    return () => window.removeEventListener('sftp-bookmarks-changed', handler);
  }, []);

  const getSyncSnapshot = useCallback(() => {
    let effectivePFRules = config.portForwardingRules;
    if (!effectivePFRules || effectivePFRules.length === 0) {
      const stored = localStorageAdapter.read<SyncPayload['portForwardingRules']>(
        STORAGE_KEY_PORT_FORWARDING,
      );
      if (stored && Array.isArray(stored) && stored.length > 0) {
        effectivePFRules = stored.map((rule) => ({
          ...rule,
          status: 'inactive' as const,
          error: undefined,
          lastUsedAt: undefined,
        }));
      }
    }

    const effectiveKnownHosts = getEffectiveKnownHosts(config.knownHosts);

    return {
      hosts: config.hosts,
      keys: config.keys,
      identities: config.identities,
      snippets: config.snippets,
      customGroups: config.customGroups,
      snippetPackages: config.snippetPackages,
      portForwardingRules: effectivePFRules,
      knownHosts: effectiveKnownHosts,
      groupConfigs: config.groupConfigs,
    };
  }, [
    config.hosts,
    config.keys,
    config.identities,
    config.snippets,
    config.customGroups,
    config.snippetPackages,
    config.portForwardingRules,
    config.knownHosts,
    config.groupConfigs,
  ]);

  // Build sync payload
  const buildPayload = useCallback((): SyncPayload => {
    return {
      ...getSyncSnapshot(),
      settings: collectSyncableSettings(),
      syncedAt: Date.now(),
    };
  }, [getSyncSnapshot]);
  
  // Create a hash of current data for comparison (includes settings)
  const getDataHash = useCallback(() => {
    return JSON.stringify({ ...getSyncSnapshot(), settings: collectSyncableSettings() });
  }, [getSyncSnapshot]);
  
  // Sync now handler - get fresh state directly from manager
  const syncNow = useCallback(async (options?: SyncNowOptions) => {
    const trigger: SyncTrigger = options?.trigger ?? 'auto';

    isSyncRunningRef.current = true;
    try {
      // Get fresh state directly from CloudSyncManager singleton
      let state = manager.getState();

      const hasProvider = Object.values(state.providers).some((provider) => isProviderReadyForSync(provider));
      const syncing = state.syncState === 'SYNCING';

      if (!hasProvider) {
        throw new Error(t('sync.autoSync.noProvider'));
      }
      if (syncing) {
        if (trigger === 'auto') {
          console.info('[AutoSync] Skipping overlapping auto-sync because another sync is already running.');
          return;
        }
        throw new Error(t('sync.autoSync.alreadySyncing'));
      }

      // If another window unlocked, reuse the in-memory session password from main process.
      if (state.securityState !== 'UNLOCKED') {
        const bridge = netcattyBridge.get();
        const sessionPassword = await bridge?.cloudSyncGetSessionPassword?.();
        if (sessionPassword) {
          const ok = await sync.unlock(sessionPassword);
          if (!ok) {
            void bridge?.cloudSyncClearSessionPassword?.();
          }
        }
      }

      // Re-check after unlock attempt
      state = manager.getState();
      if (state.securityState !== 'UNLOCKED') {
        throw new Error(t('sync.autoSync.vaultLocked'));
      }

      const dataHash = getDataHash();
      const payload = buildPayload();
      const encryptedCredentialPaths = findSyncPayloadEncryptedCredentialPaths(payload);
      if (encryptedCredentialPaths.length > 0) {
        console.warn('[AutoSync] Blocked: encrypted credential placeholders found at:', encryptedCredentialPaths.join(', '));
        throw new Error(t('sync.credentialsUnavailable'));
      }

      // Prevent pushing an empty vault to cloud. This is almost always
      // a sign that the local state was lost (update, import failure,
      // storage corruption) rather than a deliberate "delete everything".
      // We only block auto-sync — manual trigger from Settings can still
      // push if the user explicitly wants to.
      if (isPayloadEffectivelyEmpty(payload) && trigger === 'auto') {
        console.warn('[AutoSync] Blocked: refusing to auto-sync an empty vault to cloud');
        return;
      }

      const results = await sync.syncNow(payload);

      // Apply merged payloads first (before checking for failures) so local
      // state gets updated even when some providers failed
      for (const result of results.values()) {
        if (result.mergedPayload) {
          onApplyPayload(result.mergedPayload);
          skipNextSyncRef.current = true;
          break; // All providers share the same merged payload
        }
      }

      for (const result of results.values()) {
        if (!result.success) {
          if (result.conflictDetected) {
            throw new Error(t('sync.autoSync.conflictDetected'));
          }
          throw new Error(result.error || t('sync.autoSync.syncFailed'));
        }
      }

      lastSyncedDataRef.current = dataHash;
    } catch (error) {
      if (trigger === 'manual') {
        throw error;
      }
      console.error('[AutoSync] Sync failed:', error);
      notify.error(
        error instanceof Error ? error.message : t('common.unknownError'),
        t('sync.autoSync.failedTitle'),
      );
    } finally {
      isSyncRunningRef.current = false;
    }
  }, [sync, buildPayload, getDataHash, onApplyPayload, t]);
  
  // Check remote version and pull if newer (on startup)
  const checkRemoteVersion = useCallback(async () => {
    const state = manager.getState();
    const hasProvider = Object.values(state.providers).some((provider) => isProviderReadyForSync(provider));
    const unlocked = state.securityState === 'UNLOCKED';
    
    if (!hasProvider || !unlocked || hasCheckedRemoteRef.current) {
      return;
    }
    
    hasCheckedRemoteRef.current = true;
    
    // Find connected provider
    const connectedProvider = AUTO_SYNC_PROVIDER_ORDER.find((provider) =>
      isProviderReadyForSync(state.providers[provider]),
    ) ?? null;
    
    if (!connectedProvider) return;
    
    try {
      // Load base BEFORE downloading (downloadFromProvider overwrites the base)
      const base = await manager.loadSyncBase(connectedProvider);
      const remotePayload = await sync.downloadFromProvider(connectedProvider);

      if (remotePayload && remotePayload.syncedAt > state.localUpdatedAt) {
        const localPayload = buildPayload();
        const localIsEmpty = isPayloadEffectivelyEmpty(localPayload);
        const remoteHasData = !isPayloadEffectivelyEmpty(remotePayload);

        // If local vault is empty but cloud has data, this almost certainly
        // means the user's data was lost (update, storage corruption, etc.).
        // Pause and ask the user what to do instead of silently merging.
        if (localIsEmpty && remoteHasData) {
          const userAction = await new Promise<'restore' | 'keep-empty'>((resolve) => {
            emptyVaultResolveRef.current = resolve;
            setEmptyVaultConflict({
              remotePayload,
              hostCount: remotePayload.hosts?.length ?? 0,
              keyCount: remotePayload.keys?.length ?? 0,
              snippetCount: remotePayload.snippets?.length ?? 0,
            });
          });
          setEmptyVaultConflict(null);
          emptyVaultResolveRef.current = null;

          if (userAction === 'restore') {
            config.onApplyPayload(remotePayload);
            skipNextSyncRef.current = true;
            notify.success(t('sync.autoSync.restoredMessage'), t('sync.autoSync.restoredTitle'));
          } else {
            // User chose to keep the empty vault. Don't apply remote data.
            // The next auto-sync will eventually push the empty state if
            // the user makes another edit.
            notify.info(t('sync.autoSync.keptLocalMessage'), t('sync.autoSync.keptLocalTitle'));
          }
          return;
        }

        const { mergeSyncPayloads } = await import('../../domain/syncMerge');
        const mergeResult = mergeSyncPayloads(base, localPayload, remotePayload);

        config.onApplyPayload(mergeResult.payload);
        // Prevent the data-change effect from immediately re-uploading the
        // merged payload — the merge already incorporated both sides. The
        // next deliberate edit by the user will trigger a normal sync.
        skipNextSyncRef.current = true;
        notify.success(t('sync.autoSync.syncedMessage'), t('sync.autoSync.syncedTitle'));
      }
    } catch (error) {
      console.error('[AutoSync] Failed to check remote version:', error);
    } finally {
      remoteCheckDoneRef.current = true;
    }
  }, [sync, config, buildPayload, t]);
  
  // Debounced auto-sync when data changes
  useEffect(() => {
    // Skip if not ready
    if (!sync.hasAnyConnectedProvider || !sync.autoSyncEnabled || !sync.isUnlocked) {
      return;
    }

    // Don't auto-sync until the startup remote check has completed.
    // Without this gate, an empty local vault can push to the cloud
    // before checkRemoteVersion even runs, overwriting a non-empty
    // remote vault — the exact bug described in #679.
    if (!remoteCheckDoneRef.current) {
      return;
    }

    // Skip initial render
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      lastSyncedDataRef.current = getDataHash();
      return;
    }
    
    const currentHash = getDataHash();

    // After a merge, onApplyPayload changes local state which triggers
    // this effect. Skip that cycle and just update the hash baseline.
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      lastSyncedDataRef.current = currentHash;
      return;
    }

    // Skip if data hasn't changed
    if (currentHash === lastSyncedDataRef.current) {
      return;
    }

    // Wait for the current sync to finish, then this effect will re-run
    // because sync.isSyncing changed.
    if (sync.isSyncing || isSyncRunningRef.current) {
      return;
    }
    
    // Clear existing timeout
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    
    // Debounce sync by 3 seconds
    syncTimeoutRef.current = setTimeout(() => {
      syncNow();
    }, 3000);
    
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [sync.hasAnyConnectedProvider, sync.autoSyncEnabled, sync.isUnlocked, sync.isSyncing, getDataHash, syncNow, config.settingsVersion, bookmarksVersion]);
  
  // Check remote version on startup/unlock
  useEffect(() => {
    if (sync.hasAnyConnectedProvider && sync.isUnlocked && !hasCheckedRemoteRef.current) {
      // Delay check to ensure everything is loaded
      const timer = setTimeout(() => {
        checkRemoteVersion();
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, [sync.hasAnyConnectedProvider, sync.isUnlocked, checkRemoteVersion]);
  
  // Reset check flags when provider disconnects
  useEffect(() => {
    if (!sync.hasAnyConnectedProvider) {
      hasCheckedRemoteRef.current = false;
      remoteCheckDoneRef.current = false;
    }
  }, [sync.hasAnyConnectedProvider]);
  
  const resolveEmptyVaultConflict = useCallback((action: 'restore' | 'keep-empty') => {
    // Guard: resolve only once (prevents double-click from entering an
    // inconsistent state). The ref is nulled immediately so subsequent
    // calls are no-ops.
    const resolve = emptyVaultResolveRef.current;
    if (!resolve) return;
    emptyVaultResolveRef.current = null;
    resolve(action);
  }, []);

  return {
    syncNow,
    buildPayload,
    isSyncing: sync.isSyncing,
    isConnected: sync.hasAnyConnectedProvider,
    autoSyncEnabled: sync.autoSyncEnabled,
    emptyVaultConflict,
    resolveEmptyVaultConflict,
  };
};

export default useAutoSync;
