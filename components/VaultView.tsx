import {
  Activity,
  BookMarked,
  CheckSquare,
  ChevronDown,
  ClipboardCopy,
  Copy,
  Download,
  Edit2,
  FileCode,
  FileSymlink,
  FolderPlus,
  FolderTree,
  Key,
  LayoutGrid,
  List,
  Network,
  Plug,
  Plus,
  Search,
  Settings,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  Usb,
  X,
  Zap,
} from "lucide-react";
import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useStoredViewMode } from "../application/state/useStoredViewMode";
import { useTreeExpandedState } from "../application/state/useTreeExpandedState";
import { sanitizeHost } from "../domain/host";
import { importVaultHostsFromText, exportHostsToCsvWithStats } from "../domain/vaultImport";
import type { VaultImportFormat } from "../domain/vaultImport";
import { STORAGE_KEY_VAULT_HOSTS_VIEW_MODE, STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED } from "../infrastructure/config/storageKeys";
import { cn } from "../lib/utils";
import {
  ConnectionLog,
  GroupNode,
  Host,
  HostProtocol,
  Identity,
  KnownHost,
  ManagedSource,
  SerialConfig,
  SSHKey,
  ShellHistoryEntry,
  Snippet,
  TerminalSession,
} from "../types";
import { AppLogo } from "./AppLogo";
import { DistroAvatar } from "./DistroAvatar";
import HostDetailsPanel from "./HostDetailsPanel";
import { HostTreeView } from "./HostTreeView";
import KeychainManager from "./KeychainManager";
import KnownHostsManager from "./KnownHostsManager";
import PortForwarding from "./PortForwardingNew";
import QuickConnectWizard from "./QuickConnectWizard";
import { isQuickConnectInput, parseQuickConnectInputWithWarnings } from "../domain/quickConnect";
import SerialConnectModal from "./SerialConnectModal";
import SerialHostDetailsPanel from "./SerialHostDetailsPanel";
import SnippetsManager from "./SnippetsManager";
import { ImportVaultDialog, ImportOptions } from "./vault/ImportVaultDialog";
import { Button } from "./ui/button";
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
import { Badge } from "./ui/badge";
import { HotkeyScheme, KeyBinding } from "../domain/models";

const LazyProtocolSelectDialog = lazy(() => import("./ProtocolSelectDialog"));
const LazyConnectionLogsManager = lazy(() => import("./ConnectionLogsManager"));

export type VaultSection = "hosts" | "keys" | "snippets" | "port" | "knownhosts" | "logs";

// Props without isActive - it's now subscribed internally
interface VaultViewProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  snippetPackages: string[];
  customGroups: string[];
  knownHosts: KnownHost[];
  shellHistory: ShellHistoryEntry[];
  connectionLogs: ConnectionLog[];
  managedSources: ManagedSource[];
  sessions: TerminalSession[];
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  onOpenSettings: () => void;
  onOpenQuickSwitcher: () => void;
  onCreateLocalTerminal: () => void;
  onConnectSerial?: (config: SerialConfig) => void;
  onDeleteHost: (id: string) => void;
  onConnect: (host: Host) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateKeys: (keys: SSHKey[]) => void;
  onUpdateIdentities: (identities: Identity[]) => void;
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
  // Optional: navigate to a specific section on mount or when changed
  navigateToSection?: VaultSection | null;
  onNavigateToSectionHandled?: () => void;
}

const VaultViewInner: React.FC<VaultViewProps> = ({
  hosts,
  keys,
  identities,
  snippets,
  snippetPackages,
  customGroups,
  knownHosts,
  shellHistory,
  connectionLogs,
  managedSources,
  sessions,
  hotkeyScheme,
  keyBindings,
  onOpenSettings,
  onOpenQuickSwitcher,
  onCreateLocalTerminal,
  onConnectSerial,
  onDeleteHost,
  onConnect,
  onUpdateHosts,
  onUpdateKeys,
  onUpdateIdentities,
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
  navigateToSection,
  onNavigateToSectionHandled,
}) => {
  const { t } = useI18n();
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
  const [sortMode, setSortMode] = useState<SortMode>("az");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // Host panel state (local to hosts section)
  const [isHostPanelOpen, setIsHostPanelOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<Host | null>(null);
  const [newHostGroupPath, setNewHostGroupPath] = useState<string | null>(null);

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

  // Check if host has multiple protocols enabled
  const hasMultipleProtocols = useCallback((host: Host) => {
    let count = 0;
    // SSH is always available as base protocol (unless explicitly set to something else)
    if (host.protocol === "ssh" || !host.protocol) count++;
    // Mosh adds another option
    if (host.moshEnabled) count++;
    // Telnet adds another option
    if (host.telnetEnabled) count++;
    // If protocol is explicitly telnet (not ssh), count it
    if (host.protocol === "telnet" && !host.telnetEnabled) count++;
    return count > 1;
  }, []);

  // Handle host connect with protocol selection
  const handleHostConnect = useCallback(
    (host: Host) => {
      if (hasMultipleProtocols(host)) {
        setProtocolSelectHost(host);
      } else {
        onConnect(host);
      }
    },
    [hasMultipleProtocols, onConnect],
  );

  // Handle protocol selection
  const handleProtocolSelect = useCallback(
    (protocol: HostProtocol, port: number) => {
      if (protocolSelectHost) {
        const hostWithProtocol: Host = {
          ...protocolSelectHost,
          protocol: protocol === "mosh" ? "ssh" : protocol,
          port,
          moshEnabled: protocol === "mosh",
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
    setEditingHost(null);
    setNewHostGroupPath(null);
    setIsHostPanelOpen(true);
  }, []);

  const handleEditHost = useCallback((host: Host) => {
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
    // Only use telnet-specific port and credentials when protocol is explicitly telnet
    // Don't treat telnetEnabled as primary - that's just an optional protocol
    const isTelnet = host.protocol === "telnet";

    const defaultPort = isTelnet ? 23 : 22;
    const effectivePort = isTelnet
      ? (host.telnetPort ?? host.port ?? 23)
      : (host.port ?? 22);

    // Bracket IPv6 addresses when appending non-default port
    let address: string;
    if (effectivePort !== defaultPort) {
      const isIPv6 = host.hostname.includes(":") && !host.hostname.startsWith("[");
      const hostname = isIPv6 ? `[${host.hostname}]` : host.hostname;
      address = `${hostname}:${effectivePort}`;
    } else {
      address = host.hostname;
    }

    // Resolve credentials from identity if configured, otherwise use host credentials
    // For telnet hosts, use telnet-specific credentials
    const identity = host.identityId
      ? identities.find((i) => i.id === host.identityId)
      : undefined;

    const username = isTelnet
      ? (host.telnetUsername?.trim() || host.username?.trim())
      : (identity?.username?.trim() || host.username?.trim());

    const password = isTelnet
      ? (host.telnetPassword || host.password)
      : (identity?.password || host.password);

    if (!password) {
      toast.warning(t('vault.hosts.copyCredentials.toast.noPassword'));
      return;
    }

    const text = `host: ${address}\nusername: ${username ?? ''}\npassword: ${password}`;
    navigator.clipboard.writeText(text).then(() => {
      toast.success(t('vault.hosts.copyCredentials.toast.success'));
    });
  }, [identities, t]);

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

  const readTextFile = useCallback(async (file: File): Promise<string> => {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    let encoding: string = "utf-8";
    let offset = 0;

    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = "utf-16le";
      offset = 2;
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = "utf-16be";
      offset = 2;
    } else if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      encoding = "utf-8";
      offset = 3;
    }

    const decoder = new TextDecoder(encoding);
    return decoder.decode(bytes.slice(offset));
  }, []);

  const handleImportFileSelected = useCallback(
    async (format: VaultImportFormat, file: File, options?: ImportOptions) => {
      setIsImportOpen(false);

      try {
        const formatLabel =
          format === "putty"
            ? "PuTTY"
            : format === "mobaxterm"
              ? "MobaXterm"
              : format === "csv"
                ? "CSV"
                : format === "securecrt"
                  ? "SecureCRT"
                  : "ssh_config";

        toast.info(t("vault.import.toast.start", { format: formatLabel }));

        const text = await readTextFile(file);
        const result = importVaultHostsFromText(format, text, {
          fileName: file.name,
        });

        const isManaged = format === "ssh_config" && options?.managed === true;
        const fileBaseName = file.name.replace(/\.[^/.]+$/, "");

        // Generate unique managed group name (check for conflicts with existing sources,
        // custom groups, and host groups to avoid accidentally merging unrelated hosts)
        let managedGroupName = `${fileBaseName} - Managed`;
        if (isManaged) {
          const existingGroupNames = new Set([
            ...managedSources.map(s => s.groupName),
            ...customGroups,
            ...hosts.map(h => h.group).filter((g): g is string => !!g),
          ]);
          let suffix = 1;
          while (existingGroupNames.has(managedGroupName)) {
            managedGroupName = `${fileBaseName} - Managed (${suffix})`;
            suffix++;
          }
        }

        // Check if this file is already managed
        const bridge = (window as unknown as { netcatty?: { getPathForFile?: (file: File) => string | undefined } }).netcatty;
        // Try bridge.getPathForFile first, then fall back to file.path (Electron legacy)
        const filePath = bridge?.getPathForFile?.(file) || (file as File & { path?: string }).path;

        if (isManaged && !filePath) {
          // Cannot proceed with managed import without a valid file path
          toast({
            title: t("vault.import.sshConfig.noFilePath"),
            description: t("vault.import.sshConfig.noFilePathDesc"),
            variant: "destructive",
          });
          return;
        }

        if (isManaged) {
          const existingSource = managedSources.find(s => s.filePath === filePath);
          if (existingSource) {
            toast({
              title: t("vault.import.sshConfig.alreadyManaged"),
              description: t("vault.import.sshConfig.alreadyManagedDesc", { group: existingSource.groupName }),
              variant: "destructive",
            });
            return;
          }
        }

        const makeKey = (h: Host) =>
          `${(h.protocol ?? "ssh").toLowerCase()}|${h.hostname.toLowerCase()}|${h.port}|${(h.username ?? "").toLowerCase()}`;

        const existingKeys = new Set(hosts.map(makeKey));
        // Filter out duplicates for both managed and non-managed imports
        let newHosts = result.hosts.filter((h) => !existingKeys.has(makeKey(h)));

        // For managed imports, also update existing hosts to be managed
        let updatedExistingHosts: Host[] = [];
        if (isManaged) {
          const importedKeys = new Set(result.hosts.map(makeKey));
          updatedExistingHosts = hosts.filter((h) => importedKeys.has(makeKey(h)));
        }

        if (isManaged && (newHosts.length > 0 || updatedExistingHosts.length > 0)) {
          const sourceId = crypto.randomUUID();
          console.log('[Import] File path resolved:', filePath);
          const newSource: ManagedSource = {
            id: sourceId,
            type: "ssh_config",
            filePath: filePath,
            groupName: managedGroupName,
            lastSyncedAt: Date.now(),
          };

          newHosts = newHosts.map((h) => ({
            ...h,
            group: managedGroupName,
            // Only SSH hosts can be managed (SSH config only supports SSH)
            managedSourceId: (!h.protocol || h.protocol === "ssh") ? sourceId : undefined,
          }));

          // Update existing hosts to be managed (move to managed group)
          const existingHostIds = new Set(updatedExistingHosts.map(h => h.id));
          const updatedHosts = hosts.map((h) => {
            if (!existingHostIds.has(h.id)) return h;
            const canBeManaged = !h.protocol || h.protocol === "ssh";
            return {
              ...h,
              group: managedGroupName,
              managedSourceId: canBeManaged ? sourceId : undefined,
              // Sanitize label for managed hosts
              label: canBeManaged && h.label ? h.label.replace(/\s/g, '') : h.label,
            };
          });

          onUpdateManagedSources([...managedSources, newSource]);
          onUpdateHosts([...updatedHosts, ...newHosts].map(sanitizeHost));

          const nextGroups = Array.from(
            new Set([
              ...customGroups,
              ...result.groups,
              managedGroupName,
              ...newHosts.map((h) => h.group).filter(Boolean),
            ]),
          ) as string[];
          onUpdateCustomGroups(nextGroups);
        } else if (newHosts.length > 0) {
          onUpdateHosts([...hosts, ...newHosts].map(sanitizeHost));

          const nextGroups = Array.from(
            new Set([
              ...customGroups,
              ...result.groups,
              ...newHosts.map((h) => h.group).filter(Boolean),
            ]),
          ) as string[];
          onUpdateCustomGroups(nextGroups);
        }

        // Count total hosts affected (new + converted to managed)
        const totalAffected = newHosts.length + (isManaged ? updatedExistingHosts.length : 0);

        const skipped = result.stats.skipped;
        const duplicates = result.stats.duplicates;
        const hasWarnings = skipped > 0 || duplicates > 0 || result.issues.length > 0;

        if (result.stats.parsed === 0 && totalAffected === 0) {
          toast.error(
            t("vault.import.toast.noEntries", { format: formatLabel }),
            t("vault.import.toast.failedTitle"),
          );
          return;
        }

        if (totalAffected === 0) {
          toast.warning(
            t("vault.import.toast.noNewHosts", { format: formatLabel }),
            t("vault.import.toast.completedTitle"),
          );
          return;
        }

        if (isManaged) {
          toast.success(
            t("vault.import.sshConfig.managedSuccess", { count: totalAffected }),
            t("vault.import.toast.completedTitle"),
          );
        } else {
          const details = t("vault.import.toast.summary", {
            count: totalAffected,
            skipped,
            duplicates,
          });

          if (hasWarnings) {
            const firstIssue = result.issues[0]?.message;
            toast.warning(
              firstIssue ? `${details} ${t("vault.import.toast.firstIssue", { issue: firstIssue })}` : details,
              t("vault.import.toast.completedTitle"),
            );
          } else {
            toast.success(details, t("vault.import.toast.completedTitle"));
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("common.unknownError");
        toast.error(message, t("vault.import.toast.failedTitle"));
      }
    },
    [
      customGroups,
      hosts,
      managedSources,
      onUpdateCustomGroups,
      onUpdateHosts,
      onUpdateManagedSources,
      readTextFile,
      t,
    ],
  );

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
    return root;
  }, [hosts, customGroups]);


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
    }
    if (search.trim()) {
      const s = search.toLowerCase();
      filtered = filtered.filter(
        (h) =>
          h.label.toLowerCase().includes(s) ||
          h.hostname.toLowerCase().includes(s) ||
          h.tags.some((t) => t.toLowerCase().includes(s)),
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
  }, [hosts, selectedGroupPath, search, selectedTags, sortMode]);

  // For tree view: apply search, tag filter, and sorting, but not group filtering
  const treeViewHosts = useMemo(() => {
    let filtered = hosts;
    if (search.trim()) {
      const s = search.toLowerCase();
      filtered = filtered.filter(
        (h) =>
          h.label.toLowerCase().includes(s) ||
          h.hostname.toLowerCase().includes(s) ||
          h.tags.some((t) => t.toLowerCase().includes(s)),
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
    return root;
  }, [treeViewHosts, customGroups]);

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
    onUpdateKnownHostsRef.current([...knownHostsRef.current, kh]);
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
    const updatedGroups = customGroups.map((g) => {
      if (g === sourcePath) return newPath;
      if (g.startsWith(sourcePath + "/")) return g.replace(sourcePath, newPath);
      return g;
    });
    const updatedHosts = hosts.map((h) => {
      const g = h.group || "";
      if (g === sourcePath) return { ...h, group: newPath };
      if (g.startsWith(sourcePath + "/"))
        return { ...h, group: g.replace(sourcePath, newPath) };
      return h;
    });
    // Update managed sources if any match the moved group path
    const updatedManagedSources = managedSources.map((s) => {
      if (s.groupName === sourcePath) return { ...s, groupName: newPath };
      if (s.groupName.startsWith(sourcePath + "/"))
        return { ...s, groupName: s.groupName.replace(sourcePath, newPath) };
      return s;
    });
    if (updatedManagedSources.some((s, i) => s !== managedSources[i])) {
      onUpdateManagedSources(updatedManagedSources);
    }
    onUpdateCustomGroups(Array.from(new Set(updatedGroups)));
    onUpdateHosts(updatedHosts);
    if (
      selectedGroupPath &&
      (selectedGroupPath === sourcePath ||
        selectedGroupPath.startsWith(sourcePath + "/"))
    ) {
      setSelectedGroupPath(newPath);
    }
  };

  const managedGroupPaths = useMemo(() => {
    return new Set(managedSources.map(s => s.groupName));
  }, [managedSources]);

  const moveHostToGroup = (hostId: string, groupPath: string | null) => {
    const targetGroup = groupPath || "";
    // Find the most specific (deepest) managed source that matches the target group
    const targetManagedSource = managedSources
      .filter(s => targetGroup === s.groupName || targetGroup.startsWith(s.groupName + "/"))
      .sort((a, b) => b.groupName.length - a.groupName.length)[0];

    onUpdateHosts(
      hosts.map((h) => {
        if (h.id !== hostId) return h;

        // Only SSH hosts can be managed (SSH config only supports SSH)
        const canBeManaged = !h.protocol || h.protocol === "ssh";

        // Sanitize label if moving to a managed group (SSH config requires no spaces in Host alias)
        let label = h.label;
        if (targetManagedSource && canBeManaged && label) {
          label = label.replace(/\s/g, '');
        }

        return {
          ...h,
          label,
          group: targetGroup,
          managedSourceId: (targetManagedSource && canBeManaged) ? targetManagedSource.id : undefined,
        };
      }),
    );
  };

  const handleUnmanageGroup = useCallback((groupPath: string) => {
    const source = managedSources.find(s => s.groupName === groupPath);
    if (!source) return;

    // Clear managedSourceId from hosts first
    const updatedHosts = hosts.map(h =>
      h.managedSourceId === source.id
        ? { ...h, managedSourceId: undefined }
        : h
    );
    onUpdateHosts(updatedHosts);

    // Remove the source association without modifying the SSH config file
    // This preserves the user's file contents while stopping sync
    if (onUnmanageSource) {
      onUnmanageSource(source.id);
    } else {
      // Fallback if onUnmanageSource not available
      const updatedSources = managedSources.filter(s => s.id !== source.id);
      onUpdateManagedSources(updatedSources);
    }

    toast.success(t("vault.managedSource.unmanageSuccess"));
  }, [managedSources, hosts, onUpdateHosts, onUpdateManagedSources, onUnmanageSource, t]);

  // Component no longer handles visibility - that's done by VaultViewWrapper
  return (
    <div className="absolute inset-0 min-h-0 flex">
      {/* Sidebar */}
      <div className="w-52 bg-secondary/80 border-r border-border/60 flex flex-col">
        <div className="px-4 py-4 flex items-center gap-3">
          <AppLogo className="h-10 w-10 rounded-xl" />
          <div>
            <p className="text-sm font-bold text-foreground">Netcatty</p>
          </div>
        </div>

        <div className="px-3 space-y-1">
          <Button
            variant={currentSection === "hosts" ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-10",
              currentSection === "hosts" &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
            )}
            onClick={() => {
              setCurrentSection("hosts");
              setSelectedGroupPath(null);
            }}
          >
            <LayoutGrid size={16} /> {t("vault.nav.hosts")}
          </Button>
          <Button
            variant={currentSection === "keys" ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-10",
              currentSection === "keys" &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
            )}
            onClick={() => {
              setCurrentSection("keys");
            }}
          >
            <Key size={16} /> {t("vault.nav.keychain")}
          </Button>
          <Button
            variant={currentSection === "port" ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-10",
              currentSection === "port" &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
            )}
            onClick={() => setCurrentSection("port")}
          >
            <Plug size={16} /> {t("vault.nav.portForwarding")}
          </Button>
          <Button
            variant={currentSection === "snippets" ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-10",
              currentSection === "snippets" &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
            )}
            onClick={() => {
              setCurrentSection("snippets");
            }}
          >
            <FileCode size={16} /> {t("vault.nav.snippets")}
          </Button>
          <Button
            variant={currentSection === "knownhosts" ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-10",
              currentSection === "knownhosts" &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
            )}
            onClick={() => setCurrentSection("knownhosts")}
          >
            <BookMarked size={16} /> {t("vault.nav.knownHosts")}
          </Button>
          <Button
            variant={currentSection === "logs" ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-10",
              currentSection === "logs" &&
              "bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40",
            )}
            onClick={() => setCurrentSection("logs")}
          >
            <Activity size={16} /> {t("vault.nav.logs")}
          </Button>
        </div>

        <div className="mt-auto px-3 pb-4 space-y-2">
          <Button
            variant="ghost"
            className="w-full justify-start gap-3"
            onClick={onOpenSettings}
          >
            <Settings size={16} /> {t("common.settings")}
          </Button>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        {currentSection === "hosts" && (
          <header className="border-b border-border/50 bg-secondary/80 backdrop-blur app-drag">
            <div className="h-14 px-4 py-2 flex items-center gap-3">
              <div className="relative flex-1 app-no-drag">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  placeholder={t("vault.hosts.search.placeholder")}
                  className={cn(
                    "pl-9 h-10 bg-secondary border-border/60 text-sm",
                    isSearchQuickConnect &&
                    "border-primary/50 ring-1 ring-primary/20",
                  )}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                />
                {isSearchQuickConnect && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Zap size={14} className="text-primary" />
                  </div>
                )}
              </div>
              <Button
                variant={isSearchQuickConnect ? "default" : "secondary"}
                className={cn(
                  "h-10 px-4 app-no-drag",
                  !isSearchQuickConnect &&
                  currentSection === "hosts" &&
                  "bg-foreground/5 text-foreground hover:bg-foreground/10 border-border/40",
                )}
                onClick={handleConnectClick}
              >
                {t("vault.hosts.connect")}
              </Button>
              {/* View mode, tag filter, and sort controls */}
              <div className="flex items-center gap-1 app-no-drag">
                <Dropdown>
                  <DropdownTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-10 w-10 app-no-drag">
                      {viewMode === "grid" ? (
                        <LayoutGrid size={16} />
                      ) : viewMode === "list" ? (
                        <List size={16} />
                      ) : (
                        <Network size={16} />
                      )}
                      <ChevronDown size={10} className="ml-0.5" />
                    </Button>
                  </DropdownTrigger>
                  <DropdownContent className="w-32" align="end">
                    <Button
                      variant={viewMode === "grid" ? "secondary" : "ghost"}
                      className="w-full justify-start gap-2 h-9"
                      onClick={() => setViewMode("grid")}
                    >
                      <LayoutGrid size={14} /> {t("vault.view.grid")}
                    </Button>
                    <Button
                      variant={viewMode === "list" ? "secondary" : "ghost"}
                      className="w-full justify-start gap-2 h-9"
                      onClick={() => setViewMode("list")}
                    >
                      <List size={14} /> {t("vault.view.list")}
                    </Button>
                    <Button
                      variant={viewMode === "tree" ? "secondary" : "ghost"}
                      className="w-full justify-start gap-2 h-9"
                      onClick={() => setViewMode("tree")}
                    >
                      <Network size={14} /> {t("vault.view.tree")}
                    </Button>
                  </DropdownContent>
                </Dropdown>
                <TagFilterDropdown
                  allTags={allTags}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                  onEditTag={handleEditTag}
                  onDeleteTag={handleDeleteTag}
                  className="h-10 w-10"
                />
                <SortDropdown
                  value={sortMode}
                  onChange={setSortMode}
                  className="h-10 w-10"
                />
                <Button
                  variant={isMultiSelectMode ? "secondary" : "ghost"}
                  size="icon"
                  className="h-10 w-10"
                  onClick={() => {
                    if (isMultiSelectMode) {
                      clearHostSelection();
                    } else {
                      setIsMultiSelectMode(true);
                    }
                  }}
                  title={t("vault.hosts.multiSelect")}
                >
                  <CheckSquare size={16} />
                </Button>
              </div>
              {/* New Host split button */}
              <div className="flex items-center app-no-drag">
                <Dropdown>
                  <div className="flex items-center rounded-md bg-primary text-primary-foreground">
                    <Button
                      size="sm"
                      className="h-10 px-3 rounded-r-none bg-transparent hover:bg-white/10 shadow-none app-no-drag"
                      onClick={handleNewHost}
                    >
                      <Plus size={14} className="mr-2" /> {t("vault.hosts.newHost")}
                    </Button>
                    <DropdownTrigger asChild>
                      <Button
                        size="sm"
                        className="h-10 px-2 rounded-l-none bg-transparent hover:bg-white/10 border-l border-primary-foreground/20 shadow-none app-no-drag"
                      >
                        <ChevronDown size={14} />
                      </Button>
                    </DropdownTrigger>
                  </div>
                  <DropdownContent className="w-44" align="end" alignToParent>
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-2"
                      onClick={() => {
                        setTargetParentPath(selectedGroupPath);
                        setNewFolderName("");
                        setIsNewFolderOpen(true);
                      }}
                    >
                      <FolderTree size={14} /> {t("vault.hosts.newGroup")}
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-2"
                      onClick={() => {
                        setIsImportOpen(true);
                      }}
                    >
                      <Upload size={14} /> {t("vault.hosts.import")}
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-2"
                      onClick={handleExportHosts}
                    >
                      <Download size={14} /> {t("vault.hosts.export")}
                    </Button>
                  </DropdownContent>
                </Dropdown>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className={cn(
                  "h-10 px-3 app-no-drag",
                  currentSection === "hosts" &&
                  "bg-foreground/5 text-foreground hover:bg-foreground/10 border-border/40",
                )}
                onClick={onCreateLocalTerminal}
              >
                <TerminalSquare size={14} className="mr-2" /> {t("common.terminal")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className={cn(
                  "h-10 px-3 app-no-drag",
                  currentSection === "hosts" &&
                  "bg-foreground/5 text-foreground hover:bg-foreground/10 border-border/40",
                )}
                onClick={() => setIsSerialModalOpen(true)}
              >
                <Usb size={14} className="mr-2" /> {t("serial.button")}
              </Button>
            </div>
          </header>
        )}

        {currentSection !== "port" &&
          currentSection !== "keys" &&
          currentSection !== "knownhosts" &&
          currentSection !== "snippets" &&
          currentSection !== "logs" && (
            <div className="flex-1 overflow-auto px-4 py-4 space-y-6">
              {currentSection === "hosts" && (
                <>
                  <section className="space-y-2">
                    {viewMode !== "tree" && (
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <button
                          className="text-primary hover:underline"
                          onClick={() => setSelectedGroupPath(null)}
                        >
                          {t("vault.hosts.allHosts")}
                        </button>
                        {selectedGroupPath &&
                          selectedGroupPath
                            .split("/")
                            .filter(Boolean)
                            .map((part, idx, arr) => {
                              const crumbPath = arr.slice(0, idx + 1).join("/");
                              const isLast = idx === arr.length - 1;
                              return (
                                <span
                                  key={crumbPath}
                                  className="flex items-center gap-2"
                                >
                                  <span className="text-muted-foreground">›</span>
                                  <button
                                    className={cn(
                                      isLast
                                        ? "text-foreground font-semibold"
                                        : "text-primary hover:underline",
                                    )}
                                    onClick={() =>
                                      setSelectedGroupPath(crumbPath)
                                    }
                                  >
                                    {part}
                                  </button>
                                </span>
                              );
                            })}
                      </div>
                    )}
                    {viewMode !== "tree" && displayedGroups.length > 0 && (
                      <>
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-muted-foreground">
                            {t("vault.groups.title")}
                          </h3>
                          <div className="text-xs text-muted-foreground">
                            {t("vault.groups.total", { count: displayedGroups.length })}
                          </div>
                        </div>
                      </>
                    )}
                    {viewMode !== "tree" && (
                      <div
                        className={cn(
                          displayedGroups.length === 0 ? "hidden" : "",
                          viewMode === "grid"
                            ? "grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                            : "flex flex-col gap-0",
                        )}
                        onDragOver={(e) => {
                          e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const hostId = e.dataTransfer.getData("host-id");
                          const groupPath = e.dataTransfer.getData("group-path");
                          if (hostId) moveHostToGroup(hostId, selectedGroupPath);
                          if (groupPath && selectedGroupPath !== null)
                            moveGroup(groupPath, selectedGroupPath);
                        }}
                      >
                      {displayedGroups.map((node) => (
                        <ContextMenu key={node.path}>
                          <ContextMenuTrigger asChild>
                            <div
                              className={cn(
                                "group cursor-pointer",
                                viewMode === "grid"
                                  ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                  : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                              )}
                              draggable
                              onDragStart={(e) =>
                                e.dataTransfer.setData("group-path", node.path)
                              }
                              onDoubleClick={() =>
                                setSelectedGroupPath(node.path)
                              }
                              onClick={() => setSelectedGroupPath(node.path)}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const hostId =
                                  e.dataTransfer.getData("host-id");
                                const groupPath =
                                  e.dataTransfer.getData("group-path");
                                if (hostId) moveHostToGroup(hostId, node.path);
                                if (groupPath) moveGroup(groupPath, node.path);
                              }}
                            >
                              <div className="flex items-center gap-3 h-full">
                                <div className="h-11 w-11 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
                                  <FolderTree size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-semibold truncate flex items-center gap-2">
                                    {node.name}
                                    {managedGroupPaths.has(node.path) && (
                                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/15 text-primary shrink-0">
                                        <FileSymlink size={10} />
                                        Managed
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {t("vault.groups.hostsCount", { count: node.hosts.length })}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onClick={() => {
                                setTargetParentPath(node.path);
                                setNewFolderName("");
                                setIsNewFolderOpen(true);
                              }}
                            >
                              <FolderPlus className="mr-2 h-4 w-4" /> {t("vault.groups.newSubgroup")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => {
                                setRenameTargetPath(node.path);
                                setRenameGroupName(node.name);
                                setRenameGroupError(null);
                                setIsRenameGroupOpen(true);
                              }}
                            >
                              <Edit2 className="mr-2 h-4 w-4" /> {t("vault.groups.rename")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              className="text-destructive"
                              onClick={() => {
                                setDeleteTargetPath(node.path);
                                setIsDeleteGroupOpen(true);
                              }}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> {t("vault.groups.delete")}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ))}
                    </div>
                    )}
                  </section>

                  <section className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        {t("vault.nav.hosts")}
                      </h3>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {t("vault.hosts.header.entries", { count: viewMode === "tree" ? treeViewHosts.length : displayedHosts.length })}
                        </span>
                        <div className="bg-secondary/80 border border-border/70 rounded-md px-2 py-1 text-[11px]">
                          {t("vault.hosts.header.live", { count: sessions.length })}
                        </div>
                      </div>
                    </div>
                    
                    {isMultiSelectMode && (
                      <div className="flex items-center gap-2 p-2 bg-secondary/60 rounded-lg border border-border/40">
                        <span className="text-sm text-muted-foreground">
                          {t("vault.hosts.selected", { count: selectedHostIds.size })}
                        </span>
                        <div className="flex-1" />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const allIds = new Set(displayedHosts.map(h => h.id));
                            setSelectedHostIds(allIds);
                          }}
                        >
                          {t("vault.hosts.selectAll")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={clearHostSelection}
                        >
                          {t("vault.hosts.deselectAll")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={selectedHostIds.size === 0}
                          onClick={deleteSelectedHosts}
                        >
                          <Trash2 size={14} className="mr-1" />
                          {t("vault.hosts.deleteSelected", { count: selectedHostIds.size })}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={clearHostSelection}
                        >
                          <X size={14} />
                        </Button>
                      </div>
                    )}
                    
                    {viewMode === "tree" ? (
                      <HostTreeView
                        groupTree={treeViewGroupTree}
                        hosts={treeViewHosts} // Use filtered and sorted hosts for tree view
                        sortMode={sortMode}
                        expandedPaths={treeExpandedState.expandedPaths}
                        onTogglePath={treeExpandedState.togglePath}
                        onExpandAll={treeExpandedState.expandAll}
                        onCollapseAll={treeExpandedState.collapseAll}
                        onConnect={handleHostConnect}
                        onEditHost={handleEditHost}
                        onDuplicateHost={handleDuplicateHost}
                        onDeleteHost={(host) => onDeleteHost(host.id)}
                        onCopyCredentials={handleCopyCredentials}
                        onNewHost={(groupPath) => {
                          setEditingHost(null);
                          setNewHostGroupPath(groupPath || null);
                          setIsHostPanelOpen(true);
                        }}
                        onNewGroup={(parentPath) => {
                          setTargetParentPath(parentPath || null);
                          setNewFolderName("");
                          setIsNewFolderOpen(true);
                        }}
                        onEditGroup={(groupPath) => {
                          setRenameTargetPath(groupPath);
                          const groupName = groupPath.split('/').pop() || '';
                          setRenameGroupName(groupName);
                          setRenameGroupError(null);
                          setIsRenameGroupOpen(true);
                        }}
                        onDeleteGroup={(groupPath) => {
                          setDeleteTargetPath(groupPath);
                          setIsDeleteGroupOpen(true);
                        }}
                        moveHostToGroup={moveHostToGroup}
                        moveGroup={moveGroup}
                        managedGroupPaths={managedGroupPaths}
                        onUnmanageGroup={handleUnmanageGroup}
                      />
                    ) : sortMode === "group" && groupedDisplayHosts ? (
                      <div className="space-y-6">
                        {groupedDisplayHosts.map((group) => (
                          <div key={group.name || "__ungrouped__"}>
                            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/40">
                              <FolderTree size={14} className="text-muted-foreground" />
                              <span className="text-sm font-medium text-muted-foreground">
                                {group.name || t("vault.groups.ungrouped")}
                              </span>
                              <span className="text-xs text-muted-foreground/60">
                                ({group.hosts.length})
                              </span>
                            </div>
                            <div
                              className={cn(
                                viewMode === "grid"
                                  ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                                  : "flex flex-col gap-0",
                              )}
                            >
                              {group.hosts.map((host) => {
                                const safeHost = sanitizeHost(host);
                                const distroBadge = {
                                  text: (safeHost.os || "L")[0].toUpperCase(),
                                  label: safeHost.distro || safeHost.os || "Linux",
                                };
                                return (
                                  <ContextMenu key={host.id}>
                                    <ContextMenuTrigger>
                                      <div
                                        className={cn(
                                          "group cursor-pointer",
                                          viewMode === "grid"
                                            ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                            : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                                        )}
                                        draggable
                                        onDragStart={(e) => {
                                          e.dataTransfer.effectAllowed = "move";
                                          e.dataTransfer.setData("host-id", host.id);
                                        }}
                                        onClick={() => {
                                          if (isMultiSelectMode) {
                                            toggleHostSelection(host.id);
                                          } else {
                                            handleHostConnect(safeHost);
                                          }
                                        }}
                                      >
                                        <div className="flex items-center gap-3 h-full">
                                          {isMultiSelectMode && (
                                            <div 
                                              className="shrink-0"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleHostSelection(host.id);
                                              }}
                                            >
                                              {selectedHostIds.has(host.id) ? (
                                                <CheckSquare size={18} className="text-primary" />
                                              ) : (
                                                <Square size={18} className="text-muted-foreground" />
                                              )}
                                            </div>
                                          )}
                                          <DistroAvatar
                                            host={safeHost}
                                            fallback={distroBadge.text}
                                          />
                                          <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                            <div className="flex items-center gap-1.5">
                                              <span className="text-sm font-semibold truncate leading-5">
                                                {safeHost.label}
                                              </span>
                                              {safeHost.managedSourceId && (
                                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                                  managed
                                                </Badge>
                                              )}
                                            </div>
                                            <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                              {safeHost.username}@{safeHost.hostname}
                                            </div>
                                          </div>
                                          {viewMode === "list" && (
                                            <>
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleEditHost(host);
                                                }}
                                              >
                                                <Edit2 size={14} />
                                              </Button>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                      <ContextMenuItem
                                        onClick={() => handleHostConnect(host)}
                                      >
                                        <Plug className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        onClick={() => handleEditHost(host)}
                                      >
                                        <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        onClick={() => handleDuplicateHost(host)}
                                      >
                                        <Copy className="mr-2 h-4 w-4" /> {t('action.duplicate')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        onClick={() => handleCopyCredentials(host)}
                                      >
                                        <ClipboardCopy className="mr-2 h-4 w-4" /> {t('vault.hosts.copyCredentials')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        className="text-destructive"
                                        onClick={() => onDeleteHost(host.id)}
                                      >
                                        <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
                                      </ContextMenuItem>
                                    </ContextMenuContent>
                                  </ContextMenu>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                        {groupedDisplayHosts.length === 0 && (
                          <div className="col-span-full flex flex-col items-center justify-center py-24 text-muted-foreground">
                            <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                              <LayoutGrid size={32} className="opacity-60" />
                            </div>
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                              Set up your hosts
                            </h3>
                            <p className="text-sm text-center max-w-sm">
                              Save hosts to quickly connect to your servers, VMs,
                              and containers.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        className={cn(
                          viewMode === "grid"
                            ? "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                            : "flex flex-col gap-0",
                        )}
                      >
                        {displayedHosts.map((host) => {
                          const safeHost = sanitizeHost(host);
                          const distroBadge = {
                            text: (safeHost.os || "L")[0].toUpperCase(),
                            label: safeHost.distro || safeHost.os || "Linux",
                          };
                          return (
                            <ContextMenu key={host.id}>
                              <ContextMenuTrigger>
                                <div
                                  className={cn(
                                    "group cursor-pointer",
                                    viewMode === "grid"
                                      ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                      : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                                  )}
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = "move";
                                    e.dataTransfer.setData("host-id", host.id);
                                  }}
                                  onClick={() => {
                                    if (isMultiSelectMode) {
                                      toggleHostSelection(host.id);
                                    } else {
                                      handleHostConnect(safeHost);
                                    }
                                  }}
                                >
                                  <div className="flex items-center gap-3 h-full">
                                    {isMultiSelectMode && (
                                      <div 
                                        className="shrink-0"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleHostSelection(host.id);
                                        }}
                                      >
                                        {selectedHostIds.has(host.id) ? (
                                          <CheckSquare size={18} className="text-primary" />
                                        ) : (
                                          <Square size={18} className="text-muted-foreground" />
                                        )}
                                      </div>
                                    )}
                                    <DistroAvatar
                                      host={safeHost}
                                      fallback={distroBadge.text}
                                    />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-sm font-semibold truncate leading-5">
                                          {safeHost.label}
                                        </span>
                                        {safeHost.managedSourceId && (
                                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                            managed
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                        {safeHost.username}@{safeHost.hostname}
                                      </div>
                                    </div>
                                    {viewMode === "list" && (
                                      <>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleEditHost(host);
                                          }}
                                        >
                                          <Edit2 size={14} />
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  onClick={() => handleHostConnect(host)}
                                >
                                  <Plug className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() => handleEditHost(host)}
                                >
                                  <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() => handleDuplicateHost(host)}
                                >
                                  <Copy className="mr-2 h-4 w-4" /> {t('action.duplicate')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() => handleCopyCredentials(host)}
                                >
                                  <ClipboardCopy className="mr-2 h-4 w-4" /> {t('vault.hosts.copyCredentials')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  className="text-destructive"
                                  onClick={() => onDeleteHost(host.id)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          );
                        })}
                        {displayedHosts.length === 0 && (
                          <div className="col-span-full flex flex-col items-center justify-center py-24 text-muted-foreground">
                            <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                              <LayoutGrid size={32} className="opacity-60" />
                            </div>
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                              Set up your hosts
                            </h3>
                            <p className="text-sm text-center max-w-sm">
                              Save hosts to quickly connect to your servers, VMs,
                              and containers.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

        {currentSection === "snippets" && (
          <SnippetsManager
            snippets={snippets}
            packages={snippetPackages}
            hosts={hosts}
            customGroups={customGroups}
            shellHistory={shellHistory}
            hotkeyScheme={hotkeyScheme}
            keyBindings={keyBindings}
            onPackagesChange={onUpdateSnippetPackages}
            onSave={(s) =>
              onUpdateSnippets(
                snippets.find((ex) => ex.id === s.id)
                  ? snippets.map((ex) => (ex.id === s.id ? s : ex))
                  : [...snippets, s],
              )
            }
            onDelete={(id) =>
              onUpdateSnippets(snippets.filter((s) => s.id !== id))
            }
            onRunSnippet={onRunSnippet}
            availableKeys={keys}
            managedSources={managedSources}
            onSaveHost={(host) => onUpdateHosts([...hosts, host])}
            onCreateGroup={(groupPath) =>
              onUpdateCustomGroups(
                Array.from(new Set([...customGroups, groupPath])),
              )
            }
          />
        )}
        {currentSection === "keys" && (
          <KeychainManager
            keys={keys}
            identities={identities}
            hosts={hosts}
            customGroups={customGroups}
            managedSources={managedSources}
            onSave={(k) => onUpdateKeys([...keys, k])}
            onUpdate={(k) =>
              onUpdateKeys(
                keys.map((existing) => (existing.id === k.id ? k : existing)),
              )
            }
            onDelete={(id) => onUpdateKeys(keys.filter((k) => k.id !== id))}
            onSaveIdentity={(identity) =>
              onUpdateIdentities(
                identities.find((ex) => ex.id === identity.id)
                  ? identities.map((ex) =>
                    ex.id === identity.id ? identity : ex,
                  )
                  : [...identities, identity],
              )
            }
            onDeleteIdentity={(id) =>
              onUpdateIdentities(identities.filter((i) => i.id !== id))
            }
            onSaveHost={(host) => {
              // Update existing host or add new one
              const existingIndex = hosts.findIndex((h) => h.id === host.id);
              if (existingIndex >= 0) {
                onUpdateHosts(hosts.map((h) => (h.id === host.id ? host : h)));
              } else {
                onUpdateHosts([...hosts, host]);
              }
            }}
            onCreateGroup={(groupPath) =>
              onUpdateCustomGroups(
                Array.from(new Set([...customGroups, groupPath])),
              )
            }
          />
        )}
        {currentSection === "port" && (
          <PortForwarding
            hosts={hosts}
            keys={keys}
            identities={identities}
            customGroups={customGroups}
            managedSources={managedSources}
            onSaveHost={(host) => onUpdateHosts([...hosts, host])}
            onCreateGroup={(groupPath) =>
              onUpdateCustomGroups(
                Array.from(new Set([...customGroups, groupPath])),
              )
            }
          />
        )}
        {/* Always render KnownHostsManager but hide with CSS to prevent unmounting */}
        <div
          style={{
            display: currentSection === "knownhosts" ? "contents" : "none",
          }}
        >
          {knownHostsManagerElement}
        </div>
        {/* Connection Logs */}
        {currentSection === "logs" && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>}>
            <LazyConnectionLogsManager
              logs={connectionLogs}
              hosts={hosts}
              onToggleSaved={onToggleConnectionLogSaved}
              onDelete={onDeleteConnectionLog}
              onClearUnsaved={onClearUnsavedConnectionLogs}
              onOpenLogView={onOpenLogView}
            />
          </Suspense>
        )}
      </div>

      {/* Host Details Panel - positioned at VaultView root level for correct top alignment */}
      {currentSection === "hosts" && isHostPanelOpen && editingHost?.protocol !== 'serial' && (
        <HostDetailsPanel
          initialData={editingHost}
          availableKeys={keys}
          identities={identities}
          groups={Array.from(
            new Set([
              ...customGroups,
              ...hosts.map((h) => h.group || "General"),
            ]),
          )}
          managedSources={managedSources}
          allTags={allTags}
          allHosts={hosts}
          defaultGroup={editingHost ? undefined : (newHostGroupPath || selectedGroupPath)}
          onSave={(host) => {
            // Check if host already exists in the list (for updates vs. new/duplicate)
            const hostExists = hosts.some((h) => h.id === host.id);
            onUpdateHosts(
              hostExists
                ? hosts.map((h) => (h.id === host.id ? host : h))
                : [...hosts, host],
            );
            setIsHostPanelOpen(false);
            setEditingHost(null);
            setNewHostGroupPath(null);
          }}
          onCancel={() => {
            setIsHostPanelOpen(false);
            setEditingHost(null);
            setNewHostGroupPath(null);
          }}
          onCreateGroup={(groupPath) => {
            onUpdateCustomGroups(
              Array.from(new Set([...customGroups, groupPath])),
            );
          }}
        />
      )}

      {/* Serial Host Details Panel - for editing serial port hosts */}
      {currentSection === "hosts" && isHostPanelOpen && editingHost?.protocol === 'serial' && (
        <SerialHostDetailsPanel
          initialData={editingHost}
          allTags={allTags}
          groups={Array.from(
            new Set([
              ...customGroups,
              ...hosts.map((h) => h.group || "General"),
            ]),
          )}
          onSave={(host) => {
            onUpdateHosts(
              hosts.map((h) => (h.id === host.id ? host : h)),
            );
            setIsHostPanelOpen(false);
            setEditingHost(null);
          }}
          onCancel={() => {
            setIsHostPanelOpen(false);
            setEditingHost(null);
          }}
        />
      )}

      <Dialog open={isNewFolderOpen} onOpenChange={(open) => {
        setIsNewFolderOpen(open);
        if (!open) {
          setNewFolderName("");
          setTargetParentPath(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {targetParentPath
                ? t("vault.groups.createSubfolder")
                : t("vault.groups.createRoot")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("vault.groups.createDialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label>{t("vault.groups.field.name")}</Label>
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t("vault.groups.placeholder.example")}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && submitNewFolder()}
            />
            {targetParentPath && (
              <p className="text-xs text-muted-foreground mt-2">
                {t("vault.groups.parentLabel")}:{" "}
                <span className="font-mono">{targetParentPath}</span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsNewFolderOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitNewFolder}>{t("common.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isRenameGroupOpen}
        onOpenChange={(open) => {
          setIsRenameGroupOpen(open);
          if (!open) {
            setRenameTargetPath(null);
            setRenameGroupName("");
            setRenameGroupError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("vault.groups.renameDialogTitle")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("vault.groups.renameDialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            <Label>{t("vault.groups.field.name")}</Label>
            <Input
              value={renameGroupName}
              onChange={(e) => {
                setRenameGroupName(e.target.value);
                setRenameGroupError(null);
              }}
              placeholder={t("vault.groups.placeholder.example")}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && submitRenameGroup()}
            />
            {renameTargetPath && (
              <p className="text-xs text-muted-foreground">
                {t("vault.groups.pathLabel")}:{" "}
                <span className="font-mono">{renameTargetPath}</span>
              </p>
            )}
            {renameGroupError && (
              <p className="text-xs text-destructive">{renameGroupError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsRenameGroupOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitRenameGroup}>{t("common.rename")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isDeleteGroupOpen}
        onOpenChange={(open) => {
          setIsDeleteGroupOpen(open);
          if (!open) {
            setDeleteTargetPath(null);
            setDeleteGroupWithHosts(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("vault.groups.deleteDialogTitle")}</DialogTitle>
            <DialogDescription>
              {deleteTargetPath && managedGroupPaths.has(deleteTargetPath)
                ? t("vault.groups.deleteDialog.managedDesc")
                : t("vault.groups.deleteDialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {deleteTargetPath && (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("vault.groups.pathLabel")}:{" "}
                  <span className="font-mono">{deleteTargetPath}</span>
                </p>
                {!managedGroupPaths.has(deleteTargetPath) && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteGroupWithHosts}
                      onChange={(e) => setDeleteGroupWithHosts(e.target.checked)}
                      className="rounded border-border"
                    />
                    <span>{t("vault.groups.deleteDialog.deleteHosts")}</span>
                  </label>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsDeleteGroupOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => {
                if (deleteTargetPath) {
                  const isManaged = managedGroupPaths.has(deleteTargetPath);
                  deleteGroupPath(deleteTargetPath, isManaged || deleteGroupWithHosts);
                }
                setIsDeleteGroupOpen(false);
                setDeleteGroupWithHosts(false);
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportVaultDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        onFileSelected={handleImportFileSelected}
      />

      {/* Quick Connect Wizard */}
      {isQuickConnectOpen && quickConnectTarget && (
        <QuickConnectWizard
          open={isQuickConnectOpen}
          target={quickConnectTarget}
          keys={keys}
          knownHosts={knownHosts}
          onConnect={handleQuickConnect}
          onSaveHost={handleQuickConnectSaveHost}
          onClose={() => {
            setIsQuickConnectOpen(false);
            setQuickConnectTarget(null);
            setQuickConnectWarnings([]);
          }}
          warnings={quickConnectWarnings}
        />
      )}

      {/* Protocol Select Dialog */}
      {protocolSelectHost && (
        <Suspense fallback={null}>
          <LazyProtocolSelectDialog
            host={protocolSelectHost}
            onSelect={handleProtocolSelect}
            onCancel={() => setProtocolSelectHost(null)}
          />
        </Suspense>
      )}

      {/* Serial Connect Modal */}
      <SerialConnectModal
        open={isSerialModalOpen}
        onClose={() => setIsSerialModalOpen(false)}
        onConnect={(config) => {
          if (onConnectSerial) {
            onConnectSerial(config);
          }
        }}
        onSaveHost={(host) => {
          onUpdateHosts([...hosts, host]);
        }}
      />
    </div>
  );
};

// Only re-render when data props change - isActive is now managed internally via store subscription
const vaultViewAreEqual = (
  prev: VaultViewProps,
  next: VaultViewProps,
): boolean => {
  const isEqual =
    prev.hosts === next.hosts &&
    prev.keys === next.keys &&
    prev.snippets === next.snippets &&
    prev.snippetPackages === next.snippetPackages &&
    prev.customGroups === next.customGroups &&
    prev.knownHosts === next.knownHosts &&
    prev.shellHistory === next.shellHistory &&
    prev.connectionLogs === next.connectionLogs &&
    prev.sessions === next.sessions &&
    prev.managedSources === next.managedSources;

  return isEqual;
};

const MemoizedVaultViewInner = memo(VaultViewInner, vaultViewAreEqual);

// Just export the memoized component directly
// Visibility control is handled by parent (App.tsx)
export const VaultView = MemoizedVaultViewInner;
VaultView.displayName = "VaultView";
