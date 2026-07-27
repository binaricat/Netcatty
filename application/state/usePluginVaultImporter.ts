import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VaultImportDestination } from "../../domain/vaultImport";
import { pluginExtensionBridge } from "./pluginExtensionBridge";

type Translation = (key: string, params?: Record<string, unknown>) => string;

type PluginVaultImporterOptions = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPluginPreviewCommit: (
    preview: NetcattyPluginImporterPreview,
    destination?: VaultImportDestination,
  ) => Promise<void> | void;
  destination?: VaultImportDestination | null;
  t: Translation;
};

const localizeProviderLabel = (
  provider: NetcattyExtensionProviderContribution,
  locale = typeof navigator === "undefined" ? "en" : navigator.language,
): string => {
  const label = provider.provider.label;
  if (typeof label === "string") return label;
  return label[locale] ?? label[locale.split("-")[0]] ?? label.en ?? provider.provider.id;
};

const summarizePluginImporterPreview = (preview: NetcattyPluginImporterPreview | null): string | null => {
  if (!preview) return null;
  const drafts = preview.records.filter((record) => record.type === "draft");
  const byKind = drafts.reduce<Record<string, number>>((counts, record) => {
    if (record.type === "draft") counts[record.draft.kind] = (counts[record.draft.kind] ?? 0) + 1;
    return counts;
  }, {});
  return Object.entries(byKind).map(([kind, count]) => `${kind}: ${count}`).join(" · ");
};

export function usePluginVaultImporter({
  open,
  onOpenChange,
  onPluginPreviewCommit,
  destination,
  t,
}: PluginVaultImporterOptions) {
  const activePluginImportRequestRef = useRef<string | null>(null);
  const pluginImportGenerationRef = useRef(0);
  const [pluginProviders, setPluginProviders] = useState<ReadonlyArray<NetcattyExtensionProviderContribution>>([]);
  const [pluginPreview, setPluginPreview] = useState<NetcattyPluginImporterPreview | null>(null);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [pluginProgress, setPluginProgress] = useState<NetcattyPluginImporterProgressEvent["progress"] | null>(null);

  useEffect(() => pluginExtensionBridge.onImporterProgress((event) => {
    if (event.requestId === activePluginImportRequestRef.current) setPluginProgress(event.progress);
  }), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void pluginExtensionBridge.listProviders("importer").then((providers) => {
      if (!cancelled) setPluginProviders(providers);
    }).catch(() => {
      if (!cancelled) setPluginProviders([]);
    });
    return () => { cancelled = true; };
  }, [open]);

  const resetPluginImporterState = useCallback(() => {
    pluginImportGenerationRef.current += 1;
    const requestId = activePluginImportRequestRef.current;
    activePluginImportRequestRef.current = null;
    if (requestId) void pluginExtensionBridge.cancelRequest(requestId).catch(() => false);
    setPluginPreview(null);
    setPluginError(null);
    setPluginProgress(null);
    setPluginBusy(false);
  }, []);

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen) resetPluginImporterState();
    onOpenChange(newOpen);
  }, [onOpenChange, resetPluginImporterState]);

  const pickPluginFile = useCallback((provider: NetcattyExtensionProviderContribution) => {
    if (pluginBusy) return;
    const generation = ++pluginImportGenerationRef.current;
    const isCurrent = () => pluginImportGenerationRef.current === generation;
    setPluginBusy(true);
    setPluginError(null);
    setPluginProgress(null);
    void (async () => {
      let selection: Awaited<ReturnType<typeof pluginExtensionBridge.selectImporterFile>> = null;
      let consumed = false;
      let requestId: string | null = null;
      try {
        selection = await pluginExtensionBridge.selectImporterFile();
        if (!selection || !isCurrent()) return;
        requestId = crypto.randomUUID();
        activePluginImportRequestRef.current = requestId;
        const detection = await pluginExtensionBridge.detectImporter({
          requestId,
          providerId: provider.provider.id,
          sample: selection.sample,
          fileName: selection.fileName,
        });
        if (!isCurrent()) return;
        if (detection && detection.confidence <= 0) {
          throw new Error(detection.reason || t("vault.import.plugins.notRecognized"));
        }
        const preview = await pluginExtensionBridge.parseImporterFile({
          requestId,
          providerId: provider.provider.id,
          selectionToken: selection.selectionToken,
        });
        consumed = true;
        if (isCurrent()) setPluginPreview(preview);
      } catch (error) {
        if (isCurrent()) setPluginError(error instanceof Error ? error.message : t("common.unknownError"));
      } finally {
        if (activePluginImportRequestRef.current === requestId) activePluginImportRequestRef.current = null;
        if (selection && !consumed) {
          await pluginExtensionBridge.releaseImporterFile(selection.selectionToken).catch(() => false);
        }
        if (isCurrent()) {
          setPluginBusy(false);
          setPluginProgress(null);
        }
      }
    })();
  }, [pluginBusy, t]);

  const commitPluginPreview = useCallback(async () => {
    if (!pluginPreview || pluginBusy) return;
    setPluginBusy(true);
    setPluginError(null);
    try {
      await onPluginPreviewCommit(pluginPreview, destination ?? undefined);
      handleOpenChange(false);
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : t("common.unknownError"));
    } finally {
      setPluginBusy(false);
    }
  }, [destination, handleOpenChange, onPluginPreviewCommit, pluginBusy, pluginPreview, t]);

  const previewSummary = useMemo(() => summarizePluginImporterPreview(pluginPreview), [pluginPreview]);

  return {
    pluginProviders,
    pluginPreview,
    pluginBusy,
    pluginError,
    pluginProgress,
    previewSummary,
    pickPluginFile,
    commitPluginPreview,
    clearPluginPreview: () => setPluginPreview(null),
    handleOpenChange,
    localizeProviderLabel,
  };
}
