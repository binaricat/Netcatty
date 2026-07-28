import {
  Folder,
  FolderLock,
  LayoutGrid,
  Plus,
  Search,
  Terminal,
  TerminalSquare,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { Host, TerminalSession, TerminalSettings, Workspace } from "../types";
import { KeyBinding } from "../domain/models";
import { matchesSearchQuery } from "../lib/searchMatcher";
import { buildQuickSwitcherShells, useDiscoveredShells, getShellIconPath, isMonochromeShellIcon } from "../lib/useDiscoveredShells";
import { usePluginContributions } from "../application/state/usePluginContributions";
import { requestOpenPluginView } from "./plugins/PluginContributionHost";
import { PluginContributionIcon } from "./plugins/PluginContributionIcon";

type QuickSwitcherItemBase = {
  id: string;
  data?: Host | TerminalSession | Workspace;
  pluginTitle?: string;
  title?: string;
  enabled?: boolean;
  altCommand?: string;
  shortcut?: string;
  pluginId?: string;
  icon?: NetcattyPluginIconReference;
};

type QuickSwitcherItem = QuickSwitcherItemBase & (
  | { type: "plugin-command"; commandId: string }
  | { type: "host" | "tab" | "workspace" | "action" | "shell" | "plugin-view"; commandId?: never }
);

export function getQuickSwitcherRowStateClass(
  isSelected: boolean,
  isKeyboardNavigating: boolean,
): string {
  if (isSelected) return "bg-primary/15";
  return isKeyboardNavigating ? "" : "hover:bg-muted/50";
}

export function shouldUseQuickSwitcherPointerNavigation(
  movementX: number,
  movementY: number,
): boolean {
  return movementX !== 0 || movementY !== 0;
}

export function buildPluginPaletteItems(
  plugins: NetcattyPluginContributionSnapshot['plugins'],
  trimmedQuery: string,
): QuickSwitcherItem[] {
  return plugins.flatMap((plugin) => {
    const commandById = new Map(plugin.commands.map((command) => [command.id, command] as const));
    const paletteMenus = plugin.menus
      .filter((menu) => menu.location === 'commandPalette' && menu.visible)
      .sort((left, right) => (left.group ?? '').localeCompare(right.group ?? '')
        || (left.order ?? 0) - (right.order ?? 0)
        || left.id.localeCompare(right.id));
    const commands: QuickSwitcherItem[] = paletteMenus
      .map((menu) => ({ menu, command: commandById.get(menu.command) }))
      .filter((entry): entry is typeof entry & { command: NonNullable<typeof entry.command> } => Boolean(entry.command))
      .filter(({ menu, command }) => !trimmedQuery || matchesSearchQuery(
        trimmedQuery,
        menu.title ?? command.title,
        command.category ?? '',
        plugin.displayName,
      ))
      .map(({ command, menu }) => {
        const icon = menu.icon ?? command.icon;
        return {
          type: 'plugin-command' as const,
          id: menu.id,
          commandId: command.id,
          title: menu.title,
          pluginTitle: plugin.displayName,
          pluginId: plugin.id,
          enabled: command.enabled && menu.enabled,
          ...(icon ? { icon } : {}),
          ...(menu.alt ? { altCommand: menu.alt } : {}),
          ...(menu.shortcut ? { shortcut: menu.shortcut } : {}),
        };
      });
    const views: QuickSwitcherItem[] = plugin.views
      .filter((view) => view.visible)
      .filter((view) => !trimmedQuery || matchesSearchQuery(trimmedQuery, view.title, plugin.displayName, view.id))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
      .map((view) => ({
        type: 'plugin-view' as const,
        id: view.id,
        title: view.title,
        pluginTitle: plugin.displayName,
        pluginId: plugin.id,
        enabled: true,
        ...(view.icon ? { icon: view.icon } : {}),
      }));
    return [...commands, ...views];
  });
}
import { DistroAvatar } from "./DistroAvatar";
import { Input } from "./ui/input";
import {
  VariableSizeVirtualList,
  type VariableSizeVirtualListHandle,
} from "./ui/VariableSizeVirtualList";
import { clampListIndex, stepListIndex } from "./ui/virtualListMath";

// Compute once at module level
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const QS_ROW_HEIGHT = 44;
/** Two-line plugin command/view rows (title + subtitle + py-2.5) need a taller slot. */
const QS_PLUGIN_ROW_HEIGHT = 56;
const QS_HEADER_HEIGHT = 32;

type QuickSwitcherVisualRow =
  | { kind: "header"; key: string; label: string }
  | { kind: "item"; key: string; item: QuickSwitcherItem; itemIndex: number };

/** Exported for tests — must match VariableSizeVirtualList absolute slot heights. */
export function getQuickSwitcherVisualRowHeight(row: QuickSwitcherVisualRow): number {
  if (row.kind === "header") return QS_HEADER_HEIGHT;
  if (row.item.type === "plugin-command" || row.item.type === "plugin-view") {
    return QS_PLUGIN_ROW_HEIGHT;
  }
  return QS_ROW_HEIGHT;
}

interface QuickSwitcherProps {
  isOpen: boolean;
  query: string;
  results: Host[];
  sessions: TerminalSession[];
  workspaces: Workspace[];
  onQueryChange: (value: string) => void;
  onSelect: (host: Host) => void;
  onSelectTab: (tabId: string) => void;
  onClose: () => void;
  onCreateLocalTerminal?: (shell?: { command: string; args?: string[]; name?: string; icon?: string }) => void;
  onCreateWorkspace?: () => void;
  keyBindings?: KeyBinding[];
  showSftpTab: boolean;
  terminalSettings?: Pick<TerminalSettings, "localShell" | "localShellArgs">;
}

const QuickSwitcherInner: React.FC<QuickSwitcherProps> = ({
  isOpen,
  query,
  results,
  sessions,
  workspaces,
  onQueryChange,
  onSelect,
  onSelectTab,
  onClose,
  onCreateLocalTerminal,
  onCreateWorkspace,
  keyBindings,
  showSftpTab,
  terminalSettings,
}) => {
  const { t } = useI18n();
  const discoveredShells = useDiscoveredShells();
  const pluginContributions = usePluginContributions({
    context: { 'netcatty.surface': 'commandPalette' },
  });
  const quickSwitcherShells = useMemo(() => (
    buildQuickSwitcherShells(
      discoveredShells,
      terminalSettings?.localShell ?? "",
      terminalSettings?.localShellArgs,
    )
  ), [discoveredShells, terminalSettings?.localShell, terminalSettings?.localShellArgs]);

  const filteredShells = useMemo(() => {
    const list = !query.trim()
      ? quickSwitcherShells
      : quickSwitcherShells.filter(
          (s) => matchesSearchQuery(query, s.name, s.id, s.command)
        );
    // Default shell first
    return [...list].sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1));
  }, [quickSwitcherShells, query]);

  // Get hotkey display strings
  const getHotkeyLabel = useCallback((actionId: string) => {
    const binding = keyBindings?.find(k => k.id === actionId);
    if (!binding) return '';
    return IS_MAC ? binding.mac : binding.pc;
  }, [keyBindings]);
  const quickSwitchKey = getHotkeyLabel('quick-switch');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isKeyboardNavigating, setIsKeyboardNavigating] = useState(true);
  const isKeyboardNavigatingRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VariableSizeVirtualListHandle>(null);
  const handlePointerHover = useCallback((movementX: number, movementY: number) => {
    if (!shouldUseQuickSwitcherPointerNavigation(movementX, movementY)) return;
    if (!isKeyboardNavigatingRef.current) return;
    isKeyboardNavigatingRef.current = false;
    setIsKeyboardNavigating(false);
  }, []);

  // Reset state when opening
  useEffect(() => {
    if (!isOpen) return;

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 50);

    setSelectedIndex(0);
    isKeyboardNavigatingRef.current = true;
    setIsKeyboardNavigating(true);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [isOpen]);

  // Handle clicks outside the container
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose]);

  // Memoize orphan sessions
  const orphanSessions = useMemo(
    () => sessions.filter((s) => !s.workspaceId && !s.hiddenFromTabs),
    [sessions]
  );
  const trimmedQuery = query.trim();
  const builtInTabs = useMemo(() => {
    if (!trimmedQuery) return showSftpTab ? ["vault", "sftp"] : ["vault"];
    const matched: string[] = [];
    if (matchesSearchQuery(trimmedQuery, "Vaults", "vault", "hosts", "connections")) {
      matched.push("vault");
    }
    if (showSftpTab && matchesSearchQuery(trimmedQuery, "SFTP", "files", "transfer", "sftp")) {
      matched.push("sftp");
    }
    return matched;
  }, [showSftpTab, trimmedQuery]);
  const filteredOrphanSessions = useMemo(() => {
    if (!trimmedQuery) return orphanSessions;
    return orphanSessions.filter((session) =>
      matchesSearchQuery(
        trimmedQuery,
        session.hostLabel || "",
        session.hostname || "",
        session.id,
      ),
    );
  }, [orphanSessions, trimmedQuery]);
  const filteredWorkspaces = useMemo(() => {
    if (!trimmedQuery) return workspaces;
    return workspaces.filter((workspace) =>
      matchesSearchQuery(trimmedQuery, workspace.title, workspace.id),
    );
  }, [trimmedQuery, workspaces]);
  const shouldShowLocalTerminalFallback = filteredShells.length === 0 && !!onCreateLocalTerminal && !trimmedQuery;
  const pluginPaletteItems = useMemo(() => buildPluginPaletteItems(
    pluginContributions.snapshot.plugins,
    trimmedQuery,
  ), [pluginContributions.snapshot.plugins, trimmedQuery]);

  // Memoize flat selectable items + visual rows (headers + items) for virtualization.
  const { flatItems, visualRows, itemIndexToVisualIndex } = useMemo(() => {
    const items: QuickSwitcherItem[] = [];
    const visual: QuickSwitcherVisualRow[] = [];
    const itemToVisual = new Map<number, number>();

    const pushHeader = (key: string, label: string) => {
      visual.push({ kind: "header", key, label });
    };
    const pushItem = (item: QuickSwitcherItem) => {
      const itemIndex = items.length;
      items.push(item);
      itemToVisual.set(itemIndex, visual.length);
      visual.push({
        kind: "item",
        key: `${item.type}:${item.id}`,
        item,
        itemIndex,
      });
    };

    if (results.length > 0) {
      pushHeader("header:hosts", "Hosts");
      results.forEach((host) =>
        pushItem({ type: "host", id: host.id, data: host }),
      );
    }

    const hasTabsSection =
      builtInTabs.length > 0
      || filteredOrphanSessions.length > 0
      || filteredWorkspaces.length > 0;
    if (hasTabsSection) {
      pushHeader("header:tabs", "Tabs");
      builtInTabs.forEach((tabId) => {
        pushItem({ type: "tab", id: tabId });
      });
      filteredWorkspaces.forEach((w) =>
        pushItem({ type: "workspace", id: w.id, data: w }),
      );
      filteredOrphanSessions.forEach((s) =>
        pushItem({ type: "tab", id: s.id, data: s }),
      );
    }

    if (filteredShells.length > 0) {
      pushHeader("header:shells", t("qs.localShells"));
      filteredShells.forEach((shell) =>
        pushItem({ type: "shell", id: shell.id }),
      );
    } else if (shouldShowLocalTerminalFallback) {
      pushHeader("header:shells", t("qs.localShells"));
      pushItem({ type: "action", id: "local-terminal" });
    }

    if (pluginPaletteItems.length > 0) {
      pushHeader("header:plugins", t("settings.tab.plugins"));
      pluginPaletteItems.forEach((item) => pushItem(item));
    }

    return {
      flatItems: items,
      visualRows: visual,
      itemIndexToVisualIndex: itemToVisual,
    };
  }, [
    builtInTabs,
    filteredOrphanSessions,
    filteredShells,
    filteredWorkspaces,
    pluginPaletteItems,
    results,
    shouldShowLocalTerminalFallback,
    t,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedIndex((prev) => clampListIndex(prev, flatItems.length));
  }, [flatItems.length, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const visualIndex = itemIndexToVisualIndex.get(selectedIndex);
    if (visualIndex === undefined) return;
    listRef.current?.scrollToIndex(visualIndex, "auto");
  }, [isOpen, itemIndexToVisualIndex, selectedIndex]);

  const shellById = useMemo(
    () => new Map(quickSwitcherShells.map((shell) => [shell.id, shell])),
    [quickSwitcherShells],
  );

  const getRowHeight = useCallback(
    (row: QuickSwitcherVisualRow) => getQuickSwitcherVisualRowHeight(row),
    [],
  );

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      isKeyboardNavigatingRef.current = true;
      setIsKeyboardNavigating(true);
      setSelectedIndex((prev) => stepListIndex(prev, flatItems.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      isKeyboardNavigatingRef.current = true;
      setIsKeyboardNavigating(true);
      setSelectedIndex((prev) => stepListIndex(prev, flatItems.length, -1));
    } else if (e.key === "Enter" && flatItems.length > 0) {
      e.preventDefault();
      const item = flatItems[clampListIndex(selectedIndex, flatItems.length)];
      if (!item) return;
      handleItemSelect(item, e.altKey);
    }
  };

  const handleItemSelect = (item: QuickSwitcherItem, useAlternate = false) => {
    switch (item.type) {
      case "host":
        onSelect(item.data as Host);
        break;
      case "tab":
      case "workspace":
        onSelectTab(item.id);
        onClose();
        break;
      case "action":
        if (item.id === "local-terminal" && onCreateLocalTerminal) {
          onCreateLocalTerminal();
          onClose();
        }
        break;
      case "shell": {
        const shell = quickSwitcherShells.find(s => s.id === item.id);
        if (shell && onCreateLocalTerminal) {
          onCreateLocalTerminal({ command: shell.command, args: shell.args, name: shell.name, icon: shell.icon });
          onClose();
        }
        break;
      }
      case "plugin-command":
        if (item.enabled !== false) {
          void pluginContributions.executeCommand(
            useAlternate && item.altCommand ? item.altCommand : item.commandId,
            undefined,
            { 'netcatty.surface': 'commandPalette' },
          ).catch(() => {});
          onClose();
        }
        break;
      case "plugin-view":
        requestOpenPluginView({ viewId: item.id, context: { 'netcatty.surface': 'commandPalette' } });
        onClose();
        break;
    }
  };

  return (
    <div
      className="fixed inset-x-0 top-12 z-50 flex justify-center pt-2"
      style={{ pointerEvents: "none" }}
    >
      <div
        ref={containerRef}
        className="w-full max-w-2xl mx-4 bg-background border border-border rounded-xl shadow-2xl overflow-hidden max-h-[520px] flex flex-col"
        style={{ pointerEvents: "auto" }}
        onMouseMove={(event) => handlePointerHover(event.movementX, event.movementY)}
      >
        {/* Search Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              onQueryChange(e.target.value);
              setSelectedIndex(0);
              isKeyboardNavigatingRef.current = true;
              setIsKeyboardNavigating(true);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t("qs.search.placeholder")}
            className="flex-1 h-8 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-0 text-sm"
          />
          {quickSwitchKey && (
            <kbd className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {quickSwitchKey.replace(/ \+ /g, '+')}
            </kbd>
          )}
        </div>

        {/* Jump To hint + New Workspace action */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
          <span className="text-xs text-muted-foreground">{t("qs.jumpTo")}</span>
          {quickSwitchKey && (
            <kbd className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">
              {quickSwitchKey.replace(/ \+ /g, '+')}
            </kbd>
          )}
          {onCreateWorkspace && (
            <button
              type="button"
              onClick={() => {
                onCreateWorkspace();
                onClose();
              }}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors hover:bg-muted/50"
            >
              <Plus size={11} />
              <span>New Workspace</span>
            </button>
          )}
        </div>

        {/*
          max-h on the list is required: the popup only has max-h-[520px], so a bare
          h-full child can expand with the virtual spacer and get clipped with no scroll.
          Cap the scroller so large inventories remain reachable.
        */}
        <div className="min-h-0 flex-1 overflow-hidden" data-host-picker-virtual="quick-switcher">
          <VariableSizeVirtualList<QuickSwitcherVisualRow>
            ref={listRef}
            items={visualRows}
            getItemHeight={getRowHeight}
            className="h-full max-h-[min(360px,calc(100vh-14rem))]"
            overscan={8}
            getItemKey={(row) => row.key}
            renderItem={(row) => {
              if (row.kind === "header") {
                return (
                  <div className="flex h-full items-end px-4 pb-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {row.label}
                    </span>
                  </div>
                );
              }

              const { item, itemIndex } = row;
              const isSelected = itemIndex === selectedIndex;
              // Fixed virtual slots: keep content single-line (or plugin two-line) and clip overflow.
              const rowClass = `flex h-full min-h-0 items-center gap-3 overflow-hidden px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`;

              if (item.type === "host") {
                const host = item.data as Host;
                return (
                  <div
                    className={`flex h-full min-h-0 items-center justify-between overflow-hidden px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                    onClick={() => onSelect(host)}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <DistroAvatar
                        host={host}
                        fallback={host.label.slice(0, 2).toUpperCase()}
                        size="sm"
                      />
                      <span className="truncate text-sm font-medium">{host.label}</span>
                    </div>
                    <div className="ml-3 max-w-[12rem] shrink-0 truncate text-[11px] text-muted-foreground">
                      {host.group ? `Personal / ${host.group}` : "Personal"}
                    </div>
                  </div>
                );
              }

              if (item.type === "tab") {
                const isBuiltIn = item.id === "vault" || item.id === "sftp";
                if (isBuiltIn) {
                  const icon = item.id === "vault" ? <FolderLock size={16} /> : <Folder size={16} />;
                  const label = item.id === "vault" ? "Vaults" : "SFTP";
                  return (
                    <div
                      className={rowClass}
                      onClick={() => {
                        onSelectTab(item.id);
                        onClose();
                      }}
                    >
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground">
                        {icon}
                      </div>
                      <span className="truncate text-sm font-medium">{label}</span>
                    </div>
                  );
                }
                const session = item.data as TerminalSession | undefined;
                return (
                  <div
                    className={rowClass}
                    onClick={() => {
                      onSelectTab(item.id);
                      onClose();
                    }}
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground">
                      <TerminalSquare size={16} />
                    </div>
                    <span className="min-w-0 truncate text-sm font-medium">
                      {session?.hostLabel ?? item.id}
                    </span>
                  </div>
                );
              }

              if (item.type === "workspace") {
                const workspace = item.data as Workspace | undefined;
                return (
                  <div
                    className={rowClass}
                    onClick={() => {
                      onSelectTab(item.id);
                      onClose();
                    }}
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground">
                      <LayoutGrid size={16} />
                    </div>
                    <span className="min-w-0 truncate text-sm font-medium">
                      {workspace?.title ?? item.id}
                    </span>
                  </div>
                );
              }

              if (item.type === "shell") {
                const shell = shellById.get(item.id);
                if (!shell) return null;
                return (
                  <div
                    className={rowClass}
                    onClick={() => {
                      if (onCreateLocalTerminal) {
                        onCreateLocalTerminal({
                          command: shell.command,
                          args: shell.args,
                          name: shell.name,
                          icon: shell.icon,
                        });
                        onClose();
                      }
                    }}
                  >
                    <img
                      src={getShellIconPath(shell.icon)}
                      alt={shell.name}
                      className={`h-6 w-6 shrink-0${isMonochromeShellIcon(shell.icon) ? " dark:invert" : ""}`}
                    />
                    <span className="min-w-0 truncate text-sm font-medium">{shell.name}</span>
                    {shell.isDefault && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t("qs.default")}
                      </span>
                    )}
                  </div>
                );
              }

              if (item.type === "action" && item.id === "local-terminal") {
                return (
                  <div
                    className={rowClass}
                    onClick={() => {
                      onCreateLocalTerminal?.();
                      onClose();
                    }}
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground">
                      <Terminal size={16} />
                    </div>
                    <span className="truncate text-sm font-medium">{t("qs.localTerminal")}</span>
                  </div>
                );
              }

              if (item.type === "plugin-command" || item.type === "plugin-view") {
                return (
                  <button
                    type="button"
                    disabled={item.enabled === false}
                    className={`flex h-full min-h-0 w-full items-center gap-3 overflow-hidden px-4 py-2.5 text-left transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)} disabled:opacity-50`}
                    onClick={(event) => handleItemSelect(item, event.altKey)}
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground">
                      <PluginContributionIcon pluginId={item.pluginId} icon={item.icon} size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{item.title}</div>
                      <div className="truncate text-[10px] text-muted-foreground">{item.pluginTitle}</div>
                    </div>
                    {item.shortcut && (
                      <kbd className="shrink-0 text-[10px] text-muted-foreground">{item.shortcut}</kbd>
                    )}
                  </button>
                );
              }

              return null;
            }}
          />
        </div>
      </div>
    </div>
  );
};

export const QuickSwitcher = memo(QuickSwitcherInner);
QuickSwitcher.displayName = "QuickSwitcher";
