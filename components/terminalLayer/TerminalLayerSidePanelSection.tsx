/* eslint-disable @typescript-eslint/no-explicit-any */
import { Activity, FolderTree, History, MessageSquare, Palette, PanelLeft, PanelRight, X, Zap } from 'lucide-react';
import { SystemManagerSidePanel } from '../systemManager/SystemManagerSidePanel';
import React, { memo, useCallback, useState } from 'react';

import { useActiveTabId } from '../../application/state/activeTabStore';
import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { SidePanelTab } from './TerminalLayerSupport';
import { terminalLayerSidePanelCtxEqual } from './terminalLayerViewMemo';

type SidePanelContext = Record<string, any>;

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
    scriptsMountedTabIds,
    systemMountedTabIds,
    themeMountedTabIds,
    sidePanelOpenTabs,
  } = ctx;

  const anyHistoryOpen = sidePanelOpenTabs instanceof Map
    && Array.from((sidePanelOpenTabs as Map<string, SidePanelTab>).values()).includes('history');

  if (
    mountedSftpTabIds.length === 0
    && mountedAiTabIds.length === 0
    && scriptsMountedTabIds.length === 0
    && systemMountedTabIds.length === 0
    && themeMountedTabIds.length === 0
    && !anyHistoryOpen
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
    ThemeSidePanel,
    updateHosts,
    updateSnippetPackages,
    updateSnippets,
    validAIScopeTargetIds,
  } = ctx;

  const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    data-tab-id="sftp"
                    data-tab-type="sidepanel"
                    data-state={activeSidePanelTab === 'sftp' ? 'active' : 'inactive'}
                    className="netcatty-tab h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{
                      backgroundColor: activeSidePanelTab === 'sftp'
                        ? 'color-mix(in srgb, var(--terminal-sidepanel-accent) 24%, transparent)'
                        : 'transparent',
                      color: activeSidePanelTab === 'sftp'
                        ? 'var(--terminal-sidepanel-fg)'
                        : 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={handleToggleSftpFromBar}
                  >
                    <FolderTree size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>{t('terminal.layer.sftp')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    data-tab-id="scripts"
                    data-tab-type="sidepanel"
                    data-state={activeSidePanelTab === 'scripts' ? 'active' : 'inactive'}
                    className="netcatty-tab h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{
                      backgroundColor: activeSidePanelTab === 'scripts'
                        ? 'color-mix(in srgb, var(--terminal-sidepanel-accent) 24%, transparent)'
                        : 'transparent',
                      color: activeSidePanelTab === 'scripts'
                        ? 'var(--terminal-sidepanel-fg)'
                        : 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={handleOpenScripts}
                  >
                    <Zap size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>{t('terminal.layer.scripts')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    data-tab-id="history"
                    data-tab-type="sidepanel"
                    data-state={activeSidePanelTab === 'history' ? 'active' : 'inactive'}
                    className="netcatty-tab h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{
                      backgroundColor: activeSidePanelTab === 'history'
                        ? 'color-mix(in srgb, var(--terminal-sidepanel-accent) 24%, transparent)'
                        : 'transparent',
                      color: activeSidePanelTab === 'history'
                        ? 'var(--terminal-sidepanel-fg)'
                        : 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={handleOpenHistory}
                  >
                    <History size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>{t('terminal.layer.history')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    data-tab-id="theme"
                    data-tab-type="sidepanel"
                    data-state={activeSidePanelTab === 'theme' ? 'active' : 'inactive'}
                    className="netcatty-tab h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{
                      backgroundColor: activeSidePanelTab === 'theme'
                        ? 'color-mix(in srgb, var(--terminal-sidepanel-accent) 24%, transparent)'
                        : 'transparent',
                      color: activeSidePanelTab === 'theme'
                        ? 'var(--terminal-sidepanel-fg)'
                        : 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={handleOpenTheme}
                  >
                    <Palette size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>{t('terminal.layer.theme')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    data-tab-id="system"
                    data-tab-type="sidepanel"
                    data-state={activeSidePanelTab === 'system' ? 'active' : 'inactive'}
                    className="netcatty-tab h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{
                      backgroundColor: activeSidePanelTab === 'system'
                        ? 'color-mix(in srgb, var(--terminal-sidepanel-accent) 24%, transparent)'
                        : 'transparent',
                      color: activeSidePanelTab === 'system'
                        ? 'var(--terminal-sidepanel-fg)'
                        : 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={handleOpenSystem}
                  >
                    <Activity size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>{t('terminal.layer.system')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Btn
                    variant="ghost"
                    size="icon"
                    data-tab-id="ai"
                    data-tab-type="sidepanel"
                    data-state={activeSidePanelTab === 'ai' ? 'active' : 'inactive'}
                    className="netcatty-tab h-7 w-7 rounded-md p-0 hover:bg-transparent"
                    style={{
                      backgroundColor: activeSidePanelTab === 'ai'
                        ? 'color-mix(in srgb, var(--terminal-sidepanel-accent) 24%, transparent)'
                        : 'transparent',
                      color: activeSidePanelTab === 'ai'
                        ? 'var(--terminal-sidepanel-fg)'
                        : 'var(--terminal-sidepanel-muted)',
                    }}
                    onClick={handleOpenAI}
                  >
                    <MessageSquare size={15} />
                  </Btn>
                </TooltipTrigger>
                <TooltipContent>{t('terminal.layer.aiChat')}</TooltipContent>
              </Tooltip>
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
                  activeTerminalCwd={isVisibleSftpPanel && sftpFollowTerminalCwd ? activeTerminalCwd : null}
                  sftpFollowTerminalCwd={sftpFollowTerminalCwd}
                  onSftpFollowTerminalCwdChange={setSftpFollowTerminalCwd}
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
                    globalThemeId={terminalTheme.id}
                    currentFontFamilyId={focusedFontFamilyId}
                    globalFontFamilyId={terminalFontFamilyId}
                    currentFontSize={focusedFontSize}
                    currentFontWeight={focusedFontWeight}
                    canResetTheme={focusedThemeOverridden}
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
