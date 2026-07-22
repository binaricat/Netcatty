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
import { ScrollArea } from "./ui/scroll-area";

// Compute once at module level
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// Memoized host item component to prevent unnecessary re-renders
const HostItem = memo(({
  host,
  isSelected,
  isKeyboardNavigating,
  selectedItemRef,
  onSelect,
}: {
  host: Host;
  isSelected: boolean;
  isKeyboardNavigating: boolean;
  selectedItemRef?: React.RefCallback<HTMLDivElement>;
  onSelect: (host: Host) => void;
}) => (
  <div
    ref={selectedItemRef}
    className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
    onClick={() => onSelect(host)}
  >
    <div className="flex items-center gap-3 min-w-0">
      <DistroAvatar
        host={host}
        fallback={host.label.slice(0, 2).toUpperCase()}
        size="sm"
      />
      <span className="text-sm font-medium truncate">{host.label}</span>
    </div>
    <div className="text-[11px] text-muted-foreground">
      {host.group ? `Personal / ${host.group}` : "Personal"}
    </div>
  </div>
));
HostItem.displayName = "HostItem";

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
  const selectedItemRef = useRef<HTMLElement>(null);
  const setSelectedItemRef = useCallback((element: HTMLElement | null) => {
    selectedItemRef.current = element;
  }, []);
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

  // Always show categorized view (Hosts/Tabs/Quick connect)
  const showCategorized = true;

  // Memoize flat items list and index map
  const { flatItems, itemIndexMap } = useMemo(() => {
    const items: QuickSwitcherItem[] = [];

    if (showCategorized) {
      // Hosts
      results.forEach((host) =>
        items.push({ type: "host", id: host.id, data: host }),
      );
      // Tabs (built-in + sessions + workspaces)
      builtInTabs.forEach((tabId) => {
        items.push({ type: "tab", id: tabId });
      });
      filteredOrphanSessions.forEach((s) =>
        items.push({ type: "tab", id: s.id, data: s }),
      );
      filteredWorkspaces.forEach((w) =>
        items.push({ type: "workspace", id: w.id, data: w }),
      );
      // Local shells (or fallback action if discovery not ready)
      if (filteredShells.length > 0) {
        filteredShells.forEach((shell) =>
          items.push({ type: "shell", id: shell.id }),
        );
      } else if (shouldShowLocalTerminalFallback) {
        items.push({ type: "action", id: "local-terminal" });
      }
      items.push(...pluginPaletteItems);
    } else {
      // Recent connections only
      results.forEach((host) =>
        items.push({ type: "host", id: host.id, data: host }),
      );
      // Also include matching shells in search results
      filteredShells.forEach((shell) =>
        items.push({ type: "shell", id: shell.id }),
      );
      items.push(...pluginPaletteItems);
    }

    // Build index map for O(1) lookup
    const indexMap = new Map<string, number>();
    items.forEach((item, idx) => {
      indexMap.set(`${item.type}:${item.id}`, idx);
    });

    return { flatItems: items, itemIndexMap: indexMap };
  }, [showCategorized, results, builtInTabs, filteredOrphanSessions, filteredWorkspaces, filteredShells, shouldShowLocalTerminalFallback, pluginPaletteItems]);

  // O(1) index lookup
  const getItemIndex = useCallback((type: string, id: string) => {
    return itemIndexMap.get(`${type}:${id}`) ?? -1;
  }, [itemIndexMap]);

  const selectedItem = flatItems[selectedIndex];
  const selectedItemKey = selectedItem ? `${selectedItem.type}:${selectedItem.id}` : '';

  useEffect(() => {
    if (!isOpen || !selectedItemKey) return;
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex, selectedItemKey]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      isKeyboardNavigatingRef.current = true;
      setIsKeyboardNavigating(true);
      setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      isKeyboardNavigatingRef.current = true;
      setIsKeyboardNavigating(true);
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && flatItems.length > 0) {
      e.preventDefault();
      const item = flatItems[selectedIndex];
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

        <ScrollArea className="flex-1 h-full">
          {/* Categorized view: Hosts/Tabs/Quick connect */}
          <div>
            {/* Hosts section */}
            {results.length > 0 && (
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Hosts
                  </span>
                </div>
                {results.map((host) => (
                  <HostItem
                    key={host.id}
                    host={host}
                    isSelected={getItemIndex("host", host.id) === selectedIndex}
                    isKeyboardNavigating={isKeyboardNavigating}
                    selectedItemRef={getItemIndex("host", host.id) === selectedIndex ? setSelectedItemRef : undefined}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}

            {/* Tabs section */}
            <div>
              <div className="px-4 py-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Tabs
                </span>
              </div>

              {/* Built-in tabs */}
              {builtInTabs.map((tabId) => {
                const idx = getItemIndex("tab", tabId);
                const isSelected = idx === selectedIndex;
                const icon =
                  tabId === "vault" ? (
                    <FolderLock size={16} />
                  ) : (
                    <Folder size={16} />
                  );
                const label = tabId === "vault" ? "Vaults" : "SFTP";

                return (
                  <div
                    key={tabId}
                    ref={isSelected ? setSelectedItemRef : undefined}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                    onClick={() => {
                      onSelectTab(tabId);
                      onClose();
                    }}
                  >
                    <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                      {icon}
                    </div>
                    <span className="text-sm font-medium">{label}</span>
                  </div>
                );
              })}

              {/* Workspaces */}
              {filteredWorkspaces.map((workspace) => {
                const idx = getItemIndex("workspace", workspace.id);
                const isSelected = idx === selectedIndex;

                return (
                  <div
                    key={workspace.id}
                    ref={isSelected ? setSelectedItemRef : undefined}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                    onClick={() => {
                      onSelectTab(workspace.id);
                      onClose();
                    }}
                  >
                    <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                      <LayoutGrid size={16} />
                    </div>
                    <span className="text-sm font-medium">
                      {workspace.title}
                    </span>
                  </div>
                );
              })}

              {/* Orphan sessions */}
              {filteredOrphanSessions.map((session) => {
                const idx = getItemIndex("tab", session.id);
                const isSelected = idx === selectedIndex;

                return (
                  <div
                    key={session.id}
                    ref={isSelected ? setSelectedItemRef : undefined}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                    onClick={() => {
                      onSelectTab(session.id);
                      onClose();
                    }}
                  >
                    <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                      <TerminalSquare size={16} />
                    </div>
                    <span className="text-sm font-medium">
                      {session.hostLabel}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Local Shells section */}
            {/* Local Shells or fallback Local Terminal */}
            {filteredShells.length > 0 ? (
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("qs.localShells")}
                  </span>
                </div>
                {filteredShells.map((shell) => {
                  const idx = getItemIndex("shell", shell.id);
                  const isSelected = idx === selectedIndex;
                  return (
                    <div
                      key={shell.id}
                      ref={isSelected ? setSelectedItemRef : undefined}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)}`}
                      onClick={() => {
                        if (onCreateLocalTerminal) {
                          onCreateLocalTerminal({ command: shell.command, args: shell.args, name: shell.name, icon: shell.icon });
                          onClose();
                        }
                      }}
                    >
                      <img
                        src={getShellIconPath(shell.icon)}
                        alt={shell.name}
                        className={`h-6 w-6 shrink-0${isMonochromeShellIcon(shell.icon) ? " dark:invert" : ""}`}
                      />
                      <span className="text-sm font-medium">{shell.name}</span>
                      {shell.isDefault && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {t("qs.default")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : shouldShowLocalTerminalFallback && (
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("qs.localShells")}
                  </span>
                </div>
                <div
                  ref={getItemIndex("action", "local-terminal") === selectedIndex ? setSelectedItemRef : undefined}
                  className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${getQuickSwitcherRowStateClass(
                    getItemIndex("action", "local-terminal") === selectedIndex,
                    isKeyboardNavigating,
                  )}`}
                  onClick={() => {
                    onCreateLocalTerminal();
                    onClose();
                  }}
                >
                  <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                    <Terminal size={16} />
                  </div>
                  <span className="text-sm font-medium">{t("qs.localTerminal")}</span>
                </div>
              </div>
            )}

            {pluginPaletteItems.length > 0 && (
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('settings.tab.plugins')}</span>
                </div>
                {pluginPaletteItems.map((item) => {
                  const idx = getItemIndex(item.type, item.id);
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      type="button"
                      key={`${item.type}:${item.id}`}
                      ref={isSelected ? setSelectedItemRef : undefined}
                      disabled={item.enabled === false}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${getQuickSwitcherRowStateClass(isSelected, isKeyboardNavigating)} disabled:opacity-50`}
                      onClick={(event) => handleItemSelect(item, event.altKey)}
                    >
                      <div className="flex h-6 w-6 items-center justify-center text-muted-foreground">
                        <PluginContributionIcon pluginId={item.pluginId} icon={item.icon} size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{item.title}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{item.pluginTitle}</div>
                      </div>
                      {item.shortcut && <kbd className="text-[10px] text-muted-foreground">{item.shortcut}</kbd>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};

export const QuickSwitcher = memo(QuickSwitcherInner);
QuickSwitcher.displayName = "QuickSwitcher";
