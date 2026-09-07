/**
 * useCloudSync - React Hook for Cloud Sync State Management
 * 
 * Provides a complete React interface to the CloudSyncManager.
 * Handles security state machine, provider connections, and sync operations.
 * Uses useSyncExternalStore for real-time state synchronization across all components.
 */

import { useCloudSyncAutoUnlock } from './useCloudSyncAutoUnlock';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  type CloudProvider,
  type SecurityState,
  type SyncState,
  type ProviderConnection,
  type ConflictInfo,
  type ConflictResolution,
  type RemoteSyncPayload,
  type SyncedFile,
  type SyncPayload,
  type SyncResult,
  type SyncHistoryEntry,
  type ConvergentFieldConflict,
  type WebDAVConfig,
  type S3Config,
  formatLastSync,
  getSyncDotColor,
  isProviderReadyForSync,
} from '../../domain/sync';
import type { CloudSyncStrategy } from '../../domain/syncStrategy';
import type { CloudSyncConflictAction } from '../../domain/syncStrategy';
import {
  getCloudSyncManager,
  type SyncManagerState,
  type SyncEventCallback,
} from '../../infrastructure/services/CloudSyncManager';
import type { ShrinkFinding } from '../../domain/syncGuards';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { DeviceFlowState } from '../../infrastructure/services/adapters/GitHubAdapter';
import {
  getConvergentSyncLocalConfig,
  getConvergentSyncLocalConfigSnapshot,
  pauseConvergentSync,
  refreshConvergentSyncLocalConfigSnapshot,
  setConvergentSyncLocalConfig,
  subscribeConvergentSyncLocalConfig,
  type ConvergentSyncLocalConfig,
} from '../../infrastructure/services/convergentSyncConfig';

// ============================================================================
// Types
// ============================================================================

type ConvergentPayloadApplier = (
  payload: SyncPayload,
  commitReplica: () => Promise<void>,
) => Promise<void>;

interface CloudSyncRunOptions {
  overrideShrink?: boolean;
  conflictActionOverride?: CloudSyncConflictAction;
  applyConvergentPayload?: ConvergentPayloadApplier;
  signal?: AbortSignal;
}

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
  syncStrategy: CloudSyncStrategy;
  localVersion: number;
  localUpdatedAt: number;
  remoteVersion: number;
  remoteUpdatedAt: number;
  syncHistory: SyncHistoryEntry[];
  pendingLocalSync: boolean;
  convergentConflicts: ConvergentFieldConflict[];
  convergentSyncConfig: ConvergentSyncLocalConfig;
  pendingBrowserAuthProvider: 'google' | 'onedrive' | null;
  
  // Computed
  hasAnyConnectedProvider: boolean;
  connectedProviderCount: number;
  overallSyncStatus: 'none' | 'synced' | 'syncing' | 'error' | 'conflict' | 'blocked';
  
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
    onPending?: () => void,
    signal?: AbortSignal,
    authAttemptId?: number
  ) => Promise<void>;
  connectGoogle: () => Promise<string>;
  /** Connect a namespaced plugin sync Provider (encrypted-object storage only). */
  connectPluginProvider: (
    providerId: string,
    configuration?: unknown,
    credential?: unknown,
  ) => Promise<void>;
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
  syncNow: (payload: SyncPayload, opts?: CloudSyncRunOptions) => Promise<Map<CloudProvider, SyncResult>>;
  syncToProvider: (
    provider: CloudProvider,
    payload: SyncPayload,
    opts?: Pick<CloudSyncRunOptions, 'overrideShrink' | 'applyConvergentPayload' | 'signal'>,
  ) => Promise<SyncResult>;
  downloadFromProvider: (provider: CloudProvider) => Promise<RemoteSyncPayload | null>;
  commitRemoteInspection: (provider: CloudProvider, remoteFile: SyncedFile, payload: SyncPayload, opts?: { recordDownload?: boolean }) => Promise<void>;
  resolveConflict: (resolution: ConflictResolution) => Promise<RemoteSyncPayload | null>;
  resolveConvergentConflict: (
    addressKey: string,
    candidateDot: string,
    applyPayload: (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => Promise<void>,
  ) => Promise<{ payload: SyncPayload; results: Map<CloudProvider, SyncResult> }>;
  downgradeConvergentSync: (
    confirmed: boolean,
    buildLocalPayload: () => SyncPayload | Promise<SyncPayload>,
    applyPayload: (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => Promise<void>,
  ) => Promise<Map<CloudProvider, SyncResult>>;

  // Gist Revision History
  getGistRevisionHistory: () => Promise<Array<{ version: string; date: Date }>>;
  downloadGistRevision: (sha: string) => Promise<{
    payload: SyncPayload;
    meta: import('../../domain/sync').SyncFileMeta;
    preview: {
      hostCount: number;
      keyCount: number;
      snippetCount: number;
      noteCount: number;
      identityCount: number;
      portForwardingRuleCount: number;
    };
  } | null>;

  // Settings
  setAutoSync: (enabled: boolean, intervalMinutes?: number) => void;
  setDeviceName: (name: string) => void;
  setSyncStrategy: (strategy: CloudSyncStrategy) => void;
  setConvergentSyncEnabled: (enabled: boolean) => ConvergentSyncLocalConfig;
  refreshConvergentSyncConfig: () => ConvergentSyncLocalConfig;

  // Local Data Reset
  resetLocalVersion: () => void;

  // Utilities
  formatLastSync: (timestamp?: number) => string;
  getProviderDotColor: (provider: CloudProvider) => string;
  refresh: () => void;

  // Event subscription (for non-state events like SYNC_BLOCKED_SHRINK)
  subscribeToEvents: (callback: SyncEventCallback) => () => void;

  // Shrink-block state query (for banner hydration on mount)
  getShrinkBlockedFinding: () => Extract<ShrinkFinding, { suspicious: true }> | null;
}

type PendingBrowserAuthState = {
  provider: 'google' | 'onedrive';
  sessionId: string;
  authAttemptId?: number;
} | null;

let pendingBrowserAuthState: PendingBrowserAuthState = null;
const pendingBrowserAuthListeners = new Set<() => void>();
let activeOAuthBrowserHandoff:
  | { sessionId: string; cancel: () => void }
  | null = null;
const cancelledOAuthSessionIds = new Set<string>();

const getPendingBrowserAuthState = (): PendingBrowserAuthState => pendingBrowserAuthState;

const subscribePendingBrowserAuthState = (callback: () => void) => {
  pendingBrowserAuthListeners.add(callback);
  return () => pendingBrowserAuthListeners.delete(callback);
};

const setPendingBrowserAuthState = (next: PendingBrowserAuthState) => {
  pendingBrowserAuthState = next;
  pendingBrowserAuthListeners.forEach((callback) => callback());
};

const clearPendingBrowserAuthState = (
  match?: { provider: 'google' | 'onedrive'; sessionId: string; authAttemptId?: number }
) => {
  if (!match) {
    setPendingBrowserAuthState(null);
    return;
  }
  if (
    pendingBrowserAuthState &&
    pendingBrowserAuthState.provider === match.provider &&
    pendingBrowserAuthState.sessionId === match.sessionId
  ) {
    setPendingBrowserAuthState(null);
  }
};

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
  const pendingBrowserAuth = useSyncExternalStore(
    subscribePendingBrowserAuthState,
    getPendingBrowserAuthState,
    getPendingBrowserAuthState
  );
  const activeOAuthSessionIdRef = useRef<string | null>(null);
  const activeOAuthProviderRef = useRef<'google' | 'onedrive' | null>(null);
  const activeGitHubAuthAbortRef = useRef<AbortController | null>(null);
  const activeGitHubAuthAttemptIdRef = useRef<number | null>(null);
  const convergentSyncConfig = useSyncExternalStore(
    subscribeConvergentSyncLocalConfig,
    getConvergentSyncLocalConfigSnapshot,
    getConvergentSyncLocalConfigSnapshot,
  );

  useCloudSyncAutoUnlock({
    securityState: state.securityState,
    masterKeyIdentity: state.masterKeyConfig
      ? JSON.stringify(state.masterKeyConfig)
      : null,
    manager,
    bridge: netcattyBridge.get(),
  });

  useEffect(() => {
    if (state.securityState !== 'UNLOCKED') return;
    if (!getConvergentSyncLocalConfig().initialized) return;
    void manager.refreshConvergentConflicts().catch(() => {
      // A missing/corrupt replica is surfaced by the next explicit sync.
    });
  }, [state.securityState]);

  // Keep plugin sync provider availability aligned with live contributions so
  // disabled/uninstalled providers leave the auto-sync ready set after restart.
  useEffect(() => {
    let cancelled = false;
    const refreshAvailable = async () => {
      try {
        const { pluginExtensionBridge } = await import('./pluginExtensionBridge');
        const listed = await pluginExtensionBridge.listProviders('sync');
        if (cancelled) return;
        const ids = (listed ?? []).map((entry) => {
          const nested = (entry as { provider?: { id?: string } }).provider;
          return typeof nested?.id === 'string' ? nested.id : '';
        }).filter((id) => id.length > 0);
        manager.setAvailablePluginSyncProviders(ids);
      } catch {
        // Transient IPC / host startup failures must not wipe the availability
        // catalog; leave the previous set until a successful discovery.
      }
    };
    void refreshAvailable();
    let unsubscribe = () => {};
    void import('./pluginExtensionBridge').then(({ pluginExtensionBridge }) => {
      if (cancelled) return;
      unsubscribe = pluginExtensionBridge.onContributionsChanged(() => {
        void refreshAvailable();
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  
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
  
  const overallSyncStatus = useMemo((): 'none' | 'synced' | 'syncing' | 'error' | 'conflict' | 'blocked' => {
    if (state.syncState === 'BLOCKED') return 'blocked';
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
    activeGitHubAuthAttemptIdRef.current = result.data.authAttemptId ?? null;
    return result.data;
  }, []);
  
  const completeGitHubAuth = useCallback(async (
    deviceCode: string,
    interval: number,
    expiresAt: number,
    onPending?: () => void,
    signal?: AbortSignal,
    authAttemptId?: number
  ): Promise<void> => {
    const controller = new AbortController();
    const abort = () => controller.abort();

    if (signal?.aborted) {
      abort();
    } else if (signal) {
      signal.addEventListener('abort', abort, { once: true });
    }

    activeGitHubAuthAbortRef.current = controller;

    try {
      await manager.completeGitHubAuth(
        deviceCode,
        interval,
        expiresAt,
        onPending,
        controller.signal,
        authAttemptId
      );
    } finally {
      if (signal) {
        signal.removeEventListener('abort', abort);
      }
      if (activeGitHubAuthAbortRef.current === controller) {
        activeGitHubAuthAbortRef.current = null;
      }
      if (activeGitHubAuthAttemptIdRef.current === (authAttemptId ?? null)) {
        activeGitHubAuthAttemptIdRef.current = null;
      }
    }
  }, []);

  const cancelActivePKCEAuth = useCallback(async () => {
    const pending = getPendingBrowserAuthState();
    const sessionId = pending?.sessionId ?? activeOAuthSessionIdRef.current;
    const provider = pending?.provider ?? activeOAuthProviderRef.current;
    const authAttemptId = pending?.authAttemptId;
    if (!sessionId || !provider) return;

    cancelledOAuthSessionIds.add(sessionId);
    if (activeOAuthBrowserHandoff?.sessionId === sessionId) {
      activeOAuthBrowserHandoff.cancel();
      activeOAuthBrowserHandoff = null;
    }
    manager.cancelProviderAuthAttempt(provider, authAttemptId);
    activeOAuthSessionIdRef.current = null;
    activeOAuthProviderRef.current = null;
    clearPendingBrowserAuthState(
      pending
        ? {
            provider: pending.provider,
            sessionId: pending.sessionId,
            authAttemptId: pending.authAttemptId,
          }
        : undefined
    );

    try {
      await netcattyBridge.get()?.cancelOAuthCallback?.(sessionId);
    } catch {
      // Best-effort cleanup
    }
  }, []);
  
  const runPKCEAuth = useCallback(
    async (provider: 'google' | 'onedrive'): Promise<string> => {
      const bridge = netcattyBridge.get();
      const prepare = bridge?.prepareOAuthCallback;
      const awaitCallback = bridge?.awaitOAuthCallback;
      const openExternal = bridge?.openExternal;
      if (!prepare || !awaitCallback || !openExternal) {
        throw new Error('OAuth bridge is unavailable');
      }

      // Only one loopback OAuth flow can be active at a time. If the user
      // starts another provider while a previous browser hop is still pending,
      // cancel the stale one first so the new attempt owns the callback port.
      await cancelActivePKCEAuth();

      // Bind the loopback callback server first so we know which port to put
      // in the provider's redirect_uri (#823: 45678 may be in use).
      const { redirectUri, sessionId } = await prepare();
      activeOAuthSessionIdRef.current = sessionId;
      activeOAuthProviderRef.current = provider;
      setPendingBrowserAuthState({ provider, sessionId });

      try {
        const result = await manager.startProviderAuth(provider, redirectUri);
        if (result.type !== 'url') {
          throw new Error('Unexpected auth type');
        }
        const data = result.data;

        if (cancelledOAuthSessionIds.has(sessionId)) {
          throw new Error('OAuth flow cancelled');
        }

        const adapter = manager.getAdapter(provider) as
          | { getPKCEState?: () => string | null }
          | undefined;
        const expectedState = adapter?.getPKCEState?.() || undefined;

        const callbackPromise = awaitCallback(expectedState, sessionId);

        // Use system browser to avoid white-screen issues in popup windows (#563).
        // Once the browser has opened, let the rest of the PKCE handshake
        // continue in the background so closing the browser later does not
        // leave the whole settings page locked waiting on a timeout.
        let openTimer: ReturnType<typeof setTimeout> | null = null;
        let browserOpened = false;
        let rejectBrowserPromise: ((error: Error) => void) | null = null;
        const browserPromise = new Promise<void>((resolve, reject) => {
          rejectBrowserPromise = reject;
          openTimer = setTimeout(async () => {
            try {
              await openExternal(data.url);
              browserOpened = true;
              resolve();
            } catch (err) {
              bridge?.cancelOAuthCallback?.(sessionId);
              reject(
                err instanceof Error
                  ? err
                  : new Error('Failed to open browser for authentication')
              );
            }
          }, 100);
        });
        activeOAuthBrowserHandoff = {
          sessionId,
          cancel: () => {
          if (openTimer) {
            clearTimeout(openTimer);
            openTimer = null;
          }
          if (rejectBrowserPromise) {
            rejectBrowserPromise(new Error('OAuth flow cancelled'));
            rejectBrowserPromise = null;
          }
          },
        };

        try {
          await Promise.race([
            browserPromise,
            callbackPromise.then(
              () => {
                throw new Error('OAuth callback completed before browser handoff');
              },
              (error) => {
                if (browserOpened) {
                  return new Promise<void>(() => {});
                }
                throw error;
              }
            ),
          ]);
        } finally {
          if (openTimer) clearTimeout(openTimer);
          if (activeOAuthBrowserHandoff?.sessionId === sessionId) {
            activeOAuthBrowserHandoff = null;
          }
        }
        setPendingBrowserAuthState({
          provider,
          sessionId,
          authAttemptId: data.authAttemptId,
        });

        const completionPromise = (async () => {
          try {
            const { code } = await callbackPromise;
            await manager.completePKCEAuth(provider, code, data.redirectUri, data.authAttemptId);
          } catch (error) {
            const ownsActiveSession =
              activeOAuthSessionIdRef.current === sessionId &&
              activeOAuthProviderRef.current === provider;
            const message = error instanceof Error ? error.message : String(error);
            const cancelledOrSuperseded =
              message.includes('cancelled') || message.includes('auth superseded');
            const timedOut = message.toLowerCase().includes('timeout');
            if (ownsActiveSession && (cancelledOrSuperseded || timedOut)) {
              activeOAuthSessionIdRef.current = null;
              activeOAuthProviderRef.current = null;
              cancelledOAuthSessionIds.delete(sessionId);
              clearPendingBrowserAuthState({
                provider,
                sessionId,
                authAttemptId: data.authAttemptId,
              });
              manager.resetProviderStatus(provider);
            } else if (ownsActiveSession) {
              activeOAuthSessionIdRef.current = null;
              activeOAuthProviderRef.current = null;
              cancelledOAuthSessionIds.delete(sessionId);
              clearPendingBrowserAuthState({
                provider,
                sessionId,
                authAttemptId: data.authAttemptId,
              });
              manager.setProviderError(provider, message);
            }
          } finally {
            if (
              activeOAuthSessionIdRef.current === sessionId &&
              activeOAuthProviderRef.current === provider
            ) {
              activeOAuthSessionIdRef.current = null;
              activeOAuthProviderRef.current = null;
            }
            cancelledOAuthSessionIds.delete(sessionId);
            clearPendingBrowserAuthState({
              provider,
              sessionId,
              authAttemptId: data.authAttemptId,
            });
          }
        })();

        // Release the transient "connecting" UI once the browser handoff has
        // happened. The callback session remains active in the background and
        // will mark the provider connected when the redirect completes.
        // Do NOT use resetProviderStatus here — it would restore from the
        // auth snapshot and delete the adapter we just created, making the
        // eventual completePKCEAuth call fail with "adapter not initialized".
        manager.clearConnectingStatus(provider);
        manager.clearProviderError(provider);
        void completionPromise;
        return data.url;
      } catch (err) {
        const ownsActiveSession =
          activeOAuthSessionIdRef.current === sessionId &&
          activeOAuthProviderRef.current === provider;
        try {
          await bridge?.cancelOAuthCallback?.(sessionId);
        } catch {
          // Best-effort cleanup
        }
        if (ownsActiveSession) {
          activeOAuthSessionIdRef.current = null;
          activeOAuthProviderRef.current = null;
          manager.cancelProviderAuthAttempt(provider);
          manager.resetProviderStatus(provider);
        }
        throw err;
      }
    },
    [cancelActivePKCEAuth]
  );

  const connectGoogle = useCallback(async (): Promise<string> => {
    return runPKCEAuth('google');
  }, [runPKCEAuth]);

  const connectOneDrive = useCallback(async (): Promise<string> => {
    return runPKCEAuth('onedrive');
  }, [runPKCEAuth]);

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

  /**
   * Connect a namespaced plugin sync Provider (encrypted-object storage only).
   * Configuration is opaque plugin-owned JSON; encryption stays host-owned.
   */
  const connectPluginProvider = useCallback(async (
    providerId: string,
    configuration: unknown = {},
    credential?: unknown,
  ): Promise<void> => {
    await manager.connectPluginProvider(providerId, configuration, credential);
  }, []);
  
  const cancelOAuthConnect = useCallback(() => {
    const githubAbort = activeGitHubAuthAbortRef.current;
    if (githubAbort) {
      manager.cancelProviderAuthAttempt('github', activeGitHubAuthAttemptIdRef.current ?? undefined);
      activeGitHubAuthAttemptIdRef.current = null;
      githubAbort.abort();
      return;
    }

    void cancelActivePKCEAuth();
  }, [cancelActivePKCEAuth]);

  // ========== Settings ==========
  
  const setAutoSync = useCallback((enabled: boolean, intervalMinutes?: number) => {
    manager.setAutoSync(enabled, intervalMinutes);
  }, []);
  
  const setDeviceName = useCallback((name: string) => {
    manager.setDeviceName(name);
  }, []);

  const setSyncStrategy = useCallback((strategy: CloudSyncStrategy) => {
    manager.setSyncStrategy(strategy);
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

  const syncNowWithUnlock = useCallback(async (payload: SyncPayload, opts?: CloudSyncRunOptions) => {
    await ensureUnlocked();
    const controller = new AbortController();
    let onAbort: (() => void) | undefined;
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else {
        onAbort = () => controller.abort();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      const results = await manager.syncAllProviders(payload, { ...opts, signal: controller.signal });
      const { commitPluginSidecarsAfterSuccessfulSync } = await import('../pluginSyncSidecarBridge');
      commitPluginSidecarsAfterSuccessfulSync(payload, results.values());
      return results;
    } finally {
      if (opts?.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
  }, [ensureUnlocked]);

  const syncToProviderWithUnlock = useCallback(async (
    provider: CloudProvider,
    payload: SyncPayload,
    opts?: Pick<CloudSyncRunOptions, 'overrideShrink' | 'applyConvergentPayload' | 'signal'>,
  ) => {
    await ensureUnlocked();
    const controller = new AbortController();
    let onAbort: (() => void) | undefined;
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else {
        onAbort = () => controller.abort();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      const result = await manager.syncToProvider(provider, payload, { ...opts, signal: controller.signal });
      const { commitPluginSidecarsAfterSuccessfulSync } = await import('../pluginSyncSidecarBridge');
      commitPluginSidecarsAfterSuccessfulSync(payload, [result]);
      return result;
    } finally {
      if (opts?.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
  }, [ensureUnlocked]);

  const downloadFromProviderWithUnlock = useCallback(async (provider: CloudProvider) => {
    await ensureUnlocked();
    return await manager.downloadFromProvider(provider);
  }, [ensureUnlocked]);

  const commitRemoteInspectionWithUnlock = useCallback(async (
    provider: CloudProvider,
    remoteFile: SyncedFile,
    payload: SyncPayload,
    opts: { recordDownload?: boolean } = {},
  ) => {
    await ensureUnlocked();
    await manager.commitRemoteInspection(provider, remoteFile, payload, opts);
  }, [ensureUnlocked]);

  const subscribeToEvents = useCallback(
    (callback: SyncEventCallback) => manager.subscribe(callback),
    [],
  );

  const getShrinkBlockedFinding = useCallback(
    () => manager.getShrinkBlockedFinding(),
    [],
  );

  const resolveConflictWithUnlock = useCallback(async (resolution: ConflictResolution) => {
    await ensureUnlocked();
    return await manager.resolveConflict(resolution);
  }, [ensureUnlocked]);

  const resolveConvergentConflictWithUnlock = useCallback(async (
    addressKey: string,
    candidateDot: string,
    applyPayload: (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => Promise<void>,
  ) => {
    await ensureUnlocked();
    // Collect live sidecars so conflict apply/upload does not revert plugin
    // settings that changed after the last provider baseline. Operational
    // collection failures must abort (not proceed as empty). Host gated off /
    // non-authoritative collect must omit the field (not last-known cache) so
    // apply preserves local DB sidecars.
    const {
      collectPluginSyncSidecarsFromHost,
      isPluginSidecarHostUnavailableError,
    } = await import('../pluginSyncSidecarBridge');
    let pluginSidecars: SyncPayload['pluginSidecars'] | undefined;
    try {
      const collected = await collectPluginSyncSidecarsFromHost({ liveOnly: true });
      if (collected) pluginSidecars = collected;
    } catch (error) {
      if (isPluginSidecarHostUnavailableError(error)) {
        // Host gated off: omit field so apply preserves local sidecars.
      } else {
        throw error;
      }
    }
    return manager.resolveConvergentConflict(addressKey, candidateDot, applyPayload, {
      pluginSidecars,
    });
  }, [ensureUnlocked]);

  const refreshConvergentSyncConfig = useCallback(() => {
    return refreshConvergentSyncLocalConfigSnapshot();
  }, []);

  const setConvergentSyncEnabled = useCallback((enabled: boolean) => {
    const current = getConvergentSyncLocalConfig();
    const next = enabled
      ? setConvergentSyncLocalConfig({ enabled: true, initialized: current.initialized })
      : pauseConvergentSync();
    return next;
  }, []);

  const downgradeConvergentSyncWithUnlock = useCallback(async (
    confirmed: boolean,
    buildLocalPayload: () => SyncPayload | Promise<SyncPayload>,
    applyPayload: (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => Promise<void>,
  ) => {
    await ensureUnlocked();
    return manager.downgradeConvergentSync(confirmed, buildLocalPayload, applyPayload);
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
    syncStrategy: state.syncStrategy,
    localVersion: state.localVersion,
    localUpdatedAt: state.localUpdatedAt,
    remoteVersion: state.remoteVersion,
    remoteUpdatedAt: state.remoteUpdatedAt,
    syncHistory: state.syncHistory,
    pendingLocalSync: state.pendingLocalSync,
    convergentConflicts: state.convergentConflicts,
    convergentSyncConfig,
    pendingBrowserAuthProvider: pendingBrowserAuth?.provider ?? null,
    
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
    connectPluginProvider,
    completePKCEAuth,
    cancelOAuthConnect,
    disconnectProvider,
    resetProviderStatus,

    // Sync Actions
    syncNow: syncNowWithUnlock,
    syncToProvider: syncToProviderWithUnlock,
    downloadFromProvider: downloadFromProviderWithUnlock,
    commitRemoteInspection: commitRemoteInspectionWithUnlock,
    resolveConflict: resolveConflictWithUnlock,
    resolveConvergentConflict: resolveConvergentConflictWithUnlock,
    downgradeConvergentSync: downgradeConvergentSyncWithUnlock,

    // Gist Revision History (#679)
    getGistRevisionHistory: manager.getGistRevisionHistory.bind(manager),
    downloadGistRevision: manager.downloadGistRevision.bind(manager),
    
    // Settings
    setAutoSync,
    setDeviceName,
    setSyncStrategy,
    setConvergentSyncEnabled,
    refreshConvergentSyncConfig,

    // Local Data Reset
    resetLocalVersion: () => manager.resetLocalVersion(),

    // Utilities
    formatLastSync,
    getProviderDotColor,
    refresh,

    // Event subscription
    subscribeToEvents,

    // Shrink-block state query
    getShrinkBlockedFinding,
  };
};

export default useCloudSync;
