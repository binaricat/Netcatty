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
  type SyncHistoryEntry,
  type WebDAVConfig,
  type S3Config,
  type SyncedFile,
} from '../../domain/sync';
import { type CloudAdapter } from './adapters';
import type { DeviceFlowState } from './adapters/GitHubAdapter';


import { type ShrinkFinding } from '../../domain/syncGuards';
// Extracted into a plain ESM module so the signature logic is covered by
// the node --test harness (see syncSignature.test.mjs). The previous
// inline implementation only hashed a handful of meta fields and was
// trivially forgeable by a misbehaving adapter; v2 hashes the full meta
// plus a prefix of the ciphertext.
import {
  startProviderAuthImpl,
  completeGitHubAuthImpl,
  completePKCEAuthImpl,
  connectConfigProviderImpl,
  resetProviderStatusImpl,
  setProviderErrorImpl,
  clearConnectingStatusImpl,
  clearProviderErrorImpl,
  cancelProviderAuthAttemptImpl,
  disconnectProviderImpl,
  updateProviderStatusImpl,
  isActiveAuthAttemptImpl,
  buildAccountFromConfigImpl,
  syncAnchorKeyImpl,
  createSyncedFileSignatureImpl as createSyncedFileSignatureMethodImpl,
  loadSyncAnchorImpl,
  saveSyncAnchorImpl,
  clearSyncAnchorImpl,
  inspectProviderRemoteStateImpl,
  checkProviderConflictImpl,
  inspectProviderRemoteImpl,
  commitRemoteInspectionImpl,
} from './cloudSync/authMethods';
import {
  uploadToProviderImpl,
  buildPayloadImpl,
  syncToProviderImpl,
  downloadFromProviderImpl,
  getGistRevisionHistoryImpl,
  downloadGistRevisionImpl,
  resolveConflictImpl,
  exitBlockedStateImpl,
  clearShrinkBlockedStateImpl,
  getShrinkBlockedFindingImpl,
} from './cloudSync/providerSyncMethods';
import {
  syncAllProvidersImpl,
  setDeviceNameImpl,
  setAutoSyncImpl,
  startAutoSyncImpl,
  stopAutoSyncImpl,
  saveSyncConfigImpl,
  syncBaseKeyImpl,
  providerAccountIdKeyImpl,
  loadProviderAccountIdImpl,
  saveProviderAccountIdImpl,
  saveSyncBaseImpl,
  loadSyncBaseImpl,
  clearSyncBaseImpl,
  addSyncHistoryEntryImpl,
  resetLocalVersionImpl,
} from './cloudSync/syncAllStorageMethods';
import {
  loadInitialStateImpl,
  loadProviderConnectionImpl,
  initProviderDecryptionImpl,
  saveProviderConnectionImpl,
  loadFromStorageImpl,
  saveToStorageImpl,
  removeFromStorageImpl,
  setupCrossWindowSyncImpl,
  safeJsonParseImpl,
  handleStorageEventImpl,
  getConnectedAdapterImpl,
  setupMasterKeyImpl,
  unlockImpl,
  lockImpl,
  changeMasterKeyImpl,
  verifyPasswordImpl,
} from './cloudSync/stateAndSecurityMethods';

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

export interface ProviderSyncAnchor {
  signature: string | null;
  version: number;
  updatedAt: number;
  deviceId?: string;
  resourceId?: string | null;
  observedAt: number;
}

interface ProviderAuthRestoreState {
  attemptId: number;
  connection: ProviderConnection;
  adapter: CloudAdapter | null;
}

export type StartProviderAuthResult =
  | { type: 'device_code'; data: DeviceFlowState & { authAttemptId: number } }
  | { type: 'url'; data: { url: string; redirectUri: string; authAttemptId: number } };

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
  private providerAuthAttemptSeq: Record<CloudProvider, number> = {
    github: 0, google: 0, onedrive: 0, webdav: 0, s3: 0,
  };
  private providerAuthRestoreState: Record<CloudProvider, ProviderAuthRestoreState | null> = {
    github: null, google: null, onedrive: null, webdav: null, s3: null,
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
    return loadInitialStateImpl.call(this);
  }

  private loadProviderConnection(provider: CloudProvider): ProviderConnection {
    return loadProviderConnectionImpl.call(this, provider);
  }

  /**
   * Asynchronously decrypt provider connection secrets after initial load.
   * Runs once at construction; decrypted tokens replace the encrypted ones
   * in-memory so adapters can use them.
   */
  private async initProviderDecryption(): Promise<void> {
    return initProviderDecryptionImpl.call(this);
  }

  private async saveProviderConnection(
    provider: CloudProvider,
    connection: ProviderConnection,
    authAttemptId?: number
  ): Promise<void> {
    return saveProviderConnectionImpl.call(this, provider, connection, authAttemptId);
  }

  private loadFromStorage<T>(key: string): T | null {
    return loadFromStorageImpl.call(this, key);
  }

  private saveToStorage(key: string, value: unknown): void {
    return saveToStorageImpl.call(this, key, value);
  }

  private removeFromStorage(key: string): void {
    return removeFromStorageImpl.call(this, key);
  }

  // ==========================================================================
  // Cross-window sync (Electron settings window, etc.)
  // ==========================================================================

  private setupCrossWindowSync(): void {
    return setupCrossWindowSyncImpl.call(this);
  }

  private safeJsonParse<T>(value: string | null): T | null {
    return safeJsonParseImpl.call(this, value);
  }

  private handleStorageEvent = (event: StorageEvent): void => {
    return handleStorageEventImpl.call(this, event);
  }

  private async getConnectedAdapter(provider: CloudProvider): Promise<CloudAdapter> {
    return getConnectedAdapterImpl.call(this, provider);
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
    return setupMasterKeyImpl.call(this, password);
  }

  /**
   * Unlock the vault with master password
   */
  async unlock(password: string): Promise<boolean> {
    return unlockImpl.call(this, password);
  }

  /**
   * Lock the vault
   */
  lock(): void {
    return lockImpl.call(this);
  }

  /**
   * Change master password
   */
  async changeMasterKey(oldPassword: string, newPassword: string): Promise<boolean> {
    return changeMasterKeyImpl.call(this, oldPassword, newPassword);
  }

  /**
   * Verify if a password is correct
   */
  async verifyPassword(password: string): Promise<boolean> {
    return verifyPasswordImpl.call(this, password);
  }

  // ==========================================================================
  // Provider Authentication
  // ==========================================================================

  /**
   * Start authentication flow for a provider
   * Returns data needed for the auth flow (device code for GitHub, URL for others).
   *
   * For PKCE providers (Google / OneDrive) the caller must supply the
   * redirect URI the loopback callback server bound to — the port is chosen
   * dynamically by the main process (#823) so it can't be hardcoded here.
   */
  async startProviderAuth(
    provider: CloudProvider,
    redirectUri?: string
  ): Promise<StartProviderAuthResult> {
    return startProviderAuthImpl.call(this, provider, redirectUri);
  }

  /**
   * Complete GitHub Device Flow authentication
   */
  async completeGitHubAuth(
    deviceCode: string,
    interval: number,
    expiresAt: number,
    onPending?: () => void,
    signal?: AbortSignal,
    authAttemptId?: number
  ): Promise<void> {
    return completeGitHubAuthImpl.call(this, deviceCode, interval, expiresAt, onPending, signal, authAttemptId);
  }

  /**
   * Complete PKCE OAuth flow (Google/OneDrive)
   */
  async completePKCEAuth(
    provider: 'google' | 'onedrive',
    code: string,
    redirectUri: string,
    authAttemptId?: number
  ): Promise<void> {
    return completePKCEAuthImpl.call(this, provider, code, redirectUri, authAttemptId);
  }

  /**
   * Connect config-based providers (WebDAV/S3)
   */
  async connectConfigProvider(
    provider: 'webdav' | 's3',
    config: WebDAVConfig | S3Config
  ): Promise<void> {
    return connectConfigProviderImpl.call(this, provider, config);
  }

  /**
   * Reset provider status to disconnected without tearing down existing connections.
   * Used when an auth attempt is cancelled/fails — avoids destroying a previously
   * working connection if the user was re-authenticating.
   */
  resetProviderStatus(provider: CloudProvider, authAttemptId?: number): void {
    return resetProviderStatusImpl.call(this, provider, authAttemptId);
  }

  setProviderError(provider: CloudProvider, error: string): void {
    return setProviderErrorImpl.call(this, provider, error);
  }

  /**
   * Release the transient 'connecting' UI state without disturbing the adapter
   * or the auth restore snapshot. Used by PKCE flows after the browser handoff
   * has succeeded, so the settings page isn't visually stuck at "connecting"
   * while we wait for the redirect callback in the background.
   */
  clearConnectingStatus(provider: CloudProvider): void {
    return clearConnectingStatusImpl.call(this, provider);
  }

  clearProviderError(provider: CloudProvider): void {
    return clearProviderErrorImpl.call(this, provider);
  }

  cancelProviderAuthAttempt(provider: CloudProvider, authAttemptId?: number): void {
    return cancelProviderAuthAttemptImpl.call(this, provider, authAttemptId);
  }

  /**
   * Disconnect a provider
   */
  async disconnectProvider(provider: CloudProvider): Promise<void> {
    return disconnectProviderImpl.call(this, provider);
  }

  private updateProviderStatus(
    provider: CloudProvider,
    status: ProviderConnection['status'],
    error?: string
  ): void {
    return updateProviderStatusImpl.call(this, provider, status, error);
  }

  private isActiveAuthAttempt(provider: CloudProvider, authAttemptId: number): boolean {
    return isActiveAuthAttemptImpl.call(this, provider, authAttemptId);
  }

  private buildAccountFromConfig(
    provider: 'webdav' | 's3',
    config: WebDAVConfig | S3Config
  ): ProviderAccount {
    return buildAccountFromConfigImpl.call(this, provider, config);
  }

  // ==========================================================================
  // Sync Operations
  // ==========================================================================

  private syncAnchorKey(provider: CloudProvider): string {
    return syncAnchorKeyImpl.call(this, provider);
  }

  private createSyncedFileSignature(syncedFile: SyncedFile | null): Promise<string | null> {
    return createSyncedFileSignatureMethodImpl.call(this, syncedFile);
  }

  private loadSyncAnchor(provider: CloudProvider): ProviderSyncAnchor | null {
    return loadSyncAnchorImpl.call(this, provider);
  }

  private async saveSyncAnchor(
    provider: CloudProvider,
    syncedFile: SyncedFile | null,
    resourceId?: string | null,
  ): Promise<void> {
    return saveSyncAnchorImpl.call(this, provider, syncedFile, resourceId);
  }

  private clearSyncAnchor(provider?: CloudProvider): void {
    return clearSyncAnchorImpl.call(this, provider);
  }

  private async inspectProviderRemoteState(
    provider: CloudProvider,
    adapter: CloudAdapter,
  ): Promise<{
    remoteChanged: boolean;
    remoteFile: SyncedFile | null;
    error?: string;
  }> {
    return inspectProviderRemoteStateImpl.call(this, provider, adapter);
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
    return checkProviderConflictImpl.call(this, provider, adapter);
  }

  async inspectProviderRemote(provider: CloudProvider): Promise<{
    remoteChanged: boolean;
    remoteFile: SyncedFile | null;
    payload: SyncPayload | null;
  }> {
    return inspectProviderRemoteImpl.call(this, provider);
  }

  async commitRemoteInspection(
    provider: CloudProvider,
    remoteFile: SyncedFile,
    payload: SyncPayload,
  ): Promise<void> {
    return commitRemoteInspectionImpl.call(this, provider, remoteFile, payload);
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
    return uploadToProviderImpl.call(this, provider, adapter, syncedFile, payloadForBase);
  }

  /**
   * Build sync payload from current app state
   */
  buildPayload(data: {
    hosts: SyncPayload['hosts'];
    keys: SyncPayload['keys'];
    proxyProfiles?: SyncPayload['proxyProfiles'];
    snippets: SyncPayload['snippets'];
    customGroups: SyncPayload['customGroups'];
    snippetPackages?: SyncPayload['snippetPackages'];
    portForwardingRules?: SyncPayload['portForwardingRules'];
    settings?: SyncPayload['settings'];
  }): SyncPayload {
    return buildPayloadImpl.call(this, data);
  }

  /**
   * Sync to a specific provider
   */
  async syncToProvider(
    provider: CloudProvider,
    payload: SyncPayload,
    opts: { overrideShrink?: boolean } = {},
  ): Promise<SyncResult> {
    return syncToProviderImpl.call(this, provider, payload, opts);
  }

  /**
   * Download and apply data from a provider
   */
  async downloadFromProvider(provider: CloudProvider): Promise<SyncPayload | null> {
    return downloadFromProviderImpl.call(this, provider);
  }

  // ========================================================================
  // Gist Revision History (#679)
  // ========================================================================

  /**
   * Get the GitHub Gist revision history. Returns an array of
   * `{ version (SHA), date }` entries, newest first.
   */
  async getGistRevisionHistory(): Promise<Array<{ version: string; date: Date }>> {
    return getGistRevisionHistoryImpl.call(this);
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
    return downloadGistRevisionImpl.call(this, sha);
  }

  /**
   * Resolve a sync conflict
   */
  async resolveConflict(resolution: ConflictResolution): Promise<SyncPayload | null> {
    return resolveConflictImpl.call(this, resolution);
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
    return exitBlockedStateImpl.call(this);
  }

  /**
   * Reset BLOCKED back to IDLE without going through a successful sync.
   * Used by post-merge round-trip to avoid wedging the manager in BLOCKED
   * when the merge already produced safe local state and the round-trip
   * push is just an optimization.
   */
  clearShrinkBlockedState(): void {
    return clearShrinkBlockedStateImpl.call(this);
  }

  /**
   * Returns the last shrink finding that triggered BLOCKED state, or
   * null if not currently blocked. Used by the renderer to hydrate the
   * SyncBlockedBanner when opening Settings after a block happened
   * off-screen.
   */
  getShrinkBlockedFinding(): Extract<ShrinkFinding, { suspicious: true }> | null {
    return getShrinkBlockedFindingImpl.call(this);
  }

  /**
   * Sync to all connected providers
   */
  async syncAllProviders(
    inputPayload?: SyncPayload,
    opts: { overrideShrink?: boolean } = {},
  ): Promise<Map<CloudProvider, SyncResult>> {
    return syncAllProvidersImpl.call(this, inputPayload, opts);
  }

  // ==========================================================================
  // Auto-Sync
  // ==========================================================================

  setDeviceName(name: string): void {
    return setDeviceNameImpl.call(this, name);
  }

  setAutoSync(enabled: boolean, intervalMinutes?: number): void {
    return setAutoSyncImpl.call(this, enabled, intervalMinutes);
  }

  private startAutoSync(): void {
    return startAutoSyncImpl.call(this);
  }

  private stopAutoSync(): void {
    return stopAutoSyncImpl.call(this);
  }

  private saveSyncConfig(): void {
    return saveSyncConfigImpl.call(this);
  }

  // ==========================================================================
  // Sync Base (three-way merge snapshot)
  // ==========================================================================

  private syncBaseKey(provider?: CloudProvider): string {
    return syncBaseKeyImpl.call(this, provider);
  }

  private providerAccountIdKey(provider: CloudProvider): string {
    return providerAccountIdKeyImpl.call(this, provider);
  }

  private loadProviderAccountId(provider: CloudProvider): string | null {
    return loadProviderAccountIdImpl.call(this, provider);
  }

  private saveProviderAccountId(provider: CloudProvider, id: string): void {
    return saveProviderAccountIdImpl.call(this, provider, id);
  }

  async saveSyncBase(payload: SyncPayload, provider?: CloudProvider): Promise<void> {
    return saveSyncBaseImpl.call(this, payload, provider);
  }

  async loadSyncBase(provider?: CloudProvider): Promise<SyncPayload | null> {
    return loadSyncBaseImpl.call(this, provider);
  }

  private clearSyncBase(): void {
    return clearSyncBaseImpl.call(this);
  }

  private addSyncHistoryEntry(entry: Omit<SyncHistoryEntry, 'id'>): void {
    return addSyncHistoryEntryImpl.call(this, entry);
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
    return resetLocalVersionImpl.call(this);
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
