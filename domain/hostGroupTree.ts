import type { GroupConfig, GroupNode, Host } from '../types';
import { sortByVaultOrder, sortVaultStringsByOrder } from './vaultOrder';

function countAllHostsInNode(node: GroupNode): number {
  let count = node.hosts.length;
  for (const child of Object.values(node.children)) {
    count += countAllHostsInNode(child);
  }
  node.totalHostCount = count;
  return count;
}

export function buildHostGroupTree(
  hosts: Host[],
  customGroups: string[],
  groupConfigs: GroupConfig[] = [],
): { groupTree: GroupNode[]; ungroupedHosts: Host[] } {
  const groupOrderByPath = new Map(
    groupConfigs
      .filter((config) => typeof config.order === 'number' && Number.isFinite(config.order))
      .map((config) => [config.path, config.order as number]),
  );
  const orderedCustomGroups = sortVaultStringsByOrder(customGroups, groupOrderByPath);
  const sortGroupNodesBySavedOrder = (nodes: GroupNode[]) => {
    const originalIndex = new Map(nodes.map((node, index) => [node.path, index]));
    return [...nodes].sort((a, b) => {
      const orderA = groupOrderByPath.get(a.path);
      const orderB = groupOrderByPath.get(b.path);
      const hasOrderA = typeof orderA === 'number' && Number.isFinite(orderA);
      const hasOrderB = typeof orderB === 'number' && Number.isFinite(orderB);
      if (hasOrderA && hasOrderB && orderA !== orderB) return orderA - orderB;
      if (hasOrderA) return -1;
      if (hasOrderB) return 1;
      return (originalIndex.get(a.path) ?? 0) - (originalIndex.get(b.path) ?? 0);
    });
  };
  const sortChildrenBySavedOrder = (node: GroupNode) => {
    const sortedChildren = sortGroupNodesBySavedOrder(Object.values(node.children));
    node.children = Object.fromEntries(sortedChildren.map((child) => [child.name, child]));
    sortedChildren.forEach(sortChildrenBySavedOrder);
  };
  const root: Record<string, GroupNode> = {};
  const insertPath = (path: string, host?: Host) => {
    const parts = path.split('/').filter(Boolean);
    let currentLevel = root;
    let currentPath = '';
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!currentLevel[part]) {
        currentLevel[part] = {
          name: part,
          path: currentPath,
          children: {},
          hosts: [],
        };
      }
      if (host && index === parts.length - 1) {
        currentLevel[part].hosts.push(host);
      }
      currentLevel = currentLevel[part].children;
    });
  };

  orderedCustomGroups.forEach((path) => insertPath(path));
  const ungroupedHosts: Host[] = [];
  for (const host of hosts) {
    const group = host.group?.trim();
    if (group) {
      insertPath(group, host);
    } else {
      ungroupedHosts.push(host);
    }
  }

  Object.values(root).forEach(countAllHostsInNode);
  const groupTree = sortGroupNodesBySavedOrder(Object.values(root));
  groupTree.forEach(sortChildrenBySavedOrder);
  const orderedUngroupedHosts = sortByVaultOrder(ungroupedHosts);
  return { groupTree, ungroupedHosts: orderedUngroupedHosts };
}

export function groupNodeContainsHost(node: GroupNode, hostId: string | null | undefined): boolean {
  if (!hostId) return false;
  if (node.hosts.some((host) => host.id === hostId)) return true;
  return Object.values(node.children).some((child) => groupNodeContainsHost(child, hostId));
}

export function collectGroupTreePaths(nodes: GroupNode[]): string[] {
  const paths: string[] = [];
  const walk = (node: GroupNode) => {
    if (node.path) paths.push(node.path);
    for (const child of Object.values(node.children)) {
      walk(child);
    }
  };
  for (const node of nodes) walk(node);
  return paths;
}
