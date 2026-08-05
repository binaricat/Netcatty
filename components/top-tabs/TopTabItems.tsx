import { Copy, FileCode, FileText, LayoutGrid, Minus, Server, Square, Terminal, TerminalSquare, Usb, X } from 'lucide-react';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { activeTabStore, useActiveTabId, useIsTabActive } from '../../application/state/activeTabStore';
import {
  useAnySessionActivity,
  useSessionActivity,
} from '../../application/state/sessionActivityStore';
import { usePresentedSession } from '../../application/state/sessionPresentationStore';
import {
  useEditorTabDirty,
  type EditorTabChrome,
} from '../../application/state/editorTabStore';
import type { LogView } from '../../application/state/logViewState';
import { useWindowControls } from '../../application/state/useWindowControls';
import { terminalReconnectRegistry } from '../../application/state/terminalReconnectRegistry';
import { useI18n } from '../../application/i18n/I18nProvider';
import { getEffectiveHostDistro } from '../../domain/host';
import { resolveHostIconAppearance, resolveHostIconColorAppearance } from '../../domain/hostIcon';
import { resolveSessionCodingCliProvider } from '../../domain/codingCliProviderMatch';
import type { CodingCliProvider } from '../../domain/codingCliProviders';
import { resolveCodingCliActivityPhase, type CodingCliActivityPhase } from '../../domain/codingCliTitleParse';
import { resolveSessionTabTitle, resolveWorkspaceTabLabel } from '../../domain/sessionTabTitle';
import type { DynamicTabTitleMode } from '../../domain/models';
import { CodingCliProviderIcon } from '../icons/CodingCliProviderIcon';
import { cn } from '../../lib/utils';
import { Host, TerminalSession, Workspace } from '../../types';
import { DISTRO_LOGOS, DISTRO_COLORS } from '../DistroAvatar';
import { getShellIconPath, isMonochromeShellIcon } from '../../lib/useDiscoveredShells';
import { handleTabMiddleClickClose, handleTabMiddleMouseDown } from '../../lib/tabInteractions';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { SessionTabContextMenuContent } from './SessionTabContextMenuContent';
import { renderHostIconGlyph } from '../hostIconRenderer';
import type { PluginViewTab } from '../../application/state/pluginViewTabStore';
import { PluginContributionIcon } from '../plugins/PluginContributionIcon';

// File extensions that render the code-file icon instead of the plain text icon.
const CODE_EXTENSIONS_RE = /\.(js|jsx|ts|tsx|py|rb|go|rs|c|cpp|cs|java|php|sh|bash|zsh|fish|lua|r|scala|swift|kt|html|css|scss|less|json|yaml|yml|toml|xml|sql|graphql|gql|md|mdx|conf|ini|env|tf|hcl|dockerfile)$/i;

export function activateLogViewTab(logViewId: string): void {
  activeTabStore.setActiveTabId(logViewId);
}

const localOsId = (() => {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux';
})();

// Lightweight OS/distro icon for session tabs — matches DistroAvatar "sm" style
const SessionTabIcon: React.FC<{
  host: Host | undefined;
  session: Pick<TerminalSession, 'dynamicTitle' | 'startupCommand' | 'customName' | 'hostLabel' | 'localShell' | 'localShellName' | 'codingCliProviderId'>;
  isActive: boolean;
  protocol?: string;
  shellIcon?: string;
  dynamicTabTitleMode?: DynamicTabTitleMode;
}> = memo(({ host, session, isActive, protocol, shellIcon, dynamicTabTitleMode }) => {
  const boxBase = "shrink-0 h-4 w-4 rounded flex items-center justify-center";
  const iconSize = "h-2.5 w-2.5";
  const fallbackStyle = { color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' };

  const codingCliIconState = resolveSessionTabCodingCliIconState(session, host, dynamicTabTitleMode);
  if (codingCliIconState) {
    const { provider: codingCliProvider, activityPhase } = codingCliIconState;
    return (
      <CodingCliProviderIcon
        providerId={codingCliProvider.id}
        iconKey={codingCliProvider.iconKey}
        activityPhase={activityPhase}
      />
    );
  }

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

  if (host) {
    const customAppearance = resolveHostIconAppearance(host);
    if (customAppearance) {
      return (
        <div className={cn(boxBase, "text-white")} style={{ backgroundColor: customAppearance.colorHex }}>
          {renderHostIconGlyph(customAppearance.iconId, iconSize)}
        </div>
      );
    }
  }

  // Try distro logo with brand background color
  if (host) {
    const distro = getEffectiveHostDistro(host);
    const logo = DISTRO_LOGOS[distro];
    if (logo) {
      const bg = DISTRO_COLORS[distro] || DISTRO_COLORS.default;
      const customColor = resolveHostIconColorAppearance(host);
      return (
        <div className={cn(boxBase, !customColor && bg)} style={customColor ? { backgroundColor: customColor.colorHex } : undefined}>
          <img
            src={logo}
            alt={distro || host.os}
            className={distro === "h3c" ? "object-contain w-[80%]" : cn(iconSize, "object-contain invert brightness-0")}
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
  return <Terminal className={iconSize} style={fallbackStyle} />;
});
SessionTabIcon.displayName = 'SessionTabIcon';

export function resolveSessionTabCodingCliIconState(
  session: Pick<
    TerminalSession,
    | 'dynamicTitle'
    | 'startupCommand'
    | 'customName'
    | 'hostLabel'
    | 'localShell'
    | 'localShellName'
    | 'codingCliProviderId'
  >,
  host: Host | undefined,
  dynamicTabTitleMode: DynamicTabTitleMode = 'agent',
): { provider: CodingCliProvider; activityPhase: CodingCliActivityPhase } | null {
  if (dynamicTabTitleMode === 'off') {
    const provider = resolveSessionCodingCliProvider({
      ...session,
      dynamicTitle: undefined,
    }, host);
    return provider ? { provider, activityPhase: 'idle' } : null;
  }

  const provider = resolveSessionCodingCliProvider(session, host);
  if (!provider) return null;
  return {
    provider,
    activityPhase: resolveCodingCliActivityPhase(session.dynamicTitle, provider.id),
  };
}

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

const getSessionTopTabAddress = (
  session: Pick<TerminalSession, 'protocol' | 'hostname' | 'moshEnabled' | 'etEnabled'>,
): string | null => {
  const protocol = session.protocol ?? 'ssh';
  if (
    session.moshEnabled
    || session.etEnabled
    || (protocol !== 'ssh' && protocol !== 'telnet')
    || !session.hostname
  ) {
    return null;
  }
  return session.hostname;
};

export const formatSessionTopTabTooltip = (
  session: Pick<TerminalSession, 'protocol' | 'hostname' | 'moshEnabled' | 'etEnabled' | 'username' | 'port'>,
): string | null => {
  const address = getSessionTopTabAddress(session);
  if (!address) return null;
  return `${session.username ? `${session.username}@` : ''}${address}${session.port ? `:${session.port}` : ''}`;
};

export const formatSessionTopTabLabel = (
  session: Pick<
    TerminalSession,
    'customName' | 'hostLabel' | 'dynamicTitle' | 'codingCliProviderId' | 'protocol' | 'hostname' | 'moshEnabled' | 'etEnabled'
  >,
  dynamicTabTitleMode?: DynamicTabTitleMode,
): string => {
  return resolveSessionTabTitle(session, dynamicTabTitleMode);
};

export const createTopTabCopyDoubleClickHandler = (
  onCopySession: (sessionId: string) => void,
  sessionId: string,
): React.MouseEventHandler<HTMLDivElement> => () => onCopySession(sessionId);

export const stopCloseButtonDoubleClickPropagation = (
  event: Pick<React.MouseEvent, 'stopPropagation'>,
): void => {
  event.stopPropagation();
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

  const controlClassName = 'window-control-btn app-no-drag';
  const closeControlClassName = 'window-control-btn window-control-btn--close app-no-drag';

  return (
    <div className="ml-2 flex items-center h-7 overflow-visible app-no-drag">
      <button type="button" className={controlClassName} onClick={handleMinimize}>
        <Minus size={16} />
      </button>
      <button type="button" className={controlClassName} onClick={handleMaximize}>
        {isMaximized ? <Copy size={14} /> : <Square size={14} />}
      </button>
      <button type="button" className={closeControlClassName} onClick={handleClose}>
        <X size={16} />
      </button>
    </div>
  );
});
WindowControls.displayName = 'WindowControls';

type TranslateFn = ReturnType<typeof useI18n>['t'];
type RenderBulkCloseItems = (anchorId: string) => React.ReactNode;

const TOP_TAB_COMFORT_EDGE_RATIO = 0.22;
const TOP_TAB_COMFORT_EDGE_MIN = 72;
const TOP_TAB_COMFORT_EDGE_MAX = 160;

export function scrollTopTabIntoComfortView(
  container: HTMLDivElement | null,
  tab: HTMLElement | null,
  behavior: ScrollBehavior = 'smooth',
) {
  if (!container || !tab) return;
  if (container.scrollWidth <= container.clientWidth) return;

  const containerRect = container.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const edgeBuffer = Math.min(
    TOP_TAB_COMFORT_EDGE_MAX,
    Math.max(TOP_TAB_COMFORT_EDGE_MIN, containerRect.width * TOP_TAB_COMFORT_EDGE_RATIO),
  );
  const isNearLeft = tabRect.left < containerRect.left + edgeBuffer;
  const isNearRight = tabRect.right > containerRect.right - edgeBuffer;

  if (!isNearLeft && !isNearRight) return;

  const tabCenter =
    tabRect.left - containerRect.left + container.scrollLeft + tabRect.width / 2;
  const maxScrollLeft = container.scrollWidth - container.clientWidth;
  const targetLeft = Math.max(
    0,
    Math.min(maxScrollLeft, tabCenter - container.clientWidth / 2),
  );

  if (Math.abs(container.scrollLeft - targetLeft) < 1) return;
  container.scrollTo({ left: targetLeft, behavior });
}

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
    scrollTopTabIntoComfortView(container, activeTabElement, 'smooth');

    const scrollStateTimer = setTimeout(updateScrollState, 260);
    return () => clearTimeout(scrollStateTimer);
  }, [activeTabId, tabsContainerRef, updateScrollState]);

  return null;
});
ActiveTabAutoScroller.displayName = 'ActiveTabAutoScroller';

interface RootTopTabProps {
  tabId: 'vault' | 'sftp';
  label: string;
  icon: React.ReactNode;
  className?: string;
  compact?: boolean;
}

export const RootTopTab: React.FC<RootTopTabProps> = memo(({ tabId, label, icon, className, compact = false }) => {
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
        "netcatty-tab relative h-7 overflow-hidden text-xs font-semibold cursor-pointer flex items-center app-no-drag transition-[padding,gap] duration-300 ease-out",
        compact ? "px-2 gap-0" : "px-3 gap-2",
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
      {icon}
      <span className={cn('top-tab-root-label', compact && 'top-tab-root-label-compact')}>
        {label}
      </span>
    </div>
  );
});
RootTopTab.displayName = 'RootTopTab';

interface PluginViewTopTabProps {
  tab: PluginViewTab;
  onClose(tabId: string): void;
  renderBulkCloseItems: RenderBulkCloseItems;
  t: TranslateFn;
  isBeingDragged: boolean;
  isDraggingForReorder: boolean;
  shiftStyle: React.CSSProperties;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
  onTabDragStart(e: React.DragEvent, tabId: string): void;
  onTabDragEnd(): void;
  onTabDragOver(e: React.DragEvent, tabId: string): void;
  onTabDragLeave(e: React.DragEvent): void;
  onTabDrop(e: React.DragEvent, tabId: string): void;
  tabAnimationClass?: string;
}

export const PluginViewTopTab: React.FC<PluginViewTopTabProps> = memo(({
  tab,
  onClose,
  renderBulkCloseItems,
  t,
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
  tabAnimationClass,
}) => {
  const isActive = useIsTabActive(tab.id);
  const close = useCallback((event?: React.MouseEvent) => {
    event?.stopPropagation();
    onClose(tab.id);
  }, [onClose, tab.id]);
  const tabBody = (
        <div
          data-tab-id={tab.id}
          data-tab-type="plugin-view"
          data-state={isActive ? 'active' : 'inactive'}
          onClick={() => activeTabStore.setActiveTabId(tab.id)}
          onMouseDown={handleTabMiddleMouseDown}
          onAuxClick={(event) => handleTabMiddleClickClose(event, close)}
          draggable
          onDragStart={(event) => onTabDragStart(event, tab.id)}
          onDragEnd={onTabDragEnd}
          onDragOver={(event) => onTabDragOver(event, tab.id)}
          onDragLeave={onTabDragLeave}
          onDrop={(event) => onTabDrop(event, tab.id)}
          className={cn(
            'netcatty-tab relative h-7 min-w-[140px] max-w-[240px] flex-shrink-0 cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-t-md pl-3 pr-2 text-xs font-semibold app-no-drag',
            'flex transition-transform duration-150',
            isBeingDragged && isDraggingForReorder && 'scale-95 opacity-40',
            tabAnimationClass,
          )}
          style={{
            ...shiftStyle,
            backgroundColor: isActive ? 'var(--top-tabs-active-bg, hsl(var(--background)))' : 'transparent',
            color: isActive ? 'var(--top-tabs-fg, hsl(var(--foreground)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
          }}
        >
          {showDropIndicatorBefore && isDraggingForReorder && <div className="absolute -left-0.5 bottom-1 top-1 w-0.5 rounded-full bg-primary" />}
          {showDropIndicatorAfter && isDraggingForReorder && <div className="absolute -right-0.5 bottom-1 top-1 w-0.5 rounded-full bg-primary" />}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <PluginContributionIcon pluginId={tab.pluginId} icon={tab.icon} className="shrink-0" />
            <span className="truncate leading-5">{tab.title}</span>
          </div>
          <button onClick={close} className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted" aria-label={t('tabs.closePluginViewAria', { title: tab.title })}><X size={12} /></button>
        </div>
  );
  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>{tabBody}</ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tab.pluginName}</TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onClose(tab.id)}>{t('common.close')}</ContextMenuItem>
        {renderBulkCloseItems(tab.id)}
      </ContextMenuContent>
    </ContextMenu>
  );
});
PluginViewTopTab.displayName = 'PluginViewTopTab';

interface EditorTopTabProps {
  tabId: string;
  editorTab: EditorTabChrome;
  host: Host | undefined;
  suffix: string;
  onRequestCloseEditorTab: (editorTabId: string) => void;
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
  tabAnimationClass?: string;
}

export const EditorTopTab: React.FC<EditorTopTabProps> = memo(({
  tabId,
  editorTab,
  host,
  suffix,
  onRequestCloseEditorTab,
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
  tabAnimationClass,
}) => {
  const isActive = useIsTabActive(tabId);
  // Dirty is store-driven so App/TopTabs structure can stay presence-only.
  const dirty = useEditorTabDirty(editorTab.id);
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
          draggable
          onDragStart={(e) => onTabDragStart(e, tabId)}
          onDragEnd={onTabDragEnd}
          onDragOver={(e) => onTabDragOver(e, tabId)}
          onDragLeave={onTabDragLeave}
          onDrop={(e) => onTabDrop(e, tabId)}
          className={cn(
            "netcatty-tab relative h-7 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-t-md overflow-hidden text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
            "transition-transform duration-150",
            isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : "",
            tabAnimationClass,
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
            <FileIcon
              size={14}
              className="shrink-0"
              style={{ color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
            />
            <span className="flex items-center gap-0.5 truncate leading-5">
              {dirty && <span className="mr-0.5 text-primary">●</span>}
              {editorTab.fileName}
              {suffix && <span className="ml-1 text-muted-foreground">{suffix}</span>}
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
  onEditHost?: (host: Host) => void;
  renderBulkCloseItems: RenderBulkCloseItems;
  dynamicTabTitleMode?: DynamicTabTitleMode;
  t: TranslateFn;
  tabAnimationClass?: string;
}

export const SessionTopTab: React.FC<SessionTopTabProps> = memo(({
  session: sessionProp,
  host,
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
  onEditHost,
  renderBulkCloseItems,
  dynamicTabTitleMode,
  t,
  tabAnimationClass,
}) => {
  // Per-session presentation: sibling title/provider updates do not re-render this tab.
  const session = usePresentedSession(sessionProp);
  const isActive = useIsTabActive(session.id);
  // Per-session store snapshot so sibling activity dots do not re-render this tab.
  const hasActivity = useSessionActivity(session.id);
  const handleClick = useCallback(() => {
    activeTabStore.setActiveTabId(session.id);
  }, [session.id]);
  const handleDoubleClick = useMemo(
    () => createTopTabCopyDoubleClickHandler(onCopySession, session.id),
    [onCopySession, session.id],
  );
  const addressTooltip = formatSessionTopTabTooltip(session);
  const tabTitle = formatSessionTopTabLabel(session, dynamicTabTitleMode);

  const tabBody = (
    <div
      data-tab-id={session.id}
      data-tab-type="session"
      data-state={isActive ? 'active' : 'inactive'}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
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
        isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : "",
        tabAnimationClass,
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
        <SessionTabIcon
          host={host}
          session={session}
          isActive={isActive}
          protocol={session.protocol}
          shellIcon={session.localShellIcon}
          dynamicTabTitleMode={dynamicTabTitleMode}
        />
        <span className="truncate leading-5">{tabTitle}</span>
        <div className="flex-shrink-0">{sessionStatusDot(session.status, hasActivity)}</div>
      </div>
      <button
        onClick={(e) => onCloseSession(session.id, e)}
        onDoubleClick={stopCloseButtonDoubleClickPropagation}
        className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
        aria-label={t('tabs.closeSessionAria')}
      >
        <X size={12} />
      </button>
    </div>
  );

  const tabTrigger = (
    addressTooltip ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>{tabBody}</ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent
          sideOffset={6}
          className="rounded-md border border-border/60 bg-popover/95 px-2.5 py-1.5 font-mono text-[11px] font-medium leading-none text-foreground shadow-lg supports-[backdrop-filter]:backdrop-blur-sm"
        >
          {addressTooltip}
        </TooltipContent>
      </Tooltip>
    ) : (
      <ContextMenuTrigger asChild>{tabBody}</ContextMenuTrigger>
    )
  );

  return (
    <ContextMenu>
      {tabTrigger}
      <SessionTabContextMenuContent
        sessionId={session.id}
        onCloseSession={onCloseSession}
        onCopySession={onCopySession}
        onCopySessionToNewWindow={onCopySessionToNewWindow}
        onReconnectSession={terminalReconnectRegistry.request}
        sessionStatus={session.status}
        onRenameSession={onRenameSession}
        editHost={host}
        onEditHost={onEditHost}
        renderBulkCloseItems={renderBulkCloseItems}
        t={t}
      />
    </ContextMenu>
  );
});
SessionTopTab.displayName = 'SessionTopTab';

interface WorkspaceTopTabProps {
  workspace: Workspace;
  paneCount: number;
  workspaceSessionIds: readonly string[];
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
  onCopyWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onDetachSessionFromWorkspace?: (workspaceId: string, sessionId: string) => void;
  /** Sessions for Detach menu; each menu item applies live presentation itself. */
  workspaceSessions?: TerminalSession[];
  dynamicTabTitleMode?: DynamicTabTitleMode;
  renderBulkCloseItems: RenderBulkCloseItems;
  t: TranslateFn;
  tabAnimationClass?: string;
}

/**
 * Detach-menu row that subscribes to presentation for one session only, so
 * agent title updates stay live without remapping the whole TopTabs bar.
 */
const WorkspaceDetachSessionMenuItem: React.FC<{
  session: TerminalSession;
  workspaceId: string;
  dynamicTabTitleMode?: DynamicTabTitleMode;
  onDetach: (workspaceId: string, sessionId: string) => void;
  t: TranslateFn;
}> = memo(({ session: sessionProp, workspaceId, dynamicTabTitleMode, onDetach, t }) => {
  const session = usePresentedSession(sessionProp);
  const label = resolveSessionTabTitle(session, dynamicTabTitleMode);
  return (
    <ContextMenuItem onClick={() => onDetach(workspaceId, session.id)}>
      {t('terminal.menu.detachSession', { name: label })}
    </ContextMenuItem>
  );
});
WorkspaceDetachSessionMenuItem.displayName = 'WorkspaceDetachSessionMenuItem';

export const WorkspaceTopTab: React.FC<WorkspaceTopTabProps> = memo(({
  workspace,
  paneCount,
  workspaceSessionIds,
  workspaceSessions,
  dynamicTabTitleMode,
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
  onCopyWorkspace,
  onCloseWorkspace,
  onDetachSessionFromWorkspace,
  renderBulkCloseItems,
  t,
  tabAnimationClass,
}) => {
  const isActive = useIsTabActive(workspace.id);
  const hasActivity = useAnySessionActivity(workspaceSessionIds);
  const handleClick = useCallback(() => {
    activeTabStore.setActiveTabId(workspace.id);
  }, [workspace.id]);
  const handleDoubleClick = useMemo(
    () => createTopTabCopyDoubleClickHandler(onCopyWorkspace, workspace.id),
    [onCopyWorkspace, workspace.id],
  );
  const detachSessions = workspaceSessions ?? [];
  const tabLabel = resolveWorkspaceTabLabel(workspace, detachSessions);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-tab-id={workspace.id}
          data-tab-type="workspace"
          data-state={isActive ? 'active' : 'inactive'}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
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
            isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : "",
            tabAnimationClass,
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
            <span className="truncate leading-5" title={tabLabel}>{tabLabel}</span>
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
        <ContextMenuItem onClick={() => onCopyWorkspace(workspace.id)}>
          {t('tabs.copyTab')}
        </ContextMenuItem>
        {onDetachSessionFromWorkspace && detachSessions.map((session) => (
          <WorkspaceDetachSessionMenuItem
            key={session.id}
            session={session}
            workspaceId={workspace.id}
            dynamicTabTitleMode={dynamicTabTitleMode}
            onDetach={onDetachSessionFromWorkspace}
            t={t}
          />
        ))}
        {onDetachSessionFromWorkspace && detachSessions.length > 0 && (
          <ContextMenuSeparator />
        )}
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
  t: TranslateFn;
  tabAnimationClass?: string;
}

export const LogViewTopTab: React.FC<LogViewTopTabProps> = memo(({
  logView,
  onCloseLogView,
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
  t,
  tabAnimationClass,
}) => {
  const isActive = useIsTabActive(logView.id);
  const isLocal = logView.log.protocol === 'local' || logView.log.hostname === 'localhost';
  const handleClick = useCallback(() => {
    activateLogViewTab(logView.id);
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
      draggable
      onDragStart={(e) => onTabDragStart(e, logView.id)}
      onDragEnd={onTabDragEnd}
      onDragOver={(e) => onTabDragOver(e, logView.id)}
      onDragLeave={onTabDragLeave}
      onDrop={(e) => onTabDrop(e, logView.id)}
      className={cn(
        "netcatty-tab relative h-7 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-t-md overflow-hidden text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
        "transition-transform duration-150",
        isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : "",
        tabAnimationClass,
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
        <FileText
          size={14}
          className="shrink-0"
          style={{ color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
        />
        <span className="truncate leading-5">
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
