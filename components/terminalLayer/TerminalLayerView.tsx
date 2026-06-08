/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';

type TerminalLayerViewContext = Record<string, any>;

export function TerminalLayerView({ ctx }: { ctx: TerminalLayerViewContext }) {
  const { accentMode, activeResizers, activeSidePanelTab, activeTabId, activeWorkspace, AIChatPanelsHost, aiContextsByTabId, AIStateMaintenanceHost, AIStateProvider, Array, Button, cn, composeBarThemeColors, computeSplitHint, customAccent, draggingSessionId, dropHint, editorWordWrap, effectiveHosts, findSplitNode, focusedFontFamilyId, focusedFontFamilyOverridden, focusedFontSize, focusedFontSizeOverridden, focusedFontWeight, focusedFontWeightOverridden, focusedSessionId, focusedThemeOverridden, FolderTree, followAppTerminalTheme, fontSize, getTerminalCwd, handleAddKnownHost, handleAddSelectionToAI, handleBroadcastInput, handleCloseSession, handleCloseSidePanel, handleCommandExecuted, handleComposeSend, handleFontFamilyChangeForFocusedSession, handleFontFamilyResetForFocusedSession, handleFontSizeChangeForFocusedSession, handleFontSizeResetForFocusedSession, handleFontWeightChangeForFocusedSession, handleFontWeightResetForFocusedSession, handleOpenAI, handleOpenScripts, handleOpenSftp, handleOpenTheme, handleOsDetected, handlePendingTerminalSelectionConsumed, handlePendingUploadHandled, handleSessionExit, handleSftpInitialLocationApplied, handleSidePanelResizeStart, handleSnippetFromPanel, handleSnippetExecutorChange, handleStatusChange, handleTerminalCwdChange, handleTerminalDataCapture, handleTerminalFontSizeChange, handleThemeChangeForFocusedSession, handleThemeResetForFocusedSession, handleToggleSftpFromBar, handleToggleWorkspaceComposeBar, handleUpdateHost, handleWorkspaceDrop, hosts, hotkeyScheme, identities, isBroadcastEnabled, isComposeBarOpen, isFocusMode, isSidePanelOpenForCurrentTab, isTerminalLayerVisible, keyBindings, keys, knownHosts, MessageSquare, mountedAiTabIds, mountedSftpTabIds, onHotkeyAction, onSetWorkspaceFocusedSession, onSplitSession, Palette, PanelLeft, PanelRight, pendingTerminalSelectionForAI, previewedOrVisibleThemeId, refocusActiveTerminalSession, refocusTerminalSession, renderFocusModeSidebar, resizing, resolveAIExecutorContext, resolvedPreviewTheme, ScriptsSidePanel, sessionChainHostsMap, sessionHostsMap, sessionLogConfig, sessionSudoAutofillPasswordsMap, sessions, setDropHint, setEditorWordWrap, setIsComposeBarOpen, setResizing, setSidePanelPosition, sftpActiveHost, sftpAutoSync, sftpDefaultViewMode, sftpDoubleClickBehavior, sftpInitialLocationForTab, sftpPendingUploadsForTab, sftpShowHiddenFiles, SftpSidePanel, sftpUseCompressedUpload, sidePanelPosition, sidePanelWidth, snippetPackages, snippets, splitHorizontalHandlersRef, splitVerticalHandlersRef, sshDebugLogsEnabled, t, TerminalComposeBar, terminalFontFamilyId, TerminalPanesHost, terminalSettings, terminalTheme, themePreview, ThemeSidePanel, Tooltip, TooltipContent, TooltipTrigger, updateHosts, validAIScopeTargetIds, workspaceBroadcastHandlersRef, workspaceById, workspaceFocusHandlersRef, workspaceInnerRef, workspaceOuterRef, workspaceOverlayRef, workspaceRectsById, X, Zap } = ctx;
  return (
    <AIStateProvider>
      <AIStateMaintenanceHost validAIScopeTargetIds={validAIScopeTargetIds} />
      <div
        ref={workspaceOuterRef}
        className="absolute inset-0 bg-background flex flex-col"
        data-section="terminal-workspace"
        style={{
          visibility: isTerminalLayerVisible ? 'visible' : 'hidden',
          pointerEvents: isTerminalLayerVisible ? 'auto' : 'none',
          zIndex: isTerminalLayerVisible ? 10 : 0,
        }}
      >
        <div className="flex-1 flex min-h-0 relative">
        {/* Side panel with tab header + content (SFTP / Scripts / Theme).
            Uses `order-last` instead of flex-row-reverse on the parent so the
            workspace focus-mode sidebar and terminal area below stay in source
            order (sidebar on the left) regardless of the side panel's side. */}
        {(isSidePanelOpenForCurrentTab || mountedSftpTabIds.length > 0 || mountedAiTabIds.length > 0) && (
          <>
            <div
              style={{ width: isSidePanelOpenForCurrentTab ? sidePanelWidth : 0 }}
              className={cn(
                "flex-shrink-0 h-full relative z-20",
                sidePanelPosition === 'right' && "order-last",
              )}
              data-section="terminal-side-panel-shell"
              data-side-panel-position={sidePanelPosition}
            >
              {isSidePanelOpenForCurrentTab && (
                <div
                  className={cn(
                    "absolute top-0 h-full w-2 cursor-ew-resize z-30",
                    sidePanelPosition === 'left' ? "right-[-3px]" : "left-[-3px]",
                  )}
                  onMouseDown={handleSidePanelResizeStart}
                />
              )}
              <div
                className={cn(
                  "h-full flex flex-col overflow-hidden",
                  !isSidePanelOpenForCurrentTab && "pointer-events-none",
                )}
                data-section="terminal-side-panel"
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
                    style={{
                      borderBottom: '1px solid var(--terminal-sidepanel-border)',
                    }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
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
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('terminal.layer.sftp')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
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
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('terminal.layer.scripts')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
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
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('terminal.layer.theme')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
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
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('terminal.layer.aiChat')}</TooltipContent>
                    </Tooltip>
                    <div className="flex-1" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md p-0 hover:bg-transparent"
                          style={{
                            color: 'var(--terminal-sidepanel-muted)',
                          }}
                          onClick={() => setSidePanelPosition(p => p === 'left' ? 'right' : 'left')}
                        >
                          {sidePanelPosition === 'left' ? <PanelRight size={15} /> : <PanelLeft size={15} />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {sidePanelPosition === 'left' ? t('terminal.layer.movePanelRight') : t('terminal.layer.movePanelLeft')}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md p-0 hover:bg-transparent"
                          style={{
                            color: 'var(--terminal-sidepanel-muted)',
                          }}
                          onClick={handleCloseSidePanel}
                        >
                          <X size={15} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('terminal.layer.closePanel')}</TooltipContent>
                    </Tooltip>
                  </div>
                )}
                <div className="flex-1 min-h-0 relative">
                  {/* SFTP sub-panel */}
                  {mountedSftpTabIds.map((tabId) => {
                    const isVisibleSftpPanel = activeTabId === tabId && activeSidePanelTab === 'sftp';
                    return (
                        <SftpSidePanel
                          key={tabId}
                          hosts={effectiveHosts}
                          writableHosts={hosts}
                          keys={keys}
                          identities={identities}
                          updateHosts={updateHosts}
                          sftpDefaultViewMode={sftpDefaultViewMode}
                          activeHost={isVisibleSftpPanel ? sftpActiveHost : null}
                          activeSessionId={isVisibleSftpPanel ? ctx.activeTerminalSessionIdForSftp : null}
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
                          onRequestTerminalFocus={refocusActiveTerminalSession}
                          terminalSettings={terminalSettings}
                        />
                    );
                  })}

                  {/* Scripts sub-panel */}
                  {activeSidePanelTab === 'scripts' && (
                    <div className="absolute inset-0 z-10">
                      <ScriptsSidePanel
                        snippets={snippets}
                        packages={snippetPackages}
                        onSnippetClick={handleSnippetFromPanel}
                      />
                    </div>
                  )}

                  {/* Theme sub-panel */}
                  {activeSidePanelTab === 'theme' && (
                    <div className="absolute inset-0 z-10">
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
                      />
                    </div>
                  )}

                  <AIChatPanelsHost
                    mountedTabIds={mountedAiTabIds}
                    activeTabId={activeTabId}
                    activeSidePanelTab={activeSidePanelTab}
                    contextsByTabId={aiContextsByTabId}
                    resolveExecutorContext={resolveAIExecutorContext}
                    pendingTerminalSelection={pendingTerminalSelectionForAI}
                    onPendingTerminalSelectionConsumed={handlePendingTerminalSelectionConsumed}
                  />

                </div>
              </div>
            </div>
          </>
        )}

        {/* Focus mode sidebar */}
        {isFocusMode && renderFocusModeSidebar()}


        <div ref={workspaceInnerRef} className="overflow-hidden relative flex-1">
          {draggingSessionId && !isFocusMode && (
            <div
              ref={workspaceOverlayRef}
              className="absolute inset-0 z-30"
              onDragOver={(e) => {
                if (isFocusMode) return;
                if (!e.dataTransfer.types.includes('session-id')) return;
                e.preventDefault();
                e.stopPropagation();
                const hint = computeSplitHint(e);
                setDropHint(hint);
              }}
              onDragLeave={(e) => {
                if (!e.dataTransfer.types.includes('session-id')) return;
                setDropHint(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleWorkspaceDrop(e);
              }}
            >
              {dropHint && (
                <div className="absolute inset-0 pointer-events-none">
                  <div
                    className="absolute bg-emerald-600/35 border border-emerald-400/70 backdrop-blur-sm transition-all duration-150"
                    style={{
                      width: dropHint.rect ? `${dropHint.rect.w}px` : dropHint.direction === 'vertical' ? '50%' : '100%',
                      height: dropHint.rect ? `${dropHint.rect.h}px` : dropHint.direction === 'vertical' ? '100%' : '50%',
                      left: dropHint.rect ? `${dropHint.rect.x}px` : dropHint.direction === 'vertical' ? (dropHint.position === 'left' ? 0 : '50%') : 0,
                      top: dropHint.rect ? `${dropHint.rect.y}px` : dropHint.direction === 'vertical' ? 0 : (dropHint.position === 'top' ? 0 : '50%'),
                    }}
                  />
                </div>
              )}
            </div>
          )}
          <TerminalPanesHost
            sessions={sessions}
            sessionHostsMap={sessionHostsMap}
            sessionChainHostsMap={sessionChainHostsMap}
            sessionSudoAutofillPasswordsMap={sessionSudoAutofillPasswordsMap}
            workspaceById={workspaceById}
            workspaceRectsById={workspaceRectsById}
            isTerminalLayerVisible={isTerminalLayerVisible}
            workspaceFocusHandlersRef={workspaceFocusHandlersRef}
            workspaceBroadcastHandlersRef={workspaceBroadcastHandlersRef}
            splitHorizontalHandlersRef={splitHorizontalHandlersRef}
            splitVerticalHandlersRef={splitVerticalHandlersRef}
            themePreview={themePreview}
            keys={keys}
            identities={identities}
            snippets={snippets}
            knownHosts={knownHosts}
            terminalFontFamilyId={terminalFontFamilyId}
            fontSize={fontSize}
            terminalTheme={terminalTheme}
            followAppTerminalTheme={followAppTerminalTheme}
            accentMode={accentMode}
            customAccent={customAccent}
            terminalSettings={terminalSettings}
            hotkeyScheme={hotkeyScheme}
            keyBindings={keyBindings}
            isResizing={!!resizing}
            isComposeBarOpen={isComposeBarOpen}
            sessionLog={sessionLogConfig}
            sshDebugLogEnabled={sshDebugLogsEnabled}
            onHotkeyAction={onHotkeyAction}
            onTerminalFontSizeChange={handleTerminalFontSizeChange}
            onOpenSftp={handleOpenSftp}
            onTerminalCwdChange={handleTerminalCwdChange}
            onOpenScripts={handleOpenScripts}
            onOpenTheme={handleOpenTheme}
            onCloseSession={handleCloseSession}
            onStatusChange={handleStatusChange}
            onSessionExit={handleSessionExit}
            onTerminalDataCapture={handleTerminalDataCapture}
            onOsDetected={handleOsDetected}
            onUpdateHost={handleUpdateHost}
            onAddKnownHost={handleAddKnownHost}
            onCommandExecuted={handleCommandExecuted}
            onSetWorkspaceFocusedSession={onSetWorkspaceFocusedSession}
            onSplitSession={onSplitSession}
            isBroadcastEnabled={isBroadcastEnabled}
            onBroadcastInput={handleBroadcastInput}
            onToggleWorkspaceComposeBar={handleToggleWorkspaceComposeBar}
            onSnippetExecutorChange={handleSnippetExecutorChange}
            onAddSelectionToAI={handleAddSelectionToAI}
          />
          {/* Only show resizers in split view mode, not in focus mode */}
          {!isFocusMode && activeResizers.map(handle => {
            const isVertical = handle.direction === 'vertical';
            // Expand hit area perpendicular to the split line, but stay within bounds
            // Vertical split (left-right): expand horizontally, keep vertical bounds
            // Horizontal split (top-bottom): expand vertically, keep horizontal bounds
            const left = isVertical ? handle.rect.x - 3 : handle.rect.x;
            const top = isVertical ? handle.rect.y : handle.rect.y - 3;
            const width = isVertical ? handle.rect.w + 6 : handle.rect.w;
            const height = isVertical ? handle.rect.h : handle.rect.h + 6;

            return (
              <div
                key={handle.id}
                className={cn("absolute group", isVertical ? "cursor-ew-resize" : "cursor-ns-resize")}
                data-section="terminal-split-resizer"
                data-split-direction={handle.direction}
                style={{
                  left: `${left}px`,
                  top: `${top}px`,
                  width: `${width}px`,
                  height: `${height}px`,
                  zIndex: 25,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const ws = activeWorkspace;
                  if (!ws) return;
                  const split = findSplitNode(ws.root, handle.splitId);
                  const childCount = split && split.type === 'split' ? split.children.length : 0;
                  const sizes = split && split.type === 'split' && split.sizes && split.sizes.length === childCount
                    ? split.sizes
                    : Array(childCount).fill(1);
                  setResizing({
                    workspaceId: ws.id,
                    splitId: handle.splitId,
                    index: handle.index,
                    direction: handle.direction,
                    startSizes: sizes.length ? sizes : [1, 1],
                    startArea: handle.splitArea,
                    startClient: { x: e.clientX, y: e.clientY },
                  });
                }}
              >
                <div
                  data-section="terminal-split-resizer-bar"
                  className={cn(
                    "absolute bg-border/70 group-hover:bg-primary/60 transition-colors",
                    isVertical ? "w-px h-full left-1/2 -translate-x-1/2" : "h-px w-full top-1/2 -translate-y-1/2"
                  )}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Global compose bar for workspace mode */}
        {activeWorkspace && isComposeBarOpen && (
          <TerminalComposeBar
            onSend={handleComposeSend}
            onClose={() => {
              setIsComposeBarOpen(false);
              refocusTerminalSession(focusedSessionId);
            }}
            isBroadcastEnabled={isBroadcastEnabled?.(activeWorkspace.id)}
            themeColors={composeBarThemeColors}
          />
        )}
      </div>
    </AIStateProvider>
  );
}
