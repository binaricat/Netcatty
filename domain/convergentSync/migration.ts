import {
  hasSyncPayloadEntityData,
  type CloudProvider,
  type ConvergentMigrationPreview,
  type ConvergentProviderMigrationStatus,
  type SyncFileMeta,
  type SyncPayload,
} from '../sync';
import { detectSuspiciousShrink } from '../syncGuards';
import { mergeSyncPayloads } from '../syncMerge';
import { summarizeSyncChanges } from '../syncReliability';
import { mergeConvergentSyncStates, materializeConvergentSyncState } from './state';
import type { ConvergentSyncStateV2 } from './types';
import {
  cloudSyncPayloadsEqual,
  applyLegacySyncPayload,
  inheritOmittedLegacySyncFields,
} from './legacy';
import {
  CONVERGENT_ENTITY_COLLECTIONS,
  CONVERGENT_STRING_COLLECTIONS,
  createConvergentSyncStateFromPayload,
  hydrateConvergentSyncEnvelope,
  materializeSyncPayloadFromConvergentState,
  withConvergentSyncEnvelope,
} from './payload';
import {
  mergePluginSyncSidecars,
  mergePluginSyncSidecarsThreeWay,
} from '../pluginSyncSidecar';

/** LWW-union plugin sidecars from every migration input that carries them. */
function mergeMigrationSidecars(
  ...bundles: Array<SyncPayload['pluginSidecars'] | null | undefined>
): SyncPayload['pluginSidecars'] | undefined {
  let entries: NonNullable<SyncPayload['pluginSidecars']>['entries'] = [];
  let sawAny = false;
  for (const bundle of bundles) {
    if (!bundle || !Array.isArray(bundle.entries)) continue;
    sawAny = true;
    entries = mergePluginSyncSidecars({ local: entries, remote: bundle });
  }
  return sawAny ? { version: 1, entries } : undefined;
}

/**
 * Three-way merge local sidecars against each remote source using that
 * source's trusted baseline (falls back to local baseline). Preserves
 * explicit local deletions instead of resurrecting them via LWW union.
 */
function mergeMigrationSidecarsWithBaselines(options: {
  local: SyncPayload['pluginSidecars'] | null | undefined;
  localBaseline: SyncPayload['pluginSidecars'] | null | undefined;
  sources: Array<{
    remote: SyncPayload['pluginSidecars'] | null | undefined;
    baseline: SyncPayload['pluginSidecars'] | null | undefined;
  }>;
}): SyncPayload['pluginSidecars'] | undefined {
  let entries = Array.isArray(options.local?.entries) ? [...options.local.entries] : [];
  const localBase = Array.isArray(options.localBaseline?.entries)
    ? options.localBaseline.entries
    : [];
  let sawAny = Array.isArray(options.local?.entries);
  for (const source of options.sources) {
    if (!source.remote || !Array.isArray(source.remote.entries)) continue;
    sawAny = true;
    const base = Array.isArray(source.baseline?.entries)
      ? source.baseline.entries
      : localBase;
    entries = mergePluginSyncSidecarsThreeWay({
      base,
      local: entries,
      remote: source.remote.entries,
    });
  }
  if (!sawAny) return undefined;
  return { version: 1, entries };
}

// Chats use their existing transcript merge, not a new CRDT collection. A
// chat-only difference therefore needs no causal vault baseline to migrate.
function vaultPayloadsEqual(left: SyncPayload, right: SyncPayload): boolean {
  return cloudSyncPayloadsEqual(
    { ...left, aiSessions: undefined },
    { ...right, aiSessions: undefined },
  );
}

/*
 * A local snapshot with no cloud entities and no trusted base is a fresh
 * device, not an untrusted deletion. Settings are intentionally ignored here
 * because first-launch defaults must not prevent adoption of an existing v2
 * vault. Once a trusted base exists, an empty snapshot remains a real deletion.
 */
function shouldIncludeLegacyLocalSource(
  payload: SyncPayload,
  trustedBaseline: SyncPayload | null,
): boolean {
  return trustedBaseline !== null
    || hasSyncPayloadEntityData(payload, [...CONVERGENT_ENTITY_COLLECTIONS, ...CONVERGENT_STRING_COLLECTIONS]);
}

export type ConvergentMigrationProviderInput =
  | { provider: CloudProvider; status: 'empty' }
  | { provider: CloudProvider; status: 'unavailable'; message: string }
  | {
      provider: CloudProvider;
      status: 'ready';
      meta: SyncFileMeta;
      payload: SyncPayload;
      trustedBaseline: SyncPayload | null;
    };

export interface ConvergentMigrationPlan {
  preview: ConvergentMigrationPreview;
  state: ConvergentSyncStateV2 | null;
  payload: SyncPayload | null;
}

function runtimeSchema(meta: SyncFileMeta): 1 | 2 | 'future' | 'invalid' {
  const value = (meta as { syncSchemaVersion?: unknown }).syncSchemaVersion;
  if (value === undefined) return 1;
  if (value === 2) return 2;
  if (typeof value === 'number' && Number.isInteger(value) && value > 2) return 'future';
  return 'invalid';
}

function countSettingsLeaves(value: unknown, root = true): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value === undefined ? 0 : 1;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return root ? 0 : 1;
  return entries.reduce<number>(
    (total, child) => total + countSettingsLeaves(child, false),
    0,
  );
}

function entityCount(payload: SyncPayload, key: string): number {
  const value = (payload as unknown as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : 0;
}

function statusFor(
  input: ConvergentMigrationProviderInput,
  schemaVersion: ConvergentProviderMigrationStatus['schemaVersion'],
  status: ConvergentProviderMigrationStatus['status'],
  message?: string,
): ConvergentProviderMigrationStatus {
  return {
    provider: input.provider,
    status,
    schemaVersion,
    entityCount: input.status === 'ready'
      ? [...CONVERGENT_ENTITY_COLLECTIONS, ...CONVERGENT_STRING_COLLECTIONS]
          .reduce((total, key) => total + entityCount(input.payload, key), 0)
      : 0,
    hasTrustedBaseline: input.status === 'ready' && input.trustedBaseline !== null,
    ...(message ? { message } : {}),
  };
}

export function planConvergentSyncMigration(options: {
  localPayload: SyncPayload;
  localTrustedBaseline: SyncPayload | null;
  providers: ConvergentMigrationProviderInput[];
  deviceId: string;
  now: number;
  preserveDeletions?: boolean;
}): ConvergentMigrationPlan {
  const providers = [...options.providers].sort((left, right) => left.provider.localeCompare(right.provider));
  const blockedReasons: string[] = [];
  const providerStatuses: ConvergentProviderMigrationStatus[] = [];
  const shrinkFindings: ConvergentMigrationPreview['shrinkFindings'] = [];
  const v1Inputs: Extract<ConvergentMigrationProviderInput, { status: 'ready' }>[] = [];
  const v2Inputs: Array<Extract<ConvergentMigrationProviderInput, { status: 'ready' }> & { state: ConvergentSyncStateV2 }> = [];

  for (const input of providers) {
    if (input.status === 'empty') {
      providerStatuses.push(statusFor(input, 1, 'empty'));
      continue;
    }
    if (input.status === 'unavailable') {
      blockedReasons.push(`${input.provider}: ${input.message}`);
      providerStatuses.push(statusFor(input, 'invalid', 'unavailable', input.message));
      continue;
    }
    const schema = runtimeSchema(input.meta);
    if (schema === 'future' || schema === 'invalid') {
      const message = schema === 'future'
        ? 'Provider contains a newer sync schema'
        : 'Provider contains invalid sync schema metadata';
      blockedReasons.push(`${input.provider}: ${message}`);
      providerStatuses.push(statusFor(input, schema, 'blocked', message));
      continue;
    }
    if (schema === 1) {
      if (input.payload.convergentSync) {
        const message = 'Provider envelope does not match its plaintext schema metadata';
        blockedReasons.push(`${input.provider}: ${message}`);
        providerStatuses.push(statusFor(input, 'invalid', 'blocked', message));
      } else {
        v1Inputs.push(input);
        providerStatuses.push(statusFor(input, 1, 'ready'));
      }
      continue;
    }
    try {
      if (!input.payload.convergentSync) throw new Error('missing convergent envelope');
      const state = hydrateConvergentSyncEnvelope(input.payload.convergentSync, input.payload);
      v2Inputs.push({ ...input, state });
      providerStatuses.push(statusFor(input, 2, 'ready'));
    } catch (error) {
      const message = `Damaged convergent envelope: ${error instanceof Error ? error.message : String(error)}`;
      blockedReasons.push(`${input.provider}: ${message}`);
      providerStatuses.push(statusFor(input, 'invalid', 'blocked', message));
    }
  }

  let state: ConvergentSyncStateV2 | null = null;
  let materialized: SyncPayload | null = null;

  if (blockedReasons.length === 0 && v2Inputs.length === 0) {
    const includeLocalSource = shouldIncludeLegacyLocalSource(
      options.localPayload,
      options.localTrustedBaseline,
    );
    const seedFromProvider = !includeLocalSource && v1Inputs.length > 0;
    let merged = seedFromProvider ? v1Inputs[0].payload : options.localPayload;
    if (seedFromProvider) {
      const seed = v1Inputs[0];
      merged = {
        ...merged,
        aiSessions: mergeSyncPayloads(null, options.localPayload, merged).payload.aiSessions,
      };
      const shrink = detectSuspiciousShrink(
        seed.payload,
        seed.trustedBaseline,
        seed.payload,
      );
      if (shrink.suspicious) {
        shrinkFindings.push({ provider: seed.provider, finding: shrink });
        blockedReasons.push(`${seed.provider}: legacy migration would remove too many entities`);
      }
    }
    const remainingInputs = seedFromProvider ? v1Inputs.slice(1) : v1Inputs;
    for (const input of remainingInputs) {
      if (!input.trustedBaseline) {
        if (!vaultPayloadsEqual(merged, input.payload)) {
          blockedReasons.push(`${input.provider}: no trusted legacy baseline is available`);
        }
        merged = {
          ...merged,
          aiSessions: mergeSyncPayloads(null, merged, input.payload).payload.aiSessions,
        };
        continue;
      }
      const result = mergeSyncPayloads(input.trustedBaseline, merged, input.payload, {
        preserveDeletions: options.preserveDeletions,
      });
      const vaultMerge = mergeSyncPayloads(
        { ...input.trustedBaseline, aiSessions: undefined },
        { ...merged, aiSessions: undefined },
        { ...input.payload, aiSessions: undefined },
        { preserveDeletions: options.preserveDeletions },
      );
      const changeSummary = summarizeSyncChanges(
        input.trustedBaseline,
        merged,
        input.payload,
      );
      if (vaultMerge.hadConflicts || changeSummary.conflicts.some((conflict) => conflict.entityType !== 'aiSessions')) {
        blockedReasons.push(`${input.provider}: legacy smart merge has unresolved conflicts`);
      }
      const shrink = detectSuspiciousShrink(result.payload, input.trustedBaseline, input.payload);
      if (shrink.suspicious) {
        shrinkFindings.push({ provider: input.provider, finding: shrink });
        blockedReasons.push(`${input.provider}: legacy migration would remove too many entities`);
      }
      merged = result.payload;
    }
    if (blockedReasons.length === 0) {
      state = createConvergentSyncStateFromPayload(merged, options.deviceId, options.now);
      // Prefer the three-way merge result already on `merged` (preserves
      // explicit sidecar deletions). Do not re-LWW raw provider bundles —
      // that would resurrect entries three-way merge correctly removed.
      const migrationSidecars = Object.prototype.hasOwnProperty.call(merged, 'pluginSidecars')
        ? merged.pluginSidecars
        : mergeMigrationSidecars(
          options.localPayload.pluginSidecars,
          ...v1Inputs.map((input) => input.payload.pluginSidecars),
        );
      materialized = materializeSyncPayloadFromConvergentState(state, {
        syncedAt: options.now,
        syncMeta: merged.syncMeta,
        ...(migrationSidecars ? { pluginSidecars: migrationSidecars } : {}),
        ...(merged.aiSessions !== undefined ? { aiSessions: merged.aiSessions } : {}),
      });
    }
  } else if (blockedReasons.length === 0) {
    state = v2Inputs.map((input) => input.state).reduce(mergeConvergentSyncStates);
    // Three-way per provider so local resets are not resurrected from a
    // still-stale remote entry during convergent enablement.
    const joinedSidecars = mergeMigrationSidecarsWithBaselines({
      local: options.localPayload.pluginSidecars,
      localBaseline: options.localTrustedBaseline?.pluginSidecars,
      sources: [
        ...v2Inputs.map((input) => ({
          remote: input.payload.pluginSidecars,
          baseline: input.trustedBaseline?.pluginSidecars,
        })),
        ...v1Inputs.map((input) => ({
          remote: input.payload.pluginSidecars,
          baseline: input.trustedBaseline?.pluginSidecars,
        })),
      ],
    });
    let joinedAiPayload = options.localPayload;
    for (const input of [...v2Inputs, ...v1Inputs]) {
      joinedAiPayload = {
        ...joinedAiPayload,
        aiSessions: mergeSyncPayloads(
          input.trustedBaseline ?? options.localTrustedBaseline,
          joinedAiPayload,
          input.payload,
          { preserveDeletions: options.preserveDeletions },
        ).payload.aiSessions,
      };
    }
    const joinedPayload = materializeSyncPayloadFromConvergentState(state, {
      syncedAt: options.now,
      ...(joinedSidecars ? { pluginSidecars: joinedSidecars } : {}),
      ...(joinedAiPayload.aiSessions !== undefined ? { aiSessions: joinedAiPayload.aiSessions } : {}),
    });
    const legacySources: Array<{
      id: string;
      payload: SyncPayload;
      baseline: SyncPayload | null;
      now: number;
      provider?: CloudProvider;
    }> = [
      ...(shouldIncludeLegacyLocalSource(
        options.localPayload,
        options.localTrustedBaseline,
      ) ? [{
        id: `legacy-local:${options.deviceId}`,
        payload: options.localPayload,
        baseline: options.localTrustedBaseline,
        now: options.now,
      }] : []),
      ...v1Inputs.map((input) => ({
        id: `legacy-provider:${input.provider}:${input.meta.deviceId}`,
        payload: input.payload,
        baseline: input.trustedBaseline,
        now: input.meta.updatedAt,
        provider: input.provider,
      })),
    ];
    const branches: ConvergentSyncStateV2[] = [];
    for (const source of legacySources) {
      if (vaultPayloadsEqual(source.payload, joinedPayload)) continue;
      if (!source.baseline) {
        blockedReasons.push(`${source.id}: no trusted legacy baseline is available`);
        continue;
      }
      const shrink = detectSuspiciousShrink(
        options.preserveDeletions
          ? mergeSyncPayloads(null, source.payload, joinedPayload, { preserveDeletions: true }).payload
          : inheritOmittedLegacySyncFields(source.baseline, source.payload),
        source.baseline,
      );
      if (shrink.suspicious) {
        if (source.provider) {
          shrinkFindings.push({ provider: source.provider, finding: shrink });
        }
        blockedReasons.push(`${source.id}: legacy migration would remove too many entities`);
        continue;
      }
      branches.push(applyLegacySyncPayload(state, source.baseline, source.payload, source.id, source.now));
    }
    if (blockedReasons.length === 0) {
      state = branches.reduce(mergeConvergentSyncStates, state);
      // joinedSidecars already unions local + all provider inputs. Re-LWW-ing
      // raw sources again cannot add unique entries and can confuse future
      // three-way paths that expect the joined set to be final.
      materialized = materializeSyncPayloadFromConvergentState(state, {
        syncedAt: options.now,
        ...(joinedSidecars ? { pluginSidecars: joinedSidecars } : {}),
        ...(joinedAiPayload.aiSessions !== undefined ? { aiSessions: joinedAiPayload.aiSessions } : {}),
      });
    }
  }

  if (options.preserveDeletions && state && materialized && blockedReasons.length === 0) {
    let retained = materialized;
    for (const source of [options.localPayload, ...v1Inputs.map((input) => input.payload), ...v2Inputs.map((input) => input.payload)]) {
      retained = mergeSyncPayloads(null, retained, source, { preserveDeletions: true }).payload;
    }
    state = applyLegacySyncPayload(state, materialized, {
      ...retained,
      settings: materialized.settings,
    }, options.deviceId, options.now);
    materialized = materializeSyncPayloadFromConvergentState(state, {
      syncedAt: options.now,
      pluginSidecars: materialized.pluginSidecars,
      aiSessions: retained.aiSessions,
    });
  }

  const conflicts = state ? materializeConvergentSyncState(state).conflicts : [];
  if (conflicts.length > 0) blockedReasons.push('The convergent state contains unresolved field conflicts');
  const canInitialize = blockedReasons.length === 0 && state !== null && materialized !== null;
  const payload = canInitialize && state
    ? withConvergentSyncEnvelope(state, {
      syncedAt: options.now,
      syncMeta: materialized?.syncMeta,
      ...(materialized?.pluginSidecars
        ? { pluginSidecars: materialized.pluginSidecars }
        : {}),
      ...(materialized?.aiSessions !== undefined ? { aiSessions: materialized.aiSessions } : {}),
    })
    : null;
  const previewPayload = materialized ?? options.localPayload;
  const entityCounts = Object.fromEntries(
    [...CONVERGENT_ENTITY_COLLECTIONS, ...CONVERGENT_STRING_COLLECTIONS]
      .map((key) => [key, entityCount(previewPayload, key)]),
  ) as ConvergentMigrationPreview['entityCounts'];
  return {
    preview: {
      schemaVersion: 2,
      canInitialize,
      entityCounts,
      settingsLeafCount: countSettingsLeaves(previewPayload.settings),
      conflictCount: conflicts.length,
      conflicts,
      shrinkFindings,
      providers: providerStatuses,
      oldClientCompatibility: 'materialized-v1-snapshot',
      blockedReasons,
    },
    state: canInitialize ? state : null,
    payload,
  };
}
