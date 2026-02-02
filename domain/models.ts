// Proxy configuration for SSH connections
export type ProxyType = 'http' | 'socks5';
// UI locale identifier, stored in settings and used for i18n (e.g., "en", "zh-CN").
export type UILanguage = string;

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
export type HostProtocol = 'ssh' | 'telnet' | 'mosh' | 'local' | 'serial';

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
  // Optional reference to a reusable identity (username + auth) stored in Keychain.
  identityId?: string;
  group?: string;
  tags: string[];
  os: 'linux' | 'windows' | 'macos';
  identityFileId?: string; // Reference to SSHKey
  protocol?: 'ssh' | 'telnet' | 'local' | 'serial'; // Default/primary protocol
  password?: string;
  savePassword?: boolean; // Whether to save the password (default: true)
  authMethod?: 'password' | 'key' | 'certificate';
  agentForwarding?: boolean;
  createdAt?: number; // Timestamp when host was created
  startupCommand?: string;
  hostChaining?: string; // Deprecated: use hostChain instead
  proxy?: string; // Deprecated: use proxyConfig instead
  proxyConfig?: ProxyConfig; // New structured proxy configuration
  hostChain?: HostChainConfig; // New structured host chain configuration
  envVars?: string; // Deprecated: use environmentVariables instead
  environmentVariables?: EnvVar[]; // Structured environment variables
  charset?: string;
  moshEnabled?: boolean;
  moshServerPath?: string; // Custom mosh-server path (e.g., /usr/local/bin/mosh-server)
  theme?: string;
  fontFamily?: string; // Terminal font family for this host
  fontSize?: number; // Terminal font size for this host (pt)
  distro?: string; // detected distro id (e.g., ubuntu, debian)
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
  // Managed source: if this host is managed by an external file (e.g., ~/.ssh/config)
  managedSourceId?: string; // Reference to ManagedSource.id
}

export type KeyType = 'RSA' | 'ECDSA' | 'ED25519';
export type KeySource = 'generated' | 'imported';
export type KeyCategory = 'key' | 'certificate' | 'identity';
export type IdentityAuthMethod = 'password' | 'key' | 'certificate';

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
  shortkey?: string; // Keyboard shortcut to send this snippet in terminal (e.g., "F1", "Ctrl + F1")
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
  gistToken?: string; // Alias for githubToken (deprecated, use githubToken)
  lastSync?: number;
}

// Keyboard Shortcuts / Hotkeys
export type HotkeyScheme = 'disabled' | 'mac' | 'pc';

export interface KeyBinding {
  id: string;
  action: string;
  label: string;
  mac: string; // e.g., '⌘+1', '⌘+⌥+arrows'
  pc: string; // e.g., 'Ctrl+1', 'Ctrl+Alt+arrows'
  category: 'tabs' | 'terminal' | 'navigation' | 'app' | 'sftp';
}

// User's custom key bindings - only stores overrides from defaults
export type CustomKeyBindings = Record<string, { mac?: string; pc?: string }>;

// Parse a key string like "⌘ + Shift + K" or "Ctrl + Alt + T" into normalized form
export const parseKeyCombo = (keyStr: string): { modifiers: string[]; key: string } | null => {
  if (!keyStr || keyStr === 'Disabled') return null;
  const parts = keyStr.split('+').map(p => p.trim());
  const key = parts.pop() || '';
  return { modifiers: parts, key };
};

// Convert keyboard event to a key string
export const keyEventToString = (e: KeyboardEvent, isMac: boolean): string => {
  const parts: string[] = [];
  
  if (isMac) {
    if (e.metaKey) parts.push('⌘');
    if (e.ctrlKey) parts.push('⌃');
    if (e.altKey) parts.push('⌥');
    if (e.shiftKey) parts.push('Shift');
  } else {
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');
  }
  
  // Get the key name
  let keyName = e.key;
  // Normalize special keys
  if (keyName === ' ') keyName = 'Space';
  else if (keyName === 'ArrowUp') keyName = '↑';
  else if (keyName === 'ArrowDown') keyName = '↓';
  else if (keyName === 'ArrowLeft') keyName = '←';
  else if (keyName === 'ArrowRight') keyName = '→';
  else if (keyName === 'Escape') keyName = 'Esc';
  else if (keyName === 'Backspace') keyName = '⌫';
  else if (keyName === 'Delete') keyName = 'Del';
  else if (keyName === 'Enter') keyName = '↵';
  else if (keyName === 'Tab') keyName = '⇥';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();
  
  // Don't include modifier keys themselves
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
    return parts.join(' + ');
  }
  
  parts.push(keyName);
  return parts.join(' + ');
};

// Check if a keyboard event matches a key binding string
export const matchesKeyBinding = (e: KeyboardEvent, keyStr: string, isMac: boolean): boolean => {
  if (!keyStr || keyStr === 'Disabled') return false;
  
  // Handle range patterns like "[1...9]"
  if (keyStr.includes('[1...9]')) {
    const basePattern = keyStr.replace('[1...9]', '');
    const key = e.key;
    if (!/^[1-9]$/.test(key)) return false;
    // Check modifiers match the base pattern
    const testStr = basePattern + key;
    return matchesKeyBinding(e, testStr.trim(), isMac);
  }
  
  // Handle arrow key patterns like "arrows"
  if (keyStr.includes('arrows')) {
    const basePattern = keyStr.replace('arrows', '');
    const key = e.key;
    // Check if it's an arrow key
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return false;
    // Map arrow key to symbol for matching
    const arrowSymbol = key === 'ArrowUp' ? '↑' 
      : key === 'ArrowDown' ? '↓'
      : key === 'ArrowLeft' ? '←'
      : '→';
    // Check modifiers match the base pattern
    const testStr = basePattern + arrowSymbol;
    return matchesKeyBinding(e, testStr.trim(), isMac);
  }
  
  const parsed = parseKeyCombo(keyStr);
  if (!parsed) return false;
  
  const { modifiers, key } = parsed;

  const hasMacModifiers = modifiers.some((modifier) => ['⌘', '⌃', '⌥'].includes(modifier));
  const hasPcModifiers = modifiers.some((modifier) => ['Ctrl', 'Alt', 'Win'].includes(modifier));
  if ((!isMac && hasMacModifiers) || (isMac && hasPcModifiers)) {
    return false;
  }
  
  // Check modifiers
  if (isMac) {
    const needMeta = modifiers.includes('⌘');
    const needCtrl = modifiers.includes('⌃');
    const needAlt = modifiers.includes('⌥');
    const needShift = modifiers.includes('Shift');
    
    if (e.metaKey !== needMeta) return false;
    if (e.ctrlKey !== needCtrl) return false;
    if (e.altKey !== needAlt) return false;
    if (e.shiftKey !== needShift) return false;
  } else {
    const needCtrl = modifiers.includes('Ctrl');
    const needAlt = modifiers.includes('Alt');
    const needShift = modifiers.includes('Shift');
    const needMeta = modifiers.includes('Win');
    
    if (e.ctrlKey !== needCtrl) return false;
    if (e.altKey !== needAlt) return false;
    if (e.shiftKey !== needShift) return false;
    if (e.metaKey !== needMeta) return false;
  }
  
  const normalizeKey = (rawKey: string): string => {
    let normalizedKey = rawKey;
    if (normalizedKey === ' ') normalizedKey = 'Space';
    else if (normalizedKey === 'ArrowUp') normalizedKey = '↑';
    else if (normalizedKey === 'ArrowDown') normalizedKey = '↓';
    else if (normalizedKey === 'ArrowLeft') normalizedKey = '←';
    else if (normalizedKey === 'ArrowRight') normalizedKey = '→';
    else if (normalizedKey === 'Escape') normalizedKey = 'Esc';
    else if (normalizedKey === 'Backspace') normalizedKey = '⌫';
    else if (normalizedKey === 'Delete') normalizedKey = 'Del';
    else if (normalizedKey === '[') normalizedKey = '[';
    else if (normalizedKey === ']') normalizedKey = ']';
    else if (normalizedKey === 'Del') normalizedKey = 'Del';
    return normalizedKey;
  };

  const eventKey = normalizeKey(e.key);
  const parsedKey = normalizeKey(key);

  return eventKey.toLowerCase() === parsedKey.toLowerCase();
};

export const DEFAULT_KEY_BINDINGS: KeyBinding[] = [
  // Tab Management
  { id: 'switch-tab-1-9', action: 'switchToTab', label: 'Switch to Tab [1...9]', mac: '⌘ + [1...9]', pc: 'Ctrl + [1...9]', category: 'tabs' },
  { id: 'next-tab', action: 'nextTab', label: 'Next Tab', mac: '⌘ + Shift + ]', pc: 'Ctrl + Tab', category: 'tabs' },
  { id: 'prev-tab', action: 'prevTab', label: 'Previous Tab', mac: '⌘ + Shift + [', pc: 'Ctrl + Shift + Tab', category: 'tabs' },
  { id: 'close-tab', action: 'closeTab', label: 'Close Tab', mac: '⌘ + W', pc: 'Ctrl + W', category: 'tabs' },
  { id: 'new-tab', action: 'newTab', label: 'New Local Tab', mac: '⌘ + T', pc: 'Ctrl + T', category: 'tabs' },

  // Terminal Operations
  { id: 'copy', action: 'copy', label: 'Copy from Terminal', mac: '⌘ + C', pc: 'Ctrl + Shift + C', category: 'terminal' },
  { id: 'paste', action: 'paste', label: 'Paste to Terminal', mac: '⌘ + V', pc: 'Ctrl + Shift + V', category: 'terminal' },
  { id: 'select-all', action: 'selectAll', label: 'Select All in Terminal', mac: '⌘ + A', pc: 'Ctrl + Shift + A', category: 'terminal' },
  { id: 'clear-buffer', action: 'clearBuffer', label: 'Clear Terminal Buffer', mac: '⌘ + ⌃ + K', pc: 'Ctrl + Shift + K', category: 'terminal' },
  { id: 'search-terminal', action: 'searchTerminal', label: 'Open Terminal Search', mac: '⌘ + F', pc: 'Ctrl + Shift + F', category: 'terminal' },

  // Navigation / Split View
  { id: 'move-focus', action: 'moveFocus', label: 'Move focus between Split View panes', mac: '⌘ + ⌥ + arrows', pc: 'Ctrl + Alt + arrows', category: 'navigation' },
  { id: 'split-horizontal', action: 'splitHorizontal', label: 'Split Horizontal', mac: '⌘ + D', pc: 'Ctrl + Shift + D', category: 'navigation' },
  { id: 'split-vertical', action: 'splitVertical', label: 'Split Vertical', mac: '⌘ + Shift + D', pc: 'Ctrl + Shift + E', category: 'navigation' },

  // App Features
  { id: 'open-hosts', action: 'openHosts', label: 'Open Hosts Page', mac: 'Disabled', pc: 'Disabled', category: 'app' },
  { id: 'open-local', action: 'openLocal', label: 'Open Local Terminal', mac: '⌘ + L', pc: 'Ctrl + L', category: 'app' },
  { id: 'open-sftp', action: 'openSftp', label: 'Open SFTP', mac: '⌘ + Shift + O', pc: 'Ctrl + Shift + O', category: 'app' },
  { id: 'port-forwarding', action: 'portForwarding', label: 'Open Port Forwarding', mac: '⌘ + P', pc: 'Ctrl + P', category: 'app' },
  { id: 'command-palette', action: 'commandPalette', label: 'Open Command Palette', mac: '⌘ + K', pc: 'Ctrl + K', category: 'app' },
  { id: 'quick-switch', action: 'quickSwitch', label: 'Quick Switch', mac: '⌘ + J', pc: 'Ctrl + J', category: 'app' },
  { id: 'snippets', action: 'snippets', label: 'Open Snippets', mac: '⌘ + Shift + S', pc: 'Ctrl + Shift + S', category: 'app' },
  { id: 'broadcast', action: 'broadcast', label: 'Switch the Broadcast Mode', mac: '⌘ + B', pc: 'Ctrl + B', category: 'app' },

  // SFTP Operations
  { id: 'sftp-copy', action: 'sftpCopy', label: 'Copy Files', mac: '⌘ + C', pc: 'Ctrl + C', category: 'sftp' },
  { id: 'sftp-cut', action: 'sftpCut', label: 'Cut Files', mac: '⌘ + X', pc: 'Ctrl + X', category: 'sftp' },
  { id: 'sftp-paste', action: 'sftpPaste', label: 'Paste Files', mac: '⌘ + V', pc: 'Ctrl + V', category: 'sftp' },
  { id: 'sftp-select-all', action: 'sftpSelectAll', label: 'Select All Files', mac: '⌘ + A', pc: 'Ctrl + A', category: 'sftp' },
  { id: 'sftp-rename', action: 'sftpRename', label: 'Rename File', mac: 'F2', pc: 'F2', category: 'sftp' },
  { id: 'sftp-delete', action: 'sftpDelete', label: 'Delete Files', mac: '⌘ + ⌫', pc: 'Delete', category: 'sftp' },
  { id: 'sftp-refresh', action: 'sftpRefresh', label: 'Refresh', mac: '⌘ + R', pc: 'F5', category: 'sftp' },
  { id: 'sftp-new-folder', action: 'sftpNewFolder', label: 'New Folder', mac: '⌘ + Shift + N', pc: 'Ctrl + Shift + N', category: 'sftp' },
];

// Terminal appearance settings
export type CursorShape = 'block' | 'bar' | 'underline';
export type RightClickBehavior = 'context-menu' | 'paste' | 'select-word';
export type LinkModifier = 'none' | 'ctrl' | 'alt' | 'meta';
export type TerminalEmulationType = 'xterm-256color' | 'xterm-16color' | 'xterm';

// Keyword highlighting configuration
export interface KeywordHighlightRule {
  id: string;
  label: string; // Display name (e.g., "Error", "Warning", "OK")
  patterns: string[]; // Regex patterns to match
  color: string; // Highlight color (hex)
  enabled: boolean;
}

export interface TerminalSettings {
  // Rendering
  scrollback: number; // Number of lines kept in buffer
  drawBoldInBrightColors: boolean; // Draw bold text in bright colors
  terminalEmulationType: TerminalEmulationType; // Terminal emulation type (TERM env var)

  // Font
  fontLigatures: boolean; // Enable font ligatures
  fontWeight: number; // Normal font weight (100-900)
  fontWeightBold: number; // Bold font weight (100-900)
  linePadding: number; // Additional space between lines
  fallbackFont: string; // Fallback font family

  // Cursor
  cursorShape: CursorShape;
  cursorBlink: boolean;

  // Accessibility
  minimumContrastRatio: number; // Minimum contrast ratio (1-21)

  // Keyboard
  altAsMeta: boolean; // Use ⌥ as the Meta key
  scrollOnInput: boolean; // Scroll terminal to bottom on input
  scrollOnOutput: boolean; // Scroll terminal to bottom on output
  scrollOnKeyPress: boolean; // Scroll terminal to bottom on key press
  scrollOnPaste: boolean; // Scroll terminal to bottom on paste

  // Mouse
  rightClickBehavior: RightClickBehavior;
  copyOnSelect: boolean; // Automatically copy selected text
  middleClickPaste: boolean; // Paste on middle-click
  wordSeparators: string; // Characters for word selection
  linkModifier: LinkModifier; // Modifier key to click links

  // Keyword Highlighting
  keywordHighlightEnabled: boolean;
  keywordHighlightRules: KeywordHighlightRule[];

  // Local Shell Configuration
  localShell: string; // Path to shell executable (empty = system default)
  localStartDir: string; // Starting directory for local terminal (empty = home directory)

  // SSH Connection
  keepaliveInterval: number; // Seconds between SSH-level keepalive packets (0 = disabled)

  // Server Stats Display (Linux only)
  showServerStats: boolean; // Show CPU/Memory/Disk in terminal statusbar
  serverStatsRefreshInterval: number; // Seconds between stats refresh (default: 30)

  // Rendering
  rendererType: 'auto' | 'webgl' | 'canvas'; // Terminal renderer: auto (detect based on hardware), webgl, or canvas
}

export const DEFAULT_KEYWORD_HIGHLIGHT_RULES: KeywordHighlightRule[] = [
  { id: 'error', label: 'Error', patterns: ['\\[error\\]', '\\[err\\]', '\\berror\\b', '\\bfail(ed)?\\b', '\\bfatal\\b', '\\bcritical\\b', '\\bexception\\b'], color: '#F87171', enabled: true },
  { id: 'warning', label: 'Warning', patterns: ['\\[warn(ing)?\\]', '\\bwarn(ing)?\\b', '\\bcaution\\b', '\\bdeprecated\\b'], color: '#FBBF24', enabled: true },
  { id: 'ok', label: 'OK', patterns: ['\\[ok\\]', '\\bok\\b', '\\bsuccess(ful)?\\b', '\\bpassed\\b', '\\bcompleted\\b', '\\bdone\\b'], color: '#34D399', enabled: true },
  { id: 'info', label: 'Info', patterns: ['\\[info\\]', '\\[notice\\]', '\\[note\\]', '\\bnotice\\b', '\\bnote\\b'], color: '#3B82F6', enabled: true },
  { id: 'debug', label: 'Debug', patterns: ['\\[debug\\]', '\\[trace\\]', '\\[verbose\\]', '\\bdebug\\b', '\\btrace\\b', '\\bverbose\\b'], color: '#A78BFA', enabled: true },
  { id: 'ip-mac', label: 'IP address & MAC', patterns: ['\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b', '\\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b'], color: '#EC4899', enabled: true },
];

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  scrollback: 10000,
  drawBoldInBrightColors: true,
  terminalEmulationType: 'xterm-256color',
  fontLigatures: true,
  fontWeight: 400,
  fontWeightBold: 700,
  linePadding: 0,
  fallbackFont: '',
  cursorShape: 'block',
  cursorBlink: true,
  minimumContrastRatio: 1,
  altAsMeta: false,
  scrollOnInput: true,
  scrollOnOutput: false,
  scrollOnKeyPress: false,
  scrollOnPaste: true,
  rightClickBehavior: 'context-menu',
  copyOnSelect: false,
  middleClickPaste: true,
  wordSeparators: ' ()[]{}\'"',
  linkModifier: 'none',
  keywordHighlightEnabled: true,
  keywordHighlightRules: DEFAULT_KEYWORD_HIGHLIGHT_RULES,
  localShell: '', // Empty = use system default
  localStartDir: '', // Empty = use home directory
  keepaliveInterval: 0, // 0 = disabled (use SSH library defaults)
  showServerStats: true, // Show server stats by default
  serverStatsRefreshInterval: 5, // Refresh every 5 seconds
  rendererType: 'auto', // Auto-detect best renderer based on hardware
};

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
  // Connection-time protocol overrides (used instead of looking up from hosts)
  protocol?: 'ssh' | 'telnet' | 'local' | 'serial';
  port?: number;
  moshEnabled?: boolean;
  // Serial-specific connection settings
  serialConfig?: SerialConfig;
}

export interface RemoteFile {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: string;
  lastModified: string;
  linkTarget?: 'file' | 'directory' | null; // For symlinks: the type of the target, or null if broken
  permissions?: string; // rwx format for owner/group/others e.g. "rwxr-xr-x"
  hidden?: boolean; // Windows hidden attribute (only set for local Windows filesystem)
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
export type SftpFilenameEncoding = 'auto' | 'utf-8' | 'gb18030';

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
  linkTarget?: 'file' | 'directory' | null; // For symlinks: the type of the target, or null if broken
  hidden?: boolean; // Windows hidden attribute (only set for local Windows filesystem)
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
  originalFileName?: string;
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
  // Auto-start: if true, this rule will automatically start when the app launches
  autoStart?: boolean;
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

export interface SessionLogsSettings {
  enabled: boolean; // Whether auto-save is enabled
  directory: string; // Base directory for logs
  format: SessionLogFormat; // Log file format
}

// Managed Source - external file that manages a group of hosts (e.g., ~/.ssh/config)
export type ManagedSourceType = 'ssh_config';

export interface ManagedSource {
  id: string;
  type: ManagedSourceType;
  filePath: string;
  groupName: string;
  lastSyncedAt: number;
  lastFileHash?: string;
}
