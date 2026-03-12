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
import { STORAGE_KEY_PORT_FORWARDING } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { toast } from '../../components/ui/toast';

interface AutoSyncConfig {
  // Data to sync
  hosts: SyncPayload['hosts'];
  keys: SyncPayload['keys'];
  identities?: SyncPayload['identities'];
  snippets: SyncPayload['snippets'];
  customGroups: SyncPayload['customGroups'];
  portForwardingRules?: SyncPayload['portForwardingRules'];
  knownHosts?: SyncPayload['knownHosts'];
  
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
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncedDataRef = useRef<string>('');
  const hasCheckedRemoteRef = useRef(false);
  const isInitializedRef = useRef(false);
  
  // Build sync payload
  const buildPayload = useCallback((): SyncPayload => {
    // If port-forwarding hook state is still [] (async init in progress),
    // fall back to localStorage to avoid uploading an empty array that
    // overwrites the cloud snapshot.
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
    return {
      hosts: config.hosts,
      keys: config.keys,
      identities: config.identities,
      snippets: config.snippets,
      customGroups: config.customGroups,
      portForwardingRules: effectivePFRules,
      knownHosts: config.knownHosts,
      syncedAt: Date.now(),
    };
  }, [config.hosts, config.keys, config.identities, config.snippets, config.customGroups, config.portForwardingRules, config.knownHosts]);
  
  // Create a hash of current data for comparison
  const getDataHash = useCallback(() => {
    // Same fallback as buildPayload
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
    const data = {
      hosts: config.hosts,
      keys: config.keys,
      identities: config.identities,
      snippets: config.snippets,
      customGroups: config.customGroups,
      portForwardingRules: effectivePFRules,
      knownHosts: config.knownHosts,
    };
    return JSON.stringify(data);
  }, [config.hosts, config.keys, config.identities, config.snippets, config.customGroups, config.portForwardingRules, config.knownHosts]);
  
  // Sync now handler - get fresh state directly from manager
  const syncNow = useCallback(async (options?: SyncNowOptions) => {
    const trigger: SyncTrigger = options?.trigger ?? 'auto';

    try {
      // Get fresh state directly from CloudSyncManager singleton
      let state = manager.getState();

      const hasProvider = Object.values(state.providers).some((provider) => isProviderReadyForSync(provider));
      const syncing = state.syncState === 'SYNCING';

      if (!hasProvider) {
        throw new Error(t('sync.autoSync.noProvider'));
      }
      if (syncing) {
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

      const payload = buildPayload();
      const encryptedCredentialPaths = findSyncPayloadEncryptedCredentialPaths(payload);
      if (encryptedCredentialPaths.length > 0) {
        console.warn('[AutoSync] Blocked: encrypted credential placeholders found at:', encryptedCredentialPaths.join(', '));
        throw new Error(t('sync.credentialsUnavailable'));
      }

      const results = await sync.syncNow(payload);

      for (const result of results.values()) {
        if (!result.success) {
          if (result.conflictDetected) {
            throw new Error(t('sync.autoSync.conflictDetected'));
          }
          throw new Error(result.error || t('sync.autoSync.syncFailed'));
        }
      }

      lastSyncedDataRef.current = getDataHash();
    } catch (error) {
      if (trigger === 'manual') {
        throw error;
      }
      console.error('[AutoSync] Sync failed:', error);
      toast.error(
        error instanceof Error ? error.message : t('common.unknownError'),
        t('sync.autoSync.failedTitle'),
      );
    }
  }, [sync, buildPayload, getDataHash, t]);
  
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
      const remotePayload = await sync.downloadFromProvider(connectedProvider);
      
      if (remotePayload && remotePayload.syncedAt > state.localUpdatedAt) {
        console.log('[AutoSync] Remote is newer, applying...');
        config.onApplyPayload(remotePayload);
        toast.success(t('sync.autoSync.syncedMessage'), t('sync.autoSync.syncedTitle'));
      }
    } catch (error) {
      console.error('[AutoSync] Failed to check remote version:', error);
      // Don't show error toast for initial check - it's not critical
    }
  }, [sync, config, t]);
  
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
    
    // Skip if data hasn't changed
    if (currentHash === lastSyncedDataRef.current) {
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
  }, [sync.hasAnyConnectedProvider, sync.autoSyncEnabled, sync.isUnlocked, getDataHash, syncNow]);
  
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
