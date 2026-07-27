import { useCallback } from "react";

import type { GroupConfig, Host, ManagedSource } from "../../domain/models";
import { buildVaultGroupDeletion } from "../../domain/vaultGroupDeletion";

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
  return useCallback(async (
    paths: Iterable<string>,
    deleteHosts: boolean = false,
    additionallyDeletedHostIds: ReadonlySet<string> = new Set(),
  ) => {
    const deletion = buildVaultGroupDeletion({
      selectedPaths: paths,
      deleteHosts,
      customGroups,
      hosts,
      groupConfigs,
      managedSources,
    });
    if (deletion.selectedRoots.length === 0) return;

    if (deletion.sourcesToRemove.length > 0 && onClearAndRemoveManagedSources) {
      await onClearAndRemoveManagedSources(deletion.sourcesToRemove);
    } else if (deletion.sourcesToRemove.length > 0 && onClearAndRemoveManagedSource) {
      await Promise.all(
        deletion.sourcesToRemove.map((source) => onClearAndRemoveManagedSource(source)),
      );
    } else if (deletion.sourcesToRemove.length > 0) {
      const removedSourceIds = new Set(deletion.sourcesToRemove.map((source) => source.id));
      onUpdateManagedSources(
        managedSources.filter((source) => !removedSourceIds.has(source.id)),
      );
    }

    onUpdateCustomGroups(deletion.customGroups);
    onUpdateHosts(
      deletion.hosts.filter((host) => !additionallyDeletedHostIds.has(host.id)),
    );
    if (deletion.groupConfigs.length !== groupConfigs.length) {
      onUpdateGroupConfigs(deletion.groupConfigs);
    }
    onDeletedPaths?.(deletion.selectedRoots);
  }, [
    customGroups,
    groupConfigs,
    hosts,
    managedSources,
    onClearAndRemoveManagedSource,
    onClearAndRemoveManagedSources,
    onDeletedPaths,
    onUpdateCustomGroups,
    onUpdateGroupConfigs,
    onUpdateHosts,
    onUpdateManagedSources,
  ]);
}
