/* eslint-disable @typescript-eslint/no-explicit-any */


import { EncryptionService } from '../EncryptionService';
import { createAdapter, type CloudAdapter } from '../adapters';
import type GitHubAdapter from '../adapters/GitHubAdapter';
import type GoogleDriveAdapter from '../adapters/GoogleDriveAdapter';
import type OneDriveAdapter from '../adapters/OneDriveAdapter';
import { createSyncedFileSignature as createSyncedFileSignatureCore } from '../syncSignature.js';
import { decideRemoteChanged } from '../syncAnchorDecision.js';
import type {
  CloudProvider,
  OAuthTokens,
  ProviderAccount,
  ProviderConnection,
  S3Config,
  SyncedFile,
  SyncPayload,
  WebDAVConfig,
} from '../../../domain/sync';
import type {
  ProviderSyncAnchor,
  StartProviderAuthResult,
} from '../CloudSyncManager';

const SYNC_REMOTE_ANCHOR_STORAGE_KEY = 'netcatty_sync_remote_anchor_v1';

export async function startProviderAuthImpl(this: any,
  provider: CloudProvider,
  redirectUri?: string
): Promise<StartProviderAuthResult> {
    if (provider === 'webdav' || provider === 's3') {
      throw new Error('Provider requires manual configuration');
    }
    const authAttemptId = ++this.providerAuthAttemptSeq[provider];
    this.providerAuthRestoreState[provider] = {
      attemptId: authAttemptId,
      connection: { ...this.state.providers[provider] },
      adapter: this.adapters.get(provider) ?? null,
    };
    const adapter = await createAdapter(provider);
    if (!this.isActiveAuthAttempt(provider, authAttemptId)) {
      throw new Error(`${provider} auth superseded`);
    }
    this.adapters.set(provider, adapter);

    this.updateProviderStatus(provider, 'connecting');
    try {
      if (provider === 'github') {
        // GitHub uses Device Flow
        const ghAdapter = adapter as GitHubAdapter;
        const deviceFlow = await ghAdapter.startAuth();

        return {
          type: 'device_code',
          data: { ...deviceFlow, authAttemptId },
        };
      } else {
        // Google and OneDrive use PKCE with redirect
        if (!redirectUri) {
          throw new Error(
            `startProviderAuth('${provider}') requires a redirectUri — ` +
              'call prepareOAuthCallback on the bridge first and pass its redirectUri through.'
          );
        }

        if (provider === 'google') {
          const gdAdapter = adapter as GoogleDriveAdapter;
          const url = await gdAdapter.startAuth(redirectUri);
          return { type: 'url', data: { url, redirectUri, authAttemptId } };
        } else {
          const odAdapter = adapter as OneDriveAdapter;
          const url = await odAdapter.startAuth(redirectUri);
          return { type: 'url', data: { url, redirectUri, authAttemptId } };
        }
      }
    } catch (error) {
      if (!this.isActiveAuthAttempt(provider, authAttemptId)) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CloudSync] ${provider} connect failed`, {
        error: errorMessage,
      });
      this.updateProviderStatus(provider, 'error', errorMessage);
      throw error;
    }
  }

export async function completeGitHubAuthImpl(this: any,
  deviceCode: string,
  interval: number,
  expiresAt: number,
  onPending?: () => void,
  signal?: AbortSignal,
  authAttemptId?: number
): Promise<void> {
    if (authAttemptId != null && !this.isActiveAuthAttempt('github', authAttemptId)) {
      throw new Error('github auth superseded');
    }
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

      const tokens = await ghAdapter.completeAuth(deviceCode, interval, expiresAt, onPending, signal);
      if (authAttemptId != null && !this.isActiveAuthAttempt('github', authAttemptId)) {
        throw new Error('github auth superseded');
      }
      const resourceId = await ghAdapter.initializeSync(signal);

      if (authAttemptId != null && !this.isActiveAuthAttempt('github', authAttemptId)) {
        throw new Error('github auth superseded');
      }

      ++this.providerDecryptSeq.github;
      this.state.providers.github = {
        ...this.state.providers.github,
        status: 'connected',
        tokens,
        account: ghAdapter.accountInfo || undefined,
      };

      if (resourceId) {
        this.state.providers.github.resourceId = resourceId;
      }

      await this.saveProviderConnection('github', this.state.providers.github, authAttemptId);
      if (authAttemptId != null && !this.isActiveAuthAttempt('github', authAttemptId)) {
        throw new Error('github auth superseded');
      }

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
      this.providerAuthRestoreState.github = null;
    } catch (error) {
      if (authAttemptId != null && !this.isActiveAuthAttempt('github', authAttemptId)) {
        throw error;
      }
      if (error instanceof Error && error.message.includes('auth superseded')) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        this.resetProviderStatus('github', authAttemptId);
        throw error;
      }
      this.resetProviderStatus('github', authAttemptId);
      this.setProviderError('github', String(error));
      throw error;
    }
  }

export async function completePKCEAuthImpl(this: any,
  provider: 'google' | 'onedrive',
  code: string,
  redirectUri: string,
  authAttemptId?: number
): Promise<void> {
    if (authAttemptId != null && !this.isActiveAuthAttempt(provider, authAttemptId)) {
      throw new Error(`${provider} auth superseded`);
    }
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

      if (authAttemptId != null && !this.isActiveAuthAttempt(provider, authAttemptId)) {
        throw new Error(`${provider} auth superseded`);
      }

      const resourceId = await adapter.initializeSync();

      if (authAttemptId != null && !this.isActiveAuthAttempt(provider, authAttemptId)) {
        throw new Error(`${provider} auth superseded`);
      }

      ++this.providerDecryptSeq[provider];
      this.state.providers[provider] = {
        ...this.state.providers[provider],
        status: 'connected',
        tokens,
        account: account || undefined,
      };

      if (resourceId) {
        this.state.providers[provider].resourceId = resourceId;
      }

      await this.saveProviderConnection(provider, this.state.providers[provider], authAttemptId);
      if (authAttemptId != null && !this.isActiveAuthAttempt(provider, authAttemptId)) {
        throw new Error(`${provider} auth superseded`);
      }

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
      this.providerAuthRestoreState[provider] = null;
    } catch (error) {
      if (authAttemptId != null && !this.isActiveAuthAttempt(provider, authAttemptId)) {
        throw error;
      }
      if (error instanceof Error && error.message.includes('auth superseded')) {
        throw error;
      }
      this.resetProviderStatus(provider, authAttemptId);
      this.setProviderError(provider, String(error));
      throw error;
    }
  }

export async function connectConfigProviderImpl(this: any,
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

export function resetProviderStatusImpl(this: any,provider: CloudProvider, authAttemptId?: number): void {
    const restoreState = this.providerAuthRestoreState[provider];
    if (
      authAttemptId != null &&
      restoreState &&
      restoreState.attemptId !== authAttemptId
    ) {
      return;
    }

    if (restoreState) {
      this.state.providers[provider] = { ...restoreState.connection };
      if (restoreState.adapter) {
        this.adapters.set(provider, restoreState.adapter);
      } else {
        this.adapters.delete(provider);
      }
      this.notifyStateChange();
    } else if (this.state.providers[provider]?.status === 'connecting') {
      this.updateProviderStatus(provider, 'disconnected');
      return;
    }
    if (!restoreState || authAttemptId == null || restoreState.attemptId === authAttemptId) {
      this.providerAuthRestoreState[provider] = null;
    }
  }

export function setProviderErrorImpl(this: any,provider: CloudProvider, error: string): void {
    this.updateProviderStatus(provider, 'error', error);
  }

export function clearConnectingStatusImpl(this: any,provider: CloudProvider): void {
    if (this.state.providers[provider]?.status !== 'connecting') {
      return;
    }
    this.updateProviderStatus(provider, 'disconnected');
  }

export function clearProviderErrorImpl(this: any,provider: CloudProvider): void {
    const connection = this.state.providers[provider];
    if (!connection?.error && connection?.status !== 'error') {
      return;
    }
    this.state.providers[provider] = {
      ...connection,
      status: connection.status === 'error' ? 'disconnected' : connection.status,
      error: undefined,
    };
    this.notifyStateChange();
  }

export function cancelProviderAuthAttemptImpl(this: any,provider: CloudProvider, authAttemptId?: number): void {
    if (
      authAttemptId != null &&
      !this.isActiveAuthAttempt(provider, authAttemptId)
    ) {
      return;
    }
    this.resetProviderStatus(provider, authAttemptId);
    ++this.providerAuthAttemptSeq[provider];
    const restoreState = this.providerAuthRestoreState[provider];
    if (!restoreState || authAttemptId == null || restoreState.attemptId === authAttemptId) {
      this.providerAuthRestoreState[provider] = null;
    }
  }

export async function disconnectProviderImpl(this: any,provider: CloudProvider): Promise<void> {
    this.cancelProviderAuthAttempt(provider);
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

export function updateProviderStatusImpl(this: any,
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

export function isActiveAuthAttemptImpl(this: any,provider: CloudProvider, authAttemptId: number): boolean {
    return this.providerAuthAttemptSeq[provider] === authAttemptId;
  }

export function buildAccountFromConfigImpl(this: any,
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

export function syncAnchorKeyImpl(this: any,provider: CloudProvider): string {
    return `${SYNC_REMOTE_ANCHOR_STORAGE_KEY}_${provider}`;
  }

export function createSyncedFileSignatureImpl(this: any,syncedFile: SyncedFile | null): Promise<string | null> {
    return createSyncedFileSignatureCore(syncedFile);
  }

export function loadSyncAnchorImpl(this: any,provider: CloudProvider): ProviderSyncAnchor | null {
    return this.loadFromStorage<ProviderSyncAnchor>(this.syncAnchorKey(provider));
  }

export async function saveSyncAnchorImpl(this: any,
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

export function clearSyncAnchorImpl(this: any,provider?: CloudProvider): void {
    if (provider) {
      this.removeFromStorage(this.syncAnchorKey(provider));
      return;
    }
    for (const p of ['github', 'google', 'onedrive', 'webdav', 's3'] as const) {
      this.removeFromStorage(this.syncAnchorKey(p));
    }
  }

export async function inspectProviderRemoteStateImpl(this: any,
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

export async function checkProviderConflictImpl(this: any,
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

export async function inspectProviderRemoteImpl(this: any,provider: CloudProvider): Promise<{
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

export async function commitRemoteInspectionImpl(this: any,
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
