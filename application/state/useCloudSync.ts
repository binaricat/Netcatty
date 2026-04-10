/**
 * useCloudSync - React Hook for Cloud Sync State Management
 * 
 * Provides a complete React interface to the CloudSyncManager.
 * Handles security state machine, provider connections, and sync operations.
 * Uses useSyncExternalStore for real-time state synchronization across all components.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  type CloudProvider,
  type SecurityState,
  type SyncState,
  type ProviderConnection,
  type ConflictInfo,
  type ConflictResolution,
  type SyncPayload,
  type SyncResult,
  type SyncHistoryEntry,
  type WebDAVConfig,
  type S3Config,
  formatLastSync,
  getSyncDotColor,
  isProviderReadyForSync,
} from '../../domain/sync';
import {
  getCloudSyncManager,
  type SyncManagerState,
} from '../../infrastructure/services/CloudSyncManager';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { DeviceFlowState } from '../../infrastructure/services/adapters/GitHubAdapter';

// ============================================================================
// Types
// ============================================================================

export interface CloudSyncHook {
  // State
  securityState: SecurityState;
  syncState: SyncState;
  isUnlocked: boolean;
  isSyncing: boolean;
  providers: Record<CloudProvider, ProviderConnection>;
  currentConflict: ConflictInfo | null;
  lastError: string | null;
  deviceName: string;
  autoSyncEnabled: boolean;
  autoSyncInterval: number;
  localVersion: number;
  localUpdatedAt: number;
  remoteVersion: number;
  remoteUpdatedAt: number;
  syncHistory: SyncHistoryEntry[];
  
  // Computed
  hasAnyConnectedProvider: boolean;
  connectedProviderCount: number;
  overallSyncStatus: 'none' | 'synced' | 'syncing' | 'error' | 'conflict';
  
  // Master Key Actions
  setupMasterKey: (password: string, confirmPassword: string) => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  lock: () => void;
  changeMasterKey: (oldPassword: string, newPassword: string) => Promise<boolean>;
  verifyPassword: (password: string) => Promise<boolean>;
  
  // Provider Actions
  connectGitHub: () => Promise<DeviceFlowState>;
  completeGitHubAuth: (
    deviceCode: string,
    interval: number,
    expiresAt: number,
    onPending?: () => void
  ) => Promise<void>;
  connectGoogle: () => Promise<string>;
  connectOneDrive: () => Promise<string>;
  connectWebDAV: (config: WebDAVConfig) => Promise<void>;
  connectS3: (config: S3Config) => Promise<void>;
  completePKCEAuth: (
    provider: 'google' | 'onedrive',
    code: string,
    redirectUri: string
  ) => Promise<void>;
  cancelOAuthConnect: () => void;
  disconnectProvider: (provider: CloudProvider) => Promise<void>;
  resetProviderStatus: (provider: CloudProvider) => void;

  // Sync Actions
  syncNow: (payload: SyncPayload) => Promise<Map<CloudProvider, SyncResult>>;
  syncToProvider: (provider: CloudProvider, payload: SyncPayload) => Promise<SyncResult>;
  downloadFromProvider: (provider: CloudProvider) => Promise<SyncPayload | null>;
  resolveConflict: (resolution: ConflictResolution) => Promise<SyncPayload | null>;

  // Gist Revision History
  getGistRevisionHistory: () => Promise<Array<{ version: string; date: Date }>>;
  downloadGistRevision: (sha: string) => Promise<{
    payload: SyncPayload;
    meta: import('../../domain/sync').SyncFileMeta;
    preview: {
      hostCount: number;
      keyCount: number;
      snippetCount: number;
      identityCount: number;
      portForwardingRuleCount: number;
    };
  } | null>;

  // Settings
  setAutoSync: (enabled: boolean, intervalMinutes?: number) => void;
  setDeviceName: (name: string) => void;

  // Local Data Reset
  resetLocalVersion: () => void;

  // Utilities
  formatLastSync: (timestamp?: number) => string;
  getProviderDotColor: (provider: CloudProvider) => string;
  refresh: () => void;
}

// ============================================================================
// Hook Implementation
// ============================================================================

// Singleton manager instance
const manager = getCloudSyncManager();

// Subscribe function for useSyncExternalStore
const subscribe = (callback: () => void) => {
  return manager.subscribeToStateChanges(callback);
};

// Get snapshot function for useSyncExternalStore
const getSnapshot = (): SyncManagerState => {
  return manager.getState();
};

export const useCloudSync = (): CloudSyncHook => {
  // Use useSyncExternalStore for real-time state sync across all components
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Auto-unlock: if a master key exists, retrieve the persisted password (Electron safeStorage)
  // and unlock silently so users don't have to manage a LOCKED state in the UI.
  // Track the master key config hash to detect when a new master key is set up in another window.
  const lastMasterKeyHashRef = useRef<string | null>(null);
  const attemptedAutoUnlockRef = useRef(false);
  useEffect(() => {
    // Compute a simple hash of the master key config to detect changes
    const currentHash = state.masterKeyConfig 
      ? JSON.stringify({ salt: state.masterKeyConfig.salt, kdf: state.masterKeyConfig.kdf })
      : null;
    
    // If master key config changed (e.g., set up in settings window), reset the attempt flag
    if (currentHash !== lastMasterKeyHashRef.current) {
      lastMasterKeyHashRef.current = currentHash;
      attemptedAutoUnlockRef.current = false;
    }
    
    if (attemptedAutoUnlockRef.current) return;
    if (state.securityState !== 'LOCKED') return;
    attemptedAutoUnlockRef.current = true;

    void (async () => {
      try {
        const bridge = netcattyBridge.get();
        const password = await bridge?.cloudSyncGetSessionPassword?.();
        if (!password) return;

        const ok = await manager.unlock(password);
        if (!ok) {
          void bridge?.cloudSyncClearSessionPassword?.();
        }
      } catch {
        // Ignore auto-unlock errors; manual actions will surface them.
      }
    })();
  }, [state.securityState, state.masterKeyConfig]);
  
  // ========== Computed Values ==========
  
  const hasAnyConnectedProvider = useMemo(() => {
    return (Object.values(state.providers) as ProviderConnection[]).some(
      (p) => isProviderReadyForSync(p)
    );
  }, [state.providers]);
  
  const connectedProviderCount = useMemo(() => {
    return (Object.values(state.providers) as ProviderConnection[]).filter(
      (p) => isProviderReadyForSync(p)
    ).length;
  }, [state.providers]);
  
  const overallSyncStatus = useMemo((): 'none' | 'synced' | 'syncing' | 'error' | 'conflict' => {
    if (state.syncState === 'CONFLICT') return 'conflict';
    if (state.syncState === 'ERROR') return 'error';
    if (state.syncState === 'SYNCING') return 'syncing';
    
    const statuses = (Object.values(state.providers) as ProviderConnection[]).map(p => p.status);
    if (statuses.some(s => s === 'syncing')) return 'syncing';
    if (statuses.some(s => s === 'error')) return 'error';
    if (statuses.some(s => s === 'connected')) return 'synced';
    
    return 'none';
  }, [state.syncState, state.providers]);
  
  // ========== Master Key Actions ==========
  // Note: No need for setState calls - useSyncExternalStore automatically updates
  // when manager emits events and calls notifyStateChange()
  
  const setupMasterKey = useCallback(async (password: string, confirmPassword: string) => {
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    await manager.setupMasterKey(password);
    void netcattyBridge.get()?.cloudSyncSetSessionPassword?.(password);
  }, []);
  
  const unlock = useCallback(async (password: string): Promise<boolean> => {
    const ok = await manager.unlock(password);
    if (ok) {
      void netcattyBridge.get()?.cloudSyncSetSessionPassword?.(password);
    }
    return ok;
  }, []);
  
  const lock = useCallback(() => {
    void netcattyBridge.get()?.cloudSyncClearSessionPassword?.();
    manager.lock();
  }, []);
  
  const changeMasterKey = useCallback(async (
    oldPassword: string,
    newPassword: string
  ): Promise<boolean> => {
    const ok = await manager.changeMasterKey(oldPassword, newPassword);
    if (ok) {
      void netcattyBridge.get()?.cloudSyncSetSessionPassword?.(newPassword);
    }
    return ok;
  }, []);
  
  const verifyPassword = useCallback(async (password: string): Promise<boolean> => {
    return manager.verifyPassword(password);
  }, []);
  
  // ========== Provider Actions ==========
  
  const connectGitHub = useCallback(async (): Promise<DeviceFlowState> => {
    const result = await manager.startProviderAuth('github');
    if (result.type !== 'device_code') {
      throw new Error('Unexpected auth type');
    }
    return result.data as DeviceFlowState;
  }, []);
  
  const completeGitHubAuth = useCallback(async (
    deviceCode: string,
    interval: number,
    expiresAt: number,
    onPending?: () => void
  ): Promise<void> => {
    await manager.completeGitHubAuth(deviceCode, interval, expiresAt, onPending);
  }, []);
  
  const connectGoogle = useCallback(async (): Promise<string> => {
    const result = await manager.startProviderAuth('google');
    if (result.type !== 'url') {
      throw new Error('Unexpected auth type');
    }
    const data = result.data as { url: string; redirectUri: string };

    // Start OAuth callback server in Electron and wait for authorization
    const bridge = netcattyBridge.get();
    const startCallback = bridge?.startOAuthCallback;
    if (startCallback) {
      // Get state from adapter for CSRF protection
      const adapter = manager.getAdapter('google') as { getPKCEState?: () => string | null } | undefined;
      const expectedState = adapter?.getPKCEState?.() || undefined;

      // Start callback server and open system browser
      const callbackPromise = startCallback(expectedState);

      // Use system browser to avoid white-screen issues in popup windows (#563)
      // Race: if browser launch fails, surface the error immediately
      let openTimer: ReturnType<typeof setTimeout> | null = null;
      const browserPromise = new Promise<never>((_resolve, reject) => {
        openTimer = setTimeout(async () => {
          try {
            await bridge?.openExternal(data.url);
          } catch (err) {
            bridge?.cancelOAuthCallback?.();
            reject(err instanceof Error ? err : new Error('Failed to open browser for authentication'));
          }
        }, 100);
      });

      try {
        const { code } = await Promise.race([callbackPromise, browserPromise]);

        // Complete auth with the received code
        await manager.completePKCEAuth('google', code, data.redirectUri);
      } finally {
        if (openTimer) clearTimeout(openTimer);
      }
    }

    return data.url;
  }, []);

  const connectOneDrive = useCallback(async (): Promise<string> => {
    const result = await manager.startProviderAuth('onedrive');
    if (result.type !== 'url') {
      throw new Error('Unexpected auth type');
    }
    const data = result.data as { url: string; redirectUri: string };

    // Start OAuth callback server in Electron and wait for authorization
    const bridge = netcattyBridge.get();
    const startCallback = bridge?.startOAuthCallback;
    if (startCallback) {
      // Get state from adapter for CSRF protection
      const adapter = manager.getAdapter('onedrive') as { getPKCEState?: () => string | null } | undefined;
      const expectedState = adapter?.getPKCEState?.() || undefined;

      // Start callback server and open system browser
      const callbackPromise = startCallback(expectedState);

      // Use system browser to avoid white-screen issues in popup windows (#563)
      let openTimer: ReturnType<typeof setTimeout> | null = null;
      const browserPromise = new Promise<never>((_resolve, reject) => {
        openTimer = setTimeout(async () => {
          try {
            await bridge?.openExternal(data.url);
          } catch (err) {
            bridge?.cancelOAuthCallback?.();
            reject(err instanceof Error ? err : new Error('Failed to open browser for authentication'));
          }
        }, 100);
      });

      try {
        const { code } = await Promise.race([callbackPromise, browserPromise]);

        // Complete auth with the received code
        await manager.completePKCEAuth('onedrive', code, data.redirectUri);
      } finally {
        if (openTimer) clearTimeout(openTimer);
      }
    }

    return data.url;
  }, []);
  
  const completePKCEAuth = useCallback(async (
    provider: 'google' | 'onedrive',
    code: string,
    redirectUri: string
  ): Promise<void> => {
    await manager.completePKCEAuth(provider, code, redirectUri);
  }, []);
  
  const disconnectProvider = useCallback(async (provider: CloudProvider): Promise<void> => {
    await manager.disconnectProvider(provider);
  }, []);

  const resetProviderStatus = useCallback((provider: CloudProvider): void => {
    manager.resetProviderStatus(provider);
  }, []);

  const connectWebDAV = useCallback(async (config: WebDAVConfig): Promise<void> => {
    await manager.connectConfigProvider('webdav', config);
  }, []);

  const connectS3 = useCallback(async (config: S3Config): Promise<void> => {
    await manager.connectConfigProvider('s3', config);
  }, []);
  
  const cancelOAuthConnect = useCallback(() => {
    const bridge = netcattyBridge.get();
    bridge?.cancelOAuthCallback?.();
  }, []);

  // ========== Settings ==========
  
  const setAutoSync = useCallback((enabled: boolean, intervalMinutes?: number) => {
    manager.setAutoSync(enabled, intervalMinutes);
  }, []);
  
  const setDeviceName = useCallback((name: string) => {
    manager.setDeviceName(name);
  }, []);
  
  // ========== Utilities ==========
  
  const getProviderDotColor = useCallback((provider: CloudProvider): string => {
    return getSyncDotColor(state.providers[provider].status);
  }, [state.providers]);
  
  const refresh = useCallback(() => {
    // Force a re-render by triggering state change notification
    // This is now a no-op since useSyncExternalStore handles updates automatically
  }, []);

  const ensureUnlocked = useCallback(async (): Promise<void> => {
    const current = manager.getState();
    if (current.securityState === 'UNLOCKED') return;
    if (current.securityState === 'NO_KEY') {
      throw new Error('No master key configured');
    }

    const bridge = netcattyBridge.get();
    const password = await bridge?.cloudSyncGetSessionPassword?.();
    if (password) {
      const ok = await manager.unlock(password);
      if (ok) return;
      void bridge?.cloudSyncClearSessionPassword?.();
    }

    throw new Error('Vault is locked');
  }, []);

  const syncNowWithUnlock = useCallback(async (payload: SyncPayload) => {
    await ensureUnlocked();
    return await manager.syncAllProviders(payload);
  }, [ensureUnlocked]);

  const syncToProviderWithUnlock = useCallback(async (provider: CloudProvider, payload: SyncPayload) => {
    await ensureUnlocked();
    return await manager.syncToProvider(provider, payload);
  }, [ensureUnlocked]);

  const downloadFromProviderWithUnlock = useCallback(async (provider: CloudProvider) => {
    await ensureUnlocked();
    return await manager.downloadFromProvider(provider);
  }, [ensureUnlocked]);

  const resolveConflictWithUnlock = useCallback(async (resolution: ConflictResolution) => {
    await ensureUnlocked();
    return await manager.resolveConflict(resolution);
  }, [ensureUnlocked]);
  
  return {
    // State
    securityState: state.securityState,
    syncState: state.syncState,
    isUnlocked: state.securityState === 'UNLOCKED',
    isSyncing: state.syncState === 'SYNCING',
    providers: state.providers,
    currentConflict: state.currentConflict,
    lastError: state.lastError,
    deviceName: state.deviceName,
    autoSyncEnabled: state.autoSyncEnabled,
    autoSyncInterval: state.autoSyncInterval,
    localVersion: state.localVersion,
    localUpdatedAt: state.localUpdatedAt,
    remoteVersion: state.remoteVersion,
    remoteUpdatedAt: state.remoteUpdatedAt,
    syncHistory: state.syncHistory,
    
    // Computed
    hasAnyConnectedProvider,
    connectedProviderCount,
    overallSyncStatus,
    
    // Master Key Actions
    setupMasterKey,
    unlock,
    lock,
    changeMasterKey,
    verifyPassword,
    
    // Provider Actions
    connectGitHub,
    completeGitHubAuth,
    connectGoogle,
    connectOneDrive,
    connectWebDAV,
    connectS3,
    completePKCEAuth,
    cancelOAuthConnect,
    disconnectProvider,
    resetProviderStatus,

    // Sync Actions
    syncNow: syncNowWithUnlock,
    syncToProvider: syncToProviderWithUnlock,
    downloadFromProvider: downloadFromProviderWithUnlock,
    resolveConflict: resolveConflictWithUnlock,

    // Gist Revision History (#679)
    getGistRevisionHistory: manager.getGistRevisionHistory.bind(manager),
    downloadGistRevision: manager.downloadGistRevision.bind(manager),
    
    // Settings
    setAutoSync,
    setDeviceName,

    // Local Data Reset
    resetLocalVersion: () => manager.resetLocalVersion(),

    // Utilities
    formatLastSync,
    getProviderDotColor,
    refresh,
  };
};

export default useCloudSync;
