import { useCallback } from "react";

import { sanitizeHost } from "../../domain/host";
import { importVaultHostsFromText, type VaultImportFormat } from "../../domain/vaultImport";
import type { Host, ManagedSource } from "../../types";
import type { ImportOptions } from "./ImportVaultDialog";
import { toast } from "../ui/toast";

interface UseVaultImportHandlersOptions {
  customGroups: string[];
  hosts: Host[];
  managedSources: ManagedSource[];
  onUpdateCustomGroups: (groups: string[]) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateManagedSources: (sources: ManagedSource[]) => void;
  setIsImportOpen: (open: boolean) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
}

export function useVaultImportHandlers({
  customGroups,
  hosts,
  managedSources,
  onUpdateCustomGroups,
  onUpdateHosts,
  onUpdateManagedSources,
  setIsImportOpen,
  t,
}: UseVaultImportHandlersOptions) {
  const readTextFile = useCallback(async (file: File): Promise<string> => {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
  
      let encoding: string = "utf-8";
      let offset = 0;
  
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = "utf-16le";
        offset = 2;
      } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = "utf-16be";
        offset = 2;
      } else if (
        bytes.length >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf
      ) {
        encoding = "utf-8";
        offset = 3;
      }
  
      const decoder = new TextDecoder(encoding);
      return decoder.decode(bytes.slice(offset));
    }, []);
  
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
  
          const text = await readTextFile(file);
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
            toast({
              title: t("vault.import.sshConfig.noFilePath"),
              description: t("vault.import.sshConfig.noFilePathDesc"),
              variant: "destructive",
            });
            return;
          }
  
          if (isManaged) {
            const existingSource = managedSources.find(s => s.filePath === filePath);
            if (existingSource) {
              toast({
                title: t("vault.import.sshConfig.alreadyManaged"),
                description: t("vault.import.sshConfig.alreadyManagedDesc", { group: existingSource.groupName }),
                variant: "destructive",
              });
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
            onUpdateHosts([...hosts, ...newHosts].map(sanitizeHost));
  
            const nextGroups = Array.from(
              new Set([
                ...customGroups,
                ...result.groups,
                ...newHosts.map((h) => h.group).filter(Boolean),
              ]),
            ) as string[];
            onUpdateCustomGroups(nextGroups);
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
        onUpdateManagedSources,
        readTextFile,
        setIsImportOpen,
        t,
      ],
    );

  return { handleImportFileSelected };
}
