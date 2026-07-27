import { useCallback } from "react";
import {
  buildPluginImporterSafePreview,
  mergePluginImporterDrafts,
  normalizePluginImporterRecords,
  type PluginImporterDrafts,
} from "../../domain/pluginImporter";
import type { VaultImportDestination } from "../../domain/vaultImport";
import type { Host, Identity, Snippet, SSHKey } from "../../types";

type Translation = (key: string, params?: Record<string, unknown>) => string;

export type PluginImporterCommitRequest = {
  drafts: PluginImporterDrafts;
  destination?: VaultImportDestination;
};

type PluginImporterCommitOptions = {
  hosts: ReadonlyArray<Host>;
  identities: ReadonlyArray<Identity>;
  keys: ReadonlyArray<SSHKey>;
  snippets: ReadonlyArray<Snippet>;
  customGroups: ReadonlyArray<string>;
  onCommitPluginImporterData: (request: PluginImporterCommitRequest) => Promise<number>;
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
    const drafts = normalizePluginImporterRecords(preview.records);
    if (preview.result.errors > 0 || drafts.errors.length > 0) {
      throw new Error(drafts.errors[0] || t("vault.import.plugins.containsErrors"));
    }
    const addedCount = await onCommitPluginImporterData({ drafts, destination });
    onCommitSuccess?.(addedCount);
  }, [onCommitPluginImporterData, onCommitSuccess, t]);

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
