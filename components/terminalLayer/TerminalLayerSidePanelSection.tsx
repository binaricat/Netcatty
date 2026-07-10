/* eslint-disable @typescript-eslint/no-explicit-any */
import { Activity, FolderTree, History, MessageSquare, NotebookText, Palette, PanelLeft, PanelRight, Play, X } from 'lucide-react';
import { buildSidePanelChromeThemeFromTerminalTheme } from '../../infrastructure/theme/terminalAppearanceTokens';
import { injectTerminalLayerChromeSurfaceVars } from '../../infrastructure/theme/terminalAppearanceVars';
import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useActiveTabId } from '../../application/state/activeTabStore';
import {
  reorderTerminalSidePanelTab,
  TERMINAL_SIDE_PANEL_TAB_IDS,
  type TerminalSidePanelTabId,
  useTerminalSidePanelTabOrder,
} from '../../application/state/terminalSidePanelTabs';
import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { SidePanelTab } from './TerminalLayerSupport';
import { terminalLayerSidePanelStableCtxEqual } from './terminalLayerViewMemo';
import { SidePanelMountedContent } from './terminalLayerSidePanelSlots';

const MemoizedSidePanelMountedContent = memo(
  SidePanelMountedContent,
  (prev, next) => terminalLayerSidePanelStableCtxEqual(prev.ctx, next.ctx),
);
MemoizedSidePanelMountedContent.displayName = 'MemoizedSidePanelMountedContent';

type SidePanelContext = Record<string, any>;
const SIDE_PANEL_TAB_DRAG_MIME = 'application/x-netcatty-sidepanel-tab';

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

export function TerminalLayerSidePanelSection({ ctx }: { ctx: SidePanelContext }) {
  if (!hasMountedSidePanelContent(ctx)) return null;
  return <TerminalLayerSidePanelInner ctx={ctx} />;
}
TerminalLayerSidePanelSection.displayName = 'TerminalLayerSidePanelSection';

function TerminalLayerSidePanelInner({ ctx }: { ctx: SidePanelContext }) {
  const activeTabId = useActiveTabId();
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const isSidePanelOpenForCurrentTab = activeTabId ? sidePanelOpenTabs.has(activeTabId) : false;
  const activeSidePanelTab = activeTabId ? sidePanelOpenTabs.get(activeTabId) ?? null : null;

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
    handleToggleSftpFromBar,
    resolvedPreviewTheme,
    setSidePanelPosition,
    setSidePanelWidth,
    persistSidePanelWidth,
    sidePanelPosition,
    sidePanelWidth,
    t,
    terminalTheme,
  } = ctx;

  const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
  const { sidePanelTabOrder, setSidePanelTabOrder } = useTerminalSidePanelTabOrder();
  const sidePanelTheme = useMemo(() => {
    const chromeTheme = followAppTerminalTheme
      ? terminalTheme
      : (resolvedPreviewTheme ?? terminalTheme);
    return buildSidePanelChromeThemeFromTerminalTheme(chromeTheme);
  }, [followAppTerminalTheme, resolvedPreviewTheme, terminalTheme]);

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
  const isAiShellForceHidden = AI_PANEL_FORCE_HIDE_SHELL && activeSidePanelTab === 'ai';
  const shellWidth = getTerminalSidePanelShellWidth({
    activeSidePanelTab,
    forceHideAiShell: AI_PANEL_FORCE_HIDE_SHELL,
    isSidePanelOpenForCurrentTab,
    resizePreviewWidth,
    sidePanelWidth,
  });

  const handleSidePanelResizeStart = useCallback((event: React.MouseEvent) => {
    if (!isSidePanelOpenForCurrentTab) return;
    event.preventDefault();
    terminalLayoutSuppressStore.begin();
    const startX = event.clientX;
    const startWidth = sidePanelWidth;
    let lastWidth = startWidth;
    let rafId: number | null = null;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      lastWidth = Math.max(
        280,
        Math.min(800, startWidth + (sidePanelPosition === 'left' ? delta : -delta)),
      );
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setResizePreviewWidth(lastWidth);
      });
    };
    const onMouseUp = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      setSidePanelWidth(lastWidth);
      persistSidePanelWidth(lastWidth);
      setResizePreviewWidth(null);
      terminalLayoutSuppressStore.end();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [
    isSidePanelOpenForCurrentTab,
    persistSidePanelWidth,
    setSidePanelWidth,
    sidePanelPosition,
    sidePanelWidth,
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

  const sidePanelTabItems = useMemo(() => [
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

  return (
    <div
      style={{ width: shellWidth, contain: 'layout paint style' }}
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
          <div
            className="flex h-9 items-center px-1.5 py-1 flex-shrink-0 gap-1"
            data-section="terminal-side-panel-tabs"
            style={{
              backgroundColor: sidePanelTheme.termBg,
              borderBottom: `1px solid ${sidePanelTheme.separator}`,
            }}
          >
            {sidePanelTabOrder.map((tabId) => {
              const item = sidePanelTabItemById.get(tabId);
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
            <div className="flex-1" />
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
          </div>
        )}
        <div className="flex-1 min-h-0 relative" data-section="terminal-side-panel-content">
          <MemoizedSidePanelMountedContent ctx={ctx} />
        </div>
      </div>
    </div>
  );
}
