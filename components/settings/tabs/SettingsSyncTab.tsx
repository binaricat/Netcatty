import React, { useCallback } from "react";
import type { PortForwardingRule } from "../../../domain/models";
import type { SyncPayload } from "../../../domain/sync";
import {
  buildCloudSyncPayload,
  applySyncPayload,
  getEffectivePortForwardingRulesForSync,
  prepareLocalVaultPayloadApply,
} from "../../../application/syncPayload";
import { applyProtectedSyncPayload } from "../../../application/localVaultBackups";
import type { SyncableVaultData } from "../../../application/syncPayload";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { getEffectiveKnownHosts } from "../../../infrastructure/syncHelpers";
import { CloudSyncSettings } from "../../CloudSyncSettings";
import { SettingsTabContent } from "../settings-ui";

export default function SettingsSyncTab(props: {
  vault: SyncableVaultData;
  portForwardingRules: PortForwardingRule[];
  importDataFromString: (data: string) => void | Promise<void>;
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
    return getEffectivePortForwardingRulesForSync(portForwardingRules) ?? [];
  }, [portForwardingRules]);

  const onBuildPayload = useCallback((): Promise<SyncPayload> => {
    return buildCloudSyncPayload(vault, getEffectivePortForwardingRules());
  }, [vault, getEffectivePortForwardingRules]);

  const onBuildLocalPayload = useCallback(async (): Promise<SyncPayload> => {
    const effectiveKnownHosts = getEffectiveKnownHosts(vault.knownHosts);
    const { buildLocalVaultPayloadAsync } = await import('../../../application/syncPayload');
    return buildLocalVaultPayloadAsync(
      { ...vault, knownHosts: effectiveKnownHosts ?? [] },
      getEffectivePortForwardingRules(),
    );
  }, [vault, getEffectivePortForwardingRules]);

  const onApplyMigrationPayload = useCallback(
    (payload: SyncPayload) =>
      applySyncPayload(payload, {
        importVaultData: importDataFromString,
        importPortForwardingRules,
        onSettingsApplied,
      }, { currentHosts: vault.hosts }),
    [importDataFromString, importPortForwardingRules, onSettingsApplied, vault.hosts],
  );

  const onApplyPayload = useCallback(
    (payload: SyncPayload) =>
      applyProtectedSyncPayload({
        buildPreApplyPayload: onBuildLocalPayload,
        applyPayload: () => onApplyMigrationPayload(payload),
        translateProtectiveBackupFailure: (message) =>
          t("cloudSync.localBackups.protectiveBackupFailed", { message }),
      }),
    [onApplyMigrationPayload, onBuildLocalPayload, t],
  );

  const onApplyConvergentPayload = useCallback(
    (
      payload: SyncPayload,
      commitReplica: () => Promise<void>,
    ) => applyProtectedSyncPayload({
      buildPreApplyPayload: onBuildLocalPayload,
      applyPayload: async () => {
        await onApplyMigrationPayload(payload);
        await commitReplica();
      },
      translateProtectiveBackupFailure: (message) =>
        t("cloudSync.localBackups.protectiveBackupFailed", { message }),
    }),
    [onApplyMigrationPayload, onBuildLocalPayload, t],
  );

  const onApplyLocalPayload = useCallback(
    (payload: SyncPayload) =>
      applyProtectedSyncPayload({
        buildPreApplyPayload: onBuildLocalPayload,
        prepareApply: () =>
          prepareLocalVaultPayloadApply(payload, {
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
        onBuildLocalPayload={onBuildLocalPayload}
        onApplyMigrationPayload={onApplyMigrationPayload}
        onApplyPayload={onApplyPayload}
        onApplyConvergentPayload={onApplyConvergentPayload}
        onApplyLocalPayload={onApplyLocalPayload}
        onClearLocalData={clearAllLocalData}
      />
    </SettingsTabContent>
  );
}
