/**
 * Cloud Sync Domain Types & Interfaces
 *
 * Zero-Knowledge Encrypted Multi-Cloud Sync System
 * Supports: GitHub Gist, Google Drive, Microsoft OneDrive, WebDAV, S3 Compatible
 */

import type { ShrinkFinding } from './syncGuards';

// ============================================================================
// Security State Machine
// ============================================================================

/**
 * Global Security State Machine
 * Controls access to sync operations based on master key status
 */
export type SecurityState = 
  | 'NO_KEY'     // User has not set up a master key - block all sync
  | 'LOCKED'     // Master key exists but not in memory - show unlock screen
  | 'UNLOCKED';  // Master key in memory - sync operations allowed

/**
 * Sync Operation State Machine
 * Tracks the current sync operation status
 */
export type SyncState =
  | 'IDLE'       // Waiting for sync trigger
  | 'SYNCING'    // Active sync operation in progress
  | 'CONFLICT'   // Version conflict detected - needs resolution
  | 'BLOCKED'    // Outgoing payload would delete too much — user must choose restore or force-push
  | 'ERROR';     // Operation failed - needs attention

/**
 * Conflict Resolution Strategy
 */
export type ConflictResolution =
  | 'USE_REMOTE'   // Download cloud data, overwrite local
  | 'USE_LOCAL'    // Upload local data, overwrite cloud
  | 'AUTO_MERGED'; // Three-way merge was applied automatically

// ============================================================================
// Cloud Provider Types
// ============================================================================

/**
 * Supported cloud storage providers
 */
export type CloudProvider = 'github' | 'google' | 'onedrive' | 'webdav' | 's3';

export type WebDAVAuthType = 'basic' | 'digest' | 'token';

export interface WebDAVConfig {
  endpoint: string;
  authType: WebDAVAuthType;
  username?: string;
  password?: string;
  token?: string;
  allowInsecure?: boolean;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

/**
 * Provider-specific connection status
 */
type ProviderConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'error';

/**
 * OAuth token storage structure
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;  // Unix timestamp
  tokenType: string;
  scope?: string;
}

/**
 * Marker prefixed onto OneDrive refresh errors when Microsoft reports the
 * refresh token can no longer be used (expired / revoked / consent withdrawn).
 * Only an error's `message` survives the Electron IPC boundary, so the marker is
 * the stable signal that the OneDrive session must be re-authorized. It is added
 * in the bridge (electron/bridges/onedriveAuthBridge.cjs) and detected/cleaned
 * here so the same logic is shared by infrastructure and UI layers.
 */
export const ONEDRIVE_REAUTH_REQUIRED_MARKER = 'ONEDRIVE_REAUTH_REQUIRED';

/**
 * True when an error indicates the OneDrive refresh token is dead and the user
 * must reconnect. Robust to the error being re-wrapped (e.g. `new
 * Error(String(err))`) as it bubbles through the provider-agnostic pipeline.
 */
export const isOneDriveReauthRequiredMessage = (message: string): boolean =>
  message.includes(ONEDRIVE_REAUTH_REQUIRED_MARKER);

/**
 * Produce a clean, user-facing message from a (possibly multiply-wrapped) error
 * string by dropping everything up to and including the internal reauth marker,
 * e.g. "Error: OneDriveReauthRequiredError: ONEDRIVE_REAUTH_REQUIRED: OneDrive
 * session expired..." -> "OneDrive session expired...". Returns the original
 * string unchanged when the marker is absent.
 */
export const cleanOneDriveErrorMessage = (message: string): string => {
  const token = `${ONEDRIVE_REAUTH_REQUIRED_MARKER}:`;
  const markerIndex = message.lastIndexOf(token);
  if (markerIndex === -1) return message;
  return message.slice(markerIndex + token.length).trim();
};

/**
 * Provider account information
 */
export interface ProviderAccount {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * Cloud provider connection state
 */
export interface ProviderConnection {
  provider: CloudProvider;
  status: ProviderConnectionStatus;
  account?: ProviderAccount;
  tokens?: OAuthTokens;
  config?: WebDAVConfig | S3Config;
  lastSync?: number;        // Unix timestamp
  lastSyncVersion?: number;
  resourceId?: string;      // gistId / fileId / itemId
  error?: string;
}

const hasProviderConnectionData = (
  connection: Pick<ProviderConnection, 'tokens' | 'config'>,
): boolean => Boolean(connection.tokens || connection.config);

export const isProviderReadyForSync = (
  connection: Pick<ProviderConnection, 'status' | 'tokens' | 'config'>,
): boolean =>
  connection.status === 'connected'
  || connection.status === 'syncing'
  || (connection.status === 'error' && hasProviderConnectionData(connection));

// ============================================================================
// Encrypted Sync File Schema
// ============================================================================

/**
 * Sync file metadata (stored in plaintext for version control)
 */
export interface SyncFileMeta {
  version: number;          // Incremental version number
  updatedAt: number;        // Unix timestamp (ms)
  deviceId: string;         // UUID identifying the device
  deviceName?: string;      // Human-readable device name
  appVersion: string;       // App version that created this sync
  iv: string;               // AES-GCM initialization vector (Base64)
  salt: string;             // KDF salt for key derivation (Base64)
  algorithm: 'AES-256-GCM'; // Encryption algorithm identifier
  kdf: 'PBKDF2' | 'Argon2id'; // Key derivation function
  kdfIterations?: number;   // PBKDF2 iterations (if applicable)
}

/**
 * Complete synced file structure
 * The payload contains all encrypted user data
 */
export interface SyncedFile {
  meta: SyncFileMeta;
  payload: string;          // Base64 encrypted ciphertext
}

/**
 * Decrypted payload structure - contains all syncable data
 */
export interface SyncPayload {
  // Core vault data
  hosts: import('./models').Host[];
  keys: import('./models').SSHKey[];
  identities?: import('./models').Identity[];
  proxyProfiles?: import('./models').ProxyProfile[];
  snippets: import('./models').Snippet[];
  customGroups: string[];
  snippetPackages?: string[];
  notes?: import('./models').VaultNote[];
  noteGroups?: string[];

  // Group configs (connection defaults per host group)
  groupConfigs?: import('./models').GroupConfig[];

  // Port forwarding rules
  portForwardingRules?: import('./models').PortForwardingRule[];
  
  // Known hosts
  knownHosts?: import('./models').KnownHost[];
  
  // Settings
  settings?: {
    // Theme & Appearance
    theme?: 'light' | 'dark' | 'system';
    lightUiThemeId?: string;
    darkUiThemeId?: string;
    accentMode?: 'theme' | 'custom';
    customAccent?: string;
    uiFontFamilyId?: string;
    uiLanguage?: string;
    customCSS?: string;
    // Terminal
    terminalTheme?: string;
    followAppTerminalTheme?: boolean;
    terminalThemeDark?: string;
    terminalThemeLight?: string;
    terminalFontFamily?: string;
    terminalFontSize?: number;
    terminalSettings?: Record<string, unknown>;
    terminalSidePanelAutoOpen?: boolean;
    terminalSidePanelAutoOpenTab?: import('./terminalSidePanelAutoOpen').TerminalSidePanelAutoOpenTab;
    customTerminalThemes?: Array<{ id: string; name: string; colors: Record<string, string> }>;
    // Keyboard
    customKeyBindings?: Record<string, { mac?: string; pc?: string }>;
    // Editor
    editorWordWrap?: boolean;
    // SFTP
    sftpDoubleClickBehavior?: 'open' | 'transfer';
    sftpAutoSync?: boolean;
    sftpShowHiddenFiles?: boolean;
    sftpUseCompressedUpload?: boolean;
    sftpAutoOpenSidebar?: boolean;
    sftpFollowTerminalCwd?: boolean;
    sftpDefaultViewMode?: 'list' | 'tree';
    sftpGlobalBookmarks?: import('./models').SftpBookmark[];
    // Vault: show recently connected hosts
    showRecentHosts?: boolean;
    // Vault: root list shows only ungrouped hosts
    showOnlyUngroupedHostsInRoot?: boolean;
    // Top tabs: show standalone SFTP view tab
    showSftpTab?: boolean;
    // Shortcuts: Cmd/Ctrl+[1...9] and Ctrl+Tab skip pinned Vault/SFTP tabs
    shellOnlyTabNumberShortcuts?: boolean;
    // Shortcuts: disable terminal font zoom shortcuts
    disableTerminalFontZoom?: boolean;
    // Terminal/editor tabs: show left host list sidebar
    showHostTreeSidebar?: boolean;
    // Workspace focus indicator style
    workspaceFocusStyle?: 'dim' | 'border';
    // AI configuration
    ai?: {
      providers?: Array<Record<string, unknown>>;
      activeProviderId?: string;
      activeModelId?: string;
      globalPermissionMode?: 'observer' | 'confirm' | 'auto';
      toolIntegrationMode?: 'mcp' | 'skills';
      hostPermissions?: Array<Record<string, unknown>>;
      // externalAgents intentionally omitted: command/args/env are device-local
      // (binary paths, OS-specific values) and don't survive cross-device sync.
      defaultAgentId?: string;
      commandBlocklist?: string[];
      commandTimeout?: number;
      maxIterations?: number;
      agentModelMap?: Record<string, string>;
      agentProviderMap?: Record<string, string>;
      webSearchConfig?: Record<string, unknown> | null;
      quickMessages?: Array<Record<string, unknown>>;
      showTerminalSelectionAction?: boolean;
    };
  };

  // Sync metadata
  syncedAt: number;         // When this payload was created

  // Reliability metadata used to make sync decisions auditable across devices.
  syncMeta?: SyncReliabilityMeta;
}

export const SYNC_PAYLOAD_ENTITY_KEYS = [
  'hosts',
  'keys',
  'identities',
  'proxyProfiles',
  'snippets',
  'customGroups',
  'snippetPackages',
  'notes',
  'noteGroups',
  'portForwardingRules',
  'knownHosts',
  'groupConfigs',
] as const;

export const CLOUD_SYNC_PAYLOAD_ENTITY_KEYS = [
  'hosts',
  'keys',
  'identities',
  'proxyProfiles',
  'snippets',
  'customGroups',
  'snippetPackages',
  'notes',
  'noteGroups',
  'portForwardingRules',
  'groupConfigs',
] as const;

export type SyncPayloadEntityKey = typeof SYNC_PAYLOAD_ENTITY_KEYS[number];
export type CloudSyncPayloadEntityKey = typeof CLOUD_SYNC_PAYLOAD_ENTITY_KEYS[number];
export type SyncChangeEntityKey = CloudSyncPayloadEntityKey | 'settings';

export interface SyncEntityChangeCounts {
  added: { local: number; remote: number };
  modified: { local: number; remote: number };
  deleted: { local: number; remote: number };
}

export interface SyncConflictDetail {
  entityType: SyncChangeEntityKey;
  id?: string;
  kind:
    | 'both-added'
    | 'both-modified'
    | 'local-deleted-remote-modified'
    | 'remote-deleted-local-modified';
}

export interface SyncChangeSummary {
  hasLocalChanges: boolean;
  hasRemoteChanges: boolean;
  hasConflicts: boolean;
  byEntity: Partial<Record<SyncChangeEntityKey, SyncEntityChangeCounts>>;
  conflicts: SyncConflictDetail[];
}

export interface SyncDeletionRecord {
  entityType: CloudSyncPayloadEntityKey;
  id: string;
  deletedAt: number;
  deviceId?: string;
}

export interface SyncReliabilityMeta {
  schemaVersion: 1;
  generatedAt: number;
  deviceId?: string;
  baseSyncedAt?: number;
  localChanged: boolean;
  deletions: SyncDeletionRecord[];
  changeSummary: SyncChangeSummary;
}

export interface SyncSnapshotEntry {
  id: string;
  timestamp: number;
  provider?: CloudProvider;
  payload: SyncPayload;
}

export function hasSyncPayloadEntityData(
  payload: SyncPayload,
  keys: readonly SyncPayloadEntityKey[] = SYNC_PAYLOAD_ENTITY_KEYS,
): boolean {
  return keys.some((key) => {
    const value = payload[key];
    return Array.isArray(value) && value.length > 0;
  });
}

// ============================================================================
// Encryption Types
// ============================================================================

/**
 * Encryption result
 */
export interface EncryptionResult {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  salt: Uint8Array;
  algorithm: 'AES-256-GCM';
  kdf: 'PBKDF2' | 'Argon2id';
  kdfIterations?: number;
}

/**
 * Decryption input
 */
export interface DecryptionInput {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  salt: Uint8Array;
  kdf: 'PBKDF2' | 'Argon2id';
  kdfIterations?: number;
}

// ============================================================================
// Master Key Types
// ============================================================================

/**
 * Master key configuration stored in safeStorage
 */
export interface MasterKeyConfig {
  // Verification hash to confirm correct password
  verificationHash: string; // Base64 of hash(derived_key)
  salt: string;             // Base64 KDF salt
  kdf: 'PBKDF2' | 'Argon2id';
  kdfIterations?: number;
  createdAt: number;
}

/**
 * Unlocked master key state (in memory only)
 */
export interface UnlockedMasterKey {
  derivedKey: CryptoKey;    // AES-256-GCM key
  salt: Uint8Array;
  unlockedAt: number;
}

// ============================================================================
// Sync Manager Types
// ============================================================================

/**
 * Sync operation result
 */
export interface SyncResult {
  success: boolean;
  provider: CloudProvider;
  action: 'upload' | 'download' | 'merge' | 'none';
  version?: number;
  error?: string;
  conflictDetected?: boolean;
  /** Present when sync produced or selected a payload that caller should apply locally */
  mergedPayload?: import('./sync').SyncPayload;
  /** Present with a downloaded payload so callers can commit the remote anchor after local apply succeeds. */
  remoteFile?: SyncedFile;
  /** True when a shrink-detection guard blocked the upload */
  shrinkBlocked?: boolean;
  /** The finding that triggered the shrink block or force-push */
  finding?: ShrinkFinding;
}

export interface RemoteSyncPayload {
  provider: CloudProvider;
  payload: SyncPayload;
  remoteFile: SyncedFile;
}

/**
 * Conflict information for UI
 */
export interface ConflictInfo {
  provider: CloudProvider;
  localVersion: number;
  localUpdatedAt: number;
  localDeviceName?: string;
  remoteVersion: number;
  remoteUpdatedAt: number;
  remoteDeviceName?: string;
  changeSummary?: SyncChangeSummary;
}

/**
 * Sync history record entry
 */
export interface SyncHistoryEntry {
  id: string;
  timestamp: number;
  provider: CloudProvider;
  action: 'upload' | 'download' | 'merge' | 'conflict_resolved';
  success: boolean;
  localVersion: number;
  remoteVersion?: number;
  deviceName?: string;
  error?: string;
}

// ============================================================================
// OAuth Flow Types
// ============================================================================

/**
 * GitHub Device Flow response
 */
export interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * OAuth PKCE challenge
 */
export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Sync event for UI updates
 */
export type SyncEvent = 
  | { type: 'SYNC_STARTED'; provider: CloudProvider }
  | { type: 'SYNC_PROGRESS'; provider: CloudProvider; progress: number; message: string }
  | { type: 'SYNC_COMPLETED'; provider: CloudProvider; result: SyncResult }
  | { type: 'SYNC_ERROR'; provider: CloudProvider; error: string }
  | { type: 'CONFLICT_DETECTED'; conflict: ConflictInfo }
  | { type: 'SYNC_BLOCKED_SHRINK'; provider: CloudProvider; finding: ShrinkFinding }
  | { type: 'SYNC_FORCED'; provider: CloudProvider; finding: ShrinkFinding }
  | { type: 'CONFLICT_RESOLVED'; resolution: ConflictResolution }
  | { type: 'AUTH_REQUIRED'; provider: CloudProvider }
  | { type: 'AUTH_COMPLETED'; provider: CloudProvider; account: ProviderAccount }
  | { type: 'SECURITY_STATE_CHANGED'; state: SecurityState }
  | { type: 'SYNC_BLOCKED_CLEARED' }
  | {
      type: 'PROVIDERS_DIVERGED';
      summaries: Array<{
        provider: CloudProvider;
        hosts: number;
        keys: number;
        snippets: number;
      }>;
    };

// ============================================================================
// Storage Keys
// ============================================================================

export const SYNC_STORAGE_KEYS = {
  MASTER_KEY_CONFIG: 'netcatty_master_key_config_v1',
  DEVICE_ID: 'netcatty_device_id_v1',
  DEVICE_NAME: 'netcatty_device_name_v1',
  SYNC_CONFIG: 'netcatty_sync_config_v2',
  PROVIDER_GITHUB: 'netcatty_provider_github_v1',
  PROVIDER_GOOGLE: 'netcatty_provider_google_v1',
  PROVIDER_ONEDRIVE: 'netcatty_provider_onedrive_v1',
  PROVIDER_WEBDAV: 'netcatty_provider_webdav_v1',
  PROVIDER_S3: 'netcatty_provider_s3_v1',
  PROVIDER_SMB: 'netcatty_provider_smb_v1',
  LOCAL_SYNC_META: 'netcatty_local_sync_meta_v1',
  SYNC_BASE_PAYLOAD: 'netcatty_sync_base_payload_v1',
} as const;

// ============================================================================
// Constants
// ============================================================================

const readBuildEnv = (key: string): string | undefined => {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const value = env?.[key];
  return value && value.trim().length ? value : undefined;
};

export const SYNC_CONSTANTS = {
  // Encryption
  AES_KEY_LENGTH: 256,
  GCM_IV_LENGTH: 12,        // bytes
  GCM_TAG_LENGTH: 128,      // bits
  SALT_LENGTH: 32,          // bytes
  
  // PBKDF2
  PBKDF2_ITERATIONS: 600000, // OWASP recommended minimum
  PBKDF2_HASH: 'SHA-256',
  
  // Sync
  SYNC_FILE_NAME: 'netcatty-vault.json',
  GIST_DESCRIPTION: 'Netcatty Encrypted Vault (DO NOT EDIT MANUALLY)',
  
  // Auto-sync
  DEFAULT_AUTO_SYNC_INTERVAL: 5, // minutes
  MIN_SYNC_INTERVAL: 1,          // minutes
  MAX_SYNC_INTERVAL: 60,         // minutes
  
  // OAuth
  GITHUB_CLIENT_ID: readBuildEnv('VITE_SYNC_GITHUB_CLIENT_ID') || '', // Public client ID for Device Flow
  GOOGLE_CLIENT_ID: readBuildEnv('VITE_SYNC_GOOGLE_CLIENT_ID') || '',
  GOOGLE_CLIENT_SECRET: readBuildEnv('VITE_SYNC_GOOGLE_CLIENT_SECRET') || '',
  ONEDRIVE_CLIENT_ID: readBuildEnv('VITE_SYNC_ONEDRIVE_CLIENT_ID') || '',
  
  // API endpoints
  GITHUB_DEVICE_CODE_URL: 'https://github.com/login/device/code',
  GITHUB_ACCESS_TOKEN_URL: 'https://github.com/login/oauth/access_token',
  GITHUB_API_BASE: 'https://api.github.com',
  
  GOOGLE_AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_DRIVE_API: 'https://www.googleapis.com/drive/v3',
  
  ONEDRIVE_AUTH_URL: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
  ONEDRIVE_TOKEN_URL: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  ONEDRIVE_GRAPH_API: 'https://graph.microsoft.com/v1.0',
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique device ID
 */
export const generateDeviceId = (): string => {
  return crypto.randomUUID();
};

/**
 * Get default device name based on OS
 */
export const getDefaultDeviceName = (): string => {
  const platform = navigator.platform || 'Unknown';
  const hostname = 'Netcatty';
  return `${hostname} (${platform})`;
};

/**
 * Format a sync timestamp as `yyyymmdd hhmm` (e.g. `20250628 1430`).
 */
export const formatSyncDateTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}${month}${day} ${hours}${minutes}`;
};

/**
 * Format last sync time for display
 */
export const formatLastSync = (timestamp?: number): string => {
  if (!timestamp) return 'Never synced';

  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;

  return formatSyncDateTime(timestamp);
};

/**
 * Get status dot color class
 */
export const getSyncDotColor = (status: ProviderConnectionStatus): string => {
  switch (status) {
    case 'connected': return 'bg-green-500';
    case 'syncing': return 'bg-blue-500';
    case 'error': return 'bg-red-500';
    case 'connecting': return 'bg-yellow-500';
    default: return 'bg-muted-foreground';
  }
};
