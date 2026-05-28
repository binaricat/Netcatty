// Port Forwarding Types
export type PortForwardingType = 'local' | 'remote' | 'dynamic';
type PortForwardingStatus = 'inactive' | 'connecting' | 'active' | 'error';

export interface PortForwardingRule {
  id: string;
  label: string;
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
  // Runtime state
  status: PortForwardingStatus;
  error?: string;
  createdAt: number;
  lastUsedAt?: number;
}
