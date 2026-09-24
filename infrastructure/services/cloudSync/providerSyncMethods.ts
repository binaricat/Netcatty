/* eslint-disable @typescript-eslint/no-explicit-any */


import packageJson from '../../../package.json';
import { EncryptionService } from '../EncryptionService';
import { mergeSyncPayloads } from '../../../domain/syncMerge';
import { stripSyncPayloadEncryptedCredentials, healPoisonedSecretsForMerge } from '../../../domain/credentials';
import { summarizeSyncChanges, withSyncReliabilityMeta } from '../../../domain/syncReliability';
import { detectSuspiciousShrink, type ShrinkFinding } from '../../../domain/syncGuards';
import { resolveCloudSyncConflictAction } from '../../../domain/syncStrategy';
import { assertConvergentSyncWriteCompatible } from '../../../domain/convergentSync';
import { getConvergentSyncLocalConfig } from '../convergentSyncConfig';
import { syncAllProvidersConvergentlyImpl } from './convergentSyncRuntimeMethods';
import type { CloudAdapter } from '../adapters';
import type GitHubAdapter from '../adapters/GitHubAdapter';
import type {
  CloudProvider,
  ConflictResolution,
  RemoteSyncPayload,
  SyncedFile,
  SyncFileMeta,
  SyncPayload,
  SyncResult,
} from '../../../domain/sync';
import { isConditionalWriteConflictError } from '../adapters/encryptedObjectStorageBridge';

function getSyncSecurityGeneration(manager: any): number | undefined {
  return typeof manager.getSyncSecurityGeneration === 'function'
    ? manager.getSyncSecurityGeneration()
    : undefined;
}

function assertSyncSecurityGeneration(manager: any, generation?: number): void {
  if (typeof manager.assertSyncSecurityGeneration === 'function') {
    manager.assertSyncSecurityGeneration(generation);
  }
}

/**
 * Let the manager clear stale credentials when an error means a provider's
 * refresh token is dead (OneDrive). Returns true when it set a reconnect state,
 * so the caller skips the generic `error`-with-tokens status that would keep the
 * provider "ready" and retrying. Safe no-op when the manager lacks the hook.
 */
function handleProviderReauthRequired(
  manager: any,
  provider: CloudProvider,
  error: unknown,
): boolean {
  return typeof manager.handleProviderReauthRequired === 'function'
    ? manager.handleProviderReauthRequired(provider, error)
    : false;
}

async function uploadLocalPayloadImpl(this: any,
  provider: CloudProvider,
  adapter: CloudAdapter,
  payload: SyncPayload,
  opts: { overrideShrink?: boolean },
  baseVersion: number,
  remoteFile?: SyncedFile | null,
  syncSecurityGeneration?: number,
): Promise<SyncResult> {
  assertConvergentSyncWriteCompatible(remoteFile?.meta, payload);
  const overrideShrinkRequested = opts.overrideShrink === true;
  const directBase = await this.loadSyncBase(provider);
  assertSyncSecurityGeneration(this, syncSecurityGeneration);
  let directRemoteRef: SyncPayload | null = null;
  if (!directBase && remoteFile) {
    assertSyncSecurityGeneration(this, syncSecurityGeneration);
    try {
      directRemoteRef = await EncryptionService.decryptPayload(
        remoteFile,
        this.masterPassword,
      );
    } catch {
      directRemoteRef = null;
    }
    assertSyncSecurityGeneration(this, syncSecurityGeneration);
  }
  const metadataBase = directBase ?? directRemoteRef;
  const payloadForUpload = withSyncReliabilityMeta(payload, metadataBase, {
    deviceId: this.state.deviceId,
    now: Date.now(),
  });
  const directShrink = detectSuspiciousShrink(payloadForUpload, directBase, directRemoteRef);
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

  const syncedFile = await EncryptionService.encryptPayload(
    payloadForUpload,
    this.masterPassword,
    this.state.deviceId,
    this.state.deviceName,
    packageJson.version,
    baseVersion,
  );
  assertSyncSecurityGeneration(this, syncSecurityGeneration);

  const result = await this.uploadToProvider(provider, adapter, syncedFile, payloadForUpload, syncSecurityGeneration);

  if (result.success) {
    this.exitBlockedState();
    this.state.syncState = 'IDLE';
    this.state.lastShrinkFinding = undefined;
  } else if (result.conflictDetected) {
    // Conflict UI / CONFLICT state already set by uploadToProvider.
  } else {
    this.state.syncState = 'ERROR';
    if (result.error) {
      this.state.lastError = result.error;
    }
  }
  return result;
}

async function downloadRemoteConflictPayloadImpl(this: any,
  provider: CloudProvider,
  remoteFile: SyncedFile,
  syncSecurityGeneration?: number,
): Promise<SyncResult> {
  let remotePayload: SyncPayload;
  assertSyncSecurityGeneration(this, syncSecurityGeneration);
  try {
    remotePayload = await EncryptionService.decryptPayload(
      remoteFile,
      this.masterPassword,
    );
  } catch (decryptError) {
    throw new Error(`Decryption failed (master password may differ between devices): ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
  }
  assertSyncSecurityGeneration(this, syncSecurityGeneration);

  this.exitBlockedState();
  this.state.syncState = 'IDLE';
  this.state.lastError = null;
  this.updateProviderStatus(provider, 'connected');

  const result: SyncResult = {
    success: true,
    provider,
    action: 'download',
    version: remoteFile.meta.version,
    mergedPayload: remotePayload,
    remoteFile,
  };
  this.emit({ type: 'SYNC_COMPLETED', provider, result });
  return result;
}

export async function uploadToProviderImpl(this: any,
  provider: CloudProvider,
  adapter: CloudAdapter,
  syncedFile: SyncedFile,
  payloadForBase?: SyncPayload,
  syncSecurityGeneration?: number,
): Promise<SyncResult> {
    try {
      assertSyncSecurityGeneration(this, syncSecurityGeneration);
      const resourceId = await adapter.upload(syncedFile, {
        signal: this.activeSyncAbortSignal,
      });
      assertSyncSecurityGeneration(this, syncSecurityGeneration);
      this.state.lastError = null;

      // Update local state. Use a monotonic max: with multiple providers
      // uploading in parallel from different bases, a later completion from a
      // stale base must not lower the global version that a concurrent
      // no-op/merge completion already advanced (e.g. v10) — otherwise the
      // next edit mints a revision below an anchored remote and regresses
      // the cloud file.
      this.state.localVersion = Math.max(this.state.localVersion ?? 0, syncedFile.meta.version);
      this.state.localUpdatedAt = Math.max(this.state.localUpdatedAt ?? 0, syncedFile.meta.updatedAt);
      this.state.remoteVersion = Math.max(this.state.remoteVersion ?? 0, syncedFile.meta.version);
      this.state.remoteUpdatedAt = Math.max(this.state.remoteUpdatedAt ?? 0, syncedFile.meta.updatedAt);
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
      // Conditional write rejected: surface as conflict so the user can pick
      // local vs remote instead of a generic sync failure.
      if (isConditionalWriteConflictError(error)) {
        try {
          const remoteFile = await adapter.download({
            signal: this.activeSyncAbortSignal,
          });
          if (remoteFile) {
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
            // Leave the provider ready (not stuck on "syncing") while the user resolves.
            this.updateProviderStatus(provider, 'connected');
            this.addSyncHistoryEntry({
              timestamp: Date.now(),
              provider,
              action: 'upload',
              success: false,
              localVersion: this.state.localVersion,
              remoteVersion: remoteFile.meta.version,
              deviceName: this.state.deviceName,
              error: String(error),
            });
            return {
              success: false,
              provider,
              action: 'none',
              conflictDetected: true,
              error: String(error),
            };
          }
        } catch {
          // Fall through to generic ERROR if we cannot load remote for the UI.
        }
      }

      this.state.lastError = String(error);
      if (!handleProviderReauthRequired(this, provider, error)) {
        this.updateProviderStatus(provider, 'error', String(error));
      }

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

export function buildPayloadImpl(this: any,data: {
  hosts: SyncPayload['hosts'];
  keys: SyncPayload['keys'];
  proxyProfiles?: SyncPayload['proxyProfiles'];
  snippets: SyncPayload['snippets'];
  customGroups: SyncPayload['customGroups'];
  snippetPackages?: SyncPayload['snippetPackages'];
  portForwardingRules?: SyncPayload['portForwardingRules'];
  settings?: SyncPayload['settings'];
}): SyncPayload {
    return {
      ...data,
      syncedAt: Date.now(),
    };
  }

export function selectConvergentSyncToProviderResult(
  provider: CloudProvider,
  results: Map<CloudProvider, SyncResult>,
): SyncResult {
  const requested = results.get(provider) ?? {
    success: false,
    provider,
    action: 'none',
    error: 'Provider is not available for convergent sync',
  } satisfies SyncResult;
  if (requested.mergedPayload) return requested;

  // Convergent sync fans out to every provider. A non-target provider can
  // verify a newer joined replica even when the requested provider fails;
  // preserve that aggregate payload so the caller can update the local vault
  // before reporting the requested provider's failure.
  const aggregateMergedPayload = [...results.values()]
    .find((result) => result.mergedPayload);
  return aggregateMergedPayload?.mergedPayload
    ? {
        ...requested,
        mergedPayload: aggregateMergedPayload.mergedPayload,
        ...(aggregateMergedPayload.mergedPayloadApplied
          ? { mergedPayloadApplied: true }
          : {}),
      }
    : requested;
}

export async function syncToProviderImpl(this: any,
  provider: CloudProvider,
  payload: SyncPayload,
  opts: {
    overrideShrink?: boolean;
    applyConvergentPayload?: (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => Promise<void>;
  } = {},
): Promise<SyncResult> {
    const convergentConfig = getConvergentSyncLocalConfig();
    if (convergentConfig.initialized) {
      if (!convergentConfig.enabled) {
        return {
          success: false,
          provider,
          action: 'none',
          error: 'Convergent sync is paused on this device',
        };
      }
      const results = await syncAllProvidersConvergentlyImpl.call(this, payload, {
        overrideShrink: opts.overrideShrink,
        applyPayload: opts.applyConvergentPayload,
      });
      return selectConvergentSyncToProviderResult(provider, results);
    }

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
    const syncSecurityGeneration = getSyncSecurityGeneration(this);

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
    assertSyncSecurityGeneration(this, syncSecurityGeneration);

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
      assertSyncSecurityGeneration(this, syncSecurityGeneration);

      if (checkResult.conflict && checkResult.remoteFile) {
        const conflictAction = resolveCloudSyncConflictAction(this.state.syncStrategy, {
          hasConflict: checkResult.conflict,
          hasRemoteFile: Boolean(checkResult.remoteFile),
        });

        if (conflictAction === 'download-remote') {
          return await downloadRemoteConflictPayloadImpl.call(
            this,
            provider,
            checkResult.remoteFile,
            syncSecurityGeneration,
          );
        }

        if (conflictAction === 'upload-local') {
          return await uploadLocalPayloadImpl.call(
            this,
            provider,
            adapter,
            payload,
            opts,
            checkResult.remoteFile.meta.version,
            checkResult.remoteFile,
            syncSecurityGeneration,
          );
        }

        let remotePayloadForConflict: SyncPayload | null = null;
        let baseForConflict: SyncPayload | null = null;

        // Remote is newer — attempt three-way merge instead of blocking
        try {
          let remotePayload: SyncPayload;
          try {
            remotePayload = await EncryptionService.decryptPayload(
              checkResult.remoteFile,
              this.masterPassword,
            );
            remotePayloadForConflict = remotePayload;
          } catch (decryptError) {
            throw new Error(`Decryption failed (master password may differ between devices): ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
          }
          assertSyncSecurityGeneration(this, syncSecurityGeneration);
          const base = await this.loadSyncBase(provider);
          baseForConflict = base;
          const localHealed = healPoisonedSecretsForMerge(payload, remotePayload, base);
          remotePayload = healPoisonedSecretsForMerge(remotePayload, payload, base);
          remotePayloadForConflict = remotePayload;
          const mergeResult = mergeSyncPayloads(base, localHealed, remotePayload);
          const mergedPayload = withSyncReliabilityMeta(
            stripSyncPayloadEncryptedCredentials(mergeResult.payload),
            base,
            {
              deviceId: this.state.deviceId,
              now: Date.now(),
            },
          );
          assertConvergentSyncWriteCompatible(checkResult.remoteFile.meta, mergedPayload);

          console.info('[CloudSyncManager] Three-way merge completed', mergeResult.summary);

          // Shrink guard: refuse to push a merged payload that silently deletes
          // entities we still have in base. The merge itself is correct if local
          // state is trustworthy — but a degraded local (keychain failure,
          // partial load) can make merge produce a smaller-than-expected result.
          const mergedShrink = detectSuspiciousShrink(mergedPayload, base, remotePayload);
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
            mergedPayload,
            this.masterPassword,
            this.state.deviceId,
            this.state.deviceName,
            packageJson.version,
            checkResult.remoteFile.meta.version, // base on remote version
          );
          assertSyncSecurityGeneration(this, syncSecurityGeneration);

          const uploadResult = await this.uploadToProvider(
            provider,
            adapter,
            mergedSyncedFile,
            mergedPayload,
            syncSecurityGeneration,
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
              mergedPayload,
            };
          }

          // Upload after merge failed — preserve CONFLICT when conditional write
          // already surfaced a conflict; otherwise mark ERROR so we leave SYNCING.
          if (!uploadResult.conflictDetected) {
            this.state.syncState = 'ERROR';
            this.state.lastError = uploadResult.error || 'Upload failed after merge';
          }
          return uploadResult;
        } catch (mergeError) {
          assertSyncSecurityGeneration(this, syncSecurityGeneration);
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
            ...(remotePayloadForConflict
              ? { changeSummary: summarizeSyncChanges(baseForConflict, payload, remotePayloadForConflict) }
              : {}),
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

      return await uploadLocalPayloadImpl.call(
        this,
        provider,
        adapter,
        payload,
        opts,
        this.state.localVersion,
        checkResult.remoteFile,
        syncSecurityGeneration,
      );

    } catch (error) {
      this.state.syncState = 'ERROR';
      this.state.lastError = String(error);
      // A dead OneDrive refresh token clears its own credentials and sets a
      // clean reconnect status; only fall back to the generic error status when
      // it wasn't a reauth-required failure.
      if (!handleProviderReauthRequired(this, provider, error)) {
        this.updateProviderStatus(provider, 'error', String(error));
      }

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

export async function downloadFromProviderImpl(this: any,provider: CloudProvider): Promise<RemoteSyncPayload | null> {
    if (this.state.securityState !== 'UNLOCKED' || !this.masterPassword) {
      throw new Error('Vault is locked');
    }

    const adapter = await this.getConnectedAdapter(provider);

    try {
      let remoteFile: SyncedFile | null;
      try {
        remoteFile = await adapter.download({
          signal: this.activeSyncAbortSignal,
        });
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

      return { provider, payload, remoteFile };
    } catch (error) {
      // Surface a reconnect state if the failure was a dead OneDrive refresh
      // token (clears stale credentials); the error is still rethrown to the
      // caller below.
      handleProviderReauthRequired(this, provider, error);
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

export async function getGistRevisionHistoryImpl(this: any): Promise<Array<{ version: string; date: Date }>> {
    let adapter: GitHubAdapter;
    try {
      adapter = await this.getConnectedAdapter('github') as GitHubAdapter;
    } catch {
      return [];
    }
    if (!adapter.getHistory) return [];
    return adapter.getHistory();
  }

export async function downloadGistRevisionImpl(this: any,sha: string): Promise<{
  payload: SyncPayload;
  meta: SyncFileMeta;
  preview: {
    hostCount: number;
    keyCount: number;
    snippetCount: number;
    noteCount: number;
    identityCount: number;
    portForwardingRuleCount: number;
  };
} | null> {
    if (this.state.securityState !== 'UNLOCKED' || !this.masterPassword) {
      throw new Error('Vault is locked');
    }
    let adapter: GitHubAdapter;
    try {
      adapter = await this.getConnectedAdapter('github') as GitHubAdapter;
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
        noteCount: payload.notes?.length ?? 0,
        identityCount: payload.identities?.length ?? 0,
        portForwardingRuleCount: payload.portForwardingRules?.length ?? 0,
      },
    };
  }

export async function resolveConflictImpl(this: any,resolution: ConflictResolution): Promise<RemoteSyncPayload | null> {
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

export function exitBlockedStateImpl(this: any): void {
    if (this.state.syncState === 'BLOCKED') {
      this.state.lastShrinkFinding = undefined;
      this.emit({ type: 'SYNC_BLOCKED_CLEARED' });
    }
  }

export function clearShrinkBlockedStateImpl(this: any): void {
    if (this.state.syncState === 'BLOCKED') {
      this.exitBlockedState();
      this.state.syncState = 'IDLE';
      this.notifyStateChange();
    }
  }

export function getShrinkBlockedFindingImpl(this: any): Extract<ShrinkFinding, { suspicious: true }> | null {
    if (this.state.syncState !== 'BLOCKED') return null;
    return this.state.lastShrinkFinding ?? null;
  }
