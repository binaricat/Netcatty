import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSymlink,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Import,
  LoaderCircle,
  Plug,
} from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { VaultImportFileEncoding } from "../../application/state/vaultImportFile";
import type { VaultImportOptions } from "../../application/state/vaultImportOptions";
import type { VaultImportProgress } from "../../application/state/vaultImportProgress";
import { usePluginVaultImporter } from "../../application/state/usePluginVaultImporter";
import {
  buildVaultImportDestination,
  getVaultImportPickerMode,
  selectVaultImportFiles,
  type VaultImportDestinationMode,
} from "../../application/state/vaultImportSelection";
import { getVaultCsvTemplate } from "../../domain/vaultImport";
import type {
  VaultImportDestination,
  VaultImportFormat,
} from "../../domain/vaultImport";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type ImportOption = {
  format: VaultImportFormat;
  label: string;
  iconSrc: string;
  accept: string;
};

const OPTIONS: ImportOption[] = [
  {
    format: "putty",
    label: "PuTTY",
    iconSrc: "/import/putty.png",
    accept: ".reg,.txt,.ini",
  },
  {
    format: "mobaxterm",
    label: "MobaXterm",
    iconSrc: "/import/moba.jpg",
    accept: ".ini,.mxtsessions,.txt,.mobaconf",
  },
  {
    format: "csv",
    label: "CSV",
    iconSrc: "/import/csv.png",
    accept: ".csv,.txt",
  },
  {
    format: "securecrt",
    label: "SecureCRT",
    iconSrc: "/import/securecrt.png",
    accept: ".ini,.txt",
  },
  {
    format: "ssh_config",
    label: "ssh_config",
    iconSrc: "/import/file.png",
    accept: "*",
  },
];

export type ImportOptions = VaultImportOptions;

export type ImportVaultDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFileSelected: (
    format: VaultImportFormat,
    files: File[],
    options?: ImportOptions,
  ) => void;
  onPluginPreviewCommit: (
    preview: NetcattyPluginImporterPreview,
    destination?: VaultImportDestination,
  ) => Promise<void> | void;
  getPluginPreviewAnalysis: (preview: NetcattyPluginImporterPreview) => {
    duplicateCount: number;
    validationErrorCount: number;
    safePreview: import("../../domain/pluginImporter").PluginImporterSafePreview;
  };
  groups?: string[];
};

type Translate = (key: string, values?: Record<string, unknown>) => string;
type ImportDialogStep =
  | "format"
  | "destination"
  | "ssh-mode"
  | "moba-encoding"
  | "securecrt-source";

export function VaultImportDestinationControls({
  mode,
  onModeChange,
  groups,
  existingGroup,
  onExistingGroupChange,
  existingGroupQuery = existingGroup,
  onExistingGroupQueryChange,
  newGroup,
  onNewGroupChange,
  t,
}: {
  mode: VaultImportDestinationMode;
  onModeChange: (mode: VaultImportDestinationMode) => void;
  groups: string[];
  existingGroup: string;
  onExistingGroupChange: (group: string) => void;
  existingGroupQuery?: string;
  onExistingGroupQueryChange?: (query: string) => void;
  newGroup: string;
  onNewGroupChange: (group: string) => void;
  t: Translate;
}) {
  const choices: Array<{
    mode: VaultImportDestinationMode;
    icon: React.ReactNode;
  }> = [
    { mode: "preserve", icon: <FolderTree className="h-4 w-4" /> },
    { mode: "existing", icon: <FolderOpen className="h-4 w-4" /> },
    { mode: "new", icon: <FolderPlus className="h-4 w-4" /> },
  ];
  const existingGroupListId = React.useId();
  const matchingGroups = useMemo(() => {
    const query = existingGroupQuery.trim().toLocaleLowerCase();
    return groups
      .filter((group) => !query || group.toLocaleLowerCase().includes(query))
      .slice(0, 50);
  }, [existingGroupQuery, groups]);
  return (
    <div className="space-y-3" data-import-destination-controls="true">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {choices.map((choice) => (
          <button
            key={choice.mode}
            type="button"
            data-import-destination-mode={choice.mode}
            aria-pressed={mode === choice.mode}
            onClick={() => onModeChange(choice.mode)}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors",
              mode === choice.mode
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border/60 bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "shrink-0",
                mode === choice.mode ? "text-primary" : "text-muted-foreground",
              )}
            >
              {choice.icon}
            </span>
            {t(`vault.import.destination.${choice.mode}`)}
          </button>
        ))}
      </div>
      {mode === "existing" && (
        <>
          <input
            type="text"
            list={existingGroupListId}
            value={existingGroupQuery}
            onChange={(event) => {
              const value = event.target.value;
              onExistingGroupQueryChange?.(value);
              onExistingGroupChange(groups.includes(value) ? value : "");
            }}
            placeholder={groups.length === 0
              ? t("vault.import.destination.noGroups")
              : t("vault.import.destination.existing")}
            aria-label={t("vault.import.destination.existing")}
            autoComplete="off"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          />
          <datalist id={existingGroupListId}>
            {matchingGroups.map((group) => (
              <option key={group} value={group} />
            ))}
          </datalist>
        </>
      )}
      {mode === "new" && (
        <input
          value={newGroup}
          onChange={(event) => onNewGroupChange(event.target.value)}
          placeholder={t("vault.import.destination.newPlaceholder")}
          aria-label={t("vault.import.destination.new")}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
        />
      )}
    </div>
  );
}

const PROGRESS_STAGE_KEYS = {
  reading: "vault.import.progress.reading",
  parsing: "vault.import.progress.parsing",
  preparing: "vault.import.progress.preparing",
  saving: "vault.import.progress.saving",
  complete: "vault.import.progress.complete",
  failed: "vault.import.progress.failed",
} as const;

export function VaultImportProgressView({
  progress,
  onClose,
  onCancel,
  t,
}: {
  progress: VaultImportProgress;
  onClose: () => void;
  onCancel?: () => void;
  t: Translate;
}) {
  const isRunning = progress.status === "running";
  const isComplete = progress.status === "complete";
  const stageText = t(PROGRESS_STAGE_KEYS[progress.stage]);
  const completionSummary = isComplete
    ? t("vault.import.progress.summary", {
      count: progress.imported ?? 0,
      skipped: progress.skipped ?? 0,
      duplicates: progress.duplicates ?? 0,
    })
    : null;
  const announcement = isRunning
    ? stageText
    : [stageText, completionSummary ?? progress.error].filter(Boolean).join(". ");

  return (
    <div className="flex flex-col items-center gap-5 py-2 text-center">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <div
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-2xl",
          isComplete
            ? "bg-emerald-500/10 text-emerald-500"
            : progress.status === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-primary/10 text-primary",
        )}
      >
        {isComplete ? (
          <CheckCircle2 className="h-7 w-7" />
        ) : progress.status === "error" ? (
          <AlertCircle className="h-7 w-7" />
        ) : (
          <LoaderCircle className="h-7 w-7 animate-spin" />
        )}
      </div>

      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-foreground">
          {isRunning ? t("vault.import.progress.title") : stageText}
        </h2>
        <p
          className="max-w-md truncate text-sm text-muted-foreground"
          title={progress.fileName}
        >
          {progress.formatLabel} ·{" "}
          {progress.totalFiles && progress.totalFiles > 1
            ? t("vault.import.progress.fileSummary", {
                name: progress.fileName,
                count: progress.totalFiles,
              })
            : progress.fileName}
        </p>
      </div>

      <div className="w-full space-y-2">
        <div
          role="progressbar"
          aria-label={stageText}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              progress.status === "error" ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{stageText}</span>
          <span>{progress.percent}%</span>
        </div>
        {isRunning && progress.totalFiles && progress.totalFiles > 1 && (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="min-w-0 truncate" title={progress.currentFileName}>
              {progress.currentFileName}
            </span>
            <span className="shrink-0">
              {t("vault.import.progress.fileCount", {
                completed: progress.completedFiles ?? 0,
                total: progress.totalFiles,
              })}
            </span>
          </div>
        )}
      </div>

      {isRunning ? (
        <p className="text-xs text-muted-foreground">
          {t("vault.import.progress.keepOpen")}
        </p>
      ) : isComplete ? (
        <p className="text-sm text-muted-foreground">
          {completionSummary}
        </p>
      ) : (
        <p className="text-sm text-destructive">{progress.error}</p>
      )}

      {isRunning && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={progress.stage === "saving"}
          className="w-full rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
      )}

      {!isRunning && (
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("common.close")}
        </button>
      )}
    </div>
  );
}

export function VaultImportProgressPanel({
  progress,
  onClose,
  onCancel,
  t,
}: {
  progress: VaultImportProgress;
  onClose: () => void;
  onCancel?: () => void;
  t: Translate;
}) {
  return (
    <div
      data-vault-import-progress-panel
      className="fixed bottom-4 right-4 z-50 max-h-[calc(100vh-2rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border/70 bg-background p-4 shadow-2xl"
    >
      <VaultImportProgressView
        progress={progress}
        onClose={onClose}
        onCancel={onCancel}
        t={t}
      />
    </div>
  );
}

export const ImportVaultDialog: React.FC<ImportVaultDialogProps> = ({
  open,
  onOpenChange,
  onFileSelected,
  onPluginPreviewCommit,
  getPluginPreviewAnalysis,
  groups = [],
}) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingFormatRef = useRef<VaultImportFormat | null>(null);
  const pendingOptionsRef = useRef<ImportOptions | undefined>(undefined);
  const [step, setStep] = useState<ImportDialogStep>("format");
  const [destinationMode, setDestinationMode] =
    useState<VaultImportDestinationMode>("preserve");
  const [existingGroup, setExistingGroup] = useState(groups[0] ?? "");
  const [existingGroupQuery, setExistingGroupQuery] = useState(groups[0] ?? "");
  const existingGroupQueryRef = useRef(existingGroupQuery);
  existingGroupQueryRef.current = existingGroupQuery;
  const [newGroup, setNewGroup] = useState("");
  const [mobaMasterPassword, setMobaMasterPassword] = useState("");
  const destination = buildVaultImportDestination({
    mode: destinationMode,
    existingGroup,
    newGroup,
    availableGroups: groups,
  });
  const destinationSummary = useMemo(() => {
    if (destinationMode === "preserve") {
      return t("vault.import.destination.preserve");
    }
    if (destinationMode === "existing") {
      return existingGroup || t("vault.import.destination.existing");
    }
    return newGroup.trim() || t("vault.import.destination.new");
  }, [destinationMode, existingGroup, newGroup, t]);
  useEffect(() => {
    const query = existingGroupQueryRef.current;
    if (query) {
      setExistingGroup(groups.includes(query) ? query : "");
      return;
    }
    const next = groups[0] ?? "";
    setExistingGroup(next);
    setExistingGroupQuery(next);
  }, [groups]);
  useEffect(() => {
    if (open) return;
    setStep("format");
    setDestinationMode("preserve");
    setExistingGroup(groups[0] ?? "");
    setExistingGroupQuery(groups[0] ?? "");
    setNewGroup("");
    setMobaMasterPassword("");
  }, [groups, open]);
  const pluginImporter = usePluginVaultImporter({
    open,
    onOpenChange,
    onPluginPreviewCommit,
    destination,
    t,
  });

  const downloadCsvTemplate = useCallback(() => {
    const csv = getVaultCsvTemplate();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "netcatty-vault-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const pickFile = useCallback(
    (
      format: VaultImportFormat,
      accept: string,
      options?: ImportOptions,
      secureCrtSource: "folder" | "file" = "folder",
    ) => {
      const input = fileInputRef.current;
      if (!input || !destination) return;
      const pickerMode = getVaultImportPickerMode(format, secureCrtSource);
      pendingFormatRef.current = format;
      pendingOptionsRef.current = { ...options, destination };
      input.accept = accept;
      input.multiple = pickerMode.multiple;
      if (pickerMode.directory) {
        input.setAttribute("webkitdirectory", "");
        input.setAttribute("directory", "");
      } else {
        input.removeAttribute("webkitdirectory");
        input.removeAttribute("directory");
      }
      input.value = "";
      input.click();
    },
    [destination],
  );

  const handleFormatClick = useCallback(
    (opt: ImportOption) => {
      if (opt.format === "ssh_config") {
        setStep("ssh-mode");
      } else if (opt.format === "mobaxterm") {
        setStep("moba-encoding");
      } else if (opt.format === "securecrt") {
        setStep("securecrt-source");
      } else {
        pickFile(opt.format, opt.accept);
      }
    },
    [pickFile],
  );

  const handleManagedChoice = useCallback(
    (managed: boolean) => {
      setStep("format");
      pickFile("ssh_config", "*", { managed });
    },
    [pickFile],
  );

  const handleMobaEncodingChoice = useCallback(
    (encoding: VaultImportFileEncoding) => {
      setStep("format");
      pickFile("mobaxterm", ".ini,.mxtsessions,.txt,.mobaconf", {
        encoding,
        masterPassword: mobaMasterPassword === "" ? undefined : mobaMasterPassword,
      });
    },
    [mobaMasterPassword, pickFile],
  );

  const handleSecureCrtChoice = useCallback(
    (source: "folder" | "file") => {
      setStep("format");
      pickFile("securecrt", ".ini", undefined, source);
    },
    [pickFile],
  );

  const onChangeFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const format = pendingFormatRef.current;
      const options = pendingOptionsRef.current;
      if (!format || !e.target.files) return;
      const files = selectVaultImportFiles(format, e.target.files);
      if (files.length === 0) return;
      onFileSelected(format, files, options);
      onOpenChange(false);
      e.target.value = "";
      pendingOptionsRef.current = undefined;
    },
    [onFileSelected, onOpenChange],
  );

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        setStep("format");
      }
      pluginImporter.handleOpenChange(newOpen);
    },
    [pluginImporter],
  );

  const previewAnalysis = useMemo(
    () =>
      pluginImporter.pluginPreview
        ? getPluginPreviewAnalysis(pluginImporter.pluginPreview)
        : {
            duplicateCount: 0,
            validationErrorCount: 0,
            safePreview: {
              items: [],
              warnings: [],
              errors: [],
              omittedItemCount: 0,
              omittedDiagnosticCount: 0,
            },
          },
    [getPluginPreviewAnalysis, pluginImporter.pluginPreview],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
          <>
            <DialogHeader className="text-center sm:text-center">
              {step === "destination" ? (
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
                  <FolderTree className="h-6 w-6" />
                </div>
              ) : step === "securecrt-source" ? (
                <div className="mx-auto flex h-14 w-14 items-center justify-center">
                  <img
                    src="/import/securecrt.png"
                    alt=""
                    className="h-10 w-10 object-contain"
                  />
                </div>
              ) : (
                <div className="mx-auto h-14 w-14 rounded-2xl bg-muted/60 border border-border/60 flex items-center justify-center">
                  <img
                    src="/import/file.png"
                    alt=""
                    className="h-8 w-8 object-contain"
                  />
                </div>
              )}
              <DialogTitle className={step === "destination" || step === "securecrt-source" ? "text-lg" : "text-xl"}>
                {step === "securecrt-source"
                  ? t("vault.import.securecrt.promptTitle")
                  : step === "destination"
                    ? t("vault.import.destination.settings")
                    : t("vault.import.title")}
              </DialogTitle>
              {step !== "destination" && step !== "securecrt-source" && (
                <DialogDescription className="mx-auto max-w-xl">
                  {step === "ssh-mode"
                    ? t("vault.import.sshConfig.chooseMode")
                    : step === "moba-encoding"
                      ? t("vault.import.mobaxterm.chooseEncoding")
                      : t("vault.import.desc")}
                </DialogDescription>
              )}
            </DialogHeader>

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={onChangeFile}
            />

            <div className="flex flex-col gap-4">
              {pluginImporter.pluginPreview ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
                    <div className="text-sm font-medium">
                      {t("vault.import.plugins.preview")}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {pluginImporter.previewSummary ||
                        t("vault.import.plugins.empty")}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {t("vault.import.plugins.summary", {
                        parsed: pluginImporter.pluginPreview.result.parsed,
                        warnings: pluginImporter.pluginPreview.result.warnings,
                        errors: pluginImporter.pluginPreview.result.errors,
                      })}
                    </div>
                    {previewAnalysis.duplicateCount > 0 ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("vault.import.plugins.duplicates", {
                          count: previewAnalysis.duplicateCount,
                        })}
                      </div>
                    ) : null}
                    {previewAnalysis.validationErrorCount > 0 ? (
                      <div className="mt-1 text-xs text-destructive">
                        {t("vault.import.plugins.validationErrors", {
                          count: previewAnalysis.validationErrorCount,
                        })}
                      </div>
                    ) : null}
                    {previewAnalysis.safePreview.items.length > 0 ? (
                      <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/50 bg-background/60 p-2">
                        {previewAnalysis.safePreview.items.map(
                          (item, index) => (
                            <div
                              key={`${item.kind}:${index}`}
                              className="flex min-w-0 items-start gap-2 text-xs"
                            >
                              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                                {t(`vault.import.plugins.kind.${item.kind}`)}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-foreground">
                                  {item.label}
                                </span>
                                {item.detail ? (
                                  <span className="block truncate text-muted-foreground">
                                    {item.detail}
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          ),
                        )}
                        {previewAnalysis.safePreview.omittedItemCount > 0 ? (
                          <div className="pt-1 text-xs text-muted-foreground">
                            {t("vault.import.plugins.moreItems", {
                              count:
                                previewAnalysis.safePreview.omittedItemCount,
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {[
                      ...previewAnalysis.safePreview.warnings,
                      ...previewAnalysis.safePreview.errors,
                    ].length > 0 ? (
                      <div className="mt-3 space-y-1" role="status">
                        {previewAnalysis.safePreview.warnings.map(
                          (message, index) => (
                            <div
                              key={`warning:${index}`}
                              className="text-xs text-amber-600 dark:text-amber-400"
                            >
                              {message}
                            </div>
                          ),
                        )}
                        {previewAnalysis.safePreview.errors.map(
                          (message, index) => (
                            <div
                              key={`error:${index}`}
                              className="text-xs text-destructive"
                            >
                              {message}
                            </div>
                          ),
                        )}
                        {previewAnalysis.safePreview.omittedDiagnosticCount >
                        0 ? (
                          <div className="text-xs text-muted-foreground">
                            {t("vault.import.plugins.moreDiagnostics", {
                              count:
                                previewAnalysis.safePreview
                                  .omittedDiagnosticCount,
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={pluginImporter.clearPluginPreview}
                    >
                      {t("common.back")}
                    </Button>
                    <Button
                      disabled={
                        pluginImporter.pluginPreview.result.errors > 0 ||
                        previewAnalysis.validationErrorCount > 0 ||
                        pluginImporter.pluginBusy
                      }
                      onClick={() => void pluginImporter.commitPluginPreview()}
                    >
                      {t("vault.import.plugins.commit")}
                    </Button>
                  </div>
                </div>
              ) : step === "ssh-mode" ? (
                <>
                  <div className="text-sm font-medium text-center text-muted-foreground">
                    {t("vault.import.sshConfig.modeQuestion")}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      type="button"
                      className={cn(
                        "group rounded-2xl border border-border/60 bg-background",
                        "px-4 py-6 hover:bg-muted/30 hover:border-border transition-colors",
                        "flex flex-col items-center gap-3",
                      )}
                      onClick={() => handleManagedChoice(false)}
                    >
                      <div className="h-12 w-12 rounded-xl bg-muted/60 flex items-center justify-center">
                        <Import className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {t("vault.import.sshConfig.importOnly")}
                      </div>
                      <div className="text-xs text-muted-foreground text-center">
                        {t("vault.import.sshConfig.importOnlyDesc")}
                      </div>
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "group rounded-2xl border border-primary/60 bg-primary/5",
                        "px-4 py-6 hover:bg-primary/10 hover:border-primary transition-colors",
                        "flex flex-col items-center gap-3",
                      )}
                      onClick={() => handleManagedChoice(true)}
                    >
                      <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                        <FileSymlink className="h-6 w-6 text-primary" />
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {t("vault.import.sshConfig.managed")}
                      </div>
                      <div className="text-xs text-muted-foreground text-center">
                        {t("vault.import.sshConfig.managedDesc")}
                      </div>
                    </button>
                  </div>
                  <p className="text-center text-xs text-muted-foreground">
                    {t("vault.import.sshConfig.managedDestinationHint")}
                  </p>
                  <button
                    type="button"
                    onClick={() => setStep("format")}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("common.back")}
                  </button>
                </>
              ) : step === "moba-encoding" ? (
                <>
                  <div className="text-sm font-medium text-center text-muted-foreground">
                    {t("vault.import.mobaxterm.encodingQuestion")}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {(
                      [
                        ["auto", "auto", "autoDesc", true],
                        ["utf-8", "utf8", "utf8Desc", false],
                        ["gb18030", "gb18030", "gb18030Desc", false],
                      ] as const
                    ).map(([encoding, labelKey, descKey, recommended]) => (
                      <button
                        key={encoding}
                        type="button"
                        className={cn(
                          "group rounded-2xl border bg-background px-4 py-5 transition-colors",
                          "flex flex-col items-center gap-3",
                          recommended
                            ? "border-primary/60 bg-primary/5 hover:bg-primary/10 hover:border-primary"
                            : "border-border/60 hover:bg-muted/30 hover:border-border",
                        )}
                        onClick={() => handleMobaEncodingChoice(encoding)}
                      >
                        <div
                          className={cn(
                            "h-12 w-12 rounded-xl flex items-center justify-center",
                            recommended ? "bg-primary/10" : "bg-muted/60",
                          )}
                        >
                          <Import
                            className={cn(
                              "h-6 w-6",
                              recommended
                                ? "text-primary"
                                : "text-muted-foreground",
                            )}
                          />
                        </div>
                        <div className="text-sm font-medium text-foreground">
                          {t(`vault.import.mobaxterm.${labelKey}`)}
                        </div>
                        <div className="text-xs text-muted-foreground text-center">
                          {t(`vault.import.mobaxterm.${descKey}`)}
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="space-y-2">
                    <label
                      htmlFor="moba-master-password"
                      className="block text-center text-sm font-medium text-muted-foreground"
                    >
                      {t("vault.import.mobaxterm.masterPassword")}
                    </label>
                    <Input
                      id="moba-master-password"
                      type="password"
                      autoComplete="off"
                      value={mobaMasterPassword}
                      onChange={(event) => setMobaMasterPassword(event.target.value)}
                      placeholder={t("vault.import.mobaxterm.masterPasswordPlaceholder")}
                    />
                    <p className="text-center text-xs text-muted-foreground">
                      {t("vault.import.mobaxterm.masterPasswordHint")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep("format")}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("common.back")}
                  </button>
                </>
              ) : step === "securecrt-source" ? (
                <>
                  <div
                    className="grid grid-cols-2 gap-3"
                    data-import-securecrt-prompt="true"
                  >
                    <button
                      type="button"
                      className={cn(
                        "group rounded-2xl border border-primary/60 bg-primary/5",
                        "px-3 py-5 hover:bg-primary/10 hover:border-primary transition-colors",
                        "flex flex-col items-center gap-2.5",
                      )}
                      onClick={() => handleSecureCrtChoice("folder")}
                    >
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
                        <FolderOpen className="h-5 w-5 text-primary" />
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {t("vault.import.securecrt.folder")}
                      </div>
                      <div className="text-xs leading-4 text-muted-foreground text-center">
                        {t("vault.import.securecrt.folderDesc")}
                      </div>
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "group rounded-2xl border border-border/60 bg-background",
                        "px-3 py-5 hover:bg-muted/30 hover:border-border transition-colors",
                        "flex flex-col items-center gap-2.5",
                      )}
                      onClick={() => handleSecureCrtChoice("file")}
                    >
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted/60">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {t("vault.import.securecrt.file")}
                      </div>
                      <div className="text-xs leading-4 text-muted-foreground text-center">
                        {t("vault.import.securecrt.fileDesc")}
                      </div>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep("format")}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("common.back")}
                  </button>
                </>
              ) : step === "destination" ? (
                <>
                  <VaultImportDestinationControls
                    mode={destinationMode}
                    onModeChange={(mode) => {
                      setDestinationMode(mode);
                      if (
                        mode === "existing"
                        && !existingGroup
                        && !existingGroupQuery
                        && groups[0]
                      ) {
                        setExistingGroup(groups[0]);
                        setExistingGroupQuery(groups[0]);
                      }
                      // Preserve needs no extra input — finish immediately.
                      if (mode === "preserve") setStep("format");
                    }}
                    groups={groups}
                    existingGroup={existingGroup}
                    onExistingGroupChange={setExistingGroup}
                    existingGroupQuery={existingGroupQuery}
                    onExistingGroupQueryChange={setExistingGroupQuery}
                    newGroup={newGroup}
                    onNewGroupChange={setNewGroup}
                    t={t}
                  />
                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setStep("format")}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t("common.back")}
                    </button>
                    {destinationMode !== "preserve" && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!destination}
                        onClick={() => setStep("format")}
                      >
                        {t("vault.import.destination.done")}
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-sm font-medium text-center text-muted-foreground">
                    {t("vault.import.chooseFormat")}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    {OPTIONS.map((opt) => (
                      <button
                        key={opt.format}
                        type="button"
                        disabled={!destination}
                        data-import-format={opt.format}
                        className={cn(
                          "group rounded-2xl border border-border/60 bg-background",
                          "px-3 py-4 hover:bg-muted/30 hover:border-border transition-colors",
                          "flex flex-col items-center gap-3 disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                        onClick={() => handleFormatClick(opt)}
                      >
                        <div className="h-16 flex items-center justify-center">
                          <img
                            src={opt.iconSrc}
                            alt=""
                            className={cn(
                              "max-h-12 w-14 object-contain",
                              opt.format === "mobaxterm" && "w-16",
                            )}
                          />
                        </div>
                        <div className="text-sm font-medium text-foreground">
                          {opt.label}
                        </div>
                      </button>
                    ))}
                  </div>

                  {pluginImporter.pluginProviders.length > 0 && (
                    <>
                      <div className="pt-2 text-sm font-medium text-center text-muted-foreground">
                        {t("vault.import.plugins.title")}
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {pluginImporter.pluginProviders.map((provider) => (
                          <button
                            key={provider.provider.id}
                            type="button"
                            disabled={pluginImporter.pluginBusy || !destination}
                            className="flex items-center gap-3 rounded-xl border border-border/60 p-3 text-left transition-colors hover:bg-muted/30 disabled:opacity-50"
                            onClick={() =>
                              pluginImporter.pickPluginFile(provider)
                            }
                          >
                            <span className="rounded-lg bg-primary/10 p-2 text-primary">
                              <Plug className="h-5 w-5" />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {pluginImporter.localizeProviderLabel(provider)}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {provider.pluginDisplayName ||
                                  provider.provider.id}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {pluginImporter.pluginBusy && (
                    <div
                      className="text-center text-sm text-muted-foreground"
                      role="status"
                    >
                      {pluginImporter.pluginProgress
                        ? t("vault.import.plugins.progress", {
                            completed: pluginImporter.pluginProgress.completed,
                            total: pluginImporter.pluginProgress.total ?? "?",
                            message:
                              pluginImporter.pluginProgress.message ?? "",
                          })
                        : t("vault.import.plugins.loading")}
                    </div>
                  )}
                  {pluginImporter.pluginError && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      {pluginImporter.pluginError}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/60">
                    <button
                      type="button"
                      data-import-destination-settings="true"
                      onClick={() => setStep("destination")}
                      className="inline-flex min-w-0 max-w-[60%] items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                      title={`${t("vault.import.destination.settings")}: ${destinationSummary}`}
                    >
                      <FolderTree className="h-3.5 w-3.5 shrink-0 opacity-80" />
                      <span className="min-w-0 truncate">
                        <span className="text-muted-foreground/80">
                          {t("vault.import.destination.settings")}
                        </span>
                        <span className="mx-1 text-muted-foreground/50">·</span>
                        <span className="text-foreground/90">{destinationSummary}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={downloadCsvTemplate}
                      className="shrink-0 text-xs text-primary hover:underline"
                    >
                      {t("vault.import.csv.downloadTemplate")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
      </DialogContent>
    </Dialog>
  );
};
