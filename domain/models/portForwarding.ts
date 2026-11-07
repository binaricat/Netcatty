// Port Forwarding Types
export type PortForwardingType = 'local' | 'remote' | 'dynamic';
/**
 * Display / projection status for a port-forwarding rule.
 * `unknown` means the authoritative main-process snapshot could not be read;
 * it must never be persisted to localStorage.
 * `partial` is computed renderer-side when a multi-mapping rule has a mix of
 * active and failed mappings; it is also a projection, never persisted.
 */
export type PortForwardingStatus =
  | 'inactive'
  | 'connecting'
  | 'active'
  | 'partial'
  | 'error'
  | 'unknown';

/**
 * One local→destination port pair inside a multi-mapping rule. All mappings
 * share the rule's type, bindAddress and remoteHost; only the port pair
 * varies. `localPort` is the mapping's identity and must be unique within
 * the rule. Only used by `local` and `remote` rules with more than one
 * mapping — single-mapping rules keep the scalar fields only.
 */
export interface PortForwardingMapping {
  localPort: number;
  remotePort: number;
}

export interface PortForwardingRule {
  id: string;
  label: string;
  order?: number;
  type: PortForwardingType;
  // Common fields
  localPort: number;
  bindAddress: string; // e.g., '127.0.0.1', '0.0.0.0'
  // For local and remote forwarding
  remoteHost?: string;
  remotePort?: number;
  // Additional local→destination port pairs for multi-mapping rules.
  // Present only when the rule carries more than one mapping; the first
  // mapping is always mirrored into `localPort`/`remotePort` above.
  mappings?: PortForwardingMapping[];
  // Host to tunnel through
  hostId?: string;
  // Auto-start: if true, this rule will automatically start when the app launches
  autoStart?: boolean;
  // Auto-reconnect: if true, the tunnel automatically reconnects (with bounded
  // retries) after an unexpected disconnect, regardless of auto-start
  autoReconnect?: boolean;
  /**
   * Runtime projection for the UI. Authoritative phase lives in the Electron
   * main-process registry; this field is rebuilt from snapshots / events and
   * must not be treated as durable configuration.
   */
  status: PortForwardingStatus;
  error?: string;
  createdAt: number;
  lastUsedAt?: number;
}
