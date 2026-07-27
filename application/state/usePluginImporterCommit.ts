import { useCallback } from "react";
import { sanitizeHost } from "../../domain/host";
import {
  applyPluginImporterDestination,
  buildPluginImporterSafePreview,
  mergePluginImporterDrafts,
  normalizePluginImporterRecords,
} from "../../domain/pluginImporter";
import type { VaultImportDestination } from "../../domain/vaultImport";
import type { Host, Identity, Snippet, SSHKey } from "../../types";

type Translation = (key: string, params?: Record<string, unknown>) => string;

type PluginImporterCommitData = {
  keys: SSHKey[];
  identities: Identity[];
  hosts: Host[];
  snippets: Snippet[];
  customGroups: string[];
};

type PluginImporterCommitOptions = {
  hosts: ReadonlyArray<Host>;
  identities: ReadonlyArray<Identity>;
  keys: ReadonlyArray<SSHKey>;
  snippets: ReadonlyArray<Snippet>;
  customGroups: ReadonlyArray<string>;
  onCommitPluginImporterData: (data: PluginImporterCommitData) => Promise<void> | void;
  onCommitSuccess?: (addedCount: number) => void;
  t: Translation;
};

export function usePluginImporterCommit({
  hosts,
  identities,
  keys,
  snippets,
  customGroups,
  onCommitPluginImporterData,
  onCommitSuccess,
  t,
}: PluginImporterCommitOptions) {
  const buildPluginImportMerge = useCallback((preview: NetcattyPluginImporterPreview) => {
    const drafts = normalizePluginImporterRecords(preview.records);
    return {
      drafts,
      merged: mergePluginImporterDrafts({
        hosts: [...hosts],
        identities: [...identities],
        keys: [...keys],
        snippets: [...snippets],
        customGroups: [...customGroups],
      }, drafts),
    };
  }, [customGroups, hosts, identities, keys, snippets]);

  const handlePluginPreviewCommit = useCallback(async (
    preview: NetcattyPluginImporterPreview,
    destination?: VaultImportDestination,
  ) => {
    const { drafts, merged } = buildPluginImportMerge(preview);
    if (preview.result.errors > 0 || drafts.errors.length > 0) {
      throw new Error(drafts.errors[0] || t("vault.import.plugins.containsErrors"));
    }
    const destinationApplied = applyPluginImporterDestination(
      merged,
      hosts.length,
      destination,
      customGroups,
    );
    await onCommitPluginImporterData({
      keys: destinationApplied.keys,
      identities: destinationApplied.identities,
      hosts: destinationApplied.hosts.map(sanitizeHost),
      snippets: destinationApplied.snippets,
      customGroups: destinationApplied.customGroups,
    });
    onCommitSuccess?.(destinationApplied.addedCount);
  }, [buildPluginImportMerge, customGroups, hosts.length, onCommitPluginImporterData, onCommitSuccess, t]);

  const getPluginPreviewAnalysis = useCallback((preview: NetcattyPluginImporterPreview) => {
    const { drafts, merged } = buildPluginImportMerge(preview);
    return {
      duplicateCount: merged.duplicateCount,
      validationErrorCount: drafts.errors.length,
      safePreview: buildPluginImporterSafePreview(drafts),
    };
  }, [buildPluginImportMerge]);

  return {
    handlePluginPreviewCommit,
    getPluginPreviewAnalysis,
  };
}
