/**
 * useCloudSync - React Hook for Cloud Sync State Management
 * 
 * Provides a complete React interface to the CloudSyncManager.
 * Handles security state machine, provider connections, and sync operations.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CloudProvider,
  type SecurityState,
  type SyncState,
  type ProviderConnection,
  type ConflictInfo,
  type ConflictResolution,
  type SyncPayload,
  type SyncResult,
  type SyncEvent,
  formatLastSync,
  getSyncDotColor,
} from '../../domain/sync';
import {
  CloudSyncManager,
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
  completePKCEAuth: (
    provider: 'google' | 'onedrive',
    code: string,
    redirectUri: string
  ) => Promise<void>;
  disconnectProvider: (provider: CloudProvider) => Promise<void>;
  
  // Sync Actions
  syncNow: (payload: SyncPayload) => Promise<Map<CloudProvider, SyncResult>>;
  syncToProvider: (provider: CloudProvider, payload: SyncPayload) => Promise<SyncResult>;
  downloadFromProvider: (provider: CloudProvider) => Promise<SyncPayload | null>;
  resolveConflict: (resolution: ConflictResolution) => Promise<SyncPayload | null>;
  
  // Settings
  setAutoSync: (enabled: boolean, intervalMinutes?: number) => void;
  setDeviceName: (name: string) => void;
  
  // Utilities
  formatLastSync: (timestamp?: number) => string;
  getProviderDotColor: (provider: CloudProvider) => string;
}

export interface GitHubAuthState {
  isAuthenticating: boolean;
  deviceFlowState: DeviceFlowState | null;
  error: string | null;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export const useCloudSync = (): CloudSyncHook => {
  const [manager] = useState<CloudSyncManager>(() => getCloudSyncManager());
  const [state, setState] = useState<SyncManagerState>(() => manager.getState());
  
  // Subscribe to manager events
  useEffect(() => {
    const unsubscribe = manager.subscribe((event: SyncEvent) => {
      // Refresh state on any event
      setState(manager.getState());
      
      // Handle specific events if needed
      switch (event.type) {
        case 'SECURITY_STATE_CHANGED':
        case 'SYNC_COMPLETED':
        case 'SYNC_ERROR':
        case 'AUTH_COMPLETED':
        case 'CONFLICT_DETECTED':
          setState(manager.getState());
          break;
      }
    });
    
    return unsubscribe;
  }, [manager]);
  
  // ========== Computed Values ==========
  
  const hasAnyConnectedProvider = useMemo(() => {
    return (Object.values(state.providers) as ProviderConnection[]).some(p => p.status === 'connected');
  }, [state.providers]);
  
  const connectedProviderCount = useMemo(() => {
    return (Object.values(state.providers) as ProviderConnection[]).filter(p => p.status === 'connected').length;
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
  
  const setupMasterKey = useCallback(async (password: string, confirmPassword: string) => {
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    await manager.setupMasterKey(password);
    setState(manager.getState());
  }, [manager]);
  
  const unlock = useCallback(async (password: string): Promise<boolean> => {
    const success = await manager.unlock(password);
    setState(manager.getState());
    return success;
  }, [manager]);
  
  const lock = useCallback(() => {
    manager.lock();
    setState(manager.getState());
  }, [manager]);
  
  const changeMasterKey = useCallback(async (
    oldPassword: string,
    newPassword: string
  ): Promise<boolean> => {
    const success = await manager.changeMasterKey(oldPassword, newPassword);
    setState(manager.getState());
    return success;
  }, [manager]);
  
  const verifyPassword = useCallback(async (password: string): Promise<boolean> => {
    return manager.verifyPassword(password);
  }, [manager]);
  
  // ========== Provider Actions ==========
  
  const connectGitHub = useCallback(async (): Promise<DeviceFlowState> => {
    const result = await manager.startProviderAuth('github');
    if (result.type !== 'device_code') {
      throw new Error('Unexpected auth type');
    }
    setState(manager.getState());
    return result.data as DeviceFlowState;
  }, [manager]);
  
  const completeGitHubAuth = useCallback(async (
    deviceCode: string,
    interval: number,
    expiresAt: number,
    onPending?: () => void
  ): Promise<void> => {
    await manager.completeGitHubAuth(deviceCode, interval, expiresAt, onPending);
    setState(manager.getState());
  }, [manager]);
  
  const connectGoogle = useCallback(async (): Promise<string> => {
    const result = await manager.startProviderAuth('google');
    if (result.type !== 'url') {
      throw new Error('Unexpected auth type');
    }
    setState(manager.getState());
    const data = result.data as { url: string; redirectUri: string };
    
    // Start OAuth callback server in Electron and wait for authorization
    const bridge = netcattyBridge.get();
    const startCallback = bridge?.startOAuthCallback;
    if (startCallback) {
      // Get state from adapter for CSRF protection
      const adapter = manager.getAdapter('google') as { getPKCEState?: () => string | null } | undefined;
      const expectedState = adapter?.getPKCEState?.() || undefined;
      
      // Start callback server and open browser
      const callbackPromise = startCallback(expectedState);
      
      // Open browser after starting server
      setTimeout(() => {
        window.open(data.url, '_blank', 'width=600,height=700');
      }, 100);
      
      // Wait for callback
      const { code } = await callbackPromise;
      
      // Complete auth with the received code
      await manager.completePKCEAuth('google', code, data.redirectUri);
      setState(manager.getState());
    }
    
    return data.url;
  }, [manager]);
  
  const connectOneDrive = useCallback(async (): Promise<string> => {
    const result = await manager.startProviderAuth('onedrive');
    if (result.type !== 'url') {
      throw new Error('Unexpected auth type');
    }
    setState(manager.getState());
    const data = result.data as { url: string; redirectUri: string };
    
    // Start OAuth callback server in Electron and wait for authorization
    const bridge = netcattyBridge.get();
    const startCallback = bridge?.startOAuthCallback;
    if (startCallback) {
      // Get state from adapter for CSRF protection
      const adapter = manager.getAdapter('onedrive') as { getPKCEState?: () => string | null } | undefined;
      const expectedState = adapter?.getPKCEState?.() || undefined;
      
      // Start callback server and open browser
      const callbackPromise = startCallback(expectedState);
      
      // Open browser after starting server
      setTimeout(() => {
        window.open(data.url, '_blank', 'width=600,height=700');
      }, 100);
      
      // Wait for callback
      const { code } = await callbackPromise;
      
      // Complete auth with the received code
      await manager.completePKCEAuth('onedrive', code, data.redirectUri);
      setState(manager.getState());
    }
    
    return data.url;
  }, [manager]);
  
  const completePKCEAuth = useCallback(async (
    provider: 'google' | 'onedrive',
    code: string,
    redirectUri: string
  ): Promise<void> => {
    await manager.completePKCEAuth(provider, code, redirectUri);
    setState(manager.getState());
  }, [manager]);
  
  const disconnectProvider = useCallback(async (provider: CloudProvider): Promise<void> => {
    await manager.disconnectProvider(provider);
    setState(manager.getState());
  }, [manager]);
  
  // ========== Sync Actions ==========
  
  const syncNow = useCallback(async (
    payload: SyncPayload
  ): Promise<Map<CloudProvider, SyncResult>> => {
    const results = await manager.syncAllProviders(payload);
    setState(manager.getState());
    return results;
  }, [manager]);
  
  const syncToProvider = useCallback(async (
    provider: CloudProvider,
    payload: SyncPayload
  ): Promise<SyncResult> => {
    const result = await manager.syncToProvider(provider, payload);
    setState(manager.getState());
    return result;
  }, [manager]);
  
  const downloadFromProvider = useCallback(async (
    provider: CloudProvider
  ): Promise<SyncPayload | null> => {
    const payload = await manager.downloadFromProvider(provider);
    setState(manager.getState());
    return payload;
  }, [manager]);
  
  const resolveConflict = useCallback(async (
    resolution: ConflictResolution
  ): Promise<SyncPayload | null> => {
    const payload = await manager.resolveConflict(resolution);
    setState(manager.getState());
    return payload;
  }, [manager]);
  
  // ========== Settings ==========
  
  const setAutoSync = useCallback((enabled: boolean, intervalMinutes?: number) => {
    manager.setAutoSync(enabled, intervalMinutes);
    setState(manager.getState());
  }, [manager]);
  
  const setDeviceName = useCallback((name: string) => {
    // This would need to be added to manager
    manager.setDeviceName?.(name);
  }, [manager]);
  
  // ========== Utilities ==========
  
  const getProviderDotColor = useCallback((provider: CloudProvider): string => {
    return getSyncDotColor(state.providers[provider].status);
  }, [state.providers]);
  
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
    completePKCEAuth,
    disconnectProvider,
    
    // Sync Actions
    syncNow,
    syncToProvider,
    downloadFromProvider,
    resolveConflict,
    
    // Settings
    setAutoSync,
    setDeviceName,
    
    // Utilities
    formatLastSync,
    getProviderDotColor,
  };
};

// ============================================================================
// Convenience Hooks
// ============================================================================

/**
 * Hook for just the security state (lighter weight)
 */
export const useSecurityState = () => {
  const [manager] = useState<CloudSyncManager>(() => getCloudSyncManager());
  const [securityState, setSecurityState] = useState<SecurityState>(
    () => manager.getSecurityState()
  );
  
  useEffect(() => {
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === 'SECURITY_STATE_CHANGED') {
        setSecurityState(event.state);
      }
    });
    return unsubscribe;
  }, [manager]);
  
  return {
    securityState,
    isUnlocked: securityState === 'UNLOCKED',
    isLocked: securityState === 'LOCKED',
    hasNoKey: securityState === 'NO_KEY',
  };
};

/**
 * Hook for provider status indicators
 */
export const useProviderStatus = (provider: CloudProvider) => {
  const [manager] = useState<CloudSyncManager>(() => getCloudSyncManager());
  const [connection, setConnection] = useState<ProviderConnection>(
    () => manager.getProviderConnection(provider)
  );
  
  useEffect(() => {
    const unsubscribe = manager.subscribe(() => {
      setConnection(manager.getProviderConnection(provider));
    });
    return unsubscribe;
  }, [manager, provider]);
  
  return {
    ...connection,
    isConnected: connection.status === 'connected',
    isSyncing: connection.status === 'syncing',
    hasError: connection.status === 'error',
    dotColor: getSyncDotColor(connection.status),
    lastSyncFormatted: formatLastSync(connection.lastSync),
  };
};

export default useCloudSync;
