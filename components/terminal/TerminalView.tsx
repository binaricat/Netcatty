/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsLeft, GripVertical, Minimize2, Network, PanelLeft, X as XIcon } from 'lucide-react';
import { isSessionReconnectDisabled } from '../top-tabs/SessionTabContextMenuContent';

import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';
import { classifyDistroId } from '../../domain/host';
import type { HostInfoBarTitleMode } from '../../domain/models';
import { useNetworkDeviceModeSuggestion } from '../../application/state/useNetworkDeviceModeSuggestion';
import { isPluginHostProtocol } from '../../domain/pluginConnection';
import { OSC7_SETUP_TARGETS } from './osc7Setup';
import PasswordCredentialPicker from './PasswordCredentialPicker';
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
import { TerminalSelectionAIOverlay } from './TerminalSelectionAIOverlay';
import { getHistoryPreviewSelectionFromRoot } from './runtime/terminalHistoryScrollOverride';

type TerminalViewContext = Record<string, any>;
type HostLineTimestampToggle = {
  id: string;
  showLineTimestamps?: boolean;
};

export function TerminalDisconnectedNotice({
  message,
  reconnectHint,
  bottom,
  left,
  right,
  onPointerDown,
}: {
  message: string;
  reconnectHint?: string;
  bottom: number;
  left: number;
  right: number;
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-terminal-disconnected-notice="true"
      className="absolute z-20 flex h-7 items-center gap-2 overflow-hidden rounded border px-2 text-[11px]"
      onPointerDown={onPointerDown}
      style={{
        bottom,
        left,
        right,
        color: 'var(--terminal-ui-fg)',
        borderColor: 'var(--terminal-ui-border)',
        backgroundColor: 'var(--terminal-ui-bg)',
      }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={message}>{message}</span>
      {reconnectHint && (
        <span
          className="shrink-0"
          style={{ color: 'color-mix(in srgb, var(--terminal-ui-fg) 62%, transparent)' }}
        >
          {reconnectHint}
        </span>
      )}
    </div>
  );
}

export function focusTerminalFromDisconnectedNotice(
  event: Pick<React.PointerEvent<HTMLDivElement>, "preventDefault">,
  focusTerminal: () => void,
): void {
  event.preventDefault();
  focusTerminal();
}

export function resolveTerminalDisconnectedNoticeMessage({
  status,
  error,
  reconnectMessage,
  disconnectedLabel,
  isReconnectActive = false,
}: {
  status: 'connecting' | 'connected' | 'disconnected';
  error?: string | null;
  reconnectMessage?: string | null;
  disconnectedLabel: string;
  isReconnectActive?: boolean;
}): string {
  return status === 'connecting' || isReconnectActive
    ? reconnectMessage || disconnectedLabel
    : error || disconnectedLabel;
}

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

/** Keep the tab/pane; only tear down the live transport. */
export function shouldEnableStatusBarDisconnect(
  status: 'connecting' | 'connected' | 'disconnected' | undefined,
): boolean {
  return status === 'connected' || status === 'connecting';
}

export function shouldEnableStatusBarReconnect(
  status: 'connecting' | 'connected' | 'disconnected' | undefined,
): boolean {
  if (!status) return false;
  return !isSessionReconnectDisabled(status);
}

export function shouldShowStatusBarConnectionControls({
  showConnectionControls,
  hasDisconnectHandler,
  hasReconnectHandler,
}: {
  showConnectionControls?: boolean;
  hasDisconnectHandler?: boolean;
  hasReconnectHandler?: boolean;
}): boolean {
  return Boolean(showConnectionControls && (hasDisconnectHandler || hasReconnectHandler));
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
  isComposeBarOpen,
  needsAuth,
  needsHostKeyVerification,
  hasBlockingOverlay,
  isReconnectActive = false,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
  isComposing,
}: {
  key: string;
  status?: string;
  hasRetryHandler: boolean;
  isComposeBarOpen: boolean;
  needsAuth: boolean;
  needsHostKeyVerification: boolean;
  hasBlockingOverlay: boolean;
  isReconnectActive?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean {
  // Search-bar open state is intentionally not a global gate. While disconnected,
  // find-next is less useful than reconnect; the capture handler still refuses
  // Enter only when a real interactive control outside xterm owns the event
  // (compose/auth/buttons). The terminal search input is allow-listed so an open
  // search bar cannot hide the hint or swallow reconnect (#2544 / #2546).
  return key === "Enter"
    && status === "disconnected"
    && hasRetryHandler
    && !isComposeBarOpen
    && !needsAuth
    && !needsHostKeyVerification
    && !hasBlockingOverlay
    && !isReconnectActive
    && !altKey
    && !ctrlKey
    && !metaKey
    && !shiftKey
    && !isComposing;
}

export function shouldBlockTerminalReconnectForTarget({
  isWithinXterm,
  hasInteractiveAncestor,
  isTerminalSearchInput = false,
}: {
  isWithinXterm: boolean;
  hasInteractiveAncestor: boolean;
  /** Open search may keep focus; disconnected Enter reconnect must still win. */
  isTerminalSearchInput?: boolean;
}): boolean {
  if (isTerminalSearchInput) return false;
  return !isWithinXterm && hasInteractiveAncestor;
}

function isTerminalReconnectControlTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return shouldBlockTerminalReconnectForTarget({
    isWithinXterm: target.classList.contains("xterm-helper-textarea") || Boolean(target.closest(".xterm")),
    hasInteractiveAncestor: Boolean(target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='menuitem'], [role='textbox']")),
    isTerminalSearchInput: Boolean(target.closest("[data-terminal-search-input]")),
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
  if (!host || host.protocol === 'local' || isPluginHostProtocol(host.protocol)
    || host.id?.startsWith('local-') || !host.hostname || host.hostname === 'localhost') {
    return null;
  }
  const isSerial = host.protocol === 'serial' || host.id?.startsWith('serial-');
  const username = !isSerial && host.username ? `${host.username}@` : '';
  const port = !isSerial && host.port ? `:${host.port}` : '';
  return `${username}${host.hostname}${port}`;
}

/** Host info bar label: vault name or user@host, based on settings. */
export function formatTerminalHostInfoBarTitle({
  serverName,
  connectionAddress,
  mode = "address",
}: {
  serverName?: string | null;
  connectionAddress?: string | null;
  mode?: HostInfoBarTitleMode;
}): string {
  const name = (serverName || "").trim();
  const address = (connectionAddress || "").trim();
  if (mode === "label") {
    return name || address;
  }
  return address || name;
}

/** Hover tooltip can show both name and address without consuming bar width. */
export function formatTerminalHostInfoBarTooltip({
  serverName,
  connectionAddress,
}: {
  serverName?: string | null;
  connectionAddress?: string | null;
}): string {
  const name = (serverName || "").trim();
  const address = (connectionAddress || "").trim();
  if (name && address && name !== address) {
    return `${name} · ${address}`;
  }
  return name || address;
}

/** Height (px) of the one-line "enable Network Device Mode" tip strip. */
export const NETWORK_DEVICE_TIP_HEIGHT = 28;

/**
 * Right inset (px) the tip strip must keep clear so it does not paint over — and
 * swallow clicks meant for — the compact speed-dial action toggle. The toggle is
 * only rendered in `isCompactActionsMode` (host info hidden, search closed) at
 * `right-1` with a `w-7` (28px) button, so ~40px clears it plus a small gap.
 */
export const NETWORK_DEVICE_TIP_SPEED_DIAL_CLEARANCE = 40;

export function resolveNetworkDeviceTipRightInset({
  showHostInfoBar,
  isSearchOpen,
}: {
  showHostInfoBar: boolean;
  isSearchOpen: boolean;
}): number {
  // The speed dial only appears when the host info bar is hidden and search is
  // closed (isCompactActionsMode); otherwise nothing sits in the top-right.
  return !showHostInfoBar && !isSearchOpen ? NETWORK_DEVICE_TIP_SPEED_DIAL_CLEARANCE : 0;
}

export function resolveTerminalTopOffsets({
  showHostInfoBar,
  isSearchOpen,
  terminalBodyInset = 4,
  networkDeviceTipHeight = 0,
}: {
  showHostInfoBar: boolean;
  isSearchOpen: boolean;
  terminalBodyInset?: number;
  networkDeviceTipHeight?: number;
}): { toolbarOffset: number; contentTop: string } {
  const toolbarOffset = isSearchOpen ? 64 : showHostInfoBar ? 30 : 0;
  return {
    toolbarOffset,
    // The tip strip stacks directly below the toolbar, so the terminal
    // content must start below both.
    contentTop: `${toolbarOffset + networkDeviceTipHeight + terminalBodyInset}px`,
  };
}

export function resolveTerminalRightInset({
  showHostInfoBar: _showHostInfoBar,
  isSearchOpen: _isSearchOpen,
  terminalBodyInset = 4,
}: {
  showHostInfoBar: boolean;
  isSearchOpen: boolean;
  terminalBodyInset?: number;
}): number {
  // Compact speed-dial floats over the terminal (z-30 overlay). Do not reserve
  // a right gutter for it — that pushes the xterm scrollbar left and leaves a
  // dead strip next to the circular toggle.
  void _showHostInfoBar;
  void _isSearchOpen;
  return terminalBodyInset;
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
  prev: { ctx: TerminalViewContext; isPaneMagnified?: boolean },
  next: { ctx: TerminalViewContext; isPaneMagnified?: boolean },
): boolean {
  if (prev.isPaneMagnified !== next.isPaneMagnified) return false;
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

function TerminalViewInner({ ctx, isPaneMagnified = false }: { ctx: TerminalViewContext; isPaneMagnified?: boolean }) {
  const { Activity, Button, Clock3, Copy, Maximize2, Radio, RefreshCcw, SquareArrowOutUpRight, TerminalAutocomplete, TerminalComposeBar, TerminalConnectionDialog, TerminalContextMenu, TerminalSearchBar, Tooltip, TooltipContent, TooltipTrigger, Unplug, ZmodemOverwriteDialog, ZmodemProgressIndicator, auth, autocompleteAcceptTextRef, autocompleteCloseRef, autocompleteHostOs, autocompleteInputRef, autocompleteKeyEventRef, autocompleteRepositionRef, autocompleteSettings, canUpdateHost, chainProgress, cn, compactToolbar, lineTimestampsAvailable, containerRef, effectiveFontSize, effectiveFontWeight, effectiveTerminalProtocol, effectiveTheme, error, executeSnippet, executeSnippetCommand, handleAddSelectionToAI, handleCancelConnect, handleCloseDisconnectedSession, handleCloseSearch, handleDisconnect, handleDismissDisconnectedDialog, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleFindNext, handleFindPrevious, handleHostKeyAddAndContinue, handleHostKeyClose, handleHostKeyContinue, handleOsc52ReadResponse, handleOsc7SetupConfirm, handleOsc7SetupOpenChange, handleReceiveYmodem, handleRetry, handleSearch, handleSendYmodem, handleTopOverlayMouseDownCapture, hasMouseTracking, host, hotkeyScheme, inWorkspace, isBroadcastEnabled, isCancelling, isComposeBarOpen, isConnectionAwaitingUserInput, isDraggingOver, isFocusMode, isFocusedPane, isLocalConnection, remoteDragDropUsesZmodem, isPluginTerminalProviderAvailable, isReconnectActive, isSerialConnection, isSearchOpen, isSupportedOs, isSystemSidebarEligible, isVisible, keyBindings, keys, knownCwdRef, needsHostKeyVerification, onCloseSession, onDetach, onDetachPointerDown, onExpandToFocus, onTogglePaneMagnification, onOpenSystem, onRename, onSplitHorizontal, onSplitVertical, onToggleBroadcast, onUpdateHost, osc52ReadPromptVisible, osc7SetupOpen, osc7SetupRunning, passwordPromptActiveRef, pendingHostKeyInfo, progressLogs, progressValue, renderControls, resolvedFontFamily, restoreState, scriptExecutionOverlay, searchMatchCount, searchFocusToken, sessionDisplayName, sessionId, workspaceId, sessionRef, setIsComposeBarOpen, setShowLogs, shouldShowConnectionDialog, showDisconnectedTerminalNotice, showConnectionControls, showLogs, showSelectionAIAction, isRestoringSelectionRef, snippets, status, sudoHintRef, sudoHintText, passwordPickerState, onPasswordPickerSelect, passwordPickerTitle, passwordPickerEmptyText, t, termRef, terminalContextActions, terminalCwdTracker, terminalPreviewVars, terminalSettings, terminalReconnectAvailable, reconnectNoticeMessage, timeLeft, toast, zmodem } = ctx;
  // Context menu only needs a snapshot at open; avoid selection state lifting into Terminal.
  const [contextMenuHasSelection, setContextMenuHasSelection] = useState(false);
  const isNetworkDevice = host.deviceType === 'network'
    || classifyDistroId(host.distro) === 'network-device';
  const ymodemActionEnabled = shouldEnableYmodemAction({
    isSerialConnection,
    status,
    handleSendYmodem,
    handleReceiveYmodem,
  });
  const terminalBodyInset = 4;
  const showHostInfoBar = terminalSettings?.showHostInfoBar !== false;

  // One-line "enable Network Device Mode" tip. The persisted once-per-host
  // lifecycle, eligibility, and cross-pane/window sync live in the application
  // hook; here we only wire the enable side effects (persist a sparse host
  // update + toast) and render. `host` is the *effective* session object
  // (group defaults / proxy profile already materialized), so send a sparse
  // update so inherited fields keep tracking their source instead of being
  // frozen as host overrides (#2367).
  const onEnableNetworkDeviceMode = useCallback(() => {
    onUpdateHost({ id: host.id, deviceType: 'network' });
    toast.success(t('terminal.networkDevice.tip.enabled', {
      host: host.label || host.hostname || host.id,
    }));
  }, [host.id, host.label, host.hostname, onUpdateHost, t, toast]);
  const {
    visible: showNetworkDeviceTip,
    enable: enableNetworkDeviceMode,
    dismiss: dismissNetworkDeviceTip,
  } = useNetworkDeviceModeSuggestion({
    host,
    connected: status === 'connected',
    canUpdateHost,
    onEnable: onEnableNetworkDeviceMode,
  });

  const [compactActionsOpen, setCompactActionsOpen] = useState(false);
  const compactActionsRef = useRef<HTMLDivElement | null>(null);
  const compactActionsButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!compactActionsOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (compactActionsRef.current?.contains(event.target as Node)) return;
      if (
        event.target instanceof Element
        && event.target.closest('[data-radix-popper-content-wrapper]')
      ) return;
      setCompactActionsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCompactActionsOpen(false);
      compactActionsButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [compactActionsOpen]);
  const { toolbarOffset: terminalToolbarOffset, contentTop: terminalContentTop } = resolveTerminalTopOffsets({
    showHostInfoBar,
    isSearchOpen,
    terminalBodyInset,
    networkDeviceTipHeight: showNetworkDeviceTip ? NETWORK_DEVICE_TIP_HEIGHT : 0,
  });
  const terminalRightInset = resolveTerminalRightInset({
    showHostInfoBar,
    isSearchOpen,
    terminalBodyInset,
  });
  const terminalBottomInset = terminalBodyInset + (showDisconnectedTerminalNotice ? 28 : 0);
  const disconnectedTerminalNoticeMessage = resolveTerminalDisconnectedNoticeMessage({
    status,
    error,
    reconnectMessage: reconnectNoticeMessage,
    disconnectedLabel: t('terminal.progress.disconnected'),
    isReconnectActive,
  });
  // Optimistic override so the gutter paints immediately; host vault write can
  // lag behind without making the toolbar feel sticky.
  const [timestampOverride, setTimestampOverride] = useState<boolean | null>(null);
  const hostTimestampsEnabled = host.showLineTimestamps === true;
  useEffect(() => {
    if (timestampOverride === null) return;
    if (hostTimestampsEnabled === timestampOverride) {
      setTimestampOverride(null);
    }
  }, [hostTimestampsEnabled, timestampOverride]);
  const showLineTimestampGutter = lineTimestampsAvailable !== false
    && (timestampOverride ?? hostTimestampsEnabled);
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
  const handleToggleLineTimestamps = useCallback(() => {
    const next = !showLineTimestampGutter;
    setTimestampOverride(next);
    // Defer vault write so first paint of the gutter is not blocked by host
    // sanitize/encrypt scheduling on the same turn.
    queueMicrotask(() => {
      onUpdateHost({ id: host.id, showLineTimestamps: next });
    });
  }, [host.id, onUpdateHost, showLineTimestampGutter]);
  const titleConnectionAddress = formatTerminalTitleConnectionAddress(host);
  // Prefer vault host.label over sessionDisplayName so dynamic tab titles
  // (cwd / coding-cli) do not replace the stable server name in this bar.
  const hostInfoBarServerName = host.label || sessionDisplayName;
  const hostInfoBarTitle = formatTerminalHostInfoBarTitle({
    serverName: hostInfoBarServerName,
    connectionAddress: titleConnectionAddress,
    mode: terminalSettings?.hostInfoBarTitleMode ?? "address",
  });
  const hostInfoBarTooltip = formatTerminalHostInfoBarTooltip({
    serverName: hostInfoBarServerName,
    connectionAddress: titleConnectionAddress,
  });
  const hasBlockingReconnectOverlay = Boolean(osc52ReadPromptVisible || osc7SetupOpen || scriptExecutionOverlay || zmodem.active || zmodem.overwriteRequest);
  const showEnterReconnectHint = shouldReconnectTerminalOnEnterKey({
    key: "Enter",
    status,
    hasRetryHandler: Boolean(handleRetry) && terminalReconnectAvailable !== false,
    isComposeBarOpen,
    needsAuth: Boolean(auth.needsAuth),
    needsHostKeyVerification: Boolean(needsHostKeyVerification),
    hasBlockingOverlay: hasBlockingReconnectOverlay,
    isReconnectActive,
  });
  const handleTerminalKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!shouldReconnectTerminalOnEnterKey({
      key: event.key,
      status,
      hasRetryHandler: Boolean(handleRetry) && terminalReconnectAvailable !== false,
      isComposeBarOpen,
      needsAuth: Boolean(auth.needsAuth),
      needsHostKeyVerification: Boolean(needsHostKeyVerification),
      hasBlockingOverlay: hasBlockingReconnectOverlay,
      isReconnectActive,
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
    hasBlockingReconnectOverlay,
    isComposeBarOpen,
    isReconnectActive,
    needsHostKeyVerification,
    status,
    terminalReconnectAvailable,
  ]);
  return (
    <TerminalContextMenu
      sessionId={sessionId}
      workspaceId={workspaceId}
      status={status}
      hostId={host?.id}
      hostProtocol={host?.protocol ?? 'ssh'}
      hasSelection={contextMenuHasSelection}
      hotkeyScheme={hotkeyScheme}
      keyBindings={keyBindings}
      rightClickBehavior={terminalSettings?.rightClickBehavior}
      isAlternateScreen={hasMouseTracking}
      getMouseTrackingMode={() => termRef.current?.modes.mouseTrackingMode}
      showContextMenuOverFullscreenApps={terminalSettings?.showContextMenuOverFullscreenApps}
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
      isReconnectable={status === "disconnected" && !isReconnectActive && terminalReconnectAvailable !== false}
      onReconnect={!isReconnectActive && terminalReconnectAvailable !== false ? handleRetry : undefined}
      onClose={inWorkspace ? () => onCloseSession?.(sessionId) : undefined}
      onAddSelectionToAI={ctx.onAddSelectionToAI ? handleAddSelectionToAI : undefined}
      onRename={onRename}
      onDetach={inWorkspace ? onDetach : undefined}
    >
      <div
        onContextMenu={() => {
          const term = termRef.current;
          setContextMenuHasSelection(Boolean(
            term?.hasSelection()
            || getHistoryPreviewSelectionFromRoot(term?.element?.parentElement),
          ));
        }}
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
        <div
          ref={compactActionsRef}
          className="absolute left-0 right-0 top-0 z-20 pointer-events-none"
          onMouseDownCapture={handleTopOverlayMouseDownCapture}
        >
          {(() => {
            const isCompactActionsMode = !showHostInfoBar && !isSearchOpen;
            const toolbarSurfaceStyle = {
              backgroundColor: 'var(--terminal-ui-bg)',
              color: 'var(--terminal-ui-fg)',
              borderColor: 'var(--terminal-ui-border)',
              ['--terminal-toolbar-fg' as never]: 'var(--terminal-ui-fg)',
              ['--terminal-toolbar-bg' as never]: 'var(--terminal-ui-bg)',
              ['--terminal-toolbar-btn' as never]: 'var(--terminal-ui-toolbar-btn)',
              ['--terminal-toolbar-btn-hover' as never]: 'var(--terminal-ui-toolbar-btn-hover)',
              ['--terminal-toolbar-btn-active' as never]: 'var(--terminal-ui-toolbar-btn-active)',
            } as React.CSSProperties;

            const terminalActionsBody = (
              <>
                <div
                  className={cn(
                    "flex items-center gap-1 text-[11px] font-semibold min-w-0 overflow-hidden shrink",
                    showHostInfoBar && "terminal-title-cluster",
                  )}
                >
                  {!showHostInfoBar && inWorkspace && onDetachPointerDown && (
                    <div
                      role="button"
                      tabIndex={-1}
                      title={t("terminal.toolbar.dragPane")}
                      aria-label={t("terminal.toolbar.dragPane")}
                      className={cn(
                        "flex h-6 w-5 shrink-0 items-center justify-center rounded-md",
                        "cursor-grab active:cursor-grabbing",
                        "text-[color:var(--terminal-toolbar-fg)] opacity-45 hover:opacity-90",
                        "hover:bg-[color:var(--terminal-toolbar-btn-hover)] transition-colors",
                      )}
                      data-terminal-detach-drag-handle="true"
                      onPointerDown={onDetachPointerDown}
                    >
                      <GripVertical size={12} strokeWidth={2} aria-hidden="true" />
                    </div>
                  )}
                  {showHostInfoBar && <div
                    className={cn(
                      "flex items-center gap-1 min-w-0",
                      inWorkspace && onDetachPointerDown && "cursor-grab active:cursor-grabbing",
                    )}
                    data-terminal-detach-drag-handle={inWorkspace && onDetachPointerDown ? "true" : undefined}
                    onPointerDown={onDetachPointerDown}
                  >
                    <span className="whitespace-nowrap truncate min-w-0 max-w-[18rem]" title={hostInfoBarTooltip || hostInfoBarTitle}>
                      {hostInfoBarTitle}
                    </span>
                  </div>}
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
                          onClick={handleToggleLineTimestamps}
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
                  {shouldShowStatusBarConnectionControls({
                    showConnectionControls,
                    hasDisconnectHandler: Boolean(handleDisconnect),
                    hasReconnectHandler: Boolean(handleRetry),
                  }) && (
                    <>
                      {handleDisconnect && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "ml-0.5 p-0.5 rounded transition-colors flex-shrink-0",
                                "hover:bg-[color:var(--terminal-toolbar-btn-hover)]",
                                shouldEnableStatusBarDisconnect(status)
                                  ? "opacity-60 hover:opacity-100"
                                  : "opacity-30 cursor-not-allowed",
                              )}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={handleDisconnect}
                              disabled={!shouldEnableStatusBarDisconnect(status)}
                              aria-label={t("terminal.statusbar.disconnect.label")}
                            >
                              <Unplug size={10} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{t("terminal.statusbar.disconnect.tooltip")}</TooltipContent>
                        </Tooltip>
                      )}
                      {handleRetry && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "ml-0.5 p-0.5 rounded transition-colors flex-shrink-0",
                                "hover:bg-[color:var(--terminal-toolbar-btn-hover)]",
                                shouldEnableStatusBarReconnect(status) && !isReconnectActive
                                  ? "opacity-60 hover:opacity-100"
                                  : "opacity-30 cursor-not-allowed",
                              )}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={handleRetry}
                              disabled={!shouldEnableStatusBarReconnect(status) || isReconnectActive}
                              aria-label={t("terminal.statusbar.reconnect.label")}
                            >
                              <RefreshCcw size={10} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{t("terminal.statusbar.reconnect.tooltip")}</TooltipContent>
                        </Tooltip>
                      )}
                    </>
                  )}
                </div>
                {showHostInfoBar && !compactToolbar && (
                  <TerminalServerStats
                    sessionId={sessionId}
                    enabled={(terminalSettings?.showServerStats ?? true) && isVisible}
                    refreshInterval={terminalSettings?.serverStatsRefreshInterval ?? 5}
                    isSupportedOs={isSupportedOs}
                    isConnected={status === 'connected'}
                  />
                )}
                {showHostInfoBar && <div className="flex-1 min-w-0" />}
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
                          aria-label={t('terminal.toolbar.focusMode')}
                        >
                          <PanelLeft size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t('terminal.toolbar.focusMode')}</TooltipContent>
                    </Tooltip>
                  )}
                  {inWorkspace && !isFocusMode && onTogglePaneMagnification && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="secondary"
                          size="icon"
                          className="h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent"
                          onClick={onTogglePaneMagnification}
                          aria-label={t(isPaneMagnified
                            ? 'terminal.paneMagnification.restore'
                            : 'terminal.paneMagnification.magnify')}
                        >
                          {isPaneMagnified ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {t(isPaneMagnified
                          ? 'terminal.paneMagnification.restore'
                          : 'terminal.paneMagnification.magnify')}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {renderControls({ showClose: inWorkspace, restorePaneLayout: isPaneMagnified })}
                </div>
              </>
            );

            if (isCompactActionsMode) {
              // Speed-dial: circular toggle; full action strip springs out to the left.
              // Do NOT use `.terminal-topbar` here — it sets container-type:inline-size,
              // which size-contains the inline axis and collapses width to 0 when we
              // animate max-width / rely on content sizing (buttons never appear).
              // Shared h-7 keeps the toggle and the action pill the same height as the
              // inner h-6 icon buttons + vertical padding.
              // No box-shadow: the 0fr→1fr expand clip always slices shadows and
              // looks worse than a clean border-only chrome.
              const compactChromeClass =
                "h-7 rounded-full border backdrop-blur-md";
              return (
                <div
                  className="absolute right-1 top-1 z-30 flex flex-row-reverse items-center pointer-events-none"
                  data-section="terminal-toolbar"
                >
                  <Tooltip open={compactActionsOpen ? false : undefined}>
                    <TooltipTrigger asChild>
                      <button
                        ref={compactActionsButtonRef}
                        type="button"
                        className={cn(
                          "relative z-10 flex w-7 shrink-0 items-center justify-center pointer-events-auto",
                          compactChromeClass,
                          "opacity-80 hover:opacity-100 focus-visible:opacity-100",
                          "transition-[transform,opacity] duration-200 ease-out",
                          compactActionsOpen && "opacity-100",
                        )}
                        style={{
                          backgroundColor: 'var(--terminal-ui-bg)',
                          borderColor: 'var(--terminal-ui-border)',
                          color: 'var(--terminal-ui-fg)',
                        }}
                        aria-label={t("terminal.toolbar.showActions")}
                        aria-expanded={compactActionsOpen}
                        aria-controls={`terminal-actions-${sessionId}`}
                        onClick={() => setCompactActionsOpen((open) => !open)}
                      >
                        {/* Closed: chevrons point left (expand that way). Open: close. */}
                        {compactActionsOpen
                          ? <XIcon size={12} strokeWidth={2} aria-hidden="true" />
                          : <ChevronsLeft size={13} strokeWidth={2} aria-hidden="true" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("terminal.toolbar.showActions")}</TooltipContent>
                  </Tooltip>
                  <div
                    className={cn(
                      "grid min-w-0 transition-[grid-template-columns,opacity,margin] duration-200 ease-out",
                      compactActionsOpen
                        ? "mr-1.5 grid-cols-[1fr] opacity-100 pointer-events-auto"
                        : "mr-0 grid-cols-[0fr] opacity-0 pointer-events-none",
                    )}
                  >
                    <div className="min-w-0 overflow-hidden">
                      <div
                        id={`terminal-actions-${sessionId}`}
                        aria-hidden={!compactActionsOpen ? true : undefined}
                        className={cn(
                          "flex w-max items-center gap-0.5 px-1.5",
                          compactChromeClass,
                        )}
                        data-host-info-visible="false"
                        style={toolbarSurfaceStyle}
                      >
                        {terminalActionsBody}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <div
                id={`terminal-actions-${sessionId}`}
                className={cn(
                  "terminal-topbar flex items-center gap-1 py-0.5 backdrop-blur-md min-w-0",
                  showHostInfoBar
                    ? "px-2 pointer-events-auto"
                    : "ml-auto w-fit rounded-bl-md px-1 pointer-events-auto",
                )}
                data-host-info-visible={showHostInfoBar ? "true" : "false"}
                data-section="terminal-toolbar"
                style={toolbarSurfaceStyle}
              >
                {terminalActionsBody}
              </div>
            );
          })()}
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
          className={cn(
            "flex-1 min-h-0 min-w-0 relative overflow-hidden",
            showHostInfoBar && "pt-8",
          )}
          style={{ backgroundColor: 'var(--terminal-ui-bg)' }}
        >
          {showNetworkDeviceTip && (
            <div
              className="absolute left-0 z-20 flex items-center gap-2 px-3 border-b border-border/60 bg-card/95 backdrop-blur-sm text-[11px]"
              style={{
                top: terminalToolbarOffset,
                right: resolveNetworkDeviceTipRightInset({ showHostInfoBar, isSearchOpen }),
                height: NETWORK_DEVICE_TIP_HEIGHT,
              }}
            >
              <Network size={13} className="shrink-0 text-blue-500" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-foreground/90">
                {t('terminal.networkDevice.tip.message')}
              </span>
              <button
                type="button"
                onClick={enableNetworkDeviceMode}
                className="shrink-0 rounded px-2 py-0.5 font-medium text-primary hover:bg-primary/10 transition-colors"
              >
                {t('terminal.networkDevice.tip.action')}
              </button>
              <button
                type="button"
                onClick={dismissNetworkDeviceTip}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary/80 transition-colors"
                aria-label={t('terminal.networkDevice.tip.dismiss')}
              >
                <XIcon size={12} />
              </button>
            </div>
          )}
          <div
            ref={containerRef}
            className="xterm-container absolute"
            data-font-smoothing={terminalSettings?.fontSmoothing !== false ? "true" : "false"}
            style={{
              top: terminalContentTop,
              left: activeLineTimestampGutterWidth + terminalBodyInset,
              right: terminalRightInset,
              bottom: terminalBottomInset,
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
            bottom={terminalBottomInset}
            sessionId={sessionId}
            color={lineTimestampColor}
            fontFamily={resolvedFontFamily}
            fontSize={effectiveFontSize}
            fontWeight={effectiveFontWeight}
            width={lineTimestampGutterWidth}
            onWidthChange={handleLineTimestampGutterWidthChange}
          />
          {showDisconnectedTerminalNotice && (
            <TerminalDisconnectedNotice
              message={disconnectedTerminalNoticeMessage}
              reconnectHint={showEnterReconnectHint ? t('terminal.progress.enterReconnectHint') : undefined}
              bottom={terminalBodyInset}
              left={terminalBodyInset}
              right={terminalRightInset}
              onPointerDown={(event) => focusTerminalFromDisconnectedNotice(
                event,
                () => termRef.current?.focus(),
              )}
            />
          )}
          <TerminalSelectionAIOverlay
            termRef={termRef}
            containerRef={containerRef}
            showSelectionAIAction={showSelectionAIAction}
            onAddSelectionToAI={handleAddSelectionToAI}
            copyOnSelect={terminalSettings?.copyOnSelect}
            normalizeTextOnCopy={terminalSettings?.normalizeTextOnCopy ?? true}
            isRestoringSelectionRef={isRestoringSelectionRef}
            isVisible={isVisible}
          />

          {/* Autocomplete — owns the hook + popup in its own component so
              suggestion/selection updates don't re-render Terminal. Mounted
              unconditionally; it gates the popup on `visible` internally. */}
          <TerminalAutocomplete
            termRef={termRef}
            sessionId={sessionId}
            hostId={host.id}
            hostGroup={host.group}
            hostOs={autocompleteHostOs}
            settings={autocompleteSettings}
            protocol={effectiveTerminalProtocol ?? resolveEffectiveTerminalProtocol(host)}
            workspaceId={workspaceId}
            status={status}
            isVisible={isVisible}
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
            isPluginCompletionProviderAvailable={() => (
              isPluginTerminalProviderAvailable('terminal.completion')
            )}
            sensitiveInputActiveRef={passwordPromptActiveRef}
            allowHostStyleGreaterThanPrompt={isNetworkDevice}
          />

          <PasswordCredentialPicker
            visible={Boolean(passwordPickerState)}
            items={passwordPickerState?.items ?? []}
            selectedIndex={passwordPickerState?.selectedIndex ?? 0}
            onSelect={(id) => onPasswordPickerSelect?.(id)}
            title={passwordPickerTitle ?? "Saved passwords"}
            emptyText={passwordPickerEmptyText ?? "No saved passwords"}
            themeColors={effectiveTheme.colors}
            termRef={termRef}
            containerRef={containerRef}
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
                showEnterReconnectHint={showEnterReconnectHint}
                isFocusedPane={isFocusedPane}
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
                  onRetry: terminalReconnectAvailable !== false ? handleRetry : undefined,
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
