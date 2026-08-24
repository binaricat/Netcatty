/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import {
  getSidePanelLiveSnapshot,
  sidePanelLiveStore,
} from '../../application/state/sidePanelLiveStore';
import { getPaneMagnificationShortcutLabel } from '../../domain/paneMagnification';
import { terminalLayerWorkspaceCtxEqual } from './terminalLayerViewMemo';

type WorkspaceContext = Record<string, any>;

function TerminalLayerWorkspaceSectionInner({ ctx }: { ctx: WorkspaceContext }) {
  // Active workspace / focused session come ONLY from the live store so top-tab
  // switches do not force a TerminalLayerView ctx rebuild just to flip them.
  // Do not fall back to ctx.* — after memo omits activeWorkspace from equality,
  // ctx can still hold a previous workspace after live has been cleared
  // (workspace → solo session). Falling back would keep compose bar / resizer
  // handlers bound to a stale workspace.
  // Panes already derive visibility from activeTabStore themselves.
  const live = useSyncExternalStore(
    sidePanelLiveStore.subscribe,
    sidePanelLiveStore.getSnapshot,
    () => getSidePanelLiveSnapshot(false),
  );
  const activeWorkspace = live.activeWorkspace;
  const focusedSessionId = live.focusedSessionId;
  const isFocusMode = activeWorkspace?.viewMode === 'focus';

  const {
    workspaceInnerRef,
    workspaceOuterRef,
    activeTabId,
    workspaceOverlayRef,
    draggingSessionId,
    dropHint,
    setDropHint,
    computeSplitHint,
    handleWorkspaceDrop,
    TerminalPanesHost,
    sessions,
    sessionHostsMap,
    sessionChainHostsMap,
    sessionSudoAutofillPasswordsMap,
    sessionSudoAutofillCandidatesMap,
    resolvedSessionHostIds,
    workspaceById,
    workspaceRectsById,
    isTerminalLayerVisible,
    magnifiedPane,
    handleMagnifyTerminalPane,
    handleTerminalPaneInteraction,
    handleRestoreMagnifiedPane,
    workspaceFocusHandlersRef,
    workspaceBroadcastHandlersRef,
    splitHorizontalHandlersRef,
    splitVerticalHandlersRef,
    resolveSessionAppearance,
    hostMap,
    keys,
    identities,
    snippets,
    knownHosts,
    terminalFontFamilyId,
    fontSize,
    terminalTheme,
    followAppTerminalTheme,
    accentMode,
    customAccent,
    terminalSettings,
    hotkeyScheme,
    disableTerminalFontZoom,
    restoreTerminalCwd,
    keyBindings,
    resizing,
    isComposeBarOpen,
    sessionLogConfig,
    sshDebugLogsEnabled,
    onHotkeyAction,
    handleTerminalFontSizeChange,
    handleOpenSftp,
    handleTerminalCwdChange,
    handleTerminalTitleChange,
    handleTerminalBell,
    handleTerminalOutput,
    handleTerminalContextReaderChange,
    handleOpenScripts,
    handleOpenHistory,
    handleOpenSystem,
    handleOpenTheme,
    handleCloseSession,
    handleStatusChange,
    handleSessionExit,
    handleTerminalDataCapture,
    handleOsDetected,
    handleUpdateHost,
    handleAddKnownHost,
    handleCommandExecuted,
    handleCommandSubmitted,
    onSetWorkspaceFocusedSession,
    onSplitSession,
    isBroadcastEnabled,
    handleBroadcastInput,
    handleBroadcastInterruptPriorityChange,
    handleToggleWorkspaceComposeBar,
    handleSnippetExecutorChange,
    handleProgrammaticCommandLogRewriteChange,
    handleAddSelectionToAI,
    activeResizers,
    composeBarThemeColors,
    findSplitNode,
    handleComposeSend,
    handleSnippetFromPanel,
    refocusTerminalSession,
    setIsComposeBarOpen,
    setResizing,
    TerminalComposeBar,
    Array,
    cn,
    onStartSessionRename,
    onRemoveSessionFromWorkspace,
    onReorderTabs,
    onStartSessionDrag,
    onEndSessionDrag,
    t,
  } = ctx;

  const activeMagnifiedTerminal = !!activeTabId && magnifiedPane?.tabId === activeTabId
    && magnifiedPane.target.kind === 'terminal'
    ? magnifiedPane
    : null;
  const paneMagnificationShortcutLabel = getPaneMagnificationShortcutLabel(keyBindings, hotkeyScheme);
  const [showMagnificationHint, setShowMagnificationHint] = useState(false);
  useEffect(() => {
    if (!activeMagnifiedTerminal) {
      setShowMagnificationHint(false);
      return undefined;
    }
    setShowMagnificationHint(true);
    const timerId = window.setTimeout(() => setShowMagnificationHint(false), 1800);
    return () => window.clearTimeout(timerId);
  }, [activeMagnifiedTerminal]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
    <div ref={workspaceInnerRef} className="flex-1 min-h-0 overflow-hidden relative">
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
          sessionSudoAutofillCandidatesMap={sessionSudoAutofillCandidatesMap}
          resolvedSessionHostIds={resolvedSessionHostIds}
          workspaceById={workspaceById}
          workspaceRectsById={workspaceRectsById}
          isTerminalLayerVisible={isTerminalLayerVisible}
          magnifiedPane={magnifiedPane}
          onMagnifyTerminalPane={handleMagnifyTerminalPane}
          onTerminalPaneInteraction={handleTerminalPaneInteraction}
          workspaceFocusHandlersRef={workspaceFocusHandlersRef}
          workspaceBroadcastHandlersRef={workspaceBroadcastHandlersRef}
          splitHorizontalHandlersRef={splitHorizontalHandlersRef}
          splitVerticalHandlersRef={splitVerticalHandlersRef}
          resolveSessionAppearance={resolveSessionAppearance}
          hostMap={hostMap}
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
          disableTerminalFontZoom={disableTerminalFontZoom}
          restoreTerminalCwd={restoreTerminalCwd}
          keyBindings={keyBindings}
          isResizing={!!resizing}
          isComposeBarOpen={isComposeBarOpen}
          sessionLog={sessionLogConfig}
          sshDebugLogEnabled={sshDebugLogsEnabled}
          onHotkeyAction={onHotkeyAction}
          onTerminalFontSizeChange={handleTerminalFontSizeChange}
          onOpenSftp={handleOpenSftp}
          onTerminalCwdChange={handleTerminalCwdChange}
          onTerminalTitleChange={handleTerminalTitleChange}
          onTerminalBell={handleTerminalBell}
          onTerminalOutput={handleTerminalOutput}
          onTerminalContextReaderChange={handleTerminalContextReaderChange}
          onOpenScripts={handleOpenScripts}
          onOpenHistory={handleOpenHistory}
          onOpenSystem={handleOpenSystem}
          onOpenTheme={handleOpenTheme}
          onCloseSession={handleCloseSession}
          onStatusChange={handleStatusChange}
          onSessionExit={handleSessionExit}
          onTerminalDataCapture={handleTerminalDataCapture}
          onOsDetected={handleOsDetected}
          onUpdateHost={handleUpdateHost}
          onAddKnownHost={handleAddKnownHost}
          onCommandExecuted={handleCommandExecuted}
          onCommandSubmitted={handleCommandSubmitted}
          onSetWorkspaceFocusedSession={onSetWorkspaceFocusedSession}
          onSplitSession={onSplitSession}
          isBroadcastEnabled={isBroadcastEnabled}
          onBroadcastInput={handleBroadcastInput}
          onBroadcastInterruptPriorityChange={handleBroadcastInterruptPriorityChange}
          onToggleWorkspaceComposeBar={handleToggleWorkspaceComposeBar}
          onSnippetExecutorChange={handleSnippetExecutorChange}
          onProgrammaticCommandLogRewriteChange={handleProgrammaticCommandLogRewriteChange}
          onAddSelectionToAI={handleAddSelectionToAI}
          onStartSessionRename={onStartSessionRename}
          onRemoveSessionFromWorkspace={onRemoveSessionFromWorkspace}
          onReorderTabs={onReorderTabs}
          onStartSessionDrag={onStartSessionDrag}
          onEndSessionDrag={onEndSessionDrag}
        />
        {!isFocusMode && activeResizers.map((handle: any) => {
          const isVertical = handle.direction === 'vertical';
          const left = isVertical ? handle.rect.x - 3 : handle.rect.x;
          const top = isVertical ? handle.rect.y : handle.rect.y - 3;
          const width = isVertical ? handle.rect.w + 6 : handle.rect.w;
          const height = isVertical ? handle.rect.h : handle.rect.h + 6;

          return (
            <div
              key={handle.id}
              className={cn('absolute group', isVertical ? 'cursor-ew-resize' : 'cursor-ns-resize')}
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
                  'absolute bg-border/70 group-hover:bg-primary/60 transition-colors',
                  isVertical ? 'w-px h-full left-1/2 -translate-x-1/2' : 'h-px w-full top-1/2 -translate-y-1/2',
                )}
              />
            </div>
          );
        })}
    </div>

      {activeMagnifiedTerminal && workspaceOuterRef.current && createPortal(
        <>
          <div
            className="absolute inset-0 z-40 bg-background/55 backdrop-blur-[1px]"
            aria-hidden="true"
            data-section="pane-magnification-backdrop"
          />
          {showMagnificationHint && (
            <button
              type="button"
              className="absolute bottom-4 right-4 z-[60] rounded border border-border/70 bg-background/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm animate-in fade-in duration-150"
              onClick={handleRestoreMagnifiedPane}
              data-section="pane-magnification-hint"
              aria-label={t('terminal.paneMagnification.restore')}
            >
              {t('terminal.paneMagnification.hint')}: {t('terminal.layer.terminal')}
              {paneMagnificationShortcutLabel ? ` · ${paneMagnificationShortcutLabel} / Esc` : ' · Esc'}
            </button>
          )}
        </>,
        workspaceOuterRef.current,
      )}

      {activeWorkspace && isComposeBarOpen && (
        <TerminalComposeBar
          onSend={handleComposeSend}
          onSnippetClick={(snippet) => void handleSnippetFromPanel(snippet)}
          snippets={snippets}
          onClose={() => {
            setIsComposeBarOpen(false);
            refocusTerminalSession(focusedSessionId);
          }}
          isBroadcastEnabled={isBroadcastEnabled?.(activeWorkspace.id)}
          themeColors={composeBarThemeColors}
        />
      )}
    </div>
  );
}

export const TerminalLayerWorkspaceSection = memo(
  TerminalLayerWorkspaceSectionInner,
  (prev, next) => terminalLayerWorkspaceCtxEqual(prev.ctx, next.ctx),
);
TerminalLayerWorkspaceSection.displayName = 'TerminalLayerWorkspaceSection';
