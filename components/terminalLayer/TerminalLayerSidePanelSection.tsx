/* eslint-disable @typescript-eslint/no-explicit-any */
import { Activity, FolderTree, History, Maximize2, MessageSquare, Minimize2, NotebookText, Palette, PanelLeft, PanelRight, Play, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import {
  buildSidePanelChromeThemeFromTerminalTheme,
  buildTerminalSidePanelCssVars,
} from '../../infrastructure/theme/terminalAppearanceTokens';
import { injectTerminalLayerChromeSurfaceVars } from '../../infrastructure/theme/terminalAppearanceVars';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { useActiveTabId } from '../../application/state/activeTabStore';
import {
  getSidePanelLiveSnapshot,
  subscribeSidePanelLiveSnapshot,
} from '../../application/state/sidePanelLiveStore';
import {
  reorderTerminalSidePanelTab,
  fitTerminalSidePanelTabs,
  TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
  TERMINAL_SIDE_PANEL_TAB_IDS,
  type TerminalSidePanelTabId,
  useTerminalSidePanelTabOrder,
} from '../../application/state/terminalSidePanelTabs';
import {
  clampTerminalSidePanelWidth,
  getTerminalSidePanelAvailableWidth,
  getTerminalSidePanelMaxShownTools,
  getTerminalSidePanelMaxWidth,
} from '../../application/state/terminalSidePanelWidth';
import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';

import {
  ToolbarCustomizeContextMenu,
  ToolbarOverflowMenu,
} from '../ui/toolbar-item-layout';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { SidePanelTab } from './TerminalLayerSupport';
import {
  MAX_SIDE_PANEL_PANES,
  canSplitSidePanelPaneAtSize,
  collectSidePanelPanes,
  getFocusedSidePanelPane,
  getSidePanelNodeMinimumPixels,
  getSidePanelSplitResizeBounds,
  SIDE_PANEL_SPLIT_DIVIDER_PIXELS,
  type SidePanelLayout,
  type SidePanelLayoutNode,
  type SidePanelSplitDirection,
  type SidePanelSplitNode,
} from '../../domain/sidePanelLayout';
import { terminalLayerSidePanelStableCtxEqual } from './terminalLayerViewMemo';
import { SidePanelMountedContent } from './terminalLayerSidePanelSlots';
import { getPaneMagnificationShortcutLabel } from '../../domain/paneMagnification';

const MemoizedSidePanelMountedContent = memo(
  SidePanelMountedContent,
  (prev, next) => (
    prev.paneHosts === next.paneHosts
    && prev.parkingHost === next.parkingHost
    && terminalLayerSidePanelStableCtxEqual(prev.ctx, next.ctx)
  ),
);
MemoizedSidePanelMountedContent.displayName = 'MemoizedSidePanelMountedContent';

type SidePanelContext = Record<string, any>;
const SIDE_PANEL_TAB_DRAG_MIME = 'application/x-netcatty-sidepanel-tab';

type SidePanelTabItem = {
  id: SidePanelTab;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
};

export function listenForSidePanelPaneFocus(
  target: EventTarget,
  onFocus: () => void,
): () => void {
  target.addEventListener('pointerdown', onFocus);
  target.addEventListener('focusin', onFocus);
  return () => {
    target.removeEventListener('pointerdown', onFocus);
    target.removeEventListener('focusin', onFocus);
  };
}

export function resolveMagnifiedSidePanelHosts<K, T>(
  paneHosts: ReadonlyMap<K, T>,
  magnifiedPane: { tool: K } | null,
  overlayHost: T | null,
): ReadonlyMap<K, T> {
  if (!magnifiedPane || !overlayHost) return paneHosts;
  return new Map(paneHosts).set(magnifiedPane.tool, overlayHost);
}

function SidePanelPaneHost({
  node,
  focused,
  paneCount,
  label,
  onClose,
  onFocus,
  onHostChange,
  closePaneLabel,
  separator,
  mutedColor,
}: {
  node: Extract<SidePanelLayoutNode, { type: 'pane' }>;
  focused: boolean;
  paneCount: number;
  label: string;
  onClose: (paneId: string) => void;
  onFocus: (paneId: string) => void;
  onHostChange: (tool: SidePanelTab, host: HTMLElement | null) => void;
  closePaneLabel: string;
  separator: string;
  mutedColor: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Registration happens after commit and only when the actual host changes.
  // This avoids state writes from ref callbacks and provides a parking window
  // for portals while a pane tree is being replaced.
  useLayoutEffect(() => {
    const host = hostRef.current;
    onHostChange(node.tool, host);
    const stopListening = host
      ? listenForSidePanelPaneFocus(host, () => onFocus(node.id))
      : null;
    return () => {
      stopListening?.();
      onHostChange(node.tool, null);
    };
  }, [node.id, node.tool, onFocus, onHostChange]);

  return (
    <div
      className="h-full w-full min-h-0 min-w-0 overflow-hidden flex flex-col relative"
      data-section="terminal-side-panel-pane"
      data-pane-id={node.id}
      data-pane-tool={node.tool}
      data-focused={focused ? 'true' : 'false'}
      onMouseDown={() => onFocus(node.id)}
      onFocusCapture={() => onFocus(node.id)}
    >
      {paneCount > 1 && (
        <div
          className="h-7 px-2 flex items-center gap-2 shrink-0 select-none"
          style={{
            borderBottom: `1px solid ${separator}`,
            boxShadow: focused ? `inset 2px 0 0 ${mutedColor}` : undefined,
          }}
        >
          <span className="text-[11px] font-medium truncate flex-1">{label}</span>
          <button
            type="button"
            className="h-5 w-5 grid place-items-center rounded-sm opacity-70 hover:opacity-100 hover:bg-white/10"
            aria-label={`${closePaneLabel}: ${label}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClose(node.id);
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        className="relative flex-1 min-h-0 min-w-0 overflow-hidden [contain:strict]"
        data-section="terminal-side-panel-pane-content"
      />
    </div>
  );
}

function SidePanelSplitView({
  node,
  children,
  onResize,
  separator,
  resizeLabel,
}: {
  node: SidePanelSplitNode;
  children: React.ReactNode[];
  onResize: (splitId: string, sizes: number[]) => void;
  separator: string;
  resizeLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const normalizedSizes = useMemo(() => {
    const total = node.sizes.reduce((sum, size) => sum + size, 0) || 1;
    return node.children.map((_, index) => (node.sizes[index] ?? 1) / total);
  }, [node.children, node.sizes]);
  const [previewSizes, setPreviewSizes] = useState<number[] | null>(null);
  const renderedSizes = previewSizes ?? normalizedSizes;

  useLayoutEffect(() => () => {
    resizeCleanupRef.current?.();
  }, []);

  const startResize = useCallback((event: React.MouseEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const axisLength = (node.direction === 'vertical' ? rect.width : rect.height)
      - Math.max(0, node.children.length - 1) * SIDE_PANEL_SPLIT_DIVIDER_PIXELS;
    if (axisLength <= 0) return;

    resizeCleanupRef.current?.();
    terminalLayoutSuppressStore.begin();
    const startClient = node.direction === 'vertical' ? event.clientX : event.clientY;
    const startSizes = [...normalizedSizes];
    const pairSize = startSizes[index] + startSizes[index + 1];
    const { firstMin, firstMax } = getSidePanelSplitResizeBounds(
      node,
      index,
      pairSize,
      axisLength,
    );
    let frame: number | null = null;
    let pendingClient = startClient;

    let latestSizes = startSizes;
    const updatePreview = () => {
      frame = null;
      const delta = (pendingClient - startClient) / axisLength;
      const first = Math.max(firstMin, Math.min(firstMax, startSizes[index] + delta));
      const next = [...startSizes];
      next[index] = first;
      next[index + 1] = pairSize - first;
      latestSizes = next;
      setPreviewSizes(next);
    };
    const onMouseMove = (moveEvent: MouseEvent) => {
      pendingClient = node.direction === 'vertical' ? moveEvent.clientX : moveEvent.clientY;
      if (frame === null) frame = requestAnimationFrame(updatePreview);
    };
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      terminalLayoutSuppressStore.end();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', finish);
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };
    const finish = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        updatePreview();
      }
      onResize(node.id, latestSizes);
      setPreviewSizes(null);
      cleanup();
    };
    const onMouseUp = () => finish();
    resizeCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', finish);
  }, [node, normalizedSizes, onResize]);

  return (
    <div
      ref={containerRef}
      className={node.direction === 'vertical'
        ? 'h-full w-full min-h-0 min-w-0 flex flex-row overflow-hidden'
        : 'h-full w-full min-h-0 min-w-0 flex flex-col overflow-hidden'}
      data-section="terminal-side-panel-split"
      data-split-id={node.id}
      data-split-direction={node.direction}
    >
      {children.map((child, index) => (
        <React.Fragment key={node.children[index].id}>
          <div
            className="min-h-0 min-w-0 overflow-hidden relative"
            style={{ flexBasis: 0, flexGrow: renderedSizes[index] }}
          >
            {child}
          </div>
          {index < children.length - 1 && (
            <div
              className={node.direction === 'vertical'
                ? "group relative w-px shrink-0 cursor-ew-resize z-20 after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2"
                : "group relative h-px shrink-0 cursor-ns-resize z-20 after:content-[''] after:absolute after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2"}
              data-section="terminal-side-panel-split-resizer"
              role="separator"
              tabIndex={0}
              aria-label={resizeLabel}
              aria-orientation={node.direction === 'vertical' ? 'vertical' : 'horizontal'}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(
                (renderedSizes[index] / (renderedSizes[index] + renderedSizes[index + 1])) * 100,
              )}
              onMouseDown={(event) => startResize(event, index)}
              onKeyDown={(event) => {
                const decrease = node.direction === 'vertical'
                  ? event.key === 'ArrowLeft'
                  : event.key === 'ArrowUp';
                const increase = node.direction === 'vertical'
                  ? event.key === 'ArrowRight'
                  : event.key === 'ArrowDown';
                if (!decrease && !increase) return;
                event.preventDefault();
                const next = [...renderedSizes];
                const pairSize = next[index] + next[index + 1];
                const rect = containerRef.current?.getBoundingClientRect();
                const axisLength = (node.direction === 'vertical'
                  ? (rect?.width ?? 0)
                  : (rect?.height ?? 0))
                  - Math.max(0, node.children.length - 1) * SIDE_PANEL_SPLIT_DIVIDER_PIXELS;
                const { firstMin, firstMax } = getSidePanelSplitResizeBounds(
                  node,
                  index,
                  pairSize,
                  axisLength,
                );
                const first = Math.max(
                  firstMin,
                  Math.min(firstMax, next[index] + (decrease ? -0.04 : 0.04)),
                );
                next[index] = first;
                next[index + 1] = pairSize - first;
                onResize(node.id, next);
              }}
            >
              <div
                className={node.direction === 'vertical'
                  ? 'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover:w-0.5'
                  : 'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover:h-0.5'}
                style={{ backgroundColor: separator }}
              />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function SidePanelLayoutTree({
  node,
  layout,
  paneCount,
  labels,
  onClose,
  onFocus,
  onHostChange,
  onResize,
  separator,
  accent,
  closePaneLabel,
  resizeLabel,
}: {
  node: SidePanelLayoutNode;
  layout: SidePanelLayout;
  paneCount: number;
  labels: ReadonlyMap<SidePanelTab, string>;
  onClose: (paneId: string) => void;
  onFocus: (paneId: string) => void;
  onHostChange: (tool: SidePanelTab, host: HTMLElement | null) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  separator: string;
  accent: string;
  closePaneLabel: string;
  resizeLabel: string;
}): React.ReactNode {
  if (node.type === 'pane') {
    return (
      <SidePanelPaneHost
        node={node}
        focused={layout.focusedPaneId === node.id}
        paneCount={paneCount}
        label={labels.get(node.tool) ?? node.tool}
        onClose={onClose}
        onFocus={onFocus}
        onHostChange={onHostChange}
        closePaneLabel={closePaneLabel}
        separator={separator}
        mutedColor={accent}
      />
    );
  }

  return (
    <SidePanelSplitView
      node={node}
      onResize={onResize}
      separator={separator}
      resizeLabel={resizeLabel}
    >
      {node.children.map((child) => (
        <SidePanelLayoutTree
          key={child.id}
          node={child}
          layout={layout}
          paneCount={paneCount}
          labels={labels}
          onClose={onClose}
          onFocus={onFocus}
          onHostChange={onHostChange}
          onResize={onResize}
          separator={separator}
          accent={accent}
          closePaneLabel={closePaneLabel}
          resizeLabel={resizeLabel}
        />
      ))}
    </SidePanelSplitView>
  );
}

function SidePanelSplitMenu({
  direction,
  items,
  occupiedTools,
  disabled,
  onSelect,
  t,
  buttonColor,
}: {
  direction: SidePanelSplitDirection;
  items: SidePanelTabItem[];
  occupiedTools: ReadonlySet<SidePanelTab>;
  disabled: boolean;
  onSelect: (tool: SidePanelTab, direction: SidePanelSplitDirection) => void;
  t: (key: string) => string;
  buttonColor: string;
}) {
  const available = items.filter((item) => !occupiedTools.has(item.id));
  const label = direction === 'horizontal'
    ? t('terminal.layer.splitHorizontal')
    : t('terminal.layer.splitVertical');

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled || available.length === 0}
              className="h-7 w-7 rounded-md p-0 grid place-items-center disabled:opacity-35"
              style={{ color: buttonColor }}
              aria-label={label}
            >
              {direction === 'horizontal'
                ? <SplitSquareVertical size={15} />
                : <SplitSquareHorizontal size={15} />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="bottom" className="w-52 p-1">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('terminal.layer.openInNewSplit')}
        </div>
        {available.map((item) => (
          <PopoverClose asChild key={item.id}>
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary text-left"
              onClick={() => onSelect(item.id, direction)}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function getTerminalSidePanelShellWidth({
  activeSidePanelTab,
  forceHideAiShell,
  isSidePanelOpenForCurrentTab,
  resizePreviewWidth,
  sidePanelWidth,
}: {
  activeSidePanelTab: SidePanelTab | null;
  forceHideAiShell: boolean;
  isSidePanelOpenForCurrentTab: boolean;
  resizePreviewWidth: number | null;
  sidePanelWidth: number;
}): number {
  if (forceHideAiShell && activeSidePanelTab === 'ai') return 0;
  return isSidePanelOpenForCurrentTab
    ? (resizePreviewWidth ?? sidePanelWidth)
    : 0;
}

function hasMountedSidePanelContent(ctx: SidePanelContext): boolean {
  const {
    mountedAiTabIds,
    mountedSftpTabIds,
    notesMountedTabIds,
    scriptsMountedTabIds,
    systemMountedTabIds,
    themeMountedTabIds,
    sidePanelOpenTabs,
  } = ctx;

  const anyHistoryOpen = sidePanelOpenTabs instanceof Map
    && Array.from((sidePanelOpenTabs as Map<string, SidePanelTab>).values()).includes('history');
  const anyNotesOpen = sidePanelOpenTabs instanceof Map
    && Array.from((sidePanelOpenTabs as Map<string, SidePanelTab>).values()).includes('notes');

  return !(
    mountedSftpTabIds.length === 0
    && mountedAiTabIds.length === 0
    && notesMountedTabIds.length === 0
    && scriptsMountedTabIds.length === 0
    && systemMountedTabIds.length === 0
    && themeMountedTabIds.length === 0
    && !anyHistoryOpen
    && !anyNotesOpen
  );
}

function TerminalLayerSidePanelSectionInner({ ctx }: { ctx: SidePanelContext }) {
  if (!hasMountedSidePanelContent(ctx)) {
    // Keep AI scope maintenance alive even with zero mounted tool panels so
    // merge/dissolve handoff still runs when the user closed AI before the
    // workspace topology change.
    const AISidePanelStateRoot = ctx.AISidePanelStateRoot as
      | React.ComponentType<{
        validAIScopeTargetIds: Set<string>;
        workspaces: import('../../types').Workspace[];
        children: React.ReactNode;
      }>
      | undefined;
    if (!AISidePanelStateRoot) return null;
    return (
      <AISidePanelStateRoot
        validAIScopeTargetIds={ctx.validAIScopeTargetIds as Set<string>}
        workspaces={ctx.workspaces as import('../../types').Workspace[]}
      >
        {null}
      </AISidePanelStateRoot>
    );
  }
  return <TerminalLayerSidePanelInner ctx={ctx} />;
}

/** Skip chrome rebuilds when only live/workspace-focus ticks change. */
export const TerminalLayerSidePanelSection = memo(
  TerminalLayerSidePanelSectionInner,
  (prev, next) => terminalLayerSidePanelStableCtxEqual(prev.ctx, next.ctx),
);
TerminalLayerSidePanelSection.displayName = 'TerminalLayerSidePanelSection';

function TerminalLayerSidePanelInner({ ctx }: { ctx: SidePanelContext }) {
  const activeTabId = useActiveTabId();
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const sidePanelLayouts = ctx.sidePanelLayouts as Map<string, SidePanelLayout>;
  const isSidePanelOpenForCurrentTab = activeTabId ? sidePanelOpenTabs.has(activeTabId) : false;
  const activeSidePanelTab = activeTabId ? sidePanelOpenTabs.get(activeTabId) ?? null : null;
  const activeSidePanelLayout = activeTabId ? sidePanelLayouts.get(activeTabId) ?? null : null;

  const {
    Button: Btn,
    cn,
    followAppTerminalTheme,
    handleCloseSidePanel,
    handleOpenAI,
    handleOpenHistory,
    handleOpenNotes,
    handleOpenScripts,
    handleOpenSystem,
    handleOpenTheme,
    handleFocusSidePanelPane,
    handleMagnifySidePanelPane,
    handleRestoreMagnifiedPane,
    handleSplitSidePanelPane,
    handleCloseSidePanelPane,
    handleResizeSidePanelSplit,
    handleToggleSftpFromBar,
    resolvedPreviewTheme: ctxResolvedPreviewTheme,
    setSidePanelPosition,
    setSidePanelWidth,
    persistSidePanelWidth,
    sidePanelPosition,
    sidePanelWidth,
    t,
    terminalTheme,
    hotkeyScheme,
    keyBindings,
    magnifiedPane,
  } = ctx;

  // Live theme for chrome when panel is open and not follow-app — stable memo
  // no longer receives focus-driven resolvedPreviewTheme via ctx.
  const subscribeLiveTheme = isSidePanelOpenForCurrentTab && !followAppTerminalTheme;
  const liveSnapshot = useSyncExternalStore(
    (listener) => subscribeSidePanelLiveSnapshot(subscribeLiveTheme, listener),
    () => getSidePanelLiveSnapshot(subscribeLiveTheme),
    () => getSidePanelLiveSnapshot(subscribeLiveTheme),
  );
  const resolvedPreviewTheme = followAppTerminalTheme
    ? null
    : (subscribeLiveTheme
      ? (liveSnapshot.resolvedPreviewTheme ?? ctxResolvedPreviewTheme)
      : ctxResolvedPreviewTheme);

  const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const shellResizeCleanupRef = useRef<(() => void) | null>(null);
  const [availableSurfaceWidth, setAvailableSurfaceWidth] = useState(0);
  const availableSurfaceWidthRef = useRef(availableSurfaceWidth);
  const [paneHosts, setPaneHosts] = useState<Map<SidePanelTab, HTMLElement>>(new Map());
  const [parkingHost, setParkingHost] = useState<HTMLElement | null>(null);
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const parkingHostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setParkingHost(parkingHostRef.current);
    return () => setParkingHost(null);
  }, []);
  useLayoutEffect(() => () => {
    shellResizeCleanupRef.current?.();
  }, []);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const terminalLayer = shell?.parentElement;
    if (!terminalLayer) return undefined;
    setOverlayRoot(terminalLayer);

    let observedFocusSidebar: Element | null = null;
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => updateAvailableWidth());
    const updateAvailableWidth = () => {
      const focusSidebar = terminalLayer.querySelector('[data-section="terminal-workspace-sidebar"]');
      if (resizeObserver && focusSidebar !== observedFocusSidebar) {
        if (observedFocusSidebar) resizeObserver.unobserve(observedFocusSidebar);
        observedFocusSidebar = focusSidebar;
        if (focusSidebar) resizeObserver.observe(focusSidebar);
      }
      const nextWidth = getTerminalSidePanelAvailableWidth(
        terminalLayer.getBoundingClientRect().width,
        focusSidebar?.getBoundingClientRect().width ?? 0,
      );
      availableSurfaceWidthRef.current = nextWidth;
      setAvailableSurfaceWidth((current) => current === nextWidth ? current : nextWidth);
    };

    updateAvailableWidth();
    resizeObserver?.observe(terminalLayer);
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(updateAvailableWidth);
    mutationObserver?.observe(terminalLayer, { childList: true });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observedFocusSidebar = null;
      setOverlayRoot(null);
    };
  }, []);
  const handlePaneHostChange = useCallback((tool: SidePanelTab, host: HTMLElement | null) => {
    setPaneHosts((current) => {
      if (host && current.get(tool) === host) return current;
      if (!host && !current.has(tool)) return current;
      const next = new Map(current);
      if (host) next.set(tool, host);
      else next.delete(tool);
      return next;
    });
  }, []);
  const {
    sidePanelTabOrder,
    setSidePanelTabOrder,
    layout: sidePanelTabLayout,
    setPlacement: setSidePanelTabPlacement,
    move: moveSidePanelTab,
    resetLayout: resetSidePanelTabLayout,
    partition: partitionSidePanelTabs,
  } = useTerminalSidePanelTabOrder();
  const resolvedSidePanelTerminalTheme = useMemo(() => (
    followAppTerminalTheme
      ? terminalTheme
      : (resolvedPreviewTheme ?? terminalTheme)
  ), [followAppTerminalTheme, resolvedPreviewTheme, terminalTheme]);
  const sidePanelTheme = useMemo(
    () => buildSidePanelChromeThemeFromTerminalTheme(resolvedSidePanelTerminalTheme),
    [resolvedSidePanelTerminalTheme],
  );
  const sidePanelCssVars = useMemo(
    () => buildTerminalSidePanelCssVars(resolvedSidePanelTerminalTheme),
    [resolvedSidePanelTerminalTheme],
  );

  useLayoutEffect(() => {
    if (!isSidePanelOpenForCurrentTab) return;
    const chromeTheme = followAppTerminalTheme
      ? terminalTheme
      : (resolvedPreviewTheme ?? terminalTheme);
    injectTerminalLayerChromeSurfaceVars(chromeTheme);
  }, [
    followAppTerminalTheme,
    isSidePanelOpenForCurrentTab,
    resolvedPreviewTheme,
    terminalTheme,
  ]);

  const [dragOverSidePanelTab, setDragOverSidePanelTab] = useState<{
    tab: TerminalSidePanelTabId;
    placement: 'before' | 'after';
  } | null>(null);
  const draggedSidePanelTabRef = useRef<TerminalSidePanelTabId | null>(null);
  const activePaneCount = activeSidePanelLayout
    ? collectSidePanelPanes(activeSidePanelLayout.root).length
    : 0;
  const isAiShellForceHidden = AI_PANEL_FORCE_HIDE_SHELL
    && activeSidePanelTab === 'ai'
    && activePaneCount <= 1;
  const requestedShellWidth = getTerminalSidePanelShellWidth({
    activeSidePanelTab,
    forceHideAiShell: AI_PANEL_FORCE_HIDE_SHELL && activePaneCount <= 1,
    isSidePanelOpenForCurrentTab,
    resizePreviewWidth,
    sidePanelWidth,
  });
  const sidePanelContentMinimumWidth = activeSidePanelLayout
    ? getSidePanelNodeMinimumPixels(activeSidePanelLayout.root, 'vertical')
    : 0;
  const shellWidth = requestedShellWidth > 0
    ? clampTerminalSidePanelWidth(
      requestedShellWidth,
      availableSurfaceWidth,
      sidePanelContentMinimumWidth,
    )
    : 0;

  const handleSidePanelResizeStart = useCallback((event: React.MouseEvent) => {
    if (!isSidePanelOpenForCurrentTab) return;
    event.preventDefault();
    shellResizeCleanupRef.current?.();
    terminalLayoutSuppressStore.begin();
    const startX = event.clientX;
    const startWidth = shellRef.current?.getBoundingClientRect().width ?? shellWidth;
    let lastWidth = startWidth;
    let rafId: number | null = null;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      lastWidth = clampTerminalSidePanelWidth(
        startWidth + (sidePanelPosition === 'left' ? delta : -delta),
        availableSurfaceWidthRef.current,
        sidePanelContentMinimumWidth,
      );
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setResizePreviewWidth(lastWidth);
      });
    };
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      terminalLayoutSuppressStore.end();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('blur', finish);
      if (shellResizeCleanupRef.current === cleanup) shellResizeCleanupRef.current = null;
    };
    const finish = () => {
      setSidePanelWidth(lastWidth);
      persistSidePanelWidth(lastWidth);
      setResizePreviewWidth(null);
      cleanup();
    };
    shellResizeCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', finish);
    window.addEventListener('blur', finish);
  }, [
    isSidePanelOpenForCurrentTab,
    persistSidePanelWidth,
    setSidePanelWidth,
    sidePanelContentMinimumWidth,
    sidePanelPosition,
    shellWidth,
  ]);

  const handleSidePanelTabDragStart = useCallback((event: React.DragEvent, tab: TerminalSidePanelTabId) => {
    draggedSidePanelTabRef.current = tab;
    setDragOverSidePanelTab(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(SIDE_PANEL_TAB_DRAG_MIME, tab);
    event.dataTransfer.setData('text/plain', tab);
  }, []);

  const handleSidePanelTabDrop = useCallback((event: React.DragEvent, targetTab: TerminalSidePanelTabId) => {
    if (!Array.from(event.dataTransfer.types).includes(SIDE_PANEL_TAB_DRAG_MIME)) return;
    event.preventDefault();
    const transferredTab = event.dataTransfer.getData(SIDE_PANEL_TAB_DRAG_MIME) as TerminalSidePanelTabId;
    const draggedTab = draggedSidePanelTabRef.current ?? transferredTab;
    draggedSidePanelTabRef.current = null;
    setDragOverSidePanelTab(null);
    if (!TERMINAL_SIDE_PANEL_TAB_IDS.has(draggedTab)) return;

    const nextOrder = reorderTerminalSidePanelTab(
      sidePanelTabOrder,
      draggedTab,
      targetTab,
      dragOverSidePanelTab?.tab === targetTab ? dragOverSidePanelTab.placement : 'before',
    );
    if (nextOrder !== sidePanelTabOrder) {
      setSidePanelTabOrder(nextOrder);
    }
  }, [dragOverSidePanelTab, setSidePanelTabOrder, sidePanelTabOrder]);

  const handleSidePanelTabDragOver = useCallback((event: React.DragEvent, targetTab: TerminalSidePanelTabId) => {
    if (!Array.from(event.dataTransfer.types).includes(SIDE_PANEL_TAB_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientX > rect.left + (rect.width / 2) ? 'after' : 'before';
    setDragOverSidePanelTab((current) => {
      if (current?.tab === targetTab && current.placement === placement) return current;
      return { tab: targetTab, placement };
    });
  }, []);

  const handleSidePanelTabDragLeave = useCallback((event: React.DragEvent, targetTab: TerminalSidePanelTabId) => {
    if (dragOverSidePanelTab?.tab !== targetTab) return;
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setDragOverSidePanelTab(null);
  }, [dragOverSidePanelTab]);

  const sidePanelTabItems = useMemo<SidePanelTabItem[]>(() => [
    { id: 'sftp' as const, label: t('terminal.layer.sftp'), icon: <FolderTree size={15} />, onClick: handleToggleSftpFromBar },
    { id: 'scripts' as const, label: t('terminal.layer.scripts'), icon: <Play size={15} />, onClick: handleOpenScripts },
    { id: 'history' as const, label: t('terminal.layer.history'), icon: <History size={15} />, onClick: handleOpenHistory },
    { id: 'theme' as const, label: t('terminal.layer.theme'), icon: <Palette size={15} />, onClick: handleOpenTheme },
    { id: 'system' as const, label: t('terminal.layer.system'), icon: <Activity size={15} />, onClick: handleOpenSystem },
    { id: 'notes' as const, label: t('terminal.layer.notes'), icon: <NotebookText size={15} />, onClick: handleOpenNotes },
    { id: 'ai' as const, label: t('terminal.layer.aiChat'), icon: <MessageSquare size={15} />, onClick: handleOpenAI },
  ], [
    handleOpenAI,
    handleOpenHistory,
    handleOpenNotes,
    handleOpenScripts,
    handleOpenSystem,
    handleOpenTheme,
    handleToggleSftpFromBar,
    t,
  ]);
  const sidePanelTabItemById = useMemo(
    () => new Map(sidePanelTabItems.map((item) => [item.id, item])),
    [sidePanelTabItems],
  );
  const sidePanelToolLabels = useMemo(
    () => new Map(sidePanelTabItems.map((item) => [item.id, item.label])),
    [sidePanelTabItems],
  );
  const occupiedSidePanelTools = useMemo(
    () => new Set(activeSidePanelLayout
      ? collectSidePanelPanes(activeSidePanelLayout.root).map((pane) => pane.tool)
      : []),
    [activeSidePanelLayout],
  );
  const focusedPane = activeSidePanelLayout
    ? getFocusedSidePanelPane(activeSidePanelLayout)
    : null;
  const focusedPaneHost = focusedPane ? paneHosts.get(focusedPane.tool) ?? null : null;
  const activeSidePanelPanes = useMemo(
    () => activeSidePanelLayout ? collectSidePanelPanes(activeSidePanelLayout.root) : [],
    [activeSidePanelLayout],
  );
  const activeMagnifiedPane = !!activeTabId && magnifiedPane?.tabId === activeTabId
    ? magnifiedPane
    : null;
  const magnifiedSidePane = activeMagnifiedPane?.target.kind === 'side-panel'
    ? activeSidePanelPanes.find((pane) => pane.id === activeMagnifiedPane.target.paneId) ?? null
    : null;
  const paneMagnificationShortcutLabel = getPaneMagnificationShortcutLabel(keyBindings, hotkeyScheme);
  const [showMagnificationHint, setShowMagnificationHint] = useState(false);
  useEffect(() => {
    if (!magnifiedSidePane) {
      setShowMagnificationHint(false);
      return undefined;
    }
    setShowMagnificationHint(true);
    const timerId = window.setTimeout(() => setShowMagnificationHint(false), 1800);
    return () => window.clearTimeout(timerId);
  }, [magnifiedSidePane]);
  const panePortalHosts = useMemo(() => {
    return resolveMagnifiedSidePanelHosts(paneHosts, magnifiedSidePane, overlayHost);
  }, [magnifiedSidePane, overlayHost, paneHosts]);
  const [focusedPaneSplitAvailability, setFocusedPaneSplitAvailability] = useState({
    horizontal: false,
    vertical: false,
  });
  useLayoutEffect(() => {
    const pane = focusedPaneHost?.closest<HTMLElement>('[data-section="terminal-side-panel-pane"]');
    if (!pane) {
      setFocusedPaneSplitAvailability((current) => (
        !current.horizontal && !current.vertical
          ? current
          : { horizontal: false, vertical: false }
      ));
      return undefined;
    }
    const update = () => {
      const rect = pane.getBoundingClientRect();
      const next = {
        horizontal: canSplitSidePanelPaneAtSize(rect.height),
        vertical: canSplitSidePanelPaneAtSize(rect.width),
      };
      setFocusedPaneSplitAvailability((current) => (
        current.horizontal === next.horizontal && current.vertical === next.vertical
          ? current
          : next
      ));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [focusedPaneHost]);

  const handleSplitSidePanelSelect = useCallback((
    tool: SidePanelTab,
    direction: SidePanelSplitDirection,
  ) => {
    const pane = focusedPaneHost?.closest<HTMLElement>('[data-section="terminal-side-panel-pane"]');
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    const availableAxisLength = direction === 'vertical' ? rect.width : rect.height;
    handleSplitSidePanelPane(tool, direction, availableAxisLength);
  }, [focusedPaneHost, handleSplitSidePanelPane]);

  const { shown: configuredShownSidePanelTabs, collapsed: configuredCollapsedSidePanelTabs } = useMemo(() => {
    const parts = partitionSidePanelTabs(TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);
    // If an external path opens a hidden tab, still show its chip while active.
    if (
      activeSidePanelTab &&
      !parts.shown.includes(activeSidePanelTab) &&
      !parts.collapsed.includes(activeSidePanelTab)
    ) {
      return {
        shown: [...parts.shown, activeSidePanelTab],
        collapsed: parts.collapsed,
        hidden: parts.hidden.filter((id) => id !== activeSidePanelTab),
      };
    }
    return parts;
  }, [activeSidePanelTab, partitionSidePanelTabs]);
  const { shown: shownSidePanelTabs, collapsed: collapsedSidePanelTabs } = useMemo(
    () => fitTerminalSidePanelTabs({
      shown: configuredShownSidePanelTabs,
      collapsed: configuredCollapsedSidePanelTabs,
      active: activeSidePanelTab,
      maxShown: getTerminalSidePanelMaxShownTools(shellWidth),
    }),
    [
      activeSidePanelTab,
      configuredCollapsedSidePanelTabs,
      configuredShownSidePanelTabs,
      shellWidth,
    ],
  );

  const sidePanelCustomizeItems = useMemo(
    () =>
      sidePanelTabOrder.map((tabId) => {
        const item = sidePanelTabItemById.get(tabId);
        return {
          id: tabId,
          label: item?.label ?? tabId,
          icon: item?.icon,
        };
      }),
    [sidePanelTabItemById, sidePanelTabOrder],
  );

  return (
    <>
    <div
      ref={shellRef}
      inert={activeMagnifiedPane ? true : undefined}
      style={{
        width: shellWidth,
        maxWidth: getTerminalSidePanelMaxWidth(availableSurfaceWidth),
        contain: 'layout paint style',
      }}
      className={cn(
        'flex-shrink-0 h-full relative z-20',
        shellWidth === 0 && 'overflow-hidden',
        sidePanelPosition === 'right' && 'order-last',
      )}
      data-section="terminal-side-panel-shell"
      data-side-panel-position={sidePanelPosition}
    >
      {isSidePanelOpenForCurrentTab && !isAiShellForceHidden && (
        <div
          className={cn(
            'absolute top-0 h-full w-2 cursor-ew-resize z-30',
            sidePanelPosition === 'left' ? 'right-[-3px]' : 'left-[-3px]',
          )}
          data-section="terminal-side-panel-resizer"
          onMouseDown={handleSidePanelResizeStart}
        />
      )}
      <div
        className={cn(
          'h-full flex flex-col overflow-hidden',
          !isSidePanelOpenForCurrentTab && 'pointer-events-none',
        )}
        data-section={isSidePanelOpenForCurrentTab ? 'terminal-side-panel' : undefined}
        data-open={isSidePanelOpenForCurrentTab ? 'true' : 'false'}
        data-side-panel-tab={isSidePanelOpenForCurrentTab ? (activeSidePanelTab ?? undefined) : undefined}
        style={{
          ...sidePanelCssVars,
          // Keep native form controls (AI/Codex composer textarea) in sync when a
          // light terminal theme remaps --background under dark app chrome.
          colorScheme: resolvedSidePanelTerminalTheme.type,
          backgroundColor: sidePanelTheme.termBg,
          color: sidePanelTheme.termFg,
          ...(isSidePanelOpenForCurrentTab && sidePanelPosition === 'left'
            ? { borderRight: `1px solid ${sidePanelTheme.separator}` }
            : {}),
          ...(isSidePanelOpenForCurrentTab && sidePanelPosition === 'right'
            ? { borderLeft: `1px solid ${sidePanelTheme.separator}` }
            : {}),
        }}
      >
        {isSidePanelOpenForCurrentTab && !isAiShellForceHidden && (
          <ToolbarCustomizeContextMenu
            items={sidePanelCustomizeItems}
            placementOf={(id) => sidePanelTabLayout.placement[id] ?? 'show'}
            onSetPlacement={(id, placement) => {
              const next = setSidePanelTabPlacement(
                id,
                placement,
                TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
              );
              // Only close when hide actually stuck (not reverted by requireReachable).
              if (activeSidePanelTab === id && (next.placement[id] ?? 'show') === 'hide') {
                handleCloseSidePanel?.();
              }
            }}
            onMove={(id, direction) =>
              moveSidePanelTab(id, direction, TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER)
            }
            onReset={resetSidePanelTabLayout}
            t={t}
            className="flex h-9 items-center px-1.5 py-1 flex-shrink-0 gap-1 w-full"
            dataSection="terminal-side-panel-tabs"
            style={{
              backgroundColor: sidePanelTheme.termBg,
              borderBottom: `1px solid ${sidePanelTheme.separator}`,
            }}
          >
              {shownSidePanelTabs.map((tabId) => {
                const item = sidePanelTabItemById.get(tabId as TerminalSidePanelTabId);
                if (!item) return null;
                const isActive = activeSidePanelTab === item.id;
                const showDropIndicator = dragOverSidePanelTab?.tab === item.id
                  && draggedSidePanelTabRef.current !== null
                  && draggedSidePanelTabRef.current !== item.id;
                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>
                      <Btn
                        variant="ghost"
                        size="icon"
                        draggable
                        data-tab-id={item.id}
                        data-tab-type="sidepanel"
                        data-state={isActive ? 'active' : 'inactive'}
                        className="netcatty-tab relative h-7 w-7 rounded-md p-0 hover:bg-transparent"
                        style={{
                          backgroundColor: isActive
                            ? `color-mix(in srgb, ${sidePanelTheme.accent} 24%, transparent)`
                            : 'transparent',
                          color: isActive
                            ? sidePanelTheme.termFg
                            : sidePanelTheme.mutedFg,
                        }}
                        onClick={item.onClick}
                        onDragStart={(event: React.DragEvent) => handleSidePanelTabDragStart(event, item.id)}
                        onDragOver={(event: React.DragEvent) => handleSidePanelTabDragOver(event, item.id)}
                        onDragLeave={(event: React.DragEvent) => handleSidePanelTabDragLeave(event, item.id)}
                        onDrop={(event: React.DragEvent) => handleSidePanelTabDrop(event, item.id)}
                        onDragEnd={() => {
                          draggedSidePanelTabRef.current = null;
                          setDragOverSidePanelTab(null);
                        }}
                      >
                        {showDropIndicator && (
                          <span
                            aria-hidden="true"
                            className={cn(
                              'pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-none',
                              dragOverSidePanelTab?.placement === 'after' ? 'right-0' : 'left-0',
                            )}
                            style={{ backgroundColor: sidePanelTheme.accent }}
                          />
                        )}
                        {item.icon}
                      </Btn>
                    </TooltipTrigger>
                    {/* bottom: left-docked panel tooltips must not cover macOS traffic lights (#2095) */}
                    <TooltipContent side="bottom">{item.label}</TooltipContent>
                  </Tooltip>
                );
              })}
              <ToolbarOverflowMenu
                hasItems={collapsedSidePanelTabs.length > 0}
                label={t('common.more')}
                orientation="horizontal"
                buttonClassName="h-7 w-7 rounded-md p-0 hover:bg-transparent"
                contentClassName="min-w-[10rem] p-1"
              >
                <div className="flex flex-col min-w-[10rem]">
                  {collapsedSidePanelTabs.map((tabId) => {
                    const item = sidePanelTabItemById.get(tabId as TerminalSidePanelTabId);
                    if (!item) return null;
                    const isActive = activeSidePanelTab === item.id;
                    // Leaf click is closed by ToolbarOverflowMenu onClick capture.
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors text-left',
                          isActive && 'bg-secondary font-medium',
                        )}
                        onClick={item.onClick}
                      >
                        <span className="shrink-0">{item.icon}</span>
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </ToolbarOverflowMenu>
              <div className="flex-1" />
              {focusedPane && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Btn
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-md p-0 hover:bg-transparent"
                      style={{ color: sidePanelTheme.mutedFg }}
                      aria-label={t('terminal.paneMagnification.magnify')}
                      onClick={() => handleMagnifySidePanelPane(focusedPane.id)}
                    >
                      <Maximize2 size={15} />
                    </Btn>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t('terminal.paneMagnification.magnify')}
                  </TooltipContent>
                </Tooltip>
              )}
              <SidePanelSplitMenu
                direction="horizontal"
                items={sidePanelTabItems}
                occupiedTools={occupiedSidePanelTools}
                disabled={
                  !activeSidePanelLayout
                  || activePaneCount >= MAX_SIDE_PANEL_PANES
                  || !focusedPaneSplitAvailability.horizontal
                }
                onSelect={handleSplitSidePanelSelect}
                t={t}
                buttonColor={sidePanelTheme.mutedFg}
              />
              <SidePanelSplitMenu
                direction="vertical"
                items={sidePanelTabItems}
                occupiedTools={occupiedSidePanelTools}
                disabled={
                  !activeSidePanelLayout
                  || activePaneCount >= MAX_SIDE_PANEL_PANES
                  || !focusedPaneSplitAvailability.vertical
                }
                onSelect={handleSplitSidePanelSelect}
                t={t}
                buttonColor={sidePanelTheme.mutedFg}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{ color: sidePanelTheme.mutedFg }}
                    onClick={() => setSidePanelPosition((p: 'left' | 'right') => (p === 'left' ? 'right' : 'left'))}
                  >
                    {sidePanelPosition === 'left' ? <PanelRight size={15} /> : <PanelLeft size={15} />}
                  </Btn>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {sidePanelPosition === 'left' ? t('terminal.layer.movePanelRight') : t('terminal.layer.movePanelLeft')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{ color: sidePanelTheme.mutedFg }}
                    onClick={handleCloseSidePanel}
                  >
                    <X size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('terminal.layer.closePanel')}</TooltipContent>
              </Tooltip>
          </ToolbarCustomizeContextMenu>
        )}
        <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden" data-section="terminal-side-panel-content">
          {isSidePanelOpenForCurrentTab && activeSidePanelLayout && (
            <SidePanelLayoutTree
              node={activeSidePanelLayout.root}
              layout={activeSidePanelLayout}
              paneCount={activePaneCount}
              labels={sidePanelToolLabels}
              onClose={handleCloseSidePanelPane}
              onFocus={handleFocusSidePanelPane}
              onHostChange={handlePaneHostChange}
              onResize={handleResizeSidePanelSplit}
              separator={sidePanelTheme.separator}
              accent={sidePanelTheme.accent}
              closePaneLabel={t('terminal.layer.closePane')}
              resizeLabel={t('terminal.layer.resizeSplit')}
            />
          )}
          <div
            ref={parkingHostRef}
            className="hidden absolute inset-0 overflow-hidden [content-visibility:hidden] [contain:strict]"
            aria-hidden="true"
            data-section="terminal-side-panel-parking"
          />
          <MemoizedSidePanelMountedContent
            ctx={ctx}
            paneHosts={panePortalHosts}
            parkingHost={parkingHost}
          />
        </div>
      </div>
    </div>
    {overlayRoot && magnifiedSidePane && createPortal(
      <div className="absolute inset-0 z-[70]" data-section="pane-magnification-overlay">
        <div
          className="absolute inset-0 bg-background/55 backdrop-blur-[1px]"
          aria-hidden="true"
          data-section="pane-magnification-backdrop"
        />
        <div
          className="absolute inset-3 flex flex-col overflow-hidden rounded-md border bg-background shadow-2xl animate-in fade-in zoom-in-95 duration-150"
          style={{
            borderColor: sidePanelTheme.accent,
            backgroundColor: sidePanelTheme.termBg,
            color: sidePanelTheme.termFg,
          }}
        >
          <div
            className="flex h-8 items-center gap-2 border-b px-2"
            style={{ borderColor: sidePanelTheme.separator }}
          >
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {sidePanelToolLabels.get(magnifiedSidePane.tool) ?? magnifiedSidePane.tool}
            </span>
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded hover:bg-white/10"
              aria-label={t('terminal.paneMagnification.restore')}
              onClick={handleRestoreMagnifiedPane}
            >
              <Minimize2 size={14} />
            </button>
          </div>
          <div
            ref={setOverlayHost}
            className="relative flex-1 min-h-0 overflow-hidden [contain:strict]"
            data-section="pane-magnification-content"
          />
        </div>
        {showMagnificationHint && (
          <div
            className="pointer-events-none absolute bottom-4 right-4 z-[80] rounded border border-border/70 bg-background/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm animate-in fade-in duration-150"
            data-section="pane-magnification-hint"
          >
            {t('terminal.paneMagnification.hint')}: {sidePanelToolLabels.get(magnifiedSidePane.tool) ?? magnifiedSidePane.tool}
            {paneMagnificationShortcutLabel ? ` · ${paneMagnificationShortcutLabel} / Esc` : ' · Esc'}
          </div>
        )}
      </div>,
      overlayRoot,
    )}
    </>
  );
}
