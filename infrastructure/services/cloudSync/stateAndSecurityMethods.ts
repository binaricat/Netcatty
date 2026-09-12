/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BUILTIN_CLOUD_PROVIDERS,
  SYNC_CONSTANTS,
  SYNC_STORAGE_KEYS,
  cleanOneDriveErrorMessage,
  generateDeviceId,
  getDefaultDeviceName,
  isBuiltinCloudProvider,
  isOneDriveReauthRequiredMessage,
  providerConnectionStorageKey,
  type CloudProvider,
  type MasterKeyConfig,
  type ProviderConnection,
  type SecurityState,
  type SyncHistoryEntry,
} from '../../../domain/sync';
import { isPluginCloudProviderId } from '../../../domain/cloudProviderIds';
import { createPluginSyncObjectStorage } from '../adapters/pluginSyncObjectStorage';
import {
  createPluginSyncIpcHost,
  isPluginSyncIpcAvailable,
} from '../adapters/pluginSyncIpcHost';
import type { EncryptedObjectStorage } from '../../../domain/encryptedObjectStorage';
import {
  DEFAULT_CLOUD_SYNC_STRATEGY,
  normalizeCloudSyncStrategy,
} from '../../../domain/syncStrategy';
import {
  coalesceStoredSyncPreferences,
  hasSyncPreferenceFields,
  resolveSyncPreferencesForPersist,
} from './syncConfigPersist';
import { EncryptionService } from '../EncryptionService';
import { createAdapter } from '../adapters';
import { localStorageAdapter } from '../../persistence/localStorageAdapter';
import {
  decryptProviderSecrets,
  encryptProviderSecrets,
} from '../../persistence/secureFieldAdapter';
import type { CloudAdapter } from '../adapters';
import type { SyncManagerState } from '../CloudSyncManager';
import { getConvergentSyncLocalConfig } from '../convergentSyncConfig';

const SYNC_HISTORY_STORAGE_KEY = 'netcatty_sync_history_v1';

/** Ensure per-provider sequence counters exist (dynamic plugins arrive late). */
function ensureProviderSeqCounters(manager: any, provider: CloudProvider): void {
  // Lightweight test harnesses may omit the maps entirely; initialize before indexing.
  if (manager.providerDecryptSeq == null || typeof manager.providerDecryptSeq !== 'object') {
    manager.providerDecryptSeq = {};
  }
  if (manager.providerWriteSeq == null || typeof manager.providerWriteSeq !== 'object') {
    manager.providerWriteSeq = {};
  }
  if (manager.providerDecrypted == null || typeof manager.providerDecrypted !== 'object') {
    manager.providerDecrypted = {};
  }
  if (manager.providerDecryptSeq[provider] == null || Number.isNaN(manager.providerDecryptSeq[provider])) {
    manager.providerDecryptSeq[provider] = 0;
  }
  if (manager.providerWriteSeq[provider] == null || Number.isNaN(manager.providerWriteSeq[provider])) {
    manager.providerWriteSeq[provider] = 0;
  }
  if (manager.providerDecrypted[provider] == null) {
    manager.providerDecrypted[provider] = false;
  }
}

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
      autoSync?: boolean;
      interval?: number;
      localVersion?: number;
      localUpdatedAt?: number;
      remoteVersion?: number;
      remoteUpdatedAt?: number;
      syncStrategy?: unknown;
    }>(SYNC_STORAGE_KEYS.SYNC_CONFIG);
    const defaultPreferences = {
      autoSync: false,
      interval: SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL,
      syncStrategy: DEFAULT_CLOUD_SYNC_STRATEGY,
    };
    // Prefer SYNC_PREFERENCES; fall back to legacy fields still embedded in
    // SYNC_CONFIG. Do not eagerly persist the split key on startup: localStorage
    // check-then-write is not atomic across renderer windows, so a peer that
    // already migrated or toggled can still be overwritten (#2976). Migration
    // writes happen in preference writers / saveSyncConfig instead.
    const syncPreferences = resolveSyncPreferencesForPersist({
      memory: defaultPreferences,
      stored: coalesceStoredSyncPreferences(
        this.loadFromStorage<{
          autoSync?: boolean;
          interval?: number;
          syncStrategy?: unknown;
        }>(SYNC_STORAGE_KEYS.SYNC_PREFERENCES),
        syncConfig,
      ),
      preferencesFromMemory: false,
    });

    // Load sync history
    const syncHistory = this.loadFromStorage<SyncHistoryEntry[]>(SYNC_HISTORY_STORAGE_KEY) || [];

    // Determine initial security state
    const securityState: SecurityState = masterKeyConfig ? 'LOCKED' : 'NO_KEY';

    // Load provider connections (built-ins + registered plugin provider IDs)
    const providers: Record<CloudProvider, ProviderConnection> = {
      github: this.loadProviderConnection('github'),
      google: this.loadProviderConnection('google'),
      onedrive: this.loadProviderConnection('onedrive'),
      webdav: this.loadProviderConnection('webdav'),
      s3: this.loadProviderConnection('s3'),
    };
    for (const pluginProviderId of listRegisteredPluginProviderIdsImpl.call(this)) {
      providers[pluginProviderId] = this.loadProviderConnection(pluginProviderId);
      if (this.providerWriteSeq[pluginProviderId] == null) this.providerWriteSeq[pluginProviderId] = 0;
      if (this.providerDecryptSeq[pluginProviderId] == null) this.providerDecryptSeq[pluginProviderId] = 0;
      if (this.providerDecrypted[pluginProviderId] == null) this.providerDecrypted[pluginProviderId] = false;
      if (this.providerAuthAttemptSeq[pluginProviderId] == null) this.providerAuthAttemptSeq[pluginProviderId] = 0;
      if (this.providerAuthRestoreState[pluginProviderId] === undefined) {
        this.providerAuthRestoreState[pluginProviderId] = null;
      }
    }
    enforceLegacySingleProviderConnected(providers);

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
      autoSyncEnabled: syncPreferences.autoSync,
      autoSyncInterval: Math.max(
        SYNC_CONSTANTS.MIN_SYNC_INTERVAL,
        Math.min(SYNC_CONSTANTS.MAX_SYNC_INTERVAL, syncPreferences.interval),
      ),
      syncStrategy: syncPreferences.syncStrategy,
      syncHistory,
      pendingLocalSync: false,
      convergentConflicts: [],
    };
  }

export function loadProviderConnectionImpl(this: any,provider: CloudProvider): ProviderConnection {
    const key = providerConnectionStorageKey(provider);
    const stored = this.loadFromStorage<Partial<ProviderConnection>>(key);

    // Config may be a valid scalar including JSON null (schema type: "null").
    // Presence is property existence; only a missing property means absent.
    const hasCreds = stored?.tokens != null
      || (stored != null && Object.prototype.hasOwnProperty.call(stored, 'config'));
    // Determine the correct status: if tokens or config exist, should be 'connected'
    // Never restore 'syncing' or 'error' status - those are transient.
    // Dynamic plugin providers only rejoin sync when the host is ready AND the
    // provider was recorded as contribution-available (survives restart).
    // Host-off or uninstalled providers stay disconnected with config retained.
    let status: ProviderConnection['status'] = hasCreds ? 'connected' : 'disconnected';
    if (isPluginCloudProviderId(provider) && hasCreds) {
      const hostReady = isPluginSyncIpcAvailable();
      const available = listAvailablePluginSyncProviderIdsImpl.call(this);
      status = hostReady && available.includes(provider) ? 'connected' : 'disconnected';
    }

    return {
      provider,
      ...stored,
      status, // Must be last to override any stored 'syncing' or 'error' status
    } as ProviderConnection;
  }

/**
 * Legacy (non-convergent) mode allows only one ready provider. After restart,
 * retained plugin configs can race with a builtin the user switched to — keep
 * config but force extras offline (same policy as setAvailablePluginSyncProviderIds).
 */
export function enforceLegacySingleProviderConnected(
  providers: Record<string, ProviderConnection>,
): void {
  let convergentActive = false;
  try {
    convergentActive = getConvergentSyncLocalConfig().initialized === true;
  } catch {
    convergentActive = false;
  }
  if (convergentActive) return;

  const readyIds = Object.entries(providers)
    .filter(([, conn]) => conn != null && (conn.status === 'connected' || conn.status === 'syncing'))
    .map(([id]) => id);
  if (readyIds.length <= 1) return;

  // Prefer a builtin (stable UI order), else first ready id.
  const preferred = BUILTIN_CLOUD_PROVIDERS.find((id) => readyIds.includes(id))
    ?? readyIds[0]!;
  for (const id of readyIds) {
    if (id === preferred) continue;
    const conn = providers[id];
    if (!conn) continue;
    providers[id] = {
      ...conn,
      status: 'disconnected',
    };
  }
}

export function listRegisteredPluginProviderIdsImpl(this: any): string[] {
  const raw = this.loadFromStorage<unknown>(SYNC_STORAGE_KEYS.PLUGIN_CLOUD_PROVIDERS);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id: unknown): id is string => typeof id === 'string' && isPluginCloudProviderId(id))
    .sort();
}

export function listAvailablePluginSyncProviderIdsImpl(this: any): string[] {
  if (typeof this.loadFromStorage !== 'function') return [];
  const raw = this.loadFromStorage(SYNC_STORAGE_KEYS.AVAILABLE_PLUGIN_SYNC_PROVIDERS) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id: unknown): id is string => typeof id === 'string' && isPluginCloudProviderId(id))
    .sort();
}

export function markPluginSyncProviderAvailableImpl(this: any, provider: CloudProvider): void {
  if (!isPluginCloudProviderId(provider)) return;
  const next = new Set(listAvailablePluginSyncProviderIdsImpl.call(this));
  next.add(provider);
  this.saveToStorage(SYNC_STORAGE_KEYS.AVAILABLE_PLUGIN_SYNC_PROVIDERS, [...next].sort());
}

export function markPluginSyncProviderUnavailableImpl(this: any, provider: CloudProvider): void {
  if (!isPluginCloudProviderId(provider)) return;
  const next = listAvailablePluginSyncProviderIdsImpl.call(this).filter((id) => id !== provider);
  if (next.length === 0) {
    this.removeFromStorage(SYNC_STORAGE_KEYS.AVAILABLE_PLUGIN_SYNC_PROVIDERS);
  } else {
    this.saveToStorage(SYNC_STORAGE_KEYS.AVAILABLE_PLUGIN_SYNC_PROVIDERS, next);
  }
}

/**
 * Replace the live contribution-available set. Called when the renderer
 * refreshes plugin sync provider contributions so disabled/uninstalled
 * providers stop rejoining sync cycles after restart.
 */
export function setAvailablePluginSyncProviderIdsImpl(
  this: any,
  providerIds: readonly string[],
): void {
  const previous = listAvailablePluginSyncProviderIdsImpl.call(this);
  const previousSet = new Set(previous);
  const next = [...new Set(
    providerIds.filter((id): id is string => typeof id === 'string' && isPluginCloudProviderId(id)),
  )].sort();
  if (next.length === 0) {
    this.removeFromStorage(SYNC_STORAGE_KEYS.AVAILABLE_PLUGIN_SYNC_PROVIDERS);
  } else {
    this.saveToStorage(SYNC_STORAGE_KEYS.AVAILABLE_PLUGIN_SYNC_PROVIDERS, next);
  }
  if (!this.state?.providers) return;
  let changed = false;
  for (const id of Object.keys(this.state.providers)) {
    if (!isPluginCloudProviderId(id)) continue;
    const conn = this.state.providers[id];
    if (!conn) continue;
    if (!next.includes(id)) {
      // Disabled/uninstalled: leave config, force offline ready-state.
      if (conn.status !== 'disconnected') {
        this.state.providers[id] = {
          ...conn,
          status: 'disconnected',
          error: 'Plugin sync provider is no longer installed or enabled',
        };
        changed = true;
      }
      const adapter = this.adapters?.get?.(id);
      if (adapter) {
        try { adapter.signOut(); } catch { /* ignore */ }
        this.adapters.delete(id);
      }
      continue;
    }
    // Provider is still contributed. Only drop the cached adapter when the
    // provider newly re-entered the available set (install/enable/restart of
    // the package). Setting-only contribution noise keeps membership stable
    // and must not signOut mid-sync — plugin adapters rebind via rebindSession.
    if (!previousSet.has(id) && this.adapters?.has?.(id)) {
      const adapter = this.adapters.get(id);
      try { adapter?.signOut?.(); } catch { /* ignore */ }
      this.adapters.delete(id);
    }
    // Re-enable retained configs whenever the contribution reappears, but only
    // when doing so cannot create a second active provider in legacy
    // single-provider mode (convergent multi-provider allows it).
    // Config may be a valid falsy scalar (false, 0, "") — only null/undefined means absent.
    const hasRetainedConfig = conn.tokens != null
      || Object.prototype.hasOwnProperty.call(conn, 'config');
    if (hasRetainedConfig && conn.status === 'disconnected') {
      let convergentActive = false;
      try {
        convergentActive = getConvergentSyncLocalConfig().initialized === true;
      } catch {
        convergentActive = false;
      }
      const anotherReady = Object.entries(this.state.providers as Record<string, ProviderConnection>)
        .some(([otherId, other]) => (
          otherId !== id
          && other != null
          && (other.status === 'connected' || other.status === 'syncing')
        ));
      if (!convergentActive && anotherReady) {
        // Keep disconnected with retained config until the user reconnects
        // explicitly; auto-reactivation would mirror two legacy providers.
        continue;
      }
      this.state.providers[id] = {
        ...conn,
        status: 'connected',
        error: undefined,
      };
      changed = true;
    }
  }
  if (changed && typeof this.notifyStateChange === 'function') {
    this.notifyStateChange();
  }
}

export function registerPluginProviderIdImpl(this: any, provider: CloudProvider): void {
  if (!isPluginCloudProviderId(provider)) return;
  const next = new Set(listRegisteredPluginProviderIdsImpl.call(this));
  next.add(provider);
  this.saveToStorage(SYNC_STORAGE_KEYS.PLUGIN_CLOUD_PROVIDERS, [...next].sort());
  markPluginSyncProviderAvailableImpl.call(this, provider);
}

export function unregisterPluginProviderIdImpl(this: any, provider: CloudProvider): void {
  if (!isPluginCloudProviderId(provider)) return;
  const next = listRegisteredPluginProviderIdsImpl.call(this).filter((id) => id !== provider);
  if (next.length === 0) {
    this.removeFromStorage(SYNC_STORAGE_KEYS.PLUGIN_CLOUD_PROVIDERS);
  } else {
    this.saveToStorage(SYNC_STORAGE_KEYS.PLUGIN_CLOUD_PROVIDERS, next);
  }
  markPluginSyncProviderUnavailableImpl.call(this, provider);
}

export async function initProviderDecryptionImpl(this: any): Promise<void> {
    const providers: CloudProvider[] = [
      ...BUILTIN_CLOUD_PROVIDERS,
      ...listRegisteredPluginProviderIdsImpl.call(this),
    ];
    for (const p of providers) {
      try {
        const conn = this.state.providers[p];
        // Config may be a valid scalar including JSON null — presence is property existence.
        if (conn.tokens != null || Object.prototype.hasOwnProperty.call(conn, 'config')) {
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
    const key = providerConnectionStorageKey(provider);
    // Use write-specific counter so status-only updates cannot discard
    // an in-flight encrypted write that must be persisted.
    ensureProviderSeqCounters(this, provider);
    const seq = ++this.providerWriteSeq[provider];
    const encrypted = await encryptProviderSecrets(connection);
    // Only persist if no newer save has started during the async gap
    if (
      seq === this.providerWriteSeq[provider] &&
      (authAttemptId == null || this.isActiveAuthAttempt(provider, authAttemptId))
    ) {
      this.saveToStorage(key, encrypted);
      // Keep dynamic plugin providers in the restart registry while connected
      // (or while credentials/config remain so a missing plugin cannot drop them).
      if (isPluginCloudProviderId(provider)) {
        // Config may be a valid scalar including JSON null — presence is property existence.
        const hasData = encrypted.tokens != null
          || Object.prototype.hasOwnProperty.call(encrypted, 'config');
        if (hasData || encrypted.status === 'connected' || encrypted.status === 'syncing') {
          registerPluginProviderIdImpl.call(this, provider);
        }
      }
    }
  }

export function loadFromStorageImpl<T>(this: any,key: string): T | null {
    return localStorageAdapter.read<T>(key);
  }

export function saveToStorageImpl(this: any,key: string, value: unknown): boolean {
    return localStorageAdapter.write(key, value);
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

function applySyncPreferencesFromStorage(
  this: any,
  next: {
    autoSync?: boolean;
    interval?: number;
    syncStrategy?: unknown;
  },
): void {
  this.state.autoSyncEnabled = Boolean(next.autoSync);
  this.state.autoSyncInterval = Math.max(
    SYNC_CONSTANTS.MIN_SYNC_INTERVAL,
    Math.min(
      SYNC_CONSTANTS.MAX_SYNC_INTERVAL,
      Number(next.interval ?? SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL),
    ),
  );
  this.state.syncStrategy = normalizeCloudSyncStrategy(next.syncStrategy);

  // Mirror setAutoSyncImpl: keep the interval timer aligned with the
  // preference written by another window (#2976).
  if (this.state.autoSyncEnabled && this.state.securityState === 'UNLOCKED') {
    this.startAutoSync?.();
  } else {
    this.stopAutoSync?.();
  }
}

export function handleStorageEventImpl(this: any, event: StorageEvent): void {
    if (event.storageArea !== window.localStorage) return;
    const key = event.key;
    if (!key) return;

    // Handle master key config changes (e.g., when set up in settings window)
    if (key === SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG) {
      const nextConfig = this.safeJsonParse<MasterKeyConfig>(event.newValue);

      if (nextConfig) {
        const currentConfig = this.state.masterKeyConfig as MasterKeyConfig | null;
        const configChanged = !currentConfig
          || currentConfig.verificationHash !== nextConfig.verificationHash
          || currentConfig.salt !== nextConfig.salt
          || currentConfig.kdf !== nextConfig.kdf
          || currentConfig.kdfIterations !== nextConfig.kdfIterations;

        if (!configChanged) return;

        // Master key was set up or changed in another window. Lock this
        // window so it cannot keep syncing with the stale in-memory password.
        this.bumpSyncSecurityGeneration?.();
        this.state.masterKeyConfig = nextConfig;
        this.state.securityState = 'LOCKED';
        this.state.unlockedKey = null;
        this.masterPassword = null;
        this.stopAutoSync();
        this.notifyStateChange();
      } else if (this.state.masterKeyConfig) {
        // Master key was removed in another window
        this.bumpSyncSecurityGeneration?.();
        this.state.masterKeyConfig = null;
        this.state.securityState = 'NO_KEY';
        this.state.unlockedKey = null;
        this.masterPassword = null;
        this.notifyStateChange();
      }
      return;
    }

    // Sync version stamps (preferences live in SYNC_PREFERENCES).
    if (key === SYNC_STORAGE_KEYS.SYNC_CONFIG) {
      const next = this.safeJsonParse<{
        autoSync?: boolean;
        interval?: number;
        localVersion?: number;
        localUpdatedAt?: number;
        remoteVersion?: number;
        remoteUpdatedAt?: number;
        syncStrategy?: unknown;
      }>(event.newValue) || {
        localVersion: 0,
        localUpdatedAt: 0,
        remoteVersion: 0,
        remoteUpdatedAt: 0,
      };

      this.state.localVersion = Number(next.localVersion ?? 0);
      this.state.localUpdatedAt = Number(next.localUpdatedAt ?? 0);
      this.state.remoteVersion = Number(next.remoteVersion ?? 0);
      this.state.remoteUpdatedAt = Number(next.remoteUpdatedAt ?? 0);

      // Legacy combined blobs from older builds may still carry preferences.
      if (hasSyncPreferenceFields(next)) {
        const separatePreferences = this.loadFromStorage?.(SYNC_STORAGE_KEYS.SYNC_PREFERENCES);
        if (!separatePreferences || typeof separatePreferences !== 'object') {
          applySyncPreferencesFromStorage.call(this, next);
        }
      }

      this.notifyStateChange();
      return;
    }

    if (key === SYNC_STORAGE_KEYS.SYNC_PREFERENCES) {
      const next = this.safeJsonParse<{
        autoSync?: boolean;
        interval?: number;
        syncStrategy?: unknown;
      }>(event.newValue) || {
        autoSync: false,
        interval: SYNC_CONSTANTS.DEFAULT_AUTO_SYNC_INTERVAL,
        syncStrategy: DEFAULT_CLOUD_SYNC_STRATEGY,
      };
      applySyncPreferencesFromStorage.call(this, next);
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

    // Plugin provider registry changes (connect/disconnect of dynamic IDs).
    if (key === SYNC_STORAGE_KEYS.PLUGIN_CLOUD_PROVIDERS) {
      const registered = listRegisteredPluginProviderIdsImpl.call(this);
      const nextProviders = { ...this.state.providers } as Record<CloudProvider, ProviderConnection>;
      for (const id of registered) {
        if (!nextProviders[id]) {
          nextProviders[id] = this.loadProviderConnection(id);
          if (this.providerWriteSeq[id] == null) this.providerWriteSeq[id] = 0;
          if (this.providerDecryptSeq[id] == null) this.providerDecryptSeq[id] = 0;
          if (this.providerDecrypted[id] == null) this.providerDecrypted[id] = false;
          if (this.providerAuthAttemptSeq[id] == null) this.providerAuthAttemptSeq[id] = 0;
        }
      }
      for (const id of Object.keys(nextProviders)) {
        if (isBuiltinCloudProvider(id)) continue;
        if (!registered.includes(id)) {
          const adapter = this.adapters.get(id);
          if (adapter) {
            adapter.signOut();
            this.adapters.delete(id);
          }
          delete nextProviders[id];
        }
      }
      this.state.providers = nextProviders;
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
    let provider = providerByKey[key] as CloudProvider | undefined;
    if (!provider && key.startsWith('netcatty_provider_plugin_v1:')) {
      provider = key.slice('netcatty_provider_plugin_v1:'.length) as CloudProvider;
    }
    if (provider) {
      // Dynamic plugin providers may receive their first storage event before
      // the registry handler initializes counters; undefined++ becomes NaN and
      // every subsequent decrypt result is discarded (NaN !== NaN).
      ensureProviderSeqCounters(this, provider);
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

        const prev = this.state.providers[provider] ?? {
          provider,
          status: 'disconnected' as const,
        };
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
        // Config may be a valid falsy scalar including JSON null — presence is
        // property existence (matches hasProviderConnectionData).
        const hasConfigProperty = Object.prototype.hasOwnProperty.call(next, 'config');
        if (nextTokens == null && !hasConfigProperty && next.credential == null) {
          if (adapter) {
            adapter.signOut();
            this.adapters.delete(provider);
          }
          this.notifyStateChange();
          return;
        }

        const tokenChanged =
          (prev.tokens?.accessToken ?? null) !== (nextTokens?.accessToken ?? null) ||
          (prev.tokens?.refreshToken ?? null) !== (nextTokens?.refreshToken ?? null) ||
          (prev.tokens?.expiresAt ?? null) !== (nextTokens?.expiresAt ?? null) ||
          (prev.tokens?.tokenType ?? null) !== (nextTokens?.tokenType ?? null) ||
          (prev.tokens?.scope ?? null) !== (nextTokens?.scope ?? null);

        // Config may be a valid falsy scalar (false, 0, "") — use nullish, not ||.
        const configChanged =
          JSON.stringify(prev.config ?? null) !== JSON.stringify(nextConfig ?? null);

        const prevCredential = prev.credential;
        const nextCredential = next.credential;
        const credentialChanged =
          (prevCredential?.kind ?? null) !== (nextCredential?.kind ?? null)
          || (prevCredential?.id ?? null) !== (nextCredential?.id ?? null)
          || (prevCredential?.key ?? null) !== (nextCredential?.key ?? null);

        const resourceChanged = (adapter?.resourceId || null) !== (next.resourceId || null);

        if (adapter && (tokenChanged || configChanged || credentialChanged || resourceChanged)) {
          adapter.signOut();
          this.adapters.delete(provider);
        }
        // Credential identity changes invalidate merge anchors the same way
        // config/resource changes do on the connect path (authMethods).
        if (credentialChanged) {
          try {
            this.removeFromStorage(this.syncBaseKey(provider));
            this.removeFromStorage(this.convergentProviderBaselineKey(provider));
            this.clearSyncAnchor(provider);
          } catch {
            // Best-effort; adapter eviction above already forces reconnect.
          }
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
    ensureProviderSeqCounters(this, provider);

    // If this provider's secrets were not successfully decrypted at
    // startup (IPC handler not registered yet), retry now.
    if (!this.providerDecrypted[provider]) {
      const conn = this.state.providers[provider];
      // Config may be a valid scalar including JSON null — presence is property existence.
      if (conn.tokens != null || Object.prototype.hasOwnProperty.call(conn, 'config')) {
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
    // Config may be a valid scalar including JSON null — presence is property existence.
    const hasConfigProperty = connection != null
      && Object.prototype.hasOwnProperty.call(connection, 'config');
    if (tokens == null && !hasConfigProperty && connection?.credential == null) {
      throw new Error('Provider not connected');
    }

    const existing = this.adapters.get(provider);
    if (existing?.isAuthenticated) {
      attachTokenRefreshPersistence.call(this, provider, existing);
      return existing;
    }

    const createPluginStorage = async (providerId: string): Promise<EncryptedObjectStorage> => {
      if (typeof this.createPluginStorage === 'function') {
        return this.createPluginStorage(providerId, connection);
      }
      if (!isPluginSyncIpcAvailable()) {
        throw new Error(
          `Plugin sync provider ${providerId} is unavailable (plugin host not enabled)`,
        );
      }
      const host = createPluginSyncIpcHost();
      // Preserve explicit null configuration (schema type: "null"); only
      // default to {} when the config property is truly absent.
      const configuration = connection != null
        && Object.prototype.hasOwnProperty.call(connection, 'config')
        ? connection.config
        : {};
      return createPluginSyncObjectStorage({
        providerId,
        host,
        configuration,
        credential: connection?.credential,
      });
    };

    const adapter = await createAdapter(
      provider,
      tokens,
      connection.resourceId,
      config,
      isBuiltinCloudProvider(provider) ? undefined : { createPluginStorage },
    );
    attachTokenRefreshPersistence.call(this, provider, adapter);
    this.adapters.set(provider, adapter);
    return adapter;
  }

/**
 * Wire an OAuth adapter's token-refresh callback so silently refreshed tokens
 * are persisted. Without this, an adapter that refreshes its access token only
 * updates memory and the next launch loads a stale token and is forced to
 * reconnect — OneDrive's rotating refresh tokens go stale after the first
 * in-session refresh (#1189), and Google's refreshed access token is likewise
 * lost on restart. OneDrive and Google expose setOnTokensRefreshed; adapters
 * without it (GitHub, WebDAV, S3) are no-ops.
 */
export function attachTokenRefreshPersistence(
  this: any,
  provider: CloudProvider,
  adapter: CloudAdapter,
): void {
  const setCallback = (adapter as {
    setOnTokensRefreshed?: (cb: (tokens: import('../../../domain/sync').OAuthTokens) => void) => void;
  }).setOnTokensRefreshed;
  if (typeof setCallback !== 'function') return;
  setCallback.call(adapter, (tokens) => {
    persistRefreshedProviderTokensImpl.call(this, provider, tokens);
  });
}

/**
 * Persist tokens that an adapter refreshed mid-session into provider state and
 * encrypted storage. Bumps the decrypt sequence so a concurrent stale decrypt
 * (startup / cross-window) can't clobber the rotated tokens; preserves the live
 * status/account/resource fields. saveProviderConnection manages its own write
 * sequence to serialize the encrypted persist.
 */
export function persistRefreshedProviderTokensImpl(
  this: any,
  provider: CloudProvider,
  tokens: import('../../../domain/sync').OAuthTokens,
): void {
  const existing = this.state.providers[provider];
  // Provider may have been disconnected during the async refresh — don't
  // resurrect a connection that no longer has credentials.
  if (!existing?.tokens) return;

  // Invalidate any in-flight decrypt (startup / cross-window) so it cannot
  // overwrite the rotated tokens we are about to commit.
  ensureProviderSeqCounters(this, provider);
  ++this.providerDecryptSeq[provider];
  this.state.providers[provider] = {
    ...existing,
    tokens,
  };
  void this.saveProviderConnection(provider, this.state.providers[provider]);
  this.notifyStateChange();
}

/**
 * Handle a sync error that means OneDrive's refresh token is dead. Clears the
 * now-useless tokens and tears down the adapter so the provider drops to a real
 * "reconnect" (disconnected) state instead of staying `error`-with-tokens —
 * which `isProviderReadyForSync` keeps treating as ready, so auto-sync would
 * otherwise retry the dead token forever and never surface a reconnect prompt.
 *
 * Returns true when it handled a reauth-required OneDrive error so the caller
 * can preserve a clean status message. No-op (returns false) for any other
 * provider or error.
 */
export function handleProviderReauthRequiredImpl(
  this: any,
  provider: CloudProvider,
  error: unknown,
): boolean {
  if (provider !== 'onedrive') return false;
  const message = error instanceof Error ? error.message : String(error);
  if (!isOneDriveReauthRequiredMessage(message)) return false;

  // Idempotent: this error can surface on multiple paths in one sync (preflight
  // inspection + the operation's own catch). Once the credentials are already
  // cleared there is nothing more to do, but still report handled so callers
  // skip the generic error status that would re-add the raw marker message.
  const current = this.state.providers[provider];
  if (!current?.tokens && !current?.config) return true;

  const adapter = this.adapters.get(provider);
  if (adapter) {
    adapter.signOut();
    this.adapters.delete(provider);
  }

  // Bump decrypt seq so a stale in-flight decrypt cannot resurrect the tokens.
  ++this.providerDecryptSeq[provider];
  this.state.providers[provider] = {
    provider,
    status: 'error',
    account: current?.account,
    error: cleanOneDriveErrorMessage(message),
  };
  void this.saveProviderConnection(provider, this.state.providers[provider]);
  this.notifyStateChange();
  return true;
}

export async function setupMasterKeyImpl(this: any,password: string): Promise<void> {
    if (this.state.masterKeyConfig) {
      throw new Error('Master key already exists. Use changeMasterKey instead.');
    }

    const config = await EncryptionService.createMasterKeyConfig(password);

    this.bumpSyncSecurityGeneration?.();
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

    // The master key configuration can rotate while the derivation below is
    // in flight (e.g. a peer window re-encrypts with the same password and
    // the storage event lands mid-await). Capture the config and security
    // generation up front so a late-completing call cannot install a key
    // derived from a stale configuration over the active one.
    const configAtStart = this.state.masterKeyConfig;
    const generationAtStart = this.getSyncSecurityGeneration?.();

    const unlockedKey = await EncryptionService.unlockMasterKey(
      password,
      configAtStart
    );

    // Superseded derivations are not password failures. Callers discard the
    // shared session password only after false, so report stale work as an
    // error before interpreting either a valid or invalid old-config result.
    if (
      this.state.masterKeyConfig !== configAtStart
      || (generationAtStart !== undefined
        && this.getSyncSecurityGeneration?.() !== generationAtStart)
      || (this.state.securityState !== 'LOCKED' && this.state.securityState !== 'UNLOCKED')
    ) {
      throw new Error('Vault changed while unlocking. Try again.');
    }
    if (!unlockedKey) return false;
    if (this.state.securityState === 'UNLOCKED') {
      // Another unlock with the same config won the race; nothing to install.
      return true;
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
    this.bumpSyncSecurityGeneration?.();
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

    const oldUnlockedKey = await EncryptionService.unlockMasterKey(
      oldPassword,
      this.state.masterKeyConfig,
    );
    const newUnlockedKey = await EncryptionService.unlockMasterKey(
      newPassword,
      newConfig,
    );
    if (!oldUnlockedKey || !newUnlockedKey) {
      throw new Error('Failed to derive keys for master key rotation');
    }

    // Local provider baselines, snapshots and the canonical CRDT replica use
    // the master-derived key. Re-encrypt them before publishing the new master
    // config so a failed rotation cannot strand records under mismatched keys.
    await this.reencryptSyncStorage(
      oldUnlockedKey.derivedKey,
      newUnlockedKey.derivedKey,
      newConfig,
    );

    this.bumpSyncSecurityGeneration?.();
    this.state.masterKeyConfig = newConfig;
    this.state.securityState = 'UNLOCKED';
    this.masterPassword = newPassword;

    this.state.unlockedKey = newUnlockedKey;

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
