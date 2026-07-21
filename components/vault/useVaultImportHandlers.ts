import { useCallback, useRef } from "react";

import {
  readRememberedKeyPassphrases,
  rememberImportedKeyPassphrase,
  resolveDefaultKeyPassphraseAliases,
} from "../../application/defaultKeyPassphrases";
import { readVaultImportFile } from "../../application/state/vaultImportFile";
import { sanitizeHost } from "../../domain/host";
import {
  applyVaultHostImport,
  filterVaultImportKeyPassphrasesAgainstExisting,
  importVaultHostsFromText,
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
  onUpdateHosts: (hosts: Host[]) => void;
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
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const handleImportFileSelected = useCallback(
      async (format: VaultImportFormat, file: File, options?: ImportOptions) => {
        setIsImportOpen(false);
  
        try {
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
  
          toast.info(t("vault.import.toast.start", { format: formatLabel }));
  
          const text = await readVaultImportFile(format, file, options?.encoding);
          const result = importVaultHostsFromText(format, text, {
            fileName: file.name,
          });
  
          const isManaged = format === "ssh_config" && options?.managed === true;
          const fileBaseName = file.name.replace(/\.[^/.]+$/, "");
  
          // Generate unique managed group name (check for conflicts with existing sources,
          // custom groups, and host groups to avoid accidentally merging unrelated hosts)
          let managedGroupName = `${fileBaseName} - Managed`;
          if (isManaged) {
            const existingGroupNames = new Set([
              ...managedSources.map(s => s.groupName),
              ...customGroups,
              ...hosts.map(h => h.group).filter((g): g is string => !!g),
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
            toast.error(
              t("vault.import.sshConfig.noFilePathDesc"),
              t("vault.import.sshConfig.noFilePath"),
            );
            return;
          }
  
          if (isManaged) {
            const existingSource = managedSources.find(s => s.filePath === filePath);
            if (existingSource) {
              toast.error(
                t("vault.import.sshConfig.alreadyManagedDesc", { group: existingSource.groupName }),
                t("vault.import.sshConfig.alreadyManaged"),
              );
              return;
            }
          }
  
          const makeKey = (h: Host) =>
            `${(h.protocol ?? "ssh").toLowerCase()}|${h.hostname.toLowerCase()}|${h.port}|${(h.username ?? "").toLowerCase()}`;
  
          const existingKeys = new Set(hosts.map(makeKey));
          // Filter out duplicates for both managed and non-managed imports
          let newHosts = result.hosts.filter((h) => !existingKeys.has(makeKey(h)));
  
          // For managed imports, also update existing hosts to be managed
          let updatedExistingHosts: Host[] = [];
          if (isManaged) {
            const importedKeys = new Set(result.hosts.map(makeKey));
            updatedExistingHosts = hosts.filter((h) => importedKeys.has(makeKey(h)));
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
            const updatedHosts = hosts.map((h) => {
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
  
            onUpdateManagedSources([...managedSources, newSource]);
            onUpdateHosts([...updatedHosts, ...newHosts].map(sanitizeHost));
  
            const nextGroups = Array.from(
              new Set([
                ...customGroups,
                ...result.groups,
                managedGroupName,
                ...newHosts.map((h) => h.group).filter(Boolean),
              ]),
            ) as string[];
            onUpdateCustomGroups(nextGroups);
          } else if (newHosts.length > 0) {
            const merged = applyVaultHostImport(hosts, customGroups, result, { skipDuplicates: true });
            const addedHostIds = new Set(merged.addedHosts.map((host) => host.id));
            const addedHostKeyPaths = new Map(merged.addedHosts.flatMap((host) => {
              const keyPath = host.identityFilePaths?.find((path) => path.trim())?.trim();
              return keyPath ? [[host.id, keyPath] as const] : [];
            }));
            onUpdateHosts(merged.hosts);
            onUpdateCustomGroups(merged.customGroups);
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
          const duplicates = result.stats.duplicates;
          const hasWarnings = skipped > 0 || duplicates > 0 || result.issues.length > 0;
  
          if (result.stats.parsed === 0 && totalAffected === 0) {
            toast.error(
              t("vault.import.toast.noEntries", { format: formatLabel }),
              t("vault.import.toast.failedTitle"),
            );
            return;
          }
  
          if (totalAffected === 0) {
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
        } catch (err) {
          const message =
            err instanceof Error ? err.message : t("common.unknownError");
          toast.error(message, t("vault.import.toast.failedTitle"));
        }
      },
      [
        customGroups,
        hosts,
        managedSources,
        onUpdateCustomGroups,
        onUpdateHosts,
        onUpdateKeys,
        onUpdateManagedSources,
        setIsImportOpen,
        t,
      ],
    );

  return { handleImportFileSelected };
}
