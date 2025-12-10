// Proxy configuration for SSH connections
export type ProxyType = 'http' | 'socks5';

export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

// Host chain configuration for jump host / bastion connections
export interface HostChainConfig {
  hostIds: string[]; // Array of host IDs in order (first = closest to client)
}

// Environment variable for SSH session
export interface EnvVar {
  name: string;
  value: string;
}

// Protocol type for connections
export type HostProtocol = 'ssh' | 'telnet' | 'mosh' | 'local';

// Per-protocol configuration
export interface ProtocolConfig {
  protocol: HostProtocol;
  port: number;
  enabled: boolean;
  // Mosh-specific
  moshServerPath?: string;
  // Protocol-specific theme override
  theme?: string;
}

export interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  group?: string;
  tags: string[];
  os: 'linux' | 'windows' | 'macos';
  identityFileId?: string; // Reference to SSHKey
  protocol?: 'ssh' | 'telnet' | 'local'; // Default/primary protocol
  password?: string;
  authMethod?: 'password' | 'key' | 'certificate' | 'fido2';
  agentForwarding?: boolean;
  startupCommand?: string;
  hostChaining?: string; // Deprecated: use hostChain instead
  proxy?: string; // Deprecated: use proxyConfig instead
  proxyConfig?: ProxyConfig; // New structured proxy configuration
  hostChain?: HostChainConfig; // New structured host chain configuration
  envVars?: string; // Deprecated: use environmentVariables instead
  environmentVariables?: EnvVar[]; // Structured environment variables
  charset?: string;
  moshEnabled?: boolean;
  theme?: string;
  distro?: string; // detected distro id (e.g., ubuntu, debian)
  // Multi-protocol support
  protocols?: ProtocolConfig[]; // Multiple protocol configurations
  telnetPort?: number; // Telnet-specific port (for quick access)
  telnetEnabled?: boolean; // Is Telnet enabled for this host
}

export type KeyType = 'RSA' | 'ECDSA' | 'ED25519';
export type KeySource = 'generated' | 'imported' | 'biometric' | 'fido2';
export type KeyCategory = 'key' | 'certificate' | 'identity';
export type IdentityAuthMethod = 'password' | 'key' | 'certificate' | 'fido2';

export interface SSHKey {
  id: string;
  label: string;
  type: KeyType;
  keySize?: number; // RSA: 4096/2048/1024, ECDSA: 521/384/256
  privateKey: string;
  publicKey?: string;
  certificate?: string;
  passphrase?: string; // encrypted or stored securely
  savePassphrase?: boolean;
  source: KeySource;
  category: KeyCategory;
  // For biometric/FIDO2 keys
  credentialId?: string; // WebAuthn credential ID (base64)
  rpId?: string; // Relying Party ID
  created: number;
}

// Identity combines username with authentication method
export interface Identity {
  id: string;
  label: string;
  username: string;
  authMethod: IdentityAuthMethod;
  password?: string; // For password auth
  keyId?: string; // Reference to SSHKey for key/certificate auth
  created: number;
}

export interface Snippet {
  id: string;
  label: string;
  command: string; // Multi-line script
  tags?: string[];
  package?: string; // package path
  targets?: string[]; // host ids
}

export interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system';
  content: string;
  directory?: string;
  timestamp: number;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface GroupNode {
  name: string;
  path: string;
  children: Record<string, GroupNode>;
  hosts: Host[];
}

export interface SyncConfig {
  gistId: string;
  githubToken: string;
  lastSync?: number;
}

export interface TerminalTheme {
  id: string;
  name: string;
  type: 'dark' | 'light';
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  }
}

export interface TerminalSession {
  id: string;
  hostId: string;
  hostLabel: string;
  username: string;
  hostname: string;
  status: 'connecting' | 'connected' | 'disconnected';
  workspaceId?: string;
  startupCommand?: string; // Command to run after connection (for snippet runner)
}

export interface RemoteFile {
  name: string;
  type: 'file' | 'directory';
  size: string;
  lastModified: string;
}

export type WorkspaceNode =
  | {
      id: string;
      type: 'pane';
      sessionId: string;
    }
  | {
      id: string;
      type: 'split';
      direction: 'horizontal' | 'vertical';
      children: WorkspaceNode[];
      sizes?: number[]; // relative sizes for children
    };

export type WorkspaceViewMode = 'split' | 'focus';

export interface Workspace {
  id: string;
  title: string;
  root: WorkspaceNode;
  viewMode?: WorkspaceViewMode; // 'split' = tiled view (default), 'focus' = left list + single terminal
  focusedSessionId?: string; // Which session is focused when in focus mode
  snippetId?: string; // If this workspace was created from running a snippet
}

// SFTP Types
export interface SftpFileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  sizeFormatted: string;
  lastModified: number;
  lastModifiedFormatted: string;
  permissions?: string;
  owner?: string;
  group?: string;
}

export interface SftpConnection {
  id: string;
  hostId: string;
  hostLabel: string;
  isLocal: boolean;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
  currentPath: string;
  homeDir?: string;
}

export type TransferStatus = 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
export type TransferDirection = 'upload' | 'download' | 'remote-to-remote' | 'local-copy';

export interface TransferTask {
  id: string;
  fileName: string;
  sourcePath: string;
  targetPath: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  direction: TransferDirection;
  status: TransferStatus;
  totalBytes: number;
  transferredBytes: number;
  speed: number; // bytes per second
  error?: string;
  startTime: number;
  endTime?: number;
  isDirectory: boolean;
  childTasks?: string[]; // For directory transfers
  parentTaskId?: string;
  skipConflictCheck?: boolean; // Skip conflict check for replace operations
}

export interface FileConflict {
  transferId: string;
  fileName: string;
  sourcePath: string;
  targetPath: string;
  existingSize: number;
  newSize: number;
  existingModified: number;
  newModified: number;
}

// Port Forwarding Types
export type PortForwardingType = 'local' | 'remote' | 'dynamic';
export type PortForwardingStatus = 'inactive' | 'connecting' | 'active' | 'error';

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
  // Runtime state
  status: PortForwardingStatus;
  error?: string;
  createdAt: number;
  lastUsedAt?: number;
}

// Known Hosts - discovered from system SSH known_hosts file
export interface KnownHost {
  id: string;
  hostname: string; // The host pattern from known_hosts
  port: number;
  keyType: string; // ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256, etc.
  publicKey: string; // The host's public key fingerprint or full key
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
