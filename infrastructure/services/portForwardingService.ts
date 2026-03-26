/**
 * Port Forwarding Service
 * Handles communication between the frontend and the Electron backend
 * for establishing and managing SSH port forwarding tunnels.
 */

import { Host, Identity, PortForwardingRule, SSHKey } from '../../domain/models';
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from '../../domain/credentials';
import { resolveHostAuth } from '../../domain/sshAuth';
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
  // Reconnect state
  reconnectAttempts?: number;
  reconnectTimeoutId?: ReturnType<typeof setTimeout>;
}

// Map to track active connections
const activeConnections = new Map<string, PortForwardingConnection>();

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
    conn.reconnectTimeoutId = undefined;
  }
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
    currentConn.reconnectTimeoutId = setTimeout(() => {
      if (reconnectCallback) {
        reconnectCallback(ruleId, onStatusChange);
      }
    }, RECONNECT_DELAY_MS);

    onStatusChange('connecting', `Reconnecting (${attempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    return true;
  }

  logger.warn(`[PortForwardingService] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for rule ${ruleId}`);
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

/**
 * Stop and clean up a single rule's tunnel.
 * Used when a rule is deleted or replaced via import, where we need to ensure
 * the backend tunnel is torn down and all reconnect timers are cancelled.
 * This is a fire-and-forget cleanup — errors are logged but not propagated.
 */
export const stopAndCleanupRule = (ruleId: string): void => {
  clearReconnectTimer(ruleId);

  // Broadcast to other windows so they cancel any pending reconnect
  // timers for this rule (e.g. main window has a reconnect scheduled
  // but settings window just deleted the rule).
  broadcastReconnectCancel(ruleId);

  const conn = activeConnections.get(ruleId);
  if (conn) {
    // Unsubscribe from status events
    conn.unsubscribe?.();
    activeConnections.delete(ruleId);
  }

  // Use stopPortForwardByRuleId exclusively — it sets tunnel.cancelled = true
  // before conn.end(), so the close handler resolves gracefully.  The old
  // stopPortForward(tunnelId) IPC deletes the tunnel entry immediately,
  // which makes the cancelled flag invisible to the close handler.
  const bridge = netcattyBridge.get();
  if (bridge?.stopPortForwardByRuleId) {
    bridge.stopPortForwardByRuleId(ruleId).catch((err: unknown) => {
      logger.warn(`[PortForwardingService] Backend stopByRuleId failed for ${ruleId}:`, err);
    });
  }
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

/**
 * Sync active connections with backend
 * Called on app startup to restore state of tunnels that may still be running
 * This updates the local activeConnections map to match the backend state.
 */
export const syncWithBackend = async (): Promise<void> => {
  const bridge = netcattyBridge.get();
  
  if (!bridge?.listPortForwards) {
    logger.warn('[PortForwardingService] Backend not available for sync');
    return;
  }
  
  try {
    const activeTunnels = await bridge.listPortForwards();
    logger.info(`[PortForwardingService] Backend reports ${activeTunnels.length} active tunnels`);
    
    for (const tunnel of activeTunnels) {
      const ruleId = parseRuleIdFromTunnelId(tunnel.tunnelId);
      if (ruleId) {
        // Update local connection tracking
        activeConnections.set(ruleId, {
          ruleId,
          tunnelId: tunnel.tunnelId,
          status: (tunnel.status === 'active' ? 'active' : 'connecting') as 'active' | 'connecting',
        });
        
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
  gone: string[];
  appeared: string[];
}> => {
  const result = { gone: [] as string[], appeared: [] as string[] };
  const bridge = netcattyBridge.get();

  if (!bridge?.listPortForwards) return result;

  try {
    const backendTunnels = await bridge.listPortForwards();
    const backendRuleIds = new Set<string>();

    for (const tunnel of backendTunnels) {
      const ruleId = parseRuleIdFromTunnelId(tunnel.tunnelId);
      if (ruleId) {
        backendRuleIds.add(ruleId);

        // Case 2: backend has it, renderer doesn't — insert it
        if (!activeConnections.has(ruleId)) {
          activeConnections.set(ruleId, {
            ruleId,
            tunnelId: tunnel.tunnelId,
            status: (tunnel.status === 'active' ? 'active' : 'connecting') as 'active' | 'connecting',
          });
          result.appeared.push(ruleId);
        } else {
          // Case 3: renderer tracks it, but status may have changed
          // (e.g. connecting → active after SSH handshake completed
          // in another window).
          const existing = activeConnections.get(ruleId)!;
          const backendStatus = (tunnel.status === 'active' ? 'active' : 'connecting') as 'active' | 'connecting';
          if (existing.status !== backendStatus) {
            existing.status = backendStatus;
            existing.tunnelId = tunnel.tunnelId;
            result.appeared.push(ruleId);
          }
        }
      }
    }

    // Case 1: renderer thinks tunnel is active/connecting, but backend
    // says it's gone.  For 'connecting' entries seeded by a previous
    // reconcile (observing another window's handshake), also evict if the
    // backend no longer reports them — the handshake failed or was
    // cancelled.  Only skip 'connecting' entries that this renderer
    // initiated itself (they have an unsubscribe callback because this
    // renderer called startPortForward and registered a status listener).
    for (const [ruleId, conn] of activeConnections) {
      if (!backendRuleIds.has(ruleId)) {
        // Skip locally-initiated connecting tunnels (have unsubscribe)
        // — the backend hasn't reported them yet because the handshake
        // is still in progress.
        if (conn.status === 'connecting' && conn.unsubscribe) {
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
  enableReconnect = false
): Promise<{ success: boolean; error?: string }> => {
  const bridge = netcattyBridge.get();
  
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

    const resolved = resolveHostAuth({ host, keys, identities });
    const key = resolved.key;
    const proxy = host.proxyConfig
      ? {
        type: host.proxyConfig.type,
        host: host.proxyConfig.host,
        port: host.proxyConfig.port,
        username: host.proxyConfig.username,
        password: sanitizeCredentialValue(host.proxyConfig.password),
      }
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
          const hasConfiguredJumpProxyEndpoint =
            index === 0 &&
            !!(jumpHost.proxyConfig?.host && jumpHost.proxyConfig?.port);
          if (
            hasConfiguredJumpProxyEndpoint &&
            jumpHost.proxyConfig?.username &&
            isEncryptedCredentialPlaceholder(jumpHost.proxyConfig.password) &&
            !sanitizeCredentialValue(jumpHost.proxyConfig.password)
          ) {
            throw new Error(`Proxy credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter the proxy password.`);
          }
          const jumpResolved = resolveHostAuth({ host: jumpHost, keys, identities });
          const jumpKey = jumpResolved.key;
          return {
            hostname: jumpHost.hostname,
            port: jumpHost.port || 22,
            username: jumpResolved.username || 'root',
            password: jumpResolved.password,
            privateKey: jumpKey?.privateKey,
            certificate: jumpKey?.certificate,
            passphrase: jumpResolved.passphrase || jumpKey?.passphrase,
            publicKey: jumpKey?.publicKey,
            keyId: jumpResolved.keyId,
            keySource: jumpKey?.source,
            label: jumpHost.label,
            proxy: jumpHost.proxyConfig?.host && jumpHost.proxyConfig?.port
              ? {
                type: jumpHost.proxyConfig.type,
                host: jumpHost.proxyConfig.host,
                port: jumpHost.proxyConfig.port,
                username: jumpHost.proxyConfig.username,
                password: sanitizeCredentialValue(jumpHost.proxyConfig.password),
              }
              : undefined,
            identityFilePaths: jumpHost.identityFilePaths,
          };
        });
    }
    const usesTargetProxyForFirstHop = !!proxy && !jumpHosts?.[0]?.proxy;
    if (usesTargetProxyForFirstHop && host.proxyConfig?.username && isEncryptedCredentialPlaceholder(host.proxyConfig.password) && !proxy?.password) {
      throw new Error('Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.');
    }
    
    // Subscribe to status updates first
    const unsubscribe = bridge.onPortForwardStatus?.(tunnelId, (status, error) => {
      const conn = activeConnections.get(rule.id);
      if (conn) {
        conn.status = status;
        conn.error = error;
      }
      
      // Handle auto-reconnect on error/disconnect
      if (status === 'error') {
        const reconnectScheduled = scheduleReconnectIfNeeded(rule.id, enableReconnect, onStatusChange);
        if (reconnectScheduled) {
          return;
        }
      }
      
      onStatusChange(status, error ?? undefined);
    });
    
    // Store connection info (preserve reconnect attempts if this is a reconnect)
    const existingConn = activeConnections.get(rule.id);
    activeConnections.set(rule.id, {
      ruleId: rule.id,
      tunnelId,
      status: 'connecting',
      unsubscribe,
      reconnectAttempts: existingConn?.reconnectAttempts ?? 0,
    });
    
    onStatusChange('connecting');
    
    // Start the tunnel
    const result = await bridge.startPortForward({
      tunnelId,
      type: rule.type,
      localPort: rule.localPort,
      bindAddress: rule.bindAddress,
      remoteHost: rule.remoteHost,
      remotePort: rule.remotePort,
      hostname: host.hostname,
      port: host.port,
      username: resolved.username,
      password: resolved.password,
      privateKey: key?.privateKey,
      certificate: key?.certificate,
      keyId: resolved.keyId,
      passphrase: resolved.passphrase || key?.passphrase,
      proxy,
      jumpHosts: jumpHosts && jumpHosts.length > 0 ? jumpHosts : undefined,
      identityFilePaths: host.identityFilePaths,
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
    
    // Reset reconnect attempts on successful connection
    const conn = activeConnections.get(rule.id);
    if (conn) {
      conn.reconnectAttempts = 0;
    }
    
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
  onStatusChange: (status: PortForwardingRule['status']) => void
): Promise<{ success: boolean; error?: string }> => {
  const bridge = netcattyBridge.get();
  const conn = activeConnections.get(ruleId);
  
  // Clear any pending reconnect timer
  clearReconnectTimer(ruleId);
  
  if (!conn) {
    onStatusChange('inactive');
    return { success: true };
  }
  
  if (!bridge?.stopPortForward) {
    // Fallback for browser/dev mode
    logger.warn('[PortForwardingService] Backend not available, simulating stop...');
    conn.unsubscribe?.();
    activeConnections.delete(ruleId);
    onStatusChange('inactive');
    return { success: true };
  }
  
  try {
    const result = await bridge.stopPortForward(conn.tunnelId);
    
    conn.unsubscribe?.();
    activeConnections.delete(ruleId);
    onStatusChange('inactive');
    
    return result;
    
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
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
