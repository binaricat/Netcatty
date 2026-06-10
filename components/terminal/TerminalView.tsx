/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalServerStats } from './TerminalServerStats';

type TerminalViewContext = Record<string, any>;

/**
 * Shallow-compare every ctx value. <Terminal> rebuilds the ctx object on every
 * render, but many re-renders (layout/fit/visibility-of-other-panes, suppress
 * toggles) don't actually change any value passed to the view — notably
 * `paneLayoutKey`/`isResizing` are consumed by Terminal's hooks and are NOT in
 * this ctx. Without this memo, every Terminal re-render re-rendered the whole
 * (expensive) TerminalView. This only skips when EVERY value is referentially
 * equal, so it can never render stale UI.
 */
function terminalViewCtxEqual(
  prev: { ctx: TerminalViewContext },
  next: { ctx: TerminalViewContext },
): boolean {
  const a = prev.ctx;
  const b = next.ctx;
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function TerminalViewInner({ ctx }: { ctx: TerminalViewContext }) {
  const { Button, Copy, Maximize2, Radio, Sparkles, TerminalAutocomplete, TerminalComposeBar, TerminalConnectionDialog, TerminalContextMenu, TerminalSearchBar, Tooltip, TooltipContent, TooltipTrigger, ZmodemOverwriteDialog, ZmodemProgressIndicator, auth, autocompleteAcceptTextRef, autocompleteCloseRef, autocompleteHostOs, autocompleteInputRef, autocompleteKeyEventRef, autocompleteRepositionRef, autocompleteSettings, chainProgress, cn, containerRef, effectiveTheme, error, executeSnippet, executeSnippetCommand, handleAddSelectionToAI, handleCancelConnect, handleCloseDisconnectedSession, handleCloseSearch, handleDismissDisconnectedDialog, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleFindNext, handleFindPrevious, handleHostKeyAddAndContinue, handleHostKeyClose, handleHostKeyContinue, handleOsc52ReadResponse, handleRetry, handleSearch, handleTopOverlayMouseDownCapture, hasMouseTracking, hasSelection, host, hotkeyScheme, inWorkspace, isBroadcastEnabled, isCancelling, isComposeBarOpen, isDraggingOver, isFocusMode, isLocalConnection, isSearchOpen, isSupportedOs, isVisible, keyBindings, keys, knownCwdRef, needsHostKeyVerification, onCloseSession, onExpandToFocus, onSplitHorizontal, onSplitVertical, onToggleBroadcast, osc52ReadPromptVisible, pendingHostKeyInfo, progressLogs, progressValue, renderControls, searchMatchCount, selectionOverlayPosition, sessionId, sessionRef, setIsComposeBarOpen, setShowLogs, shouldShowConnectionDialog, showLogs, snippets, status, statusDotTone, sudoHintRef, sudoHintText, t, termRef, terminalContextActions, terminalCwdTracker, terminalPreviewVars, terminalSettings, timeLeft, toast, zmodem } = ctx;
  return (
    <TerminalContextMenu
      hasSelection={hasSelection}
      hotkeyScheme={hotkeyScheme}
      keyBindings={keyBindings}
      rightClickBehavior={terminalSettings?.rightClickBehavior}
      isAlternateScreen={hasMouseTracking}
      onCopy={terminalContextActions.onCopy}
      onPaste={terminalContextActions.onPaste}
      onPasteSelection={terminalContextActions.onPasteSelection}
      onSelectAll={terminalContextActions.onSelectAll}
      onClear={terminalContextActions.onClear}
      onSelectWord={terminalContextActions.onSelectWord}
      onSplitHorizontal={onSplitHorizontal}
      onSplitVertical={onSplitVertical}
      isReconnectable={status === "disconnected"}
      onReconnect={handleRetry}
      onClose={inWorkspace ? () => onCloseSession?.(sessionId) : undefined}
      onAddSelectionToAI={ctx.onAddSelectionToAI ? handleAddSelectionToAI : undefined}
    >
      <div
        className={cn(
          "relative h-full w-full flex min-h-0 overflow-hidden bg-gradient-to-br from-[#050910] via-[#06101a] to-[#0b1220]",
          isComposeBarOpen && !inWorkspace && "flex-col"
        )}
        style={terminalPreviewVars}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag and drop overlay */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 bg-blue-600/20 backdrop-blur-sm border-4 border-dashed border-blue-400 pointer-events-none flex items-center justify-center">
            <div className="bg-background/90 backdrop-blur-md rounded-lg shadow-lg p-6 border border-border">
              <div className="text-center">
                <div className="text-lg font-semibold mb-2">
                  {isLocalConnection
                    ? t("terminal.dragDrop.localTitle")
                    : t("terminal.dragDrop.remoteTitle")
                  }
                </div>
                <div className="text-sm text-muted-foreground">
                  {isLocalConnection
                    ? t("terminal.dragDrop.localMessage")
                    : t("terminal.dragDrop.remoteMessage")
                  }
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="absolute left-0 right-0 top-0 z-20 pointer-events-none">
          <div
            className="flex items-center gap-1 px-2 py-0.5 backdrop-blur-md pointer-events-auto min-w-0"
            onMouseDownCapture={handleTopOverlayMouseDownCapture}
            style={{
              backgroundColor: 'var(--terminal-ui-bg)',
              color: 'var(--terminal-ui-fg)',
              borderColor: 'var(--terminal-ui-border)',
              ['--terminal-toolbar-fg' as never]: 'var(--terminal-ui-fg)',
              ['--terminal-toolbar-bg' as never]: 'var(--terminal-ui-bg)',
              ['--terminal-toolbar-btn' as never]: 'var(--terminal-ui-toolbar-btn)',
              ['--terminal-toolbar-btn-hover' as never]: 'var(--terminal-ui-toolbar-btn-hover)',
              ['--terminal-toolbar-btn-active' as never]: 'var(--terminal-ui-toolbar-btn-active)',
            }}
          >
            <div className="flex items-center gap-1 text-[11px] font-semibold">
              <span className="whitespace-nowrap">{host.label}</span>
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full flex-shrink-0",
                  statusDotTone,
                )}
              />
              {host.protocol !== "local" && host.hostname && host.hostname !== "localhost" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="ml-0.5 p-0.5 rounded hover:bg-[color:var(--terminal-toolbar-btn-hover)] transition-colors opacity-60 hover:opacity-100 flex-shrink-0"
                      onClick={() => {
                        void navigator.clipboard.writeText(host.hostname).then(() => {
                          toast.success(t("terminal.statusbar.copyHostname.toast", { hostname: host.hostname }));
                        }).catch(() => {
                          toast.error(t("terminal.statusbar.copyHostname.error"));
                        });
                      }}
                      aria-label={t("terminal.statusbar.copyHostname.label")}
                    >
                      <Copy size={10} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("terminal.statusbar.copyHostname.tooltip", { hostname: host.hostname })}</TooltipContent>
                </Tooltip>
              )}
            </div>
            <TerminalServerStats
              sessionId={sessionId}
              enabled={terminalSettings?.showServerStats ?? true}
              refreshInterval={terminalSettings?.serverStatsRefreshInterval ?? 5}
              isSupportedOs={isSupportedOs}
              isConnected={status === 'connected'}
              isVisible={isVisible}
            />
            <div className="flex-1" />
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {inWorkspace && onToggleBroadcast && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className={cn(
                        "h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)]",
                        "bg-transparent hover:bg-transparent",
                        isBroadcastEnabled && "text-green-500",
                      )}
                      onClick={onToggleBroadcast}
                      aria-label={
                        isBroadcastEnabled
                          ? t("terminal.toolbar.broadcastDisable")
                          : t("terminal.toolbar.broadcastEnable")
                      }
                    >
                      <Radio size={12} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isBroadcastEnabled
                      ? t("terminal.toolbar.broadcastDisable")
                      : t("terminal.toolbar.broadcastEnable")}
                  </TooltipContent>
                </Tooltip>
              )}
              {inWorkspace && !isFocusMode && onExpandToFocus && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className="h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent"
                      onClick={onExpandToFocus}
                      aria-label={t("terminal.toolbar.focusMode")}
                    >
                      <Maximize2 size={12} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("terminal.toolbar.focusMode")}</TooltipContent>
                </Tooltip>
              )}
              {renderControls({ showClose: inWorkspace })}
            </div>
          </div>
          {isSearchOpen && (
            <div className="pointer-events-auto">
              <TerminalSearchBar
                isOpen={isSearchOpen}
                onClose={handleCloseSearch}
                onSearch={handleSearch}
                onFindNext={handleFindNext}
                onFindPrevious={handleFindPrevious}
                matchCount={searchMatchCount}
              />
            </div>
          )}
        </div>

        <div
          className="flex-1 min-h-0 min-w-0 relative overflow-hidden pt-8"
          style={{ backgroundColor: 'var(--terminal-ui-bg)' }}
        >
          <div
            ref={containerRef}
            className="xterm-container absolute inset-x-0 bottom-0"
            style={{
              top: isSearchOpen ? "64px" : "30px",
              paddingLeft: 6,
              backgroundColor: 'var(--terminal-ui-bg)',
            }}
          />
          {hasSelection && selectionOverlayPosition && ctx.onAddSelectionToAI && handleAddSelectionToAI && (
            <div
              className="absolute z-30 pointer-events-none"
              style={{
                left: selectionOverlayPosition.left,
                top: selectionOverlayPosition.top,
                transform: "translate(-100%, -100%)",
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="pointer-events-auto inline-flex h-7 min-w-max items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[11px] font-medium shadow-lg backdrop-blur-md transition-colors hover:bg-[color:var(--terminal-toolbar-btn-hover)]"
                    style={{
                      backgroundColor: 'color-mix(in srgb, var(--terminal-ui-bg) 86%, transparent)',
                      borderColor: 'var(--terminal-ui-border)',
                      color: 'var(--terminal-ui-fg)',
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={handleAddSelectionToAI}
                    aria-label={t("terminal.selection.addToAI")}
                  >
                    <Sparkles size={12} />
                    <span>{t("terminal.selection.addToAI")}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("terminal.selection.addToAIDesc")}</TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* Autocomplete — owns the hook + popup in its own component so
              suggestion/selection updates don't re-render Terminal. Mounted
              unconditionally; it gates the popup on `visible` internally. */}
          <TerminalAutocomplete
            termRef={termRef}
            sessionId={sessionId}
            hostId={host.id}
            hostOs={autocompleteHostOs}
            settings={autocompleteSettings}
            protocol={host.protocol}
            getCwd={() => terminalCwdTracker.getRendererCwd() ?? knownCwdRef.current}
            onAcceptText={(text) => autocompleteAcceptTextRef.current?.(text)}
            snippets={snippets}
            onAcceptSnippet={(snippet) => void executeSnippet(snippet)}
            themeColors={effectiveTheme.colors}
            containerRef={containerRef}
            searchBarOffset={isSearchOpen ? 64 : 30}
            keyEventRef={autocompleteKeyEventRef}
            inputRef={autocompleteInputRef}
            repositionRef={autocompleteRepositionRef}
            closeRef={autocompleteCloseRef}
            sudoHintRef={sudoHintRef}
            sudoHintText={sudoHintText}
          />

          {/* OSC-52 clipboard read prompt */}
          {osc52ReadPromptVisible && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-background/60"
              onKeyDown={(e) => {
                if (e.key === 'Escape') handleOsc52ReadResponse(false);
              }}
            >
              <div className="rounded-lg border bg-card p-4 shadow-lg max-w-sm space-y-3">
                <p className="text-sm font-medium">{t("terminal.osc52.readPrompt.title")}</p>
                <p className="text-sm text-muted-foreground">{t("terminal.osc52.readPrompt.desc")}</p>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => handleOsc52ReadResponse(false)}>
                    {t("terminal.osc52.readPrompt.deny")}
                  </Button>
                  <Button size="sm" autoFocus onClick={() => handleOsc52ReadResponse(true)}>
                    {t("terminal.osc52.readPrompt.allow")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Connection dialog: skip for local/serial during connecting phase, but show on error */}
          {shouldShowConnectionDialog && (
              <TerminalConnectionDialog
                host={host}
                status={status}
                error={error}
                progressValue={progressValue}
                chainProgress={chainProgress}
                needsAuth={auth.needsAuth}
                showLogs={showLogs}
                _setShowLogs={setShowLogs}
                keys={keys}
                onDismissDisconnected={handleDismissDisconnectedDialog}
                hostKeyVerification={needsHostKeyVerification && pendingHostKeyInfo ? {
                  hostKeyInfo: pendingHostKeyInfo,
                  onClose: handleHostKeyClose,
                  onContinue: handleHostKeyContinue,
                  onAddAndContinue: handleHostKeyAddAndContinue,
                } : undefined}
                authProps={{
                  authMethod: auth.authMethod,
                  setAuthMethod: auth.setAuthMethod,
                  authUsername: auth.authUsername,
                  setAuthUsername: auth.setAuthUsername,
                  authPassword: auth.authPassword,
                  setAuthPassword: auth.setAuthPassword,
                  authKeyId: auth.authKeyId,
                  setAuthKeyId: auth.setAuthKeyId,
                  authPassphrase: auth.authPassphrase,
                  setAuthPassphrase: auth.setAuthPassphrase,
                  showAuthPassphrase: auth.showAuthPassphrase,
                  setShowAuthPassphrase: auth.setShowAuthPassphrase,
                  showAuthPassword: auth.showAuthPassword,
                  setShowAuthPassword: auth.setShowAuthPassword,
                  authRetryMessage: auth.authRetryMessage,
                  onSubmit: () => auth.submit(),
                  onSubmitWithoutSave: () => auth.submit({ saveToHost: false }),
                  onCancel: handleCancelConnect,
                  isValid: auth.isValid,
                }}
                progressProps={{
                  timeLeft,
                  isCancelling,
                  progressLogs,
                  onCancelConnect: handleCancelConnect,
                  onCloseSession: handleCloseDisconnectedSession,
                  onRetry: handleRetry,
                }}
              />
            )}

          {/* ZMODEM transfer progress indicator */}
          {zmodem.active && (
            <div className="absolute bottom-4 right-4 z-[25] pointer-events-auto">
              <ZmodemProgressIndicator
                transferType={zmodem.transferType}
                filename={zmodem.filename}
                transferred={zmodem.transferred}
                total={zmodem.total}
                fileIndex={zmodem.fileIndex}
                fileCount={zmodem.fileCount}
                finalizing={zmodem.finalizing}
                onCancel={zmodem.cancel}
              />
            </div>
          )}
          {/* ZMODEM overwrite conflict dialog */}
          {zmodem.overwriteRequest && (
            <ZmodemOverwriteDialog
              filename={zmodem.overwriteRequest.filename}
              onRespond={zmodem.respondOverwrite}
            />
          )}
        </div>

        {/* Compose Bar (solo sessions only; workspace uses TerminalLayer's global bar) */}
        {isComposeBarOpen && !inWorkspace && (
          <TerminalComposeBar
            onSend={(text) => {
              if (sessionRef.current) {
                executeSnippetCommand(text, false);
              }
            }}
            onSnippetClick={(snippet) => void executeSnippet(snippet)}
            snippets={snippets}
            onClose={() => {
              setIsComposeBarOpen(false);
              termRef.current?.focus();
            }}
            isBroadcastEnabled={isBroadcastEnabled}
            themeColors={effectiveTheme.colors}
          />
        )}
      </div>
    </TerminalContextMenu>
  );
}

export const TerminalView = memo(TerminalViewInner, terminalViewCtxEqual);
TerminalView.displayName = 'TerminalView';
