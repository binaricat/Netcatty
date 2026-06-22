import type { SftpFilenameEncoding } from './sftp';
import type { KeywordHighlightRule } from './terminal';

// Proxy configuration for SSH connections
type ProxyType = 'http' | 'socks5' | 'command';
// UI locale identifier, stored in settings and used for i18n (e.g., "en", "zh-CN").
export type UILanguage = string;

export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  command?: string;
  username?: string;
  password?: string;
}

export interface ProxyProfile {
  id: string;
  label: string;
  config: ProxyConfig;
  createdAt: number;
  updatedAt?: number;
  order?: number;
}

// Host chain configuration for jump host / bastion connections
export interface HostChainConfig {
  hostIds: string[]; // Array of host IDs in order (first = closest to client)
}

// Per-host SSH algorithm override lists (advanced). Each property, when
// present and non-empty, fully replaces the offered list for that category.
// Category names mirror ssh2's `algorithms` shape (note: `compress`, not
// `compression`). Empty arrays or missing properties keep the default.
export interface HostAlgorithmOverrides {
  kex?: string[];
  cipher?: string[];
  hmac?: string[];
  serverHostKey?: string[];
  compress?: string[];
}

// Environment variable for SSH session
export interface EnvVar {
  name: string;
  value: string;
}

// Protocol type for connections
export type HostProtocol = 'ssh' | 'telnet' | 'mosh' | 'et' | 'local' | 'serial';
export type HostIconMode = 'auto' | 'custom';
export type HostIconColorMode = 'auto' | 'manual';
export type HostIconId =
  | 'server'
  | 'terminal'
  | 'database'
  | 'cloud'
  | 'router'
  | 'shield'
  | 'code'
  | 'box'
  | 'globe'
  | 'cpu'
  | 'hard-drive'
  | 'network'
  | 'wifi'
  | 'lock'
  | 'key'
  | 'monitor'
  | 'container'
  | 'activity'
  | 'zap'
  | 'server-cog';
export type HostIconColorId =
  | 'blue'
  | 'green'
  | 'red'
  | 'amber'
  | 'purple'
  | 'cyan'
  | 'orange'
  | 'slate'
  | 'violet'
  | 'pink'
  | 'rose'
  | 'lime'
  | 'teal'
  | 'sky'
  | 'indigo'
  | 'zinc';

// Serial port configuration
export type SerialParity = 'none' | 'even' | 'odd' | 'mark' | 'space';
export type SerialFlowControl = 'none' | 'xon/xoff' | 'rts/cts';

export interface SerialConfig {
  path: string; // Serial port path (e.g., /dev/ttyUSB0, COM1)
  baudRate: number; // Baud rate (e.g., 9600, 115200)
  dataBits?: 5 | 6 | 7 | 8; // Data bits (default: 8)
  stopBits?: 1 | 1.5 | 2; // Stop bits (default: 1)
  parity?: SerialParity; // Parity (default: 'none')
  flowControl?: SerialFlowControl; // Flow control (default: 'none')
  localEcho?: boolean; // Force local echo (default: false, rely on remote echo)
  lineMode?: boolean; // Line mode - buffer input and send on Enter (default: false)
}

// Per-protocol configuration
interface ProtocolConfig {
  protocol: HostProtocol;
  port: number;
  enabled: boolean;
  // Mosh-specific
  moshServerPath?: string;
  // EternalTerminal-specific
  etPort?: number;
  // Protocol-specific theme override
  theme?: string;
}

export interface SftpBookmark {
  id: string;
  path: string;
  label: string;
  global?: boolean;
}

export interface Host {
  id: string;
  label: string;
  hostname: string;
  port?: number;
  username: string;
  // Optional reference to a reusable identity (username + auth) stored in Keychain.
  identityId?: string;
  group?: string;
  tags: string[];
  os: 'linux' | 'windows' | 'macos';
  // Device type: 'general' for standard servers, 'network' for switches/routers/firewalls.
  // Network devices use raw command execution (no shell wrapping) for AI agent compatibility.
  deviceType?: 'general' | 'network';
  identityFileId?: string; // Reference to SSHKey
  protocol?: 'ssh' | 'telnet' | 'local' | 'serial'; // Default/primary protocol
  password?: string;
  savePassword?: boolean; // Whether to save the password (default: true)
  authMethod?: 'password' | 'key' | 'certificate';
  agentForwarding?: boolean;
  x11Forwarding?: boolean;
  createdAt?: number; // Timestamp when host was created
  startupCommand?: string;
  hostChaining?: string; // Deprecated: use hostChain instead
  proxy?: string; // Deprecated: use proxyConfig instead
  proxyProfileId?: string; // Reference to reusable proxy profile
  proxyConfig?: ProxyConfig; // New structured proxy configuration
  hostChain?: HostChainConfig; // New structured host chain configuration
  envVars?: string; // Deprecated: use environmentVariables instead
  environmentVariables?: EnvVar[]; // Structured environment variables
  charset?: string;
  moshEnabled?: boolean;
  moshServerPath?: string; // Custom mosh-server path (e.g., /usr/local/bin/mosh-server)
  etEnabled?: boolean;
  etPort?: number; // EternalTerminal server port (default: 2022)
  theme?: string;
  themeOverride?: boolean; // Explicitly override the global terminal theme for this host
  fontFamily?: string; // Terminal font family for this host
  fontFamilyOverride?: boolean; // Explicitly override the global terminal font family for this host
  fontSize?: number; // Terminal font size for this host (pt)
  fontSizeOverride?: boolean; // Explicitly override the global terminal font size for this host
  fontWeight?: number; // Terminal font weight for this host (100-900)
  fontWeightOverride?: boolean; // Explicitly override the global terminal font weight for this host
  distro?: string; // detected distro id (e.g., ubuntu, debian)
  distroMode?: 'auto' | 'manual'; // whether distro icon comes from detection or manual override
  manualDistro?: string; // manually selected distro id when distroMode='manual'
  iconMode?: HostIconMode; // Optional host icon mode. Missing/auto preserves distro detection.
  iconId?: HostIconId; // Curated icon override used when iconMode='custom'
  iconColorMode?: HostIconColorMode; // Whether icon color follows the icon default or a manual override
  iconColor?: HostIconColorId; // Palette color used when iconColorMode='manual'
  iconColorCustom?: string; // Custom hex color used when iconColorMode='manual'
  // Multi-protocol support
  protocols?: ProtocolConfig[]; // Multiple protocol configurations
  telnetPort?: number; // Telnet-specific port (for quick access)
  telnetEnabled?: boolean; // Is Telnet enabled for this host
  telnetUsername?: string; // Telnet-specific username
  telnetPassword?: string; // Telnet-specific password
  // Serial-specific configuration (for protocol='serial' hosts)
  serialConfig?: SerialConfig;
  // SFTP specific configuration
  sftpSudo?: boolean; // Use sudo for SFTP operations (requires password)
  sftpEncoding?: SftpFilenameEncoding; // Filename encoding for SFTP operations
  sftpBookmarks?: SftpBookmark[]; // Bookmarked SFTP paths for quick navigation
  // Managed source: if this host is managed by an external file (e.g., ~/.ssh/config)
  managedSourceId?: string; // Reference to ManagedSource.id
  // Host-level keyword highlighting (overrides/extends global settings)
  keywordHighlightRules?: KeywordHighlightRule[];
  keywordHighlightEnabled?: boolean;
  // Legacy SSH algorithm support for older network equipment (switches, routers)
  legacyAlgorithms?: boolean;
  // Drop every ecdsa-sha2-* from the offered host-key list. Some old Huawei
  // VRP / Cisco IOS stacks negotiate ECDSA but produce signatures ssh2's
  // strict RFC verifier rejects ("signature verification failed"). Forcing
  // RSA / DSA / Ed25519 fallback restores compatibility — see #1027.
  skipEcdsaHostKey?: boolean;
  // Per-host SSH algorithm overrides (advanced). When a category's array is
  // non-empty, it fully replaces the offered list for that category. Use
  // sparingly — incorrect values make the host unreachable.
  algorithms?: HostAlgorithmOverrides;
  // Per-host SSH keepalive override. When `keepaliveOverride === true`, the
  // host uses its own `keepaliveInterval` / `keepaliveCountMax` instead of
  // inheriting the global TerminalSettings values. Lets a user keep an
  // aggressive cloud-friendly keepalive globally while disabling it for a
  // specific router / embedded device whose SSH stack doesn't reply to
  // OpenSSH keepalive global requests (issue #581 / #939).
  keepaliveInterval?: number; // Seconds; 0 = disabled
  keepaliveCountMax?: number; // Unanswered keepalives before declaring dead
  keepaliveOverride?: boolean;
  // Show local timestamps for this host beside terminal output rows.
  // Kept per-host because timestamp visibility is usually a host/workflow preference.
  showLineTimestamps?: boolean;
  // What the Backspace key sends: undefined = xterm default (no interception), 'ctrl-h' = ^H (0x08)
  backspaceBehavior?: 'ctrl-h';
  // Local SSH key file paths (from SSH config IdentityFile or user-added)
  // Resolved at connection time — the app reads the file content when connecting.
  identityFilePaths?: string[];
  // Pin host to top of All hosts view for quick access
  pinned?: boolean;
  // Timestamp of last successful connection, used for Recently Connected section
  lastConnectedAt?: number;
  // Per-session shell override for local terminals (from shell discovery)
  localShell?: string;
  localShellArgs?: string[];
  localShellName?: string;
  localShellIcon?: string;
  /** User-authored Markdown notes (project, hardware, region, etc.) */
  notes?: string;
  order?: number;
}

export type KeyType = 'RSA' | 'ECDSA' | 'ED25519';
type KeySource = 'generated' | 'imported' | 'reference';
export type KeyCategory = 'key' | 'certificate' | 'identity';
type IdentityAuthMethod = 'password' | 'key' | 'certificate';

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
  created: number;
  filePath?: string;
  order?: number;
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
  order?: number;
}

export interface Snippet {
  id: string;
  label: string;
  command: string; // Multi-line script
  tags?: string[];
  package?: string; // package path
  targets?: string[]; // host ids
  shortkey?: string; // Keyboard shortcut to send this snippet in terminal (e.g., "F1", "Ctrl + F1")
  noAutoRun?: boolean; // If true, paste command without executing (no trailing Enter)
  order?: number;
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
  /** Pre-computed total host count including all descendants. Set during tree construction. */
  totalHostCount?: number;
}

/** Default configuration for a group. Hosts in this group inherit these values when not explicitly set. */
export interface GroupConfig {
  path: string;
  order?: number;
  username?: string;
  password?: string;
  savePassword?: boolean;
  authMethod?: 'password' | 'key' | 'certificate';
  identityId?: string;
  identityFileId?: string;
  identityFilePaths?: string[];
  port?: number;
  protocol?: 'ssh' | 'telnet';
  agentForwarding?: boolean;
  proxyProfileId?: string;
  proxyConfig?: ProxyConfig;
  hostChain?: HostChainConfig;
  startupCommand?: string;
  legacyAlgorithms?: boolean;
  skipEcdsaHostKey?: boolean;
  algorithms?: HostAlgorithmOverrides;
  environmentVariables?: EnvVar[];
  charset?: string;
  moshEnabled?: boolean;
  moshServerPath?: string;
  etEnabled?: boolean;
  etPort?: number;
  telnetEnabled?: boolean;
  telnetPort?: number;
  telnetUsername?: string;
  telnetPassword?: string;
  theme?: string;
  themeOverride?: boolean;
  fontFamily?: string;
  fontFamilyOverride?: boolean;
  fontSize?: number;
  fontSizeOverride?: boolean;
  fontWeight?: number;
  fontWeightOverride?: boolean;
  backspaceBehavior?: 'ctrl-h';
}

export interface SyncConfig {
  gistId: string;
  githubToken: string;
  gistToken?: string; // Alias for githubToken (deprecated, use githubToken)
  lastSync?: number;
}
