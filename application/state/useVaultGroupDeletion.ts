import { useCallback, useRef } from "react";

import type { GroupConfig, Host, ManagedSource } from "../../domain/models";
import { buildVaultGroupDeletion } from "../../domain/vaultGroupDeletion";
import { withVaultImportLock } from "./vaultManagedImportLock";

export function useVaultGroupDeletion({
  customGroups,
  hosts,
  groupConfigs,
  managedSources,
  onUpdateCustomGroups,
  onUpdateHosts,
  onUpdateGroupConfigs,
  onUpdateManagedSources,
  onClearAndRemoveManagedSource,
  onClearAndRemoveManagedSources,
  onDeletedPaths,
}: {
  customGroups: string[];
  hosts: Host[];
  groupConfigs: GroupConfig[];
  managedSources: ManagedSource[];
  onUpdateCustomGroups: (groups: string[]) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateGroupConfigs: (configs: GroupConfig[]) => void;
  onUpdateManagedSources: (sources: ManagedSource[]) => void;
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
      deletion = buildVaultGroupDeletion({
        selectedPaths,
        deleteHosts,
        ...latestRef.current,
      });
      const removedSourceIds = new Set(deletion.sourcesToRemove.map((source) => source.id));
      const nextManagedSources = latestRef.current.managedSources.filter(
        (source) => !removedSourceIds.has(source.id),
      );
      const nextHosts = deletion.hosts.filter(
        (host) => !additionallyDeletedHostIds.has(host.id),
      );
      latestRef.current = {
        customGroups: deletion.customGroups,
        hosts: nextHosts,
        groupConfigs: deletion.groupConfigs,
        managedSources: nextManagedSources,
      };

      onUpdateManagedSources(nextManagedSources);
      onUpdateCustomGroups(deletion.customGroups);
      onUpdateHosts(nextHosts);
      onUpdateGroupConfigs(deletion.groupConfigs);
      onDeletedPaths?.(deletion.selectedRoots);
    });
  }, [
    onClearAndRemoveManagedSource,
    onClearAndRemoveManagedSources,
    onDeletedPaths,
    onUpdateCustomGroups,
    onUpdateGroupConfigs,
    onUpdateHosts,
    onUpdateManagedSources,
  ]);
}
