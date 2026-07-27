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
import {
  getVaultTreeAutoExpandKey,
  VaultHostListSection,
} from "./VaultHostListSection.tsx";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});

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

test("tree auto-expansion covers both text and tag filters", () => {
  assert.equal(getVaultTreeAutoExpandKey("", []), undefined);
  assert.ok(getVaultTreeAutoExpandKey("router", []));
  assert.ok(getVaultTreeAutoExpandKey("", ["production"]));
  assert.equal(
    getVaultTreeAutoExpandKey("router", ["production", "linux"]),
    getVaultTreeAutoExpandKey("router", ["linux", "production"]),
  );
});

type RenderHostListOptions = {
  displayedGroups?: GroupNode[];
  displayedHosts?: Host[];
  groupedDisplayHosts?: Array<{ name: string; hosts: Host[] }>;
  isMultiSelectMode?: boolean;
  pinnedHosts?: Host[];
  pinnedRecentIds?: Set<string>;
  recentHosts?: Host[];
  showRecentHosts?: boolean;
  selectedGroupPaths?: Set<string>;
  selectedHostIds?: Set<string>;
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
  isMultiSelectMode = false,
  pinnedHosts = [],
  pinnedRecentIds = new Set<string>(),
  recentHosts = [],
  showRecentHosts = false,
  selectedGroupPaths = new Set<string>(),
  selectedHostIds = new Set<string>(),
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
      isMultiSelectMode,
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
      selectedGroupPaths,
      selectedHostIds,
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
      toggleGroupSelection: noop,
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

test("VaultHostListSection exposes selectable groups to keyboard and assistive technology", () => {
  const markup = renderHostList({
    viewMode: "list",
    displayedGroups: [group],
    displayedHosts: [],
    visibleDisplayedHosts: [],
    isMultiSelectMode: true,
    selectedGroupPaths: new Set([group.path]),
  });

  assert.match(markup, /data-group-path="production"[^>]*role="checkbox"/);
  assert.match(markup, /data-group-path="production"[^>]*aria-checked="true"/);
  assert.match(markup, /data-group-path="production"[^>]*tabindex="0"/);
});

test("VaultHostListSection exposes normal group cards to keyboard", () => {
  const markup = renderHostList({
    viewMode: "list",
    displayedGroups: [group],
    displayedHosts: [],
    visibleDisplayedHosts: [],
  });

  assert.match(markup, /data-group-path="production"[^>]*role="button"/);
  assert.match(markup, /data-group-path="production"[^>]*tabindex="0"/);
});

test("VaultHostListSection exposes ungrouped hosts to keyboard and assistive technology", () => {
  const markup = renderHostList({
    viewMode: "list",
    displayedGroups: [],
    displayedHosts: [mainHost],
    visibleDisplayedHosts: [mainHost],
    isMultiSelectMode: true,
    selectedHostIds: new Set([mainHost.id]),
  });

  assert.match(markup, /data-host-id="main-host"[^>]*role="checkbox"/);
  assert.match(markup, /data-host-id="main-host"[^>]*aria-checked="true"/);
  assert.match(markup, /data-host-id="main-host"[^>]*tabindex="0"/);
});

test("VaultHostListSection exposes grouped hosts to keyboard and assistive technology", () => {
  const markup = renderHostList({
    viewMode: "grid",
    displayedGroups: [],
    displayedHosts: [groupedHost],
    groupedDisplayHosts: [{ name: "Production", hosts: [groupedHost] }],
    visibleDisplayedHosts: [groupedHost],
    isMultiSelectMode: true,
    selectedHostIds: new Set([groupedHost.id]),
    sortMode: "group",
  });

  assert.match(markup, /data-host-id="grouped-host"[^>]*role="checkbox"/);
  assert.match(markup, /data-host-id="grouped-host"[^>]*aria-checked="true"/);
  assert.match(markup, /data-host-id="grouped-host"[^>]*tabindex="0"/);
});

test("VaultHostListSection virtualizes large grid collections without hiding search results", () => {
  const hosts = Array.from({ length: 300 }, (_, index) => (
    makeHost(`bulk-${index}`, `Bulk ${index}`)
  ));
  const markup = renderHostList({
    viewMode: "grid",
    displayedGroups: [],
    displayedHosts: hosts,
    visibleDisplayedHosts: hosts,
  });

  const renderedHosts = (markup.match(/data-vault-grid-item="main:/g) ?? []).length;
  assert.ok(renderedHosts > 0);
  assert.ok(renderedHosts < 100);
  assert.doesNotMatch(markup, /vault\.hosts\.showMore/);
});

test("VaultHostListSection virtualizes large pinned collections", () => {
  const hosts = Array.from({ length: 300 }, (_, index) => (
    { ...makeHost(`pinned-${index}`, `Pinned ${index}`), pinned: true }
  ));
  const markup = renderHostList({
    viewMode: "grid",
    displayedGroups: [],
    displayedHosts: [],
    visibleDisplayedHosts: [],
    pinnedHosts: hosts,
  });

  const renderedHosts = (markup.match(/data-vault-grid-item="pinned:/g) ?? []).length;
  assert.ok(renderedHosts > 0);
  assert.ok(renderedHosts < 100);
  assert.match(markup, /data-vault-virtual-collection="grid"/);
});

test("VaultHostListSection virtualizes large group collections", () => {
  const groups = Array.from({ length: 300 }, (_, index): GroupNode => ({
    name: `Group ${index}`,
    path: `group-${index}`,
    children: {},
    hosts: [],
    totalHostCount: 0,
  }));
  const markup = renderHostList({
    viewMode: "grid",
    displayedGroups: groups,
    displayedHosts: [],
    visibleDisplayedHosts: [],
  });

  const renderedGroups = (markup.match(/data-vault-grid-item="group:/g) ?? []).length;
  assert.ok(renderedGroups > 0);
  assert.ok(renderedGroups < 100);
  assert.match(markup, /data-vault-virtual-collection="grid"/);
});

test("VaultHostListSection preserves grouped totals while virtualizing rendered cards", () => {
  const hosts = Array.from({ length: 300 }, (_, index) => (
    makeHost(`grouped-bulk-${index}`, `Grouped Bulk ${index}`)
  ));
  const markup = renderHostList({
    viewMode: "grid",
    displayedGroups: [],
    displayedHosts: hosts,
    groupedDisplayHosts: [{ name: "Large group", hosts }],
    sortMode: "group",
    visibleDisplayedHosts: [],
  });

  const renderedHosts = (markup.match(/data-vault-grid-item="grouped:/g) ?? []).length;
  assert.ok(renderedHosts > 0);
  assert.ok(renderedHosts < 100);
  assert.match(markup, /\(300\)/);
});
