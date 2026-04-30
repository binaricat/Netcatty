/**
 * useAutoSync - Auto-sync Hook for Cloud Sync
 * 
 * Provides automatic sync capabilities:
 * - Sync when data changes (hosts, keys, snippets, port forwarding rules)
 * - Check remote version on app startup
 * - Debounced sync to avoid too frequent API calls
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCloudSync } from './useCloudSync';
import { useI18n } from '../i18n/I18nProvider';
import { getCloudSyncManager } from '../../infrastructure/services/CloudSyncManager';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  findSyncPayloadEncryptedCredentialPaths,
} from '../../domain/credentials';
import { isProviderReadyForSync, type CloudProvider, type SyncPayload } from '../../domain/sync';
import { collectSyncableSettings, hasMeaningfulCloudSyncData } from '../syncPayload';
import { readInterruptedVaultApply } from '../localVaultBackups';
import {
  STORAGE_KEY_PORT_FORWARDING,
  STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL,
} from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { notify } from '../notification';

interface AutoSyncConfig {
  // Data to sync
  hosts: SyncPayload['hosts'];
  keys: SyncPayload['keys'];
  identities?: SyncPayload['identities'];
  snippets: SyncPayload['snippets'];
  customGroups: SyncPayload['customGroups'];
  snippetPackages?: SyncPayload['snippetPackages'];
  portForwardingRules?: SyncPayload['portForwardingRules'];
  groupConfigs?: SyncPayload['groupConfigs'];
  /** Opaque token that changes whenever a synced setting changes. */
  settingsVersion?: number;
  startupReady?: boolean;

  // Callbacks
  onApplyPayload: (payload: SyncPayload) => void | Promise<void>;
}

// Get manager singleton for direct state access
const manager = getCloudSyncManager();
const AUTO_SYNC_PROVIDER_ORDER: CloudProvider[] = ['github', 'google', 'onedrive', 'webdav', 's3'];

// Cross-window restore barrier: stored as an epoch-ms deadline. Any value
// in the future means a restore is applying in some window and auto-sync
// must not push concurrently. The writer (`withRestoreBarrier`) heartbeats
// the deadline to keep it alive; a crashed window naturally expires within
// ~RESTORE_BARRIER_HOLD_MS. We still defend against two degenerate cases:
// (1) a stale deadline sitting in the past — harmless but pollutes debug
//     state, so we opportunistically clear it; (2) a deadline absurdly far
//     in the future (clock skew between windows, pathological holdMs, or a
//     tampered value) — would otherwise lock auto-sync indefinitely, so we
//     clear it and treat the barrier as inactive.
const RESTORE_BARRIER_SANITY_MAX_MS = 10 * 60 * 1000; // 10 minutes
const isRestoreInProgress = (): boolean => {
  const raw = localStorageAdapter.readNumber(STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL);
  if (typeof raw !== 'number' || raw <= 0) return false;
  const now = Date.now();
  if (raw <= now) {
    // Deadline is in the past — either a clean finish that failed to
    // overwrite the key, or a crashed heartbeat. Clear so subsequent
    // reads are cheap and the key doesn't linger forever.
    localStorageAdapter.writeNumber(STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL, 0);
    return false;
  }
  if (raw - now > RESTORE_BARRIER_SANITY_MAX_MS) {
    console.warn(
      '[useAutoSync] Restore barrier deadline is absurdly far in the future; treating as corrupt and clearing.',
      { deadline: raw, now },
    );
    localStorageAdapter.writeNumber(STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL, 0);
    return false;
  }
  return true;
};

type SyncTrigger = 'auto' | 'manual';

interface SyncNowOptions {
  trigger?: SyncTrigger;
}

export const useAutoSync = (config: AutoSyncConfig) => {
  const { t } = useI18n();
  const sync = useCloudSync();
  const { onApplyPayload } = config;
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncedDataRef = useRef<string>('');
  const hasCheckedRemoteRef = useRef(false);
  /** True once checkRemoteVersion has completed (success or failure). Until
   *  this is set, the debounced auto-sync effect will not fire, preventing
   *  an empty local vault from racing ahead and overwriting a non-empty
   *  cloud vault before the startup pull has run. See #679. */
  const remoteCheckDoneRef = useRef(false);
  const isInitializedRef = useRef(false);
  const isSyncRunningRef = useRef(false);
  const skipNextSyncRef = useRef(false);

  // State for the empty-vault-vs-cloud confirmation dialog (Fix D).
  // When checkRemoteVersion detects that the local vault is empty but
  // the cloud has data, it pauses and exposes this state so the root
  // component can render a confirmation dialog.
  const [emptyVaultConflict, setEmptyVaultConflict] = useState<{
    remotePayload: SyncPayload;
    hostCount: number;
    keyCount: number;
    snippetCount: number;
  } | null>(null);
  const emptyVaultResolveRef = useRef<((action: 'restore' | 'keep-empty') => void) | null>(null);

  // Listen for SFTP bookmark changes to trigger auto-sync
  const [bookmarksVersion, setBookmarksVersion] = useState(0);
  useEffect(() => {
    const handler = () => setBookmarksVersion((v) => v + 1);
    window.addEventListener('sftp-bookmarks-changed', handler);
    return () => window.removeEventListener('sftp-bookmarks-changed', handler);
  }, []);

  const getSyncSnapshot = useCallback(() => {
    let effectivePFRules = config.portForwardingRules;
    if (!effectivePFRules || effectivePFRules.length === 0) {
      const stored = localStorageAdapter.read<SyncPayload['portForwardingRules']>(
        STORAGE_KEY_PORT_FORWARDING,
      );
      if (stored && Array.isArray(stored) && stored.length > 0) {
        effectivePFRules = stored.map((rule) => ({
          ...rule,
          status: 'inactive' as const,
          error: undefined,
          lastUsedAt: undefined,
        }));
      }
    }

    return {
      hosts: config.hosts,
      keys: config.keys,
      identities: config.identities,
      snippets: config.snippets,
      customGroups: config.customGroups,
      snippetPackages: config.snippetPackages,
      portForwardingRules: effectivePFRules,
      groupConfigs: config.groupConfigs,
    };
  }, [
    config.hosts,
    config.keys,
    config.identities,
    config.snippets,
    config.customGroups,
    config.snippetPackages,
    config.portForwardingRules,
    config.groupConfigs,
  ]);

  // Build sync payload
  const buildPayload = useCallback((): SyncPayload => {
    return {
      ...getSyncSnapshot(),
      settings: collectSyncableSettings(),
      syncedAt: Date.now(),
    };
  }, [getSyncSnapshot]);
  
  // Create a hash of current data for comparison (includes settings)
  const getDataHash = useCallback(() => {
    return JSON.stringify({ ...getSyncSnapshot(), settings: collectSyncableSettings() });
  }, [getSyncSnapshot]);
  
  // Sync now handler - get fresh state directly from manager
  const syncNow = useCallback(async (options?: SyncNowOptions) => {
    const trigger: SyncTrigger = options?.trigger ?? 'auto';

    isSyncRunningRef.current = true;
    try {
      // Get fresh state directly from CloudSyncManager singleton
      let state = manager.getState();

      const hasProvider = Object.values(state.providers).some((provider) => isProviderReadyForSync(provider));
      const syncing = state.syncState === 'SYNCING';

      if (!hasProvider) {
        throw new Error(t('sync.autoSync.noProvider'));
      }
      if (syncing) {
        if (trigger === 'auto') {
          console.info('[AutoSync] Skipping overlapping auto-sync because another sync is already running.');
          return;
        }
        throw new Error(t('sync.autoSync.alreadySyncing'));
      }

      // Cross-window guard: another window may be in the middle of
      // applying a local vault restore. If we push right now we'd upload
      // the pre-restore snapshot (the main window's React state hasn't
      // observed the localStorage writes yet), clobbering the just-
      // restored cloud copy. Skip silently on auto triggers and fail
      // loudly on manual ones so the user understands why their click
      // did nothing.
      //
      // Pairs with `withRestoreBarrier` in application/localVaultBackups.ts
      // (the writer) and with the matching early-return in the
      // debounced-sync effect below (the other reader, which prevents
      // scheduling a push while the barrier is held).
      if (isRestoreInProgress()) {
        if (trigger === 'auto') {
          console.info('[AutoSync] Skipping: a vault restore is in progress in another window.');
          return;
        }
        throw new Error(t('sync.autoSync.restoreInProgress'));
      }

      // Refuse to auto-push when a previous apply crashed mid-way and
      // left the vault in a partial state. `applyProtectedSyncPayload`
      // sets a sentinel before its non-atomic localStorage writes and
      // clears it on successful completion; the sentinel's presence
      // here means the renderer crashed between a first write and the
      // clean-up, so the in-memory payload is a mix of pre-apply and
      // post-apply entries. Pushing that would silently overwrite an
      // intact cloud copy with corrupted data.
      //
      // Manual triggers surface a user-visible error that points the
      // user at the Restore UI; auto triggers return quietly (the
      // next startup toast below flags the state).
      const interruptedApply = readInterruptedVaultApply();
      if (interruptedApply) {
        if (trigger === 'auto') {
          console.warn(
            '[AutoSync] Skipping: previous apply was interrupted — refusing to push partial state.',
            interruptedApply,
          );
          return;
        }
        throw new Error(t('sync.autoSync.interruptedApplyMessage'));
      }

      // If another window unlocked, reuse the in-memory session password from main process.
      if (state.securityState !== 'UNLOCKED') {
        const bridge = netcattyBridge.get();
        const sessionPassword = await bridge?.cloudSyncGetSessionPassword?.();
        if (sessionPassword) {
          const ok = await sync.unlock(sessionPassword);
          if (!ok) {
            void bridge?.cloudSyncClearSessionPassword?.();
          }
        }
      }

      // Re-check after unlock attempt
      state = manager.getState();
      if (state.securityState !== 'UNLOCKED') {
        throw new Error(t('sync.autoSync.vaultLocked'));
      }

      const dataHash = getDataHash();
      const payload = buildPayload();
      const encryptedCredentialPaths = findSyncPayloadEncryptedCredentialPaths(payload);
      if (encryptedCredentialPaths.length > 0) {
        console.warn('[AutoSync] Blocked: encrypted credential placeholders found at:', encryptedCredentialPaths.join(', '));
        throw new Error(t('sync.credentialsUnavailable'));
      }

      // Refuse to push an empty vault to cloud. This is almost always
      // a sign that the local state was lost (update, import failure,
      // storage corruption) rather than a deliberate "delete everything".
      // Both auto and manual triggers are blocked; the user can still
      // use Force Push from the SyncBlocked banner if they genuinely
      // want to wipe the cloud.
      //
      // This pairs with the inspect-failure "fail open" behavior in
      // checkRemoteVersion below: if inspect transiently errors we still
      // let auto-sync run, trusting this guard to refuse if local is
      // truly empty rather than letting an empty state clobber remote.
      if (!hasMeaningfulCloudSyncData(payload)) {
        if (trigger === 'auto') {
          console.warn('[AutoSync] Blocked: refusing to auto-sync an empty vault to cloud');
          return;
        }
        throw new Error(t('sync.autoSync.emptyVaultManual'));
      }

      const results = await sync.syncNow(payload);

      // Apply merged payloads first (before checking for failures) so local
      // state gets updated even when some providers failed
      for (const result of results.values()) {
        if (result.mergedPayload) {
          await Promise.resolve(onApplyPayload(result.mergedPayload));
          skipNextSyncRef.current = true;
          break; // All providers share the same merged payload
        }
      }

      for (const result of results.values()) {
        if (!result.success) {
          if (result.conflictDetected) {
            throw new Error(t('sync.autoSync.conflictDetected'));
          }
          throw new Error(result.error || t('sync.autoSync.syncFailed'));
        }
      }

      lastSyncedDataRef.current = dataHash;

      // Successful sync implies a successful per-provider
      // `checkProviderConflict` (which inspects remote) — equivalent
      // to a successful startup reconciliation from the auto-sync
      // gate's point of view. Opening the gate here is the escape
      // hatch when a network outage exhausted the startup retry
      // timer: a user-triggered manual sync (or any first successful
      // auto sync that somehow ran anyway) resumes auto-sync for the
      // rest of the session. Without this, a degraded-startup session
      // would require the user to manually sync after every edit.
      hasCheckedRemoteRef.current = true;
      remoteCheckDoneRef.current = true;
    } catch (error) {
      if (trigger === 'manual') {
        throw error;
      }
      console.error('[AutoSync] Sync failed:', error);
      notify.error(
        error instanceof Error ? error.message : t('common.unknownError'),
        t('sync.autoSync.failedTitle'),
      );
    } finally {
      isSyncRunningRef.current = false;
    }
  }, [sync, buildPayload, getDataHash, onApplyPayload, t]);

  // One-shot toast per mount when a previous apply was interrupted, so the
  // user understands why auto-sync is silently paused and where to go to
  // recover. `applyProtectedSyncPayload` clears the sentinel on a clean
  // apply, so this only fires once per genuine crash and naturally stops
  // after the user completes a recovery.
  const interruptedApplyNotifiedRef = useRef(false);
  useEffect(() => {
    if (interruptedApplyNotifiedRef.current) return;
    if (!sync.isUnlocked) return;
    const interrupted = readInterruptedVaultApply();
    if (!interrupted) return;
    interruptedApplyNotifiedRef.current = true;
    notify.error(
      t('sync.autoSync.interruptedApplyMessage'),
      t('sync.autoSync.interruptedApplyTitle'),
    );
  }, [sync.isUnlocked, t]);

  // Stabilize the fields `checkRemoteVersion` reads from `config`.
  // AutoSyncConfig is a fresh object literal on every App render, so a
  // naive `config` dep would rebuild `checkRemoteVersion`'s identity on
  // every unrelated state change — re-firing the retry effect with
  // `attempt=0` and spawning overlapping in-flight inspections. The
  // refs below let `checkRemoteVersion` read the latest callback and
  // readiness flag without pulling the object identity into deps.
  const onApplyPayloadRef = useRef(config.onApplyPayload);
  useEffect(() => {
    onApplyPayloadRef.current = config.onApplyPayload;
  }, [config.onApplyPayload]);
  const startupReadyRef = useRef(config.startupReady);
  useEffect(() => {
    startupReadyRef.current = config.startupReady;
  }, [config.startupReady]);
  // `buildPayload` closes over live React state so its identity flips
  // on every vault edit; route it through a ref so `checkRemoteVersion`
  // can read the latest builder without churning its memo identity.
  const buildPayloadRef = useRef(buildPayload);
  useEffect(() => {
    buildPayloadRef.current = buildPayload;
  }, [buildPayload]);

  // Serialize `checkRemoteVersion` invocations. Overlapping runs would
  // race on `commitRemoteInspection` + `onApplyPayload`: two merges
  // could both write-then-clear the apply-in-progress sentinel around
  // interleaved applies, and both could push post-merge snapshots to
  // remote. The cross-window `withRestoreBarrier` protects other
  // windows but does NOT serialize same-window re-entry, so this
  // in-flight guard closes that gap at the top of the call.
  const checkRemoteInFlightRef = useRef(false);

  // Check remote version and pull if newer (on startup)
  const checkRemoteVersion = useCallback(async () => {
    if (checkRemoteInFlightRef.current) {
      return;
    }
    const state = manager.getState();
    const hasProvider = Object.values(state.providers).some((provider) => isProviderReadyForSync(provider));
    const unlocked = state.securityState === 'UNLOCKED';

    if (!hasProvider || !unlocked || hasCheckedRemoteRef.current || startupReadyRef.current === false) {
      return;
    }

    // Find connected provider BEFORE acquiring the in-flight lock so the
    // "nothing to check" early return doesn't leak the lock and wedge
    // the retry timer. Any path that takes the lock MUST reach the
    // finally-release below.
    const connectedProvider = AUTO_SYNC_PROVIDER_ORDER.find((provider) =>
      isProviderReadyForSync(state.providers[provider]),
    ) ?? null;

    if (!connectedProvider) {
      // Nothing to check — mark as done so the auto-sync gate opens.
      remoteCheckDoneRef.current = true;
      return;
    }

    checkRemoteInFlightRef.current = true;

    // Track whether the startup path completed in a state where the anchor/base
    // are consistent with the local vault. Only then should we latch
    // hasCheckedRemoteRef so that transient failures are retryable.
    let startupConsistent = false;
    try {
      // Load base BEFORE observing the remote payload (commitRemoteInspection overwrites the base).
      const base = await manager.loadSyncBase(connectedProvider);
      const inspection = await manager.inspectProviderRemote(connectedProvider);

      if (!inspection.payload || !inspection.remoteChanged || !inspection.remoteFile) {
        // Remote unchanged (or empty) — no local mutation needed; anchor/base
        // are already in sync with remote from a previous run.
        startupConsistent = true;
        return;
      }

      const remoteFile = inspection.remoteFile;
      const remotePayload = inspection.payload;
      const localPayload = buildPayloadRef.current();
      const localIsEmpty = !hasMeaningfulCloudSyncData(localPayload);
      const remoteHasData = hasMeaningfulCloudSyncData(remotePayload);

      // If local vault is empty but cloud has data, this almost certainly
      // means the user's data was lost (update, storage corruption, etc.).
      // Pause and ask the user what to do instead of silently merging.
      if (localIsEmpty && remoteHasData) {
        const userAction = await new Promise<'restore' | 'keep-empty'>((resolve) => {
          emptyVaultResolveRef.current = resolve;
          setEmptyVaultConflict({
            remotePayload,
            hostCount: remotePayload.hosts?.length ?? 0,
            keyCount: remotePayload.keys?.length ?? 0,
            snippetCount: remotePayload.snippets?.length ?? 0,
          });
        });
        setEmptyVaultConflict(null);
        emptyVaultResolveRef.current = null;

        if (userAction === 'restore') {
          // Apply remote FIRST; only commit anchor/base after the UI-side
          // state has accepted the remote payload, otherwise a failure
          // between commit and apply would leave the anchor pointing at
          // remote while local is still empty — the exact overwrite window
          // we're trying to close.
          await Promise.resolve(onApplyPayloadRef.current(remotePayload));
          await manager.commitRemoteInspection(connectedProvider, remoteFile, remotePayload);
          skipNextSyncRef.current = true;
          startupConsistent = true;
          notify.success(t('sync.autoSync.restoredMessage'), t('sync.autoSync.restoredTitle'));
        } else {
          // User chose to keep the empty vault. Deliberately do NOT advance
          // the anchor or base — the next sync must still treat remote as
          // "unseen" so the empty-vault-push guard (`hasMeaningfulSyncData`)
          // keeps protecting the cloud copy. startupConsistent stays false
          // so hasCheckedRemoteRef is not latched and the next startup will
          // re-prompt if the user still has not added anything.
          notify.info(t('sync.autoSync.keptLocalMessage'), t('sync.autoSync.keptLocalTitle'));
        }
        return;
      }

      const { mergeSyncPayloads } = await import('../../domain/syncMerge');
      const mergeResult = mergeSyncPayloads(base, localPayload, remotePayload);

      // Apply merged payload to local state BEFORE committing. If the apply
      // throws, the next startup will re-run the merge with fresh data.
      await Promise.resolve(onApplyPayloadRef.current(mergeResult.payload));
      // Base is the last-agreed remote snapshot; `commitRemoteInspection`
      // stores remotePayload as the base so the next diff is computed
      // against what the cloud actually has, not against the merged
      // local-only state.
      await manager.commitRemoteInspection(connectedProvider, remoteFile, remotePayload);
      startupConsistent = true;
      notify.success(t('sync.autoSync.syncedMessage'), t('sync.autoSync.syncedTitle'));

      // If the three-way merge introduced any local-only additions that the
      // remote does not yet have, we MUST round-trip those to the cloud.
      // Previously this branch stopped after applying merge locally, so the
      // merged-in additions lived only on the device that ran the merge
      // until the user's next edit.
      //
      // We push the merged payload *directly* through the manager rather
      // than going through the React-state-driven `syncNow`. syncNow
      // rebuilds the payload from hooks state, which may not yet reflect
      // the onApplyPayload we awaited above (React commit phase is async
      // relative to the awaited promise resolution). Passing mergeResult
      // in explicitly removes the race entirely and avoids a setTimeout(0)
      // that only approximated the correct ordering.
      if (mergeResult.payload) {
        try {
          const roundTripResults = await manager.syncAllProviders(mergeResult.payload);
          const wasShrinkBlocked = Array.from(roundTripResults.values()).some(
            (r) => r.shrinkBlocked === true,
          );
          if (wasShrinkBlocked) {
            // The merged payload is already applied locally and is the source of truth
            // for THIS device. The blocking only prevents pushing it to cloud, which
            // is acceptable here — the next user-edit-triggered sync will re-check
            // (and the user can also force-push from the Settings banner if they
            // navigate there). Reset syncState so we don't leave the manager wedged
            // in BLOCKED with no banner visible.
            console.warn('[AutoSync] Post-merge round-trip was shrink-blocked; merged data applied locally, reset syncState to IDLE for next attempt.');
            manager.clearShrinkBlockedState();
          }
          // Suppress the debounced follow-up tick that otherwise fires
          // once React commits the applied state, since we've just
          // already pushed that exact payload upstream.
          skipNextSyncRef.current = true;
        } catch (error) {
          // Non-fatal: the next user edit will drive another sync cycle.
          console.warn('[AutoSync] Post-merge round-trip push failed:', error);
        }
      }
    } catch (error) {
      console.error('[AutoSync] Failed to check remote version:', error);
      // Surface a degraded-sync hint to the user rather than silently
      // opening the auto-sync gate. Auto-sync will still retry on next
      // data change (see finally block), but without this toast the user
      // has no visible signal that startup reconciliation failed.
      notify.error(
        t('sync.autoSync.inspectFailedMessage'),
        t('sync.autoSync.inspectFailedTitle'),
      );
      // Leave hasCheckedRemoteRef=false so the next startup (or the next
      // provider/unlock transition) can retry.
    } finally {
      if (startupConsistent) {
        hasCheckedRemoteRef.current = true;
        // Only open the auto-sync gate when the inspect actually
        // validated the remote state. Leaving the gate closed on
        // inspect failure is intentional: an edit made during a
        // degraded startup must not race ahead and push a partially-
        // hydrated vault over an intact remote. The retry effect
        // below re-fires checkRemoteVersion on the next provider/
        // unlock/startupReady transition, and a manual sync from
        // Settings remains available as an escape hatch.
        remoteCheckDoneRef.current = true;
      }
      checkRemoteInFlightRef.current = false;
    }
    // Intentionally minimal deps: `buildPayload`, `config.onApplyPayload`,
    // and `config.startupReady` are read through refs above so their
    // identity flips (every vault edit produces a fresh `buildPayload`
    // and a fresh AutoSyncConfig literal) cannot re-memoize this
    // callback and restart the retry-timer's exponential backoff.
  }, [t]);
  
  // Debounced auto-sync when data changes
  useEffect(() => {
    // Skip if not ready
    if (!sync.hasAnyConnectedProvider || !sync.autoSyncEnabled || !sync.isUnlocked) {
      return;
    }

    // Don't auto-sync until the startup remote check has completed.
    // Without this gate, an empty local vault can push to the cloud
    // before checkRemoteVersion even runs, overwriting a non-empty
    // remote vault — the exact bug described in #679.
    if (!remoteCheckDoneRef.current) {
      return;
    }

    // Skip initial render
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      lastSyncedDataRef.current = getDataHash();
      return;
    }
    
    const currentHash = getDataHash();

    // After a merge, onApplyPayload changes local state which triggers
    // this effect. Skip that cycle and just update the hash baseline.
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      lastSyncedDataRef.current = currentHash;
      return;
    }

    // Skip if data hasn't changed
    if (currentHash === lastSyncedDataRef.current) {
      return;
    }

    // Wait for the current sync to finish, then this effect will re-run
    // because sync.isSyncing changed.
    if (sync.isSyncing || isSyncRunningRef.current) {
      return;
    }

    // Hold off on scheduling a new push while another window is applying
    // a restore — the restore is about to land via localStorage and the
    // debounce-fired syncNow would otherwise race it. The next data-
    // change tick after the restore barrier clears will re-enter here.
    if (isRestoreInProgress()) {
      return;
    }

    // Don't even schedule a push while the apply-in-progress sentinel
    // is held. The syncNow path re-checks and refuses too, but dropping
    // the debounced schedule here avoids spinning a 3-second timer for
    // every keystroke while the user is in the Restore UI working
    // through recovery.
    if (readInterruptedVaultApply()) {
      return;
    }
    
    // Clear existing timeout
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    
    // Debounce sync by 3 seconds
    syncTimeoutRef.current = setTimeout(() => {
      syncNow();
    }, 3000);
    
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [sync.hasAnyConnectedProvider, sync.autoSyncEnabled, sync.isUnlocked, sync.isSyncing, getDataHash, syncNow, config.settingsVersion, bookmarksVersion]);
  
  // Check remote version on startup/unlock, then retry with backoff
  // while the inspect keeps failing. Without the timer-based retry,
  // a failure that doesn't coincide with a dep change would wedge the
  // auto-sync gate closed until the user restarts or manually triggers
  // sync from Settings — the 30s/60s/90s cadence below lets a short
  // outage (network blip, provider rate-limit) self-heal.
  useEffect(() => {
    if (
      !sync.hasAnyConnectedProvider ||
      !sync.isUnlocked ||
      hasCheckedRemoteRef.current ||
      config.startupReady === false
    ) {
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let timerId: NodeJS.Timeout | null = null;

    const tick = () => {
      if (cancelled) return;
      void (async () => {
        await checkRemoteVersion();
        if (cancelled || hasCheckedRemoteRef.current) return;
        // Cap retries at ~5 minutes total (30s + 60s + 120s + 240s). A
        // persistent failure beyond that is almost certainly a
        // misconfiguration that needs user action rather than more
        // auto-retries.
        //
        // When retries exhaust we deliberately leave the auto-sync gate
        // CLOSED. Opening it here would allow a partially-lost local
        // vault to silently clobber an unchanged remote: anchor still
        // matches, `checkProviderConflict` sees no remote change,
        // `hasMeaningfulSyncData` doesn't flag non-empty-but-partial
        // local, and the empty-vault prompt never fires.
        //
        // Escape hatch: a successful manual sync from Settings opens
        // the gate via `syncNow`'s success path. That path runs the
        // same per-provider inspect we use here, so a successful
        // manual sync is equivalent to a successful startup inspect
        // from the gate's point of view — the user's explicit click
        // authorizes both the push and the subsequent auto-sync
        // resumption. Until then, auto-sync stays paused and the
        // "sync paused" toast is the user's signal to act.
        if (attempt >= 4) return;
        const delayMs = Math.min(240_000, 30_000 * 2 ** attempt);
        attempt += 1;
        timerId = setTimeout(tick, delayMs);
      })();
    };

    tick();

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [sync.hasAnyConnectedProvider, sync.isUnlocked, config.startupReady, checkRemoteVersion]);
  
  // Reset check flags when provider disconnects
  useEffect(() => {
    if (!sync.hasAnyConnectedProvider) {
      hasCheckedRemoteRef.current = false;
      remoteCheckDoneRef.current = false;
    }
  }, [sync.hasAnyConnectedProvider]);

  // On unmount, release any pending empty-vault confirmation. Without
  // this, an unmount mid-dialog (window close, workspace switch) leaves
  // the resolver promise dangling forever and the `checkRemoteVersion`
  // finally block never sets remoteCheckDoneRef — in practice React
  // tears down the hook first, but leaking the resolve callback and
  // referenced remotePayload keeps them pinned by the awaiter until
  // the next reload. Resolving with 'keep-empty' is the safe default:
  // it mirrors the "don't touch remote" choice and leaves the version
  // stamp untouched so the next mount re-prompts.
  useEffect(() => {
    return () => {
      const resolve = emptyVaultResolveRef.current;
      if (resolve) {
        emptyVaultResolveRef.current = null;
        resolve('keep-empty');
      }
    };
  }, []);
  
  const resolveEmptyVaultConflict = useCallback((action: 'restore' | 'keep-empty') => {
    // Guard: resolve only once (prevents double-click from entering an
    // inconsistent state). The ref is nulled immediately so subsequent
    // calls are no-ops.
    const resolve = emptyVaultResolveRef.current;
    if (!resolve) return;
    emptyVaultResolveRef.current = null;
    resolve(action);
  }, []);

  return {
    syncNow,
    buildPayload,
    isSyncing: sync.isSyncing,
    isConnected: sync.hasAnyConnectedProvider,
    autoSyncEnabled: sync.autoSyncEnabled,
    emptyVaultConflict,
    resolveEmptyVaultConflict,
  };
};

export default useAutoSync;
