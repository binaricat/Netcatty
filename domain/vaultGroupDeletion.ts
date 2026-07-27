import type { GroupConfig, Host, ManagedSource } from "./models";

const isPathAtOrBelow = (path: string, root: string): boolean => (
  path === root || path.startsWith(`${root}/`)
);

export function minimizeVaultGroupPaths(paths: Iterable<string>): string[] {
  const sorted = Array.from(new Set(
    Array.from(paths, (path) => path.trim()).filter(Boolean),
  )).sort((left, right) => left.length - right.length || left.localeCompare(right));

  return sorted.filter((path, index) => (
    !sorted.slice(0, index).some((root) => isPathAtOrBelow(path, root))
  ));
}

export function buildVaultGroupDeletion({
  selectedPaths,
  deleteHosts,
  customGroups,
  hosts,
  groupConfigs,
  managedSources,
}: {
  selectedPaths: Iterable<string>;
  deleteHosts: boolean;
  customGroups: string[];
  hosts: Host[];
  groupConfigs: GroupConfig[];
  managedSources: ManagedSource[];
}): {
  selectedRoots: string[];
  customGroups: string[];
  hosts: Host[];
  groupConfigs: GroupConfig[];
  sourcesToRemove: ManagedSource[];
} {
  const selectedRoots = minimizeVaultGroupPaths(selectedPaths);
  const matchesSelection = (path: string) => (
    selectedRoots.some((root) => isPathAtOrBelow(path, root))
  );
  const sourcesToRemove = managedSources.filter((source) => (
    matchesSelection(source.groupName)
  ));
  const removedSourceIds = new Set(sourcesToRemove.map((source) => source.id));

  const nextHosts = hosts.flatMap((host) => {
    const group = host.group || "";
    const selectedRoot = selectedRoots.find((root) => isPathAtOrBelow(group, root));
    if (!selectedRoot) return [host];

    const belongsToRemovedSource = sourcesToRemove.some((source) => (
      isPathAtOrBelow(group, source.groupName)
    ));
    if (deleteHosts || belongsToRemovedSource) return [];

    const retainedManagedSource = managedSources.find((source) => (
      !removedSourceIds.has(source.id)
      && selectedRoot.startsWith(`${source.groupName}/`)
      && source.id === host.managedSourceId
    ));
    return [{
      ...host,
      group: "",
      managedSourceId: retainedManagedSource ? host.managedSourceId : undefined,
    }];
  });

  return {
    selectedRoots,
    customGroups: customGroups.filter((group) => !matchesSelection(group)),
    hosts: nextHosts,
    groupConfigs: groupConfigs.filter((config) => !matchesSelection(config.path)),
    sourcesToRemove,
  };
}
