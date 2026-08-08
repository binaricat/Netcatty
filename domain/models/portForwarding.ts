// Port Forwarding Types
export type PortForwardingType = 'local' | 'remote' | 'dynamic';
/**
 * Display / projection status for a port-forwarding rule.
 * `unknown` means the authoritative main-process snapshot could not be read;
 * it must never be persisted to localStorage.
 */
export type PortForwardingStatus =
  | 'inactive'
  | 'connecting'
  | 'active'
  | 'error'
  | 'unknown';

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
  // Host to tunnel through
  hostId?: string;
  // Auto-start: if true, this rule will automatically start when the app launches
  autoStart?: boolean;
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
