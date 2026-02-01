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
  SYNC_CONSTANTS,
  SYNC_STORAGE_KEYS,
  generateDeviceId,
  getDefaultDeviceName,
} from '../../domain/sync';
import packageJson from '../../package.json';
import { EncryptionService } from './EncryptionService';
import { createAdapter, type CloudAdapter } from './adapters';
import type { GitHubAdapter } from './adapters/GitHubAdapter';
import type { GoogleDriveAdapter } from './adapters/GoogleDriveAdapter';
import type { OneDriveAdapter } from './adapters/OneDriveAdapter';

const SYNC_HISTORY_STORAGE_KEY = 'netcatty_sync_history_v1';

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
}

export type SyncEventCallback = (event: SyncEvent) => void;

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

  constructor() {
    this.state = this.loadInitialState();
    this.stateSnapshot = { ...this.state };
    this.setupCrossWindowSync();
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

  private saveProviderConnection(provider: CloudProvider, connection: ProviderConnection): void {
    const key = SYNC_STORAGE_KEYS[`PROVIDER_${provider.toUpperCase()}` as keyof typeof SYNC_STORAGE_KEYS];
    // Don't persist sensitive tokens directly - use safeStorage in production
    const { tokens, ...safeData } = connection;
    this.saveToStorage(key, { ...safeData, tokens }); // In production, encrypt tokens/config
  }

  private loadFromStorage<T>(key: string): T | null {
    try {
      // eslint-disable-next-line no-restricted-globals
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  private saveToStorage(key: string, value: unknown): void {
    try {
      // eslint-disable-next-line no-restricted-globals
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('Failed to save to storage:', e);
    }
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
      const prev = this.state.providers[provider];
      const next = this.loadProviderConnection(provider);

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
    }
  };

  private async getConnectedAdapter(provider: CloudProvider): Promise<CloudAdapter> {
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
      const tokens = await ghAdapter.completeAuth(deviceCode, interval, expiresAt, onPending);
      
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

      this.saveProviderConnection('github', this.state.providers.github);
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

      this.saveProviderConnection(provider, this.state.providers[provider]);
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

      this.state.providers[provider] = {
        provider,
        status: 'connected',
        config,
        account,
        resourceId: resourceId || undefined,
      };

      this.saveProviderConnection(provider, this.state.providers[provider]);
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
   * Disconnect a provider
   */
  async disconnectProvider(provider: CloudProvider): Promise<void> {
    const adapter = this.adapters.get(provider);
    if (adapter) {
      adapter.signOut();
      this.adapters.delete(provider);
    }

    this.state.providers[provider] = {
      provider,
      status: 'disconnected',
    };

    this.saveProviderConnection(provider, this.state.providers[provider]);
    this.notifyStateChange(); // Ensure UI updates immediately after disconnect
  }

  private updateProviderStatus(
    provider: CloudProvider,
    status: ProviderConnection['status'],
    error?: string
  ): void {
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

  /**
   * Build sync payload from current app state
   */
  buildPayload(data: {
    hosts: SyncPayload['hosts'];
    keys: SyncPayload['keys'];
    snippets: SyncPayload['snippets'];
    customGroups: SyncPayload['customGroups'];
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
    payload: SyncPayload
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
    this.state.syncState = 'SYNCING';
    this.emit({ type: 'SYNC_STARTED', provider });

    try {
      // Check for remote version first
      const remoteFile = await adapter.download();

      if (remoteFile) {
        // Compare versions
        if (remoteFile.meta.updatedAt > this.state.localUpdatedAt) {
          // Remote is newer - conflict
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

          this.emit({ type: 'CONFLICT_DETECTED', conflict: this.state.currentConflict });
          
          return {
            success: false,
            provider,
            action: 'none',
            conflictDetected: true,
          };
        }
      }

      // Encrypt and upload
      const syncedFile = await EncryptionService.encryptPayload(
        payload,
        this.masterPassword,
        this.state.deviceId,
        this.state.deviceName,
        packageJson.version,
        this.state.localVersion
      );

      await adapter.upload(syncedFile);

      // Update local state
      this.state.localVersion = syncedFile.meta.version;
      this.state.localUpdatedAt = syncedFile.meta.updatedAt;
      this.state.remoteVersion = syncedFile.meta.version;
      this.state.remoteUpdatedAt = syncedFile.meta.updatedAt;
      this.state.providers[provider].lastSync = Date.now();
      this.state.providers[provider].lastSyncVersion = syncedFile.meta.version;

      this.saveSyncConfig();
      this.saveProviderConnection(provider, this.state.providers[provider]);
      this.notifyStateChange(); // Notify UI immediately after version update

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

      this.state.syncState = 'IDLE';
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
      const remoteFile = await adapter.download();
      if (!remoteFile) {
        return null;
      }

      // Decrypt
      const payload = await EncryptionService.decryptPayload(remoteFile, this.masterPassword);

      // Update local tracking
      this.state.localVersion = remoteFile.meta.version;
      this.state.localUpdatedAt = remoteFile.meta.updatedAt;
      this.state.remoteVersion = remoteFile.meta.version;
      this.state.remoteUpdatedAt = remoteFile.meta.updatedAt;
      this.saveSyncConfig();
      this.notifyStateChange(); // Notify UI of state change

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
      this.state.syncState = 'IDLE';
      this.notifyStateChange(); // Notify UI of conflict resolution
      return payload;
    } else {
      // USE_LOCAL - just clear conflict, caller will re-sync
      this.state.currentConflict = null;
      this.state.syncState = 'IDLE';
      this.notifyStateChange(); // Notify UI of conflict resolution
      return null;
    }
  }

  /**
   * Sync to all connected providers
   */
  async syncAllProviders(payload?: SyncPayload): Promise<Map<CloudProvider, SyncResult>> {
    const results = new Map<CloudProvider, SyncResult>();

    if (!payload) {
      // Caller should provide payload from app state
      return results;
    }

    const connectedProviders = Object.entries(this.state.providers)
      .filter(([_, conn]) => conn.status === 'connected')
      .map(([p]) => p as CloudProvider);

    for (const provider of connectedProviders) {
      const result = await this.syncToProvider(provider, payload);
      results.set(provider, result);
      
      // Stop on conflict
      if (result.conflictDetected) {
        break;
      }
    }

    return results;
  }

  // ==========================================================================
  // Auto-Sync
  // ==========================================================================

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
