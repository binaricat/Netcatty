// Known Hosts - discovered from system SSH known_hosts file
export interface KnownHost {
  id: string;
  hostname: string; // The host pattern from known_hosts
  port: number;
  keyType: string; // ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256, etc.
  publicKey: string; // The host's public key fingerprint or full key
  fingerprint?: string; // SHA256 fingerprint without the SHA256: prefix
  discoveredAt: number;
  lastSeen?: number;
  convertedToHostId?: string; // If converted to managed host
}

// Shell History - records real commands executed in terminal sessions
export interface ShellHistoryEntry {
  id: string;
  command: string;
  hostId: string; // ID of the host where command was executed
  hostLabel: string; // Label for display
  sessionId: string;
  timestamp: number;
}

// Connection Log - records connection history
export interface ConnectionLog {
  id: string;
  sessionId?: string; // Terminal session ID for matching during capture
  hostId: string; // Host ID (can be empty for local terminal)
  hostLabel: string; // Display label (e.g., 'Local Terminal' or host label)
  hostname: string; // Target hostname or 'localhost'
  username: string; // SSH username or system username
  protocol: 'ssh' | 'telnet' | 'local' | 'mosh' | 'serial';
  startTime: number; // Connection start timestamp
  endTime?: number; // Connection end timestamp (undefined if still active)
  localUsername: string; // System username of the local user
  localHostname: string; // Local machine hostname
  saved: boolean; // Whether this log is bookmarked/saved
  terminalData?: string; // Captured terminal output data for replay
  themeId?: string; // Terminal theme ID for this log view
  fontSize?: number; // Terminal font size for this log view
}

// Session Logs Settings - for auto-saving terminal logs to local filesystem
export type SessionLogFormat = 'txt' | 'raw' | 'html';

// Managed Source - external file that manages a group of hosts (e.g., ~/.ssh/config)
type ManagedSourceType = 'ssh_config';

export interface ManagedSource {
  id: string;
  type: ManagedSourceType;
  filePath: string;
  groupName: string;
  lastSyncedAt: number;
  lastFileHash?: string;
}
