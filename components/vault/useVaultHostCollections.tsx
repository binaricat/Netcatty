import React, { useCallback, useMemo } from "react";

import { upsertKnownHost } from "../../domain/knownHosts";
import type { GroupNode, Host, KnownHost } from "../../types";
import KnownHostsManager from "../KnownHostsManager";
import type { SortMode } from "../ui/sort-dropdown";

interface UseVaultHostCollectionsOptions {
  customGroups: string[];
  hosts: Host[];
  knownHosts: KnownHost[];
  onConvertKnownHost: (knownHost: KnownHost) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateKnownHosts: (knownHosts: KnownHost[]) => void;
  search: string;
  selectedGroupPath: string | null;
  selectedTags: string[];
  showOnlyUngroupedHostsInRoot: boolean;
  showRecentHosts: boolean;
  sortMode: SortMode;
  viewMode: "grid" | "list" | "tree";
}

export function useVaultHostCollections({
  customGroups,
  hosts,
  knownHosts,
  onConvertKnownHost,
  onUpdateHosts,
  onUpdateKnownHosts,
  search,
  selectedGroupPath,
  selectedTags,
  showOnlyUngroupedHostsInRoot,
  showRecentHosts,
  sortMode,
  viewMode,
}: UseVaultHostCollectionsOptions) {
  const countAllHostsInNode = useCallback((node: GroupNode): number => {
      let count = node.hosts.length;
      Object.values(node.children).forEach((child) => {
        count += countAllHostsInNode(child);
      });
      node.totalHostCount = count;
      return count;
    }, []);
  
  const buildGroupTree = useMemo<Record<string, GroupNode>>(() => {
      const root: Record<string, GroupNode> = {};
      const insertPath = (path: string, host?: Host) => {
        const parts = path.split("/").filter(Boolean);
        let currentLevel = root;
        let currentPath = "";
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
          if (host && index === parts.length - 1)
            currentLevel[part].hosts.push(host);
          currentLevel = currentLevel[part].children;
        });
      };
      customGroups.forEach((path) => insertPath(path));
      hosts.forEach((host) => insertPath(host.group || "General", host));
  
      Object.values(root).forEach(countAllHostsInNode);
  
      return root;
    }, [hosts, customGroups, countAllHostsInNode]);
  
  // Generate all possible group paths from the tree (including all intermediate nodes)
    const allGroupPaths = useMemo(() => {
      const paths = new Set<string>();
  
      const traverse = (nodes: Record<string, GroupNode>) => {
        Object.values(nodes).forEach((node) => {
          if (node.path) {
            paths.add(node.path);
          }
          if (node.children) {
            traverse(node.children);
          }
        });
      };
  
      // Traverse the tree
      traverse(buildGroupTree);
  
      return Array.from(paths).sort();
    }, [buildGroupTree]);
  
  const findGroupNode = (path: string | null): GroupNode | null => {
      if (!path)
        return {
          name: "root",
          path: "",
          children: buildGroupTree,
          hosts: [],
        } as GroupNode;
      const parts = path.split("/").filter(Boolean);
      let current: { children?: Record<string, GroupNode>; hosts?: Host[] } = {
        children: buildGroupTree,
      };
      for (const p of parts) {
        const next = current.children?.[p];
        if (!next) return null;
        current = next;
      }
      return current as GroupNode;
    };
  
  const displayedHosts = useMemo(() => {
      let filtered = hosts;
      // Search spans all groups (#777): when the user types in the search box
      // we skip group/ungrouped-root scoping, so a matching host in another
      // group is still reachable without having to navigate into it first.
      // The tree view already uses this shape — see `treeViewHosts` below.
      const hasSearch = search.trim().length > 0;
      if (!hasSearch) {
        if (selectedGroupPath) {
          // Match hosts whose group equals the selected path
          // For "General" group, also match hosts with empty/undefined group
          filtered = filtered.filter((h) => {
            const hostGroup = h.group || "";
            if (selectedGroupPath === "General") {
              return hostGroup === "" || hostGroup === "General";
            }
            return hostGroup === selectedGroupPath;
          });
        } else if (showOnlyUngroupedHostsInRoot) {
          filtered = filtered.filter((h) => {
            const hostGroup = (h.group || "").trim();
            return hostGroup === "";
          });
        }
      }
      if (hasSearch) {
        const s = search.toLowerCase();
        filtered = filtered.filter(
          (h) =>
            h.label.toLowerCase().includes(s) ||
            h.hostname.toLowerCase().includes(s) ||
            h.tags.some((t) => t.toLowerCase().includes(s)) ||
            (h.notes?.toLowerCase().includes(s) ?? false),
        );
      }
      // Apply tag filter
      if (selectedTags.length > 0) {
        filtered = filtered.filter((h) =>
          selectedTags.some((t) => h.tags?.includes(t)),
        );
      }
      filtered = [...filtered].sort((a, b) => {
        switch (sortMode) {
          case "az":
            return a.label.localeCompare(b.label);
          case "za":
            return b.label.localeCompare(a.label);
          case "newest":
            return (b.createdAt || 0) - (a.createdAt || 0);
          case "oldest":
            return (a.createdAt || 0) - (b.createdAt || 0);
          case "group": {
            const groupA = a.group || "";
            const groupB = b.group || "";
            const groupCmp = groupA.localeCompare(groupB);
            return groupCmp !== 0 ? groupCmp : a.label.localeCompare(b.label);
          }
          default:
            return 0;
        }
      });
      return filtered;
    }, [hosts, selectedGroupPath, showOnlyUngroupedHostsInRoot, search, selectedTags, sortMode]);
  
  // Pinned hosts for root-level display (not inside a subgroup)
    // Respects active search and tag filters
    const pinnedHosts = useMemo(() => {
      if (selectedGroupPath) return [];
      let filtered = hosts.filter((h) => h.pinned);
      if (search.trim()) {
        const s = search.toLowerCase();
        filtered = filtered.filter(
          (h) =>
            h.label.toLowerCase().includes(s) ||
            h.hostname.toLowerCase().includes(s) ||
            h.tags.some((t) => t.toLowerCase().includes(s)) ||
            (h.notes?.toLowerCase().includes(s) ?? false),
        );
      }
      if (selectedTags.length > 0) {
        filtered = filtered.filter((h) =>
          selectedTags.some((t) => h.tags?.includes(t)),
        );
      }
      return filtered.sort((a, b) => a.label.localeCompare(b.label));
    }, [hosts, selectedGroupPath, search, selectedTags]);
  
  // Recently connected hosts for root-level display
    // Respects active search and tag filters
    const recentHosts = useMemo(() => {
      if (selectedGroupPath) return [];
      let filtered = hosts.filter((h) => h.lastConnectedAt);
      if (search.trim()) {
        const s = search.toLowerCase();
        filtered = filtered.filter(
          (h) =>
            h.label.toLowerCase().includes(s) ||
            h.hostname.toLowerCase().includes(s) ||
            h.tags.some((t) => t.toLowerCase().includes(s)) ||
            (h.notes?.toLowerCase().includes(s) ?? false),
        );
      }
      if (selectedTags.length > 0) {
        filtered = filtered.filter((h) =>
          selectedTags.some((t) => h.tags?.includes(t)),
        );
      }
      return filtered
        .sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0))
        .slice(0, 6);
    }, [hosts, selectedGroupPath, search, selectedTags]);
  
  // No longer deduplicate pinned/recent hosts from the main list,
    // so hosts always appear in their groups regardless of pinned/recent status.
    const pinnedRecentIds = useMemo(() => new Set<string>(), []);
  
  const visibleDisplayedHosts = useMemo(
      () => displayedHosts.filter((h) => selectedGroupPath || !pinnedRecentIds.has(h.id)),
      [displayedHosts, selectedGroupPath, pinnedRecentIds],
    );
  
  // For tree view: apply search, tag filter, and sorting, but not group filtering
    const treeViewHosts = useMemo(() => {
      let filtered = hosts;
      if (search.trim()) {
        const s = search.toLowerCase();
        filtered = filtered.filter(
          (h) =>
            h.label.toLowerCase().includes(s) ||
            h.hostname.toLowerCase().includes(s) ||
            h.tags.some((t) => t.toLowerCase().includes(s)) ||
            (h.notes?.toLowerCase().includes(s) ?? false),
        );
      }
      // Apply tag filter
      if (selectedTags.length > 0) {
        filtered = filtered.filter((h) =>
          selectedTags.some((t) => h.tags?.includes(t)),
        );
      }
      filtered = [...filtered].sort((a, b) => {
        switch (sortMode) {
          case "az":
            return a.label.localeCompare(b.label);
          case "za":
            return b.label.localeCompare(a.label);
          case "newest":
            return (b.createdAt || 0) - (a.createdAt || 0);
          case "oldest":
            return (a.createdAt || 0) - (b.createdAt || 0);
          case "group": {
            const groupA = a.group || "";
            const groupB = b.group || "";
            const groupCmp = groupA.localeCompare(groupB);
            return groupCmp !== 0 ? groupCmp : a.label.localeCompare(b.label);
          }
          default:
            return 0;
        }
      });
      return filtered;
    }, [hosts, search, selectedTags, sortMode]);
  
  const groupedDisplayHosts = useMemo(() => {
      if (sortMode !== "group") return null;
      const groups: { name: string; hosts: Host[] }[] = [];
      const groupMap = new Map<string, Host[]>();
  
      for (const host of displayedHosts) {
        const groupName = host.group || "";
        if (!groupMap.has(groupName)) {
          groupMap.set(groupName, []);
        }
        groupMap.get(groupName)!.push(host);
      }
  
      const sortedKeys = [...groupMap.keys()].sort((a, b) => a.localeCompare(b));
      for (const key of sortedKeys) {
        groups.push({ name: key, hosts: groupMap.get(key)! });
      }
      return groups;
    }, [displayedHosts, sortMode]);
  
  const buildTreeViewGroupTree = useMemo<Record<string, GroupNode>>(() => {
      const root: Record<string, GroupNode> = {};
      const insertPath = (path: string, host?: Host) => {
        const parts = path.split("/").filter(Boolean);
        let currentLevel = root;
        let currentPath = "";
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
          if (host && index === parts.length - 1)
            currentLevel[part].hosts.push(host);
          currentLevel = currentLevel[part].children;
        });
      };
      customGroups.forEach((path) => insertPath(path));
      // Use filtered hosts (treeViewHosts) instead of all hosts to respect search/tag filters
      treeViewHosts.forEach((host) => {
        if (host.group && host.group.trim() !== "") {
          insertPath(host.group, host);
        }
      });
  
      Object.values(root).forEach(countAllHostsInNode);
      
      return root;
    }, [treeViewHosts, customGroups, countAllHostsInNode]);
  
  // Create tree view specific group tree that excludes ungrouped hosts
    const treeViewGroupTree = useMemo<GroupNode[]>(() => {
      return (Object.values(buildTreeViewGroupTree) as GroupNode[]).sort((a, b) => a.name.localeCompare(b.name));
    }, [buildTreeViewGroupTree]);
  
  // Compute all unique tags across all hosts
    const allTags = useMemo(() => {
      const tagSet = new Set<string>();
      hosts.forEach((h) => h.tags?.forEach((t) => tagSet.add(t)));
      return Array.from(tagSet).sort();
    }, [hosts]);
  
  // Handle tag edit - rename tag across all hosts
    const handleEditTag = useCallback(
      (oldTag: string, newTag: string) => {
        if (oldTag === newTag) return;
        const updatedHosts = hosts.map((host) => {
          if (host.tags?.includes(oldTag)) {
            const newTags = host.tags.map((t) => (t === oldTag ? newTag : t));
            // Remove duplicates in case newTag already exists
            return { ...host, tags: Array.from(new Set(newTags)) };
          }
          return host;
        });
        onUpdateHosts(updatedHosts);
      },
      [hosts, onUpdateHosts],
    );
  
  // Handle tag delete - remove tag from all hosts
    const handleDeleteTag = useCallback(
      (tag: string) => {
        const updatedHosts = hosts.map((host) => {
          if (host.tags?.includes(tag)) {
            return { ...host, tags: host.tags.filter((t) => t !== tag) };
          }
          return host;
        });
        onUpdateHosts(updatedHosts);
      },
      [hosts, onUpdateHosts],
    );
  
  const displayedGroups = useMemo(() => {
      if (!selectedGroupPath) {
        // Hide "General" group at root level only if it's auto-generated
        // (not user-created and has no subgroups)
        const isGeneralUserCreated = customGroups.some(
          (g) => g === "General" || g.startsWith("General/")
        );
        return (Object.values(buildGroupTree) as GroupNode[])
          .filter((node) => {
            if (node.name !== "General") return true;
            // Keep General if user explicitly created it or it has subgroups
            if (isGeneralUserCreated) return true;
            if (Object.keys(node.children).length > 0) return true;
            return false;
          })
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      const node = findGroupNode(selectedGroupPath);
      if (!node || !node.children) return [];
      return (Object.values(node.children) as GroupNode[]).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps -- findGroupNode is derived from buildGroupTree
    }, [buildGroupTree, selectedGroupPath, customGroups]);
  
  const shouldHideEmptyRootHostsSection = useMemo(() => {
      if (selectedGroupPath || viewMode === "tree") return false;
      if (search.trim() || selectedTags.length > 0) return false;
      if (visibleDisplayedHosts.length > 0) return false;
      return (
        displayedGroups.length > 0 ||
        pinnedHosts.length > 0 ||
        (showRecentHosts && recentHosts.length > 0)
      );
    }, [
      selectedGroupPath,
      viewMode,
      search,
      selectedTags.length,
      visibleDisplayedHosts.length,
      displayedGroups.length,
      pinnedHosts.length,
      showRecentHosts,
      recentHosts.length,
    ]);
  
  // Known Hosts callbacks - use refs to keep stable references
    // Store latest values in refs so callbacks don't need to depend on them
    const knownHostsRef = React.useRef(knownHosts);
  
  const onUpdateKnownHostsRef = React.useRef(onUpdateKnownHosts);
  
  // Keep refs up to date
    React.useEffect(() => {
      knownHostsRef.current = knownHosts;
      onUpdateKnownHostsRef.current = onUpdateKnownHosts;
    });
  
  // Stable callbacks that read from refs
    const handleSaveKnownHost = useCallback((kh: KnownHost) => {
      onUpdateKnownHostsRef.current(upsertKnownHost(knownHostsRef.current, kh));
    }, []);
  
  const handleUpdateKnownHost = useCallback((kh: KnownHost) => {
      onUpdateKnownHostsRef.current(
        knownHostsRef.current.map((existing) =>
          existing.id === kh.id ? kh : existing,
        ),
      );
    }, []);
  
  const handleDeleteKnownHost = useCallback((id: string) => {
      onUpdateKnownHostsRef.current(
        knownHostsRef.current.filter((kh) => kh.id !== id),
      );
    }, []);
  
  const handleImportKnownHosts = useCallback((newHosts: KnownHost[]) => {
      onUpdateKnownHostsRef.current([...knownHostsRef.current, ...newHosts]);
    }, []);
  
  const handleRefreshKnownHosts = useCallback(() => {
      // Placeholder for system scan
    }, []);
  
  // Memoize the KnownHostsManager element to prevent re-renders when VaultViewInner re-renders
    const knownHostsManagerElement = useMemo(() => {
      return (
        <KnownHostsManager
          knownHosts={knownHosts}
          hosts={hosts}
          onSave={handleSaveKnownHost}
          onUpdate={handleUpdateKnownHost}
          onDelete={handleDeleteKnownHost}
          onConvertToHost={onConvertKnownHost}
          onImportFromFile={handleImportKnownHosts}
          onRefresh={handleRefreshKnownHosts}
        />
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps -- handle* callbacks are stable refs that read from refs
    }, [knownHosts, hosts, onConvertKnownHost]);

  return {
    allGroupPaths,
    allTags,
    buildGroupTree,
    displayedGroups,
    displayedHosts,
    findGroupNode,
    groupedDisplayHosts,
    handleDeleteTag,
    handleEditTag,
    knownHostsManagerElement,
    pinnedHosts,
    pinnedRecentIds,
    recentHosts,
    shouldHideEmptyRootHostsSection,
    treeViewGroupTree,
    treeViewHosts,
    visibleDisplayedHosts,
  };
}
