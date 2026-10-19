/* eslint-disable @typescript-eslint/no-explicit-any */

import packageJson from '../../../package.json';
import {
  isProviderReadyForSync,
  type CloudProvider,
  type ConvergentFieldConflict,
  type ConvergentProviderBaselineV2,
  type ConvergentSyncStateV2,
  type SyncPayload,
  type SyncResult,
  type SyncedFile,
} from '../../../domain/sync';
import {
  applyLegacySyncPayload,
  cloudSyncPayloadsEqual,
  convergentConflictAddressKey,
  materializeConvergentSyncState,
  materializeSyncPayloadFromConvergentState,
  mergeConvergentSyncStates,
  resolveConvergentFieldConflict,
  stripConvergentSyncEnvelope,
  validateConvergentSyncPayload,
  versionVectorDominates,
  versionVectorsEqual,
  withConvergentSyncEnvelope,
} from '../../../domain/convergentSync';
import { isPreserveDeletionsStrategy, type CloudSyncStrategy } from '../../../domain/syncStrategy';
import type { CloudSyncConflictAction } from '../../../domain/syncStrategy';
import { mergeAiSessionLists, mergeSyncPayloads } from '../../../domain/syncMerge';
import { detectSuspiciousShrink } from '../../../domain/syncGuards';
import { EncryptionService } from '../EncryptionService';
import type { CloudAdapter } from '../adapters';

const CONVERGENT_SYNC_LOCK = 'netcatty-convergent-sync-v2';
const MAX_VERIFY_ROUNDS = 3;
const MAX_JITTER_MS = 180;

interface ProviderRuntime {
  provider: CloudProvider;
  adapter: CloudAdapter;
  latestRemote: SyncedFile | null;
  /** Decrypted payload from the most recent successful download for this cycle. */
  latestRemotePayload?: SyncPayload;
  verifiedState?: ConvergentSyncStateV2;
  verifiedFile?: SyncedFile;
  /** Decrypted payload retained when the provider is marked verified. */
  verifiedPayload?: SyncPayload;
  resourceId?: string;
  error?: string;
}

interface DecodedRemote {
  payload: SyncPayload;
  state: ConvergentSyncStateV2;
  file: SyncedFile;
}

function assertSyncSecurityGeneration(manager: any, generation?: number): void {
  if (typeof manager.assertSyncSecurityGeneration === 'function') {
    manager.assertSyncSecurityGeneration(generation);
  }
}

function getSyncSecurityGeneration(manager: any): number | undefined {
  return typeof manager.getSyncSecurityGeneration === 'function'
    ? manager.getSyncSecurityGeneration()
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateProviderFailure(
  manager: any,
  provider: CloudProvider,
  error: unknown,
): string {
  const message = errorMessage(error);
  const reauthHandled = typeof manager.handleProviderReauthRequired === 'function'
    && manager.handleProviderReauthRequired(provider, error);
  if (!reauthHandled) manager.updateProviderStatus(provider, 'error', message);
  return message;
}

function connectedProviders(manager: any): CloudProvider[] {
  return (Object.entries(manager.state.providers) as Array<[
    CloudProvider,
    Parameters<typeof isProviderReadyForSync>[0],
  ]>)
    .filter(([, connection]) => isProviderReadyForSync(connection))
    .map(([provider]) => provider)
    .sort();
}

function syntheticLegacyDeviceId(provider: CloudProvider, file: SyncedFile): string {
  return `legacy:${provider}:${file.meta.deviceId}`;
}

async function decodeRemote(
  manager: any,
  provider: CloudProvider,
  file: SyncedFile,
  syncSecurityGeneration?: number,
): Promise<DecodedRemote> {
  const payload = await EncryptionService.decryptPayload(file, manager.masterPassword);
  assertSyncSecurityGeneration(manager, syncSecurityGeneration);
  const state = validateConvergentSyncPayload(file.meta, payload);
  if (state) return { payload, state, file };

  const baseline = await manager.loadConvergentProviderBaseline(provider) as
    | ConvergentProviderBaselineV2
    | null;
  assertSyncSecurityGeneration(manager, syncSecurityGeneration);
  if (!baseline) {
    throw new Error(
      `Legacy cloud data from ${provider} has no trusted convergent baseline. Upgrade the old device or choose a version manually.`,
    );
  }

  const legacyPayload = stripConvergentSyncEnvelope(payload);
  const convertedState = cloudSyncPayloadsEqual(baseline.materializedPayload, legacyPayload)
    ? baseline.state
    : applyLegacySyncPayload(
        baseline.state,
        baseline.materializedPayload,
        legacyPayload,
        syntheticLegacyDeviceId(provider, file),
        file.meta.updatedAt,
      );
  return { payload, state: convertedState, file };
}

function mergeStates(
  initial: ConvergentSyncStateV2,
  states: Iterable<ConvergentSyncStateV2>,
): ConvergentSyncStateV2 {
  let merged = initial;
  for (const state of states) merged = mergeConvergentSyncStates(merged, state);
  return merged;
}

function materializedPayload(
  state: ConvergentSyncStateV2,
  now: number,
  pluginSidecars?: SyncPayload['pluginSidecars'],
  aiSessions?: SyncPayload['aiSessions'],
): SyncPayload {
  return materializeSyncPayloadFromConvergentState(state, {
    syncedAt: now,
    ...(pluginSidecars && Array.isArray(pluginSidecars.entries)
      ? { pluginSidecars }
      : {}),
    ...(aiSessions !== undefined ? { aiSessions } : {}),
  });
}

function mergeRuntimeAiSessions(
  local: SyncPayload,
  remotes: ProviderRuntime[],
  baselines: Map<CloudProvider, SyncPayload>,
  strategy: CloudSyncStrategy,
): SyncPayload['aiSessions'] {
  let merged = local;
  for (const runtime of remotes) {
    const remote = runtime.latestRemotePayload ?? runtime.verifiedPayload;
    if (!remote) continue;
    const aiSessions = strategy === 'preferLocal' && local.aiSessions !== undefined
      ? local.aiSessions
      : strategy === 'preferCloud' && remote.aiSessions !== undefined
        ? remote.aiSessions
        : mergeSyncPayloads(baselines.get(runtime.provider) ?? null, merged, remote, {
          preserveDeletions: isPreserveDeletionsStrategy(strategy),
        }).payload.aiSessions;
    merged = { ...merged, aiSessions };
  }
  return merged.aiSessions;
}

function chatPayloadsEqual(left: SyncPayload, aiSessions: SyncPayload['aiSessions']): boolean {
  return cloudSyncPayloadsEqual(left, { ...left, aiSessions });
}

function preserveSurvivingState(
  state: ConvergentSyncStateV2,
  sources: SyncPayload[],
  deviceId: string,
  now: number,
): ConvergentSyncStateV2 {
  const baseline = materializedPayload(state, now);
  let retained = baseline;
  for (const source of sources) {
    retained = mergeSyncPayloads(null, retained, source, { preserveDeletions: true }).payload;
  }
  // Keep the CRDT's field winners and settings. Only missing survivors need
  // ordinary causal upserts to supersede an observed deletion.
  return applyLegacySyncPayload(state, baseline, { ...retained, settings: baseline.settings }, deviceId, now);
}

function sidecarBundleFromPayload(
  payload: SyncPayload | null | undefined,
): SyncPayload['pluginSidecars'] | undefined {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'pluginSidecars')) {
    return undefined;
  }
  return {
    version: 1,
    entries: Array.isArray(payload.pluginSidecars?.entries)
      ? payload.pluginSidecars.entries
      : [],
  };
}

function currentConflicts(state: ConvergentSyncStateV2): ConvergentFieldConflict[] {
  return materializeConvergentSyncState(state).conflicts;
}

async function persistReplica(manager: any, state: ConvergentSyncStateV2, now: number): Promise<void> {
  await manager.saveConvergentReplica({ schemaVersion: 2, state, updatedAt: now });
}

function updateConflictState(manager: any, state: ConvergentSyncStateV2): ConvergentFieldConflict[] {
  const conflicts = currentConflicts(state);
  manager.state.convergentConflicts = conflicts;
  return conflicts;
}

async function fullJitter(round: number): Promise<void> {
  const ceiling = Math.min(MAX_JITTER_MS, 30 * (2 ** round));
  const delay = Math.floor(Math.random() * (ceiling + 1));
  if (delay <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

async function downloadProviderState(
  manager: any,
  runtime: ProviderRuntime,
  syncSecurityGeneration?: number,
): Promise<DecodedRemote | null> {
  const file = await runtime.adapter.download({
    signal: manager.activeSyncAbortSignal,
  });
  assertSyncSecurityGeneration(manager, syncSecurityGeneration);
  runtime.latestRemote = file;
  if (!file) {
    runtime.latestRemotePayload = undefined;
    return null;
  }
  const decoded = await decodeRemote(manager, runtime.provider, file, syncSecurityGeneration);
  runtime.latestRemotePayload = decoded.payload;
  return decoded;
}

async function saveVerifiedBaseline(
  manager: any,
  runtime: ProviderRuntime,
  decoded: DecodedRemote,
): Promise<void> {
  await manager.saveConvergentProviderBaseline({
    schemaVersion: 2,
    provider: runtime.provider,
    remoteVersion: decoded.file.meta.version,
    remoteUpdatedAt: decoded.file.meta.updatedAt,
    remoteDeviceId: decoded.file.meta.deviceId,
    materializedPayload: stripConvergentSyncEnvelope(decoded.payload),
    state: decoded.state,
  });
}

async function markProviderVerified(
  manager: any,
  runtime: ProviderRuntime,
  decoded: DecodedRemote,
): Promise<void> {
  runtime.verifiedState = decoded.state;
  runtime.verifiedFile = decoded.file;
  runtime.verifiedPayload = decoded.payload;
  runtime.latestRemotePayload = decoded.payload;
  runtime.error = undefined;
  await saveVerifiedBaseline(manager, runtime, decoded);

  const connection = manager.state.providers[runtime.provider];
  manager.state.providers[runtime.provider] = {
    ...connection,
    resourceId: runtime.resourceId || connection.resourceId,
    lastSync: Date.now(),
    lastSyncVersion: decoded.file.meta.version,
  };
  manager.state.remoteVersion = Math.max(manager.state.remoteVersion, decoded.file.meta.version);
  manager.state.remoteUpdatedAt = Math.max(manager.state.remoteUpdatedAt, decoded.file.meta.updatedAt);
  if (typeof manager.saveProviderConnection === 'function') {
    await manager.saveProviderConnection(runtime.provider, manager.state.providers[runtime.provider]);
  }
  manager.updateProviderStatus(runtime.provider, 'connected');
}

function failedResult(provider: CloudProvider, error: string): SyncResult {
  return { success: false, provider, action: 'none', error };
}

async function runInitialDownloads(
  manager: any,
  providers: CloudProvider[],
  syncSecurityGeneration?: number,
  announce = true,
): Promise<ProviderRuntime[]> {
  return Promise.all(providers.map(async (provider): Promise<ProviderRuntime> => {
    if (announce) {
      manager.updateProviderStatus(provider, 'syncing');
      manager.emit({ type: 'SYNC_STARTED', provider });
    }
    try {
      const adapter = await manager.getConnectedAdapter(provider) as CloudAdapter;
      assertSyncSecurityGeneration(manager, syncSecurityGeneration);
      const runtime: ProviderRuntime = { provider, adapter, latestRemote: null };
      try {
        const decoded = await downloadProviderState(manager, runtime, syncSecurityGeneration);
        if (decoded) {
          runtime.verifiedState = decoded.state;
          runtime.verifiedPayload = decoded.payload;
        }
      } catch (error) {
        runtime.error = errorMessage(error);
      }
      return runtime;
    } catch (error) {
      return {
        provider,
        adapter: undefined as unknown as CloudAdapter,
        latestRemote: null,
        error: errorMessage(error),
      };
    }
  }));
}

interface PreparedLocalState {
  canonical: ConvergentSyncStateV2;
  durableBeforeVerification: ConvergentSyncStateV2;
  preservedSurvivors?: boolean;
}

function prepareLocalState(
  strategy: CloudSyncStrategy,
  replica: ConvergentSyncStateV2,
  localPayload: SyncPayload,
  remoteStates: ConvergentSyncStateV2[],
  deviceId: string,
  now: number,
): PreparedLocalState {
  const localBaseline = materializedPayload(replica, now);
  if (strategy === 'preferCloud' && remoteStates.length > 0) {
    const [first, ...rest] = remoteStates;
    return {
      canonical: mergeStates(first, rest),
      durableBeforeVerification: replica,
    };
  }
  if (strategy === 'preferLocal') {
    const joined = mergeStates(replica, remoteStates);
    const canonical = applyLegacySyncPayload(
      joined,
      localBaseline,
      stripConvergentSyncEnvelope(localPayload),
      deviceId,
      now,
    );
    return { canonical, durableBeforeVerification: canonical };
  }
  const withLocalWrites = applyLegacySyncPayload(
    replica,
    localBaseline,
    stripConvergentSyncEnvelope(localPayload),
    deviceId,
    now,
  );
  const joined = mergeStates(withLocalWrites, remoteStates);
  const canonical = isPreserveDeletionsStrategy(strategy)
    ? preserveSurvivingState(joined, [localPayload, ...remoteStates.map((state) => materializedPayload(state, now))], deviceId, now)
    : joined;
  return {
    canonical,
    durableBeforeVerification: withLocalWrites,
    preservedSurvivors: !versionVectorsEqual(joined.vector, canonical.vector),
  };
}

/**
 * The unlocked implementation is exported for deterministic integration
 * tests. Production callers must use `syncAllProvidersConvergentlyImpl`, which
 * holds the cross-window Web Lock.
 */
export async function syncConvergentProvidersUnlockedImpl(
  this: any,
  inputPayload: SyncPayload,
  options: {
    maxRounds?: number;
    now?: () => number;
    jitter?: (round: number) => Promise<void>;
    strategyOverride?: CloudSyncStrategy;
    overrideShrink?: boolean;
    applyPayload?: (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => Promise<void>;
  } = {},
): Promise<Map<CloudProvider, SyncResult>> {
  const results = new Map<CloudProvider, SyncResult>();
  const providers = connectedProviders(this);
  if (providers.length === 0) return results;
  if (this.state.securityState !== 'UNLOCKED' || !this.masterPassword) {
    for (const provider of providers) results.set(provider, failedResult(provider, 'Vault is locked'));
    return results;
  }

  const now = options.now ?? Date.now;
  const jitter = options.jitter ?? fullJitter;
  const maxRounds = options.maxRounds ?? MAX_VERIFY_ROUNDS;
  const syncSecurityGeneration = getSyncSecurityGeneration(this);
  this.state.syncState = 'SYNCING';
  this.state.lastError = null;
  this.state.currentConflict = null;

  const replica = await this.loadConvergentReplica();
  if (!replica) {
    const message = 'Convergent sync is initialized but its local replica is missing';
    this.state.syncState = 'ERROR';
    this.state.lastError = message;
    for (const provider of providers) results.set(provider, failedResult(provider, message));
    this.notifyStateChange();
    return results;
  }

  const strategy = options.strategyOverride ?? this.state.syncStrategy;
  const replicaPayload = materializedPayload(replica.state, now());
  if (strategy !== 'preferCloud' && !isPreserveDeletionsStrategy(strategy)) {
    const finding = detectSuspiciousShrink(
      stripConvergentSyncEnvelope(inputPayload),
      replicaPayload,
      null,
    );
    if (finding.suspicious && !options.overrideShrink) {
      this.state.syncState = 'BLOCKED';
      this.state.lastShrinkFinding = finding;
      for (const provider of providers) {
        this.updateProviderStatus(provider, 'error', 'Sync blocked: would delete too much');
        this.emit({ type: 'SYNC_BLOCKED_SHRINK', provider, finding });
        results.set(provider, {
          success: false,
          provider,
          action: 'none',
          shrinkBlocked: true,
          finding,
        });
      }
      this.notifyStateChange();
      return results;
    }
    if (finding.suspicious) {
      for (const provider of providers) {
        this.emit({ type: 'SYNC_FORCED', provider, finding });
      }
    }
  }

  const runtimes = await runInitialDownloads(this, providers, syncSecurityGeneration);
  // Adapter acquisition failures are terminal for this cycle. Download,
  // decrypt, and verification failures remain retryable in later rounds.
  const usable = runtimes.filter((runtime) => Boolean(runtime.adapter));
  const preparedLocal = prepareLocalState(
    strategy,
    replica.state,
    inputPayload,
    usable.flatMap((runtime) => runtime.verifiedState ? [runtime.verifiedState] : []),
    this.state.deviceId,
    now(),
  );
  let canonical = preparedLocal.canonical;
  let durableBeforeVerification = preparedLocal.durableBeforeVerification;

  // Persist locally-generated dots before every network write, but do not
  // commit downloaded remote-only dots until at least one provider verifies
  // the joined state. A total network failure must leave the replica aligned
  // with the still-unmodified renderer vault.
  await persistReplica(this, durableBeforeVerification, now());
  updateConflictState(this, durableBeforeVerification);

  const applyPreservedSurvivors = async (state: ConvergentSyncStateV2) => {
    if (!options.applyPayload) throw new Error('Preserving convergent survivors requires a protected payload applier');
    let committed = false;
    await options.applyPayload(materializedPayload(state, now()), async () => {
      await persistReplica(this, state, now());
      updateConflictState(this, state);
      durableBeforeVerification = state;
      committed = true;
    });
    if (!committed) throw new Error('Preserved payload apply completed without committing its replica');
  };
  if (preparedLocal.preservedSurvivors) await applyPreservedSurvivors(canonical);

  // Capture pre-cycle sidecar baselines per provider (never union across
  // providers). Cross-provider union invents a shared base that can treat one
  // provider's empty remote as deleting another provider's retained settings.
  const cycleBaseByProvider = new Map<CloudProvider, NonNullable<SyncPayload['pluginSidecars']>['entries']>();
  const cyclePayloadBaseByProvider = new Map<CloudProvider, SyncPayload>();
  if (typeof this.loadConvergentProviderBaseline === 'function') {
    for (const runtime of usable) {
      try {
        const baseline = await this.loadConvergentProviderBaseline(runtime.provider) as {
          materializedPayload?: SyncPayload;
        } | null;
        if (baseline?.materializedPayload) cyclePayloadBaseByProvider.set(runtime.provider, baseline.materializedPayload);
        const baseBundle = baseline?.materializedPayload?.pluginSidecars;
        if (!baseBundle || !Array.isArray(baseBundle.entries)) continue;
        cycleBaseByProvider.set(runtime.provider, baseBundle.entries);
      } catch {
        // First cycle or missing baseline is fine.
      }
    }
  }

  for (let round = 0; round < maxRounds && usable.length > 0; round += 1) {
    if (round > 0) await jitter(round);

    const preflight = await Promise.all(usable.map(async (runtime) => {
      try {
        const decoded = await downloadProviderState(this, runtime, syncSecurityGeneration);
        runtime.error = undefined;
        return decoded;
      } catch (error) {
        runtime.error = errorMessage(error);
        return null;
      }
    }));
    canonical = mergeStates(canonical, preflight.flatMap((decoded) => decoded ? [decoded.state] : []));

    if (isPreserveDeletionsStrategy(strategy)) {
      const preserved = preserveSurvivingState(canonical, [
        inputPayload,
        ...usable.flatMap((runtime) => runtime.latestRemotePayload ? [runtime.latestRemotePayload] : []),
      ], this.state.deviceId, now());
      if (!versionVectorsEqual(canonical.vector, preserved.vector)) {
        canonical = preserved;
        await applyPreservedSurvivors(canonical);
      }
    }

    const expected = canonical;
    const preflightVerified = new Map<CloudProvider, DecodedRemote>();
    await Promise.all(usable.map(async (runtime, index) => {
      if (runtime.error) return;
      const decoded = preflight[index];
      if (
        !decoded
        || decoded.file.meta.syncSchemaVersion !== 2
        || !versionVectorDominates(decoded.state.vector, expected.vector)
      ) return;
      try {
        // The provider already contains the complete joined state. Treat the
        // preflight read as verification instead of creating a new encrypted
        // cloud revision for a no-op runtime check.
        await markProviderVerified(this, runtime, decoded);
        preflightVerified.set(runtime.provider, decoded);
      } catch (error) {
        runtime.error = errorMessage(error);
      }
    }));
    // Merge plugin sidecars per successful provider with that provider's own
    // pre-cycle baseline. Failed providers are skipped so their baselines
    // cannot invent deletions against another provider's empty remote.
    const {
      mergePluginSyncSidecarsThreeWay,
    } = await import('../../../domain/pluginSyncSidecar');
    const localSidecarEntries = Array.isArray(inputPayload.pluginSidecars?.entries)
      ? inputPayload.pluginSidecars.entries
      : [];
    let mergedSidecars = [...localSidecarEntries];
    for (const runtime of usable) {
      if (runtime.error) continue;
      const fromPreflight = preflightVerified.get(runtime.provider)?.payload?.pluginSidecars;
      const fromLatest = runtime.latestRemotePayload?.pluginSidecars;
      const remoteBundle = fromPreflight ?? fromLatest;
      if (!remoteBundle) continue;
      const baseForProvider = cycleBaseByProvider.get(runtime.provider) ?? [];
      const sidecarStrategy =
        strategy === 'preferCloud' || strategy === 'preferLocal' ? strategy : 'smart';
      mergedSidecars = mergePluginSyncSidecarsThreeWay({
        base: baseForProvider,
        local: mergedSidecars,
        remote: Array.isArray(remoteBundle.entries) ? remoteBundle.entries : [],
        strategy: sidecarStrategy,
      });
    }
    const pluginSidecars = mergedSidecars.length > 0
      || Object.prototype.hasOwnProperty.call(inputPayload, 'pluginSidecars')
      ? { version: 1 as const, entries: mergedSidecars }
      : inputPayload.pluginSidecars;
    const sidecarFingerprint = (
      bundle: typeof pluginSidecars,
      payload?: SyncPayload | null,
    ) => {
      const present = payload
        ? Object.prototype.hasOwnProperty.call(payload, 'pluginSidecars')
        : bundle != null && Array.isArray(bundle.entries);
      const entries = (bundle?.entries ?? [])
        .map((e) => [e.pluginId, e.kind, e.key, e.updatedAt, e.value] as const)
        .sort((a, b) => {
          if (a[0] !== b[0]) return String(a[0]).localeCompare(String(b[0]));
          if (a[1] !== b[1]) return String(a[1]).localeCompare(String(b[1]));
          return String(a[2]).localeCompare(String(b[2]));
        });
      // Empty present and empty absent both fingerprint as empty so devices
      // do not ping-pong uploading omitted vs explicit-empty markers.
      if (entries.length === 0) {
        return JSON.stringify({ present: false, version: null, entries: [] });
      }
      return JSON.stringify({
        present,
        version: present ? (bundle?.version ?? 1) : null,
        entries,
      });
    };
    const localSidecarFp = sidecarFingerprint(
      pluginSidecars,
      Object.prototype.hasOwnProperty.call(inputPayload, 'pluginSidecars') || mergedSidecars.length > 0
        ? { ...inputPayload, pluginSidecars }
        : inputPayload,
    );
    const providerSidecarMismatch = (runtime: { provider: string }) => {
      const decoded = preflightVerified.get(runtime.provider);
      if (!decoded) return true; // no preflight match → need upload
      return sidecarFingerprint(decoded.payload?.pluginSidecars, decoded.payload) !== localSidecarFp;
    };
    const remoteSidecarMismatch = usable.some((runtime) => {
      if (runtime.error) return false;
      return providerSidecarMismatch(runtime);
    });
    const aiSessions = mergeRuntimeAiSessions(inputPayload, usable.filter((runtime) => !runtime.error), cyclePayloadBaseByProvider, strategy);
    const providerChatMismatch = (runtime: ProviderRuntime) => {
      const decoded = preflightVerified.get(runtime.provider);
      return !decoded || !chatPayloadsEqual(decoded.payload, aiSessions);
    };
    const needsUpload = usable.some((runtime) => (
      !runtime.error && !preflightVerified.has(runtime.provider)
    )) || remoteSidecarMismatch || usable.some((runtime) => !runtime.error && providerChatMismatch(runtime));
    const outgoingPayload = needsUpload
      ? withConvergentSyncEnvelope(expected, {
        syncedAt: now(),
        pluginSidecars,
        aiSessions,
      })
      : null;
    await Promise.all(usable.map(async (runtime) => {
      // Upload when CRDT preflight missed OR sidecars diverge for this provider.
      if (runtime.error) return;
      if (preflightVerified.has(runtime.provider) && !providerSidecarMismatch(runtime) && !providerChatMismatch(runtime)) return;
      if (!outgoingPayload) return;
      try {
        const remoteVersion = runtime.latestRemote?.meta.version ?? this.state.localVersion;
        const file = await EncryptionService.encryptPayload(
          outgoingPayload!,
          this.masterPassword,
          this.state.deviceId,
          this.state.deviceName,
          packageJson.version,
          remoteVersion,
        );
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        runtime.resourceId = await runtime.adapter.upload(file, {
          signal: this.activeSyncAbortSignal,
        });
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        runtime.latestRemote = file;
        // Sidecar-only (or any) upload invalidates preflight verification so the
        // post-write payload is re-downloaded and baselines stay current.
        preflightVerified.delete(runtime.provider);
        runtime.verifiedState = undefined;
        runtime.verifiedPayload = undefined;
        runtime.verifiedFile = undefined;
      } catch (error) {
        runtime.error = errorMessage(error);
      }
    }));

    const verified = await Promise.all(usable.map(async (runtime) => {
      if (runtime.error) return null;
      const preflightDecoded = preflightVerified.get(runtime.provider);
      if (preflightDecoded) return preflightDecoded;
      try {
        const decoded = await downloadProviderState(this, runtime, syncSecurityGeneration);
        if (!decoded) throw new Error('Provider returned no file after upload');
        if (!versionVectorDominates(decoded.state.vector, expected.vector)) {
          throw new Error('Remote verification did not retain the expected convergent state');
        }
        if (!chatPayloadsEqual(decoded.payload, aiSessions)) {
          throw new Error('Remote verification did not retain the expected chat history');
        }
        await markProviderVerified(this, runtime, decoded);
        return decoded;
      } catch (error) {
        runtime.error = errorMessage(error);
        return null;
      }
    }));

    canonical = mergeStates(canonical, verified.flatMap((decoded) => decoded ? [decoded.state] : []));

    const activeVerified = usable.filter((runtime) => runtime.verifiedState && !runtime.error);
    if (
      activeVerified.length === usable.length
      && activeVerified.every((runtime) => versionVectorDominates(
        runtime.verifiedState!.vector,
        canonical.vector,
      ))
      && versionVectorsEqual(expected.vector, canonical.vector)
    ) break;
  }

  const successfulRuntimes = runtimes.filter((runtime) => (
    runtime.verifiedState
      && !runtime.error
      && versionVectorDominates(runtime.verifiedState.vector, canonical.vector)
  ));
  const hasSuccess = successfulRuntimes.length > 0;
  const {
    mergePluginSyncSidecarsThreeWay: mergeSidecarsThreeWayFinal,
  } = await import('../../../domain/pluginSyncSidecar');
  const finalLocalSidecars = Array.isArray(inputPayload.pluginSidecars?.entries)
    ? [...inputPayload.pluginSidecars.entries]
    : [];
  let finalSidecarEntries = [...finalLocalSidecars];
  for (const runtime of successfulRuntimes) {
    const remoteBundle = runtime.verifiedPayload?.pluginSidecars
      ?? runtime.latestRemotePayload?.pluginSidecars;
    if (!remoteBundle) continue;
    const baseForProvider = cycleBaseByProvider.get(runtime.provider) ?? [];
    const finalSidecarStrategy =
      strategy === 'preferCloud' || strategy === 'preferLocal' ? strategy : 'smart';
    finalSidecarEntries = mergeSidecarsThreeWayFinal({
      base: baseForProvider,
      local: finalSidecarEntries,
      remote: Array.isArray(remoteBundle.entries) ? remoteBundle.entries : [],
      strategy: finalSidecarStrategy,
    });
  }
  const finalPluginSidecars = finalSidecarEntries.length > 0
    || Object.prototype.hasOwnProperty.call(inputPayload, 'pluginSidecars')
    ? { version: 1 as const, entries: finalSidecarEntries }
    : undefined;
  const mergedPayloadBase = materializedPayload(canonical, now());
  const mergedPayload: SyncPayload = {
    ...mergedPayloadBase,
    ...(finalPluginSidecars ? { pluginSidecars: finalPluginSidecars } : {}),
  };
  const finalAiSessions = mergeRuntimeAiSessions(inputPayload, successfulRuntimes, cyclePayloadBaseByProvider, strategy);
  if (finalAiSessions !== undefined) mergedPayload.aiSessions = finalAiSessions;
  const localPayloadChanged = !cloudSyncPayloadsEqual(inputPayload, mergedPayload)
    || JSON.stringify(inputPayload.pluginSidecars ?? null)
      !== JSON.stringify(mergedPayload.pluginSidecars ?? null);
  let mergedPayloadApplied = false;
  if (hasSuccess && localPayloadChanged) {
    try {
      if (!options.applyPayload) {
        throw new Error(
          'Convergent sync produced remote changes without a protected payload applier',
        );
      }
      let committed = false;
      await options.applyPayload(mergedPayload, async () => {
        if (committed) return;
        await persistReplica(this, canonical, now());
        updateConflictState(this, canonical);
        committed = true;
      });
      if (!committed) {
        throw new Error('Convergent payload apply completed without committing its replica');
      }
    } catch (error) {
      this.state.pendingLocalSync = true;
      this.state.syncState = 'ERROR';
      this.state.lastError = errorMessage(error);
      this.notifyStateChange();
      throw error;
    }
    mergedPayloadApplied = true;
  } else if (hasSuccess) {
    await persistReplica(this, canonical, now());
    updateConflictState(this, canonical);
  } else {
    await persistReplica(this, durableBeforeVerification, now());
    updateConflictState(this, durableBeforeVerification);
  }
  const conflicts = currentConflicts(hasSuccess ? canonical : durableBeforeVerification);
  for (const runtime of runtimes) {
    if (
      runtime.verifiedState
      && !runtime.error
      && versionVectorDominates(runtime.verifiedState.vector, canonical.vector)
    ) {
      const result: SyncResult = {
        success: true,
        provider: runtime.provider,
        action: 'merge',
        version: runtime.verifiedFile?.meta.version ?? runtime.latestRemote?.meta.version,
        ...(localPayloadChanged ? { mergedPayload } : {}),
        ...(mergedPayloadApplied ? { mergedPayloadApplied: true } : {}),
        convergentConflicts: conflicts,
        convergentConflictCount: conflicts.length,
      };
      results.set(runtime.provider, result);
      this.emit({ type: 'SYNC_COMPLETED', provider: runtime.provider, result });
      this.addSyncHistoryEntry({
        timestamp: now(),
        provider: runtime.provider,
        action: 'merge',
        success: true,
        localVersion: result.version ?? this.state.localVersion,
        remoteVersion: result.version,
        deviceName: this.state.deviceName,
      });
    } else {
      const message = runtime.error ?? `Provider did not converge after ${maxRounds} verification rounds`;
      runtime.error = message;
      results.set(runtime.provider, failedResult(runtime.provider, message));
      updateProviderFailure(this, runtime.provider, message);
      this.emit({ type: 'SYNC_ERROR', provider: runtime.provider, error: message });
      this.addSyncHistoryEntry({
        timestamp: now(),
        provider: runtime.provider,
        action: 'merge',
        success: false,
        localVersion: this.state.localVersion,
        deviceName: this.state.deviceName,
        error: message,
      });
    }
  }

  this.state.localVersion = Math.max(
    this.state.localVersion,
    ...runtimes.map((runtime) => runtime.verifiedFile?.meta.version ?? 0),
  );
  this.state.localUpdatedAt = now();
  this.state.pendingLocalSync = !runtimes.every((runtime) => results.get(runtime.provider)?.success);
  if (hasSuccess) this.exitBlockedState();
  this.state.syncState = hasSuccess ? 'IDLE' : 'ERROR';
  this.state.lastError = hasSuccess
    ? null
    : runtimes.find((runtime) => runtime.error)?.error ?? 'Convergent sync failed';
  if (hasSuccess) {
    this.state.lastShrinkFinding = undefined;
  }
  this.saveSyncConfig();
  this.notifyStateChange();
  return results;
}

export async function withConvergentSyncWebLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    throw new Error('Convergent sync requires the Web Locks API to prevent concurrent window writes');
  }
  return locks.request(
    CONVERGENT_SYNC_LOCK,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error('Convergent sync is already running in another window');
      return task();
    },
  );
}

export async function syncAllProvidersConvergentlyImpl(
  this: any,
  inputPayload: SyncPayload,
  opts: {
    conflictActionOverride?: CloudSyncConflictAction;
    overrideShrink?: boolean;
    applyPayload?: (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => Promise<void>;
  } = {},
): Promise<Map<CloudProvider, SyncResult>> {
  try {
    const strategyOverride = opts.conflictActionOverride === 'upload-local'
      ? 'preferLocal'
      : opts.conflictActionOverride === 'download-remote'
        ? 'preferCloud'
        : undefined;
    return await withConvergentSyncWebLock(
      () => syncConvergentProvidersUnlockedImpl.call(this, inputPayload, {
        strategyOverride,
        overrideShrink: opts.overrideShrink,
        applyPayload: opts.applyPayload,
      }),
    );
  } catch (error) {
    const message = errorMessage(error);
    const results = new Map<CloudProvider, SyncResult>();
    for (const provider of connectedProviders(this)) {
      results.set(provider, failedResult(provider, message));
      updateProviderFailure(this, provider, error);
      this.emit({ type: 'SYNC_ERROR', provider, error: message });
    }
    this.state.syncState = 'ERROR';
    this.state.lastError = message;
    this.notifyStateChange();
    return results;
  }
}

export async function previewConvergentRecoveryImpl(
  this: any,
): Promise<SyncPayload | null> {
  return withConvergentSyncWebLock(async () => {
    if (this.state.securityState !== 'UNLOCKED' || !this.masterPassword) {
      throw new Error('Vault is locked');
    }
    const providers = connectedProviders(this);
    if (providers.length === 0) return null;
    const syncSecurityGeneration = getSyncSecurityGeneration(this);
    const runtimes = await runInitialDownloads(
      this,
      providers,
      syncSecurityGeneration,
      false,
    );
    const failed = runtimes.find((runtime) => runtime.error || !runtime.adapter);
    if (failed) {
      const message = failed.error ?? 'provider adapter unavailable';
      updateProviderFailure(this, failed.provider, message);
      throw new Error(`Recovery preflight failed for ${failed.provider}: ${message}`);
    }
    const remoteStates = runtimes.flatMap((runtime) => (
      runtime.verifiedState ? [runtime.verifiedState] : []
    ));
    if (remoteStates.length === 0) return null;
    const [first, ...rest] = remoteStates;
    let aiSessions: SyncPayload['aiSessions'];
    for (const runtime of runtimes) {
      const sessions = runtime.latestRemotePayload?.aiSessions;
      if (sessions !== undefined) aiSessions = mergeAiSessionLists(aiSessions, sessions);
    }
    return materializedPayload(mergeStates(first, rest), Date.now(), undefined, aiSessions);
  });
}

async function prepareConvergentConflictResolutionImpl(
  this: any,
  addressKey: string,
  candidateDot: string,
  now = Date.now(),
  pluginSidecars?: SyncPayload['pluginSidecars'],
  aiSessions?: SyncPayload['aiSessions'],
): Promise<{ state: ConvergentSyncStateV2; payload: SyncPayload; now: number }> {
  const replica = await this.loadConvergentReplica();
  if (!replica) throw new Error('Convergent sync replica is unavailable');
  const conflict = currentConflicts(replica.state).find(
    (entry) => convergentConflictAddressKey(entry.address) === addressKey,
  );
  if (!conflict) throw new Error('The convergent conflict no longer exists');
  const resolved = resolveConvergentFieldConflict(
    replica.state,
    conflict,
    candidateDot,
    this.state.deviceId,
    now,
  );
  // Prefer caller-provided current sidecars. Never fall back to a stale
  // provider baseline — that would revert plugin settings changed after the
  // last verified sync. When omitted, materialize without the field so apply
  // preserves local sidecars (legacy missing-field semantics).
  return {
    state: resolved,
    payload: materializedPayload(resolved, now, pluginSidecars, aiSessions),
    now,
  };
}

export async function resolveConvergentConflictAndSyncImpl(
  this: any,
  addressKey: string,
  candidateDot: string,
  applyPayload: (
    payload: SyncPayload,
    commitReplica: () => Promise<void>,
  ) => Promise<void>,
  options?: {
    pluginSidecars?: SyncPayload['pluginSidecars'];
    aiSessions?: SyncPayload['aiSessions'];
  },
): Promise<{ payload: SyncPayload; results: Map<CloudProvider, SyncResult> }> {
  return withConvergentSyncWebLock(async () => {
    const prepared = await prepareConvergentConflictResolutionImpl.call(
      this,
      addressKey,
      candidateDot,
      Date.now(),
      options?.pluginSidecars,
      options?.aiSessions,
    );
    let committed = false;
    await applyPayload(prepared.payload, async () => {
      if (committed) return;
      await persistReplica(this, prepared.state, prepared.now);
      updateConflictState(this, prepared.state);
      this.state.pendingLocalSync = true;
      this.notifyStateChange();
      committed = true;
    });
    if (!committed) {
      throw new Error('Convergent conflict apply completed without committing its replica');
    }
    const results = await syncConvergentProvidersUnlockedImpl.call(
      this,
      prepared.payload,
      { applyPayload },
    );
    const finalReplica = await this.loadConvergentReplica();
    if (!finalReplica) {
      throw new Error('Convergent sync replica disappeared after conflict propagation');
    }
    const finalPayload = materializedPayload(
      finalReplica.state,
      Date.now(),
      sidecarBundleFromPayload(prepared.payload),
      [...results.values()].find((result) => result.mergedPayload)?.mergedPayload?.aiSessions
        ?? prepared.payload.aiSessions,
    );
    return { payload: finalPayload, results };
  });
}

export async function downgradeConvergentSyncImpl(
  this: any,
  confirmed: boolean,
  buildLocalPayload: () => SyncPayload | Promise<SyncPayload>,
  applyPayload: (
    payload: SyncPayload,
    commitReplica: () => Promise<void>,
  ) => Promise<void>,
): Promise<Map<CloudProvider, SyncResult>> {
  if (!confirmed) throw new Error('Explicit confirmation is required to downgrade convergent sync');
  return withConvergentSyncWebLock(async () => {
    const syncSecurityGeneration = getSyncSecurityGeneration(this);
    assertSyncSecurityGeneration(this, syncSecurityGeneration);
    const providers = connectedProviders(this);
    const replica = await this.loadConvergentReplica();
    if (!replica) throw new Error('Convergent sync replica is unavailable');
    const localPayload = await buildLocalPayload();
    const localSidecars = sidecarBundleFromPayload(localPayload);
    assertSyncSecurityGeneration(this, syncSecurityGeneration);
    const results = new Map<CloudProvider, SyncResult>();
    this.state.syncState = 'SYNCING';
    this.state.lastError = null;
    const runtimes = await runInitialDownloads(this, providers, syncSecurityGeneration);
    const failedPreflight = runtimes.find((runtime) => runtime.error || !runtime.adapter);
    if (failedPreflight) {
      const message = `Downgrade preflight failed for ${failedPreflight.provider}: ${failedPreflight.error ?? 'provider adapter unavailable'}`;
      for (const provider of providers) {
        results.set(provider, failedResult(provider, message));
        if (provider === failedPreflight.provider) {
          updateProviderFailure(this, provider, failedPreflight.error ?? message);
        } else {
          this.updateProviderStatus(provider, 'error', message);
        }
      }
      this.state.pendingLocalSync = true;
      this.state.syncState = 'ERROR';
      this.state.lastError = message;
      this.notifyStateChange();
      return results;
    }

    const now = Date.now();
    const chatBaselines = new Map<CloudProvider, SyncPayload>();
    if (typeof this.loadConvergentProviderBaseline === 'function') {
      for (const runtime of runtimes) {
        const baseline = await this.loadConvergentProviderBaseline(runtime.provider) as ConvergentProviderBaselineV2 | null;
        if (baseline) chatBaselines.set(runtime.provider, baseline.materializedPayload);
      }
    }
    const downgradeAiSessions = mergeRuntimeAiSessions(localPayload, runtimes, chatBaselines, this.state.syncStrategy);
    // Pausing v2 stops synchronization, not local editing. Convert every
    // vault change made since the last persisted replica into causal local
    // writes before joining provider states; otherwise downgrade would
    // materialize the stale replica and overwrite those paused edits.
    // Prefer local sidecars, then three-way-merge each remote against that
    // provider's trusted baseline so explicit local resets are not resurrected
    // by a stale remote entry during downgrade.
    let downgradeSidecars = localSidecars;
    {
      const { mergePluginSyncSidecarsThreeWay } = await import('../../../domain/pluginSyncSidecar');
      let entries = Array.isArray(downgradeSidecars?.entries) ? [...downgradeSidecars.entries] : [];
      let sawRemote = false;
      for (const runtime of runtimes) {
        const remoteBundle = sidecarBundleFromPayload(
          runtime.verifiedPayload ?? runtime.latestRemotePayload,
        );
        if (!remoteBundle) continue;
        sawRemote = true;
        let baseForProvider: NonNullable<SyncPayload['pluginSidecars']>['entries'] = [];
        if (typeof this.loadConvergentProviderBaseline === 'function') {
          try {
            const baseline = await this.loadConvergentProviderBaseline(runtime.provider) as {
              materializedPayload?: SyncPayload;
            } | null;
            const baseBundle = baseline?.materializedPayload?.pluginSidecars;
            if (baseBundle && Array.isArray(baseBundle.entries)) {
              baseForProvider = baseBundle.entries;
            }
          } catch {
            // First cycle or missing baseline is fine.
          }
        }
        entries = mergePluginSyncSidecarsThreeWay({
          base: baseForProvider,
          local: entries,
          remote: Array.isArray(remoteBundle.entries) ? remoteBundle.entries : [],
        });
      }
      if (sawRemote || entries.length > 0) {
        downgradeSidecars = { version: 1, entries };
      }
    }
    const withLocalWrites = applyLegacySyncPayload(
      replica.state,
      materializedPayload(replica.state, now, downgradeSidecars),
      stripConvergentSyncEnvelope(localPayload),
      this.state.deviceId,
      now,
    );
    let canonical = mergeStates(
      withLocalWrites,
      runtimes.flatMap((runtime) => runtime.verifiedState ? [runtime.verifiedState] : []),
    );
    if (isPreserveDeletionsStrategy(this.state.syncStrategy)) {
      canonical = preserveSurvivingState(canonical, [
        localPayload,
        ...runtimes.flatMap((runtime) => runtime.latestRemotePayload ? [runtime.latestRemotePayload] : []),
      ], this.state.deviceId, now);
    }
    const conflicts = currentConflicts(canonical);
    if (conflicts.length > 0) {
      const message = `Resolve ${conflicts.length} convergent conflict(s) before downgrading`;
      for (const provider of providers) {
        results.set(provider, failedResult(provider, message));
        this.updateProviderStatus(provider, 'connected');
      }
      this.state.syncState = 'CONFLICT';
      this.state.lastError = message;
      this.notifyStateChange();
      if (providers.length === 0) {
        throw new Error(message);
      }
      return results;
    }

    const outgoing = materializedPayload(canonical, now, downgradeSidecars, downgradeAiSessions);
    assertSyncSecurityGeneration(this, syncSecurityGeneration);
    let committed = false;
    try {
      await applyPayload(outgoing, async () => {
        if (committed) return;
        await persistReplica(this, canonical, now);
        updateConflictState(this, canonical);
        this.state.pendingLocalSync = true;
        this.notifyStateChange();
        committed = true;
      });
      if (!committed) {
        throw new Error('Convergent downgrade apply completed without committing its replica');
      }
    } catch (error) {
      const message = errorMessage(error);
      for (const provider of providers) this.updateProviderStatus(provider, 'error', message);
      this.state.pendingLocalSync = true;
      this.state.syncState = 'ERROR';
      this.state.lastError = message;
      this.notifyStateChange();
      throw error;
    }
    assertSyncSecurityGeneration(this, syncSecurityGeneration);

    await Promise.all(runtimes.map(async (runtime) => {
      const { provider, adapter, latestRemote: before } = runtime;
      try {
        const file = await EncryptionService.encryptPayload(
          outgoing,
          this.masterPassword,
          this.state.deviceId,
          this.state.deviceName,
          packageJson.version,
          before?.meta.version ?? this.state.localVersion,
        );
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        await adapter.upload(file, {
          signal: this.activeSyncAbortSignal,
        });
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        const verifiedFile = await adapter.download({
          signal: this.activeSyncAbortSignal,
        });
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        if (!verifiedFile) throw new Error('Provider returned no file after downgrade');
        const verifiedPayload = await EncryptionService.decryptPayload(verifiedFile, this.masterPassword);
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        if (validateConvergentSyncPayload(verifiedFile.meta, verifiedPayload) !== null) {
          throw new Error('Provider still contains convergent metadata after downgrade');
        }
        if (!cloudSyncPayloadsEqual(outgoing, verifiedPayload)) {
          throw new Error('Provider payload changed while verifying downgrade');
        }
        await this.saveConvergentProviderBaseline({
          schemaVersion: 2,
          provider,
          remoteVersion: verifiedFile.meta.version,
          remoteUpdatedAt: verifiedFile.meta.updatedAt,
          remoteDeviceId: verifiedFile.meta.deviceId,
          materializedPayload: verifiedPayload,
          state: canonical,
        });
        // The convergent baseline above is removed after a successful
        // downgrade. Seed the legacy three-way base and remote anchor from the
        // exact verified v1 file before that cleanup, so the first legacy sync
        // cannot compare a post-downgrade edit against pre-migration metadata.
        await this.commitRemoteInspection(provider, verifiedFile, verifiedPayload);
        assertSyncSecurityGeneration(this, syncSecurityGeneration);
        results.set(provider, {
          success: true,
          provider,
          action: 'upload',
          version: verifiedFile.meta.version,
        });
        this.updateProviderStatus(provider, 'connected');
      } catch (error) {
        const message = updateProviderFailure(this, provider, error);
        results.set(provider, failedResult(provider, message));
      }
    }));
    let failed = [...results.values()].find((result) => !result.success);
    if (!failed) {
      try {
        this.completeConvergentSyncDowngrade(true);
      } catch (error) {
        const message = `Unable to finalize convergent downgrade: ${errorMessage(error)}`;
        if (providers.length === 0) {
          this.state.pendingLocalSync = true;
          this.state.syncState = 'ERROR';
          this.state.lastError = message;
          this.notifyStateChange();
          throw new Error(message);
        }
        for (const provider of providers) {
          results.set(provider, failedResult(provider, message));
          this.updateProviderStatus(provider, 'error', message);
        }
        failed = results.get(providers[0]!);
      }
    }
    this.state.pendingLocalSync = Boolean(failed);
    this.state.syncState = failed ? 'ERROR' : 'IDLE';
    this.state.lastError = failed?.error ?? null;
    this.notifyStateChange();
    return results;
  });
}
