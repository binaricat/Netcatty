/* eslint-disable @typescript-eslint/no-explicit-any */
import { Activity, FolderTree, History, MessageSquare, NotebookText, Palette, PanelLeft, PanelRight, X, Zap } from 'lucide-react';
import { SystemManagerSidePanel } from '../systemManager/SystemManagerSidePanel';
import React, { memo, useCallback, useRef, useState } from 'react';

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
import { terminalLayerSidePanelCtxEqual } from './terminalLayerViewMemo';
import { resolveSftpFollowTerminalCwdTargetHost } from '../sftp/sftpFollowTerminalCwd';
import type { Host } from '../../types';

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

function TerminalLayerSidePanelShell({ ctx }: { ctx: SidePanelContext }) {
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

  if (
    mountedSftpTabIds.length === 0
    && mountedAiTabIds.length === 0
    && notesMountedTabIds.length === 0
    && scriptsMountedTabIds.length === 0
    && systemMountedTabIds.length === 0
    && themeMountedTabIds.length === 0
    && !anyHistoryOpen
    && !anyNotesOpen
  ) {
    return null;
  }

  return <TerminalLayerSidePanelTabBody ctx={ctx} />;
}

function TerminalLayerSidePanelTabBody({ ctx }: { ctx: SidePanelContext }) {
  const activeTabId = useActiveTabId();
  const sidePanelOpenTabs = ctx.sidePanelOpenTabs as Map<string, SidePanelTab>;
  const isSidePanelOpenForCurrentTab = activeTabId ? sidePanelOpenTabs.has(activeTabId) : false;
  const activeSidePanelTab = activeTabId ? sidePanelOpenTabs.get(activeTabId) ?? null : null;

  const {
    activeTerminalCwd,
    activeTerminalSessionIdForSftp,
    activeWorkspace,
    AIChatPanelsHost,
    AISidePanelStateRoot,
    aiContextsByTabId,
    Button: Btn,
    cn,
    editorWordWrap,
    effectiveHosts,
    focusedFontFamilyId,
    focusedFontFamilyOverridden,
    focusedFontSize,
    focusedFontSizeOverridden,
    focusedFontWeight,
    focusedFontWeightOverridden,
    focusedHost,
    focusedThemeOverridden,
    followAppTerminalTheme,
    getTerminalCwd,
    handleCloseSidePanel,
    handleHistoryPaste,
    handleHistoryRun,
    handleAddKnownHost,
    handleOpenHistory,
    handleFontFamilyChangeForFocusedSession,
    handleFontFamilyResetForFocusedSession,
    handleFontSizeChangeForFocusedSession,
    handleFontSizeResetForFocusedSession,
    handleFontWeightChangeForFocusedSession,
    handleFontWeightResetForFocusedSession,
    handleOpenAI,
    handleOpenNotes,
    handleOpenHostFromNotes,
    handleOpenScripts,
    handleOpenSystem,
    handleOpenTheme,
    activeTerminalSessionForSystem,
    activeSystemSessionHost,
    handlePendingTerminalSelectionConsumed,
    handleSftpInitialLocationApplied,
    handleSnippetFromPanel,
    handleThemeChangeForFocusedSession,
    handleThemeResetForFocusedSession,
    handleToggleSftpFromBar,
    handlePendingUploadHandled,
    historySessionId,
    HistorySidePanel,
    hosts,
    hotkeyScheme,
    identities,
    keyBindings,
    keys,
    knownHosts,
    mountedAiTabIds,
    mountedSftpTabIds,
    notesMountedTabIds,
    notesOpenNoteByTab,
    NotesManager,
    noteGroups,
    notes,
    scriptsMountedTabIds,
    systemMountedTabIds,
    themeMountedTabIds,
    pendingTerminalSelectionForAI,
    previewedOrVisibleThemeId,
    refocusActiveTerminalSession,
    remoteHistory,
    shellHistory,
    resolveAIExecutorContext,
    resolvedPreviewTheme,
    ScriptsSidePanel,
    setEditorWordWrap,
    setSidePanelPosition,
    setSidePanelWidth,
    setSftpFollowTerminalCwd,
    persistSidePanelWidth,
    sftpActiveHost,
    sftpHostForTab,
    sftpAutoSync,
    sftpDefaultViewMode,
    sftpDoubleClickBehavior,
    sftpFollowTerminalCwd,
    sftpInitialLocationForTab,
    sftpPendingUploadsForTab,
    sftpShowHiddenFiles,
    SftpSidePanel,
    sftpUseCompressedUpload,
    sidePanelPosition,
    sidePanelWidth,
    snippetPackages,
    snippets,
    t,
    terminalFontFamilyId,
    terminalSettings,
    terminalTheme,
    terminalThemeId,
    ThemeSidePanel,
    updateHosts,
    updateNoteGroups,
    updateNotes,
    updateSnippetPackages,
    updateSnippets,
    validAIScopeTargetIds,
  } = ctx;

  const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
  const { sidePanelTabOrder, setSidePanelTabOrder } = useTerminalSidePanelTabOrder();
  const [dragOverSidePanelTab, setDragOverSidePanelTab] = useState<{
    tab: TerminalSidePanelTabId;
    placement: 'before' | 'after';
  } | null>(null);
  const draggedSidePanelTabRef = useRef<TerminalSidePanelTabId | null>(null);
  const isAiShellForceHidden = AI_PANEL_FORCE_HIDE_SHELL && activeSidePanelTab === 'ai';
  const shouldRenderAiPanels = mountedAiTabIds.length > 0 && !isAiShellForceHidden;
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

  const sidePanelTabItems: Array<{
    id: TerminalSidePanelTabId;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
  }> = [
    {
      id: 'sftp',
      label: t('terminal.layer.sftp'),
      icon: <FolderTree size={15} />,
      onClick: handleToggleSftpFromBar,
    },
    {
      id: 'scripts',
      label: t('terminal.layer.scripts'),
      icon: <Zap size={15} />,
      onClick: handleOpenScripts,
    },
    {
      id: 'history',
      label: t('terminal.layer.history'),
      icon: <History size={15} />,
      onClick: handleOpenHistory,
    },
    {
      id: 'theme',
      label: t('terminal.layer.theme'),
      icon: <Palette size={15} />,
      onClick: handleOpenTheme,
    },
    {
      id: 'system',
      label: t('terminal.layer.system'),
      icon: <Activity size={15} />,
      onClick: handleOpenSystem,
    },
    {
      id: 'notes',
      label: t('terminal.layer.notes'),
      icon: <NotebookText size={15} />,
      onClick: handleOpenNotes,
    },
    {
      id: 'ai',
      label: t('terminal.layer.aiChat'),
      icon: <MessageSquare size={15} />,
      onClick: handleOpenAI,
    },
  ];
  const sidePanelTabItemById = new Map(sidePanelTabItems.map((item) => [item.id, item]));

  return (
    <>
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
            isSidePanelOpenForCurrentTab && sidePanelPosition === 'left' && 'border-r',
            isSidePanelOpenForCurrentTab && sidePanelPosition === 'right' && 'border-l',
            !isSidePanelOpenForCurrentTab && 'pointer-events-none',
          )}
          data-section={isSidePanelOpenForCurrentTab ? 'terminal-side-panel' : undefined}
          data-open={isSidePanelOpenForCurrentTab ? 'true' : 'false'}
          data-side-panel-tab={isSidePanelOpenForCurrentTab ? (activeSidePanelTab ?? undefined) : undefined}
          style={{
            ['--terminal-sidepanel-bg' as never]: resolvedPreviewTheme.colors.background,
            ['--terminal-sidepanel-fg' as never]: resolvedPreviewTheme.colors.foreground,
            ['--terminal-sidepanel-accent' as never]: resolvedPreviewTheme.colors.cursor,
            ['--terminal-sidepanel-muted' as never]: `color-mix(in srgb, ${resolvedPreviewTheme.colors.foreground} 62%, ${resolvedPreviewTheme.colors.background} 38%)`,
            ['--terminal-sidepanel-border' as never]: `color-mix(in srgb, ${resolvedPreviewTheme.colors.foreground} 12%, ${resolvedPreviewTheme.colors.background} 88%)`,
            backgroundColor: 'var(--terminal-sidepanel-bg)',
            color: 'var(--terminal-sidepanel-fg)',
            borderColor: 'var(--terminal-sidepanel-border)',
          }}
        >
          {isSidePanelOpenForCurrentTab && !isAiShellForceHidden && (
            <div
              className="flex h-9 items-center px-1.5 py-1 flex-shrink-0 gap-1"
              data-section="terminal-side-panel-tabs"
              style={{
                borderBottom: '1px solid var(--terminal-sidepanel-border)',
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
                            ? 'color-mix(in srgb, var(--terminal-sidepanel-accent) 24%, transparent)'
                            : 'transparent',
                          color: isActive
                            ? 'var(--terminal-sidepanel-fg)'
                            : 'var(--terminal-sidepanel-muted)',
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
                            style={{ backgroundColor: 'var(--terminal-sidepanel-accent)' }}
                          />
                        )}
                        {item.icon}
                      </Btn>
                    </TooltipTrigger>
                    <TooltipContent>{item.label}</TooltipContent>
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
                    style={{
                      color: 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={() => setSidePanelPosition((p: 'left' | 'right') => (p === 'left' ? 'right' : 'left'))}
                  >
                    {sidePanelPosition === 'left' ? <PanelRight size={15} /> : <PanelLeft size={15} />}
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>
                  {sidePanelPosition === 'left' ? t('terminal.layer.movePanelRight') : t('terminal.layer.movePanelLeft')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{
                      color: 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={handleCloseSidePanel}
                  >
                    <X size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>{t('terminal.layer.closePanel')}</TooltipContent>
              </Tooltip>
            </div>
          )}
          <div className="flex-1 min-h-0 relative" data-section="terminal-side-panel-content">
            {mountedSftpTabIds.map((tabId: string) => {
              const isVisibleSftpPanel = activeTabId === tabId && activeSidePanelTab === 'sftp';
              const storedSftpHost = sftpHostForTab.get(tabId) ?? null;
              const panelActiveHost = isVisibleSftpPanel
                ? (sftpActiveHost ?? storedSftpHost)
                : storedSftpHost;
              const handlePanelFollowTerminalCwdChange = (enabled: boolean, visibleHost?: Host | null) => {
                const targetHost = resolveSftpFollowTerminalCwdTargetHost(visibleHost, panelActiveHost);
                if (!targetHost?.id) {
                  setSftpFollowTerminalCwd(enabled);
                  return;
                }
                let updated = false;
                const nextHosts = (hosts as Host[]).map((host) => {
                  if (host.id !== targetHost.id) return host;
                  updated = true;
                  return { ...host, sftpFollowTerminalCwd: enabled };
                });
                if (updated) {
                  updateHosts(nextHosts);
                } else {
                  setSftpFollowTerminalCwd(enabled);
                }
              };
              return (
                <div
                  key={tabId}
                  className={cn('absolute inset-0 z-10', !isVisibleSftpPanel && 'hidden')}
                >
                <SftpSidePanel
                  hosts={effectiveHosts}
                  writableHosts={hosts}
                  keys={keys}
                  identities={identities}
                  knownHosts={knownHosts}
                  updateHosts={updateHosts}
                  onAddKnownHost={handleAddKnownHost}
                  sftpDefaultViewMode={sftpDefaultViewMode}
                  activeHost={panelActiveHost}
                  activeSessionId={isVisibleSftpPanel ? activeTerminalSessionIdForSftp : null}
                  initialLocation={
                    isVisibleSftpPanel
                      ? (sftpInitialLocationForTab.get(tabId) ?? null)
                      : null
                  }
                  onInitialLocationApplied={(location) => handleSftpInitialLocationApplied(tabId, location)}
                  showWorkspaceHostHeader={isVisibleSftpPanel && !!activeWorkspace}
                  isVisible={isVisibleSftpPanel}
                  renderOverlays={isVisibleSftpPanel}
                  pendingUpload={sftpPendingUploadsForTab.get(tabId) ?? null}
                  onPendingUploadHandled={(requestId) => handlePendingUploadHandled(tabId, requestId)}
                  sftpDoubleClickBehavior={sftpDoubleClickBehavior}
                  sftpAutoSync={isVisibleSftpPanel ? sftpAutoSync : false}
                  sftpShowHiddenFiles={sftpShowHiddenFiles}
                  sftpUseCompressedUpload={sftpUseCompressedUpload}
                  hotkeyScheme={hotkeyScheme}
                  keyBindings={keyBindings}
                  editorWordWrap={editorWordWrap}
                  setEditorWordWrap={setEditorWordWrap}
                  onGetTerminalCwd={getTerminalCwd}
                  activeTerminalCwd={isVisibleSftpPanel ? activeTerminalCwd : null}
                  sftpFollowTerminalCwd={sftpFollowTerminalCwd}
                  onSftpFollowTerminalCwdChange={handlePanelFollowTerminalCwdChange}
                  onRequestTerminalFocus={refocusActiveTerminalSession}
                  terminalSettings={terminalSettings}
                />
                </div>
              );
            })}

            {systemMountedTabIds.map((tabId: string) => {
              const isVisibleSystemPanel = activeTabId === tabId && activeSidePanelTab === 'system';
              return (
                <div
                  key={`system-${tabId}`}
                  className={cn('absolute inset-0 z-10', !isVisibleSystemPanel && 'hidden')}
                >
                  <SystemManagerSidePanel
                    key={activeTerminalSessionForSystem?.id ?? 'system-none'}
                    session={activeTerminalSessionForSystem ?? null}
                    sessionHost={activeSystemSessionHost ?? null}
                    showWorkspaceHostHeader={isVisibleSystemPanel && !!activeWorkspace}
                    isVisible={isVisibleSystemPanel}
                    terminalSettings={terminalSettings}
                    snippets={snippets}
                    onRequestTerminalFocus={refocusActiveTerminalSession}
                  />
                </div>
              );
            })}

            {scriptsMountedTabIds.map((tabId: string) => {
              const isVisibleScriptsPanel = activeTabId === tabId && activeSidePanelTab === 'scripts';
              return (
                <div
                  key={`scripts-${tabId}`}
                  className={cn('absolute inset-0 z-10', !isVisibleScriptsPanel && 'hidden')}
                >
                  <ScriptsSidePanel
                    snippets={snippets}
                    packages={snippetPackages}
                    onSnippetsChange={updateSnippets}
                    onPackagesChange={updateSnippetPackages}
                    onSnippetClick={handleSnippetFromPanel}
                    isVisible={isVisibleScriptsPanel}
                  />
                </div>
              );
            })}

            {activeSidePanelTab === 'history' && (
              <div className="absolute inset-0 z-10">
                <HistorySidePanel
                  focusedHost={focusedHost}
                  focusedSessionId={historySessionId}
                  state={remoteHistory.getState(focusedHost?.id, historySessionId)}
                  globalEntries={shellHistory}
                  onFetch={remoteHistory.fetch}
                  onPasteToTerminal={handleHistoryPaste}
                  onRunInTerminal={handleHistoryRun}
                  isVisible
                />
              </div>
            )}

            {themeMountedTabIds.map((tabId: string) => {
              const isVisibleThemePanel = activeTabId === tabId && activeSidePanelTab === 'theme';
              return (
                <div
                  key={`theme-${tabId}`}
                  className={cn('absolute inset-0 z-10', !isVisibleThemePanel && 'hidden')}
                >
                  <ThemeSidePanel
                    followAppTerminalTheme={followAppTerminalTheme}
                    currentThemeId={previewedOrVisibleThemeId}
                    globalThemeId={terminalThemeId ?? terminalTheme.id}
                    currentFontFamilyId={focusedFontFamilyId}
                    globalFontFamilyId={terminalFontFamilyId}
                    currentFontSize={focusedFontSize}
                    currentFontWeight={focusedFontWeight}
                    canResetTheme={followAppTerminalTheme ? false : focusedThemeOverridden}
                    canResetFontFamily={focusedFontFamilyOverridden}
                    canResetFontSize={focusedFontSizeOverridden}
                    canResetFontWeight={focusedFontWeightOverridden}
                    onThemeChange={handleThemeChangeForFocusedSession}
                    onThemeReset={handleThemeResetForFocusedSession}
                    onFontFamilyChange={handleFontFamilyChangeForFocusedSession}
                    onFontFamilyReset={handleFontFamilyResetForFocusedSession}
                    onFontSizeChange={handleFontSizeChangeForFocusedSession}
                    onFontSizeReset={handleFontSizeResetForFocusedSession}
                    onFontWeightChange={handleFontWeightChangeForFocusedSession}
                    onFontWeightReset={handleFontWeightResetForFocusedSession}
                    previewColors={resolvedPreviewTheme.colors}
                    isVisible={isVisibleThemePanel}
                  />
                </div>
              );
            })}

            {notesMountedTabIds.map((tabId: string) => {
              const isVisibleNotesPanel = activeTabId === tabId && activeSidePanelTab === 'notes';
              return (
                <div
                  key={`notes-${tabId}`}
                  className={cn('absolute inset-0 z-20 bg-background text-foreground', !isVisibleNotesPanel && 'hidden')}
                  data-section={isVisibleNotesPanel ? 'terminal-notes-panel' : undefined}
                >
                  <NotesManager
                    notes={notes}
                    noteGroups={noteGroups}
                    hosts={hosts}
                    onUpdateNotes={updateNotes}
                    onUpdateNoteGroups={updateNoteGroups}
                    onOpenHost={handleOpenHostFromNotes}
                    displayMode="sidebar"
                    openNoteId={notesOpenNoteByTab.get(tabId) ?? null}
                  />
                </div>
              );
            })}

            {shouldRenderAiPanels && (
              <AISidePanelStateRoot validAIScopeTargetIds={validAIScopeTargetIds}>
                <AIChatPanelsHost
                  mountedTabIds={mountedAiTabIds}
                  activeTabId={activeTabId}
                  activeSidePanelTab={activeSidePanelTab}
                  contextsByTabId={aiContextsByTabId}
                  resolveExecutorContext={resolveAIExecutorContext}
                  pendingTerminalSelection={pendingTerminalSelectionForAI}
                  onPendingTerminalSelectionConsumed={handlePendingTerminalSelectionConsumed}
                />
              </AISidePanelStateRoot>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export const TerminalLayerSidePanelSection = memo(
  TerminalLayerSidePanelShell,
  (prev, next) => terminalLayerSidePanelCtxEqual(prev.ctx, next.ctx),
);
TerminalLayerSidePanelSection.displayName = 'TerminalLayerSidePanelSection';
