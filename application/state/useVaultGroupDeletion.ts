import { useCallback, useRef } from "react";

import type { GroupConfig, Host, ManagedSource } from "../../domain/models";
import { buildVaultGroupDeletion } from "../../domain/vaultGroupDeletion";
import { withVaultImportLock } from "./vaultManagedImportLock";

export function useVaultGroupDeletion({
  customGroups,
  hosts,
  groupConfigs,
  managedSources,
  onReadPersistedHosts,
  onCommitVaultImportTransaction,
  onClearAndRemoveManagedSource,
  onClearAndRemoveManagedSources,
  onDeletedPaths,
}: {
  customGroups: string[];
  hosts: Host[];
  groupConfigs: GroupConfig[];
  managedSources: ManagedSource[];
  onReadPersistedHosts: () => Promise<Host[]>;
  onCommitVaultImportTransaction: (
    hosts: Host[],
    updateGroups: (current: string[]) => string[],
    updateSources: (current: ManagedSource[]) => ManagedSource[],
  ) => Promise<
    | { status: "persisted"; groups: string[]; sources: ManagedSource[] }
    | { status: "superseded" }
  >;
  onClearAndRemoveManagedSource?: (source: ManagedSource) => Promise<boolean>;
  onClearAndRemoveManagedSources?: (sources: ManagedSource[]) => Promise<void>;
  onDeletedPaths?: (selectedRoots: string[]) => void;
}) {
  const latestRef = useRef({ customGroups, hosts, groupConfigs, managedSources });
  latestRef.current = { customGroups, hosts, groupConfigs, managedSources };

  return useCallback(async (
    paths: Iterable<string>,
    deleteHosts: boolean = false,
    additionallyDeletedHostIds: ReadonlySet<string> = new Set(),
  ) => {
    const selectedPaths = [...paths];
    await withVaultImportLock("vault", async () => {
      let deletion = buildVaultGroupDeletion({
        selectedPaths,
        deleteHosts,
        ...latestRef.current,
      });
      if (deletion.selectedRoots.length === 0) return;

      if (deletion.sourcesToRemove.length > 0 && onClearAndRemoveManagedSources) {
        await onClearAndRemoveManagedSources(deletion.sourcesToRemove);
      } else if (deletion.sourcesToRemove.length > 0 && onClearAndRemoveManagedSource) {
        await Promise.all(
          deletion.sourcesToRemove.map((source) => onClearAndRemoveManagedSource(source)),
        );
      }

      // Rebuild after the file operations so edits made while they were running
      // are preserved, then publish one coherent in-memory baseline for any
      // deletion already queued behind this one.
      while (true) {
        deletion = buildVaultGroupDeletion({
          selectedPaths,
          deleteHosts,
          ...latestRef.current,
        });
        const nextHosts = deletion.hosts.filter(
          (host) => !additionallyDeletedHostIds.has(host.id),
        );
        const transaction = await onCommitVaultImportTransaction(
          nextHosts,
          (currentGroups) => buildVaultGroupDeletion({
            selectedPaths,
            deleteHosts,
            customGroups: currentGroups,
            hosts: [],
            groupConfigs: [],
            managedSources: [],
          }).customGroups,
          (currentSources) => buildVaultGroupDeletion({
            selectedPaths,
            deleteHosts,
            customGroups: [],
            hosts: [],
            groupConfigs: [],
            managedSources: currentSources,
          }).sourcesToRemove.reduce(
            (remaining, sourceToRemove) => remaining.filter((source) => source.id !== sourceToRemove.id),
            currentSources,
          ),
        );
        if (transaction.status === "superseded") {
          latestRef.current.hosts = await onReadPersistedHosts();
          continue;
        }
        latestRef.current = {
          customGroups: transaction.groups,
          hosts: nextHosts,
          groupConfigs: deletion.groupConfigs,
          managedSources: transaction.sources,
        };
        break;
      }
      onDeletedPaths?.(deletion.selectedRoots);
    });
  }, [
    onClearAndRemoveManagedSource,
    onClearAndRemoveManagedSources,
    onCommitVaultImportTransaction,
    onDeletedPaths,
    onReadPersistedHosts,
  ]);
}
