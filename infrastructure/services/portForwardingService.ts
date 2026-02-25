/**
 * Port Forwarding Service
 * Handles communication between the frontend and the Electron backend
 * for establishing and managing SSH port forwarding tunnels.
 */

import { Host,PortForwardingRule } from '../../domain/models';
import { logger } from '../../lib/logger';
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
    logger.info(`[PortForwardingService] Scheduling reconnect ${attempts}/${MAX_RECONNECT_ATTEMPTS}`);

    if (currentConn) {
      currentConn.reconnectAttempts = attempts;
      currentConn.reconnectTimeoutId = setTimeout(() => {
        if (reconnectCallback) {
          reconnectCallback(ruleId, onStatusChange);
        }
      }, RECONNECT_DELAY_MS);
    }

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
          status: 'active',
        });
        
        logger.info(`[PortForwardingService] Synced active tunnel for rule ${ruleId}`);
      }
    }
  } catch (err) {
    logger.error('[PortForwardingService] Failed to sync with backend:', err);
  }
};

/**
 * Start a port forwarding tunnel
 * @param enableReconnect - If true, will automatically attempt to reconnect on disconnect
 */
export const startPortForward = async (
  rule: PortForwardingRule,
  host: Host,
  keys: { id: string; privateKey: string }[],
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
    const authTraceId = `pf-auth-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    
    // Get the private key if using key auth
    let privateKey: string | undefined;
    const usePasswordOnly = host.authMethod === "password";
    if (host.identityFileId && !usePasswordOnly) {
      const key = keys.find(k => k.id === host.identityFileId);
      if (key) {
        privateKey = key.privateKey;
      }
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
      username: host.username,
      authMethod: host.authMethod,
      password: host.password,
      privateKey,
      _authTraceId: authTraceId,
    });
    
    if (!result.success) {
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
