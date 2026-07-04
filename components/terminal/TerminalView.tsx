/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo, useCallback, useEffect, useState } from 'react';

import { OSC7_SETUP_TARGETS } from './osc7Setup';
import { TerminalServerStats } from './TerminalServerStats';
import {
  TerminalTimestampGutter,
  resolveTerminalTimestampGutterColor,
  resolveTerminalTimestampGutterWidth,
} from './TerminalTimestampGutter';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

type TerminalViewContext = Record<string, any>;
type HostLineTimestampToggle = {
  id: string;
  showLineTimestamps?: boolean;
};

export function getLineTimestampToggleHostUpdate<T extends HostLineTimestampToggle>(
  host: T,
): Pick<T, "id"> & { showLineTimestamps: boolean } {
  return {
    id: host.id,
    showLineTimestamps: host.showLineTimestamps !== true,
  };
}

export function shouldShowLineTimestampToolbarToggle(
  lineTimestampsAvailable: boolean | undefined,
  onUpdateHost: unknown,
): boolean {
  return lineTimestampsAvailable !== false && Boolean(onUpdateHost);
}

export function shouldEnableYmodemAction({
  isSerialConnection,
  status,
  handleSendYmodem,
  handleReceiveYmodem,
}: {
  isSerialConnection?: boolean;
  status?: string;
  handleSendYmodem?: () => void;
  handleReceiveYmodem?: () => void;
}): boolean {
  return Boolean(isSerialConnection && status === "connected" && (handleSendYmodem || handleReceiveYmodem));
}

export function shouldShowSelectionAIOverlay({
  hasSelection,
  selectionOverlayPosition,
  onAddSelectionToAI,
  showSelectionAIAction,
}: {
  hasSelection: boolean;
  selectionOverlayPosition?: { left: number; top: number } | null;
  onAddSelectionToAI?: unknown;
  showSelectionAIAction?: boolean;
}): boolean {
  return Boolean(
    showSelectionAIAction !== false
    && hasSelection
    && selectionOverlayPosition
    && onAddSelectionToAI,
  );
}

export function shouldReconnectTerminalOnEnterKey({
  key,
  status,
  hasRetryHandler,
  isSearchOpen,
  isComposeBarOpen,
  needsAuth,
  needsHostKeyVerification,
  hasBlockingOverlay,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
  isComposing,
}: {
  key: string;
  status?: string;
  hasRetryHandler: boolean;
  isSearchOpen: boolean;
  isComposeBarOpen: boolean;
  needsAuth: boolean;
  needsHostKeyVerification: boolean;
  hasBlockingOverlay: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return key === "Enter"
    && status === "disconnected"
    && hasRetryHandler
    && !isSearchOpen
    && !isComposeBarOpen
    && !needsAuth
    && !needsHostKeyVerification
    && !hasBlockingOverlay
    && !altKey
    && !ctrlKey
    && !metaKey
    && !shiftKey
    && !isComposing;
}

export function shouldBlockTerminalReconnectForTarget({
  isWithinXterm,
  hasInteractiveAncestor,
}: {
  isWithinXterm: boolean;
  hasInteractiveAncestor: boolean;
}): boolean {
  return !isWithinXterm && hasInteractiveAncestor;
}

function isTerminalReconnectControlTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return shouldBlockTerminalReconnectForTarget({
    isWithinXterm: target.classList.contains("xterm-helper-textarea") || Boolean(target.closest(".xterm")),
    hasInteractiveAncestor: Boolean(target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='menuitem'], [role='textbox']")),
  });
}

type TerminalTitleAddressHost = {
  id?: string;
  protocol?: string;
  username?: string;
  hostname?: string;
  port?: number;
};

export function formatTerminalTitleConnectionAddress(host?: TerminalTitleAddressHost): string | null {
  if (!host || host.protocol === 'local' || host.id?.startsWith('local-') || !host.hostname || host.hostname === 'localhost') {
    return null;
  }
  const isSerial = host.protocol === 'serial' || host.id?.startsWith('serial-');
  const username = !isSerial && host.username ? `${host.username}@` : '';
  const port = !isSerial && host.port ? `:${host.port}` : '';
  return `${username}${host.hostname}${port}`;
}

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
  const { Activity, Button, Clock3, Copy, Maximize2, Radio, Sparkles, SquareArrowOutUpRight, TerminalAutocomplete, TerminalComposeBar, TerminalConnectionDialog, TerminalContextMenu, TerminalSearchBar, Tooltip, TooltipContent, TooltipTrigger, ZmodemOverwriteDialog, ZmodemProgressIndicator, auth, autocompleteAcceptTextRef, autocompleteCloseRef, autocompleteHostOs, autocompleteInputRef, autocompleteKeyEventRef, autocompleteRepositionRef, autocompleteSettings, chainProgress, cn, compactToolbar, lineTimestampsAvailable, containerRef, effectiveFontSize, effectiveFontWeight, effectiveTheme, error, executeSnippet, executeSnippetCommand, handleAddSelectionToAI, handleCancelConnect, handleCloseDisconnectedSession, handleCloseSearch, handleDismissDisconnectedDialog, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleFindNext, handleFindPrevious, handleHostKeyAddAndContinue, handleHostKeyClose, handleHostKeyContinue, handleOsc52ReadResponse, handleOsc7SetupConfirm, handleOsc7SetupOpenChange, handleReceiveYmodem, handleRetry, handleSearch, handleSendYmodem, handleTopOverlayMouseDownCapture, hasMouseTracking, hasSelection, host, hotkeyScheme, inWorkspace, isBroadcastEnabled, isCancelling, isComposeBarOpen, isConnectionAwaitingUserInput, isDraggingOver, isFocusMode, isLocalConnection, remoteDragDropUsesZmodem, isSerialConnection, isSearchOpen, isSupportedOs, isSystemSidebarEligible, isVisible, keyBindings, keys, knownCwdRef, needsHostKeyVerification, onCloseSession, onDetach, onDetachPointerDown, onExpandToFocus, onOpenSystem, onRename, onSplitHorizontal, onSplitVertical, onToggleBroadcast, onUpdateHost, osc52ReadPromptVisible, osc7SetupOpen, osc7SetupRunning, pendingHostKeyInfo, progressLogs, progressValue, renderControls, resolvedFontFamily, restoreState, scriptExecutionOverlay, searchMatchCount, searchFocusToken, selectionOverlayPosition, sessionDisplayName, sessionId, sessionRef, setIsComposeBarOpen, setShowLogs, shouldShowConnectionDialog, showLogs, showSelectionAIAction, snippets, status, sudoHintRef, sudoHintText, t, termRef, terminalContextActions, terminalCwdTracker, terminalPreviewVars, terminalSettings, timeLeft, toast, zmodem } = ctx;
  const ymodemActionEnabled = shouldEnableYmodemAction({
    isSerialConnection,
    status,
    handleSendYmodem,
    handleReceiveYmodem,
  });
  const terminalToolbarOffset = isSearchOpen ? 64 : 30;
  const terminalBodyInset = 4;
  const terminalContentTop = `${terminalToolbarOffset + terminalBodyInset}px`;
  const showLineTimestampGutter = lineTimestampsAvailable !== false && host.showLineTimestamps === true;
  const lineTimestampColor = resolveTerminalTimestampGutterColor(effectiveTheme.colors);
  const [lineTimestampGutterWidth, setLineTimestampGutterWidth] = useState(() => (
    resolveTerminalTimestampGutterWidth({ fontSize: effectiveFontSize })
  ));
  useEffect(() => {
    if (showLineTimestampGutter) return;
    setLineTimestampGutterWidth(resolveTerminalTimestampGutterWidth({ fontSize: effectiveFontSize }));
  }, [effectiveFontSize, effectiveFontWeight, resolvedFontFamily, sessionId, showLineTimestampGutter]);
  const handleLineTimestampGutterWidthChange = useCallback((width: number) => {
    setLineTimestampGutterWidth((current) => (current === width ? current : width));
  }, []);
  const activeLineTimestampGutterWidth = showLineTimestampGutter ? lineTimestampGutterWidth : 0;
  const lineTimestampToggleLabel = showLineTimestampGutter
    ? t("terminal.toolbar.timestampsDisable")
    : t("terminal.toolbar.timestampsEnable");
  const titleConnectionAddress = formatTerminalTitleConnectionAddress(host);
  const handleTerminalKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!shouldReconnectTerminalOnEnterKey({
      key: event.key,
      status,
      hasRetryHandler: Boolean(handleRetry),
      isSearchOpen,
      isComposeBarOpen,
      needsAuth: Boolean(auth.needsAuth),
      needsHostKeyVerification: Boolean(needsHostKeyVerification),
      hasBlockingOverlay: Boolean(osc52ReadPromptVisible || osc7SetupOpen || scriptExecutionOverlay || zmodem.active || zmodem.overwriteRequest),
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) {
      return;
    }

    if (isTerminalReconnectControlTarget(event.target)) return;

    event.preventDefault();
    event.stopPropagation();
    handleRetry();
  }, [
    auth.needsAuth,
    handleRetry,
    isComposeBarOpen,
    isSearchOpen,
    needsHostKeyVerification,
    osc52ReadPromptVisible,
    osc7SetupOpen,
    scriptExecutionOverlay,
    status,
    zmodem.active,
    zmodem.overwriteRequest,
  ]);
  return (
    <TerminalContextMenu
      hasSelection={hasSelection}
      hotkeyScheme={hotkeyScheme}
      keyBindings={keyBindings}
      rightClickBehavior={terminalSettings?.rightClickBehavior}
      isAlternateScreen={hasMouseTracking}
      onCopy={terminalContextActions.onCopy}
      onPaste={terminalContextActions.onPaste}
      onUploadClipboardImage={status === "connected" ? terminalContextActions.onUploadClipboardImage : undefined}
      onPasteSelection={terminalContextActions.onPasteSelection}
      onSelectAll={terminalContextActions.onSelectAll}
      onClear={terminalContextActions.onClear}
      onSelectWord={terminalContextActions.onSelectWord}
      onSplitHorizontal={onSplitHorizontal}
      onSplitVertical={onSplitVertical}
      onSendYmodem={ymodemActionEnabled ? handleSendYmodem : undefined}
      onReceiveYmodem={ymodemActionEnabled ? handleReceiveYmodem : undefined}
      isReconnectable={status === "disconnected"}
      onReconnect={handleRetry}
      onClose={inWorkspace ? () => onCloseSession?.(sessionId) : undefined}
      onAddSelectionToAI={ctx.onAddSelectionToAI ? handleAddSelectionToAI : undefined}
      onRename={onRename}
      onDetach={inWorkspace ? onDetach : undefined}
    >
      <div
        className={cn(
          "relative h-full w-full flex min-h-0 overflow-hidden",
          isComposeBarOpen && !inWorkspace && "flex-col"
        )}
        style={{
          ...terminalPreviewVars,
          backgroundColor: 'var(--terminal-ui-bg)',
        }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onKeyDownCapture={handleTerminalKeyDownCapture}
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
                    : remoteDragDropUsesZmodem
                      ? t("terminal.dragDrop.remoteZmodemMessage")
                      : t("terminal.dragDrop.remoteSftpMessage")
                  }
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="absolute left-0 right-0 top-0 z-20 pointer-events-none">
          <div
            className="terminal-topbar flex items-center gap-1 px-2 py-0.5 backdrop-blur-md pointer-events-auto min-w-0"
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
            <div
              className={cn(
                "terminal-title-cluster flex items-center gap-1 text-[11px] font-semibold min-w-0 overflow-hidden shrink",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-1 min-w-0",
                  inWorkspace && onDetachPointerDown && "cursor-grab active:cursor-grabbing",
                )}
                data-terminal-detach-drag-handle={inWorkspace && onDetachPointerDown ? "true" : undefined}
                onPointerDown={onDetachPointerDown}
              >
                <span className="whitespace-nowrap truncate min-w-0 max-w-[18rem]" title={titleConnectionAddress || sessionDisplayName || host.label}>
                  {titleConnectionAddress || sessionDisplayName || host.label}
                </span>
                {host.protocol !== "local" && host.hostname && host.hostname !== "localhost" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="ml-0.5 p-0.5 rounded hover:bg-[color:var(--terminal-toolbar-btn-hover)] transition-colors opacity-60 hover:opacity-100 flex-shrink-0"
                        onPointerDown={(event) => event.stopPropagation()}
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
              {shouldShowLineTimestampToolbarToggle(lineTimestampsAvailable, onUpdateHost) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "ml-0.5 p-0.5 rounded transition-colors flex-shrink-0",
                        "hover:bg-[color:var(--terminal-toolbar-btn-hover)]",
                        showLineTimestampGutter ? "opacity-100" : "opacity-60 hover:opacity-100",
                      )}
                      style={
                        showLineTimestampGutter
                          ? {
                            backgroundColor: 'var(--terminal-toolbar-btn-active)',
                            color: lineTimestampColor,
                          }
                          : undefined
                      }
                      onClick={() => onUpdateHost(getLineTimestampToggleHostUpdate(host))}
                      aria-label={lineTimestampToggleLabel}
                      aria-pressed={showLineTimestampGutter}
                    >
                      <Clock3 size={10} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{lineTimestampToggleLabel}</TooltipContent>
                </Tooltip>
              )}
              {isSystemSidebarEligible && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="ml-0.5 p-0.5 rounded hover:bg-[color:var(--terminal-toolbar-btn-hover)] transition-colors opacity-60 hover:opacity-100 flex-shrink-0"
                      onClick={onOpenSystem}
                      aria-label={t("terminal.layer.system")}
                    >
                      <Activity size={10} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("terminal.layer.system")}</TooltipContent>
                </Tooltip>
              )}
            </div>
            {!compactToolbar && (
              <TerminalServerStats
                sessionId={sessionId}
                enabled={terminalSettings?.showServerStats ?? true}
                refreshInterval={terminalSettings?.serverStatsRefreshInterval ?? 5}
                isSupportedOs={isSupportedOs}
                isConnected={status === 'connected'}
                isVisible={isVisible}
              />
            )}
            <div className="flex-1 min-w-0" />
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
              {inWorkspace && onDetach && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className="h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent"
                      onClick={onDetach}
                      aria-label={t('terminal.toolbar.detach')}
                    >
                      <SquareArrowOutUpRight size={12} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('terminal.toolbar.detach')}</TooltipContent>
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
                focusToken={searchFocusToken}
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
            className="xterm-container absolute"
            data-font-smoothing={terminalSettings?.fontSmoothing !== false ? "true" : "false"}
            style={{
              top: terminalContentTop,
              left: activeLineTimestampGutterWidth + terminalBodyInset,
              right: terminalBodyInset,
              bottom: terminalBodyInset,
              paddingLeft: 6,
              backgroundColor: 'var(--terminal-ui-bg)',
            }}
          />
          <TerminalTimestampGutter
            termRef={termRef}
            containerRef={containerRef}
            enabled={showLineTimestampGutter}
            top={terminalContentTop}
            left={terminalBodyInset}
            bottom={terminalBodyInset}
            sessionId={sessionId}
            color={lineTimestampColor}
            fontFamily={resolvedFontFamily}
            fontSize={effectiveFontSize}
            fontWeight={effectiveFontWeight}
            width={lineTimestampGutterWidth}
            onWidthChange={handleLineTimestampGutterWidthChange}
          />
          {shouldShowSelectionAIOverlay({
            hasSelection,
            selectionOverlayPosition,
            onAddSelectionToAI: ctx.onAddSelectionToAI,
            showSelectionAIAction,
          }) && handleAddSelectionToAI && (
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
            searchBarOffset={terminalToolbarOffset + terminalBodyInset}
            keyEventRef={autocompleteKeyEventRef}
            inputRef={autocompleteInputRef}
            repositionRef={autocompleteRepositionRef}
            closeRef={autocompleteCloseRef}
            sudoHintRef={sudoHintRef}
            sudoHintText={sudoHintText}
          />

          {scriptExecutionOverlay}

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

          <Dialog open={Boolean(osc7SetupOpen)} onOpenChange={handleOsc7SetupOpenChange}>
            <DialogContent className="sm:max-w-[640px]">
              <DialogHeader>
                <DialogTitle>{t("terminal.osc7Setup.title")}</DialogTitle>
                <DialogDescription>
                  {t("terminal.osc7Setup.desc")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-md border border-border/70 bg-muted/35 p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {t("terminal.osc7Setup.targets")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {OSC7_SETUP_TARGETS.map((target) => (
                      <code
                        key={target}
                        className="rounded bg-background px-2 py-1 text-[11px] text-foreground"
                      >
                        {target}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="secondary" onClick={() => handleOsc7SetupOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={handleOsc7SetupConfirm} disabled={status !== "connected" || osc7SetupRunning}>
                  {osc7SetupRunning ? t("terminal.osc7Setup.running") : t("terminal.osc7Setup.run")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Connection dialog: skip for local/serial during connecting phase, but show on error */}
          {shouldShowConnectionDialog && (
              <TerminalConnectionDialog
                host={host}
                status={status}
                restoreState={restoreState}
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
                  isAwaitingUserInput: Boolean(isConnectionAwaitingUserInput),
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
                bytesPerSecond={zmodem.bytesPerSecond}
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
