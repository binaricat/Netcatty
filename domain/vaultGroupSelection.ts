interface VaultGroupTreeNodeLike {
  path: string;
  children?: Record<string, VaultGroupTreeNodeLike>;
}

export function collectVisibleVaultGroupPaths(
  nodes: VaultGroupTreeNodeLike[],
): string[] {
  const paths: string[] = [];
  const visit = (items: VaultGroupTreeNodeLike[]) => {
    for (const node of items) {
      paths.push(node.path);
      visit(Object.values(node.children ?? {}));
    }
  };
  visit(nodes);
  return paths;
}

export function collectVaultGroupPathsForSelectAll({
  hasActiveFilters,
  viewMode,
  displayedGroupPaths,
  visibleTreeGroupPaths,
}: {
  hasActiveFilters: boolean;
  viewMode: "grid" | "list" | "tree";
  displayedGroupPaths: readonly string[];
  visibleTreeGroupPaths: readonly string[];
}): string[] {
  if (hasActiveFilters) return [];
  return viewMode === "tree"
    ? [...visibleTreeGroupPaths]
    : [...displayedGroupPaths];
}

export function retainVisibleVaultGroupSelection(
  selectedGroupPaths: ReadonlySet<string>,
  visibleGroupPaths: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...selectedGroupPaths].filter((path) => visibleGroupPaths.has(path)),
  );
}

export function collectVisibleVaultHostIds<T extends { id: string }>({
  viewMode,
  displayedHosts,
  treeHosts,
}: {
  viewMode: "grid" | "list" | "tree";
  displayedHosts: T[];
  treeHosts: T[];
}): string[] {
  const visibleHosts = viewMode === "tree" ? treeHosts : displayedHosts;
  return visibleHosts.map((host) => host.id);
}
