import type {
  CloudProvider,
  ConvergentMigrationPreview,
  ConvergentProviderBaselineV2,
  SyncPayload,
} from '../domain/sync';
import {
  cloudSyncPayloadsEqual,
  materializeSyncPayloadFromConvergentState,
  planConvergentSyncMigration,
  stripConvergentSyncEnvelope,
  validateConvergentSyncPayload,
  type ConvergentMigrationPlan,
  type ConvergentMigrationProviderInput,
} from '../domain/convergentSync';
import { isProviderReadyForSync } from '../domain/sync';
import { getCloudSyncManager, type CloudSyncManager } from '../infrastructure/services/CloudSyncManager';
import {
  clearConvergentSyncLocalConfigAfterDowngrade,
  markConvergentSyncInitialized,
} from '../infrastructure/services/convergentSyncConfig';
import { applyProtectedSyncPayload } from './localVaultBackups';

export interface PreparedConvergentMigration {
  plan: ConvergentMigrationPlan;
  providerBaselines: ConvergentProviderBaselineV2[];
}

function selectLocalTrustedBaseline(baselines: SyncPayload[]): SyncPayload | null {
  if (baselines.length === 0) return null;
  const first = baselines[0];
  return baselines.every((baseline) => cloudSyncPayloadsEqual(first, baseline))
    ? first
    : null;
}

export async function prepareConvergentSyncMigration(
  localPayload: SyncPayload,
  manager: CloudSyncManager = getCloudSyncManager(),
  now = Date.now(),
): Promise<PreparedConvergentMigration> {
  if (!manager.isUnlocked()) throw new Error('Unlock cloud sync before preparing migration');
  const providers = (Object.entries(manager.getAllProviders()) as Array<[
    CloudProvider,
    ReturnType<CloudSyncManager['getProviderConnection']>,
  ]>)
    .filter(([, connection]) => isProviderReadyForSync(connection))
    .map(([provider]) => provider)
    .sort();
  const baselineByProvider = new Map<CloudProvider, SyncPayload | null>();
  const providerBaselines: ConvergentProviderBaselineV2[] = [];
  const inputs: ConvergentMigrationProviderInput[] = await Promise.all(
    providers.map(async (provider): Promise<ConvergentMigrationProviderInput> => {
      try {
        const convergentBaseline = await manager.loadConvergentProviderBaseline(provider);
        const baseline = convergentBaseline?.materializedPayload
          ?? await manager.loadSyncBase(provider);
        baselineByProvider.set(provider, baseline);
        const remote = await manager.downloadFromProvider(provider);
        if (!remote) return { provider, status: 'empty' };
        const remoteState = validateConvergentSyncPayload(remote.remoteFile.meta, remote.payload);
        if (remoteState) {
          providerBaselines.push({
            schemaVersion: 2,
            provider,
            remoteVersion: remote.remoteFile.meta.version,
            remoteUpdatedAt: remote.remoteFile.meta.updatedAt,
            remoteDeviceId: remote.remoteFile.meta.deviceId,
            materializedPayload: stripConvergentSyncEnvelope(remote.payload),
            state: remoteState,
          });
        }
        return {
          provider,
          status: 'ready',
          meta: remote.remoteFile.meta,
          payload: remote.payload,
          trustedBaseline: baseline,
        };
      } catch (error) {
        return {
          provider,
          status: 'unavailable',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const localTrustedBaseline = selectLocalTrustedBaseline(
    [...baselineByProvider.values()].filter((value): value is SyncPayload => value !== null),
  );
  return {
    providerBaselines: providerBaselines.sort((left, right) => left.provider.localeCompare(right.provider)),
    plan: planConvergentSyncMigration({
      localPayload: stripConvergentSyncEnvelope(localPayload),
      localTrustedBaseline,
      providers: inputs,
      deviceId: manager.getState().deviceId,
      now,
    }),
  };
}

export async function initializePreparedConvergentMigration(options: {
  prepared: PreparedConvergentMigration;
  buildPreApplyPayload: () => SyncPayload;
  applyPayload: (payload: SyncPayload) => void | Promise<void>;
  translateProtectiveBackupFailure: (message: string) => string;
  manager?: CloudSyncManager;
  now?: number;
  runProtectedApply?: typeof applyProtectedSyncPayload;
}): Promise<ConvergentMigrationPreview> {
  const { prepared } = options;
  const manager = options.manager ?? getCloudSyncManager();
  const now = options.now ?? Date.now();
  if (!prepared.plan.preview.canInitialize || !prepared.plan.state || !prepared.plan.payload) {
    throw new Error(`Convergent migration is blocked: ${prepared.plan.preview.blockedReasons.join('; ')}`);
  }
  if (!manager.isUnlocked()) {
    throw new Error('Unlock cloud sync before initializing convergent migration');
  }
  const runProtectedApply = options.runProtectedApply ?? applyProtectedSyncPayload;
  await runProtectedApply({
    buildPreApplyPayload: options.buildPreApplyPayload,
    translateProtectiveBackupFailure: options.translateProtectiveBackupFailure,
    applyPayload: async () => {
      await options.applyPayload(prepared.plan.payload as SyncPayload);
      for (const baseline of prepared.providerBaselines) {
        await manager.saveConvergentProviderBaseline(baseline);
      }
      await manager.saveConvergentReplica({
        schemaVersion: 2,
        state: prepared.plan.state as NonNullable<ConvergentMigrationPlan['state']>,
        updatedAt: now,
      });
      markConvergentSyncInitialized();
    },
  });
  return prepared.plan.preview;
}

export async function prepareConvergentSyncDowngrade(
  manager: CloudSyncManager = getCloudSyncManager(),
  now = Date.now(),
): Promise<SyncPayload> {
  const replica = await manager.loadConvergentReplica();
  if (!replica) throw new Error('No convergent sync replica is available to downgrade');
  return materializeSyncPayloadFromConvergentState(replica.state, { syncedAt: now });
}

/** Call only after PR3's provider integration has replaced every v2 cloud file with v1. */
export function completeConvergentSyncDowngrade(
  confirmed: boolean,
  manager: CloudSyncManager = getCloudSyncManager(),
): void {
  if (!confirmed) throw new Error('Explicit confirmation is required to complete downgrade');
  manager.clearConvergentSyncStorage(true);
  clearConvergentSyncLocalConfigAfterDowngrade(true);
}
