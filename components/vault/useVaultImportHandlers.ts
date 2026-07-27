import { startTransition, useCallback, useRef, useState } from "react";

import {
  readRememberedKeyPassphrases,
  rememberImportedKeyPassphrase,
  resolveDefaultKeyPassphraseAliases,
} from "../../application/defaultKeyPassphrases";
import {
  countVaultImportDuplicates,
  ensureVaultImportPersisted,
  waitForVaultImportProgressPaint,
  type VaultImportProgress,
} from "../../application/state/vaultImportProgress";
import { importVaultHostsInWorker } from "../../application/state/vaultImportWorker";
import { sanitizeHost } from "../../domain/host";
import {
  applyVaultImportDestination,
  applyVaultHostImport,
  filterVaultImportKeyPassphrasesAgainstExisting,
  mergeVaultImportIssues,
  resolveVaultImportKeyPassphraseConflicts,
  type VaultImportFormat,
} from "../../domain/vaultImport";
import type { Host, ManagedSource, SSHKey } from "../../types";
import type { ImportOptions } from "./ImportVaultDialog";
import { toast } from "../ui/toast";

interface UseVaultImportHandlersOptions {
  customGroups: string[];
  hosts: Host[];
  keys: SSHKey[];
  managedSources: ManagedSource[];
  onUpdateCustomGroups: (groups: string[]) => void;
  onUpdateHosts: (hosts: Host[]) => boolean | void | Promise<boolean | void>;
  onUpdateKeys: (keys: SSHKey[]) => void;
  onUpdateManagedSources: (sources: ManagedSource[]) => void;
  setIsImportOpen: (open: boolean) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
}

export function useVaultImportHandlers({
  customGroups,
  hosts,
  keys,
  managedSources,
  onUpdateCustomGroups,
  onUpdateHosts,
  onUpdateKeys,
  onUpdateManagedSources,
  setIsImportOpen,
  t,
}: UseVaultImportHandlersOptions) {
  const [importProgress, setImportProgress] = useState<VaultImportProgress | null>(null);
  const customGroupsRef = useRef(customGroups);
  const hostsRef = useRef(hosts);
  const keysRef = useRef(keys);
  const managedSourcesRef = useRef(managedSources);
  customGroupsRef.current = customGroups;
  hostsRef.current = hosts;
  keysRef.current = keys;
  managedSourcesRef.current = managedSources;
  const resetImportProgress = useCallback(() => setImportProgress(null), []);

  const handleImportFileSelected = useCallback(
      async (format: VaultImportFormat, files: File[], options?: ImportOptions) => {
        const file = files[0];
        if (!file) return;
        const relativeRoot = file.webkitRelativePath?.split(/[\\/]+/).filter(Boolean)[0];
        const selectionName = files.length > 1 ? (relativeRoot || file.name) : file.name;
        const formatLabel =
          format === "putty"
            ? "PuTTY"
            : format === "mobaxterm"
              ? "MobaXterm"
              : format === "csv"
                ? "CSV"
                : format === "securecrt"
                  ? "SecureCRT"
                  : "ssh_config";
        const updateProgress = (next: Partial<VaultImportProgress>) => {
          setImportProgress((current) => ({
            status: "running",
            stage: "reading",
            percent: 5,
            formatLabel,
            fileName: selectionName,
            totalFiles: files.length,
            ...current,
            ...next,
          }));
        };

        setIsImportOpen(true);
        setImportProgress({
          status: "running",
          stage: "reading",
          percent: 5,
          formatLabel,
          fileName: selectionName,
          completedFiles: 0,
          totalFiles: files.length,
        });

        try {
          let result = await importVaultHostsInWorker({
            format,
            files,
            encoding: options?.encoding,
            onProgress: (progress) => updateProgress(progress),
          });
          const isManaged = format === "ssh_config" && options?.managed === true;
          if (!isManaged) {
            result = applyVaultImportDestination(
              result,
              options?.destination ?? { mode: "preserve" },
            );
          }
          updateProgress({ stage: "preparing", percent: 70 });
          await waitForVaultImportProgressPaint();
          updateProgress({ stage: "saving", percent: 85 });
          await waitForVaultImportProgressPaint();

          const currentCustomGroups = customGroupsRef.current;
          const currentHosts = hostsRef.current;
          const currentManagedSources = managedSourcesRef.current;

          const fileBaseName = file.name.replace(/\.[^/.]+$/, "");
  
          // Generate unique managed group name (check for conflicts with existing sources,
          // custom groups, and host groups to avoid accidentally merging unrelated hosts)
          let managedGroupName = `${fileBaseName} - Managed`;
          if (isManaged) {
            const existingGroupNames = new Set([
              ...currentManagedSources.map(s => s.groupName),
              ...currentCustomGroups,
              ...currentHosts.map(h => h.group).filter((g): g is string => !!g),
            ]);
            let suffix = 1;
            while (existingGroupNames.has(managedGroupName)) {
              managedGroupName = `${fileBaseName} - Managed (${suffix})`;
              suffix++;
            }
          }
  
          // Check if this file is already managed
          const bridge = (window as unknown as { netcatty?: { getPathForFile?: (file: File) => string | undefined } }).netcatty;
          // Try bridge.getPathForFile first, then fall back to file.path (Electron legacy)
          const filePath = bridge?.getPathForFile?.(file) || (file as File & { path?: string }).path;
  
          if (isManaged && !filePath) {
            // Cannot proceed with managed import without a valid file path
            const message = t("vault.import.sshConfig.noFilePathDesc");
            updateProgress({
              status: "error",
              stage: "failed",
              percent: 100,
              error: message,
            });
            toast.error(
              message,
              t("vault.import.sshConfig.noFilePath"),
            );
            return;
          }
  
          if (isManaged) {
            const existingSource = currentManagedSources.find(s => s.filePath === filePath);
            if (existingSource) {
              const message = t("vault.import.sshConfig.alreadyManagedDesc", {
                group: existingSource.groupName,
              });
              updateProgress({
                status: "error",
                stage: "failed",
                percent: 100,
                error: message,
              });
              toast.error(
                message,
                t("vault.import.sshConfig.alreadyManaged"),
              );
              return;
            }
          }
  
          const makeKey = (h: Host) =>
            `${(h.protocol ?? "ssh").toLowerCase()}|${h.hostname.toLowerCase()}|${h.port}|${(h.username ?? "").toLowerCase()}`;
  
          const existingKeys = new Set(currentHosts.map(makeKey));
          // Filter out duplicates for both managed and non-managed imports
          let newHosts = result.hosts.filter((h) => !existingKeys.has(makeKey(h)));
  
          // For managed imports, also update existing hosts to be managed
          let updatedExistingHosts: Host[] = [];
          if (isManaged) {
            const importedKeys = new Set(result.hosts.map(makeKey));
            updatedExistingHosts = currentHosts.filter((h) => importedKeys.has(makeKey(h)));
          }
  
          if (isManaged && (newHosts.length > 0 || updatedExistingHosts.length > 0)) {
            const sourceId = crypto.randomUUID();
            const newSource: ManagedSource = {
              id: sourceId,
              type: "ssh_config",
              filePath: filePath,
              groupName: managedGroupName,
              lastSyncedAt: Date.now(),
            };
  
            newHosts = newHosts.map((h) => ({
              ...h,
              group: managedGroupName,
              // Only SSH hosts can be managed (SSH config only supports SSH)
              managedSourceId: (!h.protocol || h.protocol === "ssh") ? sourceId : undefined,
            }));
  
            // Update existing hosts to be managed (move to managed group)
            const existingHostIds = new Set(updatedExistingHosts.map(h => h.id));
            const updatedHosts = currentHosts.map((h) => {
              if (!existingHostIds.has(h.id)) return h;
              const canBeManaged = !h.protocol || h.protocol === "ssh";
              return {
                ...h,
                group: managedGroupName,
                managedSourceId: canBeManaged ? sourceId : undefined,
                // Sanitize label for managed hosts
                label: canBeManaged && h.label ? h.label.replace(/\s/g, '') : h.label,
              };
            });
  
            const nextGroups = Array.from(
              new Set([
                ...currentCustomGroups,
                ...result.groups,
                managedGroupName,
                ...newHosts.map((h) => h.group).filter(Boolean),
              ]),
            ) as string[];

            onUpdateManagedSources([...currentManagedSources, newSource]);
            let hostUpdate: boolean | void | Promise<boolean | void>;
            startTransition(() => {
	              hostUpdate = onUpdateHosts(
	                [...updatedHosts, ...newHosts].map((host: Host) => sanitizeHost(host)),
	              );
              onUpdateCustomGroups(nextGroups);
            });
            ensureVaultImportPersisted(
              await hostUpdate!,
              t("vault.import.progress.persistFailed"),
            );
          } else if (newHosts.length > 0) {
            const merged = applyVaultHostImport(currentHosts, currentCustomGroups, result, { skipDuplicates: true });
            const addedHostIds = new Set(merged.addedHosts.map((host) => host.id));
            const addedHostKeyPaths = new Map(merged.addedHosts.flatMap((host) => {
              const keyPath = host.identityFilePaths?.find((path) => path.trim())?.trim();
              return keyPath ? [[host.id, keyPath] as const] : [];
            }));
            let hostUpdate: boolean | void | Promise<boolean | void>;
            startTransition(() => {
              hostUpdate = onUpdateHosts(merged.hosts);
              onUpdateCustomGroups(merged.customGroups);
            });
            ensureVaultImportPersisted(
              await hostUpdate!,
              t("vault.import.progress.persistFailed"),
            );
            const resolved = await resolveVaultImportKeyPassphraseConflicts(
              result.keyPassphraseCandidates ?? result.keyPassphrases ?? [],
              resolveDefaultKeyPassphraseAliases,
              addedHostIds,
              addedHostKeyPaths,
            );
            const checked = await filterVaultImportKeyPassphrasesAgainstExisting(
              resolved.keyPassphrases,
              (keyPath) => readRememberedKeyPassphrases(keyPath, keysRef.current),
            );
            result.issues = mergeVaultImportIssues(
              result.issues,
              resolved.issues,
              checked.issues,
            );
            for (const entry of checked.keyPassphrases) {
              try {
                const saved = await rememberImportedKeyPassphrase({
                  keyPath: entry.keyPath,
                  passphrase: entry.passphrase,
                  keys: keysRef.current,
                  getKeys: () => keysRef.current,
                  updateKeys: onUpdateKeys,
                  setCurrentKeys: (updatedKeys) => {
                    keysRef.current = updatedKeys;
                  },
                });
                if (saved === "conflict") {
                  result.issues.push({
                    level: "warning",
                    message: `CSV passphrase conflicts with an existing saved passphrase for KeyPath "${entry.keyPath}"; the existing passphrase was kept.`,
                  });
                } else if (saved === "unreadable") {
                  result.issues.push({
                    level: "warning",
                    message: `Could not verify the existing saved passphrase for KeyPath "${entry.keyPath}"; the imported passphrase was not saved.`,
                  });
                }
              } catch {
                result.issues.push({
                  level: "warning",
                  message: `Could not save the passphrase for KeyPath "${entry.keyPath}".`,
                });
              }
            }
            result.issues = mergeVaultImportIssues(result.issues);
          }
  
          // Count total hosts affected (new + converted to managed)
          const totalAffected = newHosts.length + (isManaged ? updatedExistingHosts.length : 0);
  
          const skipped = result.stats.skipped;
          const duplicates = countVaultImportDuplicates({
            importedHostCount: result.hosts.length,
            newHostCount: newHosts.length,
            fileDuplicateCount: result.stats.duplicates,
            managed: isManaged,
          });
          const hasWarnings = skipped > 0 || duplicates > 0 || result.issues.length > 0;
  
          if (result.stats.parsed === 0 && totalAffected === 0) {
            const message = t("vault.import.toast.noEntries", { format: formatLabel });
            updateProgress({
              status: "error",
              stage: "failed",
              percent: 100,
              error: message,
            });
            toast.error(
              message,
              t("vault.import.toast.failedTitle"),
            );
            return;
          }
  
          if (totalAffected === 0) {
            updateProgress({
              status: "complete",
              stage: "complete",
              percent: 100,
              imported: 0,
              skipped,
              duplicates,
            });
            toast.warning(
              t("vault.import.toast.noNewHosts", { format: formatLabel }),
              t("vault.import.toast.completedTitle"),
            );
            return;
          }
  
          if (isManaged) {
            toast.success(
              t("vault.import.sshConfig.managedSuccess", { count: totalAffected }),
              t("vault.import.toast.completedTitle"),
            );
          } else {
            const details = t("vault.import.toast.summary", {
              count: totalAffected,
              skipped,
              duplicates,
            });
  
            if (hasWarnings) {
              const firstIssue = result.issues[0]?.message;
              toast.warning(
                firstIssue ? `${details} ${t("vault.import.toast.firstIssue", { issue: firstIssue })}` : details,
                t("vault.import.toast.completedTitle"),
              );
            } else {
              toast.success(details, t("vault.import.toast.completedTitle"));
            }
          }
          updateProgress({
            status: "complete",
            stage: "complete",
            percent: 100,
            imported: totalAffected,
            skipped,
            duplicates,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : t("common.unknownError");
          updateProgress({
            status: "error",
            stage: "failed",
            percent: 100,
            error: message,
          });
          toast.error(message, t("vault.import.toast.failedTitle"));
        }
      },
      [
        onUpdateCustomGroups,
        onUpdateHosts,
        onUpdateKeys,
        onUpdateManagedSources,
        setIsImportOpen,
        t,
      ],
    );

  return { handleImportFileSelected, importProgress, resetImportProgress };
}
