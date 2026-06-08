import { Copy, FileCode, FileText, LayoutGrid, Minus, Server, Square, TerminalSquare, Usb, X } from 'lucide-react';
import React, { memo, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { activeTabStore, useActiveTabId, useIsTabActive } from '../../application/state/activeTabStore';
import type { EditorTab } from '../../application/state/editorTabStore';
import type { LogView } from '../../application/state/logViewState';
import { useWindowControls } from '../../application/state/useWindowControls';
import { useI18n } from '../../application/i18n/I18nProvider';
import { getEffectiveHostDistro } from '../../domain/host';
import { cn } from '../../lib/utils';
import { Host, TerminalSession, Workspace } from '../../types';
import { DISTRO_LOGOS, DISTRO_COLORS } from '../DistroAvatar';
import { getShellIconPath, isMonochromeShellIcon } from '../../lib/useDiscoveredShells';
import { handleTabMiddleClickClose, handleTabMiddleMouseDown } from '../../lib/tabInteractions';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

// File extensions that render the code-file icon instead of the plain text icon.
const CODE_EXTENSIONS_RE = /\.(js|jsx|ts|tsx|py|rb|go|rs|c|cpp|cs|java|php|sh|bash|zsh|fish|lua|r|scala|swift|kt|html|css|scss|less|json|yaml|yml|toml|xml|sql|graphql|gql|md|mdx|conf|ini|env|tf|hcl|dockerfile)$/i;


const localOsId = (() => {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux';
})();

// Lightweight OS/distro icon for session tabs — matches DistroAvatar "sm" style
const SessionTabIcon: React.FC<{ host: Host | undefined; isActive: boolean; protocol?: string; shellIcon?: string }> = memo(({ host, isActive, protocol, shellIcon }) => {
  const boxBase = "shrink-0 h-4 w-4 rounded flex items-center justify-center";
  const iconSize = "h-2.5 w-2.5";
  const fallbackStyle = { color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' };

  // Serial protocol → USB icon
  if (protocol === 'serial' || host?.protocol === 'serial') {
    return (
      <div className={cn(boxBase, "bg-amber-500/15 text-amber-500")}>
        <Usb className={iconSize} />
      </div>
    );
  }

  // Local protocol → shell-specific icon if available, else OS-specific icon
  if (protocol === 'local' || host?.protocol === 'local' || (!protocol && !host)) {
    // Use shell icon from discovery when available
    const iconId = shellIcon || host?.localShellIcon;
    if (iconId) {
      return (
        <img
          src={getShellIconPath(iconId)}
          alt={iconId}
          className={cn("shrink-0 h-4 w-4 object-contain", isMonochromeShellIcon(iconId) && "dark:invert")}
        />
      );
    }
    const logo = DISTRO_LOGOS[localOsId];
    const bg = DISTRO_COLORS[localOsId] || DISTRO_COLORS.default;
    if (logo) {
      return (
        <div className={cn(boxBase, bg)}>
          <img
            src={logo}
            alt={localOsId}
            className={cn(iconSize, "object-contain invert brightness-0")}
          />
        </div>
      );
    }
    return (
      <div className={boxBase} style={{ backgroundColor: 'color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 15%, transparent)', color: 'var(--top-tabs-accent, hsl(var(--accent)))' }}>
        <TerminalSquare className={iconSize} />
      </div>
    );
  }

  // Try distro logo with brand background color
  if (host) {
    const distro = getEffectiveHostDistro(host);
    const logo = DISTRO_LOGOS[distro];
    if (logo) {
      const bg = DISTRO_COLORS[distro] || DISTRO_COLORS.default;
      return (
        <div className={cn(boxBase, bg)}>
          <img
            src={logo}
            alt={distro || host.os}
            className={cn(iconSize, "object-contain invert brightness-0")}
          />
        </div>
      );
    }
  }

  // Fallback: generic server icon for remote, terminal for unknown
  if (host && host.protocol !== 'local') {
    return (
      <div className={boxBase} style={{ backgroundColor: 'color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 15%, transparent)', color: 'var(--top-tabs-accent, hsl(var(--accent)))' }}>
        <Server className={iconSize} />
      </div>
    );
  }
  return <TerminalSquare className={iconSize} style={fallbackStyle} />;
});
SessionTabIcon.displayName = 'SessionTabIcon';

export const sessionStatusDot = (status: TerminalSession['status'], hasActivity: boolean) => {
  const tone = status === 'connected'
    ? "bg-emerald-400"
    : status === 'connecting'
      ? "bg-amber-400"
      : "bg-rose-500";
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center">
      <span
        className={cn(
          "relative inline-block h-2 w-2 rounded-full ring-2",
          tone,
          hasActivity && "session-activity-dot",
        )}
        style={{ boxShadow: '0 0 0 2px color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 60%, transparent)' }}
      />
    </span>
  );
};

// Custom window controls for Windows/Linux (frameless window)
export const WindowControls: React.FC = memo(() => {
  const { minimize, maximize, close, isMaximized: fetchIsMaximized } = useWindowControls();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // Check initial maximized state
    fetchIsMaximized().then(v => setIsMaximized(!!v));

    // Listen for window resize to update maximized state (debounced to avoid IPC storm)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fetchIsMaximized().then(v => setIsMaximized(!!v));
      }, 200);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, [fetchIsMaximized]);

  const handleMinimize = () => {
    minimize();
  };

  const handleMaximize = async () => {
    const result = await maximize();
    setIsMaximized(!!result);
  };

  const handleClose = () => {
    close();
  };

  const controlStyle = { color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' };
  const controlClassName =
    'h-7 w-10 flex items-center justify-center rounded-none hover:bg-foreground/10 transition-colors app-no-drag';

  return (
    <div className="ml-2 flex items-center h-7">
      <button type="button" className={controlClassName} style={controlStyle} onClick={handleMinimize}>
        <Minus size={16} />
      </button>
      <button type="button" className={controlClassName} style={controlStyle} onClick={handleMaximize}>
        {isMaximized ? <Copy size={14} /> : <Square size={14} />}
      </button>
      <button type="button" className={controlClassName} style={controlStyle} onClick={handleClose}>
        <X size={16} />
      </button>
    </div>
  );
});
WindowControls.displayName = 'WindowControls';

type TranslateFn = ReturnType<typeof useI18n>['t'];
type RenderBulkCloseItems = (anchorId: string) => React.ReactNode;

interface ActiveTabAutoScrollerProps {
  tabsContainerRef: React.RefObject<HTMLDivElement | null>;
  updateScrollState: () => void;
}

export const ActiveTabAutoScroller: React.FC<ActiveTabAutoScrollerProps> = memo(({
  tabsContainerRef,
  updateScrollState,
}) => {
  const activeTabId = useActiveTabId();

  useLayoutEffect(() => {
    if (!activeTabId || activeTabId === 'vault' || activeTabId === 'sftp') return;
    const container = tabsContainerRef.current;
    if (!container) return;

    const activeTabElement = container.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    if (activeTabElement) {
      const containerRect = container.getBoundingClientRect();
      const tabRect = activeTabElement.getBoundingClientRect();

      if (tabRect.left < containerRect.left) {
        container.scrollLeft -= (containerRect.left - tabRect.left + 8);
      } else if (tabRect.right > containerRect.right) {
        container.scrollLeft += (tabRect.right - containerRect.right + 8);
      }
    }

    setTimeout(updateScrollState, 100);
  }, [activeTabId, tabsContainerRef, updateScrollState]);

  return null;
});
ActiveTabAutoScroller.displayName = 'ActiveTabAutoScroller';

interface RootTopTabProps {
  tabId: 'vault' | 'sftp';
  label: string;
  icon: React.ReactNode;
  className?: string;
}

export const RootTopTab: React.FC<RootTopTabProps> = memo(({ tabId, label, icon, className }) => {
  const isActive = useIsTabActive(tabId);
  // The Vaults tab is the app's persistent "home", so keep its selected state
  // visually flat — no active background fill (the label/icon still brighten to
  // the active foreground for subtle feedback). Other root tabs (SFTP) keep the
  // normal filled active state.
  const suppressActiveBg = tabId === 'vault';
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Flat tabs never change their React-managed backgroundColor (transparent
    // when inactive AND active), so React can't diff transparent → transparent
    // to clear the hover fill that onMouseEnter wrote imperatively. Clicking
    // straight from a hover would otherwise leave a stuck highlight, so reset
    // it here before activating.
    if (suppressActiveBg) {
      e.currentTarget.style.backgroundColor = 'transparent';
    }
    activeTabStore.setActiveTabId(tabId);
  }, [tabId, suppressActiveBg]);

  return (
    <div
      data-tab-id={tabId}
      data-tab-type="root"
      data-state={isActive ? 'active' : 'inactive'}
      onClick={handleClick}
      className={cn(
        "netcatty-tab relative h-7 px-3 overflow-hidden text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag",
        className,
      )}
      style={{
        backgroundColor: isActive && !suppressActiveBg
          ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
          : 'transparent',
        color: isActive
          ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
          : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
          e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.backgroundColor = 'transparent';
          e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
        }
      }}
    >
      {icon} {label}
    </div>
  );
});
RootTopTab.displayName = 'RootTopTab';

interface EditorTopTabProps {
  tabId: string;
  editorTab: EditorTab;
  host: Host | undefined;
  suffix: string;
  onRequestCloseEditorTab: (editorTabId: string) => void;
}

export const EditorTopTab: React.FC<EditorTopTabProps> = memo(({
  tabId,
  editorTab,
  host,
  suffix,
  onRequestCloseEditorTab,
}) => {
  const isActive = useIsTabActive(tabId);
  const dirty = editorTab.content !== editorTab.baselineContent;
  const tooltip = `${host?.label ?? editorTab.hostId}@${host?.hostname ?? ''}:${editorTab.remotePath}`;
  const FileIcon = CODE_EXTENSIONS_RE.test(editorTab.fileName) ? FileCode : FileText;
  const handleClick = useCallback(() => {
    activeTabStore.setActiveTabId(tabId);
  }, [tabId]);
  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRequestCloseEditorTab(editorTab.id);
  }, [editorTab.id, onRequestCloseEditorTab]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-tab-id={tabId}
          data-tab-type="editor"
          data-state={isActive ? 'active' : 'inactive'}
          onClick={handleClick}
          onMouseDown={handleTabMiddleMouseDown}
          onAuxClick={(e) => handleTabMiddleClickClose(e, () => onRequestCloseEditorTab(editorTab.id))}
          className="netcatty-tab relative h-7 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-t-md overflow-hidden text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0"
          style={{
            backgroundColor: isActive
              ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
              : 'transparent',
            color: isActive
              ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
              : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
          }}
          onMouseEnter={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
              e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
            }
          }}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <FileIcon
              size={14}
              className="shrink-0"
              style={{ color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
            />
            <span className="truncate flex items-center gap-0.5">
              {dirty && <span className="text-primary mr-0.5">●</span>}
              {editorTab.fileName}
              {suffix && <span className="text-muted-foreground ml-1">{suffix}</span>}
            </span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
            aria-label="Close editor tab"
          >
            <X size={12} />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
});
EditorTopTab.displayName = 'EditorTopTab';

interface SessionTopTabProps {
  session: TerminalSession;
  host: Host | undefined;
  hasActivity: boolean;
  isBeingDragged: boolean;
  isDraggingForReorder: boolean;
  shiftStyle: React.CSSProperties;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
  onTabDragStart: (e: React.DragEvent, tabId: string) => void;
  onTabDragEnd: () => void;
  onTabDragOver: (e: React.DragEvent, tabId: string) => void;
  onTabDragLeave: (e: React.DragEvent) => void;
  onTabDrop: (e: React.DragEvent, targetTabId: string) => void;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onRenameSession: (sessionId: string) => void;
  onCopySession: (sessionId: string) => void;
  onCopySessionToNewWindow: (sessionId: string) => void;
  renderBulkCloseItems: RenderBulkCloseItems;
  t: TranslateFn;
}

export const SessionTopTab: React.FC<SessionTopTabProps> = memo(({
  session,
  host,
  hasActivity,
  isBeingDragged,
  isDraggingForReorder,
  shiftStyle,
  showDropIndicatorBefore,
  showDropIndicatorAfter,
  onTabDragStart,
  onTabDragEnd,
  onTabDragOver,
  onTabDragLeave,
  onTabDrop,
  onCloseSession,
  onRenameSession,
  onCopySession,
  onCopySessionToNewWindow,
  renderBulkCloseItems,
  t,
}) => {
  const isActive = useIsTabActive(session.id);
  const handleClick = useCallback(() => {
    activeTabStore.setActiveTabId(session.id);
  }, [session.id]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-tab-id={session.id}
          data-tab-type="session"
          data-state={isActive ? 'active' : 'inactive'}
          onClick={handleClick}
          onMouseDown={handleTabMiddleMouseDown}
          onAuxClick={(e) => handleTabMiddleClickClose(e, () => onCloseSession(session.id))}
          draggable
          onDragStart={(e) => onTabDragStart(e, session.id)}
          onDragEnd={onTabDragEnd}
          onDragOver={(e) => onTabDragOver(e, session.id)}
          onDragLeave={onTabDragLeave}
          onDrop={(e) => onTabDrop(e, session.id)}
          className={cn(
            "netcatty-tab relative h-7 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-t-md overflow-hidden text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
            "transition-transform duration-150",
            isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : ""
          )}
          style={{
            ...shiftStyle,
            backgroundColor: isActive
              ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
              : 'transparent',
            color: isActive
              ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
              : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
          }}
          onMouseEnter={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
              e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
            }
          }}
        >
          {showDropIndicatorBefore && isDraggingForReorder && (
            <div
              className="absolute -left-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
              style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
            />
          )}
          {showDropIndicatorAfter && isDraggingForReorder && (
            <div
              className="absolute -right-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
              style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
            />
          )}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <SessionTabIcon host={host} isActive={isActive} protocol={session.protocol} shellIcon={session.localShellIcon} />
            <span className="truncate">{session.hostLabel}</span>
            <div className="flex-shrink-0">{sessionStatusDot(session.status, hasActivity)}</div>
          </div>
          <button
            onClick={(e) => onCloseSession(session.id, e)}
            className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
            aria-label={t('tabs.closeSessionAria')}
          >
            <X size={12} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onRenameSession(session.id)}>
          {t('common.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopySession(session.id)}>
          {t('tabs.copyTab')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopySessionToNewWindow(session.id)}>
          {t('tabs.copyTabToNewWindow')}
        </ContextMenuItem>
        <ContextMenuItem className="text-destructive" onClick={() => onCloseSession(session.id)}>
          {t('common.close')}
        </ContextMenuItem>
        {renderBulkCloseItems(session.id)}
      </ContextMenuContent>
    </ContextMenu>
  );
});
SessionTopTab.displayName = 'SessionTopTab';

interface WorkspaceTopTabProps {
  workspace: Workspace;
  paneCount: number;
  hasActivity: boolean;
  isBeingDragged: boolean;
  isDraggingForReorder: boolean;
  shiftStyle: React.CSSProperties;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
  onTabDragStart: (e: React.DragEvent, tabId: string) => void;
  onTabDragEnd: () => void;
  onTabDragOver: (e: React.DragEvent, tabId: string) => void;
  onTabDragLeave: (e: React.DragEvent) => void;
  onTabDrop: (e: React.DragEvent, targetTabId: string) => void;
  onRenameWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  renderBulkCloseItems: RenderBulkCloseItems;
  t: TranslateFn;
}

export const WorkspaceTopTab: React.FC<WorkspaceTopTabProps> = memo(({
  workspace,
  paneCount,
  hasActivity,
  isBeingDragged,
  isDraggingForReorder,
  shiftStyle,
  showDropIndicatorBefore,
  showDropIndicatorAfter,
  onTabDragStart,
  onTabDragEnd,
  onTabDragOver,
  onTabDragLeave,
  onTabDrop,
  onRenameWorkspace,
  onCloseWorkspace,
  renderBulkCloseItems,
  t,
}) => {
  const isActive = useIsTabActive(workspace.id);
  const handleClick = useCallback(() => {
    activeTabStore.setActiveTabId(workspace.id);
  }, [workspace.id]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-tab-id={workspace.id}
          data-tab-type="workspace"
          data-state={isActive ? 'active' : 'inactive'}
          onClick={handleClick}
          onMouseDown={handleTabMiddleMouseDown}
          onAuxClick={(e) => handleTabMiddleClickClose(e, () => onCloseWorkspace(workspace.id))}
          draggable
          onDragStart={(e) => onTabDragStart(e, workspace.id)}
          onDragEnd={onTabDragEnd}
          onDragOver={(e) => onTabDragOver(e, workspace.id)}
          onDragLeave={onTabDragLeave}
          onDrop={(e) => onTabDrop(e, workspace.id)}
          className={cn(
            "netcatty-tab relative h-7 pl-3 pr-2 min-w-[150px] max-w-[260px] rounded-t-md overflow-hidden text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
            "transition-transform duration-150",
            isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : ""
          )}
          style={{
            ...shiftStyle,
            backgroundColor: isActive
              ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
              : 'transparent',
            color: isActive
              ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
              : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
          }}
          onMouseEnter={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
              e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
            }
          }}
        >
          {showDropIndicatorBefore && isDraggingForReorder && (
            <div
              className="absolute -left-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
              style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
            />
          )}
          {showDropIndicatorAfter && isDraggingForReorder && (
            <div
              className="absolute -right-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
              style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
            />
          )}
          <div className="flex items-center gap-2 truncate">
            <LayoutGrid
              size={14}
              className="shrink-0"
              style={{ color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
            />
            <span className="truncate">{workspace.title}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {hasActivity && sessionStatusDot('connected', true)}
            <div
              className="text-[10px] px-1.5 py-0.5 rounded-full min-w-[22px] text-center"
              style={{
                border: '1px solid color-mix(in srgb, var(--top-tabs-fg, hsl(var(--foreground))) 18%, transparent)',
                backgroundColor: 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 60%, transparent)',
              }}
            >
              {paneCount}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onRenameWorkspace(workspace.id)}>
          {t('common.rename')}
        </ContextMenuItem>
        <ContextMenuItem className="text-destructive" onClick={() => onCloseWorkspace(workspace.id)}>
          {t('common.close')}
        </ContextMenuItem>
        {renderBulkCloseItems(workspace.id)}
      </ContextMenuContent>
    </ContextMenu>
  );
});
WorkspaceTopTab.displayName = 'WorkspaceTopTab';

interface LogViewTopTabProps {
  logView: LogView;
  onCloseLogView: (logViewId: string) => void;
  t: TranslateFn;
}

export const LogViewTopTab: React.FC<LogViewTopTabProps> = memo(({
  logView,
  onCloseLogView,
  t,
}) => {
  const isActive = useIsTabActive(logView.id);
  const isLocal = logView.log.protocol === 'local' || logView.log.hostname === 'localhost';
  const handleClick = useCallback(() => {
    activeTabStore.setActiveTabId(logView.id);
  }, [logView.id]);
  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCloseLogView(logView.id);
  }, [logView.id, onCloseLogView]);

  return (
    <div
      data-tab-id={logView.id}
      data-tab-type="logView"
      data-state={isActive ? 'active' : 'inactive'}
      onClick={handleClick}
      onMouseDown={handleTabMiddleMouseDown}
      onAuxClick={(e) => handleTabMiddleClickClose(e, () => onCloseLogView(logView.id))}
      className="netcatty-tab relative h-7 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-t-md overflow-hidden text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0"
      style={{
        backgroundColor: isActive
          ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
          : 'transparent',
        color: isActive
          ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
          : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
          e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.backgroundColor = 'transparent';
          e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
        }
      }}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <FileText
          size={14}
          className="shrink-0"
          style={{ color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
        />
        <span className="truncate">
          {t('tabs.logPrefix')} {isLocal ? t('tabs.logLocal') : logView.log.hostname}
        </span>
      </div>
      <button
        onClick={handleClose}
        className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
        aria-label={t('tabs.closeLogViewAria')}
      >
        <X size={12} />
      </button>
    </div>
  );
});
LogViewTopTab.displayName = 'LogViewTopTab';
