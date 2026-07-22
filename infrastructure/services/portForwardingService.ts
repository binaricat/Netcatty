/**
 * Port Forwarding Service
 * Handles communication between the frontend and the Electron backend
 * for establishing and managing SSH port forwarding tunnels.
 */

import { Host, Identity, KnownHost, PortForwardingRule, SSHKey, TerminalSettings } from '../../domain/models';
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from '../../domain/credentials';
import { resolveBridgeKeyAuth, resolveBridgeSshAgentAuth, resolveHostAuth } from '../../domain/sshAuth';
import { resolveHostKeepalive } from '../../domain/host';
import { resolveHostSshConnectionTimeouts } from '../../domain/sshConnectionTimeouts';
import {
  findIncompleteProxyIdentityId,
  findMissingProxyIdentityId,
  formatIncompleteProxyIdentityMessage,
  formatMissingProxyIdentityMessage,
  hasUnreadableProxyCredential,
  hasUsableProxyConfig,
  resolveProxyConfigAuth,
} from '../../domain/proxyProfiles';

// Fallback matching DEFAULT_TERMINAL_SETTINGS so older call sites that don't
// thread terminalSettings still get the cloud-friendly defaults.
const FALLBACK_TERMINAL_SETTINGS = {
  verifyHostKeys: true,
  keepaliveInterval: 30,
  keepaliveCountMax: 10,
};
import { logger } from '../../lib/logger';
import { localStorageAdapter } from '../persistence/localStorageAdapter';
import { STORAGE_KEY_PF_RECONNECT_CANCEL } from '../config/storageKeys';
import { netcattyBridge } from './netcattyBridge';

export interface PortForwardingConnection {
  ruleId: string;
  tunnelId: string;
  status: 'inactive' | 'connecting' | 'active' | 'error';
  error?: string;
  unsubscribe?: () => void;
  locallyInitiated?: boolean;
  // Reconnect state
  reconnectAttempts?: number;
  reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  reconnectDueAt?: number;
  reconnectTimerCallback?: () => void;
  reconnectStartAuthorized?: boolean;
  syncedShouldReconnect?: () => boolean;
  syncedOnStatusChange?: (
    status: PortForwardingRule['status'],
    error?: string,
  ) => void;
}

// Map to track active connections
const activeConnections = new Map<string, PortForwardingConnection>();
// Rules are added only when their bounded automatic reconnect cycle is
// exhausted. This distinguishes a local-outage failure from a tunnel that the
// user intentionally stopped while leaving auto-start enabled for next launch.
const exhaustedReconnectRules = new Set<string>();
const rulesPendingCleanup = new Set<string>();
const manualStopsInProgress = new Set<string>();
const ruleCleanupPromises = new Map<string, Promise<{ success: boolean; error?: string }>>();
const deferredReconnects = new Map<string, {
  enableReconnect: boolean;
  onStatusChange: (status: PortForwardingRule['status'], error?: string) => void;
}>();

// Reconnect configuration
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000; // 3 seconds between reconnection attempts

// Callbacks for auto-reconnect - will be set by the state hook
let reconnectCallback: ((
  ruleId: string,
  onStatusChange: (status: PortForwardingRule['status'], error?: string) => void
) => Promise<{ success: boolean; error?: string }>) | null = null;

/**
 * Set the reconnect callback (called by state hook to enable auto-reconnect)
 */
export const setReconnectCallback = (
  callback: typeof reconnectCallback
): void => {
  reconnectCallback = callback;
};

/**
 * Clear any pending reconnect for a rule
 */
export const clearReconnectTimer = (ruleId: string): void => {
  const conn = activeConnections.get(ruleId);
  if (conn?.reconnectTimeoutId) {
    clearTimeout(conn.reconnectTimeoutId);
  }
  if (conn) {
    conn.reconnectTimeoutId = undefined;
    conn.reconnectDueAt = undefined;
    conn.reconnectTimerCallback = undefined;
  }
};

/**
 * Give a failed/retrying auto-start rule a fresh bounded retry cycle after
 * local network recovery. Returns false for inactive rules that were stopped
 * manually and therefore must stay stopped until the next app launch.
 */
export const resetReconnectAttempts = (ruleId: string): boolean => {
  const connection = activeConnections.get(ruleId);
  const shouldRecover = exhaustedReconnectRules.has(ruleId) ||
    (connection?.reconnectAttempts ?? 0) > 0;
  if (connection) connection.reconnectAttempts = 0;
  return shouldRecover;
};

/** Re-check recovery eligibility after asynchronous backend reconciliation. */
export const isReconnectRecoveryEligible = (ruleId: string): boolean => {
  return exhaustedReconnectRules.has(ruleId);
};

interface PausedReconnectTimer {
  connection: PortForwardingConnection;
  callback: () => void;
  remainingMs: number;
}

const pauseReconnectTimer = (ruleId: string): PausedReconnectTimer | undefined => {
  const connection = activeConnections.get(ruleId);
  if (!connection?.reconnectTimeoutId || !connection.reconnectTimerCallback) return undefined;

  clearTimeout(connection.reconnectTimeoutId);
  const paused = {
    connection,
    callback: connection.reconnectTimerCallback,
    remainingMs: Math.max(0, (connection.reconnectDueAt ?? Date.now()) - Date.now()),
  };
  connection.reconnectTimeoutId = undefined;
  connection.reconnectDueAt = undefined;
  connection.reconnectTimerCallback = undefined;
  return paused;
};

const restoreReconnectTimer = (ruleId: string, paused?: PausedReconnectTimer): void => {
  if (!paused) return;
  const connection = activeConnections.get(ruleId);
  if (connection !== paused.connection || connection.reconnectTimeoutId) return;

  connection.reconnectDueAt = Date.now() + paused.remainingMs;
  connection.reconnectTimerCallback = paused.callback;
  connection.reconnectTimeoutId = setTimeout(paused.callback, paused.remainingMs);
};

// Cross-window reconnect cancellation via localStorage broadcast.
// When one window deletes/replaces a rule, it writes to this key so
// other windows (with pending reconnect timers) can cancel them.
const broadcastReconnectCancel = (ruleId: string): void => {
  try {
    // Write then immediately remove so the storage event fires on
    // other windows without leaving stale data.
    localStorageAdapter.writeString(STORAGE_KEY_PF_RECONNECT_CANCEL, ruleId);
    localStorageAdapter.remove(STORAGE_KEY_PF_RECONNECT_CANCEL);
  } catch {
    // localStorage may be unavailable in some contexts
  }
};

/**
 * Start listening for cross-window reconnect cancellation events.
 * Should be called once at app init (e.g. in the port-forwarding state hook).
 * Returns a cleanup function.
 */
export const initReconnectCancelListener = (): (() => void) => {
  const handler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY_PF_RECONNECT_CANCEL || !e.newValue) return;
    const ruleId = e.newValue;
    exhaustedReconnectRules.delete(ruleId);
    clearReconnectTimer(ruleId);

    const conn = activeConnections.get(ruleId);
    if (conn) {
      conn.unsubscribe?.();
      activeConnections.delete(ruleId);
    }

    // Also ask the backend to stop any tunnel for this rule.
    // This catches tunnels still in SSH handshake that aren't yet
    // in the renderer's activeConnections or the backend's list output.
    const bridge = netcattyBridge.get();
    if (bridge?.stopPortForwardByRuleId) {
      bridge.stopPortForwardByRuleId(ruleId).catch((err: unknown) => {
        logger.warn(`[PortForwardingService] Cross-window stopByRuleId failed for ${ruleId}:`, err);
      });
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
};

/**
 * Helper function to schedule a reconnection attempt
 * Returns true if a reconnect was scheduled, false otherwise
 */
const scheduleReconnectIfNeeded = (
  ruleId: string,
  enableReconnect: boolean,
  onStatusChange: (status: PortForwardingRule['status'], error?: string) => void,
): boolean => {
  if (!enableReconnect || !reconnectCallback) {
    return false;
  }
  if (rulesPendingCleanup.has(ruleId)) {
    deferredReconnects.set(ruleId, { enableReconnect, onStatusChange });
    return true;
  }

  const currentConn = activeConnections.get(ruleId);
  const attempts = (currentConn?.reconnectAttempts ?? 0) + 1;

  if (attempts <= MAX_RECONNECT_ATTEMPTS) {
    // If the activeConnections entry was already deleted (e.g. by
    // stopAndCleanupRule while the handshake was in-flight), we
    // can't actually schedule a reconnect.  Return false so the
    // caller transitions to 'inactive' instead of stuck 'connecting'.
    if (!currentConn) {
      return false;
    }

    logger.info(`[PortForwardingService] Scheduling reconnect ${attempts}/${MAX_RECONNECT_ATTEMPTS}`);

    currentConn.reconnectAttempts = attempts;
    exhaustedReconnectRules.delete(ruleId);
    const runReconnect = () => {
      if (currentConn.reconnectTimerCallback !== runReconnect) return;
      currentConn.reconnectTimeoutId = undefined;
      currentConn.reconnectDueAt = undefined;
      currentConn.reconnectTimerCallback = undefined;
      if (reconnectCallback) {
        currentConn.reconnectStartAuthorized = true;
        reconnectCallback(ruleId, onStatusChange);
      }
    };
    currentConn.reconnectDueAt = Date.now() + RECONNECT_DELAY_MS;
    currentConn.reconnectTimerCallback = runReconnect;
    currentConn.reconnectTimeoutId = setTimeout(runReconnect, RECONNECT_DELAY_MS);

    const reconnectMessage = `Reconnecting (${attempts}/${MAX_RECONNECT_ATTEMPTS})...`;
    currentConn.status = 'connecting';
    currentConn.error = reconnectMessage;
    onStatusChange('connecting', reconnectMessage);
    return true;
  }

  logger.warn(`[PortForwardingService] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for rule ${ruleId}`);
  exhaustedReconnectRules.add(ruleId);
  // Reset reconnect attempts
  if (currentConn) {
    currentConn.reconnectAttempts = 0;
  }
  return false;
};

/**
 * Get active connection info for a rule
 */
export const getActiveConnection = (ruleId: string): PortForwardingConnection | undefined => {
  return activeConnections.get(ruleId);
};

/**
 * Get all active connection rule IDs
 */
export const getActiveRuleIds = (): string[] => {
  return Array.from(activeConnections.entries())
    .filter(([_, conn]) => conn.status === 'active' || conn.status === 'connecting')
    .map(([ruleId]) => ruleId);
};

const finishRuleCleanup = (ruleId: string): void => {
  exhaustedReconnectRules.delete(ruleId);
  rulesPendingCleanup.delete(ruleId);
  deferredReconnects.delete(ruleId);
  clearReconnectTimer(ruleId);
  const conn = activeConnections.get(ruleId);
  conn?.unsubscribe?.();
  activeConnections.delete(ruleId);
  broadcastReconnectCancel(ruleId);
};

const preserveFailedStopConnection = (
  ruleId: string,
  connection: PortForwardingConnection | undefined,
  error: string,
): void => {
  const failedConnection = connection ?? {
    ruleId,
    tunnelId: `untracked-${ruleId}`,
    status: 'error' as const,
  };
  failedConnection.reconnectStartAuthorized = false;
  failedConnection.status = 'error';
  failedConnection.error = error;
  activeConnections.set(ruleId, failedConnection);
};

const resumeReconnectAfterFailedCleanup = (
  ruleId: string,
  pausedReconnect?: PausedReconnectTimer,
): void => {
  rulesPendingCleanup.delete(ruleId);
  const deferredReconnect = deferredReconnects.get(ruleId);
  deferredReconnects.delete(ruleId);
  if (pausedReconnect) {
    restoreReconnectTimer(ruleId, pausedReconnect);
    return;
  }
  if (deferredReconnect) {
    scheduleReconnectIfNeeded(
      ruleId,
      deferredReconnect.enableReconnect,
      deferredReconnect.onStatusChange,
    );
  }
};

/** Stop every tunnel for a rule and cancel reconnects in every window. */
export const stopAndCleanupRuleAndWait = (
  ruleId: string,
): Promise<{ success: boolean; error?: string }> => {
  const existingCleanup = ruleCleanupPromises.get(ruleId);
  if (existingCleanup) return existingCleanup;

  const cleanupPromise = (async () => {
    const conn = activeConnections.get(ruleId);
    rulesPendingCleanup.add(ruleId);
    const pausedReconnect = pauseReconnectTimer(ruleId);

    // Use stopPortForwardByRuleId so every tunnel for this rule is marked
    // cancelled before its sockets are closed.
    const bridge = netcattyBridge.get();
    if (bridge?.stopPortForwardByRuleId) {
      try {
        const result = await bridge.stopPortForwardByRuleId(ruleId);
        if ((result.failed ?? 0) > 0) {
          const error = result.errors?.filter(Boolean).join('; ') ||
            `Failed to stop ${result.failed} port forwarding tunnel(s)`;
          logger.warn(`[PortForwardingService] Backend stopByRuleId failed for ${ruleId}: ${error}`);
          resumeReconnectAfterFailedCleanup(ruleId, pausedReconnect);
          return { success: false, error };
        }
        finishRuleCleanup(ruleId);
        return { success: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn(`[PortForwardingService] Backend stopByRuleId failed for ${ruleId}:`, err);
        resumeReconnectAfterFailedCleanup(ruleId, pausedReconnect);
        return { success: false, error };
      }
    }
    if (conn && bridge?.stopPortForward) {
      try {
        const result = await bridge.stopPortForward(conn.tunnelId);
        if (result.success) {
          finishRuleCleanup(ruleId);
        } else {
          resumeReconnectAfterFailedCleanup(ruleId, pausedReconnect);
        }
        return result;
      } catch (err) {
        resumeReconnectAfterFailedCleanup(ruleId, pausedReconnect);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    finishRuleCleanup(ruleId);
    return { success: true };
  })();

  ruleCleanupPromises.set(ruleId, cleanupPromise);
  void cleanupPromise.then(
    () => {
      if (ruleCleanupPromises.get(ruleId) === cleanupPromise) ruleCleanupPromises.delete(ruleId);
    },
    () => {
      if (ruleCleanupPromises.get(ruleId) === cleanupPromise) ruleCleanupPromises.delete(ruleId);
    },
  );
  return cleanupPromise;
};

/** Fire-and-forget compatibility wrapper for imports and local UI actions. */
export const stopAndCleanupRule = (ruleId: string): void => {
  void stopAndCleanupRuleAndWait(ruleId).then(
    (result) => {
      if (!result.success) finishRuleCleanup(ruleId);
    },
    () => finishRuleCleanup(ruleId),
  );
};

// Tunnel ID prefix and UUID regex pattern for parsing
const TUNNEL_ID_PREFIX = 'pf-';
// UUID format: 8-4-4-4-12 hexadecimal characters
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse rule ID from tunnel ID
 * Tunnel ID format is "pf-{ruleId}-{timestamp}" where ruleId is a UUID
 */
const parseRuleIdFromTunnelId = (tunnelId: string): string | null => {
  if (!tunnelId.startsWith(TUNNEL_ID_PREFIX)) {
    return null;
  }
  
  // Remove prefix and split remaining parts
  const withoutPrefix = tunnelId.slice(TUNNEL_ID_PREFIX.length);
  const parts = withoutPrefix.split('-');
  
  // UUID has 5 parts (8-4-4-4-12), so we need at least 6 parts (5 UUID + timestamp)
  if (parts.length < 6) {
    return null;
  }
  
  // Reconstruct the UUID from first 5 parts
  const ruleId = parts.slice(0, 5).join('-');
  
  // Validate it's a proper UUID format
  if (!UUID_REGEX.test(ruleId)) {
    return null;
  }
  
  return ruleId;
};

const resolveBackendRuleId = (tunnel: { ruleId?: string; tunnelId: string }): string | null => {
  const explicitRuleId = tunnel.ruleId?.trim();
  return explicitRuleId || parseRuleIdFromTunnelId(tunnel.tunnelId);
};

const resolveBackendStatus = (status: string): PortForwardingConnection['status'] => {
  if (status === 'active' || status === 'connecting' || status === 'error') return status;
  return 'connecting';
};

/**
 * Sync active connections with backend
 * Called on app startup to restore state of tunnels that may still be running
 * This updates the local activeConnections map to match the backend state.
 */
export interface PortForwardingBackendSyncOptions {
  shouldReconnect?: (ruleId: string) => boolean;
  onStatusChange?: (
    ruleId: string,
    status: PortForwardingRule['status'],
    error?: string,
  ) => void;
}

const backendSyncOptions: PortForwardingBackendSyncOptions = {};

const rememberBackendSyncOptions = (options: PortForwardingBackendSyncOptions): void => {
  if (options.shouldReconnect) backendSyncOptions.shouldReconnect = options.shouldReconnect;
  if (options.onStatusChange) backendSyncOptions.onStatusChange = options.onStatusChange;
};

const configureSyncedConnection = (
  connection: PortForwardingConnection,
  ruleId: string,
): void => {
  if (backendSyncOptions.shouldReconnect) {
    connection.syncedShouldReconnect = () =>
      backendSyncOptions.shouldReconnect?.(ruleId) ?? false;
  }
  if (backendSyncOptions.onStatusChange) {
    connection.syncedOnStatusChange = (status, error) => {
      backendSyncOptions.onStatusChange?.(ruleId, status, error);
    };
  }
};

const subscribeSyncedConnection = async (
  ruleId: string,
  connection: PortForwardingConnection,
): Promise<boolean> => {
  const bridge = netcattyBridge.get();
  if (!bridge) return activeConnections.get(ruleId) === connection;

  if (!connection.unsubscribe) {
    const onStatusChange = (status: PortForwardingRule['status'], error?: string) => {
      connection.syncedOnStatusChange?.(status, error);
    };
    const unsubscribe = bridge.onPortForwardStatus?.(
      connection.tunnelId,
      (status, error) => {
        const current = activeConnections.get(ruleId);
        if (current !== connection) return;

        if (status === 'inactive') {
          if (current.reconnectTimerCallback) {
            current.unsubscribe?.();
            current.unsubscribe = undefined;
            return;
          }
          if (
            !manualStopsInProgress.has(ruleId)
            && !rulesPendingCleanup.has(ruleId)
          ) {
            const reconnectScheduled = scheduleReconnectIfNeeded(
              ruleId,
              connection.syncedShouldReconnect?.() ?? false,
              onStatusChange,
            );
            if (reconnectScheduled) {
              current.unsubscribe?.();
              current.unsubscribe = undefined;
              return;
            }
          }
          current.unsubscribe?.();
          clearReconnectTimer(ruleId);
          activeConnections.delete(ruleId);
          onStatusChange('inactive');
          return;
        }

        current.status = status;
        current.error = error ?? undefined;
        if (status === 'error') {
          const reconnectScheduled = scheduleReconnectIfNeeded(
            ruleId,
            connection.syncedShouldReconnect?.() ?? false,
            onStatusChange,
          );
          if (reconnectScheduled) return;
        }
        onStatusChange(status, error ?? undefined);
      },
    );
    if (activeConnections.get(ruleId) === connection) {
      connection.unsubscribe = unsubscribe;
    } else {
      unsubscribe?.();
    }
  }

  const snapshot = await bridge.subscribePortForward?.(connection.tunnelId);
  if (activeConnections.get(ruleId) !== connection) return false;
  if (snapshot?.status === 'inactive') {
    connection.unsubscribe?.();
    activeConnections.delete(ruleId);
    connection.syncedOnStatusChange?.('inactive');
    return false;
  }
  if (snapshot) {
    connection.status = resolveBackendStatus(snapshot.status);
    connection.error = snapshot.error;
  }
  return true;
};

export const syncWithBackend = async (
  options: PortForwardingBackendSyncOptions = {},
): Promise<void> => {
  rememberBackendSyncOptions(options);
  const bridge = netcattyBridge.get();
  
  if (!bridge?.listPortForwards) {
    logger.warn('[PortForwardingService] Backend not available for sync');
    return;
  }
  
  try {
    const activeTunnels = await bridge.listPortForwards();
    logger.info(`[PortForwardingService] Backend reports ${activeTunnels.length} active tunnels`);
    
    for (const tunnel of activeTunnels) {
      const ruleId = resolveBackendRuleId(tunnel);
      if (ruleId) {
        const existing = activeConnections.get(ruleId);
        if (existing?.tunnelId !== tunnel.tunnelId) existing?.unsubscribe?.();

        // Update local connection tracking
        const connection: PortForwardingConnection = existing?.tunnelId === tunnel.tunnelId
          ? existing
          : {
              ruleId,
              tunnelId: tunnel.tunnelId,
              status: resolveBackendStatus(tunnel.status),
              reconnectAttempts: existing?.reconnectAttempts ?? 0,
            };
        connection.status = resolveBackendStatus(tunnel.status);
        connection.error = tunnel.error;
        configureSyncedConnection(connection, ruleId);
        activeConnections.set(ruleId, connection);

        if (!await subscribeSyncedConnection(ruleId, connection)) continue;
        
        logger.info(`[PortForwardingService] Synced active tunnel for rule ${ruleId}`);
      }
    }
  } catch (err) {
    logger.error('[PortForwardingService] Failed to sync with backend:', err);
  }
};

/**
 * Reconcile renderer-side connection state with the backend (heartbeat).
 *
 * Returns the set of ruleIds whose status changed so the caller can update
 * React state accordingly.
 *
 * Cases handled:
 * 1. Renderer thinks a tunnel is active, but backend says it's gone
 *    → clean up activeConnections, return ruleId as "gone"
 * 2. Backend has an active tunnel that the renderer doesn't track
 *    → add to activeConnections, return ruleId as "appeared"
 */
export const reconcileWithBackend = async (): Promise<{
  snapshotAvailable: boolean;
  gone: string[];
  appeared: string[];
}> => {
  const result = {
    snapshotAvailable: false,
    gone: [] as string[],
    appeared: [] as string[],
  };
  const bridge = netcattyBridge.get();

  if (!bridge?.listPortForwards) return result;

  try {
    const backendTunnels = await bridge.listPortForwards();
    result.snapshotAvailable = true;
    const backendRuleIds = new Set<string>();

    for (const tunnel of backendTunnels) {
      const ruleId = resolveBackendRuleId(tunnel);
      if (ruleId) {
        backendRuleIds.add(ruleId);

        // Case 2: backend has it, renderer doesn't — insert it
        if (!activeConnections.has(ruleId)) {
          const connection: PortForwardingConnection = {
            ruleId,
            tunnelId: tunnel.tunnelId,
            status: resolveBackendStatus(tunnel.status),
            error: tunnel.error,
          };
          configureSyncedConnection(connection, ruleId);
          activeConnections.set(ruleId, connection);
          if (!await subscribeSyncedConnection(ruleId, connection)) {
            result.gone.push(ruleId);
            continue;
          }
          result.appeared.push(ruleId);
        } else {
          // Case 3: renderer tracks it, but status may have changed
          // (e.g. connecting → active after SSH handshake completed
          // in another window).
          const existing = activeConnections.get(ruleId)!;
          const backendStatus = resolveBackendStatus(tunnel.status);
          if (existing.tunnelId !== tunnel.tunnelId) {
            existing.unsubscribe?.();
            const replacement: PortForwardingConnection = {
              ruleId,
              tunnelId: tunnel.tunnelId,
              status: backendStatus,
              error: tunnel.error,
              reconnectAttempts: existing.reconnectAttempts ?? 0,
            };
            configureSyncedConnection(replacement, ruleId);
            activeConnections.set(ruleId, replacement);
            if (!await subscribeSyncedConnection(ruleId, replacement)) {
              result.gone.push(ruleId);
              continue;
            }
            result.appeared.push(ruleId);
            continue;
          }
          if (existing.status !== backendStatus || existing.error !== tunnel.error) {
            existing.status = backendStatus;
            existing.error = tunnel.error;
            result.appeared.push(ruleId);
          }
        }
      }
    }

    // Case 1: renderer thinks a tunnel is active/connecting, but backend
    // says it's gone. Preserve only a local handshake that has not appeared
    // in the backend yet, or a reconnect that is already scheduled.
    for (const [ruleId, conn] of activeConnections) {
      if (!backendRuleIds.has(ruleId)) {
        if (
          conn.status === 'connecting'
          && (conn.locallyInitiated || conn.reconnectTimerCallback)
        ) {
          continue;
        }
        conn.unsubscribe?.();
        clearReconnectTimer(ruleId);
        activeConnections.delete(ruleId);
        result.gone.push(ruleId);
      }
    }

    if (result.gone.length || result.appeared.length) {
      logger.info(
        `[PortForwardingService] Reconcile: ${result.gone.length} gone, ${result.appeared.length} appeared`,
      );
    }
  } catch (err) {
    logger.warn('[PortForwardingService] Reconcile failed:', err);
  }

  return result;
};

/**
 * Start a port forwarding tunnel
 * @param enableReconnect - If true, will automatically attempt to reconnect on disconnect
 */
export const startPortForward = async (
  rule: PortForwardingRule,
  host: Host,
  hosts: Host[],
  keys: SSHKey[],
  identities: Identity[],
  onStatusChange: (status: PortForwardingRule['status'], error?: string) => void,
  enableReconnect = false,
  terminalSettings?: Pick<TerminalSettings, 'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'>,
  knownHosts?: KnownHost[],
): Promise<{ success: boolean; error?: string }> => {
  const globalTerminalSettings = { ...FALLBACK_TERMINAL_SETTINGS, ...(terminalSettings ?? {}) };
  const bridge = netcattyBridge.get();
  if (rulesPendingCleanup.has(rule.id)) {
    return { success: false, error: 'This port forwarding rule is currently being stopped.' };
  }
  const existingConnection = activeConnections.get(rule.id);
  if (
    existingConnection
    && (existingConnection.status === 'active' || existingConnection.status === 'connecting')
    && !existingConnection.reconnectStartAuthorized
  ) {
    onStatusChange(existingConnection.status, existingConnection.error);
    return { success: true };
  }
  if (existingConnection) existingConnection.reconnectStartAuthorized = false;
  
  // Clear any existing reconnect timer
  clearReconnectTimer(rule.id);
  
  if (!bridge?.startPortForward) {
    // Fallback for browser/dev mode - simulate the connection
    logger.warn('[PortForwardingService] Backend not available, simulating connection...');
    return simulateConnection(rule, onStatusChange);
  }
  
  try {
    // Generate a unique tunnel ID
    const tunnelId = `pf-${rule.id}-${Date.now()}`;

    if (host.proxyProfileId && !host.proxyConfig) {
      throw new Error(`Saved proxy for host "${host.label || host.hostname}" is missing. Open host settings and select a valid proxy.`);
    }
    if (findMissingProxyIdentityId(host.proxyConfig, identities)) {
      throw new Error(formatMissingProxyIdentityMessage(host.label || host.hostname));
    }
    if (findIncompleteProxyIdentityId(host.proxyConfig, identities)) {
      throw new Error(formatIncompleteProxyIdentityMessage(host.label || host.hostname));
    }

    const resolved = resolveHostAuth({ host, keys, identities });
    const key = resolved.key;
    const proxy = host.proxyConfig
      ? resolveProxyConfigAuth(host.proxyConfig, identities)
      : undefined;
    let jumpHosts: NetcattyJumpHost[] | undefined;
    if (host.hostChain?.hostIds?.length) {
      const resolvedJumpHosts = host.hostChain.hostIds.map((hostId) =>
        hosts.find((candidate) => candidate.id === hostId),
      );
      const missingJumpHostIds = host.hostChain.hostIds.filter((_, index) => !resolvedJumpHosts[index]);
      if (missingJumpHostIds.length > 0) {
        throw new Error(`Missing jump host configuration for host chain: ${missingJumpHostIds.join(", ")}`);
      }
      jumpHosts = resolvedJumpHosts
        .filter((jumpHost): jumpHost is Host => Boolean(jumpHost))
        .map((jumpHost, index) => {
          if (jumpHost.proxyProfileId && !jumpHost.proxyConfig) {
            throw new Error(`Saved proxy for jump host "${jumpHost.label || jumpHost.hostname}" is missing. Open host settings and select a valid proxy.`);
          }
          if (findMissingProxyIdentityId(jumpHost.proxyConfig, identities)) {
            throw new Error(formatMissingProxyIdentityMessage(jumpHost.label || jumpHost.hostname));
          }
          if (findIncompleteProxyIdentityId(jumpHost.proxyConfig, identities)) {
            throw new Error(formatIncompleteProxyIdentityMessage(jumpHost.label || jumpHost.hostname));
          }
          const hasConfiguredJumpProxyEndpoint =
            index === 0 &&
            hasUsableProxyConfig(jumpHost.proxyConfig);
          if (
            hasConfiguredJumpProxyEndpoint &&
            hasUnreadableProxyCredential(jumpHost.proxyConfig, identities)
          ) {
            throw new Error(`Proxy credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter the proxy password.`);
          }
          const jumpResolved = resolveHostAuth({ host: jumpHost, keys, identities });
          const jumpKey = jumpResolved.key;
          const jumpPassword = sanitizeCredentialValue(jumpResolved.password);
          const jumpKeyAuth = resolveBridgeKeyAuth({
            key: jumpKey,
            fallbackIdentityFilePaths: jumpResolved.authMethod === "password" || jumpResolved.keyId
              ? undefined
              : jumpHost.identityFilePaths,
            passphrase: jumpResolved.passphrase,
          });
          const jumpAgentAuth = resolveBridgeSshAgentAuth(jumpHost, jumpKey, jumpResolved.authMethod);
          const hasJumpKeyMaterial = Boolean(
            jumpAgentAuth.useSshAgent || jumpKeyAuth.privateKey || jumpKeyAuth.identityFilePaths?.length,
          );
          const hasUnreadableJumpCredential =
            isEncryptedCredentialPlaceholder(jumpResolved.password) ||
            isEncryptedCredentialPlaceholder(jumpKey?.privateKey) ||
            isEncryptedCredentialPlaceholder(jumpResolved.passphrase);
          if (
            (jumpResolved.authMethod === "password" && isEncryptedCredentialPlaceholder(jumpResolved.password) && !jumpPassword) ||
            (jumpResolved.authMethod !== "password" && jumpResolved.authMethod !== "auto" && hasUnreadableJumpCredential && !jumpPassword && !hasJumpKeyMaterial)
          ) {
            throw new Error(`Saved credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter them.`);
          }
          const hopKeepalive = resolveHostKeepalive(jumpHost, globalTerminalSettings);
          const hopConnectionTimeouts = resolveHostSshConnectionTimeouts(jumpHost);
          return {
            hostname: jumpHost.hostname,
            hostId: jumpHost.id,
            port: jumpHost.port || 22,
            username: jumpResolved.username || 'root',
            authMethod: jumpResolved.authMethod,
            requiresMfa: !!jumpHost.requiresMfa,
            password: jumpPassword,
            privateKey: jumpKeyAuth.privateKey,
            certificate: jumpKey?.certificate,
            passphrase: jumpKeyAuth.passphrase,
            publicKey: jumpKey?.publicKey,
            keyId: jumpResolved.keyId,
            keySource: jumpKey?.source,
            label: jumpHost.label,
            proxy: hasUsableProxyConfig(jumpHost.proxyConfig)
              ? resolveProxyConfigAuth(jumpHost.proxyConfig, identities)
              : undefined,
            identityFilePaths: jumpKeyAuth.identityFilePaths,
            ...jumpAgentAuth,
            keepaliveInterval: hopKeepalive.interval,
            keepaliveCountMax: hopKeepalive.countMax,
            sshTcpConnectTimeoutMs: hopConnectionTimeouts.tcpConnectTimeoutSeconds * 1000,
            sshAuthReadyTimeoutMs: hopConnectionTimeouts.authReadyTimeoutSeconds * 1000,
            verifyHostKeys: globalTerminalSettings.verifyHostKeys,
            legacyAlgorithms: jumpHost.legacyAlgorithms,
            skipEcdsaHostKey: jumpHost.skipEcdsaHostKey,
            algorithmOverrides: jumpHost.algorithms,
          };
        });
    }
    const usesTargetProxyForFirstHop = !!proxy && !jumpHosts?.[0]?.proxy;
    if (usesTargetProxyForFirstHop && hasUnreadableProxyCredential(host.proxyConfig, identities)) {
      throw new Error('Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.');
    }
    
    const keyAuth = resolveBridgeKeyAuth({
      key,
      fallbackIdentityFilePaths: resolved.authMethod === "password" || resolved.keyId
        ? undefined
        : host.identityFilePaths,
      passphrase: resolved.passphrase,
    });
    const targetAgentAuth = resolveBridgeSshAgentAuth(host, key, resolved.authMethod);
    const password = sanitizeCredentialValue(resolved.password);
    const hasKeyMaterial = Boolean(
      targetAgentAuth.useSshAgent || keyAuth.privateKey || keyAuth.identityFilePaths?.length,
    );
    const hasUnreadableCredential =
      isEncryptedCredentialPlaceholder(resolved.password) ||
      isEncryptedCredentialPlaceholder(key?.privateKey) ||
      isEncryptedCredentialPlaceholder(resolved.passphrase);
    if (
      (resolved.authMethod === "password" && isEncryptedCredentialPlaceholder(resolved.password) && !password) ||
      (resolved.authMethod !== "password" && resolved.authMethod !== "auto" && hasUnreadableCredential && !password && !hasKeyMaterial)
    ) {
      throw new Error('Saved credentials cannot be decrypted on this device. Open host settings and re-enter them.');
    }

    // Subscribe to status updates first
    const handleTunnelStatus = (status: PortForwardingRule['status'], error?: string | null) => {
      const conn = activeConnections.get(rule.id);
      if (status === 'inactive') {
        if (conn?.reconnectTimerCallback) {
          conn.unsubscribe?.();
          conn.unsubscribe = undefined;
          conn.locallyInitiated = false;
          return;
        }
        conn?.unsubscribe?.();
        clearReconnectTimer(rule.id);
        activeConnections.delete(rule.id);
        onStatusChange('inactive');
        return;
      }
      if (conn) {
        conn.status = status;
        conn.error = error ?? undefined;
        if (status !== 'connecting') conn.locallyInitiated = false;
      }
      
      // Handle auto-reconnect on error/disconnect
      if (status === 'error') {
        const reconnectScheduled = scheduleReconnectIfNeeded(rule.id, enableReconnect, onStatusChange);
        if (reconnectScheduled) {
          return;
        }
      }
      
      onStatusChange(status, error ?? undefined);
    };
    const unsubscribe = bridge.onPortForwardStatus?.(tunnelId, handleTunnelStatus);
    
    // Store connection info (preserve reconnect attempts if this is a reconnect)
    const existingConn = activeConnections.get(rule.id);
    activeConnections.set(rule.id, {
      ruleId: rule.id,
      tunnelId,
      status: 'connecting',
      unsubscribe,
      locallyInitiated: true,
      reconnectAttempts: existingConn?.reconnectAttempts ?? 0,
    });
    
    onStatusChange('connecting');
    
    // Start the tunnel
    const connectionTimeouts = resolveHostSshConnectionTimeouts(host);
    const result = await bridge.startPortForward({
      ruleId: rule.id,
      tunnelId,
      type: rule.type,
      localPort: rule.localPort,
      bindAddress: rule.bindAddress,
      remoteHost: rule.remoteHost,
      remotePort: rule.remotePort,
      hostname: host.hostname,
      hostId: host.id,
      port: host.port,
      username: resolved.username,
      authMethod: resolved.authMethod,
      requiresMfa: !!host.requiresMfa,
      password,
      privateKey: keyAuth.privateKey,
      certificate: key?.certificate,
      keyId: resolved.keyId,
      passphrase: keyAuth.passphrase,
      knownHosts,
      verifyHostKeys: globalTerminalSettings.verifyHostKeys,
      proxy,
      jumpHosts: jumpHosts && jumpHosts.length > 0 ? jumpHosts : undefined,
      identityFilePaths: keyAuth.identityFilePaths,
      ...targetAgentAuth,
      legacyAlgorithms: host.legacyAlgorithms,
      skipEcdsaHostKey: host.skipEcdsaHostKey,
      algorithmOverrides: host.algorithms,
      keepaliveInterval: resolveHostKeepalive(host, globalTerminalSettings).interval,
      keepaliveCountMax: resolveHostKeepalive(host, globalTerminalSettings).countMax,
      sshTcpConnectTimeoutMs: connectionTimeouts.tcpConnectTimeoutSeconds * 1000,
      sshAuthReadyTimeoutMs: connectionTimeouts.authReadyTimeoutSeconds * 1000,
    });
    
    if (!result.success) {
      // Intentional cancellation (rule deleted/replaced during handshake).
      // Clean up quietly — no error state, no reconnect.
      if ((result as { cancelled?: boolean }).cancelled) {
        activeConnections.delete(rule.id);
        unsubscribe?.();
        onStatusChange('inactive');
        return { success: false, error: undefined };
      }

      if (result.blockedByCleanup && result.tunnelId) {
        unsubscribe?.();
        activeConnections.set(rule.id, {
          ruleId: rule.id,
          tunnelId: result.tunnelId,
          status: 'error',
          error: result.error,
        });
        onStatusChange('error', result.error);
        return { success: false, error: result.error };
      }

      // Check if we should attempt reconnect
      const reconnectScheduled = scheduleReconnectIfNeeded(rule.id, enableReconnect, onStatusChange);
      if (reconnectScheduled) {
        return { success: false, error: result.error };
      }
      
      activeConnections.delete(rule.id);
      unsubscribe?.();
      onStatusChange('error', result.error);
      return { success: false, error: result.error };
    }

    if (result.reused && result.tunnelId) {
      // A different window won the start race. Adopt the backend's durable
      // tunnel instead of keeping this renderer's unused attempt id.
      unsubscribe?.();
      const adoptedStatus = result.status === 'active' ? 'active' : 'connecting';
      const adoptedUnsubscribe = bridge.onPortForwardStatus?.(
        result.tunnelId,
        handleTunnelStatus,
      );
      activeConnections.set(rule.id, {
        ruleId: rule.id,
        tunnelId: result.tunnelId,
        status: adoptedStatus,
        unsubscribe: adoptedUnsubscribe,
        locallyInitiated: false,
        reconnectAttempts: existingConn?.reconnectAttempts ?? 0,
      });

      // Close the reply/listener race: an adopted tunnel may have stopped
      // after the backend replied but before this renderer subscribed.
      const snapshot = await bridge.getPortForwardStatus?.(result.tunnelId);
      const adoptedConnection = activeConnections.get(rule.id);
      if (snapshot && adoptedConnection?.tunnelId === result.tunnelId) {
        if (snapshot.status === 'inactive') {
          adoptedUnsubscribe?.();
          activeConnections.delete(rule.id);
          onStatusChange('inactive');
          return { success: false, error: 'Port forwarding tunnel stopped before adoption completed' };
        }
        adoptedConnection.status = snapshot.status;
        adoptedConnection.error = snapshot.error;
      }

      const current = activeConnections.get(rule.id);
      if (!current) {
        return {
          success: false,
          error: 'Port forwarding tunnel stopped before adoption completed',
        };
      }
      onStatusChange(current.status, current.error);
      return { success: true };
    }
    
    // Reset reconnect attempts on successful connection
    const conn = activeConnections.get(rule.id);
    if (conn) {
      conn.reconnectAttempts = 0;
    }
    exhaustedReconnectRules.delete(rule.id);
    
    return { success: true };
    
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    
    // Check if we should attempt reconnect
    const reconnectScheduled = scheduleReconnectIfNeeded(rule.id, enableReconnect, onStatusChange);
    if (reconnectScheduled) {
      return { success: false, error };
    }
    
    onStatusChange('error', error);
    activeConnections.delete(rule.id);
    return { success: false, error };
  }
};

/**
 * Stop a port forwarding tunnel
 */
export const stopPortForward = async (
  ruleId: string,
  onStatusChange: (status: PortForwardingRule['status'], error?: string) => void
): Promise<{ success: boolean; error?: string }> => {
  const bridge = netcattyBridge.get();
  const conn = activeConnections.get(ruleId);

  // User intent takes effect immediately. Do not let an already queued network
  // recovery restart this rule while the backend stop request is still pending.
  exhaustedReconnectRules.delete(ruleId);
  
  // Clear any pending reconnect timer
  clearReconnectTimer(ruleId);
  
  if (!bridge?.stopPortForwardByRuleId && !conn) {
    onStatusChange('inactive');
    return { success: true };
  }

  if (!bridge?.stopPortForwardByRuleId && !bridge?.stopPortForward) {
    // Fallback for browser/dev mode
    logger.warn('[PortForwardingService] Backend not available, simulating stop...');
    conn?.unsubscribe?.();
    activeConnections.delete(ruleId);
    onStatusChange('inactive');
    return { success: true };
  }

  manualStopsInProgress.add(ruleId);
  try {
    if (bridge.stopPortForwardByRuleId) {
      const result = await bridge.stopPortForwardByRuleId(ruleId);
      if ((result.failed ?? 0) > 0) {
        const error = result.errors?.filter(Boolean).join('; ') ||
          `Failed to stop ${result.failed} port forwarding tunnel(s)`;
        clearReconnectTimer(ruleId);
        preserveFailedStopConnection(ruleId, conn, error);
        onStatusChange('error', error);
        return { success: false, error };
      }
    } else if (conn && bridge.stopPortForward) {
      const result = await bridge.stopPortForward(conn.tunnelId);
      if (!result.success) return result;
    }

    finishRuleCleanup(ruleId);
    onStatusChange('inactive');
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    clearReconnectTimer(ruleId);
    preserveFailedStopConnection(ruleId, conn, error);
    onStatusChange('error', error);
    return { success: false, error };
  } finally {
    manualStopsInProgress.delete(ruleId);
  }
};

/**
 * Get the current status of a tunnel
 */
export const getPortForwardStatus = async (
  ruleId: string
): Promise<PortForwardingRule['status']> => {
  const conn = activeConnections.get(ruleId);
  if (!conn) return 'inactive';
  return conn.status;
};

/**
 * Check if backend is available
 */
export const isBackendAvailable = (): boolean => {
  return !!(netcattyBridge.get()?.startPortForward);
};

/**
 * Stop all active tunnels (cleanup on unmount)
 */
export const stopAllPortForwards = async (): Promise<void> => {
  const bridge = netcattyBridge.get();
  
  // Stop everything the renderer knows about
  for (const [ruleId, conn] of activeConnections) {
    // Clear any pending reconnect timer
    clearReconnectTimer(ruleId);
    
    try {
      if (bridge?.stopPortForward) {
        await bridge.stopPortForward(conn.tunnelId);
      }
      conn.unsubscribe?.();
    } catch (err) {
      logger.warn(`[PortForwardingService] Failed to stop tunnel ${conn.tunnelId}:`, err);
    }
  }
  
  activeConnections.clear();

  // Also ask the backend to stop ALL tunnels it knows about.
  // This covers tunnels that were started by other windows or that
  // this renderer doesn't have in its activeConnections map (e.g.
  // settings window opened before initializeStore finished).
  if (bridge?.stopAllPortForwards) {
    try {
      await bridge.stopAllPortForwards();
    } catch (err) {
      logger.warn('[PortForwardingService] Backend stopAllPortForwards failed:', err);
    }
  }
};

/**
 * Simulate connection for development/browser mode
 */
const simulateConnection = async (
  rule: PortForwardingRule,
  onStatusChange: (status: PortForwardingRule['status'], error?: string) => void
): Promise<{ success: boolean; error?: string }> => {
  onStatusChange('connecting');
  
  // Simulate connection delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Random success/failure for demo
  const success = Math.random() > 0.1; // 90% success rate
  
  if (success) {
    // Store simulated connection
    activeConnections.set(rule.id, {
      ruleId: rule.id,
      tunnelId: `simulated-${rule.id}`,
      status: 'active',
    });
    onStatusChange('active');
    return { success: true };
  } else {
    onStatusChange('error', 'Simulated connection failure');
    return { success: false, error: 'Simulated connection failure' };
  }
};

export default {
  startPortForward,
  stopPortForward,
  getPortForwardStatus,
  isBackendAvailable,
  stopAllPortForwards,
  setReconnectCallback,
  clearReconnectTimer,
};
