import {
  Folder,
  LayoutGrid,
  Search,
  Shield,
  Terminal,
  TerminalSquare,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { Host, TerminalSession, Workspace } from "../types";
import { KeyBinding } from "../domain/models";

type QuickSwitcherItem = {
  type: "host" | "tab" | "workspace" | "action";
  id: string;
  data?: Host | TerminalSession | Workspace;
};
import { DistroAvatar } from "./DistroAvatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";

// Compute once at module level
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// Memoized host item component to prevent unnecessary re-renders
const HostItem = memo(({
  host,
  isSelected,
  onSelect,
  onMouseEnter,
}: {
  host: Host;
  isSelected: boolean;
  onSelect: (host: Host) => void;
  onMouseEnter: () => void;
}) => (
  <div
    className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${isSelected ? "bg-primary/15" : "hover:bg-muted/50"
      }`}
    onClick={() => onSelect(host)}
    onMouseEnter={onMouseEnter}
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
  onCreateLocalTerminal?: () => void;
  onCreateWorkspace?: () => void;
  keyBindings?: KeyBinding[];
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
}) => {
  const { t } = useI18n();
  // Get hotkey display strings
  const getHotkeyLabel = useCallback((actionId: string) => {
    const binding = keyBindings?.find(k => k.id === actionId);
    if (!binding) return '';
    return IS_MAC ? binding.mac : binding.pc;
  }, [keyBindings]);
  const quickSwitchKey = getHotkeyLabel('quick-switch');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setIsFocused(false);
      setSelectedIndex(0);
      // Auto focus the input after a short delay
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
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
    () => sessions.filter((s) => !s.workspaceId),
    [sessions]
  );

  const showCategorized = query.trim().length > 0;

  // Memoize flat items list and index map
  const { flatItems, itemIndexMap } = useMemo(() => {
    const items: QuickSwitcherItem[] = [];

    if (showCategorized) {
      // Hosts
      results.forEach((host) =>
        items.push({ type: "host", id: host.id, data: host }),
      );
      // Tabs (built-in + sessions + workspaces)
      items.push({ type: "tab", id: "vault" });
      items.push({ type: "tab", id: "sftp" });
      orphanSessions.forEach((s) =>
        items.push({ type: "tab", id: s.id, data: s }),
      );
      workspaces.forEach((w) =>
        items.push({ type: "workspace", id: w.id, data: w }),
      );
      // Quick connect actions
      items.push({ type: "action", id: "local-terminal" });
    } else {
      // Recent connections only
      results.forEach((host) =>
        items.push({ type: "host", id: host.id, data: host }),
      );
    }

    // Build index map for O(1) lookup
    const indexMap = new Map<string, number>();
    items.forEach((item, idx) => {
      indexMap.set(`${item.type}:${item.id}`, idx);
    });

    return { flatItems: items, itemIndexMap: indexMap };
  }, [showCategorized, results, orphanSessions, workspaces]);

  // O(1) index lookup
  const getItemIndex = useCallback((type: string, id: string) => {
    return itemIndexMap.get(`${type}:${id}`) ?? -1;
  }, [itemIndexMap]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && flatItems.length > 0) {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      handleItemSelect(item);
    }
  };

  const handleItemSelect = (item: QuickSwitcherItem) => {
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
            }}
            onFocus={() => setIsFocused(true)}
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

        <ScrollArea className="flex-1 h-full">
          {!showCategorized ? (
            /* Default view: Recent connections with header */
            <div>
              <div className="px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("qs.recentConnections")}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => onCreateWorkspace?.()}
                  >
                    {t("qs.createWorkspace")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled
                  >
                    {t("qs.restore")}
                  </Button>
                </div>
              </div>
              <div>
                {results.length > 0 ? (
                  results.map((host) => (
                    <HostItem
                      key={host.id}
                      host={host}
                      isSelected={getItemIndex("host", host.id) === selectedIndex}
                      onSelect={onSelect}
                      onMouseEnter={() => setSelectedIndex(getItemIndex("host", host.id))}
                    />
                  ))
                ) : (
                  <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                    No recent connections
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Focused/searching view: Categorized items */
            <div>
              {/* Jump To hint */}
              <div className="px-4 py-2 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("qs.jumpTo")}</span>
                {quickSwitchKey && (
                  <kbd className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">
                    {quickSwitchKey.replace(/ \+ /g, '+')}
                  </kbd>
                )}
              </div>

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
                      onSelect={onSelect}
                      onMouseEnter={() => setSelectedIndex(getItemIndex("host", host.id))}
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
                {["vault", "sftp"].map((tabId) => {
                  const idx = getItemIndex("tab", tabId);
                  const isSelected = idx === selectedIndex;
                  const icon =
                    tabId === "vault" ? (
                      <Shield size={16} />
                    ) : (
                      <Folder size={16} />
                    );
                  const label = tabId === "vault" ? "Vaults" : "SFTP";

                  return (
                    <div
                      key={tabId}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${isSelected ? "bg-primary/15" : "hover:bg-muted/50"
                        }`}
                      onClick={() => {
                        onSelectTab(tabId);
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                        {icon}
                      </div>
                      <span className="text-sm font-medium">{label}</span>
                    </div>
                  );
                })}

                {/* Workspaces */}
                {workspaces.map((workspace) => {
                  const idx = getItemIndex("workspace", workspace.id);
                  const isSelected = idx === selectedIndex;

                  return (
                    <div
                      key={workspace.id}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${isSelected ? "bg-primary/15" : "hover:bg-muted/50"
                        }`}
                      onClick={() => {
                        onSelectTab(workspace.id);
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
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
                {orphanSessions.map((session) => {
                  const idx = getItemIndex("tab", session.id);
                  const isSelected = idx === selectedIndex;

                  return (
                    <div
                      key={session.id}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${isSelected ? "bg-primary/15" : "hover:bg-muted/50"
                        }`}
                      onClick={() => {
                        onSelectTab(session.id);
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
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

              {/* Quick connect section */}
              <div>
                <div className="px-4 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Quick connect
                  </span>
                </div>

                {/* Local Terminal */}
                {onCreateLocalTerminal && (
                  <div
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${getItemIndex("action", "local-terminal") === selectedIndex
                      ? "bg-primary/15"
                      : "hover:bg-muted/50"
                      }`}
                    onClick={() => {
                      onCreateLocalTerminal();
                      onClose();
                    }}
                    onMouseEnter={() =>
                      setSelectedIndex(getItemIndex("action", "local-terminal"))
                    }
                  >
                    <div className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground">
                      <Terminal size={16} />
                    </div>
                    <span className="text-sm font-medium">{t("qs.localTerminal")}</span>
                  </div>
                )}

                {/* Serial removed (not supported) */}
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
};

export const QuickSwitcher = memo(QuickSwitcherInner);
QuickSwitcher.displayName = "QuickSwitcher";
