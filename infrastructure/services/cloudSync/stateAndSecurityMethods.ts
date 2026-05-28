/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  SYNC_CONSTANTS,
  SYNC_STORAGE_KEYS,
  generateDeviceId,
  getDefaultDeviceName,
} from '../../../domain/sync';
import { EncryptionService } from '../EncryptionService';
import { createAdapter } from '../adapters';
import { localStorageAdapter } from '../../persistence/localStorageAdapter';
import {
  decryptProviderSecrets,
  encryptProviderSecrets,
} from '../../persistence/secureFieldAdapter';
import type { CloudAdapter } from '../adapters';
import type {
  CloudProvider,
  MasterKeyConfig,
  ProviderConnection,
  SecurityState,
  SyncHistoryEntry,
} from '../../../domain/sync';
import type { SyncManagerState } from '../CloudSyncManager';

const SYNC_HISTORY_STORAGE_KEY = 'netcatty_sync_history_v1';

export function loadInitialStateImpl(this: any): SyncManagerState {
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

export function loadProviderConnectionImpl(this: any,provider: CloudProvider): ProviderConnection {
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

export async function initProviderDecryptionImpl(this: any): Promise<void> {
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

export async function saveProviderConnectionImpl(this: any,
  provider: CloudProvider,
  connection: ProviderConnection,
  authAttemptId?: number
): Promise<void> {
    const key = SYNC_STORAGE_KEYS[`PROVIDER_${provider.toUpperCase()}` as keyof typeof SYNC_STORAGE_KEYS];
    // Use write-specific counter so status-only updates cannot discard
    // an in-flight encrypted write that must be persisted.
    const seq = ++this.providerWriteSeq[provider];
    const encrypted = await encryptProviderSecrets(connection);
    // Only persist if no newer save has started during the async gap
    if (
      seq === this.providerWriteSeq[provider] &&
      (authAttemptId == null || this.isActiveAuthAttempt(provider, authAttemptId))
    ) {
      this.saveToStorage(key, encrypted);
    }
  }

export function loadFromStorageImpl<T>(this: any,key: string): T | null {
    return localStorageAdapter.read<T>(key);
  }

export function saveToStorageImpl(this: any,key: string, value: unknown): void {
    localStorageAdapter.write(key, value);
  }

export function removeFromStorageImpl(this: any,key: string): void {
    localStorageAdapter.remove(key);
  }

export function setupCrossWindowSyncImpl(this: any): void {
    if (this.hasStorageListener) return;
    if (typeof window === 'undefined') return;

    window.addEventListener('storage', this.handleStorageEvent);
    this.hasStorageListener = true;
  }

export function safeJsonParseImpl<T>(this: any,value: string | null): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

export function handleStorageEventImpl(this: any, event: StorageEvent): void {
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
  }

export async function getConnectedAdapterImpl(this: any,provider: CloudProvider): Promise<CloudAdapter> {
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

export async function setupMasterKeyImpl(this: any,password: string): Promise<void> {
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

export async function unlockImpl(this: any,password: string): Promise<boolean> {
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

export function lockImpl(this: any): void {
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

export async function changeMasterKeyImpl(this: any,oldPassword: string, newPassword: string): Promise<boolean> {
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

export async function verifyPasswordImpl(this: any,password: string): Promise<boolean> {
    if (!this.state.masterKeyConfig) {
      return false;
    }
    return EncryptionService.verifyPassword(password, this.state.masterKeyConfig);
  }
