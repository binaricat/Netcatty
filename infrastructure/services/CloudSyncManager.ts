/**
 * CloudSyncManager - Central Orchestrator for Multi-Cloud Sync
 * 
 * Manages:
 * - Security state machine (NO_KEY → LOCKED → UNLOCKED)
 * - Sync state machine (IDLE → SYNCING → CONFLICT/ERROR)
 * - Provider adapters (GitHub, Google, OneDrive)
 * - Version conflict detection and resolution
 * - Auto-sync scheduling
 */

import {
  type CloudProvider,
  type SecurityState,
  type SyncState,
  type SyncPayload,
  type SyncResult,
  type ConflictInfo,
  type ConflictResolution,
  type MasterKeyConfig,
  type UnlockedMasterKey,
  type ProviderConnection,
  type ProviderAccount,
  type SyncEvent,
  type OAuthTokens,
  type SyncHistoryEntry,
  type WebDAVConfig,
  type S3Config,
  type SyncedFile,
  SYNC_CONSTANTS,
  SYNC_STORAGE_KEYS,
  generateDeviceId,
  getDefaultDeviceName,
  isProviderReadyForSync,
} from '../../domain/sync';
import packageJson from '../../package.json';
import { EncryptionService } from './EncryptionService';
import { createAdapter, type CloudAdapter } from './adapters';
import { localStorageAdapter } from '../persistence/localStorageAdapter';
import type { GitHubAdapter } from './adapters/GitHubAdapter';
import type { GoogleDriveAdapter } from './adapters/GoogleDriveAdapter';
import type { OneDriveAdapter } from './adapters/OneDriveAdapter';
import {
  decryptProviderSecrets,
  encryptProviderSecrets,
} from '../persistence/secureFieldAdapter';
import { mergeSyncPayloads } from '../../domain/syncMerge';
import { detectSuspiciousShrink, type ShrinkFinding } from '../../domain/syncGuards';
// Extracted into a plain ESM module so the signature logic is covered by
// the node --test harness (see syncSignature.test.mjs). The previous
// inline implementation only hashed a handful of meta fields and was
// trivially forgeable by a misbehaving adapter; v2 hashes the full meta
// plus a prefix of the ciphertext.
import { createSyncedFileSignature as createSyncedFileSignatureImpl } from './syncSignature.js';
import { decideRemoteChanged } from './syncAnchorDecision.js';

const SYNC_HISTORY_STORAGE_KEY = 'netcatty_sync_history_v1';
const SYNC_REMOTE_ANCHOR_STORAGE_KEY = 'netcatty_sync_remote_anchor_v1';

// ============================================================================
// Types
// ============================================================================

export interface SyncManagerState {
  securityState: SecurityState;
  syncState: SyncState;
  masterKeyConfig: MasterKeyConfig | null;
  unlockedKey: UnlockedMasterKey | null;
  providers: Record<CloudProvider, ProviderConnection>;
  deviceId: string;
  deviceName: string;
  localVersion: number;
  localUpdatedAt: number;
  remoteVersion: number;
  remoteUpdatedAt: number;
  currentConflict: ConflictInfo | null;
  lastError: string | null;
  autoSyncEnabled: boolean;
  autoSyncInterval: number;
  syncHistory: SyncHistoryEntry[];
  /** Last shrink finding that put us into BLOCKED state, retained until
   * a sync actually succeeds (SYNC_COMPLETED with result.success) or
   * `clearShrinkBlockedState()` is called. Renderer hydrates the banner
   * from this on mount so a block that happened off-screen is still
   * visible to the user. */
  lastShrinkFinding?: Extract<ShrinkFinding, { suspicious: true }>;
}

export type SyncEventCallback = (event: SyncEvent) => void;

interface ProviderSyncAnchor {
  signature: string | null;
  version: number;
  updatedAt: number;
  deviceId?: string;
  resourceId?: string | null;
  observedAt: number;
}

// ============================================================================
// CloudSyncManager Class
// ============================================================================

export class CloudSyncManager {
  private state: SyncManagerState;
  private stateSnapshot: SyncManagerState; // Immutable snapshot for useSyncExternalStore
  private adapters: Map<CloudProvider, CloudAdapter> = new Map();
  private eventListeners: Set<SyncEventCallback> = new Set();
  private stateChangeListeners: Set<() => void> = new Set(); // For useSyncExternalStore
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private masterPassword: string | null = null; // In memory only!
  private hasStorageListener = false;
  // Promise that resolves once startup provider secret decryption finishes.
  // Awaited by getConnectedAdapter() to prevent using still-encrypted tokens.
  private decryptionReady: Promise<void>;
  // Per-provider flag: true once that provider's secrets have been
  // successfully decrypted.  When false, getConnectedAdapter() will
  // retry decryption before using the tokens.
  private providerDecrypted: Record<CloudProvider, boolean> = {
    github: false, google: false, onedrive: false, webdav: false, s3: false,
  };
  // Per-provider sequence counters for async decrypt callbacks (startup,
  // cross-window storage events).  Bumped by any state mutation so stale
  // decrypt results are discarded.
  private providerDecryptSeq: Record<CloudProvider, number> = {
    github: 0, google: 0, onedrive: 0, webdav: 0, s3: 0,
  };
  // Per-provider write sequence counters for saveProviderConnection.
  // Only bumped when a new save is initiated, so status-only updates
  // (which don't persist) cannot discard an in-flight encrypted write.
  private providerWriteSeq: Record<CloudProvider, number> = {
    github: 0, google: 0, onedrive: 0, webdav: 0, s3: 0,
  };

  constructor() {
    this.state = this.loadInitialState();
    this.stateSnapshot = { ...this.state };
    this.setupCrossWindowSync();
    // Decrypt provider secrets asynchronously after initial load
    this.decryptionReady = this.initProviderDecryption();
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  private loadInitialState(): SyncManagerState {
    // Load persisted configuration
    const masterKeyConfig = this.loadFromStorage<MasterKeyConfig>(
      SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG
    );

    const deviceId = this.loadFromStorage<string>(SYNC_STORAGE_KEYS.DEVICE_ID)
      || generateDeviceId();

    const deviceName = this.loadFromStorage<string>(SYNC_STORAGE_KEYS.DEVICE_NAME)
      || getDefaultDeviceName();

    const syncConfig = this.loadFromStorage<{
      autoSync: boolean;
      interval: number;
      localVersion: number;
      localUpdatedAt: number;
      remoteVersion: number;
      remoteUpdatedAt: number;
    }>(SYNC_STORAGE_KEYS.SYNC_CONFIG);

    // Load sync history
    const syncHistory = this.loadFromStorage<SyncHistoryEntry[]>(SYNC_HISTORY_STORAGE_KEY) || [];

    // Determine initial security state
    const securityState: SecurityState = masterKeyConfig ? 'LOCKED' : 'NO_KEY';

    // Load provider connections
    const providers: Record<CloudProvider, ProviderConnection> = {
      github: this.loadProviderConnection('github'),
      google: this.loadProviderConnection('google'),
      onedrive: this.loadProviderConnection('onedrive'),
      webdav: this.loadProviderConnection('webdav'),
      s3: this.loadProviderConnection('s3'),
    };

    // Save device ID if new
    this.saveToStorage(SYNC_STORAGE_KEYS.DEVICE_ID, deviceId);
    this.saveToStorage(SYNC_STORAGE_KEYS.DEVICE_NAME, deviceName);

    return {
      securityState,
      syncState: 'IDLE',
      masterKeyConfig,
      unlockedKey: null,
      providers,
      deviceId,
      deviceName,
      localVersion: syncConfig?.localVersion || 0,
      localUpdatedAt: syncConfig?.localUpdatedAt || 0,
      remoteVersion: syncConfig?.remoteVersion || 0,
      remoteUpdatedAt: syncConfig?.remoteUpdatedAt || 0,
      currentConflict: null,
      lastError: null,
      autoSyncEnabled: syncConfig?.autoSync || false,
      autoSyncInterval: syncConfig?.interval || SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL,
      syncHistory,
    };
  }

  private loadProviderConnection(provider: CloudProvider): ProviderConnection {
    const key = SYNC_STORAGE_KEYS[`PROVIDER_${provider.toUpperCase()}` as keyof typeof SYNC_STORAGE_KEYS];
    const stored = this.loadFromStorage<Partial<ProviderConnection>>(key);

    // Determine the correct status: if tokens or config exist, should be 'connected'
    // Never restore 'syncing' or 'error' status - those are transient
    const status: ProviderConnection['status'] = (stored?.tokens || stored?.config)
      ? 'connected'
      : 'disconnected';

    return {
      provider,
      ...stored,
      status, // Must be last to override any stored 'syncing' or 'error' status
    } as ProviderConnection;
  }

  /**
   * Asynchronously decrypt provider connection secrets after initial load.
   * Runs once at construction; decrypted tokens replace the encrypted ones
   * in-memory so adapters can use them.
   */
  private async initProviderDecryption(): Promise<void> {
    const providers: CloudProvider[] = ['github', 'google', 'onedrive', 'webdav', 's3'];
    for (const p of providers) {
      try {
        const conn = this.state.providers[p];
        if (conn.tokens || conn.config) {
          const seq = ++this.providerDecryptSeq[p];
          const decrypted = await decryptProviderSecrets(conn);
          // Only apply if no newer update has occurred during the async gap
          if (seq === this.providerDecryptSeq[p]) {
            this.state.providers[p] = decrypted;
            this.providerDecrypted[p] = true;
          }
        } else {
          // No secrets to decrypt — mark as done
          this.providerDecrypted[p] = true;
        }
      } catch {
        // Decryption failed — likely the Electron IPC handler is not yet
        // registered.  getConnectedAdapter() will retry for this provider.
      }
    }
    this.notifyStateChange();
  }

  private async saveProviderConnection(provider: CloudProvider, connection: ProviderConnection): Promise<void> {
    const key = SYNC_STORAGE_KEYS[`PROVIDER_${provider.toUpperCase()}` as keyof typeof SYNC_STORAGE_KEYS];
    // Use write-specific counter so status-only updates cannot discard
    // an in-flight encrypted write that must be persisted.
    const seq = ++this.providerWriteSeq[provider];
    const encrypted = await encryptProviderSecrets(connection);
    // Only persist if no newer save has started during the async gap
    if (seq === this.providerWriteSeq[provider]) {
      this.saveToStorage(key, encrypted);
    }
  }

  private loadFromStorage<T>(key: string): T | null {
    return localStorageAdapter.read<T>(key);
  }

  private saveToStorage(key: string, value: unknown): void {
    localStorageAdapter.write(key, value);
  }

  private removeFromStorage(key: string): void {
    localStorageAdapter.remove(key);
  }

  // ==========================================================================
  // Cross-window sync (Electron settings window, etc.)
  // ==========================================================================

  private setupCrossWindowSync(): void {
    if (this.hasStorageListener) return;
    if (typeof window === 'undefined') return;

    window.addEventListener('storage', this.handleStorageEvent);
    this.hasStorageListener = true;
  }

  private safeJsonParse<T>(value: string | null): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  private handleStorageEvent = (event: StorageEvent): void => {
    if (event.storageArea !== window.localStorage) return;
    const key = event.key;
    if (!key) return;

    // Handle master key config changes (e.g., when set up in settings window)
    if (key === SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG) {
      const nextConfig = this.safeJsonParse<MasterKeyConfig>(event.newValue);

      if (nextConfig && !this.state.masterKeyConfig) {
        // Master key was set up in another window - update our state
        this.state.masterKeyConfig = nextConfig;
        this.state.securityState = 'LOCKED';
        this.notifyStateChange();
      } else if (!nextConfig && this.state.masterKeyConfig) {
        // Master key was removed in another window
        this.state.masterKeyConfig = null;
        this.state.securityState = 'NO_KEY';
        this.state.unlockedKey = null;
        this.masterPassword = null;
        this.notifyStateChange();
      }
      return;
    }

    // Sync versions + auto-sync settings
    if (key === SYNC_STORAGE_KEYS.SYNC_CONFIG) {
      const next = this.safeJsonParse<{
        autoSync?: boolean;
        interval?: number;
        localVersion?: number;
        localUpdatedAt?: number;
        remoteVersion?: number;
        remoteUpdatedAt?: number;
      }>(event.newValue) || {
        autoSync: false,
        interval: SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL,
        localVersion: 0,
        localUpdatedAt: 0,
        remoteVersion: 0,
        remoteUpdatedAt: 0,
      };

      this.state.autoSyncEnabled = Boolean(next.autoSync);
      this.state.autoSyncInterval = Math.max(
        SYNC_CONSTANTS.MIN_SYNC_INTERVAL,
        Math.min(
          SYNC_CONSTANTS.MAX_SYNC_INTERVAL,
          Number(next.interval ?? SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL)
        )
      );
      this.state.localVersion = Number(next.localVersion ?? 0);
      this.state.localUpdatedAt = Number(next.localUpdatedAt ?? 0);
      this.state.remoteVersion = Number(next.remoteVersion ?? 0);
      this.state.remoteUpdatedAt = Number(next.remoteUpdatedAt ?? 0);

      this.notifyStateChange();
      return;
    }

    // Sync history list
    if (key === SYNC_HISTORY_STORAGE_KEY) {
      const nextHistory = this.safeJsonParse<SyncHistoryEntry[]>(event.newValue) || [];
      this.state.syncHistory = Array.isArray(nextHistory) ? nextHistory : [];
      this.notifyStateChange();
      return;
    }

    // Sync provider connections (connect/disconnect, account, tokens, last sync)
    const providerByKey: Partial<Record<string, CloudProvider>> = {
      [SYNC_STORAGE_KEYS.PROVIDER_GITHUB]: 'github',
      [SYNC_STORAGE_KEYS.PROVIDER_GOOGLE]: 'google',
      [SYNC_STORAGE_KEYS.PROVIDER_ONEDRIVE]: 'onedrive',
      [SYNC_STORAGE_KEYS.PROVIDER_WEBDAV]: 'webdav',
      [SYNC_STORAGE_KEYS.PROVIDER_S3]: 's3',
    };
    const provider = providerByKey[key];
    if (provider) {
      const rawNext = this.loadProviderConnection(provider);
      const seq = ++this.providerDecryptSeq[provider];
      // Also bump write seq so any in-flight save from this window for the
      // same provider is discarded — the cross-window data is newer.
      ++this.providerWriteSeq[provider];

      // Decrypt secrets asynchronously, then update state.
      // Use sequence counter to discard stale results when multiple events
      // for the same provider arrive in quick succession.
      decryptProviderSecrets(rawNext).then((next) => {
        if (seq !== this.providerDecryptSeq[provider]) return; // stale — discard

        const prev = this.state.providers[provider];
        const preserveTransientStatus =
          prev.status === 'connecting' || prev.status === 'syncing';

        this.state.providers[provider] = {
          ...next,
          status: preserveTransientStatus ? prev.status : next.status,
          error: preserveTransientStatus ? prev.error : next.error,
        };

        const nextTokens = next.tokens;
        const nextConfig = next.config;
        const adapter = this.adapters.get(provider);
        if (!nextTokens && !nextConfig) {
          if (adapter) {
            adapter.signOut();
            this.adapters.delete(provider);
          }
          this.notifyStateChange();
          return;
        }

        const tokenChanged =
          (prev.tokens?.accessToken || null) !== (nextTokens?.accessToken || null) ||
          (prev.tokens?.refreshToken || null) !== (nextTokens?.refreshToken || null) ||
          (prev.tokens?.expiresAt || null) !== (nextTokens?.expiresAt || null) ||
          (prev.tokens?.tokenType || null) !== (nextTokens?.tokenType || null) ||
          (prev.tokens?.scope || null) !== (nextTokens?.scope || null);

        const configChanged =
          JSON.stringify(prev.config || null) !== JSON.stringify(nextConfig || null);

        const resourceChanged = (adapter?.resourceId || null) !== (next.resourceId || null);

        if (adapter && (tokenChanged || configChanged || resourceChanged)) {
          adapter.signOut();
          this.adapters.delete(provider);
        }

        this.notifyStateChange();
      }).catch(() => {
        // Decryption failure in cross-window handler is non-fatal
      });
    }
  };

  private async getConnectedAdapter(provider: CloudProvider): Promise<CloudAdapter> {
    // Ensure startup decryption has finished before reading tokens
    await this.decryptionReady;

    // If this provider's secrets were not successfully decrypted at
    // startup (IPC handler not registered yet), retry now.
    if (!this.providerDecrypted[provider]) {
      const conn = this.state.providers[provider];
      if (conn.tokens || conn.config) {
        try {
          const seq = ++this.providerDecryptSeq[provider];
          const decrypted = await decryptProviderSecrets(conn);
          if (seq === this.providerDecryptSeq[provider]) {
            this.state.providers[provider] = decrypted;
            this.providerDecrypted[provider] = true;
            // Evict any adapter cached with the old (encrypted) tokens
            // so a fresh one is built from the decrypted credentials below.
            const stale = this.adapters.get(provider);
            if (stale) {
              stale.signOut();
              this.adapters.delete(provider);
            }
            this.notifyStateChange();
          }
        } catch {
          // Still failing — will surface when adapter tries to use tokens
        }
      }
    }

    const connection = this.state.providers[provider];
    const tokens = connection?.tokens;
    const config = connection?.config;
    if (!tokens && !config) {
      throw new Error('Provider not connected');
    }

    const existing = this.adapters.get(provider);
    if (existing?.isAuthenticated) {
      return existing;
    }

    const adapter = await createAdapter(provider, tokens, connection.resourceId, config);
    this.adapters.set(provider, adapter);
    return adapter;
  }

  // ==========================================================================
  // Event System
  // ==========================================================================

  subscribe(callback: SyncEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Subscribe to state changes for useSyncExternalStore
   * This is a simpler subscription that just notifies when state changes
   */
  subscribeToStateChanges(callback: () => void): () => void {
    this.stateChangeListeners.add(callback);
    return () => this.stateChangeListeners.delete(callback);
  }

  private emit(event: SyncEvent): void {
    // Update snapshot and notify state change listeners first
    this.notifyStateChange();
    // Then notify event listeners
    this.eventListeners.forEach(cb => cb(event));
  }

  /**
   * Notify all state change listeners and update snapshot
   * Call this after any state mutation
   * Uses deep clone to ensure React detects changes in nested objects
   */
  private notifyStateChange(): void {
    // Deep clone the state to ensure all nested objects are new references
    this.stateSnapshot = {
      ...this.state,
      providers: {
        github: { ...this.state.providers.github },
        google: { ...this.state.providers.google },
        onedrive: { ...this.state.providers.onedrive },
        webdav: { ...this.state.providers.webdav },
        s3: { ...this.state.providers.s3 },
      },
      syncHistory: [...this.state.syncHistory],
      currentConflict: this.state.currentConflict ? { ...this.state.currentConflict } : null,
    };
    this.stateChangeListeners.forEach(cb => cb());
  }

  // ==========================================================================
  // Public API - State Accessors
  // ==========================================================================

  getState(): Readonly<SyncManagerState> {
    return this.stateSnapshot;
  }

  getAdapter(provider: CloudProvider): CloudAdapter | undefined {
    return this.adapters.get(provider);
  }

  getSecurityState(): SecurityState {
    return this.state.securityState;
  }

  getSyncState(): SyncState {
    return this.state.syncState;
  }

  getProviderConnection(provider: CloudProvider): ProviderConnection {
    return { ...this.state.providers[provider] };
  }

  getAllProviders(): Record<CloudProvider, ProviderConnection> {
    return { ...this.state.providers };
  }

  getCurrentConflict(): ConflictInfo | null {
    return this.state.currentConflict;
  }

  isUnlocked(): boolean {
    return this.state.securityState === 'UNLOCKED';
  }

  // ==========================================================================
  // Master Key Management
  // ==========================================================================

  /**
   * Set up a new master key (first time setup)
   */
  async setupMasterKey(password: string): Promise<void> {
    if (this.state.masterKeyConfig) {
      throw new Error('Master key already exists. Use changeMasterKey instead.');
    }

    const config = await EncryptionService.createMasterKeyConfig(password);

    this.state.masterKeyConfig = config;
    this.state.securityState = 'LOCKED';

    this.saveToStorage(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, config);
    this.emit({ type: 'SECURITY_STATE_CHANGED', state: 'LOCKED' });

    // Auto-unlock after setup
    await this.unlock(password);
  }

  /**
   * Unlock the vault with master password
   */
  async unlock(password: string): Promise<boolean> {
    if (!this.state.masterKeyConfig) {
      throw new Error('No master key configured');
    }

    if (this.state.securityState === 'UNLOCKED') {
      return true;
    }

    const unlockedKey = await EncryptionService.unlockMasterKey(
      password,
      this.state.masterKeyConfig
    );

    if (!unlockedKey) {
      return false;
    }

    this.state.unlockedKey = unlockedKey;
    this.state.securityState = 'UNLOCKED';
    this.masterPassword = password;

    this.emit({ type: 'SECURITY_STATE_CHANGED', state: 'UNLOCKED' });

    // Start auto-sync if enabled
    if (this.state.autoSyncEnabled) {
      this.startAutoSync();
    }

    return true;
  }

  /**
   * Lock the vault
   */
  lock(): void {
    if (this.state.securityState !== 'UNLOCKED') {
      return;
    }

    // Clear sensitive data from memory
    this.state.unlockedKey = null;
    this.masterPassword = null;
    this.state.securityState = 'LOCKED';

    // Stop auto-sync
    this.stopAutoSync();

    this.emit({ type: 'SECURITY_STATE_CHANGED', state: 'LOCKED' });
  }

  /**
   * Change master password
   */
  async changeMasterKey(oldPassword: string, newPassword: string): Promise<boolean> {
    if (!this.state.masterKeyConfig) {
      throw new Error('No master key configured');
    }

    const newConfig = await EncryptionService.changeMasterPassword(
      oldPassword,
      newPassword,
      this.state.masterKeyConfig
    );

    if (!newConfig) {
      return false;
    }

    this.state.masterKeyConfig = newConfig;
    this.state.securityState = 'UNLOCKED';
    this.masterPassword = newPassword;

    // Re-derive key with new password
    this.state.unlockedKey = await EncryptionService.unlockMasterKey(
      newPassword,
      newConfig
    );

    this.saveToStorage(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, newConfig);

    // Notify UI and restart auto-sync (actual re-upload requires a payload from app state)
    this.emit({ type: 'SECURITY_STATE_CHANGED', state: 'UNLOCKED' });
    if (this.state.autoSyncEnabled) {
      this.startAutoSync();
    }

    return true;
  }

  /**
   * Verify if a password is correct
   */
  async verifyPassword(password: string): Promise<boolean> {
    if (!this.state.masterKeyConfig) {
      return false;
    }
    return EncryptionService.verifyPassword(password, this.state.masterKeyConfig);
  }

  // ==========================================================================
  // Provider Authentication
  // ==========================================================================

  /**
   * Start authentication flow for a provider
   * Returns data needed for the auth flow (device code for GitHub, URL for others)
   */
  async startProviderAuth(provider: CloudProvider): Promise<{
    type: 'device_code' | 'url';
    data: unknown;
  }> {
    if (provider === 'webdav' || provider === 's3') {
      throw new Error('Provider requires manual configuration');
    }
    const adapter = await createAdapter(provider);
    this.adapters.set(provider, adapter);

    this.updateProviderStatus(provider, 'connecting');
    try {
      if (provider === 'github') {
        // GitHub uses Device Flow
        const ghAdapter = adapter as GitHubAdapter;
        const deviceFlow = await ghAdapter.startAuth();

        return {
          type: 'device_code',
          data: deviceFlow,
        };
      } else {
        // Google and OneDrive use PKCE with redirect
        const redirectUri = 'http://127.0.0.1:45678/oauth/callback';

        if (provider === 'google') {
          const gdAdapter = adapter as GoogleDriveAdapter;
          const url = await gdAdapter.startAuth(redirectUri);
          return { type: 'url', data: { url, redirectUri } };
        } else {
          const odAdapter = adapter as OneDriveAdapter;
          const url = await odAdapter.startAuth(redirectUri);
          return { type: 'url', data: { url, redirectUri } };
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CloudSync] ${provider} connect failed`, {
        error: errorMessage,
      });
      this.updateProviderStatus(provider, 'error', errorMessage);
      throw error;
    }
  }

  /**
   * Complete GitHub Device Flow authentication
   */
  async completeGitHubAuth(
    deviceCode: string,
    interval: number,
    expiresAt: number,
    onPending?: () => void
  ): Promise<void> {
    const adapter = this.adapters.get('github');
    if (!adapter) {
      throw new Error('GitHub adapter not initialized');
    }

    const ghAdapter = adapter as GitHubAdapter;

    try {
      // Snapshot the prior account BEFORE we overwrite providers[provider].
      // Used as a fallback for the same-account comparison when the persisted
      // accountId key is absent (e.g., first re-auth after upgrading to this
      // version, where the key didn't exist yet).
      const previousAccount = this.state.providers.github?.account;

      const tokens = await ghAdapter.completeAuth(deviceCode, interval, expiresAt, onPending);

      ++this.providerDecryptSeq.github;
      this.state.providers.github = {
        ...this.state.providers.github,
        status: 'connected',
        tokens,
        account: ghAdapter.accountInfo || undefined,
      };

      // Initialize sync (find or create gist)
      const resourceId = await ghAdapter.initializeSync();
      if (resourceId) {
        this.state.providers.github.resourceId = resourceId;
      }

      await this.saveProviderConnection('github', this.state.providers.github);

      // Only clear the merge base if the authenticated account identity differs
      // from the previously-stored one. See notes in completePKCEAuth.
      const newId = ghAdapter.accountInfo?.id ?? null;
      const previousId = this.loadProviderAccountId('github') ?? previousAccount?.id ?? null;
      const sameAccount = newId !== null && previousId !== null && newId === previousId;
      if (!sameAccount) {
        this.removeFromStorage(this.syncBaseKey('github'));
        this.clearSyncAnchor('github');
      }
      if (newId) {
        this.saveProviderAccountId('github', newId);
      }

      this.emit({
        type: 'AUTH_COMPLETED',
        provider: 'github',
        account: ghAdapter.accountInfo!,
      });
    } catch (error) {
      this.updateProviderStatus('github', 'error', String(error));
      throw error;
    }
  }

  /**
   * Complete PKCE OAuth flow (Google/OneDrive)
   */
  async completePKCEAuth(
    provider: 'google' | 'onedrive',
    code: string,
    redirectUri: string
  ): Promise<void> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`${provider} adapter not initialized`);
    }

    try {
      // Snapshot the prior account BEFORE we overwrite providers[provider].
      // Used as a fallback for the same-account comparison when the persisted
      // accountId key is absent (e.g., first re-auth after upgrading to this
      // version, where the key didn't exist yet).
      const previousAccount = this.state.providers[provider]?.account;

      let tokens: OAuthTokens;
      let account;

      if (provider === 'google') {
        const gdAdapter = adapter as GoogleDriveAdapter;
        tokens = await gdAdapter.completeAuth(code, redirectUri);
        account = gdAdapter.accountInfo;
      } else {
        const odAdapter = adapter as OneDriveAdapter;
        tokens = await odAdapter.completeAuth(code, redirectUri);
        account = odAdapter.accountInfo;
      }

      ++this.providerDecryptSeq[provider];
      this.state.providers[provider] = {
        ...this.state.providers[provider],
        status: 'connected',
        tokens,
        account: account || undefined,
      };

      // Initialize sync
      const resourceId = await adapter.initializeSync();
      if (resourceId) {
        this.state.providers[provider].resourceId = resourceId;
      }

      await this.saveProviderConnection(provider, this.state.providers[provider]);

      // Only clear the merge base if the authenticated account identity differs
      // from the previously-stored one. Same-account re-auth preserves the base
      // so the next sync computes correct local-deletions instead of treating
      // it as "first sync" and resurrecting zombie entries via null-base union.
      const newId = account?.id ?? null;
      const previousId = this.loadProviderAccountId(provider) ?? previousAccount?.id ?? null;
      const sameAccount = newId !== null && previousId !== null && newId === previousId;
      if (!sameAccount) {
        this.removeFromStorage(this.syncBaseKey(provider));
        this.clearSyncAnchor(provider);
      }
      if (newId) {
        this.saveProviderAccountId(provider, newId);
      }

      this.emit({
        type: 'AUTH_COMPLETED',
        provider,
        account: account!,
      });
    } catch (error) {
      this.updateProviderStatus(provider, 'error', String(error));
      throw error;
    }
  }

  /**
   * Connect config-based providers (WebDAV/S3)
   */
  async connectConfigProvider(
    provider: 'webdav' | 's3',
    config: WebDAVConfig | S3Config
  ): Promise<void> {
    const adapter = await createAdapter(provider, undefined, undefined, config);
    this.adapters.set(provider, adapter);
    this.updateProviderStatus(provider, 'connecting');

    try {
      const resourceId = await adapter.initializeSync();
      const account = adapter.accountInfo || this.buildAccountFromConfig(provider, config);

      ++this.providerDecryptSeq[provider];
      this.state.providers[provider] = {
        provider,
        status: 'connected',
        config,
        account,
        resourceId: resourceId || undefined,
      };

      await this.saveProviderConnection(provider, this.state.providers[provider]);
      // Clear merge base when (re)configuring to a different endpoint/bucket
      this.removeFromStorage(this.syncBaseKey(provider));
      this.clearSyncAnchor(provider);
      this.emit({
        type: 'AUTH_COMPLETED',
        provider,
        account,
      });
    } catch (error) {
      this.updateProviderStatus(provider, 'error', String(error));
      throw error;
    }
  }

  /**
   * Reset provider status to disconnected without tearing down existing connections.
   * Used when an auth attempt is cancelled/fails — avoids destroying a previously
   * working connection if the user was re-authenticating.
   */
  resetProviderStatus(provider: CloudProvider): void {
    // Only reset if currently 'connecting' — don't drop an already authenticated
    // provider back to 'disconnected' (e.g., if auth succeeded but sync init failed).
    if (this.state.providers[provider]?.status === 'connecting') {
      this.updateProviderStatus(provider, 'disconnected');
    }
  }

  /**
   * Disconnect a provider
   */
  async disconnectProvider(provider: CloudProvider): Promise<void> {
    const adapter = this.adapters.get(provider);
    if (adapter) {
      adapter.signOut();
      this.adapters.delete(provider);
    }

    ++this.providerDecryptSeq[provider];
    this.state.providers[provider] = {
      provider,
      status: 'disconnected',
    };

    await this.saveProviderConnection(provider, this.state.providers[provider]);
    // Clear the merge base for this provider so reconnecting to a different
    // account/resource doesn't reuse an unrelated snapshot
    this.removeFromStorage(this.syncBaseKey(provider));
    this.clearSyncAnchor(provider);
    this.removeFromStorage(this.providerAccountIdKey(provider));
    // Reset BLOCKED state if it was present — disconnect implicitly resolves
    // any pending shrink-block warning since there's no provider to push to.
    this.exitBlockedState();
    if (this.state.syncState === 'BLOCKED') {
      this.state.syncState = 'IDLE';
    }
    this.notifyStateChange(); // Ensure UI updates immediately after disconnect
  }

  private updateProviderStatus(
    provider: CloudProvider,
    status: ProviderConnection['status'],
    error?: string
  ): void {
    // Bump sequence to invalidate any in-flight async decrypt for this provider
    ++this.providerDecryptSeq[provider];
    this.state.providers[provider] = {
      ...this.state.providers[provider],
      status,
      error,
    };
    this.notifyStateChange(); // Notify UI of status change
  }

  private buildAccountFromConfig(
    provider: 'webdav' | 's3',
    config: WebDAVConfig | S3Config
  ): ProviderAccount {
    if (provider === 'webdav') {
      const endpoint = (config as WebDAVConfig).endpoint;
      return { id: endpoint, name: endpoint };
    }
    const s3 = config as S3Config;
    return { id: `${s3.bucket}@${s3.endpoint}`, name: `${s3.bucket} (${s3.region})` };
  }

  // ==========================================================================
  // Sync Operations
  // ==========================================================================

  private syncAnchorKey(provider: CloudProvider): string {
    return `${SYNC_REMOTE_ANCHOR_STORAGE_KEY}_${provider}`;
  }

  private createSyncedFileSignature(syncedFile: SyncedFile | null): Promise<string | null> {
    return createSyncedFileSignatureImpl(syncedFile);
  }

  private loadSyncAnchor(provider: CloudProvider): ProviderSyncAnchor | null {
    return this.loadFromStorage<ProviderSyncAnchor>(this.syncAnchorKey(provider));
  }

  private async saveSyncAnchor(
    provider: CloudProvider,
    syncedFile: SyncedFile | null,
    resourceId?: string | null,
  ): Promise<void> {
    this.saveToStorage(this.syncAnchorKey(provider), {
      signature: await this.createSyncedFileSignature(syncedFile),
      version: syncedFile?.meta.version ?? 0,
      updatedAt: syncedFile?.meta.updatedAt ?? 0,
      deviceId: syncedFile?.meta.deviceId,
      resourceId: resourceId ?? this.state.providers[provider].resourceId ?? null,
      observedAt: Date.now(),
    } satisfies ProviderSyncAnchor);
  }

  private clearSyncAnchor(provider?: CloudProvider): void {
    if (provider) {
      this.removeFromStorage(this.syncAnchorKey(provider));
      return;
    }
    for (const p of ['github', 'google', 'onedrive', 'webdav', 's3'] as const) {
      this.removeFromStorage(this.syncAnchorKey(p));
    }
  }

  private async inspectProviderRemoteState(
    provider: CloudProvider,
    adapter: CloudAdapter,
  ): Promise<{
    remoteChanged: boolean;
    remoteFile: SyncedFile | null;
    error?: string;
  }> {
    try {
      const remoteFile = await adapter.download();
      const currentSignature = await this.createSyncedFileSignature(remoteFile);
      const anchor = this.loadSyncAnchor(provider);
      const currentResourceId = adapter.resourceId || this.state.providers[provider].resourceId || null;

      const decision = decideRemoteChanged({
        currentSignature,
        currentResourceId,
        anchor,
        hasRemoteFile: Boolean(remoteFile),
      });

      return {
        remoteChanged: decision.remoteChanged,
        remoteFile,
      };
    } catch (error) {
      return {
        remoteChanged: false,
        remoteFile: null,
        error: String(error),
      };
    }
  }

  /**
   * Helper: Check for conflicts with a specific provider
   *
   * Fails closed on inspection error: throws rather than returning a
   * `{conflict: false, error}` tuple. The previous return-shape let
   * `syncAll`'s `validUploads` filter — which checks `!r.error` (the
   * outer per-provider try/catch error) and `!r.check?.conflict` but
   * NOT `r.check?.error` — admit this provider into the upload batch
   * with `conflict: false`, which then proceeded to upload stale local
   * data over the remote (the exact #711/#719 failure mode on a
   * transient download 5xx). Throwing surfaces the failure through the
   * same per-provider try/catch that already handles connection errors.
   */
  private async checkProviderConflict(
    provider: CloudProvider,
    adapter: CloudAdapter
  ): Promise<{
    conflict: boolean;
    remoteFile?: SyncedFile;
  }> {
    const inspection = await this.inspectProviderRemoteState(provider, adapter);
    if (inspection.error) {
      throw new Error(inspection.error);
    }
    return {
      conflict: inspection.remoteChanged && Boolean(inspection.remoteFile),
      remoteFile: inspection.remoteFile ?? undefined,
    };
  }

  async inspectProviderRemote(provider: CloudProvider): Promise<{
    remoteChanged: boolean;
    remoteFile: SyncedFile | null;
    payload: SyncPayload | null;
  }> {
    if (this.state.securityState !== 'UNLOCKED' || !this.masterPassword) {
      throw new Error('Vault is locked');
    }

    const adapter = await this.getConnectedAdapter(provider);
    const inspection = await this.inspectProviderRemoteState(provider, adapter);
    if (inspection.error) {
      throw new Error(inspection.error);
    }

    if (!inspection.remoteFile) {
      return {
        remoteChanged: inspection.remoteChanged,
        remoteFile: null,
        payload: null,
      };
    }

    return {
      remoteChanged: inspection.remoteChanged,
      remoteFile: inspection.remoteFile,
      payload: await EncryptionService.decryptPayload(inspection.remoteFile, this.masterPassword),
    };
  }

  async commitRemoteInspection(
    provider: CloudProvider,
    remoteFile: SyncedFile,
    payload: SyncPayload,
  ): Promise<void> {
    const adapter = await this.getConnectedAdapter(provider);
    const resourceId = adapter.resourceId || this.state.providers[provider].resourceId || null;
    if (resourceId && this.state.providers[provider].resourceId !== resourceId) {
      ++this.providerDecryptSeq[provider];
      this.state.providers[provider] = {
        ...this.state.providers[provider],
        resourceId,
      };
    }

    this.state.localVersion = remoteFile.meta.version;
    this.state.localUpdatedAt = remoteFile.meta.updatedAt;
    this.state.remoteVersion = remoteFile.meta.version;
    this.state.remoteUpdatedAt = remoteFile.meta.updatedAt;
    this.state.providers[provider].lastSync = Date.now();
    this.state.providers[provider].lastSyncVersion = remoteFile.meta.version;

    this.saveSyncConfig();
    await this.saveSyncAnchor(provider, remoteFile, resourceId);
    await this.saveSyncBase(payload, provider);
    await this.saveProviderConnection(provider, this.state.providers[provider]);
    this.notifyStateChange();
  }

  /**
   * Helper: Upload encrypted file to a provider
   *
   * `payloadForBase`, when supplied, is persisted as the new sync base
   * BEFORE the anchor is advanced. Ordering matters: if the renderer
   * crashes between the two writes, the next startup's inspect must
   * either (a) see no anchor advance and re-merge against the fresh
   * base, or (b) see both advanced consistently. The previous ordering
   * (anchor before base) allowed a crash window where the next run
   * saw "remote unchanged" (anchor matched) but silently kept a stale
   * base, so a subsequent 3-way merge could misclassify entries that
   * landed in this upload.
   */
  private async uploadToProvider(
    provider: CloudProvider,
    adapter: CloudAdapter,
    syncedFile: SyncedFile,
    payloadForBase?: SyncPayload,
  ): Promise<SyncResult> {
    try {
      const resourceId = await adapter.upload(syncedFile);
      this.state.lastError = null;

      // Update local state (safe to do multiple times if values are same)
      this.state.localVersion = syncedFile.meta.version;
      this.state.localUpdatedAt = syncedFile.meta.updatedAt;
      this.state.remoteVersion = syncedFile.meta.version;
      this.state.remoteUpdatedAt = syncedFile.meta.updatedAt;
      // Invalidate any pending provider decrypt so it cannot overwrite
      // the lastSync/lastSyncVersion we are about to set.
      ++this.providerDecryptSeq[provider];
      this.state.providers[provider] = {
        ...this.state.providers[provider],
        resourceId: resourceId || this.state.providers[provider].resourceId,
        lastSync: Date.now(),
        lastSyncVersion: syncedFile.meta.version,
      };

      this.saveSyncConfig();
      // Persist base BEFORE anchor so a crash between them degrades
      // safely: the stale anchor forces re-inspection next run, which
      // merges against the fresh base and cannot silently drift.
      if (payloadForBase) {
        await this.saveSyncBase(payloadForBase, provider);
      }
      await this.saveSyncAnchor(provider, syncedFile, resourceId);
      await this.saveProviderConnection(provider, this.state.providers[provider]);
      this.notifyStateChange();

      // Add to sync history
      this.addSyncHistoryEntry({
        timestamp: Date.now(),
        provider,
        action: 'upload',
        success: true,
        localVersion: syncedFile.meta.version,
        remoteVersion: syncedFile.meta.version,
        deviceName: this.state.deviceName,
      });

      this.updateProviderStatus(provider, 'connected');

      const result: SyncResult = {
        success: true,
        provider,
        action: 'upload',
        version: syncedFile.meta.version,
      };

      this.emit({ type: 'SYNC_COMPLETED', provider, result });
      return result;
    } catch (error) {
      this.state.lastError = String(error);
      this.updateProviderStatus(provider, 'error', String(error));

      // Add to sync history
      this.addSyncHistoryEntry({
        timestamp: Date.now(),
        provider,
        action: 'upload',
        success: false,
        localVersion: this.state.localVersion,
        deviceName: this.state.deviceName,
        error: String(error),
      });

      this.emit({ type: 'SYNC_ERROR', provider, error: String(error) });

      return {
        success: false,
        provider,
        action: 'none',
        error: String(error),
      };
    }
  }

  /**
   * Build sync payload from current app state
   */
  buildPayload(data: {
    hosts: SyncPayload['hosts'];
    keys: SyncPayload['keys'];
    snippets: SyncPayload['snippets'];
    customGroups: SyncPayload['customGroups'];
    snippetPackages?: SyncPayload['snippetPackages'];
    portForwardingRules?: SyncPayload['portForwardingRules'];
    knownHosts?: SyncPayload['knownHosts'];
    settings?: SyncPayload['settings'];
  }): SyncPayload {
    return {
      ...data,
      syncedAt: Date.now(),
    };
  }

  /**
   * Sync to a specific provider
   */
  async syncToProvider(
    provider: CloudProvider,
    payload: SyncPayload,
    opts: { overrideShrink?: boolean } = {},
  ): Promise<SyncResult> {
    if (this.state.securityState !== 'UNLOCKED') {
      return {
        success: false,
        provider,
        action: 'none',
        error: 'Vault is locked',
      };
    }

    if (!this.masterPassword) {
      return {
        success: false,
        provider,
        action: 'none',
        error: 'Master password not available',
      };
    }

    const overrideShrinkRequested = opts.overrideShrink === true;

    let adapter: CloudAdapter;
    try {
      adapter = await this.getConnectedAdapter(provider);
    } catch {
      return {
        success: false,
        provider,
        action: 'none',
        error: 'Provider not connected',
      };
    }

    this.updateProviderStatus(provider, 'syncing');
    this.state.lastError = null;
    this.state.syncState = 'SYNCING';
    this.emit({ type: 'SYNC_STARTED', provider });

    try {
      // 1. Check for conflict. `checkProviderConflict` throws on
      // inspect failure, which the outer try/catch routes to the
      // SYNC_ERROR path — so we never reach the upload branch with an
      // unknown remote state.
      const checkResult = await this.checkProviderConflict(provider, adapter);

      if (checkResult.conflict && checkResult.remoteFile) {
        // Remote is newer — attempt three-way merge instead of blocking
        try {
          let remotePayload: SyncPayload;
          try {
            remotePayload = await EncryptionService.decryptPayload(
              checkResult.remoteFile,
              this.masterPassword,
            );
          } catch (decryptError) {
            throw new Error(`Decryption failed (master password may differ between devices): ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
          }
          const base = await this.loadSyncBase(provider);
          const mergeResult = mergeSyncPayloads(base, payload, remotePayload);

          console.info('[CloudSyncManager] Three-way merge completed', mergeResult.summary);

          // Shrink guard: refuse to push a merged payload that silently deletes
          // entities we still have in base. The merge itself is correct if local
          // state is trustworthy — but a degraded local (keychain failure,
          // partial load) can make merge produce a smaller-than-expected result.
          const mergedShrink = detectSuspiciousShrink(mergeResult.payload, base);
          const shouldBlockMerged = mergedShrink.suspicious && !overrideShrinkRequested;
          const shouldForceMerged = mergedShrink.suspicious && overrideShrinkRequested;
          if (shouldBlockMerged) {
            this.state.syncState = 'BLOCKED';
            this.state.lastShrinkFinding = mergedShrink;
            this.emit({ type: 'SYNC_BLOCKED_SHRINK', provider, finding: mergedShrink });
            this.updateProviderStatus(provider, 'error', 'Sync blocked: would delete too much');
            return {
              success: false,
              provider,
              action: 'none',
              shrinkBlocked: true,
              finding: mergedShrink,
            };
          }
          if (shouldForceMerged) {
            this.emit({ type: 'SYNC_FORCED', provider, finding: mergedShrink });
          }

          // Encrypt and upload merged payload
          const mergedSyncedFile = await EncryptionService.encryptPayload(
            mergeResult.payload,
            this.masterPassword,
            this.state.deviceId,
            this.state.deviceName,
            packageJson.version,
            checkResult.remoteFile.meta.version, // base on remote version
          );

          const uploadResult = await this.uploadToProvider(
            provider,
            adapter,
            mergedSyncedFile,
            mergeResult.payload,
          );

          if (uploadResult.success) {
            // Base was persisted inside uploadToProvider before the
            // anchor advanced, so a crash between them cannot leave a
            // stale base pointing at pre-merge state.
            this.exitBlockedState();
            this.state.syncState = 'IDLE';

            this.addSyncHistoryEntry({
              timestamp: Date.now(),
              provider,
              action: 'merge',
              success: true,
              localVersion: mergedSyncedFile.meta.version,
              remoteVersion: checkResult.remoteFile.meta.version,
              deviceName: this.state.deviceName,
            });

            return {
              ...uploadResult,
              action: 'merge',
              mergedPayload: mergeResult.payload,
            };
          }

          // Upload after merge failed — set ERROR so sync isn't stuck in SYNCING
          this.state.syncState = 'ERROR';
          this.state.lastError = uploadResult.error || 'Upload failed after merge';
          return uploadResult;
        } catch (mergeError) {
          // Merge failed — fall back to conflict UI
          console.error('[CloudSyncManager] Merge failed, falling back to conflict UI', mergeError);
          const remoteFile = checkResult.remoteFile;
          this.state.syncState = 'CONFLICT';
          this.state.currentConflict = {
            provider,
            localVersion: this.state.localVersion,
            localUpdatedAt: this.state.localUpdatedAt,
            localDeviceName: this.state.deviceName,
            remoteVersion: remoteFile.meta.version,
            remoteUpdatedAt: remoteFile.meta.updatedAt,
            remoteDeviceName: remoteFile.meta.deviceName,
          };

          this.emit({
            type: 'CONFLICT_DETECTED',
            conflict: this.state.currentConflict,
          });

          return {
            success: false,
            provider,
            action: 'none',
            conflictDetected: true,
          };
        }
      }

      // Shrink guard (no-conflict path): same rationale as the merge branch —
      // refuse a payload that drops entities versus the stored base.
      const directBase = await this.loadSyncBase(provider);
      const directShrink = detectSuspiciousShrink(payload, directBase);
      const shouldBlockDirect = directShrink.suspicious && !overrideShrinkRequested;
      const shouldForceDirect = directShrink.suspicious && overrideShrinkRequested;
      if (shouldBlockDirect) {
        this.state.syncState = 'BLOCKED';
        this.state.lastShrinkFinding = directShrink;
        this.emit({ type: 'SYNC_BLOCKED_SHRINK', provider, finding: directShrink });
        this.updateProviderStatus(provider, 'error', 'Sync blocked: would delete too much');
        return {
          success: false,
          provider,
          action: 'none',
          shrinkBlocked: true,
          finding: directShrink,
        };
      }
      if (shouldForceDirect) {
        this.emit({ type: 'SYNC_FORCED', provider, finding: directShrink });
      }

      // 2. Encrypt
      const syncedFile = await EncryptionService.encryptPayload(
        payload,
        this.masterPassword,
        this.state.deviceId,
        this.state.deviceName,
        packageJson.version,
        this.state.localVersion
      );

      // 3. Upload — base is persisted inside uploadToProvider before
      // the anchor advances so a crash between them cannot leave the
      // base pointing at a pre-upload snapshot.
      const result = await this.uploadToProvider(provider, adapter, syncedFile, payload);

      if (result.success) {
        this.exitBlockedState();
        this.state.syncState = 'IDLE';
        this.state.lastShrinkFinding = undefined;
      } else {
        this.state.syncState = 'ERROR';
        if (result.error) {
          this.state.lastError = result.error;
        }
      }
      return result;

    } catch (error) {
      this.state.syncState = 'ERROR';
      this.state.lastError = String(error);
      this.updateProviderStatus(provider, 'error', String(error));

      // Add to sync history
      this.addSyncHistoryEntry({
        timestamp: Date.now(),
        provider,
        action: 'upload',
        success: false,
        localVersion: this.state.localVersion,
        deviceName: this.state.deviceName,
        error: String(error),
      });

      this.emit({ type: 'SYNC_ERROR', provider, error: String(error) });

      return {
        success: false,
        provider,
        action: 'none',
        error: String(error),
      };
    }
  }

  /**
   * Download and apply data from a provider
   */
  async downloadFromProvider(provider: CloudProvider): Promise<SyncPayload | null> {
    if (this.state.securityState !== 'UNLOCKED' || !this.masterPassword) {
      throw new Error('Vault is locked');
    }

    const adapter = await this.getConnectedAdapter(provider);

    try {
      let remoteFile: SyncedFile | null;
      try {
        remoteFile = await adapter.download();
      } catch (downloadError) {
        throw new Error(`Download failed: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
      }
      if (!remoteFile) {
        return null;
      }

      // Decrypt
      let payload: SyncPayload;
      try {
        payload = await EncryptionService.decryptPayload(remoteFile, this.masterPassword);
      } catch (decryptError) {
        throw new Error(`Decryption failed (master password may differ between devices): ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
      }

      await this.commitRemoteInspection(provider, remoteFile, payload);

      // Add to sync history
      this.addSyncHistoryEntry({
        timestamp: Date.now(),
        provider,
        action: 'download',
        success: true,
        localVersion: remoteFile.meta.version,
        remoteVersion: remoteFile.meta.version,
        deviceName: remoteFile.meta.deviceName,
      });

      return payload;
    } catch (error) {
      // Add to sync history
      this.addSyncHistoryEntry({
        timestamp: Date.now(),
        provider,
        action: 'download',
        success: false,
        localVersion: this.state.localVersion,
        error: String(error),
      });
      throw error;
    }
  }

  // ========================================================================
  // Gist Revision History (#679)
  // ========================================================================

  /**
   * Get the GitHub Gist revision history. Returns an array of
   * `{ version (SHA), date }` entries, newest first.
   */
  async getGistRevisionHistory(): Promise<Array<{ version: string; date: Date }>> {
    let adapter: import('./adapters/GitHubAdapter').default;
    try {
      adapter = await this.getConnectedAdapter('github') as import('./adapters/GitHubAdapter').default;
    } catch {
      return [];
    }
    if (!adapter.getHistory) return [];
    return adapter.getHistory();
  }

  /**
   * Download and decrypt a specific historical Gist revision.
   * Returns a structured preview (entity counts) plus the full
   * SyncPayload so the caller can offer a one-click restore.
   *
   * Throws if the revision cannot be decrypted (e.g. encrypted with a
   * different master password).
   */
  async downloadGistRevision(sha: string): Promise<{
    payload: SyncPayload;
    meta: import('../../domain/sync').SyncFileMeta;
    preview: {
      hostCount: number;
      keyCount: number;
      snippetCount: number;
      identityCount: number;
      portForwardingRuleCount: number;
    };
  } | null> {
    if (this.state.securityState !== 'UNLOCKED' || !this.masterPassword) {
      throw new Error('Vault is locked');
    }
    let adapter: import('./adapters/GitHubAdapter').default;
    try {
      adapter = await this.getConnectedAdapter('github') as import('./adapters/GitHubAdapter').default;
    } catch {
      throw new Error('GitHub adapter not available');
    }
    if (!adapter.downloadRevision) throw new Error('GitHub adapter not available');
    const syncedFile = await adapter.downloadRevision(sha);
    if (!syncedFile) return null;

    const payload = await EncryptionService.decryptPayload(syncedFile, this.masterPassword);
    return {
      payload,
      meta: syncedFile.meta,
      preview: {
        hostCount: payload.hosts?.length ?? 0,
        keyCount: payload.keys?.length ?? 0,
        snippetCount: payload.snippets?.length ?? 0,
        identityCount: payload.identities?.length ?? 0,
        portForwardingRuleCount: payload.portForwardingRules?.length ?? 0,
      },
    };
  }

  /**
   * Resolve a sync conflict
   */
  async resolveConflict(resolution: ConflictResolution): Promise<SyncPayload | null> {
    if (!this.state.currentConflict) {
      throw new Error('No conflict to resolve');
    }

    const { provider } = this.state.currentConflict;
    this.emit({ type: 'CONFLICT_RESOLVED', resolution });

    if (resolution === 'USE_REMOTE') {
      // Download and return remote data
      const payload = await this.downloadFromProvider(provider);
      this.state.currentConflict = null;
      this.exitBlockedState();
      this.state.syncState = 'IDLE';
      this.notifyStateChange(); // Notify UI of conflict resolution
      return payload;
    } else {
      // USE_LOCAL - just clear conflict, caller will re-sync
      this.state.currentConflict = null;
      this.exitBlockedState();
      this.state.syncState = 'IDLE';
      this.notifyStateChange(); // Notify UI of conflict resolution
      return null;
    }
  }

  /**
   * Side-effect helper: called BEFORE any syncState assignment that transitions
   * away from BLOCKED. Clears lastShrinkFinding and emits SYNC_BLOCKED_CLEARED
   * so the UI banner (and any other subscriber) gets a single, authoritative
   * "block resolved" signal. The guard on syncState === 'BLOCKED' makes it safe
   * to call unconditionally at every non-BLOCKED assignment site — it no-ops
   * when the state was already non-BLOCKED.
   */
  private exitBlockedState(): void {
    if (this.state.syncState === 'BLOCKED') {
      this.state.lastShrinkFinding = undefined;
      this.emit({ type: 'SYNC_BLOCKED_CLEARED' });
    }
  }

  /**
   * Reset BLOCKED back to IDLE without going through a successful sync.
   * Used by post-merge round-trip to avoid wedging the manager in BLOCKED
   * when the merge already produced safe local state and the round-trip
   * push is just an optimization.
   */
  clearShrinkBlockedState(): void {
    if (this.state.syncState === 'BLOCKED') {
      this.exitBlockedState();
      this.state.syncState = 'IDLE';
      this.notifyStateChange();
    }
  }

  /**
   * Returns the last shrink finding that triggered BLOCKED state, or
   * null if not currently blocked. Used by the renderer to hydrate the
   * SyncBlockedBanner when opening Settings after a block happened
   * off-screen.
   */
  getShrinkBlockedFinding(): Extract<ShrinkFinding, { suspicious: true }> | null {
    if (this.state.syncState !== 'BLOCKED') return null;
    return this.state.lastShrinkFinding ?? null;
  }

  /**
   * Sync to all connected providers
   */
  async syncAllProviders(
    inputPayload?: SyncPayload,
    opts: { overrideShrink?: boolean } = {},
  ): Promise<Map<CloudProvider, SyncResult>> {
    const results = new Map<CloudProvider, SyncResult>();
    let payload = inputPayload;
    let wasMerged = false;

    const overrideShrinkRequested = opts.overrideShrink === true;

    if (!payload) {
      // Caller should provide payload from app state
      return results;
    }

    if (this.state.securityState !== 'UNLOCKED') {
      return results; // Or throw? Caller handles it.
    }

    if (!this.masterPassword) {
      return results;
    }

    const connectedProviders = Object.entries(this.state.providers)
      .filter(([provider, connection]) => {
        if (!isProviderReadyForSync(connection)) return false;
        if (connection.status === 'error') {
          this.state.providers[provider as CloudProvider].status = 'connected';
          this.state.providers[provider as CloudProvider].error = undefined;
          // Clear cached adapter so a fresh one is created with current (decrypted) tokens
          this.adapters.delete(provider as CloudProvider);
        }
        return true;
      })
      .map(([p]) => p as CloudProvider);

    if (connectedProviders.length === 0) {
      return results;
    }

    this.state.lastError = null;
    this.state.syncState = 'SYNCING';

    // 1. Parallel Checks
    const checkTasks = connectedProviders.map(async (provider) => {
      try {
        // We handle connection error here to prevent one provider blocking others
        const adapter = await this.getConnectedAdapter(provider);
        this.updateProviderStatus(provider, 'syncing');
        this.emit({ type: 'SYNC_STARTED', provider });

        const check = await this.checkProviderConflict(provider, adapter);
        return { provider, adapter, check };
      } catch (error) {
        return { provider, error: String(error) };
      }
    });

    const checkResults = await Promise.all(checkTasks);

    // 2. Analyze Results & Handle Conflicts — merge ALL conflicting providers
    //
    // Contract: every connected provider is assumed to mirror the *same*
    // logical vault. When providers hold divergent content (e.g. user
    // intentionally points GitHub and OneDrive at separate accounts with
    // different data), uploading the conflict-merged payload below will
    // overwrite provider-unique content on non-conflicting providers. A
    // proper fix requires per-provider compare-and-swap (follow-up work,
    // see I-1 and `docs/`). Until then, we log a diagnostic warning when
    // we detect cross-provider base divergence so the issue is visible in
    // support logs.
    const conflicts = checkResults.filter((r) => !r.error && r.check?.conflict && r.check?.remoteFile);

    // Instrumentation only — detect divergent provider bases (an
    // unsupported configuration). Cheap: bases are already persisted
    // and we only read their aggregate counts.
    if (checkResults.filter((r) => !r.error).length > 1) {
      try {
        const summaries = await Promise.all(
          checkResults
            .filter((r) => !r.error)
            .map(async (r) => {
              const base = await this.loadSyncBase(r.provider as CloudProvider);
              return {
                provider: r.provider,
                hosts: base?.hosts?.length ?? 0,
                keys: base?.keys?.length ?? 0,
                snippets: base?.snippets?.length ?? 0,
              };
            }),
        );
        const signatures = summaries.map((s) => `${s.hosts}/${s.keys}/${s.snippets}`);
        const allSame = signatures.every((sig) => sig === signatures[0]);
        if (!allSame) {
          console.warn(
            '[CloudSyncManager] syncAll: connected providers hold divergent bases (multi-account setup?). Uploading the conflict-merged payload will replace each provider\'s current remote. See I-7 in PR #720 for context.',
            summaries,
          );
        }
      } catch (diagError) {
        // Non-fatal diagnostic; never let it block the sync.
        console.warn('[CloudSyncManager] syncAll: base-divergence check failed:', diagError);
      }
    }

    if (conflicts.length > 0) {
      // Three-way merge: incorporate remote data from every conflicting provider
      try {
        let merged = payload;
        for (const c of conflicts) {
          const providerBase = await this.loadSyncBase(c.provider as CloudProvider);
          const remotePayload = await EncryptionService.decryptPayload(
            c.check!.remoteFile!,
            this.masterPassword,
          );
          const result = mergeSyncPayloads(providerBase, merged, remotePayload);
          merged = result.payload;
        }
        const mergeResult = { payload: merged };

        console.info('[CloudSyncManager] syncAll: three-way merge completed');

        // Replace payload with merged payload for upload to all providers
        payload = mergeResult.payload;
        wasMerged = true;

        // Re-classify: all providers (including the conflicting one) should now upload
        // Clear the conflict check result so all go through the upload path
        for (const r of checkResults) {
          if (r.check) r.check.conflict = false;
        }
      } catch (mergeError) {
        // Merge failed — fall back to conflict UI
        console.error('[CloudSyncManager] syncAll: merge failed', mergeError);
        const { provider, check } = conflicts[0];
        const remoteFile = check!.remoteFile!;

        this.state.syncState = 'CONFLICT';
        this.state.currentConflict = {
          provider: provider as CloudProvider,
          localVersion: this.state.localVersion,
          localUpdatedAt: this.state.localUpdatedAt,
          localDeviceName: this.state.deviceName,
          remoteVersion: remoteFile.meta.version,
          remoteUpdatedAt: remoteFile.meta.updatedAt,
          remoteDeviceName: remoteFile.meta.deviceName,
        };

        this.emit({
          type: 'CONFLICT_DETECTED',
          conflict: this.state.currentConflict,
        });

        for (const r of checkResults) {
          if (r.error) {
            results.set(r.provider as CloudProvider, {
              success: false,
              provider: r.provider as CloudProvider,
              action: 'none',
              error: r.error,
            });
            this.updateProviderStatus(r.provider as CloudProvider, 'error', r.error);
            this.emit({ type: 'SYNC_ERROR', provider: r.provider as CloudProvider, error: r.error });
          } else if (r.provider === conflicts[0].provider) {
            results.set(r.provider as CloudProvider, {
              success: false,
              provider: r.provider as CloudProvider,
              action: 'none',
              conflictDetected: true,
            });
          } else {
            this.updateProviderStatus(r.provider as CloudProvider, 'connected');
            results.set(r.provider as CloudProvider, {
              success: true,
              provider: r.provider as CloudProvider,
              action: 'none',
            });
          }
        }
        return results;
      }
    }

    // Shrink guard (multi-provider): check the final outgoing payload against
    // each provider's stored base. If ANY provider would suffer a suspicious
    // shrink, block ALL uploads — the same payload goes to every provider, so
    // any one provider's "would lose too much" is a global block. Override flag
    // is one-shot and clears regardless of outcome.
    const shrinkSuspectByProvider: Array<{
      provider: CloudProvider;
      finding: Extract<ShrinkFinding, { suspicious: true }>;
    }> = [];
    const candidateProviders = checkResults
      .filter((r) => !r.error && !r.check?.conflict && r.adapter)
      .map((r) => r.provider as CloudProvider);
    for (const provider of candidateProviders) {
      const providerBase = await this.loadSyncBase(provider);
      const finding = detectSuspiciousShrink(payload, providerBase);
      if (finding.suspicious) {
        shrinkSuspectByProvider.push({ provider, finding });
      }
    }
    const shouldBlockAll = shrinkSuspectByProvider.length > 0 && !overrideShrinkRequested;
    const shouldForceAll = shrinkSuspectByProvider.length > 0 && overrideShrinkRequested;

    if (shouldBlockAll) {
      this.state.syncState = 'BLOCKED';
      this.state.lastShrinkFinding = shrinkSuspectByProvider[0].finding;
      for (const { provider, finding } of shrinkSuspectByProvider) {
        this.emit({ type: 'SYNC_BLOCKED_SHRINK', provider, finding });
        this.updateProviderStatus(provider, 'error', 'Sync blocked: would delete too much');
        results.set(provider, {
          success: false,
          provider,
          action: 'none',
          shrinkBlocked: true,
          finding,
        });
      }
      // Process check errors from the parallel check phase so a provider that
      // failed during checkProviderConflict is not silently dropped from results.
      checkResults.forEach((r) => {
        if (r.error) {
          results.set(r.provider as CloudProvider, {
            success: false,
            provider: r.provider as CloudProvider,
            action: 'none',
            error: r.error,
          });
          this.updateProviderStatus(r.provider as CloudProvider, 'error', r.error);
          this.emit({ type: 'SYNC_ERROR', provider: r.provider as CloudProvider, error: r.error });
        }
      });
      // Providers in candidateProviders that didn't trip the shrink check still
      // share the same payload — mark them as not-uploaded so the caller doesn't
      // think a "successful" no-op happened.
      const blockedProviders = new Set(shrinkSuspectByProvider.map((e) => e.provider));
      for (const provider of candidateProviders) {
        if (!results.has(provider) && !blockedProviders.has(provider)) {
          results.set(provider, {
            success: false,
            provider,
            action: 'none',
            error: 'Sync blocked: another provider would lose too much data',
          });
          this.updateProviderStatus(provider, 'error', 'Sync blocked due to peer provider');
        }
      }
      return results;
    }

    if (shouldForceAll) {
      for (const { provider, finding } of shrinkSuspectByProvider) {
        this.emit({ type: 'SYNC_FORCED', provider, finding });
      }
    }

    // 3. Encrypt Once
    const validUploads = checkResults.filter(
      (r) => !r.error && !r.check?.conflict && r.adapter
    ) as { provider: CloudProvider; adapter: CloudAdapter }[];

    if (validUploads.length === 0) {
      // Process errors if any
      checkResults.forEach((r) => {
        if (r.error) {
          results.set(r.provider as CloudProvider, {
            success: false,
            provider: r.provider as CloudProvider,
            action: 'none',
            error: r.error,
          });
          this.updateProviderStatus(r.provider as CloudProvider, 'error', r.error);
          this.emit({ type: 'SYNC_ERROR', provider: r.provider as CloudProvider, error: r.error });
        }
      });
      this.state.syncState = 'ERROR';
      return results;
    }

    // Use the highest version as base: either local or any remote that was merged
    let baseVersion = this.state.localVersion;
    if (wasMerged) {
      for (const c of conflicts) {
        const rv = c.check?.remoteFile?.meta?.version ?? 0;
        if (rv > baseVersion) baseVersion = rv;
      }
    }

    let syncedFile: SyncedFile;
    try {
      syncedFile = await EncryptionService.encryptPayload(
        payload,
        this.masterPassword,
        this.state.deviceId,
        this.state.deviceName,
        packageJson.version,
        baseVersion
      );
    } catch (error) {
      const msg = String(error);
      this.state.syncState = 'ERROR';
      this.state.lastError = msg;

      // Fail all
      for (const r of validUploads) {
        this.updateProviderStatus(r.provider, 'error', msg);
        this.emit({ type: 'SYNC_ERROR', provider: r.provider, error: msg });
        results.set(r.provider, {
          success: false,
          provider: r.provider,
          action: 'none',
          error: msg,
        });
      }
      return results;
    }

    // 4. Parallel Uploads — pass the payload so base is persisted
    // inside uploadToProvider BEFORE the per-provider anchor advances.
    // Ordering matters: a crash between the two writes must leave the
    // stale anchor re-triggering inspection on next startup, not a
    // fresh anchor paired with a stale base.
    const uploadTasks = validUploads.map(async ({ provider, adapter }) => {
      const result = await this.uploadToProvider(provider, adapter, syncedFile, payload);
      results.set(provider, result);
    });

    await Promise.all(uploadTasks);

    // 5. Final State Update
    const hasSuccess = Array.from(results.values()).some((r) => r.success);
    if (hasSuccess) {
      this.exitBlockedState();
      this.state.syncState = 'IDLE';
      this.state.lastShrinkFinding = undefined;

      // If a merge happened, attach the merged payload to successful results
      // so callers can apply remote additions to local state
      if (wasMerged && payload) {
        for (const [p, r] of results) {
          if (r.success) {
            results.set(p, { ...r, action: 'merge', mergedPayload: payload });
          }
        }
      }
    } else {
      this.state.syncState = 'ERROR';
      // lastError is set by uploadToProvider
    }
    this.notifyStateChange(); // Notify UI that sync is complete

    // Process errors from initial checks (if any)
    checkResults.forEach((r) => {
      if (r.error) {
        results.set(r.provider as CloudProvider, {
          success: false,
          provider: r.provider as CloudProvider,
          action: 'none',
          error: r.error,
        });
        this.updateProviderStatus(r.provider as CloudProvider, 'error', r.error);
        this.emit({ type: 'SYNC_ERROR', provider: r.provider as CloudProvider, error: r.error });
      }
    });

    return results;
  }

  // ==========================================================================
  // Auto-Sync
  // ==========================================================================

  setDeviceName(name: string): void {
    this.state.deviceName = name;
    this.saveToStorage(SYNC_STORAGE_KEYS.DEVICE_NAME, name);
    this.notifyStateChange();
  }

  setAutoSync(enabled: boolean, intervalMinutes?: number): void {
    this.state.autoSyncEnabled = enabled;
    if (intervalMinutes) {
      this.state.autoSyncInterval = Math.max(
        SYNC_CONSTANTS.MIN_SYNC_INTERVAL,
        Math.min(SYNC_CONSTANTS.MAX_SYNC_INTERVAL, intervalMinutes)
      );
    }
    this.saveSyncConfig();
    this.notifyStateChange(); // Notify UI of state change

    if (enabled && this.state.securityState === 'UNLOCKED') {
      this.startAutoSync();
    } else {
      this.stopAutoSync();
    }
  }

  private startAutoSync(): void {
    if (this.autoSyncTimer) {
      return;
    }

    this.autoSyncTimer = setInterval(
      () => {
        // Auto-sync callback - caller should provide payload
        this.emit({ type: 'SYNC_STARTED', provider: 'github' }); // Trigger UI to initiate sync
      },
      this.state.autoSyncInterval * 60 * 1000
    );
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  private saveSyncConfig(): void {
    this.saveToStorage(SYNC_STORAGE_KEYS.SYNC_CONFIG, {
      autoSync: this.state.autoSyncEnabled,
      interval: this.state.autoSyncInterval,
      localVersion: this.state.localVersion,
      localUpdatedAt: this.state.localUpdatedAt,
      remoteVersion: this.state.remoteVersion,
      remoteUpdatedAt: this.state.remoteUpdatedAt,
    });
  }

  // ==========================================================================
  // Sync Base (three-way merge snapshot)
  // ==========================================================================

  private syncBaseKey(provider?: CloudProvider): string {
    const suffix = provider ? `_${provider}` : '';
    return `${SYNC_STORAGE_KEYS.SYNC_BASE_PAYLOAD}${suffix}`;
  }

  private providerAccountIdKey(provider: CloudProvider): string {
    return `netcatty.sync.accountId.${provider}`;
  }

  private loadProviderAccountId(provider: CloudProvider): string | null {
    return this.loadFromStorage<string>(this.providerAccountIdKey(provider)) ?? null;
  }

  private saveProviderAccountId(provider: CloudProvider, id: string): void {
    this.saveToStorage(this.providerAccountIdKey(provider), id);
  }

  async saveSyncBase(payload: SyncPayload, provider?: CloudProvider): Promise<void> {
    const key = this.state.unlockedKey?.derivedKey;
    if (!key) return;
    try {
      const data = new TextEncoder().encode(JSON.stringify(payload));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);
      // Encode in chunks to avoid stack overflow with large buffers
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < combined.length; i += CHUNK) {
        binary += String.fromCharCode(...combined.subarray(i, i + CHUNK));
      }
      this.saveToStorage(this.syncBaseKey(provider), btoa(binary));
    } catch {
      console.warn('[CloudSyncManager] Failed to save sync base');
    }
  }

  async loadSyncBase(provider?: CloudProvider): Promise<SyncPayload | null> {
    const key = this.state.unlockedKey?.derivedKey;
    if (!key) return null;
    try {
      const encoded = this.loadFromStorage<string>(this.syncBaseKey(provider));
      if (!encoded || typeof encoded !== 'string') return null;
      const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
      return null;
    }
  }

  private clearSyncBase(): void {
    this.removeFromStorage(SYNC_STORAGE_KEYS.SYNC_BASE_PAYLOAD);
    for (const p of ['github', 'google', 'onedrive', 'webdav', 's3'] as const) {
      this.removeFromStorage(this.syncBaseKey(p));
    }
    this.clearSyncAnchor();
  }

  private addSyncHistoryEntry(entry: Omit<SyncHistoryEntry, 'id'>): void {
    const newEntry: SyncHistoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
    };

    // Keep only the last 50 entries
    this.state.syncHistory = [newEntry, ...this.state.syncHistory].slice(0, 50);
    this.saveToStorage(SYNC_HISTORY_STORAGE_KEY, this.state.syncHistory);
    this.notifyStateChange(); // Notify UI of new history entry
  }

  // ==========================================================================
  // Local Data Reset
  // ==========================================================================

  /**
   * Resets local version and timestamp to 0.
   * This allows the next sync to treat the remote data as newer
   * and download it, effectively resetting local vault data.
   */
  resetLocalVersion(): void {
    this.state.localVersion = 0;
    this.state.localUpdatedAt = 0;
    this.state.syncHistory = [];
    this.saveSyncConfig();
    this.saveToStorage(SYNC_HISTORY_STORAGE_KEY, []);
    this.clearSyncBase();
    this.clearSyncAnchor();
    this.notifyStateChange();
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  destroy(): void {
    this.stopAutoSync();
    this.lock();
    this.eventListeners.clear();
    this.adapters.clear();
    if (this.hasStorageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorageEvent);
      this.hasStorageListener = false;
    }
  }
}

// Singleton instance
let syncManagerInstance: CloudSyncManager | null = null;

export const getCloudSyncManager = (): CloudSyncManager => {
  if (!syncManagerInstance) {
    syncManagerInstance = new CloudSyncManager();
  }
  return syncManagerInstance;
};

export const resetCloudSyncManager = (): void => {
  if (syncManagerInstance) {
    syncManagerInstance.destroy();
    syncManagerInstance = null;
  }
};

export default CloudSyncManager;
