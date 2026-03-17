/**
 * useAutoSync - Auto-sync Hook for Cloud Sync
 * 
 * Provides automatic sync capabilities:
 * - Sync when data changes (hosts, keys, snippets, port forwarding rules)
 * - Check remote version on app startup
 * - Debounced sync to avoid too frequent API calls
 */

import { useCallback, useEffect, useRef } from 'react';
import { useCloudSync } from './useCloudSync';
import { useI18n } from '../i18n/I18nProvider';
import { getCloudSyncManager } from '../../infrastructure/services/CloudSyncManager';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  findSyncPayloadEncryptedCredentialPaths,
} from '../../domain/credentials';
import { isProviderReadyForSync, type CloudProvider, type SyncPayload } from '../../domain/sync';
import { collectSyncableSettings } from '../../domain/syncPayload';
import { STORAGE_KEY_PORT_FORWARDING } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { getEffectiveKnownHosts } from '../../infrastructure/syncHelpers';
import { toast } from '../../components/ui/toast';

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
  const isInitializedRef = useRef(false);
  const isSyncRunningRef = useRef(false);
  const skipNextSyncRef = useRef(false);

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
      toast.error(
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
      console.log('[AutoSync] Checking remote version...');
      // Load base BEFORE downloading (downloadFromProvider overwrites the base)
      const base = await manager.loadSyncBase(connectedProvider);
      const remotePayload = await sync.downloadFromProvider(connectedProvider);

      if (remotePayload && remotePayload.syncedAt > state.localUpdatedAt) {
        const { mergeSyncPayloads } = await import('../../domain/syncMerge');
        const localPayload = buildPayload();
        const mergeResult = mergeSyncPayloads(base, localPayload, remotePayload);

        console.log('[AutoSync] Remote is newer, merged:', mergeResult.summary);
        config.onApplyPayload(mergeResult.payload);
        // Don't save base or skip auto-sync — let the data-change effect
        // naturally trigger an upload of the merged payload (which will
        // go through syncAllProviders and save base on success).
        toast.success(t('sync.autoSync.syncedMessage'), t('sync.autoSync.syncedTitle'));
      }
    } catch (error) {
      console.error('[AutoSync] Failed to check remote version:', error);
    }
  }, [sync, config, buildPayload, t]);
  
  // Debounced auto-sync when data changes
  useEffect(() => {
    // Skip if not ready
    if (!sync.hasAnyConnectedProvider || !sync.autoSyncEnabled || !sync.isUnlocked) {
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
      console.log('[AutoSync] Data changed, syncing...');
      syncNow();
    }, 3000);
    
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [sync.hasAnyConnectedProvider, sync.autoSyncEnabled, sync.isUnlocked, sync.isSyncing, getDataHash, syncNow, config.settingsVersion]);
  
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
  
  // Reset check flag when provider disconnects
  useEffect(() => {
    if (!sync.hasAnyConnectedProvider) {
      hasCheckedRemoteRef.current = false;
    }
  }, [sync.hasAnyConnectedProvider]);
  
  return {
    syncNow,
    buildPayload,
    isSyncing: sync.isSyncing,
    isConnected: sync.hasAnyConnectedProvider,
    autoSyncEnabled: sync.autoSyncEnabled,
  };
};

export default useAutoSync;
