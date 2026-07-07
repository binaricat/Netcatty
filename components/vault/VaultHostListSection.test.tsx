import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckSquare,
  ClipboardCopy,
  Clock,
  Copy,
  Edit2,
  FileSymlink,
  FolderPlus,
  FolderTree,
  LayoutGrid,
  Pin,
  Plug,
  Square,
  Star,
  Trash2,
} from "lucide-react";

import { getEffectiveHostDistro, sanitizeHost } from "../../domain/host.ts";
import type { GroupNode, Host } from "../../types.ts";
import { DistroAvatar } from "../DistroAvatar.tsx";
import { HostTreeView } from "../HostTreeView.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu.tsx";
import { cn } from "../../lib/utils.ts";
import { VaultHostListSection } from "./VaultHostListSection.tsx";

const makeHost = (id: string, label: string): Host => ({
  id,
  label,
  hostname: "router.example.com",
  username: "netops",
  port: 22,
  os: "linux",
  tags: [],
  notes: "Maintenance notes",
  createdAt: 1,
});

const mainHost = makeHost("main-host", "Main Router");
const pinnedHost = makeHost("pinned-host", "Pinned Router");
const recentHost = makeHost("recent-host", "Recent Router");
const groupedHost = makeHost("grouped-host", "Grouped Router");

const group: GroupNode = {
  name: "Production",
  path: "production",
  children: {},
  hosts: [mainHost],
  totalHostCount: 1,
};

const noop = () => undefined;

type RenderHostListOptions = {
  displayedGroups?: GroupNode[];
  displayedHosts?: Host[];
  groupedDisplayHosts?: Array<{ name: string; hosts: Host[] }>;
  pinnedHosts?: Host[];
  pinnedRecentIds?: Set<string>;
  recentHosts?: Host[];
  showRecentHosts?: boolean;
  sortMode?: string;
  treeViewGroupTree?: GroupNode[];
  treeViewHosts?: Host[];
  viewMode: "list" | "grid" | "tree";
  visibleDisplayedHosts?: Host[];
};

const renderHostList = ({
  displayedGroups = [group],
  displayedHosts = [mainHost],
  groupedDisplayHosts,
  pinnedHosts = [],
  pinnedRecentIds = new Set<string>(),
  recentHosts = [],
  showRecentHosts = false,
  sortMode = "az",
  treeViewGroupTree = [],
  treeViewHosts = [],
  viewMode,
  visibleDisplayedHosts = [mainHost],
}: RenderHostListOptions) => renderToStaticMarkup(
  <VaultHostListSection
    ctx={{
      Badge,
      Boolean,
      Button,
      cancelInlineGroupEdit: noop,
      CheckSquare,
      ClipboardCopy,
      Clock,
      cn,
      commitInlineGroupRename: noop,
      ContextMenu,
      ContextMenuContent,
      ContextMenuItem,
      ContextMenuTrigger,
      Copy,
      displayedGroups,
      displayedHosts,
      DistroAvatar,
      Edit2,
      FileSymlink,
      FolderPlus,
      FolderTree,
      getDropTargetClasses: () => "",
      getEffectiveHostDistro,
      groupConfigs: [],
      groupedDisplayHosts,
      handleCopyCredentials: noop,
      handleDuplicateHost: noop,
      handleEditGroupConfig: noop,
      handleEditHost: noop,
      handleHostConnect: noop,
      handleUnmanageGroup: noop,
      hasHostsSidePanel: false,
      hostListScrollRef: React.createRef<HTMLDivElement>(),
      HostTreeView,
      isHostsSectionActive: true,
      isMultiSelectMode: false,
      lastPinnedId: null,
      LayoutGrid,
      managedGroupPaths: new Set<string>(),
      moveGroup: noop,
      moveHostToGroup: noop,
      onDeleteHost: noop,
      Pin,
      pinnedHosts,
      pinnedRecentIds,
      Plug,
      recentHosts,
      reorderGroup: noop,
      reorderHost: noop,
      sanitizeHost,
      selectedGroupPath: null,
      selectedHostIds: new Set<string>(),
      sessionCount: 0,
      setDeleteTargetPath: noop,
      setDragOverDropTarget: noop,
      setGroupDragOverDropTarget: noop,
      setIsDeleteGroupOpen: noop,
      setIsNewFolderOpen: noop,
      setLastPinnedId: noop,
      setNewFolderName: noop,
      setSelectedGroupPath: noop,
      setTargetParentPath: noop,
      shouldHideEmptyRootHostsSection: false,
      showRecentHosts,
      sortMode,
      splitViewGridStyle: undefined,
      Square,
      Star,
      startInlineDeleteGroup: noop,
      startInlineNewGroup: noop,
      startInlineRenameGroup: noop,
      t: (key: string) => key,
      toggleHostPinned: noop,
      toggleHostSelection: noop,
      Trash2,
      treeExpandedState: {
        expandedPaths: new Set<string>(),
        togglePath: noop,
        expandAll: noop,
        collapseAll: noop,
      },
      treeViewGroupTree,
      treeViewHosts,
      viewMode,
      visibleDisplayedHosts,
    }}
  />,
);

const editButtonIndexForHost = (markup: string, hostId: string) =>
  markup.indexOf(`data-vault-host-edit-button="${hostId}"`);

const editButtonIndexForGroup = (markup: string, groupPath: string) =>
  markup.indexOf(`data-vault-group-edit-button="${groupPath}"`);

const assertListHostPlacement = (markup: string, host: Host) => {
  const listLabelIndex = markup.indexOf(host.label);
  const listEditIndex = editButtonIndexForHost(markup, host.id);
  const listNotesIndex = markup.indexOf('aria-label="Host notes"', listLabelIndex);

  assert.ok(listLabelIndex >= 0);
  assert.ok(listEditIndex > listLabelIndex);
  assert.ok(listNotesIndex > listEditIndex);
};

const assertGridHostPlacement = (markup: string, host: Host) => {
  const gridLabelIndex = markup.indexOf(host.label);
  const gridNotesIndex = markup.indexOf('aria-label="Host notes"', gridLabelIndex);
  const gridEditIndex = editButtonIndexForHost(markup, host.id);

  assert.ok(gridLabelIndex >= 0);
  assert.ok(gridNotesIndex > gridLabelIndex);
  assert.ok(gridEditIndex > gridNotesIndex);
};

const assertListGroupPlacement = (markup: string, groupNode: GroupNode) => {
  const listLabelIndex = markup.indexOf(groupNode.name);
  const listEditIndex = editButtonIndexForGroup(markup, groupNode.path);
  const listCountIndex = markup.indexOf("vault.groups.hostsCount", listLabelIndex);

  assert.ok(listLabelIndex >= 0);
  assert.ok(listEditIndex > listLabelIndex);
  assert.ok(listCountIndex > listEditIndex);
};

const assertGridGroupPlacement = (markup: string, groupNode: GroupNode) => {
  const gridLabelIndex = markup.indexOf(groupNode.name);
  const gridCountIndex = markup.indexOf("vault.groups.hostsCount", gridLabelIndex);
  const gridEditIndex = editButtonIndexForGroup(markup, groupNode.path);

  assert.ok(gridLabelIndex >= 0);
  assert.ok(gridCountIndex > gridLabelIndex);
  assert.ok(gridEditIndex > gridCountIndex);
};

test("VaultHostListSection keeps list edit actions beside host labels in all list sections without changing grid", () => {
  const listMarkup = renderHostList({
    viewMode: "list",
    displayedGroups: [],
    displayedHosts: [mainHost, pinnedHost, recentHost],
    pinnedHosts: [pinnedHost],
    recentHosts: [recentHost],
    showRecentHosts: true,
    visibleDisplayedHosts: [mainHost],
  });

  assertListHostPlacement(listMarkup, pinnedHost);
  assertListHostPlacement(listMarkup, recentHost);
  assertListHostPlacement(listMarkup, mainHost);

  const gridMarkup = renderHostList({
    viewMode: "grid",
    displayedGroups: [],
    displayedHosts: [mainHost, pinnedHost, recentHost],
    pinnedHosts: [pinnedHost],
    recentHosts: [recentHost],
    showRecentHosts: true,
    visibleDisplayedHosts: [mainHost],
  });

  assertGridHostPlacement(gridMarkup, pinnedHost);
  assertGridHostPlacement(gridMarkup, recentHost);
  assertGridHostPlacement(gridMarkup, mainHost);
});

test("VaultHostListSection keeps grouped host edit actions beside labels without changing grid", () => {
  const listMarkup = renderHostList({
    viewMode: "list",
    displayedGroups: [],
    displayedHosts: [groupedHost],
    groupedDisplayHosts: [{ name: "Routers", hosts: [groupedHost] }],
    sortMode: "group",
    visibleDisplayedHosts: [],
  });

  assertListHostPlacement(listMarkup, groupedHost);

  const gridMarkup = renderHostList({
    viewMode: "grid",
    displayedGroups: [],
    displayedHosts: [groupedHost],
    groupedDisplayHosts: [{ name: "Routers", hosts: [groupedHost] }],
    sortMode: "group",
    visibleDisplayedHosts: [],
  });

  assertGridHostPlacement(gridMarkup, groupedHost);
});

test("VaultHostListSection keeps list group edit action beside the group label without changing grid", () => {
  const listMarkup = renderHostList({
    viewMode: "list",
    displayedGroups: [group],
    displayedHosts: [],
    visibleDisplayedHosts: [],
  });

  assertListGroupPlacement(listMarkup, group);

  const gridMarkup = renderHostList({
    viewMode: "grid",
    displayedGroups: [group],
    displayedHosts: [],
    visibleDisplayedHosts: [],
  });

  assertGridGroupPlacement(gridMarkup, group);
});
