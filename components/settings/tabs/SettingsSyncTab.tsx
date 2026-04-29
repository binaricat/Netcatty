import React, { useCallback } from "react";
import type { PortForwardingRule } from "../../../domain/models";
import type { SyncPayload } from "../../../domain/sync";
import {
  applyLocalVaultPayload,
  buildLocalVaultPayload,
  buildSyncPayload,
  applySyncPayload,
} from "../../../application/syncPayload";
import { applyProtectedSyncPayload } from "../../../application/localVaultBackups";
import type { SyncableVaultData } from "../../../application/syncPayload";
import { useI18n } from "../../../application/i18n/I18nProvider";
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
  const { t } = useI18n();

  const getEffectivePortForwardingRules = useCallback((): PortForwardingRule[] => {
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

    return effectiveRules;
  }, [portForwardingRules]);

  const onBuildPayload = useCallback((): SyncPayload => {
    return buildSyncPayload(vault, getEffectivePortForwardingRules());
  }, [vault, getEffectivePortForwardingRules]);

  const onBuildLocalPayload = useCallback((): SyncPayload => {
    const effectiveKnownHosts = getEffectiveKnownHosts(vault.knownHosts);

    return buildLocalVaultPayload(
      { ...vault, knownHosts: effectiveKnownHosts ?? [] },
      getEffectivePortForwardingRules(),
    );
  }, [vault, getEffectivePortForwardingRules]);

  const onApplyPayload = useCallback(
    (payload: SyncPayload) =>
      applyProtectedSyncPayload({
        buildPreApplyPayload: onBuildLocalPayload,
        applyPayload: () =>
          applySyncPayload(payload, {
            importVaultData: importDataFromString,
            importPortForwardingRules,
            onSettingsApplied,
          }),
        translateProtectiveBackupFailure: (message) =>
          t("cloudSync.localBackups.protectiveBackupFailed", { message }),
      }),
    [importDataFromString, importPortForwardingRules, onBuildLocalPayload, onSettingsApplied, t],
  );

  const onApplyLocalPayload = useCallback(
    (payload: SyncPayload) =>
      applyProtectedSyncPayload({
        buildPreApplyPayload: onBuildLocalPayload,
        applyPayload: () =>
          applyLocalVaultPayload(payload, {
            importVaultData: importDataFromString,
            importPortForwardingRules,
            onSettingsApplied,
          }),
        translateProtectiveBackupFailure: (message) =>
          t("cloudSync.localBackups.protectiveBackupFailed", { message }),
      }),
    [importDataFromString, importPortForwardingRules, onBuildLocalPayload, onSettingsApplied, t],
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
        onApplyLocalPayload={onApplyLocalPayload}
        onClearLocalData={clearAllLocalData}
      />
    </SettingsTabContent>
  );
}
