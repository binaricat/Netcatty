import type { SyncPayload } from '../domain/sync';
import {
  applyLegacySyncPayload,
  materializeSyncPayloadFromConvergentState,
  stripConvergentSyncEnvelope,
} from '../domain/convergentSync';
import { getCloudSyncManager } from '../infrastructure/services/CloudSyncManager';
import type { CloudSyncManager } from '../infrastructure/services/CloudSyncManager';
import { getConvergentSyncLocalConfig } from '../infrastructure/services/convergentSyncConfig';

export type CommitRestoredPayloadConvergentWrites = () => Promise<void>;

/**
 * Local backups intentionally contain no active CRDT replica. Before applying
 * a restore, validate the active replica and prepare ordinary local writes.
 * The returned commit persists them only after the local import succeeds, so
 * the replica never claims a restore that the local import rejected.
 */
export async function prepareRestoredPayloadConvergentWrites(
  restoredPayload: SyncPayload,
  now = Date.now(),
  dependencies: {
    manager?: CloudSyncManager;
    initialized?: boolean;
  } = {},
): Promise<CommitRestoredPayloadConvergentWrites> {
  const initialized = dependencies.initialized
    ?? getConvergentSyncLocalConfig().initialized;
  if (!initialized) return async () => {};
  const manager = dependencies.manager ?? getCloudSyncManager();
  const replica = await manager.loadConvergentReplica();
  if (!replica) {
    throw new Error('Convergent sync is initialized but its local replica is missing');
  }
  const baseline = materializeSyncPayloadFromConvergentState(replica.state, {
    syncedAt: replica.updatedAt,
  });
  const state = applyLegacySyncPayload(
    replica.state,
    baseline,
    stripConvergentSyncEnvelope(restoredPayload),
    manager.getState().deviceId,
    now,
  );
  return () => manager.saveConvergentReplica({ schemaVersion: 2, state, updatedAt: now });
}
