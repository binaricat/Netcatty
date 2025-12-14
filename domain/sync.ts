/**
 * Cloud Sync Domain Types & Interfaces
 * 
 * Zero-Knowledge Encrypted Multi-Cloud Sync System
 * Supports: GitHub Gist, Google Drive, Microsoft OneDrive
 */

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
  | 'ERROR';     // Operation failed - needs attention

/**
 * Conflict Resolution Strategy
 */
export type ConflictResolution = 
  | 'USE_REMOTE' // Download cloud data, overwrite local
  | 'USE_LOCAL'; // Upload local data, overwrite cloud

// ============================================================================
// Cloud Provider Types
// ============================================================================

/**
 * Supported cloud storage providers
 */
export type CloudProvider = 'github' | 'google' | 'onedrive';

/**
 * Provider-specific connection status
 */
export type ProviderConnectionStatus = 
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
  lastSync?: number;        // Unix timestamp
  lastSyncVersion?: number;
  resourceId?: string;      // gistId / fileId / itemId
  error?: string;
}

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
  snippets: import('./models').Snippet[];
  customGroups: string[];
  
  // Port forwarding rules
  portForwardingRules?: import('./models').PortForwardingRule[];
  
  // Known hosts
  knownHosts?: import('./models').KnownHost[];
  
  // Settings
  settings?: {
    theme?: 'light' | 'dark' | 'system';
    accentColor?: string;
    terminalTheme?: string;
    terminalFontFamily?: string;
    terminalFontSize?: number;
    hotkeyScheme?: string;
    customKeyBindings?: Record<string, { mac?: string; pc?: string }>;
  };
  
  // Sync metadata
  syncedAt: number;         // When this payload was created
}

// ============================================================================
// Encryption Types
// ============================================================================

/**
 * Key derivation parameters
 */
export interface KDFParams {
  algorithm: 'PBKDF2' | 'Argon2id';
  salt: Uint8Array;
  iterations?: number;      // For PBKDF2 (default: 600000)
  memory?: number;          // For Argon2 (KB)
  parallelism?: number;     // For Argon2
}

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
  biometricEnabled?: boolean;
  // If biometric enabled, encrypted master key stored here
  encryptedMasterKey?: string; // Base64
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
  action: 'upload' | 'download' | 'none';
  version?: number;
  error?: string;
  conflictDetected?: boolean;
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
}

/**
 * Sync manager configuration
 */
export interface SyncManagerConfig {
  autoSync: boolean;
  autoSyncInterval: number; // Minutes
  providers: CloudProvider[];
  deviceId: string;
  deviceName: string;
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

/**
 * Google OAuth token response
 */
export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/**
 * OneDrive/MSAL token response
 */
export interface OneDriveTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresOn: number;
  tokenType: string;
  scopes: string[];
  account?: {
    homeAccountId: string;
    username: string;
    name?: string;
  };
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
  | { type: 'CONFLICT_RESOLVED'; resolution: ConflictResolution }
  | { type: 'AUTH_REQUIRED'; provider: CloudProvider }
  | { type: 'AUTH_COMPLETED'; provider: CloudProvider; account: ProviderAccount }
  | { type: 'SECURITY_STATE_CHANGED'; state: SecurityState };

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
  LOCAL_SYNC_META: 'netcatty_local_sync_meta_v1',
} as const;

// ============================================================================
// Constants
// ============================================================================

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
  GITHUB_CLIENT_ID: 'Ov23liuLdkw1H393rtT4', // Public client ID for Device Flow
  GOOGLE_CLIENT_ID: '840441747394-n58o8ibgivgd3frqsn0bo5revf4viq2a.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: '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', // TODO: Replace with your Desktop app client secret
  ONEDRIVE_CLIENT_ID: 'your-onedrive-client-id',
  
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
 * Format last sync time for display
 */
export const formatLastSync = (timestamp?: number): string => {
  if (!timestamp) return 'Never synced';
  
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  
  const date = new Date(timestamp);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/**
 * Get status color for sync state
 */
export const getSyncStatusColor = (status: ProviderConnectionStatus): string => {
  switch (status) {
    case 'connected': return 'text-green-500';
    case 'syncing': return 'text-blue-500';
    case 'error': return 'text-red-500';
    case 'connecting': return 'text-yellow-500';
    default: return 'text-muted-foreground';
  }
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
