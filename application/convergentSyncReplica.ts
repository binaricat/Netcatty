import type { SyncPayload } from '../domain/sync';
import {
  applyLegacySyncPayload,
  materializeSyncPayloadFromConvergentState,
  stripConvergentSyncEnvelope,
} from '../domain/convergentSync';
import { getCloudSyncManager } from '../infrastructure/services/CloudSyncManager';
import type { CloudSyncManager } from '../infrastructure/services/CloudSyncManager';
import { getConvergentSyncLocalConfig } from '../infrastructure/services/convergentSyncConfig';

/**
 * Local backups intentionally contain no active CRDT replica. After a restore,
 * translate the restored materialized snapshot into ordinary local writes so
 * tombstones and causal history remain intact.
 */
export async function recordRestoredPayloadAsConvergentWrites(
  restoredPayload: SyncPayload,
  now = Date.now(),
  dependencies: {
    manager?: CloudSyncManager;
    initialized?: boolean;
  } = {},
): Promise<void> {
  const initialized = dependencies.initialized
    ?? getConvergentSyncLocalConfig().initialized;
  if (!initialized) return;
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
  await manager.saveConvergentReplica({ schemaVersion: 2, state, updatedAt: now });
}
