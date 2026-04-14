import React, { useCallback } from "react";
import type { PortForwardingRule } from "../../../domain/models";
import type { SyncPayload } from "../../../domain/sync";
import { buildSyncPayload, applySyncPayload } from "../../../application/syncPayload";
import {
  createProtectiveLocalVaultBackup,
  withRestoreBarrier,
} from "../../../application/localVaultBackups";
import type { SyncableVaultData } from "../../../application/syncPayload";
import { STORAGE_KEY_PORT_FORWARDING } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { getEffectiveKnownHosts } from "../../../infrastructure/syncHelpers";
import { CloudSyncSettings } from "../../CloudSyncSettings";
import { SettingsTabContent } from "../settings-ui";

export default function SettingsSyncTab(props: {
  vault: SyncableVaultData;
  portForwardingRules: PortForwardingRule[];
  importDataFromString: (data: string) => void;
  importPortForwardingRules: (rules: PortForwardingRule[]) => void;
  clearVaultData: () => void;
  onSettingsApplied?: () => void;
}) {
  const {
    vault,
    portForwardingRules,
    importDataFromString,
    importPortForwardingRules,
    clearVaultData,
    onSettingsApplied,
  } = props;

  const onBuildPayload = useCallback((): SyncPayload => {
    // If hook state is empty but localStorage has data, the async store
    // initialization hasn't finished yet.  Read from localStorage directly
    // to avoid uploading empty arrays and overwriting the remote snapshot.
    let effectiveRules = portForwardingRules;
    if (effectiveRules.length === 0) {
      const stored = localStorageAdapter.read<PortForwardingRule[]>(
        STORAGE_KEY_PORT_FORWARDING,
      );
      if (stored && Array.isArray(stored) && stored.length > 0) {
        // Strip transient per-device fields (status, error, lastUsedAt)
        // that setGlobalRules persists to localStorage but shouldn't be
        // included in the cloud sync snapshot.
        effectiveRules = stored.map(({ status: _status, error: _error, ...rest }) => ({
          ...rest,
          status: "inactive" as const,
          error: undefined,
          lastUsedAt: undefined,
        }));
      }
    }

    const effectiveKnownHosts = getEffectiveKnownHosts(vault.knownHosts);

    return buildSyncPayload({ ...vault, knownHosts: effectiveKnownHosts }, effectiveRules);
  }, [vault, portForwardingRules]);

  const onApplyPayload = useCallback(
    async (payload: SyncPayload) => {
      // Callers from inside CloudSyncSettings already wrap destructive
      // ops (local-backup restore, conflict USE_REMOTE, Gist revision
      // restore) with `withRestoreBarrier`. This `onApplyPayload` is
      // also invoked by the same flows. Re-wrapping here is a
      // defense-in-depth: the barrier write is a cheap localStorage set
      // and nested calls just refresh the deadline, never race each
      // other. If no caller has set the barrier (e.g. future callers we
      // haven't converted yet), this guarantees it's held for the whole
      // apply window.
      await withRestoreBarrier(async () => {
        // Snapshot the payload BEFORE mutating local state so the
        // protective backup reflects what's being replaced. onBuildPayload
        // captures from React closures, so we call it once up-front
        // rather than after the apply has already overwritten storage.
        const pre = onBuildPayload();
        try {
          await createProtectiveLocalVaultBackup(pre);
        } catch (error) {
          console.error("[SettingsSyncTab] Failed to create protective backup:", error);
        }

        applySyncPayload(payload, {
          importVaultData: importDataFromString,
          importPortForwardingRules,
          onSettingsApplied,
        });
      });
    },
    [importDataFromString, importPortForwardingRules, onBuildPayload, onSettingsApplied],
  );

  const clearAllLocalData = useCallback(() => {
    clearVaultData();
    importPortForwardingRules([]);
  }, [clearVaultData, importPortForwardingRules]);

  return (
    <SettingsTabContent value="sync">
      <CloudSyncSettings
        onBuildPayload={onBuildPayload}
        onApplyPayload={onApplyPayload}
        onClearLocalData={clearAllLocalData}
      />
    </SettingsTabContent>
  );
}
