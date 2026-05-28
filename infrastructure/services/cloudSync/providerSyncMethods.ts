/* eslint-disable @typescript-eslint/no-explicit-any */


import packageJson from '../../../package.json';
import { EncryptionService } from '../EncryptionService';
import { mergeSyncPayloads } from '../../../domain/syncMerge';
import { detectSuspiciousShrink, type ShrinkFinding } from '../../../domain/syncGuards';
import type { CloudAdapter } from '../adapters';
import type GitHubAdapter from '../adapters/GitHubAdapter';
import type {
  CloudProvider,
  ConflictResolution,
  SyncedFile,
  SyncFileMeta,
  SyncPayload,
  SyncResult,
} from '../../../domain/sync';

export async function uploadToProviderImpl(this: any,
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

export async function syncToProviderImpl(this: any,
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
          const mergedShrink = detectSuspiciousShrink(mergeResult.payload, base, remotePayload);
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
      // refuse a payload that drops entities versus the stored base. When the
      // stored base is absent (first sync, re-auth, or decrypt failure) fall
      // back to the current remote payload if one exists — the guard must
      // have *some* reference to catch a degraded local from wiping the
      // cloud (#779).
      const directBase = await this.loadSyncBase(provider);
      let directRemoteRef: SyncPayload | null = null;
      if (!directBase && checkResult.remoteFile) {
        try {
          directRemoteRef = await EncryptionService.decryptPayload(
            checkResult.remoteFile,
            this.masterPassword,
          );
        } catch {
          // Decrypt failure means we can't trust the remote contents as a
          // reference; leave `null` and let the guard return not-suspicious
          // rather than block on garbage. The upload itself will likely fail
          // downstream if the password mismatch is real.
          directRemoteRef = null;
        }
      }
      const directShrink = detectSuspiciousShrink(payload, directBase, directRemoteRef);
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

export async function downloadFromProviderImpl(this: any,provider: CloudProvider): Promise<SyncPayload | null> {
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
        identityCount: payload.identities?.length ?? 0,
        portForwardingRuleCount: payload.portForwardingRules?.length ?? 0,
      },
    };
  }

export async function resolveConflictImpl(this: any,resolution: ConflictResolution): Promise<SyncPayload | null> {
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
