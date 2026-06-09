/* eslint-disable @typescript-eslint/no-explicit-any */
import { FolderTree, MessageSquare, Palette, PanelLeft, PanelRight, X, Zap } from 'lucide-react';
import React, { memo, useCallback, useState } from 'react';

import { useActiveTabId } from '../../application/state/activeTabStore';
import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { SidePanelTab } from './TerminalLayerSupport';
import { terminalLayerSidePanelCtxEqual } from './terminalLayerViewMemo';

type SidePanelContext = Record<string, any>;

function TerminalLayerSidePanelShell({ ctx }: { ctx: SidePanelContext }) {
  const {
    mountedAiTabIds,
    mountedSftpTabIds,
    scriptsMountedTabIds,
    themeMountedTabIds,
  } = ctx;

  if (
    mountedSftpTabIds.length === 0
    && mountedAiTabIds.length === 0
    && scriptsMountedTabIds.length === 0
    && themeMountedTabIds.length === 0
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
    focusedThemeOverridden,
    followAppTerminalTheme,
    getTerminalCwd,
    handleCloseSidePanel,
    handleFontFamilyChangeForFocusedSession,
    handleFontFamilyResetForFocusedSession,
    handleFontSizeChangeForFocusedSession,
    handleFontSizeResetForFocusedSession,
    handleFontWeightChangeForFocusedSession,
    handleFontWeightResetForFocusedSession,
    handleOpenAI,
    handleOpenScripts,
    handleOpenTheme,
    handlePendingTerminalSelectionConsumed,
    handleSftpInitialLocationApplied,
    handleSnippetFromPanel,
    handleThemeChangeForFocusedSession,
    handleThemeResetForFocusedSession,
    handleToggleSftpFromBar,
    handlePendingUploadHandled,
    hosts,
    hotkeyScheme,
    identities,
    keyBindings,
    keys,
    mountedAiTabIds,
    mountedSftpTabIds,
    scriptsMountedTabIds,
    themeMountedTabIds,
    pendingTerminalSelectionForAI,
    previewedOrVisibleThemeId,
    refocusActiveTerminalSession,
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
    validAIScopeTargetIds,
  } = ctx;

  const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
  const shellWidth = isSidePanelOpenForCurrentTab
    ? (resizePreviewWidth ?? sidePanelWidth)
    : 0;

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
        style={{ width: shellWidth }}
        className={cn(
          'flex-shrink-0 h-full relative z-20',
          sidePanelPosition === 'right' && 'order-last',
        )}
        data-section="terminal-side-panel-shell"
        data-side-panel-position={sidePanelPosition}
      >
        {isSidePanelOpenForCurrentTab && (
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
          {isSidePanelOpenForCurrentTab && (
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
                  updateHosts={updateHosts}
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
                  activeTerminalCwd={activeTerminalCwd}
                  sftpFollowTerminalCwd={sftpFollowTerminalCwd}
                  onSftpFollowTerminalCwdChange={setSftpFollowTerminalCwd}
                  onRequestTerminalFocus={refocusActiveTerminalSession}
                  terminalSettings={terminalSettings}
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
                    onSnippetClick={handleSnippetFromPanel}
                    isVisible={isVisibleScriptsPanel}
                  />
                </div>
              );
            })}

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

            {mountedAiTabIds.length > 0 && (
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
