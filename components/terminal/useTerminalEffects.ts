/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import { useRef } from 'react';
import { publishPluginTerminalRuntimeLifecycleEvent } from '../../application/state/pluginTerminalRuntimeLifecycle';
import { markTerminalCommandCompletionPending } from './runtime/promptLineBreak';
import { resolveFontWeightBold } from '../../lib/fontWeightAvailability';
import { bundledFamiliesInStack } from '../../lib/fontAvailability';
import { isMacPlatform } from '../../lib/utils';
import { resolveXTermScrollback } from '../../infrastructure/config/xtermPerformance';
import {
  createMacOptionForcedSelectionMouseEvent,
  shouldInterceptMouseTrackingContextMenu,
  shouldReplayShiftMouseSelectionAsMacOption,
  shouldStopShiftRightClickMouseTrackingMouseDown,
} from './runtime/middleClickBehavior';
import {
  hasOpenAppDialog,
  TERMINAL_SESSION_RESTORE_FOCUS_EVENT,
  type TerminalSessionRestoreFocusDetail,
} from './focusTerminalSession';
import {
  resolveHibernatePreferWasmSerialize,
  resolveTerminalHibernateEnabledForProtocol,
} from '../../domain/terminalHibernate';
import { applyUserCursorBlinkPreference } from './runtime/cursorPreference';
import { getTerminalSelectionForClipboard } from './normalizeTerminalSelection';
import { getFlowControllerForTerm } from './runtime/terminalSessionAttachment';
import {
  prioritizeTerminalInput,
  shouldArmTerminalInterruptDisplayGateForProtocol,
} from './runtime/terminalOutputPipeline';
import { scheduleTerminalThemeUpdate, applyTerminalThemeSync, cancelTerminalThemeUpdate } from './terminalThemeScheduler';
import { injectTerminalPaneAppearanceVars } from '../../infrastructure/theme/terminalAppearanceVars';
import {
  isTerminalAlternateScreenActive,
  nudgeAlternateScreenRedraw,
} from './terminalHibernateRuntime';
import {
  cancelScheduledUnfocusedRepaint,
  flushPendingTerminalWritesOnResume,
  forceTerminalRepaintBypassingAnimationFrame,
  repaintTerminalAfterReveal,
} from './runtime/terminalUnfocusedRepaint';
import {
  forceXTermFontRemeasure,
  type XTermFontRemeasureTarget,
} from './runtime/terminalFontRemeasure';
import {
  isTerminalCloseGenerationCurrent,
  resolveConnectionLogCapturePayload,
  scheduleTerminalCloseTeardown,
  serializeTerminalCloseFallback,
} from './runtime/terminalCloseCapture';
import {
  getConnectionTimeoutMs,
  resolveActiveConnectionTimeoutHost,
  shouldRunConnectionTimeout,
} from './connectionTimeouts';
import { resolveHostSshConnectionTimeouts } from '../../domain/sshConnectionTimeouts';
import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';

type TerminalEffectsContext = Record<string, any>;

type SelectionOverlayPosition = {
  left: number;
  top: number;
} | null;

type ZmodemToastInput = {
  active?: boolean;
  completed?: boolean;
  error?: string | null;
  filename?: string | null;
  transferType?: 'upload' | 'download' | null;
};

type ZmodemToast =
  | { kind: 'error'; message: string; title: string }
  | { kind: 'success'; message: string; title: string }
  | null;

type ZmodemToastApi = {
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
};

const CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS = 3000;

export function resolveZmodemTransferToast(zmodem: ZmodemToastInput): ZmodemToast {
  if (zmodem.active) return null;
  if (zmodem.error) {
    return { kind: 'error', message: zmodem.error, title: 'ZMODEM' };
  }
  if (!zmodem.completed) return null;

  const action = zmodem.transferType === 'upload'
    ? 'Uploaded'
    : zmodem.transferType === 'download'
      ? 'Downloaded'
      : 'Transfer completed';
  const message = zmodem.filename ? `${action}: ${zmodem.filename}` : action;
  return { kind: 'success', message, title: 'ZMODEM' };
}

export function applyZmodemTransferToast(
  zmodem: ZmodemToastInput,
  toastedRef: { current: boolean },
  toast: ZmodemToastApi,
): void {
  if (zmodem.active) {
    toastedRef.current = false;
    return;
  }
  if (toastedRef.current) return;
  const zmodemToast = resolveZmodemTransferToast(zmodem);
  if (!zmodemToast) return;
  toastedRef.current = true;
  if (zmodemToast.kind === 'error') {
    toast.error(zmodemToast.message, zmodemToast.title);
  } else {
    toast.success(zmodemToast.message, zmodemToast.title);
  }
}

const areSelectionOverlayPositionsEqual = (
  a: SelectionOverlayPosition,
  b: SelectionOverlayPosition,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top;
};

export function resolveSelectionOverlayPosition(term: any, container: HTMLElement | null): SelectionOverlayPosition {
  if (!container || !term?.getSelectionPosition || !term.getSelection()) return null;

  const range = term.getSelectionPosition();
  if (!range) return null;

  const start = range.start;
  const end = range.end;
  const startsBeforeEnd =
    start.y < end.y
    || (start.y === end.y && start.x <= end.x);
  const top = startsBeforeEnd ? start : end;
  const bottom = startsBeforeEnd ? end : start;
  const viewportY = term.buffer?.active?.viewportY ?? 0;
  const row = top.y - viewportY;
  const rows = Math.max(1, term.rows ?? 1);
  const cols = Math.max(1, term.cols ?? 1);

  if (row < 0 || row >= rows) return null;

  const screen = container.querySelector<HTMLElement>(".xterm-screen") ?? container;
  const screenRect = screen.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const cellWidth = screen.clientWidth / cols;
  const cellHeight = screen.clientHeight / rows;
  const spansRows = top.y !== bottom.y;
  const rightCol = spansRows ? cols : Math.max(top.x, bottom.x);
  const containerOffsetLeft = container.offsetLeft ?? 0;
  const containerOffsetTop = container.offsetTop ?? 0;
  const selectionRight = containerOffsetLeft + screenRect.left - containerRect.left + Math.min(cols, rightCol) * cellWidth;
  const selectionTop = containerOffsetTop + screenRect.top - containerRect.top + row * cellHeight;

  return {
    left: Math.max(140, Math.min(selectionRight + 8, container.clientWidth - 8)),
    top: Math.max(36, Math.min(selectionTop - 8, container.clientHeight - 8)),
  };
}

export function useTerminalEffects(ctx: TerminalEffectsContext) {
  const { CONNECTION_TIMEOUT, Error, XTERM_PERFORMANCE_CONFIG, applyUserCursorPreference, auth, autocompleteCloseRef, autocompleteInputRef, autocompleteKeyEventRef, captureTerminalLogData, chainHosts, chainProgress, clearTerminalCwd, commandBufferRef, connectionLogBufferRef, containerRef, createPromptLineBreakState, createReplaySafeTerminalLogSanitizer, createXTermRuntime, deferTerminalResizeRef, disableTerminalFontZoomRef, effectiveFontSize, effectiveFontWeight, effectiveTheme, error, executeSnippetCommand, finalizeTerminalLogData, fitAddonRef, fontFamilyId, fontSize, fontWeightFixupDoneRef, forceCloseHibernatedSession, forceSyncRenderAfterResize, handleOsc52ReadRequest, handleTerminalDataCaptureOnce, hasConnectedRef, hasRuntimeRef, host, hotkeySchemeRef, hibernatedRef, identities, inWorkspace, isBootActiveRef, isBroadcastEnabledRef, isComposeBarOpen, isConnectionAwaitingUserInput, isConnectionPastTcpDial, isFocusMode, isFocused, isLocalConnection, isNetworkDevice, isResizing, isRestoringSelectionRef, isSearchOpen, isSerialConnection, isVisible, isVisibleRef, keyBindingsRef, keys, knownCwdRef, lastFittedSizeRef, lastToastedErrorRef, logger, mouseTrackingRef, needsHostKeyVerification, onBroadcastInputRef, onBroadcastInterruptPriorityChange, onCommandExecuted, onCommandSubmitted, onHotkeyActionRef, onOutputTriggerUserInputRef, onPluginRuntimeCwdChange, onSnippetExecutorChange, onTerminalTitleChange, onTerminalBell, onTerminalFontSizeChange, paneLayoutKey, passwordPromptActiveRef, pendingAuthRef, pendingOutputScrollRef, pluginDecorationRules, pluginTerminalLifecycle, pluginTerminalProviderRevision, isPluginTerminalProviderAvailable, requestPluginTerminalProviders, prepareRestoredReconnect, prevIsResizingRef, promptLineBreakStateRef, resizeSession, resolveHostAuth, resolvedFontFamily, safeFit, scriptRecorderRef, searchAddonRef, serialConfig, serialLineBufferRef, serializeAddonRef, sessionId, sessionRef, sessionStarters, setError, setHasMouseTracking, setHasSelection, setIsCancelling, setIsDisconnectedDialogDismissed, requestSearchFocus, setNeedsHostKeyVerification, setPendingHostKeyInfo, setPendingHostKeyRequestId, setProgressLogs, setProgressValue, setSelectionOverlayPosition, setShowLogs, setStatus, setTimeLeft, shouldEnableNativeUserInputAutoScroll, shouldProbeSessionCwd, shouldStartTerminalBackend, attachExistingSession, attachAuthorization, attachHomeWebContentsIdRef, onSnippetShortkeyRef, snippetsRef, splitResizeActive, status, statusRef, sudoAutofillRef, t, teardown, telnetLocalEchoRef, termRef, terminalAltKeyOptions, terminalBackend, terminalContextActionsRef, terminalCwdTracker, terminalDataCapturedRef, terminalLogSanitizerRef, terminalSettings, terminalSettingsRef, toHostKeyInfo, toast, updateStatus, useEffect, useLayoutEffect, xtermRuntimeRef, zmodem, zmodemToastedRef, restoreState } = ctx;
  const effectiveTerminalProtocol = resolveEffectiveTerminalProtocol(host);
  const hibernateHiddenTabs = resolveTerminalHibernateEnabledForProtocol(
    terminalSettings,
    effectiveTerminalProtocol,
  );
  ctx.pluginDecorationRulesRef.current = pluginDecorationRules;
  const pluginAwareOnCommandSubmitted = (...args: Parameters<NonNullable<typeof onCommandSubmitted>>) => {
    markTerminalCommandCompletionPending(promptLineBreakStateRef);
    publishPluginTerminalRuntimeLifecycleEvent(pluginTerminalLifecycle, 'commandSubmitted');
    void xtermRuntimeRef.current?.pluginProviderHost?.commandSubmitted(args[0]);
  };
  const pluginAwareOnCommandCompleted = () => {
    publishPluginTerminalRuntimeLifecycleEvent(pluginTerminalLifecycle, 'commandCompleted');
    void xtermRuntimeRef.current?.pluginProviderHost?.commandCompleted();
  };
  const isRendererActive = isVisible || !hibernateHiddenTabs;
  const isRendererActiveRef = useRef(isRendererActive);
  isRendererActiveRef.current = isRendererActive;

  // Remember the last layout we successfully refit while visible so revisiting
  // the same workspace tab does not replay expensive force-fit/WebGL recovery.
  const lastCommittedVisibleLayoutKeyRef = useRef<string | null>(null);
  const lastWebglRecoveryLayoutKeyRef = useRef<string | null>(null);
  const terminalBootCloseGenerationRef = useRef(0);
  const hiddenAtRef = useRef<number | null>(null);
  const wasVisibleRef = useRef(isVisible);


  useEffect(() => {
    if (xtermRuntimeRef.current) {
      // Merge global rules with host-level rules
      const globalRules = terminalSettings?.keywordHighlightRules ?? [];
      const hostRules = host?.keywordHighlightRules ?? [];
      const providerRules = pluginDecorationRules.map((rule) => ({
        id: rule.id,
        label: rule.label,
        patterns: [...rule.patterns],
        color: rule.color,
        enabled: true,
        providerId: rule.providerId,
      }));

      const globalEnabled = terminalSettings?.keywordHighlightEnabled ?? false;
      // Host-level toggle: undefined = inherit global, true/false = explicit override
      const hostEnabled = host?.keywordHighlightEnabled;

      // Global and host-level highlights are independent:
      // global toggle controls global rules, host toggle controls host-specific rules
      const effectiveGlobalEnabled = globalEnabled;
      const effectiveHostEnabled = hostEnabled ?? false;

      const mergedRules = [
        ...(effectiveGlobalEnabled ? globalRules : []),
        ...(effectiveHostEnabled ? hostRules : []),
        ...providerRules,
      ];
      const isEnabled = effectiveGlobalEnabled || effectiveHostEnabled || providerRules.length > 0;

      xtermRuntimeRef.current.keywordHighlighter.setRules(mergedRules, isEnabled);
    }
  }, [
    terminalSettings?.keywordHighlightEnabled,
    terminalSettings?.keywordHighlightRules,
    host?.keywordHighlightEnabled,
    host?.keywordHighlightRules,
    pluginDecorationRules,
  ]);

  useEffect(() => {
    xtermRuntimeRef.current?.pluginProviderHost?.providerAvailabilityChanged(
      effectiveTheme.colors.background,
    );
    xtermRuntimeRef.current?.pluginLinkProviderHost?.providerAvailabilityChanged();
  }, [
    effectiveTheme.colors.background,
    pluginTerminalProviderRevision,
    xtermRuntimeRef,
  ]);

  useEffect(() => {
    xtermRuntimeRef.current?.pluginProviderHost?.setActive(
      status === 'connected',
      effectiveTheme.colors.background,
    );
    xtermRuntimeRef.current?.pluginLinkProviderHost?.setActive(status === 'connected');
  }, [effectiveTheme.colors.background, status, xtermRuntimeRef]);

  useEffect(() => {
    xtermRuntimeRef.current?.pluginProviderHost?.setVisible(
      isVisible,
      effectiveTheme.colors.background,
    );
    xtermRuntimeRef.current?.pluginLinkProviderHost?.setVisible(isVisible);
  }, [effectiveTheme.colors.background, isVisible, xtermRuntimeRef]);


  // Work around xterm.js WebGL renderer bug: glyphs rendered via the constructor
  // look different from dynamically-set ones. After text appears on screen (status
  // becomes "connected"), do a fontWeight round-trip to normalize the rendering.
  useEffect(() => {
    if (status !== 'connected' || fontWeightFixupDoneRef.current || !termRef.current) return;
    fontWeightFixupDoneRef.current = true;
    const timer = setTimeout(() => {
      if (!termRef.current) return;
      // Re-read the current weight at fire time to avoid stale closures
      const w = termRef.current.options.fontWeight;
      if (w === 'normal' || w === 400) return;
      termRef.current.options.fontWeight = 'normal';
      termRef.current.options.fontWeight = w;
    }, 200);
    return () => clearTimeout(timer);
  }, [status]);


  useEffect(() => {
    clearTerminalCwd({ persistRestoreMetadata: false });
    return () => clearTerminalCwd({ persistRestoreMetadata: false });
  }, [clearTerminalCwd, host.id]);


  useEffect(() => {
    if (host.protocol === "local" || host.protocol === "serial" || host.protocol === "telnet") {
      return;
    }
    if (status !== "connected" || !sessionRef.current || knownCwdRef.current) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const id = sessionRef.current;
      if (!id) return;
      try {
        // The pwd probe opens an extra POSIX-shell exec channel, which strict
        // network-device CLIs like Huawei VRP answer by closing the whole
        // session (#1043). Skip it for known network devices; for a brand-new
        // host (distro not classified yet on the first connect) consult the
        // SSH banner, which is captured for free at handshake time.
        const info = await terminalBackend.getSessionRemoteInfo?.(id);
        if (cancelled || id !== sessionRef.current) return;
        if (!shouldProbeSessionCwd({ isNetworkDevice, remoteSshVersion: info?.remoteSshVersion })) {
          return;
        }
        const result = await terminalBackend.getSessionPwd(id);
        if (!cancelled && !terminalCwdTracker.getRendererCwd() && result.success && result.cwd) {
          onPluginRuntimeCwdChange(result.cwd);
        }
      } catch {
        // Best effort only.
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [host.protocol, status, terminalBackend, terminalCwdTracker, isNetworkDevice]);


  useEffect(() => {
    if (!isVisible) {
      autocompleteCloseRef.current?.();
    }
  }, [isVisible]);

  useEffect(() => {
    applyZmodemTransferToast(zmodem, zmodemToastedRef, toast);
  }, [zmodem.active, zmodem.completed, zmodem.error, zmodem.filename, zmodem.transferType]);


  useEffect(() => {
    if (!error) {
      lastToastedErrorRef.current = null;
      return;
    }
    if (lastToastedErrorRef.current === error) return;
    lastToastedErrorRef.current = error;
    toast.error(error, t("terminal.connectionErrorTitle"));
  }, [error, t]);


  useEffect(() => {
    const dispose = terminalBackend.onHostKeyVerification?.((request) => {
      if (request.sessionId !== sessionId) return;

      setPendingHostKeyRequestId(request.requestId);
      setPendingHostKeyInfo(toHostKeyInfo(request));
      setNeedsHostKeyVerification(true);
      setError(null);
      setProgressLogs((prev) => [
        ...prev,
        request.status === 'changed'
          ? `Host key changed for ${request.hostname}. Waiting for confirmation...`
          : `Host key verification required for ${request.hostname}.`,
      ]);
    });

    return () => {
      dispose?.();
    };
  }, [sessionId, terminalBackend]);


  useEffect(() => {
    let disposed = false;
    let initialFitTimer: ReturnType<typeof setTimeout> | undefined;
    const closeGeneration = ++terminalBootCloseGenerationRef.current;
    isBootActiveRef.current = true;
    terminalDataCapturedRef.current = false;
    connectionLogBufferRef.current.reset();
    terminalLogSanitizerRef.current = createReplaySafeTerminalLogSanitizer();
    setError(null);
    hasConnectedRef.current = false;
    pendingOutputScrollRef.current = false;
    setProgressLogs([]);
    setShowLogs(false);
    setIsCancelling(false);
    setIsDisconnectedDialogDismissed(false);
    promptLineBreakStateRef.current = createPromptLineBreakState();

    const boot = async () => {
      try {
        if (disposed || !containerRef.current) return;

        const runtime = createXTermRuntime({
          container: containerRef.current,
          host,
          fontFamilyId,
          resolvedFontFamily,
          fontSize,
          terminalTheme: effectiveTheme,
          terminalSettingsRef,
          terminalBackend,
          sessionRef,
          hotkeySchemeRef,
          disableTerminalFontZoomRef,
          keyBindingsRef,
          onHotkeyActionRef,
          onTerminalFontSizeChange,
          isBroadcastEnabledRef,
          onBroadcastInputRef,
          snippetsRef,
          onSnippetShortkeyRef,
          sessionId,
          statusRef,
          onCommandExecuted,
          onCommandSubmitted,
          onTrustedCommandSubmitted: pluginAwareOnCommandSubmitted,
          onCommandCompleted: pluginAwareOnCommandCompleted,
          requestPluginTerminalProviders,
          pluginProviderVisible: isVisible,
          isPluginTerminalProviderAvailable,
          onResize: (cols: number, rows: number) => (
            publishPluginTerminalRuntimeLifecycleEvent(pluginTerminalLifecycle, 'resized', { cols, rows })
          ),
          onAlternateScreenChange: (alternateScreen: boolean) => (
            publishPluginTerminalRuntimeLifecycleEvent(
              pluginTerminalLifecycle,
              'alternateScreenChanged',
              { alternateScreen },
            )
          ),
          commandBufferRef,
          promptLineBreakStateRef,
          scriptRecorderRef,
          passwordPromptActiveRef,
          allowHostStyleGreaterThanPrompt: isNetworkDevice,
          onOutputTriggerUserInputRef,
          sudoAutofillRef,
          requestSearchFocus,
          // Serial-specific options
          serialLocalEcho: serialConfig?.localEcho,
          serialLineMode: serialConfig?.lineMode,
          serialLineBufferRef,
          telnetLocalEchoRef,
          onTerminalLogData: captureTerminalLogData,
          onCwdChange: (cwd: string) => {
            onPluginRuntimeCwdChange(cwd, { source: 'osc7' });
          },
          onTitleChange: (title: string | null) => {
            publishPluginTerminalRuntimeLifecycleEvent(
              pluginTerminalLifecycle,
              'titleChanged',
              { ...(title ? { title } : {}) },
            );
            onTerminalTitleChange?.(sessionId, title);
          },
          onBell: () => {
            onTerminalBell?.(sessionId);
          },
          onOsc52ReadRequest: handleOsc52ReadRequest,
          // Autocomplete integration
          onAutocompleteKeyEvent: (e: KeyboardEvent) => autocompleteKeyEventRef.current?.(e) ?? true,
          onAutocompleteInput: (data: string) => autocompleteInputRef.current?.(data),
          terminalContextActionsRef,
          isRestoringSelectionRef,
          // Defer WebGL context creation for panes that mount hidden (e.g. the
          // background tabs of a batch connect) until they first become visible.
          initiallyVisible: isRendererActive,
        });

        if (disposed) {
          runtime.dispose();
          return;
        }

        xtermRuntimeRef.current = runtime;
        termRef.current = runtime.term;
        fitAddonRef.current = runtime.fitAddon;
        serializeAddonRef.current = runtime.serializeAddon;
        searchAddonRef.current = runtime.searchAddon;
        hasRuntimeRef.current = true;
        // xterm boots asynchronously; ResizeObserver may have already run without
        // fitAddon and will not re-attach until isVisible/isResizing changes.
        initialFitTimer = setTimeout(() => {
          if (disposed) return;
          safeFit({ force: true, requireVisible: true });
        }, 0);

        // Apply merged keyword highlight rules immediately after runtime creation
        // This fixes a timing issue where the useEffect for keyword highlighting
        // runs before the runtime is created, causing host-level rules to be missed
        const globalRules = terminalSettingsRef.current?.keywordHighlightRules ?? [];
        const hostRules = host?.keywordHighlightRules ?? [];
        const globalEnabled = terminalSettingsRef.current?.keywordHighlightEnabled ?? false;
        const hostEnabled = host?.keywordHighlightEnabled;
        const effectiveGlobalEnabled = globalEnabled;
        const effectiveHostEnabled = hostEnabled ?? false;
        const mergedRules = [
          ...(effectiveGlobalEnabled ? globalRules : []),
          ...(effectiveHostEnabled ? hostRules : [])
        ];
        const isEnabled = effectiveGlobalEnabled || effectiveHostEnabled;
        runtime.keywordHighlighter.setRules(mergedRules, isEnabled);

        const term = runtime.term;
        const restoredReconnect = restoreState === "restored-disconnected";
        if (restoredReconnect) {
          prepareRestoredReconnect?.();
        }
        const setBackendConnectingStatus = () => {
          if (restoredReconnect) {
            updateStatus("connecting");
          } else {
            setStatus("connecting");
          }
        };

        if (attachExistingSession) {
          // Observe popup: pause → snapshot → rebind → resume so no live bytes
          // fall into the gap between snapshot and route handoff.
          let outputRebound = false;
          let reboundHomeWebContentsId: number | null = null;
          try {
            if (terminalBackend.setSessionFlowPausedAndWait) {
              const paused = await terminalBackend.setSessionFlowPausedAndWait(sessionId, true);
              if (!paused?.success && paused?.error === "Output drain unavailable") {
                terminalBackend.setSessionFlowPaused?.(sessionId, true);
                await new Promise((resolve) => setTimeout(resolve, 40));
              } else if (!paused?.success) {
                throw new Error(paused?.error || "Failed to drain terminal output");
              }
            } else {
              terminalBackend.setSessionFlowPaused?.(sessionId, true);
              await new Promise((resolve) => setTimeout(resolve, 40));
            }
            if (disposed) {
              try { terminalBackend.setSessionFlowPaused?.(sessionId, false); } catch { /* ignore */ }
              return;
            }
            // Snapshot while home still owns the display route (and stream is paused).
            const snap = await terminalBackend.requestSessionSnapshot?.(
              sessionId,
              attachAuthorization || "",
            );
            if (disposed) {
              try { terminalBackend.setSessionFlowPaused?.(sessionId, false); } catch { /* ignore */ }
              return;
            }
            if (!snap?.success) {
              throw new Error(snap?.error || "Failed to capture terminal snapshot");
            }
            if (snap?.success && snap.snapshot) {
              try {
                await new Promise<void>((resolve) => term.write(snap.snapshot!, resolve));
              } catch (writeErr) {
                logger.warn("Failed to write attach snapshot to popup terminal", writeErr);
              }
            }

            const rebind = await terminalBackend.rebindSessionOutput?.(
              sessionId,
              attachAuthorization || "",
            );
            if (disposed) {
              if (rebind?.success) {
                try {
                  await terminalBackend.restoreSessionOutput?.(
                    sessionId,
                    rebind.previousWebContentsId ?? null,
                    attachAuthorization || "",
                  );
                } catch {
                  // Main-process closed lifecycle remains the final fallback.
                }
              }
              try { terminalBackend.setSessionFlowPaused?.(sessionId, false); } catch { /* ignore */ }
              return;
            }
            if (!rebind?.success) {
              try { terminalBackend.setSessionFlowPaused?.(sessionId, false); } catch { /* ignore */ }
              setError(rebind?.error || "Failed to attach to session");
              updateStatus("disconnected");
              isBootActiveRef.current = false;
              return;
            }
            outputRebound = true;
            reboundHomeWebContentsId = rebind.previousWebContentsId ?? null;
            if (attachHomeWebContentsIdRef) {
              attachHomeWebContentsIdRef.current = rebind.previousWebContentsId ?? null;
            }
            sessionRef.current = sessionId;
            const attached = sessionStarters.reattachSession(term);
            if (!attached) {
              throw new Error("Failed to attach display to session");
            }
            // Resume only after the popup has subscribed to the live session.
            terminalBackend.setSessionFlowPaused?.(sessionId, false);
            hasConnectedRef.current = true;
            updateStatus("connected");
            setTimeout(() => {
              if (disposed) return;
              safeFit({ force: true, requireVisible: true });
              try {
                term.scrollToBottom?.();
              } catch {
                // ignore
              }
              try {
                terminalBackend.resizeSession?.(sessionId, term.cols, term.rows);
              } catch {
                // ignore
              }
            }, 50);
          } catch (attachErr) {
            if (outputRebound) {
              try {
                const restored = await terminalBackend.restoreSessionOutput?.(
                  sessionId,
                  reboundHomeWebContentsId,
                  attachAuthorization || "",
                );
                if (restored?.success) terminalBackend.setSessionFlowPaused?.(sessionId, false);
              } catch {
                // Main-process close/recovery lifecycle remains the fallback.
              }
            } else {
              try { terminalBackend.setSessionFlowPaused?.(sessionId, false); } catch { /* ignore */ }
            }
            if (disposed) return;
            logger.error("Failed to attach existing session", attachErr);
            setError(attachErr instanceof Error ? attachErr.message : String(attachErr));
            updateStatus("disconnected");
          }
          isBootActiveRef.current = false;
          return;
        }

        if (!shouldStartTerminalBackend()) {
          isBootActiveRef.current = false;
          return;
        }

        if (effectiveTerminalProtocol === "serial") {
          setBackendConnectingStatus();
          setProgressLogs(["Initializing serial connection..."]);
          await sessionStarters.startSerial(term);
          if (disposed) return;
        } else if (effectiveTerminalProtocol === "local") {
          setBackendConnectingStatus();
          setProgressLogs(["Initializing local shell..."]);
          await sessionStarters.startLocal(term);
          if (disposed) return;
        } else if (effectiveTerminalProtocol === "telnet") {
          setBackendConnectingStatus();
          setProgressLogs(["Initializing Telnet connection..."]);
          await sessionStarters.startTelnet(term);
          if (disposed) return;
        } else if (effectiveTerminalProtocol === "mosh") {
          setBackendConnectingStatus();
          setProgressLogs(["Initializing Mosh connection..."]);
          await sessionStarters.startMosh(term);
          if (disposed) return;
        } else if (effectiveTerminalProtocol === "et") {
          setBackendConnectingStatus();
          setProgressLogs(["Initializing EternalTerminal connection..."]);
          await sessionStarters.startEt(term);
          if (disposed) return;
        } else {
          const resolvedAuth = resolveHostAuth({ host, keys, identities });
          const hasPassword = !!resolvedAuth.password;
          const hasKey = !!resolvedAuth.keyId;
          const hasPendingAuth = pendingAuthRef.current;

          if (
            !hasPassword &&
            !hasKey &&
            !hasPendingAuth &&
            !resolvedAuth.username
          ) {
            auth.setNeedsAuth(true);
            setStatus("disconnected");
            return;
          }

          setBackendConnectingStatus();
          setProgressLogs(["Initializing secure channel..."]);
          await sessionStarters.startSSH(term);
          if (disposed) return;
        }
      } catch (err) {
        if (disposed) return;
        logger.error("Failed to initialize terminal", err);
        setError(err instanceof Error ? err.message : String(err));
        updateStatus("disconnected");
      }
    };

    boot();

    return () => {
      disposed = true;
      if (initialFitTimer !== undefined) clearTimeout(initialFitTimer);
      isBootActiveRef.current = false;
      if (hibernatedRef?.current) {
        forceCloseHibernatedSession?.();
        return;
      }

      const persistCloseCapture = (data: string, source: string, dataLength: number) => {
        logger.info("[Terminal] Capturing data on unmount", {
          sessionId,
          source,
          dataLength,
        });
        handleTerminalDataCaptureOnce(sessionId, data, { finalized: true });
      };

      const connectionLogPayload = !terminalDataCapturedRef.current
        ? resolveConnectionLogCapturePayload(finalizeTerminalLogData)
        : null;
      if (connectionLogPayload) {
        persistCloseCapture(
          connectionLogPayload.data,
          connectionLogPayload.source,
          connectionLogPayload.data.length,
        );
        scheduleTerminalCloseTeardown(teardown);
        return;
      }

      const term = termRef.current;
      const serializeAddon = serializeAddonRef.current;
      if (!terminalDataCapturedRef.current && term && serializeAddon) {
        const preferWasm = resolveHibernatePreferWasmSerialize(terminalSettingsRef.current);
        void serializeTerminalCloseFallback(term, serializeAddon, { preferWasm })
          .then((payload) => {
            if (!isTerminalCloseGenerationCurrent(
              closeGeneration,
              terminalBootCloseGenerationRef.current,
            )) {
              return;
            }
            if (payload) {
              persistCloseCapture(payload.data, payload.source, payload.data.length);
            }
            scheduleTerminalCloseTeardown(teardown);
          })
          .catch((err) => {
            if (!isTerminalCloseGenerationCurrent(
              closeGeneration,
              terminalBootCloseGenerationRef.current,
            )) {
              return;
            }
            logger.warn("Failed to serialize terminal data on unmount:", err);
            scheduleTerminalCloseTeardown(teardown);
          });
        return;
      }

      teardown();
    };
     
  }, [forceCloseHibernatedSession, handleTerminalDataCaptureOnce, host.id, sessionId]);


  // Connection timeline and timeout visuals
  useEffect(() => {
    const hasSshTcpConnectProgress = host.protocol !== "local"
      && host.protocol !== "serial"
      && host.protocol !== "telnet"
      && host.protocol !== "mosh"
      && !host.moshEnabled
      && host.protocol !== "et"
      && !host.etEnabled;
    const timeoutState = {
      status,
      needsAuth: auth.needsAuth,
      isLocalConnection,
      isSerialConnection,
      hasSshTcpConnectProgress,
      needsHostKeyVerification: Boolean(needsHostKeyVerification),
      isConnectionAwaitingUserInput: Boolean(isConnectionAwaitingUserInput),
      isConnectionPastTcpDial: Boolean(isConnectionPastTcpDial),
    };
    if (!shouldRunConnectionTimeout(timeoutState)) return;

    const activeTimeoutHost = resolveActiveConnectionTimeoutHost(
      host,
      chainHosts,
      chainProgress?.currentHop,
      chainProgress?.connectionPhase,
    );
    const hostConnectionTimeouts = resolveHostSshConnectionTimeouts(activeTimeoutHost);
    const connectionTimeout = getConnectionTimeoutMs(timeoutState, {
      tcpConnectTimeoutMs: hostConnectionTimeouts.tcpConnectTimeoutSeconds * 1000,
      authReadyTimeoutMs: hostConnectionTimeouts.authReadyTimeoutSeconds * 1000,
    }) || CONNECTION_TIMEOUT;
    setTimeLeft(connectionTimeout / 1000);
    const countdown = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    const timeout = setTimeout(() => {
      setError("Connection timed out. Please try again.");
      updateStatus("disconnected");
      setProgressLogs((prev) => [...prev, "Connection timed out."]);
    }, connectionTimeout);

    setProgressValue(5);
    const prog = setInterval(() => {
      setProgressValue((prev) => {
        if (prev >= 95) return prev;
        const remaining = 95 - prev;
        const increment = Math.max(1, remaining * 0.15);
        return Math.min(95, prev + increment);
      });
    }, 200);

    return () => {
      clearInterval(countdown);
      clearTimeout(timeout);
      clearInterval(prog);
    };
     
  }, [status, auth.needsAuth, host.protocol, host.hostname, host.moshEnabled, host.etEnabled, host.sshTcpConnectTimeoutSeconds, host.sshAuthReadyTimeoutSeconds, chainHosts, chainProgress?.currentHop, chainProgress?.connectionPhase, isLocalConnection, isSerialConnection, needsHostKeyVerification, isConnectionAwaitingUserInput, isConnectionPastTcpDial]);


  useEffect(() => {
    if (status === "connecting") {
      setIsDisconnectedDialogDismissed(false);
    }
  }, [status]);


  const effectiveThemeKey = `${effectiveTheme.id}:${effectiveTheme.colors.background}:${effectiveTheme.colors.foreground}:${effectiveTheme.colors.cursor}`;

  // Sync xterm theme before browser paint; apply synchronously on visible panes.
  useLayoutEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (isRendererActiveRef.current || isFocused) {
      cancelTerminalThemeUpdate(sessionId);
      applyTerminalThemeSync(term, effectiveTheme);
      injectTerminalPaneAppearanceVars(sessionId, effectiveTheme);
      return;
    }

    scheduleTerminalThemeUpdate(
      sessionId,
      effectiveTheme,
      { visible: false, focused: false },
      () => termRef.current,
    );
  }, [effectiveThemeKey, isFocused, isVisible, sessionId, effectiveTheme]);


  // Keep font-size sync separate from terminalSettings so unrelated setting
  // updates (or focus/layout re-renders) do not reset a wheel/Ctrl zoom that
  // has not yet propagated into React props.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = effectiveFontSize;
    xtermRuntimeRef.current?.clearTextureAtlas();
    if (isRendererActiveRef.current) {
      const refitTimer = setTimeout(() => safeFit({ force: true, requireVisible: true }), 50);
      return () => clearTimeout(refitTimer);
    } else {
      lastFittedSizeRef.current = null;
    }
  }, [effectiveFontSize]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontFamily = resolvedFontFamily;

    if (terminalSettings) {
      applyUserCursorPreference(termRef.current, terminalSettings);
      termRef.current.options.scrollback = resolveXTermScrollback(terminalSettings.scrollback);
      termRef.current.options.fontWeight = effectiveFontWeight as
        | 100
        | 200
        | 300
        | 400
        | 500
        | 600
        | 700
        | 800
        | 900;
      const resolvedFontWeightBold = resolveFontWeightBold({
        fontFamilyCss: termRef.current?.options.fontFamily || "",
        normalWeight: effectiveFontWeight,
        desiredBoldWeight: terminalSettings.fontWeightBold,
        fontSize: effectiveFontSize,
      });

      termRef.current.options.fontWeightBold = resolvedFontWeightBold as
        | 100
        | 200
        | 300
        | 400
        | 500
        | 600
        | 700
        | 800
        | 900;
      termRef.current.options.lineHeight = 1 + terminalSettings.linePadding / 10;
      termRef.current.options.drawBoldTextInBrightColors =
        terminalSettings.drawBoldInBrightColors;
      termRef.current.options.minimumContrastRatio =
        terminalSettings.minimumContrastRatio;
      termRef.current.options.smoothScrollDuration =
        terminalSettings.smoothScrolling
          ? XTERM_PERFORMANCE_CONFIG.rendering.smoothScrollDuration
          : 0;
      termRef.current.options.scrollOnUserInput =
        shouldEnableNativeUserInputAutoScroll(terminalSettings);
      const altKeyOpts = terminalAltKeyOptions(terminalSettings.altAsMeta);
      termRef.current.options.macOptionIsMeta = altKeyOpts.macOptionIsMeta;
      termRef.current.options.altClickMovesCursor = altKeyOpts.altClickMovesCursor;
      termRef.current.options.wordSeparator = terminalSettings.wordSeparators;
      termRef.current.options.ignoreBracketedPasteMode = terminalSettings.disableBracketedPaste ?? false;
    }

    // Changing the font can leave the WebGL renderer drawing stale glyphs from
    // the old metrics (xterm.js #3280), surfacing as garbled text (issue #1049).
    // Clear the texture atlas so glyphs re-rasterize with the new font.
    xtermRuntimeRef.current?.clearTextureAtlas();

    if (isRendererActiveRef.current) {
      const refitTimer = setTimeout(() => safeFit({ force: true, requireVisible: true }), 50);
      return () => clearTimeout(refitTimer);
    } else {
      lastFittedSizeRef.current = null;
    }
  }, [effectiveFontSize, effectiveFontWeight, resolvedFontFamily, terminalSettings]);


  const runImmediateRefit = (options?: { force?: boolean; repeatOnNextFrame?: boolean }) => {
    const force = options?.force === true;
    const repeatOnNextFrame = options?.repeatOnNextFrame ?? force;
    if (force) {
      lastFittedSizeRef.current = null;
    }
    safeFit({ force, requireVisible: true, immediate: true });
    if (force && repeatOnNextFrame && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        safeFit({ force: true, requireVisible: true, immediate: true });
      });
    }
  };

  const syncPtySizeAfterLayout = () => {
    const term = termRef.current;
    const id = sessionRef.current;
    if (!term || !id) return;

    try {
      if (isTerminalAlternateScreenActive(term)) {
        nudgeAlternateScreenRedraw(term);
      } else {
        resizeSession(id, term.cols, term.rows);
      }
    } catch (err) {
      logger.warn('Sync session size after layout failed', err);
    }
  };

  const finishLayoutRecovery = () => {
    const term = termRef.current;
    if (term) {
      forceSyncRenderAfterResize(term);
    }
    syncPtySizeAfterLayout();
  };

  const finishLayoutRecoveryAfterFit = () => {
    const run = () => finishLayoutRecovery();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(run));
      return;
    }
    window.setTimeout(run, 0);
  };

  const layoutRecoveryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearLayoutRecoveryTimers = () => {
    for (const timerId of layoutRecoveryTimersRef.current) {
      clearTimeout(timerId);
    }
    layoutRecoveryTimersRef.current = [];
  };

  // Re-fit after the app returns from the background, macOS fullscreen toggles,
  // or other layout changes that do not reliably fire window.resize /
  // ResizeObserver (common after App Nap / GPU context eviction).
  const scheduleLayoutRecoveryRefit = (delaysMs: number[] = [80, 250]) => {
    clearLayoutRecoveryTimers();
    for (const delayMs of delaysMs) {
      const timerId = setTimeout(() => {
        layoutRecoveryTimersRef.current = layoutRecoveryTimersRef.current.filter((id) => id !== timerId);
        if (!isVisibleRef.current) return;
        runImmediateRefit({ force: true, repeatOnNextFrame: false });
        finishLayoutRecoveryAfterFit();
      }, delayMs);
      layoutRecoveryTimersRef.current.push(timerId);
    }
  };

  useEffect(() => {
    const handleRestoreFocus = (event: Event) => {
      const detail = (event as CustomEvent<TerminalSessionRestoreFocusDetail>).detail;
      if (detail?.sessionId !== sessionId) return;
      if (!isVisibleRef.current) return;

      const term = termRef.current;
      if (!term) return;

      applyUserCursorBlinkPreference(term, terminalSettingsRef.current);
      if (hasOpenAppDialog()) return;
      term.focus();
      scheduleLayoutRecoveryRefit([0, 100]);
    };

    window.addEventListener(TERMINAL_SESSION_RESTORE_FOCUS_EVENT, handleRestoreFocus);
    return () => window.removeEventListener(TERMINAL_SESSION_RESTORE_FOCUS_EVENT, handleRestoreFocus);
  }, [sessionId]);

  const layoutAlreadyCommitted = () => (
    lastCommittedVisibleLayoutKeyRef.current === paneLayoutKey
  );

  const commitVisibleLayout = () => {
    lastCommittedVisibleLayoutKeyRef.current = paneLayoutKey;
  };

  const currentContainerSizeAlreadyFit = () => {
    const container = containerRef.current;
    const lastSize = lastFittedSizeRef.current;
    if (!container || !lastSize) return false;
    const width = container.clientWidth;
    const height = container.clientHeight;
    return width > 0 && height > 0 && lastSize.width === width && lastSize.height === height;
  };

  const getHiddenDurationMs = () => (
    hiddenAtRef.current !== null
      ? Date.now() - hiddenAtRef.current
      : Number.POSITIVE_INFINITY
  );

  const flushPendingOutputScroll = () => {
    if (!pendingOutputScrollRef.current) return;
    termRef.current?.scrollToBottom();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        termRef.current?.scrollToBottom();
      });
    }
    pendingOutputScrollRef.current = false;
  };

  const flushTerminalWritesAfterBecomeVisible = () => {
    lastCommittedVisibleLayoutKeyRef.current = null;
    const term = termRef.current;
    if (term) {
      cancelScheduledUnfocusedRepaint(term);
      flushPendingTerminalWritesOnResume(term);
      repaintTerminalAfterReveal(term, () => isVisibleRef.current);
    }
  };

  const recoverTerminalAfterBecomeVisible = () => {
    flushTerminalWritesAfterBecomeVisible();

    if (
      getHiddenDurationMs() < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS
      && currentContainerSizeAlreadyFit()
    ) {
      lastWebglRecoveryLayoutKeyRef.current = paneLayoutKey;
      flushPendingOutputScroll();
      commitVisibleLayout();
      return;
    }

    xtermRuntimeRef.current?.ensureWebglRenderer();
    xtermRuntimeRef.current?.clearTextureAtlas();
    lastWebglRecoveryLayoutKeyRef.current = paneLayoutKey;

    if (currentContainerSizeAlreadyFit()) {
      finishLayoutRecovery();
      flushPendingOutputScroll();
      commitVisibleLayout();
      return;
    }

    lastFittedSizeRef.current = null;
    runImmediateRefit({ force: true, repeatOnNextFrame: false });
    finishLayoutRecoveryAfterFit();
    flushPendingOutputScroll();
    commitVisibleLayout();
    scheduleLayoutRecoveryRefit([100, 350]);
  };

  // Refit synchronously when a split pane becomes visible or its bounds change.
  // Tab switches hide inactive panes without resizing xterm; becoming visible
  // again does not always fire ResizeObserver, leaving a gap below content.
  // Skip during split-divider drag — refit runs once when split resizing ends.
  // Recover every visible pane immediately so split workspaces return with
  // fresh terminal buffers, scroll positions, and PTY sizes.
  useLayoutEffect(() => {
    const becameVisible = isVisible && !wasVisibleRef.current;

    if (!isVisible) {
      wasVisibleRef.current = false;
      return;
    }

    if (splitResizeActive) return;

    wasVisibleRef.current = true;

    if (becameVisible) {
      recoverTerminalAfterBecomeVisible();
      return;
    }

    if (layoutAlreadyCommitted()) {
      safeFit({ requireVisible: true });
      return;
    }

    commitVisibleLayout();
    runImmediateRefit({ force: true, repeatOnNextFrame: false });
    finishLayoutRecoveryAfterFit();
  }, [isVisible, paneLayoutKey, splitResizeActive]);

  useLayoutEffect(() => {
    if (isVisible) return;
    lastCommittedVisibleLayoutKeyRef.current = null;
    lastWebglRecoveryLayoutKeyRef.current = null;
    if (hiddenAtRef.current === null) {
      hiddenAtRef.current = Date.now();
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;

    const hiddenMs = hiddenAtRef.current
      ? Date.now() - hiddenAtRef.current
      : Number.POSITIVE_INFINITY;
    hiddenAtRef.current = null;

    if (
      lastWebglRecoveryLayoutKeyRef.current === paneLayoutKey
      && hiddenMs < CSS_ONLY_TAB_REVEAL_MAX_HIDDEN_MS
    ) {
      flushPendingOutputScroll();
      return;
    }

    const timer = setTimeout(() => {
      lastWebglRecoveryLayoutKeyRef.current = paneLayoutKey;
      // A pane that mounted hidden deferred its WebGL renderer; create it now
      // that it's visible (no-op if already active or WebGL is disabled).
      xtermRuntimeRef.current?.ensureWebglRenderer();
      // Recover the WebGL renderer now that this tab is visible again. Hidden
      // panes stay mounted off-screen (visibility:hidden) so each keeps a live
      // WebGL context; creating another terminal's context — or the GPU dropping
      // a non-composited off-screen canvas — can leave this terminal's drawing
      // buffer corrupted ("花屏", issue #1063). Because a hidden pane keeps its
      // dimensions, becoming visible triggers no resize and therefore no redraw,
      // so the corruption persists until the user resizes the window. Force the
      // same recovery a resize performs: clear the texture atlas (no-op on the
      // DOM renderer) and synchronously repaint every row.
      xtermRuntimeRef.current?.clearTextureAtlas();
      runImmediateRefit({ force: true });
      finishLayoutRecoveryAfterFit();
      flushPendingOutputScroll();
    }, 50);
    return () => clearTimeout(timer);
  }, [isVisible, paneLayoutKey]);


  useEffect(() => {
    let cancelled = false;

    // Re-derive cell metrics and repaint after a font finishes loading. xterm
    // measures the cell grid once at open(); a webfont that swaps in later
    // (font-display: swap on the bundled JetBrains Mono / Sarasa Mono SC, or
    // any user-chosen webfont) leaves the grid sized to the fallback until a
    // manual resize (#1647). This performs the same recovery a resize does.
    const remeasureAfterFontLoad = () => {
      const term = termRef.current as {
        cols: number;
        rows: number;
      } & XTermFontRemeasureTarget | null;
      if (cancelled || !term) return;
      if (!isRendererActiveRef.current) {
        lastFittedSizeRef.current = null;
        return;
      }
      const fitAddon = fitAddonRef.current;
      try {
        if (!forceXTermFontRemeasure(term)) {
          logger.warn("Font remeasure skipped: xterm measurement hook unavailable");
        }
      } catch (err) {
        logger.warn("Font remeasure failed", err);
      }

      // Font remeasurement does not invalidate cells rasterized before fonts were ready.
      xtermRuntimeRef.current?.clearTextureAtlas();
      const visibleTerm = termRef.current;
      if (visibleTerm) {
        forceSyncRenderAfterResize(visibleTerm);
      }

      try {
        fitAddon?.fit();
      } catch (err) {
        logger.warn("Fit after fonts ready failed", err);
      }

      if (terminalSettings && termRef.current) {
        const resolvedBold = resolveFontWeightBold({
          fontFamilyCss: termRef.current.options?.fontFamily || "",
          normalWeight: effectiveFontWeight,
          desiredBoldWeight: terminalSettings.fontWeightBold,
          fontSize: effectiveFontSize,
        });
        termRef.current.options.fontWeightBold = resolvedBold as
          | 100
          | 200
          | 300
          | 400
          | 500
          | 600
          | 700
          | 800
          | 900;
      }

      const id = sessionRef.current;
      if (id) {
        try {
          resizeSession(id, term.cols, term.rows);
        } catch (err) {
          logger.warn("Resize session after fonts ready failed", err);
        }
      }
    };

    const fontFaceSet = document.fonts as FontFaceSet | undefined;

    // Coalesce bursts of loadingdone events (a cold start loads several faces
    // in quick succession) into a single remeasure.
    let remeasureTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRemeasure = () => {
      if (cancelled) return;
      if (remeasureTimer) clearTimeout(remeasureTimer);
      remeasureTimer = setTimeout(() => {
        remeasureTimer = null;
        remeasureAfterFontLoad();
      }, 50);
    };

    // Any font finishing later than the initial measurement — including a
    // user-chosen webfont primary — triggers a remeasure, so recovery no
    // longer depends on the single document.fonts.ready resolution below.
    const onLoadingDone = () => scheduleRemeasure();
    fontFaceSet?.addEventListener?.("loadingdone", onLoadingDone);

    const waitForFonts = async () => {
      try {
        if (!fontFaceSet?.ready) return;
        await fontFaceSet.ready;
        if (cancelled) return;

        // Ensure bundled Nerd Font icon fallbacks are loaded at the terminal's
        // cell size. Shell prompts can arrive before these faces finish loading
        // on cold start (Linux), leaving Powerline glyphs cached as tofu (#1363).
        try {
          await fontFaceSet.load(`${effectiveFontSize}px "Symbols Nerd Font Mono"`);
        } catch (err) {
          logger.warn("Nerd Font preload failed", err);
        }

        // Explicitly load the bundled webfonts the terminal actually renders
        // with (the Latin JetBrains Mono fallback, the Sarasa Mono SC CJK
        // fallback). document.fonts.ready can resolve before these are even
        // requested, so without this the cold-start grid stays mis-sized (#1647).
        const fontFamilyCss = (termRef.current as { options?: { fontFamily?: string } } | null)
          ?.options?.fontFamily || "";
        for (const family of bundledFamiliesInStack(fontFamilyCss)) {
          try {
            await fontFaceSet.load(`${effectiveFontSize}px "${family}"`);
          } catch (err) {
            logger.warn(`Bundled font preload failed: ${family}`, err);
          }
        }
        if (cancelled) return;

        remeasureAfterFontLoad();
      } catch (err) {
        logger.warn("Waiting for fonts failed", err);
      }
    };

    waitForFonts();
    return () => {
      cancelled = true;
      if (remeasureTimer) clearTimeout(remeasureTimer);
      fontFaceSet?.removeEventListener?.("loadingdone", onLoadingDone);
    };
  }, [effectiveFontSize, effectiveFontWeight, resizeSession, resolvedFontFamily, terminalSettings]);


  useEffect(() => {
    if (!isRendererActive || !containerRef.current) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver(() => {
      if (deferTerminalResizeRef?.current || !isRendererActiveRef.current) return;
      if (!fitAddonRef.current) return;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        safeFit({ requireVisible: true });
      }, 250);
    });

    observer.observe(containerRef.current);
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();
    };
  }, [isRendererActive, isResizing]);

  useLayoutEffect(() => {
    if (splitResizeActive) {
      prevIsResizingRef.current = true;
      return;
    }
    if (!prevIsResizingRef.current || !isVisible) {
      prevIsResizingRef.current = splitResizeActive;
      return;
    }
    prevIsResizingRef.current = splitResizeActive;
    lastFittedSizeRef.current = null;
    safeFit({ force: true, requireVisible: true });
    finishLayoutRecoveryAfterFit();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        safeFit({ force: true, requireVisible: true });
        const term = termRef.current;
        if (term) {
          forceSyncRenderAfterResize(term);
          syncPtySizeAfterLayout();
        }
      });
    }
  }, [splitResizeActive, isVisible]);


  useEffect(() => {
    if (!isVisible || !fitAddonRef.current) return;
    // Fit twice: once after initial layout (100ms) and again after layout settles
    // (350ms) to handle race conditions during split operations where the container
    // dimensions may not be final on the first pass.
    const timer1 = setTimeout(() => {
      safeFit({ requireVisible: true });
      finishLayoutRecoveryAfterFit();
    }, 100);
    const timer2 = setTimeout(() => {
      safeFit({ force: true, requireVisible: true });
      finishLayoutRecoveryAfterFit();
    }, 350);
    return () => { clearTimeout(timer1); clearTimeout(timer2); };
  }, [inWorkspace, isVisible]);


  // When search bar opens/closes, re-fit terminal and maintain scroll position
  useEffect(() => {
    const term = termRef.current;
    if (!term || !fitAddonRef.current) return;
    const buffer = term.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    const prevViewportY = buffer.viewportY;
    const timer = setTimeout(() => {
      safeFit({ force: true, requireVisible: true });
      requestAnimationFrame(() => {
        if (wasAtBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(prevViewportY);
        }
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [isSearchOpen]);

  // When compose bar opens/closes, re-fit terminal and maintain scroll position
  useEffect(() => {
    const term = termRef.current;
    if (!term || !fitAddonRef.current) return;
    const buffer = term.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    const prevViewportY = buffer.viewportY;
    const timer = setTimeout(() => {
      safeFit({ force: true, requireVisible: true });
      requestAnimationFrame(() => {
        safeFit({ force: true, requireVisible: true });
        if (wasAtBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(prevViewportY);
        }
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [isComposeBarOpen]);


  useEffect(() => {
    const shouldAutoFocus = isVisible && termRef.current && (!inWorkspace || isFocusMode);
    if (shouldAutoFocus) {
      const timer = setTimeout(() => {
        termRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible, inWorkspace, isFocusMode]);


  useEffect(() => {
    if (isFocused && termRef.current && isVisible) {
      const timer = setTimeout(() => {
        termRef.current?.focus();
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [isFocused, isVisible, sessionId]);


  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    let overlayRafId: number | null = null;
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHasSelection: boolean | null = null;
    let lastOverlayPosition: SelectionOverlayPosition = null;
    const requestFrame = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
    const cancelFrame = typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

    const publishSelectionOverlayPosition = () => {
      overlayRafId = null;
      const nextPosition = resolveSelectionOverlayPosition(term, containerRef.current);
      if (areSelectionOverlayPositionsEqual(lastOverlayPosition, nextPosition)) return;
      lastOverlayPosition = nextPosition;
      setSelectionOverlayPosition?.(nextPosition);
    };

    const scheduleSelectionOverlayPosition = () => {
      if (lastHasSelection === false) return;
      if (overlayRafId !== null) return;
      overlayRafId = requestFrame(publishSelectionOverlayPosition);
    };

    const onSelectionChange = () => {
      // hasSelection uses raw getSelection for cheap emptiness checks; the
      // clipboard write path normalizes soft wraps + display padding.
      const rawSelection = term.getSelection();
      const hasText = !!rawSelection && rawSelection.length > 0;
      if (lastHasSelection !== hasText) {
        lastHasSelection = hasText;
        setHasSelection(hasText);
      }
      if (copyTimer) {
        clearTimeout(copyTimer);
        copyTimer = null;
      }
      if (!hasText) {
        if (lastOverlayPosition !== null) {
          lastOverlayPosition = null;
          setSelectionOverlayPosition?.(null);
        }
        return;
      }
      scheduleSelectionOverlayPosition();

      if (hasText && terminalSettings?.copyOnSelect && !isRestoringSelectionRef.current) {
        // Capture now so a later buffer redraw during the debounce cannot
        // change what gets copied (selection-change may not fire again).
        const selection = getTerminalSelectionForClipboard(
          term,
          terminalSettings?.normalizeTextOnCopy ?? true,
        );
        if (!selection) return;
        copyTimer = setTimeout(() => {
          navigator.clipboard.writeText(selection).catch((err) => {
            logger.warn("Copy on select failed:", err);
          });
        }, 80);
      }
    };

    const selectionDisposable = term.onSelectionChange(onSelectionChange);
    const scrollDisposable = term.onScroll?.(scheduleSelectionOverlayPosition);
    const resizeDisposable = term.onResize?.(scheduleSelectionOverlayPosition);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleSelectionOverlayPosition);
    if (containerRef.current) {
      resizeObserver?.observe(containerRef.current);
    }
    scheduleSelectionOverlayPosition();
    return () => {
      if (overlayRafId !== null) {
        cancelFrame(overlayRafId);
      }
      if (copyTimer) {
        clearTimeout(copyTimer);
      }
      selectionDisposable.dispose();
      scrollDisposable?.dispose();
      resizeDisposable?.dispose();
      resizeObserver?.disconnect();
    };
  }, [terminalSettings?.copyOnSelect, terminalSettings?.normalizeTextOnCopy, isSearchOpen, isVisible, isResizing]);


  // Track whether the terminal application has enabled mouse tracking
  // (e.g. tmux with `set -g mouse on`, vim with `set mouse=a`).
  // When mouse tracking is active, disable Netcatty's context menu to avoid
  // conflicting with the application's own mouse handling.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onWriteParsed(() => {
      const tracking = term.modes.mouseTrackingMode !== 'none';
      if (tracking !== mouseTrackingRef.current) {
        mouseTrackingRef.current = tracking;
        setHasMouseTracking(tracking);
      }
    });

    // Set initial state
    const initial = term.modes.mouseTrackingMode !== 'none';
    mouseTrackingRef.current = initial;
    setHasMouseTracking(initial);

    return () => disposable.dispose();
  }, [sessionId]);


  // Prevent xterm.js's built-in rightClickHandler and right-button mouseup
  // from interfering with tmux/vim popup menus when mouse tracking is active.
  // On macOS, xterm forces selection with Option, while most terminal users
  // expect Shift to bypass mouse reporting. Replay Shift+left-click as that
  // native xterm force-selection gesture before xterm receives the original.
  // - mousedown (button 2 + Shift): keep Shift+right-click local so the
  //   terminal app does not also receive the right-button press
  // - contextmenu: xterm.js calls textarea.select() which steals focus
  // - mouseup (button 2): tmux interprets the right-button release as a
  //   dismiss action, closing the popup menu immediately after it appears
  // Both are intercepted at the capture phase before xterm.js's own listeners.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleContextMenuCapture = (e: MouseEvent) => {
      if (!shouldInterceptMouseTrackingContextMenu({
        event: e,
        mouseTracking: mouseTrackingRef.current,
        status: statusRef.current,
      })) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();

      // stopImmediatePropagation blocks the event from reaching React's
      // bubble-phase root listener, so the onContextMenu handler in
      // TerminalContextMenu (which dispatches paste / select-word) never
      // fires inside a mouse-tracking TUI. Without dispatching the user's
      // chosen action here, right-click paste silently stops working in
      // opencode, tmux with `mouse on`, vim with `set mouse=a`, etc. (#941).
      // Middle-click still works because its auxclick listener lives in
      // createXTermRuntime and isn't gated by mouseTracking.
      const behavior = terminalSettingsRef.current?.rightClickBehavior;
      if (behavior === 'paste') {
        void terminalContextActionsRef.current?.onPaste?.();
      } else if (behavior === 'select-word') {
        terminalContextActionsRef.current?.onSelectWord?.();
      }
      // 'context-menu' is intentionally not handled — Radix opens the
      // menu via its own pointerdown listener, which our capture handler
      // does not intercept.
    };

    const handleMouseDownCapture = (e: MouseEvent) => {
      if (shouldStopShiftRightClickMouseTrackingMouseDown({
        event: e,
        mouseTracking: mouseTrackingRef.current,
        status: statusRef.current,
      })) {
        e.stopImmediatePropagation();
        return;
      }

      if (!shouldReplayShiftMouseSelectionAsMacOption({
        event: e,
        mouseTracking: mouseTrackingRef.current,
        status: statusRef.current,
        isMacPlatform: isMacPlatform(),
      })) {
        return;
      }

      const target = e.target as EventTarget | null;
      if (!target || typeof target.dispatchEvent !== 'function') return;

      e.preventDefault();
      e.stopImmediatePropagation();
      target.dispatchEvent(createMacOptionForcedSelectionMouseEvent(e));
    };

    const handleMouseUpCapture = (e: MouseEvent) => {
      if (e.button === 2 && mouseTrackingRef.current && statusRef.current === 'connected') {
        e.stopImmediatePropagation();
      }
    };

    el.addEventListener('mousedown', handleMouseDownCapture, true);
    el.addEventListener('contextmenu', handleContextMenuCapture, true);
    el.addEventListener('mouseup', handleMouseUpCapture, true);
    return () => {
      el.removeEventListener('mousedown', handleMouseDownCapture, true);
      el.removeEventListener('contextmenu', handleContextMenuCapture, true);
      el.removeEventListener('mouseup', handleMouseUpCapture, true);
    };
  }, [sessionId]);


  useEffect(() => {
    if (!isRendererActive) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      if (!isRendererActiveRef.current) return;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        safeFit({ requireVisible: true });
      }, 250);
    };

    window.addEventListener("resize", handler);
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      window.removeEventListener("resize", handler);
    };
  }, [isRendererActive]);


  useEffect(() => {
    if (!isVisible) return;

    const recoverWebglRendererOnAppResume = () => {
      xtermRuntimeRef.current?.ensureWebglRenderer();
    };

    const recoverTerminalOnAppResume = () => {
      const term = termRef.current;
      if (term) {
        cancelScheduledUnfocusedRepaint(term);
        flushPendingTerminalWritesOnResume(term);
        forceTerminalRepaintBypassingAnimationFrame(term);
      }
      flushPendingOutputScroll();
      recoverWebglRendererOnAppResume();
      scheduleLayoutRecoveryRefit([0, 100, 300]);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      recoverTerminalOnAppResume();
    };

    const handleWindowFocus = () => {
      recoverTerminalOnAppResume();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    const unsubscribeWindowShown = terminalBackend.onWindowShown?.(() => {
      recoverTerminalOnAppResume();
    });

    // Fullscreen changes layout for every visible pane.
    const unsubscribeFullscreen = terminalBackend.onWindowFullScreenChanged?.((isFullscreen) => {
      scheduleLayoutRecoveryRefit(isFullscreen ? [0, 150, 400] : [0, 100, 300]);
    });

    return () => {
      clearLayoutRecoveryTimers();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      unsubscribeWindowShown?.();
      unsubscribeFullscreen?.();
    };
  }, [isVisible, terminalBackend]);


  // Only register the snippet executor once the terminal session is ready.
  // Before that, TerminalLayer falls back to raw writeToSession which is the
  // correct path for sessions that are still connecting.
  useEffect(() => {
    if (status !== "connected") {
      onSnippetExecutorChange?.(sessionId, null);
      return;
    }
    onSnippetExecutorChange?.(sessionId, executeSnippetCommand);
    return () => onSnippetExecutorChange?.(sessionId, null);
  }, [executeSnippetCommand, onSnippetExecutorChange, sessionId, status]);

  useEffect(() => {
    if (status !== "connected") {
      onBroadcastInterruptPriorityChange?.(sessionId, null);
      return;
    }
    const prioritizeBroadcastInterrupt = () => {
      const term = termRef.current;
      if (!term) return;
      prioritizeTerminalInput(
        term,
        sessionId,
        getFlowControllerForTerm(term),
        terminalBackend,
        {
          reason: "interrupt",
          drainStaleOutput: shouldArmTerminalInterruptDisplayGateForProtocol(host.protocol),
        },
      );
    };
    onBroadcastInterruptPriorityChange?.(sessionId, prioritizeBroadcastInterrupt);
    return () => onBroadcastInterruptPriorityChange?.(sessionId, null);
  }, [
    host.protocol,
    onBroadcastInterruptPriorityChange,
    sessionId,
    status,
    terminalBackend,
    termRef,
  ]);
}
