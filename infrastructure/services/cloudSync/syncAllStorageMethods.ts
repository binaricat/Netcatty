/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  SYNC_CONSTANTS,
  SYNC_STORAGE_KEYS,
  isProviderReadyForSync,
} from '../../../domain/sync';
import packageJson from '../../../package.json';
import { EncryptionService } from '../EncryptionService';
import { mergeSyncPayloads } from '../../../domain/syncMerge';
import {
  SYNC_SNAPSHOT_LIMIT,
  summarizeSyncChanges,
  withSyncReliabilityMeta,
} from '../../../domain/syncReliability';
import { detectSuspiciousShrink, type ShrinkFinding } from '../../../domain/syncGuards';
import { resolveCloudSyncConflictAction, type CloudSyncConflictAction } from '../../../domain/syncStrategy';
import { assertConvergentSyncWriteCompatible } from '../../../domain/convergentSync';
import type { CloudAdapter } from '../adapters';
import type {
  CloudProvider,
  ProviderConnection,
  SyncedFile,
  SyncHistoryEntry,
  SyncSnapshotEntry,
  SyncPayload,
  SyncResult,
} from '../../../domain/sync';
import {
  decryptLocalStorageValue,
  encryptLocalStorageValue,
} from './encryptedLocalStorage';

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

async function downloadRemoteForSyncAllImpl(this: any,
  provider: CloudProvider,
  remoteFile: SyncedFile,
  syncSecurityGeneration?: number,
): Promise<SyncResult> {
  assertSyncSecurityGeneration(this, syncSecurityGeneration);
  const payload = await EncryptionService.decryptPayload(remoteFile, this.masterPassword);
  assertSyncSecurityGeneration(this, syncSecurityGeneration);
  this.updateProviderStatus(provider, 'connected');

  const result: SyncResult = {
    success: true,
    provider,
    action: 'download',
    version: remoteFile.meta.version,
    mergedPayload: payload,
    remoteFile,
  };
  this.emit({ type: 'SYNC_COMPLETED', provider, result });
  return result;
}

const SYNC_HISTORY_STORAGE_KEY = 'netcatty_sync_history_v1';
const SYNC_SNAPSHOTS_STORAGE_KEY = 'netcatty_sync_snapshots_v1';

async function loadRawSyncBase(this: any, provider?: CloudProvider): Promise<SyncPayload | null> {
  const key = this.state.unlockedKey?.derivedKey;
  if (!key || typeof this.loadFromStorage !== 'function') return null;
  const encoded = this.loadFromStorage(this.syncBaseKey(provider));
  if (!encoded || typeof encoded !== 'string') return null;
  return decryptLocalStorageValue<SyncPayload>(encoded, key);
}

async function rememberCurrentSyncBaseSnapshot(this: any, provider?: CloudProvider): Promise<void> {
  if (typeof this.syncSnapshotsKey !== 'function') return;
  const previous = await loadRawSyncBase.call(this, provider);
  if (!previous) return;
  const snapshots = await loadSyncSnapshotsImpl.call(this, provider);
  const entry: SyncSnapshotEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    ...(provider ? { provider } : {}),
    payload: previous,
  };
  await saveSyncSnapshotsImpl.call(this, [entry, ...snapshots].slice(0, SYNC_SNAPSHOT_LIMIT), provider);
}

export async function syncAllProvidersImpl(this: any,
  inputPayload?: SyncPayload,
  opts: { overrideShrink?: boolean; conflictActionOverride?: CloudSyncConflictAction } = {},
): Promise<Map<CloudProvider, SyncResult>> {
    const results = new Map<CloudProvider, SyncResult>();
    let payload = inputPayload;
    let wasMerged = false;

    const overrideShrinkRequested = opts.overrideShrink === true;
    const syncSecurityGeneration = getSyncSecurityGeneration(this);

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

    const connectedProviders = Object.entries(
      this.state.providers as Record<CloudProvider, ProviderConnection>,
    )
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

        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        const check = await this.checkProviderConflict(provider, adapter);
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
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
          // Surface the same finding to the UI so multi-account / intentionally
          // diverged configurations can be warned visibly instead of silently
          // having one provider's data merged over another's (#779 follow-up).
          this.emit({
            type: 'PROVIDERS_DIVERGED',
            summaries: summaries.map((s) => ({
              provider: s.provider as CloudProvider,
              hosts: s.hosts,
              keys: s.keys,
              snippets: s.snippets,
            })),
          });
        }
      } catch (diagError) {
        // Non-fatal diagnostic; never let it block the sync.
        console.warn('[CloudSyncManager] syncAll: base-divergence check failed:', diagError);
      }
    }

    if (conflicts.length > 0) {
      const conflictAction = opts.conflictActionOverride
        ?? resolveCloudSyncConflictAction(this.state.syncStrategy, {
          hasConflict: true,
          hasRemoteFile: true,
        });

      if (conflictAction === 'download-remote') {
        const newestConflict = conflicts.reduce((latest, entry) => {
          const latestUpdatedAt = latest.check?.remoteFile?.meta.updatedAt ?? 0;
          const entryUpdatedAt = entry.check?.remoteFile?.meta.updatedAt ?? 0;
          return entryUpdatedAt > latestUpdatedAt ? entry : latest;
        });
        try {
          const remoteResult = await downloadRemoteForSyncAllImpl.call(
            this,
            newestConflict.provider as CloudProvider,
            newestConflict.check!.remoteFile!,
            syncSecurityGeneration,
          );
          const sourceProvider = newestConflict.provider as CloudProvider;
          results.set(sourceProvider, remoteResult);
          payload = remoteResult.mergedPayload ?? payload;

          for (const r of checkResults) {
            const provider = r.provider as CloudProvider;
            if (provider === sourceProvider) continue;
            if (r.check) {
              r.check.conflict = false;
            }
          }
        } catch (error) {
          const msg = String(error);
          this.state.syncState = 'ERROR';
          this.state.lastError = msg;
          this.updateProviderStatus(newestConflict.provider as CloudProvider, 'error', msg);
          this.emit({ type: 'SYNC_ERROR', provider: newestConflict.provider as CloudProvider, error: msg });
          results.set(newestConflict.provider as CloudProvider, {
            success: false,
            provider: newestConflict.provider as CloudProvider,
            action: 'none',
            error: msg,
          });
          return results;
        }
      }

      if (conflictAction === 'upload-local') {
        for (const r of checkResults) {
          if (r.check) r.check.conflict = false;
        }
      } else if (conflictAction === 'smart-merge') {
        // Three-way merge: incorporate remote data from every conflicting provider
        try {
          let merged = payload;
          for (const c of conflicts) {
            const providerBase = await this.loadSyncBase(c.provider as CloudProvider);
            const remotePayload = await EncryptionService.decryptPayload(
              c.check!.remoteFile!,
              this.masterPassword,
            );
            assertSyncSecurityGeneration(this, syncSecurityGeneration);
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
          assertSyncSecurityGeneration(this, syncSecurityGeneration);
          // Merge failed — fall back to conflict UI
          console.error('[CloudSyncManager] syncAll: merge failed', mergeError);
          const { provider, check } = conflicts[0];
          const remoteFile = check!.remoteFile!;
          let conflictSummary;
          try {
            assertSyncSecurityGeneration(this, syncSecurityGeneration);
            const base = await this.loadSyncBase(provider as CloudProvider);
            const remotePayload = await EncryptionService.decryptPayload(remoteFile, this.masterPassword);
            assertSyncSecurityGeneration(this, syncSecurityGeneration);
            conflictSummary = summarizeSyncChanges(
              base,
              payload,
              remotePayload,
            );
          } catch {
            conflictSummary = undefined;
          }
          assertSyncSecurityGeneration(this, syncSecurityGeneration);

          this.state.syncState = 'CONFLICT';
          this.state.currentConflict = {
            provider: provider as CloudProvider,
            localVersion: this.state.localVersion,
            localUpdatedAt: this.state.localUpdatedAt,
            localDeviceName: this.state.deviceName,
            remoteVersion: remoteFile.meta.version,
            remoteUpdatedAt: remoteFile.meta.updatedAt,
            remoteDeviceName: remoteFile.meta.deviceName,
            ...(conflictSummary ? { changeSummary: conflictSummary } : {}),
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
      // When no stored base exists, fall back to the remote payload fetched
      // during the parallel check above — the shrink guard needs a reference
      // or it fails open and lets degraded local state overwrite remote
      // (#779). checkResults carries the per-provider remoteFile already.
      let providerRemoteRef: SyncPayload | null = null;
      if (!providerBase) {
        const entry = checkResults.find((r) => r.provider === provider);
        const remoteFile = entry?.check?.remoteFile;
        if (remoteFile) {
          assertSyncSecurityGeneration(this, syncSecurityGeneration);
          try {
            providerRemoteRef = await EncryptionService.decryptPayload(
              remoteFile,
              this.masterPassword,
            );
          } catch {
            providerRemoteRef = null;
          }
          assertSyncSecurityGeneration(this, syncSecurityGeneration);
        }
      }
      const finding = detectSuspiciousShrink(payload, providerBase, providerRemoteRef);
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
      if (Array.from(results.values()).some((r) => r.success)) {
        this.exitBlockedState();
        this.state.syncState = 'IDLE';
      } else {
        this.state.syncState = 'ERROR';
      }
      this.notifyStateChange();
      return results;
    }

    // Use the highest version as base: either local or any remote that was merged
    let baseVersion = this.state.localVersion;
    if (wasMerged || (this.state.syncStrategy !== 'smartMerge' && conflicts.length > 0)) {
      for (const c of conflicts) {
        const rv = c.check?.remoteFile?.meta?.version ?? 0;
        if (rv > baseVersion) baseVersion = rv;
      }
    }

    // 4. Parallel Uploads — each provider gets metadata derived from its own
    // base, then that exact payload is persisted as the provider base
    // inside uploadToProvider BEFORE the per-provider anchor advances.
    // Ordering matters: a crash between the two writes must leave the
    // stale anchor re-triggering inspection on next startup, not a
    // fresh anchor paired with a stale base.
    const uploadTasks = validUploads.map(async ({ provider, adapter }) => {
      try {
        const entry = checkResults.find((result) => result.provider === provider);
        assertConvergentSyncWriteCompatible(entry?.check?.remoteFile?.meta, payload);
        const providerBase = await this.loadSyncBase(provider);
        let providerRemoteRef: SyncPayload | null = null;
        if (!providerBase) {
          const remoteFile = entry?.check?.remoteFile;
          if (remoteFile) {
            assertSyncSecurityGeneration(this, syncSecurityGeneration);
            try {
              providerRemoteRef = await EncryptionService.decryptPayload(
                remoteFile,
                this.masterPassword,
              );
            } catch {
              providerRemoteRef = null;
            }
            assertSyncSecurityGeneration(this, syncSecurityGeneration);
          }
        }
        const providerPayload = withSyncReliabilityMeta(payload, providerBase ?? providerRemoteRef, {
          deviceId: this.state.deviceId,
          now: Date.now(),
        });
        const syncedFile = await EncryptionService.encryptPayload(
          providerPayload,
          this.masterPassword,
          this.state.deviceId,
          this.state.deviceName,
          packageJson.version,
          baseVersion
        );
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        const result = await this.uploadToProvider(provider, adapter, syncedFile, providerPayload, syncSecurityGeneration);
        results.set(provider, result);
      } catch (error) {
        const msg = String(error);
        this.state.lastError = msg;
        this.updateProviderStatus(provider, 'error', msg);
        this.emit({ type: 'SYNC_ERROR', provider, error: msg });
        results.set(provider, {
          success: false,
          provider,
          action: 'none',
          error: msg,
        });
      }
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

export function setDeviceNameImpl(this: any,name: string): void {
    this.state.deviceName = name;
    this.saveToStorage(SYNC_STORAGE_KEYS.DEVICE_NAME, name);
    this.notifyStateChange();
  }

export function setAutoSyncImpl(this: any,enabled: boolean, intervalMinutes?: number): void {
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

export function startAutoSyncImpl(this: any): void {
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

export function stopAutoSyncImpl(this: any): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

export function saveSyncConfigImpl(this: any): void {
    this.saveToStorage(SYNC_STORAGE_KEYS.SYNC_CONFIG, {
      autoSync: this.state.autoSyncEnabled,
      interval: this.state.autoSyncInterval,
      localVersion: this.state.localVersion,
      localUpdatedAt: this.state.localUpdatedAt,
      remoteVersion: this.state.remoteVersion,
      remoteUpdatedAt: this.state.remoteUpdatedAt,
      syncStrategy: this.state.syncStrategy,
    });
  }

export function syncBaseKeyImpl(this: any,provider?: CloudProvider): string {
    const suffix = provider ? `_${provider}` : '';
    return `${SYNC_STORAGE_KEYS.SYNC_BASE_PAYLOAD}${suffix}`;
  }

export function providerAccountIdKeyImpl(this: any,provider: CloudProvider): string {
    return `netcatty.sync.accountId.${provider}`;
  }

export function loadProviderAccountIdImpl(this: any,provider: CloudProvider): string | null {
    const stored = this.loadFromStorage(this.providerAccountIdKey(provider));
    return typeof stored === 'string' ? stored : null;
  }

export function saveProviderAccountIdImpl(this: any,provider: CloudProvider, id: string): void {
    this.saveToStorage(this.providerAccountIdKey(provider), id);
  }

export async function saveSyncBaseImpl(this: any,payload: SyncPayload, provider?: CloudProvider): Promise<void> {
    const key = this.state.unlockedKey?.derivedKey;
    if (!key) {
      throw new Error('Sync base encryption key is unavailable');
    }
    try {
      try {
        await rememberCurrentSyncBaseSnapshot.call(this, provider);
      } catch (snapshotError) {
        console.warn('[CloudSyncManager] Failed to save previous sync snapshot', snapshotError);
      }
      if (
        this.saveToStorage(
          this.syncBaseKey(provider),
          await encryptLocalStorageValue(payload, key),
        ) === false
      ) {
        throw new Error('Unable to persist sync base');
      }
    } catch (error) {
      console.warn('[CloudSyncManager] Failed to save sync base', error);
      throw error;
    }
  }

export async function loadSyncBaseImpl(this: any,provider?: CloudProvider): Promise<SyncPayload | null> {
    const key = this.state.unlockedKey?.derivedKey;
    if (!key) return null;
    try {
      const encoded = this.loadFromStorage(this.syncBaseKey(provider)) as unknown;
      if (!encoded || typeof encoded !== 'string') return null;
      return decryptLocalStorageValue<SyncPayload>(encoded, key);
    } catch {
      return null;
    }
  }

export function syncSnapshotsKeyImpl(this: any,provider?: CloudProvider): string {
    const suffix = provider ? `_${provider}` : '';
    return `${SYNC_SNAPSHOTS_STORAGE_KEY}${suffix}`;
  }

export async function loadSyncSnapshotsImpl(this: any,provider?: CloudProvider): Promise<SyncSnapshotEntry[]> {
    const key = this.state.unlockedKey?.derivedKey;
    if (!key) return [];
    try {
      const encoded = this.loadFromStorage(this.syncSnapshotsKey(provider)) as unknown;
      if (!encoded || typeof encoded !== 'string') return [];
      const snapshots = await decryptLocalStorageValue<SyncSnapshotEntry[]>(encoded, key);
      return Array.isArray(snapshots) ? snapshots : [];
    } catch {
      return [];
    }
  }

export async function saveSyncSnapshotsImpl(this: any,snapshots: SyncSnapshotEntry[], provider?: CloudProvider): Promise<void> {
    const key = this.state.unlockedKey?.derivedKey;
    if (!key) {
      throw new Error('Sync snapshot encryption key is unavailable');
    }
    if (this.saveToStorage(
      this.syncSnapshotsKey(provider),
      await encryptLocalStorageValue(snapshots.slice(0, SYNC_SNAPSHOT_LIMIT), key),
    ) === false) throw new Error('Unable to persist sync snapshots');
  }

export function clearSyncBaseImpl(this: any): void {
    this.removeFromStorage(SYNC_STORAGE_KEYS.SYNC_BASE_PAYLOAD);
    if (typeof this.syncSnapshotsKey === 'function') {
      this.removeFromStorage(this.syncSnapshotsKey());
    }
    for (const p of ['github', 'google', 'onedrive', 'webdav', 's3'] as const) {
      this.removeFromStorage(this.syncBaseKey(p));
      this.removeFromStorage(this.convergentProviderBaselineKey(p));
      if (typeof this.syncSnapshotsKey === 'function') {
        this.removeFromStorage(this.syncSnapshotsKey(p));
      }
    }
    this.clearSyncAnchor();
  }

export function addSyncHistoryEntryImpl(this: any,entry: Omit<SyncHistoryEntry, 'id'>): void {
    const newEntry: SyncHistoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
    };

    // Keep only the last 50 entries
    this.state.syncHistory = [newEntry, ...this.state.syncHistory].slice(0, 50);
    this.saveToStorage(SYNC_HISTORY_STORAGE_KEY, this.state.syncHistory);
    this.notifyStateChange(); // Notify UI of new history entry
  }

export function resetLocalVersionImpl(this: any): void {
    this.state.localVersion = 0;
    this.state.localUpdatedAt = 0;
    this.state.syncHistory = [];
    this.saveSyncConfig();
    this.saveToStorage(SYNC_HISTORY_STORAGE_KEY, []);
    this.clearSyncBase();
    this.clearSyncAnchor();
    this.notifyStateChange();
  }
