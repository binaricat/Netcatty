import {
  Activity,
  BookMarked,
  CheckSquare,
  ChevronDown,
  ClipboardCopy,
  Clock,
  Copy,
  Download,
  Edit2,
  FileCode,
  FileSymlink,
  FolderPlus,
  FolderTree,
  Globe,
  Key,
  LayoutGrid,
  List,
  Network,
  Pin,
  Plug,
  Plus,
  Search,
  Settings,
  Square,
  Star,
  TerminalSquare,
  Trash2,
  Upload,
  Usb,
  X,
  Zap,
} from "lucide-react";
import React, { Suspense, lazy, memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useStoredViewMode } from "../application/state/useStoredViewMode";
import { useStoredBoolean } from "../application/state/useStoredBoolean";
import { useStoredNumber } from "../application/state/useStoredNumber";
import { useStoredString } from "../application/state/useStoredString";
import { useTreeExpandedState } from "../application/state/useTreeExpandedState";
import { sanitizeCredentialValue } from "../domain/credentials";
import { resolveGroupDefaults, applyGroupDefaults } from "../domain/groupConfig";
import {
  getEffectiveHostDistro,
  resolveTelnetPassword,
  resolveTelnetPort,
  resolveTelnetUsername,
  sanitizeHost,
  upsertHostById,
} from "../domain/host";
import { exportHostsToCsvWithStats } from "../domain/vaultImport";
import {
  STORAGE_KEY_VAULT_HOSTS_SORT_MODE,
  STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED,
  STORAGE_KEY_VAULT_HOSTS_VIEW_MODE,
  STORAGE_KEY_VAULT_SIDEBAR_COLLAPSED,
  STORAGE_KEY_VAULT_SIDEBAR_WIDTH,
} from "../infrastructure/config/storageKeys";
import { cn } from "../lib/utils";
import { useInstantThemeSwitch } from "../lib/useInstantThemeSwitch";
import {
  ConnectionLog,
  GroupConfig,
  Host,
  HostProtocol,
  Identity,
  KnownHost,
  ManagedSource,
  ProxyProfile,
  SerialConfig,
  SSHKey,
  ShellHistoryEntry,
  Snippet,
} from "../types";
import { AppLogo } from "./AppLogo";
import { DistroAvatar } from "./DistroAvatar";
import GroupDetailsPanel from "./GroupDetailsPanel";
import HostDetailsPanel from "./HostDetailsPanel";
import { HostTreeView } from "./HostTreeView";
import KeychainManager from "./KeychainManager";
import PortForwarding from "./PortForwardingNew";
import ProxyProfilesManager from "./ProxyProfilesManager";
import QuickConnectWizard from "./QuickConnectWizard";
import { isQuickConnectInput, parseQuickConnectInputWithWarnings } from "../domain/quickConnect";
import SerialConnectModal from "./SerialConnectModal";
import SerialHostDetailsPanel from "./SerialHostDetailsPanel";
import SnippetsManager from "./SnippetsManager";
import { ImportVaultDialog } from "./vault/ImportVaultDialog";
import { Button } from "./ui/button";
import { RippleButton } from "./ui/ripple";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SortDropdown, SortMode } from "./ui/sort-dropdown";
import { TagFilterDropdown } from "./ui/tag-filter-dropdown";
import { toast } from "./ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "./ui/tooltip";
import { Badge } from "./ui/badge";
import { HotkeyScheme, KeyBinding } from "../domain/models";
import { VaultViewLayout } from "./vault/VaultViewLayout";
import { useVaultHostCollections } from "./vault/useVaultHostCollections";
import { useVaultImportHandlers } from "./vault/useVaultImportHandlers";
import { useVaultGroupDragHandlers } from "./vault/useVaultGroupDragHandlers";

const LazyProtocolSelectDialog = lazy(() => import("./ProtocolSelectDialog"));
const LazyConnectionLogsManager = lazy(() => import("./ConnectionLogsManager"));

export type VaultSection = "hosts" | "keys" | "proxies" | "snippets" | "port" | "knownhosts" | "logs";

const VAULT_SIDEBAR_MIN_WIDTH = 56;
const VAULT_SIDEBAR_DEFAULT_WIDTH = 208;
const VAULT_SIDEBAR_MAX_WIDTH = 320;
const VAULT_SIDEBAR_LABEL_THRESHOLD = 132;

const isSortMode = (value: string): value is SortMode =>
  value === "az" ||
  value === "za" ||
  value === "newest" ||
  value === "oldest" ||
  value === "group";

// Props without isActive - it's now subscribed internally
interface VaultViewProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  proxyProfiles: ProxyProfile[];
  snippets: Snippet[];
  snippetPackages: string[];
  customGroups: string[];
  knownHosts: KnownHost[];
  shellHistory: ShellHistoryEntry[];
  connectionLogs: ConnectionLog[];
  managedSources: ManagedSource[];
  sessionCount: number;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  terminalThemeId: string;
  terminalFontSize: number;
  onOpenSettings: () => void;
  onOpenQuickSwitcher: () => void;
  onCreateLocalTerminal: () => void;
  onConnectSerial?: (config: SerialConfig, options?: { charset?: string }) => void;
  onDeleteHost: (id: string) => void;
  onConnect: (host: Host) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateKeys: (keys: SSHKey[]) => void;
  onImportOrReuseKey: (draft: Partial<SSHKey>) => SSHKey;
  onUpdateIdentities: (identities: Identity[]) => void;
  onUpdateProxyProfiles: (profiles: ProxyProfile[]) => void;
  onUpdateSnippets: (snippets: Snippet[]) => void;
  onUpdateSnippetPackages: (pkgs: string[]) => void;
  onUpdateCustomGroups: (groups: string[]) => void;
  onUpdateKnownHosts: (knownHosts: KnownHost[]) => void;
  onUpdateManagedSources: (managedSources: ManagedSource[]) => void;
  onClearAndRemoveManagedSource?: (source: ManagedSource) => Promise<boolean>;
  onClearAndRemoveManagedSources?: (sources: ManagedSource[]) => Promise<void>;
  onUnmanageSource?: (sourceId: string) => void;
  onConvertKnownHost: (knownHost: KnownHost) => void;
  onToggleConnectionLogSaved: (id: string) => void;
  onDeleteConnectionLog: (id: string) => void;
  onClearUnsavedConnectionLogs: () => void;
  onOpenLogView: (log: ConnectionLog) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
  groupConfigs: GroupConfig[];
  onUpdateGroupConfigs: (configs: GroupConfig[]) => void;
  showRecentHosts: boolean;
  showOnlyUngroupedHostsInRoot: boolean;
  // Optional: navigate to a specific section on mount or when changed
  navigateToSection?: VaultSection | null;
  onNavigateToSectionHandled?: () => void;
  terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number };
}

const VaultViewInner: React.FC<VaultViewProps> = ({
  hosts,
  keys,
  identities,
  proxyProfiles,
  snippets,
  snippetPackages,
  customGroups,
  knownHosts,
  shellHistory,
  connectionLogs,
  managedSources,
  sessionCount,
  hotkeyScheme,
  keyBindings,
  terminalThemeId,
  terminalFontSize,
  onOpenSettings,
  onOpenQuickSwitcher,
  onCreateLocalTerminal,
  onConnectSerial,
  onDeleteHost,
  onConnect,
  onUpdateHosts,
  onUpdateKeys,
  onImportOrReuseKey,
  onUpdateIdentities,
  onUpdateProxyProfiles,
  onUpdateSnippets,
  onUpdateSnippetPackages,
  onUpdateCustomGroups,
  onUpdateKnownHosts,
  onUpdateManagedSources,
  onClearAndRemoveManagedSource,
  onClearAndRemoveManagedSources,
  onUnmanageSource,
  onConvertKnownHost,
  onToggleConnectionLogSaved,
  onDeleteConnectionLog,
  onClearUnsavedConnectionLogs,
  onOpenLogView,
  onRunSnippet,
  groupConfigs,
  onUpdateGroupConfigs,
  showRecentHosts,
  showOnlyUngroupedHostsInRoot,
  navigateToSection,
  onNavigateToSectionHandled,
  terminalSettings,
}) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const [currentSection, setCurrentSection] = useState<VaultSection>("hosts");
  const [search, setSearch] = useState("");
  const [selectedGroupPath, setSelectedGroupPath] = useState<string | null>(
    null,
  );
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [targetParentPath, setTargetParentPath] = useState<string | null>(null);
  const [isRenameGroupOpen, setIsRenameGroupOpen] = useState(false);
  const [renameTargetPath, setRenameTargetPath] = useState<string | null>(null);
  const [renameGroupName, setRenameGroupName] = useState("");
  const [renameGroupError, setRenameGroupError] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isSerialModalOpen, setIsSerialModalOpen] = useState(false);
  const [isDeleteGroupOpen, setIsDeleteGroupOpen] = useState(false);
  const [deleteTargetPath, setDeleteTargetPath] = useState<string | null>(null);
  const [deleteGroupWithHosts, setDeleteGroupWithHosts] = useState(false);

  useInstantThemeSwitch(rootRef);

  // Sidebar collapsed state with localStorage persistence
  const [storedSidebarCollapsed, setStoredSidebarCollapsed] = useStoredBoolean(
    STORAGE_KEY_VAULT_SIDEBAR_COLLAPSED,
    false,
  );
  const [sidebarWidth, setSidebarWidth, persistSidebarWidth] = useStoredNumber(
    STORAGE_KEY_VAULT_SIDEBAR_WIDTH,
    storedSidebarCollapsed ? VAULT_SIDEBAR_MIN_WIDTH : VAULT_SIDEBAR_DEFAULT_WIDTH,
    {
      min: VAULT_SIDEBAR_MIN_WIDTH,
      max: VAULT_SIDEBAR_MAX_WIDTH,
    },
  );
  const sidebarCollapsed = sidebarWidth < VAULT_SIDEBAR_LABEL_THRESHOLD;
  const setSidebarCollapsed = useCallback((nextCollapsed: boolean) => {
    const nextWidth = nextCollapsed ? VAULT_SIDEBAR_MIN_WIDTH : VAULT_SIDEBAR_DEFAULT_WIDTH;
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
    setStoredSidebarCollapsed(nextCollapsed);
  }, [persistSidebarWidth, setSidebarWidth, setStoredSidebarCollapsed]);
  const handleSidebarWidthCommit = useCallback((nextWidth: number) => {
    const clampedWidth = Math.max(
      VAULT_SIDEBAR_MIN_WIDTH,
      Math.min(VAULT_SIDEBAR_MAX_WIDTH, nextWidth),
    );
    setSidebarWidth(clampedWidth);
    persistSidebarWidth(clampedWidth);
    setStoredSidebarCollapsed(clampedWidth < VAULT_SIDEBAR_LABEL_THRESHOLD);
  }, [persistSidebarWidth, setSidebarWidth, setStoredSidebarCollapsed]);

  // Handle external navigation requests
  useEffect(() => {
    if (navigateToSection) {
      setCurrentSection(navigateToSection);
      onNavigateToSectionHandled?.();
    }
  }, [navigateToSection, onNavigateToSectionHandled]);

  // View mode, sorting, and tag filter state
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_VAULT_HOSTS_VIEW_MODE,
    "grid",
  );
  const treeExpandedState = useTreeExpandedState(STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED);
  const [sortMode, setSortMode] = useStoredString<SortMode>(
    STORAGE_KEY_VAULT_HOSTS_SORT_MODE,
    "az",
    isSortMode,
  );
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // Host panel state (local to hosts section)
  const [isHostPanelOpen, setIsHostPanelOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [newHostGroupPath, setNewHostGroupPath] = useState<string | null>(null);

  // When the side panel is open, Tailwind's viewport-based grid-cols-* can't
  // react to the narrowed content area, so we drive the host-grid column count
  // off the actual container width (measured below). A fixed column count keeps
  // a lone card at one column's width instead of stretching it across the row
  // the way auto-fit + 1fr would. The count is published as a CSS variable
  // (set imperatively) rather than React state, so re-flowing the grid never
  // re-renders this (large) component during panel transitions / window resize.
  const hostListScrollRef = useRef<HTMLDivElement>(null);
  const splitGridColsRef = useRef(0);

  // Close host panel if the host being edited was deleted.
  // Track previous host IDs so we only close for actual deletions, not for
  // unsaved new/duplicated hosts whose IDs were never in the hosts array.
  const knownHostIdsRef = useRef(new Set(hosts.map(h => h.id)));
  useEffect(() => {
    const currentIds = new Set(hosts.map(h => h.id));
    // Check against previous IDs before updating the ref
    if (editingHost && knownHostIdsRef.current.has(editingHost.id) && !currentIds.has(editingHost.id)) {
      setIsHostPanelOpen(false);
      setEditingHost(null);
      setNewHostGroupPath(null);
    }
    knownHostIdsRef.current = currentIds;
  }, [hosts, editingHost]);

  // Group panel state
  const [isGroupPanelOpen, setIsGroupPanelOpen] = useState(false);
  const [editingGroupPath, setEditingGroupPath] = useState<string | null>(null);

  // Compute inherited group defaults for the host being edited
  const editingHostGroupDefaults = useMemo(() => {
    const group = editingHost?.group || newHostGroupPath || selectedGroupPath;
    if (!group) return undefined;
    return resolveGroupDefaults(group, groupConfigs);
  }, [editingHost, newHostGroupPath, selectedGroupPath, groupConfigs]);
  const proxyProfileIdSet = useMemo(
    () => new Set(proxyProfiles.map((profile) => profile.id)),
    [proxyProfiles],
  );
  // Quick connect state
  const [quickConnectTarget, setQuickConnectTarget] = useState<{
    hostname: string;
    username?: string;
    port?: number;
  } | null>(null);
  const [isQuickConnectOpen, setIsQuickConnectOpen] = useState(false);
  const [quickConnectWarnings, setQuickConnectWarnings] = useState<string[]>([]);

  // Protocol select state (for hosts with multiple protocols)
  const [protocolSelectHost, setProtocolSelectHost] = useState<Host | null>(
    null,
  );

  // Check if search input is a quick connect address
  const isSearchQuickConnect = useMemo(() => {
    return isQuickConnectInput(search);
  }, [search]);

  // Handle connect button click - detect quick connect or regular search
  const handleConnectClick = useCallback(() => {
    if (isSearchQuickConnect) {
      const parsed = parseQuickConnectInputWithWarnings(search);
      if (parsed.target) {
        setQuickConnectTarget(parsed.target);
        setQuickConnectWarnings(parsed.warnings);
        setIsQuickConnectOpen(true);
      }
    } else {
      onOpenQuickSwitcher();
    }
  }, [isSearchQuickConnect, search, onOpenQuickSwitcher]);

  // Handle search input keydown for quick connect
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && isSearchQuickConnect) {
        e.preventDefault();
        handleConnectClick();
      }
    },
    [isSearchQuickConnect, handleConnectClick],
  );

  // Handle host connect. Resolution order:
  //   Telnet set as default (protocol === 'telnet')  -> connect Telnet
  //   Telnet enabled but not the default             -> ask (protocol picker)
  //   Mosh enabled                                   -> connect Mosh
  //   otherwise                                      -> connect SSH
  const handleHostConnect = useCallback(
    (host: Host) => {
      const effective = host.group
        ? applyGroupDefaults(host, resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds: proxyProfileIdSet }), { validProxyProfileIds: proxyProfileIdSet })
        : applyGroupDefaults(host, {}, { validProxyProfileIds: proxyProfileIdSet });
      // Only prompt when Telnet is available but isn't the host's default protocol.
      if (effective.telnetEnabled && effective.protocol !== "telnet") {
        setProtocolSelectHost(effective);
      } else if (effective.protocol === "telnet") {
        // Telnet-as-default wins over a stray moshEnabled flag.
        onConnect({ ...host, moshEnabled: false });
      } else {
        onConnect(host);
      }
    },
    [onConnect, groupConfigs, proxyProfileIdSet],
  );

  // Handle protocol selection
  const handleProtocolSelect = useCallback(
    (protocol: HostProtocol, port: number) => {
      if (protocolSelectHost) {
        const hostWithProtocol: Host = {
          ...protocolSelectHost,
          protocol: (protocol === "mosh" || protocol === "et") ? "ssh" : protocol,
          port,
          moshEnabled: protocol === "mosh",
          etEnabled: protocol === "et",
        };
        onConnect(hostWithProtocol);
        setProtocolSelectHost(null);
      }
    },
    [protocolSelectHost, onConnect],
  );

  // Handle quick connect
  const handleQuickConnect = useCallback(
    (host: Host) => {
      onConnect(host);
      setIsQuickConnectOpen(false);
      setQuickConnectTarget(null);
      setQuickConnectWarnings([]);
      setSearch("");
    },
    [onConnect],
  );

  // Handle quick connect save host
  const handleQuickConnectSaveHost = useCallback(
    (host: Host) => {
      onUpdateHosts([...hosts, host]);
    },
    [hosts, onUpdateHosts],
  );

  const handleNewHost = useCallback(() => {
    setIsGroupPanelOpen(false);
    setEditingGroupPath(null);
    setEditingHost(null);
    setNewHostGroupPath(null);
    setIsHostPanelOpen(true);
  }, []);

  const handleEditHost = useCallback((host: Host) => {
    setIsGroupPanelOpen(false);
    setEditingGroupPath(null);
    setEditingHost(host);
    setIsHostPanelOpen(true);
  }, []);

  const handleDuplicateHost = useCallback((host: Host) => {
    // Create a copy of the host with a new ID and modified label
    const duplicatedHost: Host = {
      ...host,
      id: crypto.randomUUID(),
      label: `${host.label} (${t('action.copy')})`,
      createdAt: Date.now(),
      pinned: undefined,
      lastConnectedAt: undefined,
    };
    // Open the edit panel with the duplicated host for modification
    setEditingHost(duplicatedHost);
    setIsHostPanelOpen(true);
  }, [t]);

  // Export hosts to CSV
  const handleExportHosts = useCallback(() => {
    if (hosts.length === 0) {
      toast.warning(t('vault.hosts.export.toast.noHosts'));
      return;
    }

    const { csv, exportedCount, skippedCount } = exportHostsToCsvWithStats(hosts);

    if (exportedCount === 0) {
      toast.warning(t('vault.hosts.export.toast.noHosts'));
      return;
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hosts_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    if (skippedCount > 0) {
      toast.warning(t('vault.hosts.export.toast.successWithSkipped', { count: exportedCount, skipped: skippedCount }));
    } else {
      toast.success(t('vault.hosts.export.toast.success', { count: exportedCount }));
    }
  }, [hosts, t]);

  // Copy host credentials to clipboard
  const handleCopyCredentials = useCallback((host: Host) => {
    // Apply group defaults so inherited credentials are included
    const effective = host.group
      ? applyGroupDefaults(host, resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds: proxyProfileIdSet }), { validProxyProfileIds: proxyProfileIdSet })
      : applyGroupDefaults(host, {}, { validProxyProfileIds: proxyProfileIdSet });
    // Only use telnet-specific port and credentials when protocol is explicitly telnet
    // Don't treat telnetEnabled as primary - that's just an optional protocol
    const isTelnet = effective.protocol === "telnet";

    const defaultPort = isTelnet ? 23 : 22;
    const effectivePort = isTelnet ? resolveTelnetPort(effective) : (effective.port ?? 22);

    // Bracket IPv6 addresses when appending non-default port
    let address: string;
    if (effectivePort !== defaultPort) {
      const isIPv6 = effective.hostname.includes(":") && !effective.hostname.startsWith("[");
      const hostname = isIPv6 ? `[${effective.hostname}]` : effective.hostname;
      address = `${hostname}:${effectivePort}`;
    } else {
      address = effective.hostname;
    }

    // Resolve credentials from identity if configured, otherwise use host credentials
    // For telnet hosts, use telnet-specific credentials
    const identity = effective.identityId
      ? identities.find((i) => i.id === effective.identityId)
      : undefined;

    const username = isTelnet
      ? resolveTelnetUsername(effective)
      : (identity?.username?.trim() || effective.username?.trim());

    const rawPassword = isTelnet
      ? resolveTelnetPassword(effective)
      : (identity?.password || effective.password);
    const password = sanitizeCredentialValue(rawPassword);

    if (!password) {
      toast.warning(t('vault.hosts.copyCredentials.toast.noPassword'));
      return;
    }

    const text = `host: ${address}\nusername: ${username ?? ''}\npassword: ${password}`;
    navigator.clipboard.writeText(text).then(() => {
      toast.success(t('vault.hosts.copyCredentials.toast.success'));
    });
  }, [identities, groupConfigs, proxyProfileIdSet, t]);

  const [lastPinnedId, setLastPinnedId] = useState<string | null>(null);
  const toggleHostPinned = useCallback((hostId: string) => {
    const host = hostsRef.current.find((h) => h.id === hostId);
    const isPinning = host && !host.pinned;
    startTransition(() => {
      onUpdateHosts(hostsRef.current.map((h) =>
        h.id === hostId ? { ...h, pinned: !h.pinned } : h
      ));
    });
    setLastPinnedId(isPinning ? hostId : null);
  }, [onUpdateHosts]);

  const toggleHostSelection = useCallback((hostId: string) => {
    setSelectedHostIds(prev => {
      const next = new Set(prev);
      if (next.has(hostId)) {
        next.delete(hostId);
      } else {
        next.add(hostId);
      }
      return next;
    });
  }, []);

  const clearHostSelection = useCallback(() => {
    setSelectedHostIds(new Set());
    setIsMultiSelectMode(false);
  }, []);

  const deleteSelectedHosts = useCallback(() => {
    if (selectedHostIds.size === 0) return;
    const updatedHosts = hosts.filter(h => !selectedHostIds.has(h.id));
    onUpdateHosts(updatedHosts);
    clearHostSelection();
    toast.success(t("vault.hosts.deleteMultiple.success", { count: selectedHostIds.size }));
  }, [selectedHostIds, hosts, onUpdateHosts, clearHostSelection, t]);

  const connectSelectedHosts = useCallback(() => {
    if (selectedHostIds.size === 0) return;
    // Connect each selected host in list order with its default protocol.
    // We call onConnect directly (not handleHostConnect) so multi-protocol hosts
    // connect with their configured protocol instead of opening a per-host dialog.
    const targets = hosts.filter(h => selectedHostIds.has(h.id));
    targets.forEach(host => onConnect(host));
    clearHostSelection();
    toast.success(t("vault.hosts.connectMultiple.success", { count: targets.length }));
  }, [selectedHostIds, hosts, onConnect, clearHostSelection, t]);
  const { handleImportFileSelected } = useVaultImportHandlers({
    customGroups,
    hosts,
    managedSources,
    onUpdateCustomGroups,
    onUpdateHosts,
    onUpdateManagedSources,
    setIsImportOpen,
    t,
  });

  const {
    allGroupPaths,
    allTags,
    displayedGroups,
    displayedHosts,
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
  } = useVaultHostCollections({
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
  });


  const submitNewFolder = () => {
    if (!newFolderName.trim()) return;
    const fullPath = targetParentPath
      ? `${targetParentPath}/${newFolderName.trim()}`
      : newFolderName.trim();
    onUpdateCustomGroups(Array.from(new Set([...customGroups, fullPath])));
    setNewFolderName("");
    setTargetParentPath(null);
    setIsNewFolderOpen(false);
  };

  const submitRenameGroup = () => {
    if (!renameTargetPath) return;

    const nextName = renameGroupName.trim();
    if (!nextName) {
      setRenameGroupError(t("vault.groups.errors.required"));
      return;
    }
    if (nextName.includes("/") || nextName.includes("\\")) {
      setRenameGroupError(t("vault.groups.errors.invalidChars"));
      return;
    }

    const segments = renameTargetPath.split("/").filter(Boolean);
    const parent = segments.slice(0, -1).join("/");
    const nextPath = parent ? `${parent}/${nextName}` : nextName;
    if (nextPath === renameTargetPath) {
      setIsRenameGroupOpen(false);
      return;
    }

    const updatedGroups = customGroups.map((g) => {
      if (g === renameTargetPath) return nextPath;
      if (g.startsWith(renameTargetPath + "/"))
        return nextPath + g.slice(renameTargetPath.length);
      return g;
    });
    const updatedHosts = hosts.map((h) => {
      const g = h.group || "";
      if (g === renameTargetPath) return { ...h, group: nextPath };
      if (g.startsWith(renameTargetPath + "/"))
        return { ...h, group: nextPath + g.slice(renameTargetPath.length) };
      return h;
    });

    // Update managed sources if any match the renamed group path
    const updatedManagedSources = managedSources.map((s) => {
      if (s.groupName === renameTargetPath) return { ...s, groupName: nextPath };
      if (s.groupName.startsWith(renameTargetPath + "/"))
        return { ...s, groupName: nextPath + s.groupName.slice(renameTargetPath.length) };
      return s;
    });
    if (updatedManagedSources.some((s, i) => s !== managedSources[i])) {
      onUpdateManagedSources(updatedManagedSources);
    }

    onUpdateCustomGroups(Array.from(new Set(updatedGroups)));
    onUpdateHosts(updatedHosts);
    if (
      selectedGroupPath &&
      (selectedGroupPath === renameTargetPath ||
        selectedGroupPath.startsWith(renameTargetPath + "/"))
    ) {
      const suffix =
        selectedGroupPath === renameTargetPath
          ? ""
          : selectedGroupPath.slice(renameTargetPath.length);
      setSelectedGroupPath(nextPath + suffix);
    }

    setIsRenameGroupOpen(false);
  };

  const handleEditGroupConfig = useCallback((groupPath: string) => {
    setIsHostPanelOpen(false);
    setEditingHost(null);
    setEditingGroupPath(groupPath);
    setIsGroupPanelOpen(true);
  }, []);

  const handleSaveGroupConfig = useCallback((config: GroupConfig, _newName?: string, _newParent?: string | null) => {
    const oldPath = editingGroupPath!;
    const newPath = config.path; // Panel already computed the correct path

    // Validate no duplicate path on rename/reparent
    if (newPath !== oldPath && customGroups.includes(newPath)) {
      toast.error(t('vault.groups.errors.duplicatePath'));
      return;
    }

    // Save config (use new path)
    const updatedConfigs = [...groupConfigs.filter(c => c.path !== oldPath), config];

    // Handle path change (rename or parent change)
    if (newPath !== oldPath) {
      // Update groups, hosts, managed sources, and configs for path change
      const updatedGroups = customGroups.map((g) => {
        if (g === oldPath) return newPath;
        if (g.startsWith(oldPath + '/')) return newPath + g.slice(oldPath.length);
        return g;
      });
      const updatedHosts = hosts.map((h) => {
        const g = h.group || '';
        if (g === oldPath) return { ...h, group: newPath };
        if (g.startsWith(oldPath + '/')) return { ...h, group: newPath + g.slice(oldPath.length) };
        return h;
      });
      const updatedManagedSources = managedSources.map((s) => {
        if (s.groupName === oldPath) return { ...s, groupName: newPath };
        if (s.groupName.startsWith(oldPath + '/')) return { ...s, groupName: newPath + s.groupName.slice(oldPath.length) };
        return s;
      });
      if (updatedManagedSources.some((s, i) => s !== managedSources[i])) {
        onUpdateManagedSources(updatedManagedSources);
      }
      onUpdateCustomGroups(Array.from(new Set(updatedGroups)));
      onUpdateHosts(updatedHosts);
      // Update child config paths too
      const finalConfigs = updatedConfigs.map(c => {
        if (c.path.startsWith(oldPath + '/')) return { ...c, path: newPath + c.path.slice(oldPath.length) };
        return c;
      });
      onUpdateGroupConfigs(finalConfigs);
      if (selectedGroupPath === oldPath) setSelectedGroupPath(newPath);
      if (selectedGroupPath?.startsWith(oldPath + '/')) {
        setSelectedGroupPath(newPath + selectedGroupPath.slice(oldPath.length));
      }
    } else {
      onUpdateGroupConfigs(updatedConfigs);
    }

    setIsGroupPanelOpen(false);
    setEditingGroupPath(null);
  }, [groupConfigs, editingGroupPath, customGroups, hosts, managedSources, selectedGroupPath, onUpdateGroupConfigs, onUpdateCustomGroups, onUpdateHosts, onUpdateManagedSources, t]);

  const deleteGroupPath = async (path: string, deleteHosts: boolean = false) => {
    const keepGroups = customGroups.filter(
      (g) => !(g === path || g.startsWith(path + "/")),
    );

    // Find all managed sources under the deleted path (exact match or subgroups)
    const sourcesToRemove = managedSources.filter(s =>
      s.groupName === path || s.groupName.startsWith(path + "/")
    );

    // Clear managed blocks in SSH config files before removing sources
    // Use batch removal to avoid race conditions when multiple sources are removed
    if (sourcesToRemove.length > 0 && onClearAndRemoveManagedSources) {
      await onClearAndRemoveManagedSources(sourcesToRemove);
    } else if (sourcesToRemove.length > 0 && onClearAndRemoveManagedSource) {
      // Fallback to single removal (may have race conditions with multiple sources)
      await Promise.all(sourcesToRemove.map(s => onClearAndRemoveManagedSource(s)));
    } else if (sourcesToRemove.length > 0) {
      // Fallback: just remove sources without clearing (if callback not provided)
      const updatedSources = managedSources.filter(s =>
        s.groupName !== path && !s.groupName.startsWith(path + "/")
      );
      onUpdateManagedSources(updatedSources);
    }

    // Check if this is a subgroup under a managed group (that won't be deleted)
    // Use the most specific (deepest) matching managed source
    const parentManagedSource = managedSources
      .filter(s => path.startsWith(s.groupName + "/") && s.groupName !== path)
      .sort((a, b) => b.groupName.length - a.groupName.length)[0];

    let keepHosts: Host[];
    if (deleteHosts) {
      keepHosts = hosts.filter((h) => {
        const g = h.group || "";
        return !(g === path || g.startsWith(path + "/"));
      });
    } else {
      keepHosts = hosts.map((h) => {
        const g = h.group || "";
        if (g === path || g.startsWith(path + "/")) {
          // If deleting a subgroup under a managed group, keep managedSourceId
          // so hosts remain managed and sync to the SSH config
          if (parentManagedSource) {
            return { ...h, group: "" };
          }
          return { ...h, group: "", managedSourceId: undefined };
        }
        return h;
      });
    }

    onUpdateCustomGroups(keepGroups);
    onUpdateHosts(keepHosts);
    // Remove configs for deleted group and its children
    const updatedGroupConfigs = groupConfigs.filter(
      (c) => c.path !== path && !c.path.startsWith(path + '/')
    );
    if (updatedGroupConfigs.length !== groupConfigs.length) {
      onUpdateGroupConfigs(updatedGroupConfigs);
    }
    if (
      selectedGroupPath &&
      (selectedGroupPath === path || selectedGroupPath.startsWith(path + "/"))
    ) {
      setSelectedGroupPath(null);
    }
  };

  const moveGroup = (sourcePath: string, targetParent: string | null) => {
    const name = sourcePath.split("/").filter(Boolean).pop() || "";
    const newPath = targetParent ? `${targetParent}/${name}` : name;
    if (newPath === sourcePath || newPath.startsWith(sourcePath + "/")) return;
    if (customGroups.includes(newPath)) {
      toast.error(t('vault.groups.errors.duplicatePath'));
      return;
    }
    const updatedGroups = customGroups.map((g) => {
      if (g === sourcePath) return newPath;
      if (g.startsWith(sourcePath + "/")) return newPath + g.slice(sourcePath.length);
      return g;
    });
    const updatedHosts = hosts.map((h) => {
      const g = h.group || "";
      if (g === sourcePath) return { ...h, group: newPath };
      if (g.startsWith(sourcePath + "/"))
        return { ...h, group: newPath + g.slice(sourcePath.length) };
      return h;
    });
    // Update managed sources if any match the moved group path
    const updatedManagedSources = managedSources.map((s) => {
      if (s.groupName === sourcePath) return { ...s, groupName: newPath };
      if (s.groupName.startsWith(sourcePath + "/"))
        return { ...s, groupName: newPath + s.groupName.slice(sourcePath.length) };
      return s;
    });
    if (updatedManagedSources.some((s, i) => s !== managedSources[i])) {
      onUpdateManagedSources(updatedManagedSources);
    }
    onUpdateCustomGroups(Array.from(new Set(updatedGroups)));
    onUpdateHosts(updatedHosts);
    // Update group configs for moved paths
    const updatedGroupConfigs = groupConfigs.map((c) => {
      if (c.path === sourcePath) return { ...c, path: newPath };
      if (c.path.startsWith(sourcePath + '/'))
        return { ...c, path: newPath + c.path.slice(sourcePath.length) };
      return c;
    });
    if (updatedGroupConfigs.some((c, i) => c !== groupConfigs[i])) {
      onUpdateGroupConfigs(updatedGroupConfigs);
    }
    if (
      selectedGroupPath &&
      (selectedGroupPath === sourcePath ||
        selectedGroupPath.startsWith(sourcePath + "/"))
    ) {
      setSelectedGroupPath(newPath);
    }
  };
  const {
    getDropTargetClasses,
    handleUnmanageGroup,
    managedGroupPaths,
    moveHostToGroup,
    setDragOverDropTarget,
    setGroupDragOverDropTarget,
  } = useVaultGroupDragHandlers({
    hosts,
    managedSources,
    onUnmanageSource,
    onUpdateHosts,
    onUpdateManagedSources,
    t,
  });


  const isHostsSectionActive = currentSection === "hosts";
  const hasHostsSidePanel =
    isHostsSectionActive &&
    ((isGroupPanelOpen && !!editingGroupPath) || isHostPanelOpen);
  // Fixed N columns (not auto-fit) so populated rows fill the width with no
  // trailing gap AND a section with a single card (e.g. Pinned) keeps it at one
  // column's width instead of stretching it across the whole row — matching the
  // no-panel grid-cols-* behaviour, just measured from the container. The actual
  // column count rides on the --vault-grid-cols custom property (set by the
  // ResizeObserver below); the fallback applies until the first measurement.
  const splitViewGridStyle = hasHostsSidePanel
    ? { gridTemplateColumns: "var(--vault-grid-cols, repeat(2, minmax(0, 1fr)))" }
    : undefined;

  // Track the host-list container width and derive the column count the same way
  // the auto-fit grid did (≈220px min card + 12px gap), but as a fixed count so
  // lone cards don't stretch. We write the whole grid-template-columns value into
  // a CSS variable imperatively (no setState) and only when the count actually
  // changes, so panel transitions / window resizing reflow the grid natively
  // without re-rendering this component.
  useEffect(() => {
    const el = hostListScrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const GAP = 12; // matches gap-3
    const MIN_CARD = 220;
    const PADDING_X = 32; // matches px-4 on both sides
    const recompute = () => {
      const usable = el.clientWidth - PADDING_X;
      if (usable <= 0) return; // hidden / not laid out yet
      const next = Math.max(1, Math.floor((usable + GAP) / (MIN_CARD + GAP)));
      if (next === splitGridColsRef.current) return;
      splitGridColsRef.current = next;
      el.style.setProperty("--vault-grid-cols", `repeat(${next}, minmax(0, 1fr))`);
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <VaultViewLayout ctx={{ Activity, allGroupPaths, allTags, AppLogo, Array, Badge, BookMarked, Boolean, Button, CheckSquare, ChevronDown, clearHostSelection, ClipboardCopy, Clock, cn, connectionLogs, connectSelectedHosts, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Copy, currentSection, customGroups, deleteGroupPath, deleteGroupWithHosts, deleteSelectedHosts, deleteTargetPath, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, displayedGroups, displayedHosts, DistroAvatar, Download, Dropdown, DropdownContent, DropdownTrigger, Edit2, editingGroupPath, editingHost, editingHostGroupDefaults, FileCode, FileSymlink, FolderPlus, FolderTree, getDropTargetClasses, getEffectiveHostDistro, Globe, groupConfigs, GroupDetailsPanel, groupedDisplayHosts, handleConnectClick, handleCopyCredentials, handleDeleteTag, handleDuplicateHost, handleEditGroupConfig, handleEditHost, handleEditTag, handleExportHosts, handleHostConnect, handleImportFileSelected, handleNewHost, handleProtocolSelect, handleQuickConnect, handleQuickConnectSaveHost, handleSaveGroupConfig, handleSearchKeyDown, handleUnmanageGroup, hasHostsSidePanel, HostDetailsPanel, hostListScrollRef, hosts, HostTreeView, hotkeyScheme, identities, ImportVaultDialog, Input, isDeleteGroupOpen, isGroupPanelOpen, isHostPanelOpen, isHostsSectionActive, isImportOpen, isMultiSelectMode, isNewFolderOpen, isQuickConnectOpen, isRenameGroupOpen, isSearchQuickConnect, isSerialModalOpen, Key, keyBindings, KeychainManager, keys, knownHostsManagerElement, Label, lastPinnedId, LayoutGrid, LazyConnectionLogsManager, LazyProtocolSelectDialog, List, managedGroupPaths, managedSources, moveGroup, moveHostToGroup, Network, newFolderName, newHostGroupPath, onClearUnsavedConnectionLogs, onConnectSerial, onCreateLocalTerminal, onDeleteConnectionLog, onDeleteHost, onImportOrReuseKey, onOpenLogView, onOpenSettings, onRunSnippet, onToggleConnectionLogSaved, onUpdateCustomGroups, onUpdateGroupConfigs, onUpdateHosts, onUpdateIdentities, onUpdateKeys, onUpdateProxyProfiles, onUpdateSnippetPackages, onUpdateSnippets, Pin, pinnedHosts, pinnedRecentIds, Plug, Plus, PortForwarding, protocolSelectHost, proxyProfiles, ProxyProfilesManager, quickConnectTarget, quickConnectWarnings, QuickConnectWizard, recentHosts, renameGroupError, renameGroupName, renameTargetPath, RippleButton, rootRef, sanitizeHost, search, Search, selectedGroupPath, selectedHostIds, selectedTags, SerialConnectModal, SerialHostDetailsPanel, sessionCount, Set, setCurrentSection, setDeleteGroupWithHosts, setDeleteTargetPath, setDragOverDropTarget, setEditingGroupPath, setEditingHost, setGroupDragOverDropTarget, setIsDeleteGroupOpen, setIsGroupPanelOpen, setIsHostPanelOpen, setIsImportOpen, setIsMultiSelectMode, setIsNewFolderOpen, setIsQuickConnectOpen, setIsRenameGroupOpen, setIsSerialModalOpen, setLastPinnedId, setNewFolderName, setNewHostGroupPath, setProtocolSelectHost, setQuickConnectTarget, setQuickConnectWarnings, setRenameGroupError, setRenameGroupName, setRenameTargetPath, setSearch, setSelectedGroupPath, setSelectedHostIds, setSelectedTags, setSidebarCollapsed, setSidebarWidth, handleSidebarWidthCommit, setSortMode, setTargetParentPath, Settings, setViewMode, shellHistory, shouldHideEmptyRootHostsSection, showRecentHosts, sidebarCollapsed, sidebarWidth, snippetPackages, snippets, SnippetsManager, SortDropdown, sortMode, splitViewGridStyle, Square, Star, submitNewFolder, submitRenameGroup, Suspense, t, TagFilterDropdown, targetParentPath, terminalFontSize, terminalSettings, TerminalSquare, terminalThemeId, toggleHostPinned, toggleHostSelection, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Trash2, treeExpandedState, treeViewGroupTree, treeViewHosts, Upload, upsertHostById, Usb, viewMode, visibleDisplayedHosts, X, Zap }} />;
};

// Only re-render when data props change - isActive is now managed internally via store subscription
export const vaultViewAreEqual = (
  prev: VaultViewProps,
  next: VaultViewProps,
): boolean => {
  const isEqual =
    prev.hosts === next.hosts &&
    prev.keys === next.keys &&
    prev.identities === next.identities &&
    prev.proxyProfiles === next.proxyProfiles &&
    prev.snippets === next.snippets &&
    prev.snippetPackages === next.snippetPackages &&
    prev.customGroups === next.customGroups &&
    prev.knownHosts === next.knownHosts &&
    prev.shellHistory === next.shellHistory &&
    prev.connectionLogs === next.connectionLogs &&
    prev.sessionCount === next.sessionCount &&
    prev.managedSources === next.managedSources &&
    prev.groupConfigs === next.groupConfigs &&
    prev.terminalThemeId === next.terminalThemeId &&
    prev.terminalFontSize === next.terminalFontSize &&
    prev.navigateToSection === next.navigateToSection &&
    // Only the keepalive fields of terminalSettings are forwarded to
    // PortForwarding inside the vault, so compare them directly. Other
    // terminal settings (fonts, themes, etc.) don't affect this subtree
    // and we don't want to re-render for them.
    prev.terminalSettings?.keepaliveInterval === next.terminalSettings?.keepaliveInterval &&
    prev.terminalSettings?.keepaliveCountMax === next.terminalSettings?.keepaliveCountMax;

  return isEqual;
};

const MemoizedVaultViewInner = memo(VaultViewInner, vaultViewAreEqual);

// Just export the memoized component directly
// Visibility control is handled by parent (App.tsx)
export const VaultView = MemoizedVaultViewInner;
VaultView.displayName = "VaultView";
