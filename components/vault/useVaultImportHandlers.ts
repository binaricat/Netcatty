import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import {
  readRememberedKeyPassphrases,
  rememberImportedKeyPassphrase,
  resolveDefaultKeyPassphraseAliases,
} from "../../application/defaultKeyPassphrases";
import {
  countVaultImportDuplicates,
  ensureVaultImportPersisted,
  mergeVaultImportedGroups,
  rebaseVaultImportedHosts,
  resolveUniqueManagedImportGroupName,
  rollbackVaultImportedHosts,
  waitForVaultImportProgressPaint,
  type VaultHostPersistenceResult,
  type VaultImportProgress,
} from "../../application/state/vaultImportProgress";
import { importVaultHostsInWorker } from "../../application/state/vaultImportWorker";
import {
  type VaultLockHandle,
  withVaultImportLock,
} from "../../application/state/vaultManagedImportLock";

/** Exit the import lock so a concurrent host save can finish, then retry. */
const RETRY_VAULT_IMPORT_AFTER_CONCURRENT_EDIT = Symbol("retry-vault-import-after-concurrent-edit");
import { sanitizeHost } from "../../domain/host";
import {
  applyVaultImportDestination,
  applyVaultHostImport,
  filterVaultImportKeyPassphrasesAgainstExisting,
  mergeVaultImportIssues,
  resolveVaultImportKeyPassphraseConflicts,
  type VaultImportFormat,
} from "../../domain/vaultImport";
import type { GroupConfig, Host, ManagedSource, SSHKey } from "../../types";
import type { ImportOptions } from "./ImportVaultDialog";
import { toast } from "../ui/toast";

interface UseVaultImportHandlersOptions {
  customGroups: string[];
  hosts: Host[];
  keys: SSHKey[];
  managedSources: ManagedSource[];
  onReadPersistedHosts: () => Promise<Host[]>;
  onUpdateHosts: (hosts: Host[]) => VaultHostPersistenceResult | Promise<VaultHostPersistenceResult>;
  onUpdateKeys: (keys: SSHKey[]) => void;
  onReadPersistedManagedSources: () => ManagedSource[];
  onCommitVaultImportTransaction: (
    hosts: Host[],
    updateGroups: (current: string[]) => string[],
    updateSources: (current: ManagedSource[]) => ManagedSource[],
    updateGroupConfigs?: (current: GroupConfig[]) => GroupConfig[],
    expectedHosts?: Host[],
    lock?: VaultLockHandle | null,
  ) => Promise<
    | {
      status: "persisted";
      groups: string[];
      sources: ManagedSource[];
      groupConfigs: GroupConfig[];
    }
    | { status: "superseded" }
  >;
  setIsImportOpen: (open: boolean) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
}

export function useVaultImportHandlers({
  customGroups,
  hosts,
  keys,
  managedSources,
  onReadPersistedHosts,
  onUpdateHosts,
  onUpdateKeys,
  onReadPersistedManagedSources,
  onCommitVaultImportTransaction,
  setIsImportOpen,
  t,
}: UseVaultImportHandlersOptions) {
  const [importProgress, setImportProgress] = useState<VaultImportProgress | null>(null);
  const customGroupsRef = useRef(customGroups);
  const hostsRef = useRef(hosts);
  const keysRef = useRef(keys);
  const managedSourcesRef = useRef(managedSources);
  const activeImportAbortRef = useRef<AbortController | null>(null);
  const importCommitStartedRef = useRef(false);
  const importInFlightRef = useRef(false);
  customGroupsRef.current = customGroups;
  hostsRef.current = hosts;
  keysRef.current = keys;
  managedSourcesRef.current = managedSources;
  const resetImportProgress = useCallback(() => setImportProgress(null), []);

  useEffect(() => () => {
    if (!importCommitStartedRef.current) activeImportAbortRef.current?.abort();
    activeImportAbortRef.current = null;
  }, []);

  const cancelImport = useCallback(() => {
    if (importCommitStartedRef.current) return;
    activeImportAbortRef.current?.abort();
    activeImportAbortRef.current = null;
    setImportProgress(null);
    setIsImportOpen(false);
  }, [setIsImportOpen]);

  const handleImportFileSelected = useCallback(
      async (format: VaultImportFormat, files: File[], options?: ImportOptions) => {
        const file = files[0];
        if (!file) return;
        if (importInFlightRef.current) return;
        importInFlightRef.current = true;
        activeImportAbortRef.current?.abort();
        const abortController = new AbortController();
        activeImportAbortRef.current = abortController;
        importCommitStartedRef.current = false;
        const { signal } = abortController;
        const throwIfCancelled = () => {
          if (signal.aborted) {
            throw new DOMException("Vault import cancelled.", "AbortError");
          }
        };
        let rollbackSnapshot: {
          baselineHosts: Host[];
          appliedHosts: Host[];
        } | null = null;
        let rollbackPendingImport: () => Promise<void> = async () => undefined;
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

        setIsImportOpen(false);
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
            signal,
            onProgress: (progress) => {
              if (!signal.aborted) updateProgress(progress);
            },
          });
          throwIfCancelled();
          const isManaged = format === "ssh_config" && options?.managed === true;
          if (!isManaged) {
            result = applyVaultImportDestination(
              result,
              options?.destination ?? { mode: "preserve" },
            );
          }
          updateProgress({ stage: "preparing", percent: 70 });
          await waitForVaultImportProgressPaint();
          throwIfCancelled();
          updateProgress({ stage: "saving", percent: 85 });
          await waitForVaultImportProgressPaint();
          throwIfCancelled();

          const currentCustomGroups = customGroupsRef.current;
          const currentHosts = hostsRef.current;
          const currentManagedSources = managedSourcesRef.current;
          const persistHosts = async (
            nextHosts: Host[],
            options?: {
              baselineHosts?: Host[];
              persistAttempt?: (
                hosts: Host[],
                baselineHosts: Host[],
              ) => Promise<VaultHostPersistenceResult>;
              prepareAttempt?: (attempt: { baselineHosts: Host[]; appliedHosts: Host[] }) => Host[];
            },
          ) => {
            throwIfCancelled();
            importCommitStartedRef.current = true;
            let baselineHosts = options?.baselineHosts ?? currentHosts;
            let appliedHosts = nextHosts;
            while (true) {
              appliedHosts = options?.prepareAttempt?.({ baselineHosts, appliedHosts }) ?? appliedHosts;
              rollbackSnapshot = { baselineHosts, appliedHosts };
              let persisted: VaultHostPersistenceResult;
              if (options?.persistAttempt) {
                persisted = await options.persistAttempt(appliedHosts, baselineHosts);
              } else {
                let hostUpdate: VaultHostPersistenceResult | Promise<VaultHostPersistenceResult>;
                startTransition(() => {
                  hostUpdate = onUpdateHosts(appliedHosts);
                });
                persisted = await hostUpdate!;
              }
              if (persisted !== "superseded") {
                if (persisted !== false) rollbackSnapshot = null;
                return persisted;
              }

              // Locked import commits must release the shared lock before retrying
              // so a concurrent host save queued behind that lock can finish first.
              if (options?.persistAttempt) {
                throw RETRY_VAULT_IMPORT_AFTER_CONCURRENT_EDIT;
              }

              const latestHosts = hostsRef.current;
              hostsRef.current = latestHosts;
              appliedHosts = rebaseVaultImportedHosts({
                currentHosts: latestHosts,
                baselineHosts,
                appliedHosts,
              });
              baselineHosts = latestHosts;
            }
          };

          rollbackPendingImport = async () => {
            const snapshot = rollbackSnapshot;
            if (!snapshot) return;
            while (true) {
              const rollbackHosts = rollbackVaultImportedHosts({
                currentHosts: hostsRef.current,
                ...snapshot,
              });
              let rollbackUpdate: VaultHostPersistenceResult | Promise<VaultHostPersistenceResult>;
              startTransition(() => {
                rollbackUpdate = onUpdateHosts(rollbackHosts);
              });
              const persisted = await rollbackUpdate!;
              if (persisted === "superseded") continue;
              if (persisted === false) {
                throw new Error(t("vault.import.progress.persistFailed"));
              }
              rollbackSnapshot = null;
              return;
            }
          };

          const fileBaseName = file.name.replace(/\.[^/.]+$/, "");
          const requestedManagedGroup = options?.destination?.mode === "preserve"
            ? null
            : options?.destination?.group ?? null;
          let managedGroupName = requestedManagedGroup ?? `${fileBaseName} - Managed`;
  
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
          let newHosts = format === "securecrt"
            ? result.hosts
            : result.hosts.filter((h) => !existingKeys.has(makeKey(h)));
  
          // For managed imports, also update existing hosts to be managed
          let updatedExistingHosts: Host[] = [];
          if (isManaged) {
            const importedKeys = new Set(result.hosts.map(makeKey));
            updatedExistingHosts = currentHosts.filter((h) => importedKeys.has(makeKey(h)));
          }
  
          if (isManaged && (newHosts.length > 0 || updatedExistingHosts.length > 0)) {
            while (true) {
            try {
            await withVaultImportLock("vault", async (lock) => {
            const latestPersistedSources = onReadPersistedManagedSources();
            managedSourcesRef.current = latestPersistedSources;
            const sourceClaim = latestPersistedSources.find((source) => source.filePath === filePath);
            if (sourceClaim) {
              throw new Error(t("vault.import.sshConfig.alreadyManagedDesc", {
                group: sourceClaim.groupName,
              }));
            }
            const managedBaselineHosts = await onReadPersistedHosts();
            hostsRef.current = managedBaselineHosts;
            const managedExistingKeys = new Set(managedBaselineHosts.map(makeKey));
            newHosts = result.hosts.filter((host) => !managedExistingKeys.has(makeKey(host)));
            const managedImportedKeys = new Set(result.hosts.map(makeKey));
            updatedExistingHosts = managedBaselineHosts.filter((host) => (
              !host.managedSourceId && managedImportedKeys.has(makeKey(host))
            ));
            if (newHosts.length === 0 && updatedExistingHosts.length === 0) return;
            const sourceId = crypto.randomUUID();
            let newSource: ManagedSource = {
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
            const updatedHosts = managedBaselineHosts.map((h) => {
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
  
            let nextGroups: string[] = [];
            const ensureManagedSourceStillAvailable = () => {
              const conflictingSource = managedSourcesRef.current.find((source) => (
                source.id !== sourceId && source.filePath === filePath
              ));
              if (conflictingSource) {
                throw new Error(t("vault.import.sshConfig.alreadyManagedDesc", {
                  group: conflictingSource.groupName,
                }));
              }
            };
            const prepareManagedAttempt = ({
              baselineHosts,
              appliedHosts,
            }: {
              baselineHosts: Host[];
              appliedHosts: Host[];
            }) => {
              ensureManagedSourceStillAvailable();
              managedGroupName = requestedManagedGroup ?? resolveUniqueManagedImportGroupName({
                  baseName: fileBaseName,
                  customGroups: customGroupsRef.current,
                  hosts: baselineHosts,
                  managedSources: managedSourcesRef.current,
                  ownerSourceId: sourceId,
                });
              newSource = { ...newSource, groupName: managedGroupName };
              nextGroups = Array.from(new Set([
                ...currentCustomGroups,
                ...(requestedManagedGroup ? [] : result.groups),
                managedGroupName,
              ]));
              return appliedHosts.map((host) => (
                host.managedSourceId === sourceId
                  ? { ...host, group: managedGroupName }
                  : host
              ));
            };
            const hostPersisted = await persistHosts(
              [...updatedHosts, ...newHosts].map((host: Host) => sanitizeHost(host)),
              {
                baselineHosts: managedBaselineHosts,
                prepareAttempt: prepareManagedAttempt,
                persistAttempt: async (hostsToCommit, baselineHosts) => {
                  const transaction = await onCommitVaultImportTransaction(
                    hostsToCommit,
                    (latestPersistedGroups) => mergeVaultImportedGroups({
                      currentGroups: latestPersistedGroups,
                      baselineGroups: currentCustomGroups,
                      appliedGroups: nextGroups,
                    }),
                    (latestPersistedSources) => {
                      const conflictingSource = latestPersistedSources.find((source) => (
                        source.id !== sourceId && source.filePath === filePath
                      ));
                      if (conflictingSource) {
                        throw new Error(t("vault.import.sshConfig.alreadyManagedDesc", {
                          group: conflictingSource.groupName,
                        }));
                      }
                      return [
                        ...latestPersistedSources.filter((source) => source.id !== newSource.id),
                        newSource,
                      ];
                    },
                    undefined,
                    baselineHosts,
                    lock,
                  );
                  if (transaction.status === "superseded") return "superseded";
                  customGroupsRef.current = transaction.groups;
                  managedSourcesRef.current = transaction.sources;
                  return true;
                },
              },
            );
            await ensureVaultImportPersisted(
              hostPersisted,
              t("vault.import.progress.persistFailed"),
              undefined,
              rollbackPendingImport,
            );
            });
            break;
            } catch (error) {
              if (error !== RETRY_VAULT_IMPORT_AFTER_CONCURRENT_EDIT) throw error;
              // Drain concurrent locked writes outside the critical section.
              hostsRef.current = await onReadPersistedHosts();
            }
            }
          } else if (newHosts.length > 0) {
            let addedHostIds = new Set<string>();
            let addedHostKeyPaths = new Map<string, string>();
            while (true) {
            try {
            await withVaultImportLock("vault", async (lock) => {
            const importBaselineHosts = await onReadPersistedHosts();
            hostsRef.current = importBaselineHosts;
            const importBaselineGroups = customGroupsRef.current;
            const merged = applyVaultHostImport(
              importBaselineHosts,
              importBaselineGroups,
              result,
              { skipDuplicates: format !== "securecrt" },
            );
            newHosts = merged.addedHosts;
            addedHostIds = new Set(merged.addedHosts.map((host) => host.id));
            addedHostKeyPaths = new Map(merged.addedHosts.flatMap((host) => {
              const keyPath = host.identityFilePaths?.find((path) => path.trim())?.trim();
              return keyPath ? [[host.id, keyPath] as const] : [];
            }));
            if (newHosts.length === 0) return;
            const hostPersisted = await persistHosts(merged.hosts, {
              baselineHosts: importBaselineHosts,
              persistAttempt: async (hostsToCommit, baselineHosts) => {
                const transaction = await onCommitVaultImportTransaction(
                  hostsToCommit,
                  (latestPersistedGroups) => mergeVaultImportedGroups({
                    currentGroups: latestPersistedGroups,
                    baselineGroups: importBaselineGroups,
                    appliedGroups: merged.customGroups,
                  }),
                  (latestPersistedSources) => latestPersistedSources,
                  undefined,
                  baselineHosts,
                  lock,
                );
                if (transaction.status === "superseded") return "superseded";
                customGroupsRef.current = transaction.groups;
                managedSourcesRef.current = transaction.sources;
                return true;
              },
            });
            await ensureVaultImportPersisted(
              hostPersisted,
              t("vault.import.progress.persistFailed"),
              undefined,
              rollbackPendingImport,
            );
            });
            break;
            } catch (error) {
              if (error !== RETRY_VAULT_IMPORT_AFTER_CONCURRENT_EDIT) throw error;
              hostsRef.current = await onReadPersistedHosts();
            }
            }
            throwIfCancelled();
            const resolved = await resolveVaultImportKeyPassphraseConflicts(
              result.keyPassphraseCandidates ?? result.keyPassphrases ?? [],
              resolveDefaultKeyPassphraseAliases,
              addedHostIds,
              addedHostKeyPaths,
            );
            throwIfCancelled();
            const checked = await filterVaultImportKeyPassphrasesAgainstExisting(
              resolved.keyPassphrases,
              (keyPath) => readRememberedKeyPassphrases(keyPath, keysRef.current),
            );
            throwIfCancelled();
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
                throwIfCancelled();
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
              } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") {
                  throw error;
                }
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

          throwIfCancelled();
          rollbackSnapshot = null;
  
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
          let rollbackFailure: unknown;
          if (rollbackSnapshot) {
            try {
              await rollbackPendingImport();
            } catch (rollbackError) {
              rollbackFailure = rollbackError;
              console.error("[vault import] Failed to rollback imported hosts.", rollbackError);
            }
          }
          if (
            !rollbackFailure
            && (
              signal.aborted
              || (err instanceof DOMException && err.name === "AbortError")
            )
          ) return;
          const originalMessage =
            err instanceof Error ? err.message : t("common.unknownError");
          const message = rollbackFailure
            ? `${originalMessage} ${t("vault.import.progress.rollbackFailed")}`
            : originalMessage;
          updateProgress({
            status: "error",
            stage: "failed",
            error: message,
          });
          toast.error(message, t("vault.import.toast.failedTitle"));
        } finally {
          if (activeImportAbortRef.current === abortController) {
            activeImportAbortRef.current = null;
          }
          importCommitStartedRef.current = false;
          importInFlightRef.current = false;
        }
      },
      [
        onReadPersistedHosts,
        onCommitVaultImportTransaction,
        onReadPersistedManagedSources,
        onUpdateHosts,
        onUpdateKeys,
        setIsImportOpen,
        t,
      ],
    );

  return {
    cancelImport,
    handleImportFileSelected,
    importProgress,
    resetImportProgress,
  };
}
