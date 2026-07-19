import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Activity, Cpu, Clock3, Copy, HardDrive, Maximize2, MemoryStick, Radio, ArrowDownToLine, ArrowUpFromLine, Sparkles, SquareArrowOutUpRight } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { detectLocalOs } from "../lib/localShell";
import { logger } from "../lib/logger";
import { cn, normalizeLineEndings, wrapBracketedPaste } from "../lib/utils";
import {
  Host,
  Snippet,
  TerminalSession,
} from "../types";
import { resolveSnippetCommand } from "./SnippetExecutionProvider";
import {
  scrollTerminalToBottomAfterInputIfEnabled,
  shouldEnableNativeUserInputAutoScroll,
} from "../domain/terminalScroll";
import {
  applyCustomAccentToTerminalTheme,
  resolveHostTerminalThemeId,
  type TerminalHostUpdate,
} from "../domain/terminalAppearance";
import {
  createTerminalEncodingStorageKey,
  isTerminalEncodingPreference,
  resolveInitialTerminalEncoding,
  shouldSyncTerminalEncodingOnAttach,
  terminalEncodingPreferenceToCharset,
  type TerminalEncodingPreference,
  type TerminalEncodingAttachConnection,
} from "../domain/terminalEncodingPreference";
import { resolveRestoreCwdIntent } from "../domain/sessionRestore";
import {
  buildTerminalContextReadResult,
  buildTerminalContextSnapshotText,
  normalizeTerminalContextRange,
  resolveTerminalContextLineWindow,
  type TerminalContextReader,
} from "../domain/terminalContextRead";
import { classifyDistroId, shouldProbeSessionCwd } from "../domain/host";
import { resolveHostSshConnectionTimeouts } from "../domain/sshConnectionTimeouts";
import { supportsZmodemTerminalDragDrop } from "../lib/zmodemDragDrop";
import { resolveHostAuth, resolveHostAutofillPassword } from "../domain/sshAuth";
import { listPasswordPromptFillCandidates } from "../domain/passwordPromptAssist";
import { useTerminalBackend } from "../application/state/useTerminalBackend";
import {
  TERMINAL_AUTO_RECONNECT_DELAY_MS,
  canAttemptTerminalAutoReconnect,
  shouldAutoReconnectAfterExit,
  shouldContinueAutoReconnectAfterFailure,
} from "../application/state/terminalAutoReconnect";
import { useStoredBoolean } from "../application/state/useStoredBoolean";
import { readOptionalStoredStringValue, useStoredString } from "../application/state/useStoredString";
import { useSessionLogBackend } from "../application/state/useSessionLogBackend";
import { useTerminalLayoutSuppressActive } from "../application/state/terminalLayoutSuppressStore";
import { terminalReconnectRegistry } from "../application/state/terminalReconnectRegistry";
// SFTPModal removed - SFTP is now handled by SftpSidePanel in TerminalLayer
import { Button } from "./ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { toast } from "./ui/toast";
import { useAvailableFonts } from "../application/state/fontStore";
import { composeFontFamilyStack, type SupportedPlatform } from "../infrastructure/config/cjkFonts";
import { resolveTerminalFontFamilyId } from "../infrastructure/config/fonts";
import { getBuiltinTerminalThemeById } from "../infrastructure/config/terminalThemes";
import {
  STORAGE_KEY_TERMINAL_COMPOSE_BAR_OPEN,
  STORAGE_KEY_TERMINAL_ENCODING_BY_HOST_PREFIX,
} from "../infrastructure/config/storageKeys";
import { useCustomThemes } from "../application/state/customThemeStore";

import { TerminalConnectionDialog } from "./terminal/TerminalConnectionDialog";
import { HostKeyInfo } from "./terminal/TerminalHostKeyVerification";
import { createKnownHostFromHostKeyInfo, toHostKeyInfo } from "./terminal/hostKeyVerification";
import { TerminalToolbar } from "./terminal/TerminalToolbar";
import { ScriptRecordingIndicator } from "./terminal/ScriptRecordingIndicator";
import { ScriptSaveRecordingDialog } from "./scripts/ScriptSaveRecordingDialog";
import { registerScreenSnapshotProvider } from "@/infrastructure/scripts/screenSnapshotRegistry.ts";
import { useScriptRecorder } from "@/application/state/useScriptRecorder.ts";
import { getScriptRecordingSnapshot, setScriptRecordingState } from "@/application/state/scriptRecordingStore.ts";
import {
  runAutomationScript,
  runConnectScriptsSequential,
  subscribeScriptRuns,
  pauseScriptRun,
  resumeScriptRun,
  stopScriptRun,
} from "@/application/state/scriptAutomationCoordinator.ts";
import { resolveConnectScriptsForHost, hasUnresolvedConnectScriptBindings } from "@/domain/hostConnectScripts.ts";
import { isVaultInitialized } from "@/application/state/vaultInitStore.ts";
import { netcattyBridge } from "@/infrastructure/services/netcattyBridge.ts";
import { ScriptExecutionOverlay } from "./terminal/ScriptExecutionOverlay";
import { isScriptSnippet } from "@/domain/snippetScript.ts";
import { useOutputTriggers } from "@/application/state/useOutputTriggers.ts";
import { TerminalComposeBar } from "./terminal/TerminalComposeBar";
import { TerminalContextMenu } from "./terminal/TerminalContextMenu";
import { TerminalSearchBar } from "./terminal/TerminalSearchBar";
import { ZmodemOverwriteDialog } from "./terminal/ZmodemOverwriteDialog";
import { ZmodemProgressIndicator } from "./terminal/ZmodemProgressIndicator";
import { createReplaySafeTerminalLogSanitizer } from "./terminal/replaySafeTerminalLog";
import { createConnectionLogBuffer } from "./terminal/connectionLogBuffer";
import { createProgrammaticCommandLogRewriter, type ProgrammaticCommandLogRewrite } from "./terminal/programmaticCommandLog";
import { getSessionLogInitialLine } from "./terminal/sessionLogInitialLine";
import { getTerminalSelectionForClipboard } from "./terminal/normalizeTerminalSelection";
import { useZmodemTransfer } from "./terminal/hooks/useZmodemTransfer";
import {
  createTerminalSessionStarters,
  type PendingAuth,
  type TerminalSessionDataMeta,
} from "./terminal/runtime/createTerminalSessionStarters";
import { createXTermRuntime, type XTermRuntime } from "./terminal/runtime/createXTermRuntime";
import { applyUserCursorPreference } from "./terminal/runtime/cursorPreference";
import { terminalAltKeyOptions } from "./terminal/runtime/altKeyOptions";
import {
  createPromptLineBreakState,
  type PromptLineBreakState,
} from "./terminal/runtime/promptLineBreak";
import {
  prepareSudoAutofillInput,
  type PasswordPromptPickerState,
  type SudoPasswordAutofill,
} from "./terminal/runtime/terminalSudoAutofill";
import {
  recordTerminalCommandExecution,
  shouldRecordShellHistory,
} from "./terminal/runtime/terminalCommandExecution";
import { shouldPreserveTerminalFocusOnMouseDown } from "./terminal/toolbarFocus";
import { preserveTerminalViewportInScrollback } from "./terminal/clearTerminalViewport";
import { XTERM_PERFORMANCE_CONFIG } from "../infrastructure/config/xtermPerformance";
import { useTerminalSearch } from "./terminal/hooks/useTerminalSearch";
import { useTerminalContextActions } from "./terminal/hooks/useTerminalContextActions";
import { useTerminalAuthState } from "./terminal/hooks/useTerminalAuthState";
import { useTerminalDragDrop } from "./terminal/hooks/useTerminalDragDrop";
import { useTerminalFilePaste } from "./terminal/hooks/useTerminalFilePaste";
import { getRememberedYmodemSendDefaultPath, rememberYmodemSendFilePath } from "../application/state/ymodemFileMemory";
import { TerminalAutocomplete } from "./terminal/TerminalAutocomplete";
import { resolveTerminalAutocompleteSettings } from "./terminal/autocomplete/terminalAutocompleteSettings";
import { buildOsc7SetupExecCommand, runOsc7SetupAction, shouldOfferOsc7SetupAction } from "./terminal/osc7Setup";
import {
  getRemoteClipboardImageUploadErrorMessageKey,
  type RemoteClipboardImageUploadResult,
} from "./terminal/clipboardImagePaste";
import { createTerminalCwdTracker, resolvePreferredTerminalCwd } from "./terminal/sftpCwd";
import { useTerminalEffects } from "./terminal/useTerminalEffects";
import { useTerminalHibernateEffect } from "./terminal/useTerminalHibernateEffect";
import { readActiveTerminalBufferTextRange } from "./terminal/terminalContextBuffer";
import {
  appendHibernatePendingBuffer,
  isTerminalAlternateScreenActive,
  serializeTerminalForHibernate,
} from "./terminal/terminalHibernateRuntime";
import {
  ackTerminalSessionFlow,
  clearTerminalSessionFlowAck,
  flushTerminalSessionFlowAck,
} from "./terminal/runtime/terminalFlowAckBuffer";
import { releaseTerminalFlowBeforeHibernate } from "./terminal/runtime/terminalSessionAttachment";
import { flushPendingTerminalWritesBeforeHibernate } from "./terminal/runtime/terminalUnfocusedRepaint";
import {
  isTerminalFileTransferActive,
  resolveHibernateKeepRendererCount,
  resolveHibernatePreferWasmSerialize,
  resolveHibernateSkipAltScreen,
  resolveTerminalHibernateDelayMs,
  resolveTerminalHibernateEnabledForProtocol,
  resolveTerminalHibernateReplayChunkBytes,
  type TerminalHibernateWakePayload,
} from "../domain/terminalHibernate";
import { terminalHiddenRendererStore } from "../application/state/terminalHiddenRendererStore";
import {
  wakeTerminalFromHibernate,
  type TerminalRuntimeRefs,
} from "./terminal/terminalRuntimeMount";
import type { CreateXTermRuntimeContext } from "./terminal/runtime/createXTermRuntime";
import { TerminalView } from "./terminal/TerminalView";
import {
  getInitialTerminalStatus,
  shouldStartTerminalBackend,
} from "./terminal/restoredSessionGate";
import {
  AUTO_RUN_SNIPPET_LINE_DELAY_MS,
  forceSyncRenderAfterResize,
  MAX_CONNECTION_LOG_DATA_CHARS,
  shouldDelayAutoRunSnippetInput,
  shouldHideConnectingDialogForConnectionReuse,
  shouldShowTerminalConnectionDialog,
  type TerminalProps,
} from "./terminal/terminalHelpers";
import { terminalPropsAreEqual } from "./terminal/terminalMemo";

const HIBERNATE_RETRY_AFTER_DRAIN_MS = 250;
const EMPTY_CHAIN_HOSTS: Host[] = [];
// Detect password/passphrase prompts in output so the next keystroke is treated
// as sensitive. Hoisted to module scope + shared by the onTerminalOutput branch
// so the pattern is compiled once and not duplicated per chunk.
const PASSWORD_PROMPT_PATTERN = /password|passphrase|口令/i;

const TerminalComponent: React.FC<TerminalProps> = ({
  host,
  keys,
  identities,
  snippets,
  snippetPackages = [],
  compactToolbar = false,
  lineTimestampsAvailable = true,
  chainHosts = EMPTY_CHAIN_HOSTS,
  appearanceTheme,
  knownHosts = [],
  isVisible,
  paneLayoutKey,
  inWorkspace,
  isResizing,
  isFocusMode,
  isFocused,
  fontFamilyId,
  fontSize,
  terminalTheme,
  followAppTerminalTheme = false,
  accentMode = "theme",
  customAccent = "",
  terminalSettings,
  sessionId,
  restoreState,
  shellType,
  lastCwd,
  restoreTerminalCwd = false,
  startupCommand,
  noAutoRun,
  multiLineRunMode,
  pendingScriptId,
  pendingScript,
  reuseConnectionFromSessionId,
  serialConfig,
  hotkeyScheme = "disabled",
  disableTerminalFontZoom = false,
  keyBindings = [],
  onHotkeyAction,
  onTerminalFontSizeChange,
  onStatusChange,
  onSessionExit,
  onTerminalDataCapture,
  onOsDetected,
  onCloseSession,
  onUpdateHost,
  onAddKnownHost,
  onExpandToFocus,
  onCommandExecuted,
  onCommandSubmitted,
  onSplitHorizontal,
  onSplitVertical,
  onOpenSftp,
  onTerminalCwdChange,
  onTerminalTitleChange,
  onTerminalBell,
  onTerminalOutput,
  onTerminalContextReaderChange,
  onOpenScripts,
  onOpenHistory,
  onOpenTheme,
  onOpenSystem,
  isBroadcastEnabled,
  onToggleBroadcast,
  onToggleComposeBar,
  isWorkspaceComposeBarOpen,
  onBroadcastInput,
  onBroadcastInterruptPriorityChange,
  onSnippetExecutorChange,
  onProgrammaticCommandLogRewriteChange,
  sessionLog,
  sshDebugLogEnabled,
  sudoAutofillPassword,
  sudoAutofillCandidates,
  showSelectionAIAction = true,
  onAddSelectionToAI,
  sessionDisplayName,
  onRename,
  onDetach,
  onStartSessionDrag,
  onEndSessionDrag,
  onDetachPointerDown,
  onDetachDragStart,
  onDetachDragEnd,
}) => {
  const layoutSuppressActive = useTerminalLayoutSuppressActive();
  const deferTerminalResize = isResizing || layoutSuppressActive;
  const deferTerminalResizeRef = useRef(deferTerminalResize);
  deferTerminalResizeRef.current = deferTerminalResize;

  // Initial TCP dial timeout. Authentication prompts use their own backend timeout.
  const hostConnectionTimeouts = resolveHostSshConnectionTimeouts(host);
  const CONNECTION_TIMEOUT = hostConnectionTimeouts.tcpConnectTimeoutSeconds * 1000;
  const { t } = useI18n();
  const connectScriptsConsumedRef = useRef(false);
  const connectScriptsCompletedIdsRef = useRef(new Set<string>());
  const connectScriptsInFlightRef = useRef(false);
  const pendingScriptRunIdRef = useRef<string | null>(null);
  const pendingScriptHandledRef = useRef<Snippet | null>(null);
  // Mosh marks status=connected during the SSH handshake so interactive
  // prompts remain reachable. Connect/pending scripts must wait until
  // mosh-client is ready (#2199). closeSession clears preload ready
  // listeners for this session id — resubscribe synchronously before each
  // startMosh (not only in a useEffect, which can lose a race with reconnect).
  const [moshShellReady, setMoshShellReady] = useState(() => !host.moshEnabled);
  const disposeMoshReadyRef = useRef<(() => void) | null>(null);
  const [saveRecordingOpen, setSaveRecordingOpen] = useState(false);
  const [recordedCode, setRecordedCode] = useState('');
  const recorder = useScriptRecorder(sessionId);
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const passwordPromptActiveRef = useRef(false);
  const [activeScriptRun, setActiveScriptRun] = useState<import('@/types/global/netcatty-bridge-script.d.ts').ScriptRun | undefined>(undefined);
  const dismissedScriptRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    return subscribeScriptRuns((runs) => {
      const sessionRuns = runs.filter((run) => run.sessionId === sessionId);
      const liveRun = sessionRuns.find((run) => run.status === 'running' || run.status === 'paused');
      if (liveRun) {
        dismissedScriptRunIdRef.current = null;
        setActiveScriptRun(liveRun);
        return;
      }

      const finishedRun = sessionRuns
        .filter((run) =>
          (run.status === 'completed' || run.status === 'failed')
          && run.runId !== dismissedScriptRunIdRef.current,
        )
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];

      setActiveScriptRun(finishedRun);
    });
  }, [sessionId]);

  const dismissScriptOverlay = useCallback(() => {
    if (activeScriptRun) {
      dismissedScriptRunIdRef.current = activeScriptRun.runId;
    }
    setActiveScriptRun(undefined);
  }, [activeScriptRun]);
  const outputTriggers = useOutputTriggers({
    sessionId,
    hostId: host.id,
    snippets,
    onRunScript: (snippet, sid) => runAutomationScript({ snippet, sessionId: sid }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message.includes('Observer mode') ? t('scripts.observer.blocked') : message);
      throw err;
    }),
  });
  const appendOutputTriggerOutputRef = useRef(outputTriggers.appendOutput);
  appendOutputTriggerOutputRef.current = outputTriggers.appendOutput;
  const noteOutputTriggerUserInputRef = useRef(outputTriggers.noteUserInput);
  noteOutputTriggerUserInputRef.current = outputTriggers.noteUserInput;
  const availableFonts = useAvailableFonts();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const xtermRuntimeRef = useRef<XTermRuntime | null>(null);
  const terminalCwdTracker = useMemo(() => createTerminalCwdTracker(), []);
  const knownCwdRef = useRef<string | undefined>(undefined);
  const disposeDataRef = useRef<(() => void) | null>(null);
  const disposeExitRef = useRef<(() => void) | null>(null);
  const disposeTelnetEchoModeRef = useRef<(() => void) | null>(null);
  const hibernatedRef = useRef(false);
  const softHiddenRef = useRef(false);
  const hasRuntimeRef = useRef(false);
  const hibernateSnapshotRef = useRef("");
  const hibernateViewportSnapshotRef = useRef("");
  const hibernateScrollbackSnapshotRef = useRef("");
  const hibernateContextSnapshotRef = useRef("");
  const hibernateContextViewportSnapshotRef = useRef("");
  const hibernateContextScrollbackSnapshotRef = useRef("");
  const hibernatePendingBufferRef = useRef("");
  const hibernateAlternateScreenRef = useRef(false);
  const hibernateRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullHibernateRuntimeRef = useRef<(() => Promise<boolean>) | null>(null);
  const wakeInProgressRef = useRef(false);
  const wakePromiseRef = useRef<Promise<boolean> | null>(null);
  const sessionRef = useRef<string | null>(null);
  const sessionCleanupPromiseRef = useRef<Promise<void> | null>(null);
  const isBootActiveRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const hasRunStartupCommandRef = useRef(false);
  const restoreCwdIntentRef = useRef<{ cwd: string; command: string } | null>(null);
  const suppressHostStartupCommandRef = useRef(false);
  // Token for an in-flight retry chain. handleRetry sets this to a fresh
  // symbol; any cancel/close/teardown/subsequent-retry invalidates it. The
  // chained xterm.write callbacks verify the token before proceeding so a
  // cancelled retry can't fire a startNewSession after the fact.
  const retryTokenRef = useRef<symbol | null>(null);
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoReconnectLoopActiveRef = useRef(false);
  const autoReconnectAttemptRef = useRef(0);
  const startReconnectRef = useRef<((mode: "manual" | "auto") => void) | null>(null);
  const wakeHibernatedRuntimeForReconnectRef = useRef<(() => Promise<boolean>) | null>(null);
  const reconnectWakeInFlightRef = useRef(false);
  const reconnectWakeTokenRef = useRef<symbol | null>(null);
  const manualReconnectRequestRef = useRef<() => void>(() => {});
  const terminalDataCapturedRef = useRef(false);
  const connectionLogBufferRef = useRef(createConnectionLogBuffer(MAX_CONNECTION_LOG_DATA_CHARS));
  const terminalLogSanitizerRef = useRef(createReplaySafeTerminalLogSanitizer());
  const commandLogRewriterRef = useRef(createProgrammaticCommandLogRewriter());
  const onTerminalDataCaptureRef = useRef(onTerminalDataCapture);
  const commandBufferRef = useRef<string>("");
  const promptLineBreakStateRef = useRef<PromptLineBreakState>(createPromptLineBreakState());
  const [hasMouseTracking, setHasMouseTracking] = useState(false);
  const mouseTrackingRef = useRef(false);
  const serialLineBufferRef = useRef<string>("");
  const telnetLocalEchoRef = useRef(false);

  useEffect(() => () => {
    reconnectWakeTokenRef.current = null;
  }, [sessionId]);

  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;
  const isSearchOpenRef = useRef(false);
  const hibernateFileTransferActiveRef = useRef(false);
  const handleUpdateHostFromTerminal = useCallback((hostUpdate: TerminalHostUpdate) => {
    onUpdateHost?.(hostUpdate as Host);
  }, [onUpdateHost]);
  onTerminalDataCaptureRef.current = onTerminalDataCapture;
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const hibernateEnabled = resolveTerminalHibernateEnabledForProtocol(terminalSettings, host.protocol);
  const hibernateEnabledRef = useRef(hibernateEnabled);
  hibernateEnabledRef.current = hibernateEnabled;
  const isRendererActive = isVisible || !hibernateEnabled;
  const isRendererActiveRef = useRef(isRendererActive);
  isRendererActiveRef.current = isRendererActive;
  const pendingOutputScrollRef = useRef(false);
  const lastFittedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const fontWeightFixupDoneRef = useRef(false);

  const captureTerminalLogData = useCallback((data: string) => {
    const readableCommandData = commandLogRewriterRef.current.append(data);
    const replaySafeData = terminalLogSanitizerRef.current.append(readableCommandData);
    if (!replaySafeData) return;
    connectionLogBufferRef.current.append(replaySafeData);
  }, []);

  const finalizeTerminalLogData = useCallback(() => {
    const readableCommandData = commandLogRewriterRef.current.finish();
    if (readableCommandData) {
      const replaySafeData = terminalLogSanitizerRef.current.append(readableCommandData);
      if (replaySafeData) {
        connectionLogBufferRef.current.append(replaySafeData);
      }
    }
    const replaySafeData = terminalLogSanitizerRef.current.finish();
    if (replaySafeData) {
      connectionLogBufferRef.current.append(replaySafeData);
    }
    return connectionLogBufferRef.current.toString();
  }, []);

  const readTerminalContext = useCallback<TerminalContextReader>(async (request) => {
    if (request.sessionId !== sessionId) {
      return { ok: false, error: `Terminal context reader is registered for "${sessionId}", not "${request.sessionId}".` };
    }

    const range = normalizeTerminalContextRange(request.range);
    const term = termRef.current;
    if (term) {
      const alternateScreen = isTerminalAlternateScreenActive(term);
      const activeBuffer = term.buffer.active as typeof term.buffer.active & {
        viewportY?: number;
      };
      const totalLines = Math.max(0, activeBuffer.length);
      const viewportStartLine = alternateScreen
        ? 0
        : Math.max(0, activeBuffer.viewportY ?? Math.max(0, totalLines - term.rows));
      const viewportEndLine = totalLines > 0
        ? Math.min(totalLines - 1, viewportStartLine + Math.max(1, term.rows) - 1)
        : -1;
      const lineWindow = resolveTerminalContextLineWindow({
        range,
        totalLines,
        viewportStartLine,
        viewportEndLine,
        startLine: request.startLine,
        maxLines: request.maxLines,
      });
      let content = '';
      if (lineWindow.endLine >= lineWindow.startLine) {
        content = readActiveTerminalBufferTextRange(term, {
          startLine: lineWindow.startLine,
          endLine: lineWindow.endLine,
        });
      }

      return {
        ok: true,
        sessionId,
        label: sessionDisplayName ?? host.label,
        range,
        content,
        totalLines,
        startLine: lineWindow.startLine,
        endLine: lineWindow.endLine,
        returnedLines: lineWindow.endLine >= lineWindow.startLine
          ? lineWindow.endLine - lineWindow.startLine + 1
          : 0,
        hasMoreBefore: lineWindow.startLine > 0,
        hasMoreAfter: lineWindow.endLine >= 0 && lineWindow.endLine < totalLines - 1,
        source: 'live',
        alternateScreen,
      };
    }

    const snapshot = buildTerminalContextSnapshotText({
      scrollbackText: hibernateContextScrollbackSnapshotRef.current,
      viewportText: hibernateContextViewportSnapshotRef.current,
      pendingText: hibernatePendingBufferRef.current,
    });
    const fullText = snapshot.fullText || hibernateContextSnapshotRef.current;

    if (!fullText) {
      return { ok: false, error: `Terminal session "${sessionId}" has no readable terminal buffer yet.` };
    }

    return buildTerminalContextReadResult({
      sessionId,
      label: sessionDisplayName ?? host.label,
      fullText,
      range,
      startLine: request.startLine,
      maxLines: request.maxLines,
      source: 'snapshot',
      alternateScreen: hibernateAlternateScreenRef.current,
      viewportStartLine: snapshot.viewportStartLine,
      viewportEndLine: snapshot.viewportEndLine,
    });
  }, [host.label, sessionDisplayName, sessionId]);

  useEffect(() => {
    onTerminalContextReaderChange?.(sessionId, readTerminalContext);
    return () => onTerminalContextReaderChange?.(sessionId, null);
  }, [onTerminalContextReaderChange, readTerminalContext, sessionId]);

  useEffect(() => {
    commandLogRewriterRef.current = createProgrammaticCommandLogRewriter();
  }, [sessionId]);

  const queueProgrammaticCommandLogRewrite = useCallback((rewrite: ProgrammaticCommandLogRewrite) => {
    commandLogRewriterRef.current.queueRewrite(rewrite);
  }, []);

  useEffect(() => {
    onProgrammaticCommandLogRewriteChange?.(sessionId, queueProgrammaticCommandLogRewrite);
    return () => onProgrammaticCommandLogRewriteChange?.(sessionId, null);
  }, [onProgrammaticCommandLogRewriteChange, queueProgrammaticCommandLogRewrite, sessionId]);

  const writeLocalTerminalData = useCallback((data: string) => {
    if (!data) return;
    captureTerminalLogData(data);
    termRef.current?.write(data);
  }, [captureTerminalLogData]);

  const hotkeySchemeRef = useRef(hotkeyScheme);
  const disableTerminalFontZoomRef = useRef(disableTerminalFontZoom);
  const keyBindingsRef = useRef(keyBindings);
  const onHotkeyActionRef = useRef(onHotkeyAction);
  hotkeySchemeRef.current = hotkeyScheme;
  disableTerminalFontZoomRef.current = disableTerminalFontZoom;
  keyBindingsRef.current = keyBindings;
  onHotkeyActionRef.current = onHotkeyAction;

  const isBroadcastEnabledRef = useRef(isBroadcastEnabled);
  const onBroadcastInputRef = useRef(onBroadcastInput);
  isBroadcastEnabledRef.current = isBroadcastEnabled;
  onBroadcastInputRef.current = onBroadcastInput;

  // Snippets ref for shortkey support in terminal
  const snippetsRef = useRef(snippets);
  snippetsRef.current = snippets;

  // Autocomplete handler refs — populated by <TerminalAutocomplete> so the
  // xterm runtime (and a few effects here) can drive the hook without making
  // Terminal re-render on every suggestion update.
  const autocompleteKeyEventRef = useRef<((e: KeyboardEvent) => boolean) | undefined>(undefined);
  const autocompleteInputRef = useRef<((data: string) => void) | undefined>(undefined);
  const autocompleteRepositionRef = useRef<(() => void) | undefined>(undefined);
  const autocompleteCloseRef = useRef<(() => void) | undefined>(undefined);
  const sudoHintRef = useRef<((active: boolean) => boolean) | undefined>(undefined);

  const terminalBackend = useTerminalBackend();
  const { startManualSessionLog, stopManualSessionLog, getManualSessionLogStatus } = useSessionLogBackend();
  const {
    resizeSession,
    receiveSerialYmodem,
    selectDirectory,
    selectDirectoryAvailable,
    selectFile,
    selectFileAvailable,
    sendSerialYmodem,
    serialYmodemAvailable,
    serialYmodemReceiveAvailable,
    setSessionEncoding,
  } = terminalBackend;



  // isScriptsOpen state removed - scripts now handled by side panel
  const [status, setStatus] = useState<TerminalSession["status"]>(() => (
    getInitialTerminalStatus()
  ));
  const hasEverConnectedRef = useRef(status === "connected");
  const [error, setError] = useState<string | null>(null);
  const lastToastedErrorRef = useRef<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [timeLeft, setTimeLeft] = useState(CONNECTION_TIMEOUT / 1000);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showSFTP, setShowSFTP] = useState(false);
  const [isSessionLogging, setIsSessionLogging] = useState(false);
  const [progressValue, setProgressValue] = useState(15);
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionOverlayPosition, setSelectionOverlayPosition] = useState<{ left: number; top: number } | null>(null);
  const [isDisconnectedDialogDismissed, setIsDisconnectedDialogDismissed] = useState(false);
  const [connectionReuseFellBack, setConnectionReuseFellBack] = useState(false);

  const statusRef = useRef<TerminalSession["status"]>(status);
  statusRef.current = status;
  const getSessionConnectedRef = useRef(() => statusRef.current === "connected" && Boolean(sessionRef.current));
  getSessionConnectedRef.current = () => statusRef.current === "connected" && Boolean(sessionRef.current);
  const sudoAutofillRef = useRef<SudoPasswordAutofill | null>(null);
  // Prefer parent-supplied candidates (TerminalLayer); otherwise derive from
  // host/keys/identities so standalone popups (TerminalPopupPage) still work.
  const resolvedSudoAutofillCandidates = useMemo(
    () =>
      sudoAutofillCandidates
      ?? listPasswordPromptFillCandidates({ host, keys, identities }),
    [sudoAutofillCandidates, host, keys, identities],
  );
  const resolvedSudoAutofillPassword = useMemo(
    () =>
      sudoAutofillPassword
      ?? resolveHostAutofillPassword({ host, keys, identities }),
    [sudoAutofillPassword, host, keys, identities],
  );
  const sudoAutofillPasswordRef = useRef(resolvedSudoAutofillPassword);
  sudoAutofillPasswordRef.current = resolvedSudoAutofillPassword;
  const sudoAutofillCandidatesRef = useRef(resolvedSudoAutofillCandidates);
  sudoAutofillCandidatesRef.current = resolvedSudoAutofillCandidates;
  const [passwordPickerState, setPasswordPickerState] = useState<PasswordPromptPickerState | null>(null);
  const passwordPickerRef = useRef<
    ((active: boolean, state: PasswordPromptPickerState | null) => boolean) | undefined
  >(undefined);
  passwordPickerRef.current = (active, state) => {
    setPasswordPickerState(active && state ? state : null);
    return true;
  };

  const [chainProgress, setChainProgress] = useState<{
    currentHop: number;
    totalHops: number;
    currentHostLabel: string;
    connectionPhase: string;
  } | null>(null);
  const [isConnectionAwaitingUserInput, setIsConnectionAwaitingUserInput] = useState(false);
  const [isConnectionPastTcpDial, setIsConnectionPastTcpDial] = useState(false);

  // pendingUploadEntries removed - drag-drop uploads now handled by SftpSidePanel
  const [isComposeBarOpen, setIsComposeBarOpen] = useStoredBoolean(
    STORAGE_KEY_TERMINAL_COMPOSE_BAR_OPEN,
    false,
  );
  const terminalEncodingStorageKey = createTerminalEncodingStorageKey(
    STORAGE_KEY_TERMINAL_ENCODING_BY_HOST_PREFIX,
    host,
  );
  const initialRememberedTerminalEncoding = readOptionalStoredStringValue(
    terminalEncodingStorageKey,
    isTerminalEncodingPreference,
  );
  const [, setRememberedTerminalEncoding] = useStoredString(
    terminalEncodingStorageKey,
    'utf-8',
    isTerminalEncodingPreference,
  );
  const [terminalEncoding, setTerminalEncoding] = useState<TerminalEncodingPreference>(() => {
    return resolveInitialTerminalEncoding(
      host?.charset,
      initialRememberedTerminalEncoding,
    );
  });
  const terminalEncodingRef = useRef(terminalEncoding);
  terminalEncodingRef.current = terminalEncoding;
  const hasRememberedTerminalEncodingRef = useRef(initialRememberedTerminalEncoding !== null);
  // True only after the user actively picks an encoding from the toolbar.
  // onSessionAttached uses this to decide whether to override the backend's
  // initial charset for telnet/serial reconnects — on a first attach we
  // must not overwrite arbitrary host.charset values (latin1/shift_jis/...)
  // that the UI's two-value state can't represent.
  const userPickedEncodingRef = useRef(false);

  const terminalSearch = useTerminalSearch({ searchAddonRef, termRef });
  const {
    isSearchOpen,
    searchMatchCount,
    searchFocusToken,
    requestSearchFocus,
    handleToggleSearch,
    handleSearch,
    handleFindNext,
    handleFindPrevious,
    handleCloseSearch,
  } = terminalSearch;
  isSearchOpenRef.current = isSearchOpen;

  const prepareProgrammaticSudoInput = useCallback((data: string): string => {
    if (
      statusRef.current !== "connected" ||
      (isBroadcastEnabledRef.current && onBroadcastInputRef.current)
    ) {
      return data;
    }
    const pastedCommand = data.match(/^([^\r\n]+)(\r\n|\r|\n)$/);
    if (!pastedCommand || !shouldRecordShellHistory(pastedCommand[1], termRef.current)) {
      return data;
    }
    prepareSudoAutofillInput(data, null, sudoAutofillRef.current);
    return data;
  }, []);

  // Terminal autocomplete — onAcceptText writes directly to session (no CustomEvent)
  const autocompleteAcceptTextRef = useRef<((text: string) => void) | undefined>(undefined);
  autocompleteAcceptTextRef.current = (text: string) => {
    const id = sessionRef.current;
    if (id && text) {
      let textToWrite = text;
      let handledSubmittedInput = false;
      if (
        host.protocol !== "serial" &&
        statusRef.current === "connected" &&
        !(isBroadcastEnabledRef.current && onBroadcastInputRef.current)
      ) {
        const preparedText = prepareProgrammaticSudoInput(text);
        handledSubmittedInput = preparedText !== text;
        textToWrite = preparedText;
      }

      // Serial line mode: buffer text and handle local echo instead of direct send
      if (host.protocol === "serial" && serialConfig?.lineMode) {
        for (const ch of text) {
          if (ch === "\r") {
            const line = serialLineBufferRef.current + "\r";
            terminalBackend.writeToSession(id, line);
            serialLineBufferRef.current = "";
            if (serialConfig?.localEcho) writeLocalTerminalData("\r\n");
          } else if (ch === "\x15") {
            if (serialConfig?.localEcho && serialLineBufferRef.current.length > 0) {
              writeLocalTerminalData("\b \b".repeat(serialLineBufferRef.current.length));
            }
            serialLineBufferRef.current = "";
          } else if (ch === "\b" || ch === "\x7f") {
            if (serialLineBufferRef.current.length > 0) {
              serialLineBufferRef.current = serialLineBufferRef.current.slice(0, -1);
              if (serialConfig?.localEcho) writeLocalTerminalData("\b \b");
            }
          } else if (ch.charCodeAt(0) >= 32) {
            serialLineBufferRef.current += ch;
            if (serialConfig?.localEcho) writeLocalTerminalData(ch);
          }
        }
        // Still update commandBuffer and broadcast for serial line mode
        // (fall through to shared bookkeeping below — don't return early)
      } else if (host.protocol === "serial" && serialConfig?.localEcho) {
        // Serial character mode with local echo: echo accepted text locally
        terminalBackend.writeToSession(id, textToWrite);
        for (const ch of text) {
          if (ch === "\r") {
            writeLocalTerminalData("\r\n");
          } else if (ch.charCodeAt(0) >= 32) {
            writeLocalTerminalData(ch);
          }
        }
      } else {
        terminalBackend.writeToSession(id, textToWrite);
      }

      // Broadcast to other sessions if broadcast mode is enabled
      if (isBroadcastEnabledRef.current && onBroadcastInputRef.current) {
        onBroadcastInputRef.current(text, sessionId);
      }

      // Update command buffer for onCommandExecuted tracking
      for (const ch of text) {
        if (handledSubmittedInput) {
          commandBufferRef.current = "";
          break;
        } else if (ch === "\r" || ch === "\n") {
          const rawCommand = commandBufferRef.current;
          if (recorderRef.current.isRecording) {
            void recorderRef.current.recordEnter({
              sensitive: passwordPromptActiveRef.current,
            });
            passwordPromptActiveRef.current = false;
          }
          recordTerminalCommandExecution(rawCommand, {
            host,
            sessionId,
            onCommandExecuted,
            onCommandSubmitted,
            commandBufferRef,
            promptLineBreakStateRef,
          }, termRef.current);
        } else if (ch === "\x15") {
          // Ctrl+U: clear line — reset command buffer (fuzzy match sends this)
          commandBufferRef.current = "";
          recorderRef.current.recordClearLine();
        } else if (ch === "\b" || ch === "\x7f") {
          // Backspace: remove last character (Windows fuzzy replacement uses \b)
          commandBufferRef.current = commandBufferRef.current.slice(0, -1);
          recorderRef.current.recordBackspace();
        } else if (ch.charCodeAt(0) >= 32) {
          commandBufferRef.current += ch;
          recorderRef.current.recordInput(ch);
        }
      }
    }
  };

  // Autocomplete config — the hook itself lives in <TerminalAutocomplete> so
  // its state updates don't re-render this component (see render below).
  // For local protocol the effective OS is the client OS: synthetic fallback
  // hosts (TerminalLayer) and saved-host defaults (HostDetailsPanel) both
  // stamp os: "linux", which mis-routes the autocomplete clear sequence to
  // Ctrl-U on Windows where cmd/PowerShell render it literally (#1112).
  const autocompleteHostOs: "linux" | "windows" | "macos" = host.protocol === "local"
    ? detectLocalOs(navigator.userAgent || navigator.platform)
    : (host.os || "linux");
  const autocompleteSettings = resolveTerminalAutocompleteSettings({
    protocol: host.protocol,
    terminalSettings,
  });

  const resolveSftpInitialPath = useCallback(async (options?: { preferFreshBackend?: boolean }): Promise<string | undefined> => {
    const cwd = await resolvePreferredTerminalCwd({
      rendererCwd: terminalCwdTracker.getRendererCwd(),
      sessionId: sessionRef.current,
      getSessionPwd: (id, options) => terminalBackend.getSessionPwd(id, options),
      preferFreshBackend: options?.preferFreshBackend,
    });
    return cwd ?? undefined;
  }, [terminalBackend, terminalCwdTracker]);

  const clearTerminalCwd = useCallback((options?: { persistRestoreMetadata?: boolean }) => {
    terminalCwdTracker.clearRendererCwd();
    knownCwdRef.current = undefined;
    if (options?.persistRestoreMetadata === false) return;
    onTerminalCwdChange?.(sessionId, null);
  }, [onTerminalCwdChange, sessionId, terminalCwdTracker]);

  // Classify the host's device family from the *detected* distro and the
  // explicit deviceType only. This intentionally bypasses
  // getEffectiveHostDistro(): the manual distro override (`distroMode:
  // 'manual'` + `manualDistro`) is a purely cosmetic icon choice, and a
  // user who pinned e.g. an "ubuntu" icon on what is actually a Cisco /
  // Huawei host must not silently re-enable POSIX-shell probes against it.
  // Several features gate on this — the working-directory probe below, the
  // /etc/os-release probe, and the periodic server-stats poll (#674) —
  // because each opens an extra exec channel that strict network-device
  // CLIs reject or log as a new AAA session, and on Huawei VRP closes the
  // whole session (#1043).
  const detectedDeviceClass = classifyDistroId(host.distro);
  const isNetworkDevice =
    host.deviceType === 'network' || detectedDeviceClass === 'network-device';
  const remoteDragDropUsesZmodem = supportsZmodemTerminalDragDrop(host, isNetworkDevice);

  // Check if this is a local or serial connection (doesn't need connection dialog during connecting)
  const isLocalConnection = host.protocol === "local";
  const isSerialConnection = host.protocol === "serial";
  const supportsRemoteImagePaste =
    !isLocalConnection &&
    !isSerialConnection &&
    host.protocol !== "telnet" &&
    host.protocol !== "mosh" &&
    !host.moshEnabled &&
    host.protocol !== "et" &&
    !host.etEnabled;

  // Server stats (CPU, Memory, Disk) — only for Linux/macOS, never for
  // network devices. See isNetworkDevice above for why the gating uses the
  // raw detected distro / explicit deviceType (not getEffectiveHostDistro);
  // #674 covers the AAA-log-flood motivation for stats specifically.
  const isSupportedOs =
    !isNetworkDevice &&
    (host.os === 'linux' || host.os === 'macos' || detectedDeviceClass === 'linux-like');
  const isSystemSidebarEligible =
    !!onOpenSystem &&
    isSupportedOs &&
    !isLocalConnection &&
    !isSerialConnection &&
    host.protocol !== 'telnet';
  // Server-stats polling now lives inside <TerminalServerStats> (rendered by
  // TerminalView) so its ~5s refresh only re-renders that widget, not the whole
  // terminal. We just forward `isSupportedOs` via ctx.

  const zmodem = useZmodemTransfer(sessionId);
  const [ymodemInProgress, setYmodemInProgress] = useState(false);

  const zmodemToastedRef = useRef(false);

  const pendingAuthRef = useRef<PendingAuth>(null);
  useEffect(() => {
    sudoAutofillRef.current?.updatePassword(resolvedSudoAutofillPassword);
  }, [resolvedSudoAutofillPassword]);
  useEffect(() => {
    sudoAutofillRef.current?.updateCandidates(resolvedSudoAutofillCandidates);
  }, [resolvedSudoAutofillCandidates]);
  useEffect(() => {
    const mode = terminalSettings?.passwordPromptAssist ?? "hint";
    sudoAutofillRef.current?.updateMode(mode);
  }, [terminalSettings?.passwordPromptAssist]);
  // Drop a stale picker if the session disconnects/reconnects — exit teardown
  // nulls sudoAutofillRef without calling onPicker(false).
  useEffect(() => {
    if (status === "disconnected" || status === "connecting") {
      setPasswordPickerState(null);
    }
  }, [status]);
  const handlePasswordPickerSelect = useCallback((id: string) => {
    sudoAutofillRef.current?.confirmFill(id);
  }, []);
  const passwordPickerTitle = t("terminal.passwordPicker.title");
  const passwordPickerEmptyText = t("terminal.passwordPicker.empty");
  const sudoHintText = t("terminal.sudoHint.pressEnter");
  const sessionStartersRef = useRef<ReturnType<typeof createTerminalSessionStarters> | null>(null);
  const auth = useTerminalAuthState({
    host,
    pendingAuthRef,
    termRef,
    onUpdateHost: handleUpdateHostFromTerminal,
    onStartSession: (term) => {
      const starters = sessionStartersRef.current;
      if (!starters) return;
      if (host.moshEnabled) {
        starters.startMosh(term);
        return;
      }
      if (host.etEnabled) {
        starters.startEt(term);
        return;
      }
      starters.startSSH(term);
    },
    setStatus: (next) => setStatus(next),
    setProgressLogs,
  });

  const [needsHostKeyVerification, setNeedsHostKeyVerification] = useState(false);
  const [pendingHostKeyInfo, setPendingHostKeyInfo] = useState<HostKeyInfo | null>(null);
  const [pendingHostKeyRequestId, setPendingHostKeyRequestId] = useState<string | null>(null);
  const pendingConnectionRef = useRef<(() => void) | null>(null);

  // OSC-52 clipboard read prompt
  const [osc52ReadPromptVisible, setOsc52ReadPromptVisible] = useState(false);
  const osc52ReadResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const [osc7SetupOpen, setOsc7SetupOpen] = useState(false);
  const [osc7SetupRunning, setOsc7SetupRunning] = useState(false);
  const handleOsc52ReadRequest = useCallback((): Promise<boolean> => {
    // Reject if terminal is not visible (background tab) — user can't see the prompt
    if (!isVisibleRef.current) return Promise.resolve(false);
    // Reject if another prompt is already pending (avoid resolver overwrite)
    if (osc52ReadResolverRef.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      osc52ReadResolverRef.current = resolve;
      setOsc52ReadPromptVisible(true);
    });
  }, []);
  const handleOsc52ReadResponse = useCallback((allowed: boolean) => {
    setOsc52ReadPromptVisible(false);
    osc52ReadResolverRef.current?.(allowed);
    osc52ReadResolverRef.current = null;
    // Restore focus to terminal
    termRef.current?.focus();
  }, []);

  const handleOsc7SetupOpenChange = useCallback((open: boolean) => {
    setOsc7SetupOpen(open);
    if (!open) {
      queueMicrotask(() => termRef.current?.focus());
    }
  }, []);

  const handleOsc7SetupConfirm = useCallback(() => {
    if (status !== "connected") {
      handleOsc7SetupOpenChange(false);
      return;
    }
    if (osc7SetupRunning) return;
    const currentCwd = terminalCwdTracker.getRendererCwd() ?? knownCwdRef.current;
    if (!currentCwd) {
      toast.error(t("terminal.osc7Setup.failed"));
      return;
    }
    setOsc7SetupRunning(true);
    void runOsc7SetupAction({
      status,
      sessionId,
      setupCommand: buildOsc7SetupExecCommand(currentCwd),
      setupOsc7Tracking: terminalBackend.setupOsc7Tracking,
      writeToSession: terminalBackend.writeToSession,
      writeLocalTerminalData,
    }).then((result) => {
      handleOsc7SetupOpenChange(false);
      if (result.success) {
        toast.success(result.sentToTerminal
          ? t("terminal.osc7Setup.sent")
          : t("terminal.osc7Setup.configured"));
        return;
      }
      toast.error(result.error || t("terminal.osc7Setup.failed"));
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("terminal.osc7Setup.failed"));
    }).finally(() => {
      setOsc7SetupRunning(false);
    });
  }, [
    handleOsc7SetupOpenChange,
    osc7SetupRunning,
    sessionId,
    status,
    t,
    terminalCwdTracker,
    terminalBackend.setupOsc7Tracking,
    terminalBackend.writeToSession,
    writeLocalTerminalData,
  ]);

  const handleTopOverlayMouseDownCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (!shouldPreserveTerminalFocusOnMouseDown(e.target)) return;
    e.preventDefault();
  }, []);

  // Subscribe to custom theme changes so editing triggers re-render
  const customThemes = useCustomThemes();
  const hasFontSizeOverride = host.fontSizeOverride === true || (host.fontSizeOverride === undefined && host.fontSize != null);
  const hasFontFamilyOverride = host.fontFamilyOverride === true || (host.fontFamilyOverride === undefined && !!host.fontFamily);
  const hasFontWeightOverride = host.fontWeightOverride === true || (host.fontWeightOverride === undefined && host.fontWeight != null);
  const effectiveFontSize = useMemo(
    () => (hasFontSizeOverride && host.fontSize != null ? host.fontSize : fontSize),
    [fontSize, hasFontSizeOverride, host.fontSize],
  );
  const effectiveFontWeight = useMemo(
    () => (hasFontWeightOverride && host.fontWeight != null ? host.fontWeight : (terminalSettings?.fontWeight ?? 400)),
    [terminalSettings?.fontWeight, hasFontWeightOverride, host.fontWeight],
  );
  const resolvedFontFamily = useMemo(() => {
    const hostFontId = hasFontFamilyOverride && host.fontFamily
      ? host.fontFamily
      : fontFamilyId;
    const resolvedFontId = resolveTerminalFontFamilyId(
      hostFontId,
      typeof navigator !== "undefined" ? navigator.platform : "",
    );
    const selectedFont = availableFonts.find((f) => f.id === resolvedFontId) || availableFonts[0];
    const platform: SupportedPlatform =
      typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
        ? "darwin"
        : typeof navigator !== "undefined" && /Win/i.test(navigator.platform)
          ? "win32"
          : "linux";
    return composeFontFamilyStack({
      primaryFamily: selectedFont.family,
      userFallback: terminalSettings?.fallbackFont ?? "",
      latinFontId: resolvedFontId,
      platform,
    });
  }, [availableFonts, fontFamilyId, hasFontFamilyOverride, host.fontFamily, terminalSettings?.fallbackFont]);

  const effectiveTheme = useMemo(() => {
    if (appearanceTheme) return appearanceTheme;
    if (followAppTerminalTheme) {
      return applyCustomAccentToTerminalTheme(terminalTheme, accentMode, customAccent);
    }
    const themeId = resolveHostTerminalThemeId(
      { theme: host.theme, themeOverride: host.themeOverride } as Pick<Host, 'theme' | 'themeOverride'>,
      terminalTheme.id,
    );
    let baseTheme = terminalTheme;
    if (themeId) {
      const hostTheme = getBuiltinTerminalThemeById(themeId)
        || customThemes.find((t) => t.id === themeId);
      if (hostTheme) baseTheme = hostTheme;
    }
    return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
  }, [accentMode, appearanceTheme, customAccent, customThemes, followAppTerminalTheme, host.theme, host.themeOverride, terminalTheme]);

  const resolvedChainHosts =
    chainHosts;

  const clearAutoReconnect = useCallback((options?: { stopLoop?: boolean }) => {
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    if (options?.stopLoop !== false) {
      autoReconnectLoopActiveRef.current = false;
      autoReconnectAttemptRef.current = 0;
    }
  }, []);

  const updateStatus = useCallback((next: TerminalSession["status"]) => {
    setStatus(next);
    hasConnectedRef.current = next === "connected";
    if (next === "connected") {
      hasEverConnectedRef.current = true;
      clearAutoReconnect();
    }
    onStatusChange?.(sessionId, next);
  }, [clearAutoReconnect, onStatusChange, sessionId]);
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;

  const scheduleAutoReconnect = useCallback((trigger?: { evt?: Parameters<typeof shouldAutoReconnectAfterExit>[0]["evt"] }) => {
    const shouldSchedule = trigger?.evt
      ? shouldAutoReconnectAfterExit({
        evt: trigger.evt,
        host,
        terminalSettings,
        hasEverConnected: hasEverConnectedRef.current,
      })
      : shouldContinueAutoReconnectAfterFailure({
        host,
        terminalSettings,
        loopActive: autoReconnectLoopActiveRef.current,
      });

    if (!shouldSchedule || !canAttemptTerminalAutoReconnect({
      hasTerminalRuntime: Boolean(termRef.current),
      isHibernated: hibernatedRef.current,
    })) {
      return false;
    }

    autoReconnectLoopActiveRef.current = true;
    if (autoReconnectTimerRef.current) {
      return true;
    }

    autoReconnectAttemptRef.current += 1;
    const attempt = autoReconnectAttemptRef.current;
    const seconds = Math.round(TERMINAL_AUTO_RECONNECT_DELAY_MS / 1000);
    const scheduledMessage = t("terminal.progress.autoReconnectScheduled", { seconds, attempt });

    setError(null);
    setShowLogs(true);
    setIsDisconnectedDialogDismissed(false);
    setProgressLogs((prev) => [...prev, scheduledMessage]);
    updateStatus("connecting");

    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      startReconnectRef.current?.("auto");
    }, TERMINAL_AUTO_RECONNECT_DELAY_MS);

    return true;
  }, [host, t, terminalSettings, updateStatus]);

  const prepareRestoredReconnect = useCallback(() => {
    if (restoreState !== "restored-disconnected") {
      suppressHostStartupCommandRef.current = false;
      restoreCwdIntentRef.current = null;
      return;
    }

    suppressHostStartupCommandRef.current = true;
    restoreCwdIntentRef.current = resolveRestoreCwdIntent({
      enabled: restoreTerminalCwd,
      session: {
        status: "disconnected",
        restoreState,
        protocol: host.protocol,
        shellType,
        lastCwd,
        moshEnabled: host.moshEnabled,
        etEnabled: host.etEnabled,
      },
      isNetworkDevice,
    });
  }, [
    host.etEnabled,
    host.moshEnabled,
    host.protocol,
    isNetworkDevice,
    lastCwd,
    restoreState,
    restoreTerminalCwd,
    shellType,
  ]);

  const handleTerminalDataCaptureOnce = useCallback((
    capturedSessionId: string,
    data: string,
    options?: { finalized?: boolean },
  ) => {
    const captureHandler = onTerminalDataCaptureRef.current;
    if (!captureHandler || terminalDataCapturedRef.current) return;
    terminalDataCapturedRef.current = true;
    const capturedData = options?.finalized
      ? data
      : (finalizeTerminalLogData() || data);
    captureHandler(capturedSessionId, capturedData);
  }, [finalizeTerminalLogData]);

  const cleanupSession = async () => {
    const closingSessionId = sessionRef.current;
    sessionRef.current = null;
    disposeDataRef.current?.();
    disposeDataRef.current = null;
    disposeExitRef.current?.();
    disposeExitRef.current = null;
    disposeTelnetEchoModeRef.current?.();
    disposeTelnetEchoModeRef.current = null;
    telnetLocalEchoRef.current = false;

    const pendingCleanup = sessionCleanupPromiseRef.current;
    if (pendingCleanup) {
      await pendingCleanup;
    }

    if (!closingSessionId) return;

    const cleanupPromise = (async () => {
      const activeTerm = termRef.current;
      if (activeTerm) {
        releaseTerminalFlowBeforeHibernate(terminalBackend, activeTerm, closingSessionId, {
          resumeBackend: false,
        });
      } else {
        flushTerminalSessionFlowAck(closingSessionId);
        clearTerminalSessionFlowAck(closingSessionId);
      }
      try {
        await terminalBackend.closeSession(closingSessionId);
      } catch (err) {
        logger.warn("Failed to close SSH session", err);
      }
    })();

    sessionCleanupPromiseRef.current = cleanupPromise;
    try {
      await cleanupPromise;
    } finally {
      if (sessionCleanupPromiseRef.current === cleanupPromise) {
        sessionCleanupPromiseRef.current = null;
      }
    }
  };

  const disposeRuntimeOnly = () => {
    xtermRuntimeRef.current?.dispose();
    xtermRuntimeRef.current = null;
    termRef.current = null;
    fitAddonRef.current = null;
    serializeAddonRef.current = null;
    searchAddonRef.current = null;
    hasRuntimeRef.current = false;
  };

  const clearHibernateRuntimeState = useCallback(() => {
    hibernatedRef.current = false;
    softHiddenRef.current = false;
    hibernateSnapshotRef.current = "";
    hibernateViewportSnapshotRef.current = "";
    hibernateScrollbackSnapshotRef.current = "";
    hibernateContextSnapshotRef.current = "";
    hibernateContextViewportSnapshotRef.current = "";
    hibernateContextScrollbackSnapshotRef.current = "";
    hibernatePendingBufferRef.current = "";
    hibernateAlternateScreenRef.current = false;
    terminalHiddenRendererStore.clearSoftHidden(sessionId);
  }, [sessionId]);

  const forceCloseHibernatedSession = useCallback(() => {
    if (!terminalDataCapturedRef.current) {
      const hibernatedData = hibernateSnapshotRef.current + hibernatePendingBufferRef.current;
      if (hibernatedData) {
        handleTerminalDataCaptureOnce(sessionId, hibernatedData);
      }
    }
    disposeDataRef.current?.();
    disposeDataRef.current = null;
    disposeExitRef.current?.();
    disposeExitRef.current = null;
    disposeTelnetEchoModeRef.current?.();
    disposeTelnetEchoModeRef.current = null;
    telnetLocalEchoRef.current = false;
    const closingSessionId = sessionRef.current;
    if (closingSessionId) {
      flushTerminalSessionFlowAck(closingSessionId);
      clearTerminalSessionFlowAck(closingSessionId);
      try {
        const closeResult = terminalBackend.closeSession(closingSessionId);
        void Promise.resolve(closeResult).catch((err) => {
          logger.warn("Failed to close hibernated session", err);
        });
      } catch (err) {
        logger.warn("Failed to close hibernated session", err);
      }
    }
    sessionRef.current = null;
    clearHibernateRuntimeState();
  }, [clearHibernateRuntimeState, handleTerminalDataCaptureOnce, sessionId, terminalBackend]);

  const beginHibernatedSessionListeners = useCallback((backendId: string) => {
    disposeDataRef.current?.();
    flushTerminalSessionFlowAck(backendId);
    terminalBackend.setSessionFlowPaused?.(backendId, false);
    hibernatePendingBufferRef.current = "";
    disposeDataRef.current = terminalBackend.onSessionData(
      backendId,
      (chunk) => {
        hibernatePendingBufferRef.current = appendHibernatePendingBuffer(
          hibernatePendingBufferRef.current,
          chunk,
        );
        ackTerminalSessionFlow(terminalBackend, backendId, chunk.length);
      },
      { replayBacklog: true },
    );

    disposeExitRef.current?.();
    disposeExitRef.current = terminalBackend.onSessionExit(backendId, (evt) => {
      disposeTelnetEchoModeRef.current?.();
      disposeTelnetEchoModeRef.current = null;
      telnetLocalEchoRef.current = false;
      updateStatusRef.current("disconnected");
      if (evt.error) {
        setError(evt.error);
      }
      const exitMessage = `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`;
      hibernatePendingBufferRef.current = appendHibernatePendingBuffer(
        hibernatePendingBufferRef.current,
        exitMessage,
      );
      onSessionExit?.(sessionId, evt);
      scheduleAutoReconnect({ evt });
    });
  }, [onSessionExit, scheduleAutoReconnect, sessionId, terminalBackend]);

  const clearHibernateRetry = useCallback(() => {
    if (hibernateRetryTimerRef.current === null) return;
    clearTimeout(hibernateRetryTimerRef.current);
    hibernateRetryTimerRef.current = null;
  }, []);

  const scheduleHibernateRetry = useCallback(() => {
    if (hibernateRetryTimerRef.current !== null) return;
    hibernateRetryTimerRef.current = setTimeout(() => {
      hibernateRetryTimerRef.current = null;
      if (
        isVisibleRef.current
        || hibernatedRef.current
        || softHiddenRef.current
        || !hasRuntimeRef.current
        || statusRef.current !== "connected"
        || isSearchOpenRef.current
        || hibernateFileTransferActiveRef.current
        || !hibernateEnabledRef.current
      ) {
        return;
      }
      void fullHibernateRuntimeRef.current?.();
    }, HIBERNATE_RETRY_AFTER_DRAIN_MS);
  }, []);

  const applyHibernateSnapshot = useCallback((
    snapshot: {
      snapshot: string;
      viewportSnapshot: string;
      scrollbackSnapshot: string;
      contextSnapshot?: string;
      contextViewportSnapshot?: string;
      contextScrollbackSnapshot?: string;
      alternateScreen: boolean;
    },
  ) => {
    hibernateSnapshotRef.current = snapshot.snapshot;
    hibernateViewportSnapshotRef.current = snapshot.viewportSnapshot;
    hibernateScrollbackSnapshotRef.current = snapshot.scrollbackSnapshot;
    hibernateContextSnapshotRef.current = snapshot.contextSnapshot ?? "";
    hibernateContextViewportSnapshotRef.current = snapshot.contextViewportSnapshot ?? "";
    hibernateContextScrollbackSnapshotRef.current = snapshot.contextScrollbackSnapshot ?? "";
    hibernateAlternateScreenRef.current = snapshot.alternateScreen;
  }, []);

  const shouldSkipHibernateForActiveAlternateScreen = useCallback((term: XTerm): boolean => {
    if (
      !isTerminalAlternateScreenActive(term)
      || !resolveHibernateSkipAltScreen(terminalSettings)
    ) {
      return false;
    }
    logger.info("[Terminal] Skipping hibernate: alternate screen active", { sessionId });
    return true;
  }, [sessionId, terminalSettings]);

  const fullHibernateRuntime = useCallback(async (): Promise<boolean> => {
    if (hibernatedRef.current || softHiddenRef.current || !termRef.current || !serializeAddonRef.current) return false;
    clearHibernateRetry();
    const backendId = sessionRef.current;
    if (!backendId) return false;
    const term = termRef.current;
    const serializeAddon = serializeAddonRef.current;
    const canFinishHibernate = () => (
      !isVisibleRef.current
      && !hibernatedRef.current
      && !softHiddenRef.current
      && hasRuntimeRef.current
      && statusRef.current === "connected"
      && !isSearchOpenRef.current
      && !hibernateFileTransferActiveRef.current
      && hibernateEnabledRef.current
      && termRef.current === term
      && sessionRef.current === backendId
      && serializeAddonRef.current === serializeAddon
    );

    if (!canFinishHibernate()) return false;

    terminalHiddenRendererStore.clearSoftHidden(sessionId);
    softHiddenRef.current = false;
    const flushedBeforeHibernate = await flushPendingTerminalWritesBeforeHibernate(term);
    if (!flushedBeforeHibernate) {
      logger.info("[Terminal] Skipping hibernate: terminal output is still draining", { sessionId });
      scheduleHibernateRetry();
      return false;
    }
    if (!canFinishHibernate()) return false;
    if (shouldSkipHibernateForActiveAlternateScreen(term)) {
      return false;
    }

    const snapshot = await serializeTerminalForHibernate(
      term,
      serializeAddon,
      { preferWasm: resolveHibernatePreferWasmSerialize(terminalSettingsRef.current) },
    );

    if (!canFinishHibernate()) return false;

    if (snapshot.alternateScreen && snapshot.snapshot.length === 0) {
      logger.info("[Terminal] Skipping hibernate: alternate screen snapshot unavailable", { sessionId });
      return false;
    }

    applyHibernateSnapshot(snapshot);
    isBootActiveRef.current = false;
    releaseTerminalFlowBeforeHibernate(terminalBackend, term, backendId);
    disposeDataRef.current?.();
    disposeDataRef.current = null;
    disposeExitRef.current?.();
    disposeExitRef.current = null;
    disposeRuntimeOnly();
    beginHibernatedSessionListeners(backendId);
    hibernatedRef.current = true;
    // Hibernation rebuilds the autofill controller on wake; drop any open
    // picker so it cannot stay visible against a non-pending controller.
    setPasswordPickerState(null);
    logger.info("[Terminal] Hibernated runtime", {
      sessionId,
      snapshotChars: hibernateSnapshotRef.current.length,
      viewportChars: hibernateViewportSnapshotRef.current.length,
      scrollbackChars: hibernateScrollbackSnapshotRef.current.length,
      alternateScreen: snapshot.alternateScreen,
    });
    return true;
  }, [
    applyHibernateSnapshot,
    beginHibernatedSessionListeners,
    clearHibernateRetry,
    scheduleHibernateRetry,
    sessionId,
    shouldSkipHibernateForActiveAlternateScreen,
    terminalBackend,
  ]);
  fullHibernateRuntimeRef.current = fullHibernateRuntime;

  const hideRuntimeOnly = useCallback(() => {
    if (hibernatedRef.current || softHiddenRef.current || !hasRuntimeRef.current) return;
    xtermRuntimeRef.current?.suspendWebglRenderer();
    terminalHiddenRendererStore.markSoftHidden(sessionId);
    softHiddenRef.current = true;
    logger.info("[Terminal] Soft-hidden runtime", { sessionId });
  }, [sessionId]);

  const hibernateRuntime = useCallback(() => {
    if (hibernatedRef.current || softHiddenRef.current || !termRef.current) return;

    if (shouldSkipHibernateForActiveAlternateScreen(termRef.current)) {
      return;
    }

    const keepCount = resolveHibernateKeepRendererCount(terminalSettings);
    if (keepCount > 0 && terminalHiddenRendererStore.getSoftHiddenCount() < keepCount) {
      hideRuntimeOnly();
      return;
    }

    if (keepCount > 0) {
      const victim = terminalHiddenRendererStore.pickEvictionCandidate(keepCount);
      if (victim && victim !== sessionId) {
        terminalHiddenRendererStore.requestEviction(victim);
      }
    }

    void fullHibernateRuntime();
  }, [fullHibernateRuntime, hideRuntimeOnly, sessionId, shouldSkipHibernateForActiveAlternateScreen, terminalSettings]);

  const terminalRuntimeRefs = useMemo<TerminalRuntimeRefs>(() => ({
    xtermRuntimeRef,
    termRef,
    fitAddonRef,
    serializeAddonRef,
    searchAddonRef,
    hasRuntimeRef,
  }), []);

  const xTermRuntimeContextRef = useRef<Omit<CreateXTermRuntimeContext, "container" | "initiallyVisible"> | null>(null);

  const teardown = () => {
    isBootActiveRef.current = false;
    retryTokenRef.current = null;
    restoreCwdIntentRef.current = null;
    suppressHostStartupCommandRef.current = false;
    clearHibernateRetry();
    clearAutoReconnect();
    void cleanupSession();
    disposeRuntimeOnly();
  };

  const sessionStarters = createTerminalSessionStarters({
    host,
    keys,
    identities,
    knownHosts,
    resolvedChainHosts,
    sessionId,
    reuseConnectionFromSessionId,
    startupCommand,
    noAutoRun,
    multiLineRunMode,
    shellType,
    suppressHostStartupCommandRef,
    terminalSettings,
    terminalSettingsRef,
    terminalBackend,
    serialConfig,
    telnetLocalEchoRef,
    isVisibleRef: isRendererActiveRef,
    isBootActiveRef,
    pendingOutputScrollRef,
    sessionRef,
    hasConnectedRef,
    hasRunStartupCommandRef,
    restoreCwdIntentRef,
    disposeDataRef,
    disposeExitRef,
    disposeTelnetEchoModeRef,
    fitAddonRef,
    serializeAddonRef,
    pendingAuthRef,
    promptLineBreakStateRef,
    sudoAutofillRef,
    onSudoHint: (active: boolean) => sudoHintRef.current?.(active) ?? false,
    onPasswordPromptPicker: (active, state) => passwordPickerRef.current?.(active, state) ?? false,
    sudoAutofillCandidates: resolvedSudoAutofillCandidates,
    sudoAutofillCandidatesRef,
    updateStatus,
    setStatus,
    setError,
    setNeedsAuth: auth.setNeedsAuth,
    setAuthRetryMessage: auth.setAuthRetryMessage,
    setAuthPassword: auth.setAuthPassword,
    setProgressLogs,
    setProgressValue,
    setChainProgress,
    setIsConnectionAwaitingUserInput,
    setIsConnectionPastTcpDial,
    t,
    onSessionAttached: (id: string) => {
      clearTerminalCwd({ persistRestoreMetadata: false });
      // SSH: always sync. Its backend starts in utf-8 regardless of
      // host.charset, so the push is what keeps the UI state aligned
      // across reconnects — including localhost SSH targets, hence
      // hostname isn't in the gate.
      const isLocal = host.protocol === 'local' || host.id?.startsWith('local-');
      const isSerial = host.protocol === 'serial' || host.id?.startsWith('serial-');
      const isTelnet = host.protocol === 'telnet';
      const isMosh = host.protocol === 'mosh' || host.moshEnabled;
      const isEt = host.protocol === 'et' || host.etEnabled;
      const isSSH = !isLocal && !isSerial && !isTelnet && !isMosh && !isEt;
      const encodingAttachConnection: TerminalEncodingAttachConnection = isSSH
        ? 'ssh'
        : isTelnet
          ? 'telnet'
          : isSerial
            ? 'serial'
            : 'other';
      // Telnet / serial: the backend already applied host.charset unless
      // a remembered per-host choice exists. Remembered choices are explicit
      // user preferences and must win on reconnect, including saved serial hosts.
      // (including arbitrary iconv labels like latin1 / shift_jis that
      // the UI's two-value state can't represent) through start*Session
      // options, so don't clobber it on first attach without a stored choice.
      if (shouldSyncTerminalEncodingOnAttach({
        connection: encodingAttachConnection,
        userPickedEncoding: userPickedEncodingRef.current,
        hasRememberedEncoding: hasRememberedTerminalEncodingRef.current,
      })) {
        setSessionEncoding(id, terminalEncodingRef.current);
      }
    },
    onRestoreCwdIntentConsumed: (cwd: string) => {
      knownCwdRef.current = cwd;
    },
    onSessionExit: (closedSessionId, evt) => {
      clearTerminalCwd();
      onSessionExit?.(closedSessionId, evt);
      scheduleAutoReconnect({ evt });
    },
    onTerminalDataCapture: handleTerminalDataCaptureOnce,
    onTerminalOutput: (chunk: string, meta?: TerminalSessionDataMeta) => {
      if (PASSWORD_PROMPT_PATTERN.test(chunk)) {
        passwordPromptActiveRef.current = true;
      }
      appendOutputTriggerOutputRef.current(chunk, meta);
      if (onTerminalOutput) {
        onTerminalOutput(sessionId, chunk);
      }
    },
    onTerminalLogData: captureTerminalLogData,
    onProgrammaticCommandLogRewrite: queueProgrammaticCommandLogRewrite,
    onOsDetected,
    onCommandExecuted,
    onCommandSubmitted,
    sessionLog,
    sshDebugLogEnabled,
    sudoAutofillPassword: resolvedSudoAutofillPassword,
    sudoAutofillPasswordRef,
  });
  sessionStartersRef.current = sessionStarters;

  useEffect(() => {
    if (status === 'disconnected' && !autoReconnectLoopActiveRef.current) {
      connectScriptsConsumedRef.current = false;
      connectScriptsCompletedIdsRef.current = new Set();
    }
    if (status === 'disconnected' && host.moshEnabled) {
      setMoshShellReady(false);
    }
  }, [host.moshEnabled, status]);

  // Synchronously (re)register the mosh ready listener. Must run before
  // startMosh on retry: cleanupSession/closeSession wipes preload listeners,
  // and a useEffect-only resubscribe can race a fast passwordless handshake.
  const prepareMoshReadySubscription = useCallback(() => {
    disposeMoshReadyRef.current?.();
    disposeMoshReadyRef.current = null;
    if (!host.moshEnabled) {
      setMoshShellReady(true);
      return;
    }
    if (!terminalBackend.onMoshSessionReady) {
      // Older bridges without the ready event must not block scripts forever.
      setMoshShellReady(true);
      return;
    }
    setMoshShellReady(false);
    disposeMoshReadyRef.current = terminalBackend.onMoshSessionReady(sessionId, () => {
      setMoshShellReady(true);
    }) ?? null;
  }, [host.moshEnabled, sessionId, terminalBackend]);

  useEffect(() => {
    prepareMoshReadySubscription();
    return () => {
      disposeMoshReadyRef.current?.();
      disposeMoshReadyRef.current = null;
    };
  }, [prepareMoshReadySubscription]);

  useEffect(() => {
    if (status !== "disconnected") return;
    scheduleAutoReconnect();
  }, [scheduleAutoReconnect, status]);

  useEffect(() => {
    if (!autoReconnectLoopActiveRef.current) return;
    if (shouldContinueAutoReconnectAfterFailure({ host, terminalSettings, loopActive: true })) return;
    const hadPendingReconnect = autoReconnectTimerRef.current !== null;
    clearAutoReconnect();
    if (hadPendingReconnect) {
      updateStatus("disconnected");
    }
  }, [clearAutoReconnect, host, terminalSettings, updateStatus]);

  useEffect(() => {
    pendingScriptRunIdRef.current = null;
    pendingScriptHandledRef.current = null;
  }, [pendingScript?.id, pendingScriptId]);

  const isPendingScriptAlreadyHandled = useCallback((snippet: Snippet) => {
    if (snippet.id) {
      return pendingScriptRunIdRef.current === snippet.id;
    }
    return pendingScriptHandledRef.current === snippet;
  }, []);

  useEffect(() => {
    if (status !== 'connected') return;
    if (host.moshEnabled && !moshShellReady) return;

    let pendingOne: Snippet | undefined;
    if (pendingScript && isScriptSnippet(pendingScript)) {
      if (!isPendingScriptAlreadyHandled(pendingScript)) {
        pendingOne = pendingScript;
      }
    } else if (pendingScriptId) {
      const script = snippets.find((item) => item.id === pendingScriptId && isScriptSnippet(item));
      if (script && !isPendingScriptAlreadyHandled(script)) {
        pendingOne = script;
      }
    }

    const shouldEvaluateConnect = !connectScriptsConsumedRef.current;
    const hasPendingWork = Boolean(pendingOne);
    if (!shouldEvaluateConnect && !hasPendingWork) return;
    if (connectScriptsInFlightRef.current) return;

    // Defer until xterm has rendered login output and the main-process output tap
    // has populated SessionOutputBuffer (avoids waitForPrompt racing an empty buffer).
    const timer = window.setTimeout(() => {
      const runPending = Boolean(pendingOne);
      const connectQueueNow = connectScriptsConsumedRef.current
        ? []
        : resolveConnectScriptsForHost(host, snippets).filter(
          (item) => item.id && !connectScriptsCompletedIdsRef.current.has(item.id),
        );

      const scriptsToRun: Snippet[] = [];
      for (const item of connectQueueNow) {
        scriptsToRun.push(item);
      }
      if (runPending && pendingOne && !scriptsToRun.some((entry) => entry.id === pendingOne.id)) {
        scriptsToRun.push(pendingOne);
      }

      const resolvedConnectScripts = resolveConnectScriptsForHost(host, snippets);
      const allConnectScriptsDone = resolvedConnectScripts.length === 0
        || resolvedConnectScripts.every(
          (item) => item.id && connectScriptsCompletedIdsRef.current.has(item.id),
        );

      if (scriptsToRun.length === 0) {
        if (
          !connectScriptsConsumedRef.current
          && allConnectScriptsDone
          && isVaultInitialized()
          && snippets.length > 0
          && !hasUnresolvedConnectScriptBindings(host, snippets)
        ) {
          connectScriptsConsumedRef.current = true;
        }
        return;
      }

      const pendingScriptToMark = runPending ? pendingOne : undefined;
      const connectIdsInBatch = new Set(
        connectQueueNow.map((item) => item.id).filter((id): id is string => Boolean(id)),
      );

      connectScriptsInFlightRef.current = true;

      void runConnectScriptsSequential({
        scripts: scriptsToRun,
        sessionId,
        sessionMeta: {
          connected: true,
          hostname: host.hostname,
          username: host.username,
        },
        onScriptComplete: (snippet) => {
          if (snippet.id && connectIdsInBatch.has(snippet.id)) {
            connectScriptsCompletedIdsRef.current.add(snippet.id);
          }
          if (pendingScriptToMark && snippet === pendingScriptToMark) {
            if (snippet.id) {
              pendingScriptRunIdRef.current = snippet.id;
            } else {
              pendingScriptHandledRef.current = snippet;
            }
          }
        },
      })
        .then(() => {
          const resolvedAfterRun = resolveConnectScriptsForHost(host, snippets);
          const doneAfterRun = resolvedAfterRun.length === 0
            || resolvedAfterRun.every(
              (item) => item.id && connectScriptsCompletedIdsRef.current.has(item.id),
            );
          if (doneAfterRun) {
            connectScriptsConsumedRef.current = true;
          }
        })
        .catch(async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          toast.error(message.includes('Observer mode') ? t('scripts.observer.blocked') : message);
          connectScriptsConsumedRef.current = true;

          const pendingStillNeeded = pendingScriptToMark && (
            pendingScriptToMark.id
              ? pendingScriptRunIdRef.current !== pendingScriptToMark.id
              : pendingScriptHandledRef.current !== pendingScriptToMark
          );
          if (!pendingStillNeeded) return;

          try {
            await runConnectScriptsSequential({
              scripts: [pendingScriptToMark],
              sessionId,
              sessionMeta: {
                connected: true,
                hostname: host.hostname,
                username: host.username,
              },
              onScriptComplete: (snippet) => {
                if (snippet.id) {
                  pendingScriptRunIdRef.current = snippet.id;
                } else {
                  pendingScriptHandledRef.current = snippet;
                }
              },
            });
          } catch (pendingErr) {
            const pendingMessage = pendingErr instanceof Error ? pendingErr.message : String(pendingErr);
            toast.error(pendingMessage.includes('Observer mode') ? t('scripts.observer.blocked') : pendingMessage);
          }
        })
        .finally(() => {
          connectScriptsInFlightRef.current = false;
        });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [host, isPendingScriptAlreadyHandled, moshShellReady, pendingScript, pendingScriptId, sessionId, snippets, status, t]);

  useEffect(() => {
    return registerScreenSnapshotProvider(sessionId, () => {
      const term = termRef.current;
      if (!term?.buffer?.active) {
        // Hibernated terminals: prefer last captured viewport for script sync.
        const hibernatedViewport =
          hibernateViewportSnapshotRef.current
          || hibernateSnapshotRef.current
          || hibernatePendingBufferRef.current;
        if (hibernatedViewport) {
          const lines = hibernatedViewport.split("\n");
          return {
            rows: Math.max(lines.length, 1),
            cols: 80,
            currentRow: Math.max(lines.length - 1, 0),
            lines,
            source: "hibernate-viewport",
          };
        }
        return { rows: 24, cols: 80, currentRow: 0, lines: [] };
      }
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < term.rows; row += 1) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      }
      return {
        rows: term.rows,
        cols: term.cols,
        currentRow: buffer.baseY + buffer.cursorY,
        lines,
      };
    });
  }, [sessionId]);

  useEffect(() => {
    const startHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId !== sessionId) return;
      void recorderRef.current.startRecording();
    };
    const stopHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId !== sessionId) return;
      if (!recorderRef.current.isRecording) return;
      void recorderRef.current.stopRecording().then(({ code }) => {
        setRecordedCode(code);
        setSaveRecordingOpen(true);
      });
    };
    window.addEventListener('netcatty:script:recording:start', startHandler);
    window.addEventListener('netcatty:script:recording:stop', stopHandler);
    return () => {
      window.removeEventListener('netcatty:script:recording:start', startHandler);
      window.removeEventListener('netcatty:script:recording:stop', stopHandler);
    };
  }, [sessionId]);

  useEffect(() => {
    if (recorder.isRecording) {
      setScriptRecordingState(sessionId, recorder.isPaused);
    } else if (getScriptRecordingSnapshot().sessionId === sessionId) {
      setScriptRecordingState(null);
    }
  }, [recorder.isRecording, recorder.isPaused, sessionId]);

  useEffect(() => () => {
    if (getScriptRecordingSnapshot().sessionId === sessionId) {
      setScriptRecordingState(null);
    }
  }, [sessionId]);

  useEffect(() => {
    setConnectionReuseFellBack(false);
    if (!reuseConnectionFromSessionId) return undefined;

    return terminalBackend.onConnectionReuseFallback?.((fallbackSessionId) => {
      if (fallbackSessionId === sessionId) {
        setConnectionReuseFellBack(true);
      }
    });
  }, [reuseConnectionFromSessionId, sessionId, terminalBackend]);

  const safeFit = (options?: { force?: boolean; requireVisible?: boolean; immediate?: boolean; allowHidden?: boolean }) => {
    const fitAddon = fitAddonRef.current;
    if (!fitAddon) return;
    if (!isRendererActiveRef.current && !options?.allowHidden) {
      lastFittedSizeRef.current = null;
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) {
      // Terminal is hidden — invalidate the cached size so that when it
      // becomes visible again, a non-forced fit won't be suppressed by a
      // stale size match (e.g. after font metrics changed while hidden).
      lastFittedSizeRef.current = null;
      return;
    }

    if (!options?.force) {
      const lastSize = lastFittedSizeRef.current;
      if (lastSize && lastSize.width === width && lastSize.height === height) {
        autocompleteRepositionRef.current?.();
        return;
      }
    }

    const runFit = () => {
      try {
        const term = termRef.current;
        if (!term) return;

        const buffer = term.buffer.active;
        const wasPinnedToBottom = buffer.viewportY >= buffer.baseY;
        const savedViewportY = buffer.viewportY;

        const dimensions = fitAddon.proposeDimensions();
        if (!dimensions || Number.isNaN(dimensions.cols) || Number.isNaN(dimensions.rows)) return;

        lastFittedSizeRef.current = { width, height };
        // addon-fit 0.11 clears the renderer before resizing, which can show
        // as a one-frame WebGL blink during layout changes. Resize directly
        // using the proposed dimensions to preserve the existing behavior
        // without forcing a blank intermediate frame.
        if (term.cols !== dimensions.cols || term.rows !== dimensions.rows) {
          term.resize(dimensions.cols, dimensions.rows);
          forceSyncRenderAfterResize(term);
        } else {
          // Pixel-only layout changes (opening the SFTP side panel, compose
          // bar, etc.) shrink the container without changing cols/rows, so
          // term.onResize — which clears the WebGL atlas — never fires.
          // Stale atlas glyphs then paint as black squares (#2013).
          xtermRuntimeRef.current?.clearTextureAtlas();
          forceSyncRenderAfterResize(term);
        }

        // Preserve scroll position across resize (superset/Tabby pattern).
        if (wasPinnedToBottom) {
          term.scrollToBottom();
        } else {
          const targetY = Math.min(savedViewportY, term.buffer.active.baseY);
          if (term.buffer.active.viewportY !== targetY) {
            term.scrollToLine(targetY);
          }
        }
        term.refresh(0, Math.max(0, term.rows - 1));

        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            autocompleteRepositionRef.current?.();
          });
        } else {
          autocompleteRepositionRef.current?.();
        }
      } catch (err) {
        logger.warn("Fit failed", err);
      }
    };

    if (
      XTERM_PERFORMANCE_CONFIG.resize.useRAF &&
      typeof requestAnimationFrame === "function" &&
      !options?.immediate
    ) {
      requestAnimationFrame(runFit);
    } else {
      runFit();
    }
  };

  const prevIsResizingRef = useRef(isResizing);

  const disableBracketedPasteRef = useRef(terminalSettings?.disableBracketedPaste ?? false);
  disableBracketedPasteRef.current = terminalSettings?.disableBracketedPaste ?? false;

  // True only while createXTermRuntime is programmatically restoring the
  // selection right after a keystroke (preserveSelectionOnInput). Lets
  // copy-on-select skip a redundant clipboard write that would otherwise
  // clobber whatever the user copied elsewhere in the meantime.
  const isRestoringSelectionRef = useRef(false);

  const scrollOnPasteRef = useRef(terminalSettings?.scrollOnPaste ?? true);
  scrollOnPasteRef.current = terminalSettings?.scrollOnPaste ?? true;
  const clearWipesScrollbackRef = useRef(terminalSettings?.clearWipesScrollback ?? true);
  clearWipesScrollbackRef.current = terminalSettings?.clearWipesScrollback ?? true;
  const normalizeTextOnCopyRef = useRef(terminalSettings?.normalizeTextOnCopy ?? true);
  normalizeTextOnCopyRef.current = terminalSettings?.normalizeTextOnCopy ?? true;

  const scrollToBottomAfterProgrammaticInput = useCallback((data: string) => {
    if (!termRef.current) return;
    scrollTerminalToBottomAfterInputIfEnabled(
      termRef.current,
      terminalSettingsRef.current,
      data,
    );
  }, []);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    const dispose = bridge?.onScriptSessionInput?.(({ sessionId: sid, data }) => {
      if (sid !== sessionId) return;
      scrollToBottomAfterProgrammaticInput(data);
    });
    return dispose;
  }, [scrollToBottomAfterProgrammaticInput, sessionId]);

  useEffect(() => {
    if (!activeScriptRun) return;
    termRef.current?.scrollToBottom();
  }, [activeScriptRun]);

  const broadcastUserPasteData = useCallback((data: string) => {
    if (sessionRef.current && isBroadcastEnabledRef.current && onBroadcastInputRef.current) {
      onBroadcastInputRef.current(data, sessionId);
      return true;
    }
    return false;
  }, [sessionId]);

  const executeSnippetCommand = useCallback((
    command: string,
    noAutoRun?: boolean,
    options?: { broadcast?: boolean; multiLineRunMode?: Snippet["multiLineRunMode"] },
  ) => {
    const term = termRef.current;
    const id = sessionRef.current;
    if (!term || !id) return;

    let data = normalizeLineEndings(command);
    const lineDelayMs = shouldDelayAutoRunSnippetInput(data, {
      noAutoRun,
      multiLineRunMode: options?.multiLineRunMode,
    })
      ? AUTO_RUN_SNIPPET_LINE_DELAY_MS
      : undefined;
    const isMultiLine = data.includes('\n');
    // Wrap in bracketed paste BEFORE appending \r so the Enter is sent
    // outside the paste markers — otherwise shells treat it as pasted text
    // instead of a submit action.
    if (!lineDelayMs && isMultiLine && term.modes.bracketedPasteMode && !disableBracketedPasteRef.current) {
      data = wrapBracketedPaste(data);
    }
    if (!noAutoRun) data = `${data}\r`;

    // Broadcast the exact bytes the active session receives so peers mirror it,
    // including the bracketed-paste wrapping and the auto-run \r. Broadcasting
    // the raw (un-wrapped) form would let a multi-line noAutoRun snippet run
    // line-by-line on peers, since handleBroadcastInput writes bytes directly
    // without re-wrapping. Without broadcasting at all, accepting a snippet in
    // broadcast mode would clear peer input (the clear keystrokes already go
    // through the broadcast-aware path) but never send the command.
    if (options?.broadcast !== false && isBroadcastEnabledRef.current && onBroadcastInputRef.current) {
      onBroadcastInputRef.current(data, sessionId, {
        noAutoRun,
        ...(lineDelayMs ? { lineDelayMs } : {}),
      });
    }

    data = prepareProgrammaticSudoInput(data);
    terminalBackend.writeToSession(id, data, {
      automated: true,
      ...(lineDelayMs ? { lineDelayMs } : {}),
    });
    scrollToBottomAfterProgrammaticInput(data);
    term.focus();
  }, [prepareProgrammaticSudoInput, scrollToBottomAfterProgrammaticInput, terminalBackend, sessionId]);

  const executeSnippet = useCallback(async (snippet: Snippet) => {
    if (isScriptSnippet(snippet)) {
      try {
        await runAutomationScript({ snippet, sessionId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(message.includes('Observer mode') ? t('scripts.observer.blocked') : message);
      }
      return;
    }
    const command = await resolveSnippetCommand(snippet);
    if (command === null) return;
    executeSnippetCommand(command, snippet.noAutoRun, {
      multiLineRunMode: snippet.multiLineRunMode,
    });
  }, [executeSnippetCommand, sessionId, t]);

  const onSnippetShortkeyRef = useRef(executeSnippet);
  onSnippetShortkeyRef.current = executeSnippet;

  const handleClipboardImageUploadResult = useCallback((result: RemoteClipboardImageUploadResult) => {
    const messageKey = getRemoteClipboardImageUploadErrorMessageKey(result);
    if (messageKey) toast.error(t(messageKey));
  }, [t]);

  const terminalContextActions = useTerminalContextActions({
    termRef,
    sourceSessionId: sessionId,
    sessionRef,
    onHasSelectionChange: setHasSelection,
    scrollOnPasteRef,
    clearWipesScrollbackRef,
    normalizeTextOnCopyRef,
    isBroadcastEnabledRef,
    onBroadcastInputRef,
    isLocalConnection,
    supportsRemoteImagePaste,
    terminalBackend,
    getRemoteCwd: () => resolveSftpInitialPath({ preferFreshBackend: true }),
    scrollToBottomAfterProgrammaticInput,
    onClipboardImageUploadResult: handleClipboardImageUploadResult,
  });
  // Kept fresh on every render so the mouseTracking capture handler at
  // handleContextMenuCapture (which is bound once per sessionId) can
  // still invoke the latest paste / select-word callbacks without
  // re-binding on every action identity change. See #941.
  const terminalContextActionsRef = useRef(terminalContextActions);
  terminalContextActionsRef.current = terminalContextActions;

  const handleAddSelectionToAI = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const selection = getTerminalSelectionForClipboard(
      term,
      terminalSettings?.normalizeTextOnCopy ?? true,
    );
    if (!selection.trim()) return;
    onAddSelectionToAI?.(sessionId, selection);
  }, [onAddSelectionToAI, sessionId, terminalSettings?.normalizeTextOnCopy]);

  const handleSetTerminalEncoding = useCallback((encoding: TerminalEncodingPreference) => {
    setTerminalEncoding(encoding);
    setRememberedTerminalEncoding(encoding);
    userPickedEncodingRef.current = true;
    if (host.id && host.protocol !== 'local' && !host.id.startsWith('local-') && !host.id.startsWith('serial-')) {
      handleUpdateHostFromTerminal({
        id: host.id,
        charset: terminalEncodingPreferenceToCharset(encoding),
      });
    }
    if (sessionRef.current) {
      setSessionEncoding(sessionRef.current, encoding);
    }
  }, [handleUpdateHostFromTerminal, host.id, host.protocol, setRememberedTerminalEncoding, setSessionEncoding]);

  const handleOpenSFTP = useCallback(async () => {
    if (onOpenSftp) {
      // Delegate to parent (TerminalLayer) for shared SFTP side panel
      const initialPath = await resolveSftpInitialPath();
      onOpenSftp(host, initialPath, undefined, sessionId);
      return;
    }

    // Fallback: toggle internal SFTP state (shouldn't happen with new architecture)
    if (showSFTP) {
      setShowSFTP(false);
      return;
    }
    setShowSFTP(true);
  }, [host, onOpenSftp, resolveSftpInitialPath, sessionId, showSFTP]);

  const handleSendYmodem = useCallback(async () => {
    if (!isSerialConnection || statusRef.current !== "connected") return;
    if (!selectFileAvailable() || !serialYmodemAvailable()) {
      toast.error(t("terminal.ymodem.unavailable"));
      return;
    }

    try {
      const defaultPath = getRememberedYmodemSendDefaultPath();
      const filePath = await selectFile(
        t("terminal.ymodem.selectFile"),
        defaultPath,
        [{ name: t("terminal.ymodem.allFiles"), extensions: ["*"] }],
      );
      if (!filePath) return;
      rememberYmodemSendFilePath(filePath);

      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      toast.info(t("terminal.ymodem.started", { fileName }));
      setYmodemInProgress(true);
      const result = await sendSerialYmodem(sessionRef.current || sessionId, filePath);
      if (result.success) {
        toast.success(t("terminal.ymodem.complete", { fileName: result.fileName || fileName }));
      } else {
        toast.error(result.error || t("terminal.ymodem.failed"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("terminal.ymodem.failed"));
    } finally {
      setYmodemInProgress(false);
    }
  }, [isSerialConnection, selectFile, selectFileAvailable, sendSerialYmodem, serialYmodemAvailable, sessionId, t]);

  const handleReceiveYmodem = useCallback(async () => {
    if (!isSerialConnection || statusRef.current !== "connected") return;
    if (!selectDirectoryAvailable() || !serialYmodemReceiveAvailable()) {
      toast.error(t("terminal.ymodem.unavailable"));
      return;
    }

    try {
      const destinationDir = await selectDirectory(t("terminal.ymodem.selectReceiveDirectory"));
      if (!destinationDir) return;

      toast.info(t("terminal.ymodem.receiveStarted"));
      setYmodemInProgress(true);
      const result = await receiveSerialYmodem(sessionRef.current || sessionId, destinationDir);
      if (result.success) {
        if (result.fileCount && result.fileCount > 1) {
          toast.success(t("terminal.ymodem.receiveCompleteMultiple", { count: result.fileCount }));
        } else if (result.fileName) {
          toast.success(t("terminal.ymodem.receiveComplete", { fileName: result.fileName }));
        } else {
          toast.success(t("terminal.ymodem.receiveEmpty"));
        }
      } else {
        toast.error(t("terminal.ymodem.receiveFailed"));
      }
    } catch {
      toast.error(t("terminal.ymodem.receiveFailed"));
    } finally {
      setYmodemInProgress(false);
    }
  }, [
    isSerialConnection,
    receiveSerialYmodem,
    selectDirectory,
    selectDirectoryAvailable,
    serialYmodemReceiveAvailable,
    sessionId,
    t,
  ]);

  const handleCancelConnect = () => {
    if (pendingHostKeyRequestId) {
      void terminalBackend.respondHostKeyVerification(pendingHostKeyRequestId, false);
    }
    clearAutoReconnect();
    retryTokenRef.current = null;
    restoreCwdIntentRef.current = null;
    setIsCancelling(true);
    auth.setNeedsAuth(false);
    auth.setAuthRetryMessage(null);
    setNeedsHostKeyVerification(false);
    setPendingHostKeyInfo(null);
    setPendingHostKeyRequestId(null);
    setError("Connection cancelled");
    setProgressLogs((prev) => [...prev, "Cancelled by user."]);
    void cleanupSession();
    updateStatus("disconnected");
    setChainProgress(null);
    setTimeout(() => setIsCancelling(false), 600);
    onCloseSession?.(sessionId);
  };

  const handleDismissDisconnectedDialog = () => {
    setIsDisconnectedDialogDismissed(true);
    queueMicrotask(() => termRef.current?.focus());
  };

  const handleCloseDisconnectedSession = () => {
    clearAutoReconnect();
    retryTokenRef.current = null;
    restoreCwdIntentRef.current = null;
    onCloseSession?.(sessionId);
  };

  const handleHostKeyClose = () => {
    setNeedsHostKeyVerification(false);
    setPendingHostKeyInfo(null);
    setPendingHostKeyRequestId(null);
    handleCancelConnect();
  };

  const handleHostKeyContinue = () => {
    if (pendingHostKeyRequestId) {
      void terminalBackend.respondHostKeyVerification(pendingHostKeyRequestId, true, false);
    }
    setNeedsHostKeyVerification(false);
    if (pendingConnectionRef.current) {
      pendingConnectionRef.current();
      pendingConnectionRef.current = null;
    }
    setPendingHostKeyInfo(null);
    setPendingHostKeyRequestId(null);
  };

  const handleHostKeyAddAndContinue = () => {
    if (pendingHostKeyInfo && onAddKnownHost) {
      onAddKnownHost(createKnownHostFromHostKeyInfo(pendingHostKeyInfo, host));
    }
    if (pendingHostKeyRequestId) {
      void terminalBackend.respondHostKeyVerification(pendingHostKeyRequestId, true, true);
    }
    setNeedsHostKeyVerification(false);
    if (pendingConnectionRef.current) {
      pendingConnectionRef.current();
      pendingConnectionRef.current = null;
    }
    setPendingHostKeyInfo(null);
    setPendingHostKeyRequestId(null);
  };

  const startReconnect = async (mode: "manual" | "auto" = "manual") => {
    if (!termRef.current && hibernatedRef.current) {
      if (reconnectWakeInFlightRef.current) return;
      const wakeForReconnect = wakeHibernatedRuntimeForReconnectRef.current;
      if (!wakeForReconnect) {
        updateStatus("disconnected");
        return;
      }
      reconnectWakeInFlightRef.current = true;
      const wakeToken = Symbol();
      reconnectWakeTokenRef.current = wakeToken;
      updateStatus("connecting");
      void wakeForReconnect().then((woke) => {
        if (reconnectWakeTokenRef.current !== wakeToken) {
          disposeRuntimeOnly();
          return;
        }
        reconnectWakeTokenRef.current = null;
        reconnectWakeInFlightRef.current = false;
        if (woke) {
          startReconnectRef.current?.(mode);
          return;
        }
        updateStatus("disconnected");
      }).catch(() => {
        if (reconnectWakeTokenRef.current !== wakeToken) {
          disposeRuntimeOnly();
          return;
        }
        reconnectWakeTokenRef.current = null;
        reconnectWakeInFlightRef.current = false;
        updateStatus("disconnected");
      });
      return;
    }
    if (!termRef.current) return;
    if (mode === "manual") {
      clearAutoReconnect();
      prepareRestoredReconnect();
    } else {
      restoreCwdIntentRef.current = null;
      suppressHostStartupCommandRef.current = true;
    }
    // Claim the retry before awaiting close. A close/cancel/unmount during the
    // awaited backend cleanup invalidates this token and stops the continuation.
    const retryToken = Symbol("retry");
    retryTokenRef.current = retryToken;
    const retryTokenStillCurrent = () => retryTokenRef.current === retryToken;

    await cleanupSession();
    if (!retryTokenStillCurrent()) return;
    const term = termRef.current;
    if (!term) return;
    // closeSession wiped preload ready listeners; re-arm before startMosh so a
    // fast handshake cannot emit netcatty:mosh:ready into an empty map.
    prepareMoshReadySubscription();
    // Keep the same retry token through the queued writes. If the user cancels /
    // closes / unmounts / kicks off another retry while the chained writes are
    // queued, the token is invalidated and callbacks abort before opening a
    // ghost backend session with no owning UI.
    const retryStillActive = () => retryTokenStillCurrent() && termRef.current === term;

    isBootActiveRef.current = true;
    auth.resetForRetry();
    terminalDataCapturedRef.current = false;
    if (mode === "manual") {
      hasRunStartupCommandRef.current = false;
    }
    setIsDisconnectedDialogDismissed(false);
    setConnectionReuseFellBack(false);
    updateStatus("connecting");
    setError(null);
    setProgressLogs((prev) => (
      mode === "auto"
        ? [...prev, t("terminal.progress.autoReconnectAttempt", { attempt: autoReconnectAttemptRef.current })]
        : ["Retrying secure channel..."]
    ));
    setShowLogs(true);

    const startNewSession = () => {
      if (!retryStillActive()) return;
      if (host.protocol === "serial") {
        sessionStarters.startSerial(term);
      } else if (host.protocol === "local" || host.hostname === "localhost") {
        sessionStarters.startLocal(term);
      } else if (host.protocol === "telnet") {
        sessionStarters.startTelnet(term);
      } else if (host.moshEnabled) {
        // Defensive: xterm.write may fire after another cleanup raced us.
        prepareMoshReadySubscription();
        sessionStarters.startMosh(term);
      } else if (host.etEnabled) {
        sessionStarters.startEt(term);
      } else {
        sessionStarters.startSSH(term);
      }
    };

    // Chain the whole preparation through xterm.write callbacks so everything
    // lands in strict order — see #695. xterm.write is async, so without
    // chaining, a fast reconnect path (local/serial especially) can interleave
    // the new session's first bytes with our reset sequence, corrupting the
    // first screen.
    //
    // 1. Exit the alternate screen first. preserveTerminalViewportInScrollback
    //    is a no-op on the alt buffer (disconnect while in vim/less/top), so
    //    we must be on the normal buffer before preserving.
    term.write('\x1b[?1049l', () => {
      if (!retryStillActive()) return;
      // 2. Push the previous session's viewport into scrollback so the user
      //    can still read it after reconnect.
      preserveTerminalViewportInScrollback(term);
      // 3. Soft terminal reset (DECSTR, \x1b[!p) resets VT220-era modes that
      //    full-screen apps may have left on — DECCKM (otherwise arrow keys
      //    emit SS3 and break readline history), keypad mode, SGR,
      //    insert/replace, origin, cursor visibility — without clearing the
      //    buffer. DECSTR does not cover xterm-specific extensions, so also
      //    explicitly disable mouse tracking (1000/1002/1003/1006) and
      //    bracketed paste (2004). Finally home the cursor.
      term.write(
        '\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[H',
        // 4. Only now — after every prep byte has been applied to the
        //    terminal — start the new session, so its first output can't
        //    interleave with the reset sequence.
        startNewSession,
      );
    });
  };
  startReconnectRef.current = startReconnect;

  const handleRetry = () => {
    startReconnect("manual");
  };
  manualReconnectRequestRef.current = handleRetry;
  useEffect(() => terminalReconnectRegistry.register(
    sessionId,
    () => manualReconnectRequestRef.current(),
  ), [sessionId]);

  const shouldShowConnectionDialog = shouldShowTerminalConnectionDialog({
    status,
    isLocalConnection,
    isSerialConnection,
    isDisconnectedDialogDismissed,
    hideConnectingDialogForConnectionReuse: shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId,
      host,
      connectionReuseFellBack,
    }),
  });

  const {
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    isDraggingOver,
  } = useTerminalDragDrop({
    host,
    isLocalConnection,
    isNetworkDevice,
    onOpenSftp,
    resolveSftpInitialPath,
    scrollToBottomAfterProgrammaticInput,
    sessionId,
    sessionRef,
    status,
    t,
    terminalBackend,
    termRef,
  });

  useTerminalFilePaste({
    isLocalConnection,
    status,
    termRef,
    sessionRef,
    terminalBackend,
    scrollOnPasteRef,
    onPasteData: broadcastUserPasteData,
    scrollToBottomAfterProgrammaticInput,
    containerRef,
  });

  const handleToggleSessionLog = useCallback(async () => {
    const currentSessionId = sessionRef.current ?? sessionId;
    if (!currentSessionId) {
      toast.error("Session log bridge is unavailable");
      return;
    }

    try {
      const currentStatus = await getManualSessionLogStatus({ sessionId: currentSessionId });
      if (currentStatus?.isLogging) {
        const stopResult = await stopManualSessionLog({ sessionId: currentSessionId });
        if (stopResult?.success) {
          setIsSessionLogging(false);
        } else {
          toast.error(stopResult?.error || "Failed to stop session log");
        }
        return;
      }

      const startResult = await startManualSessionLog({
        sessionId: currentSessionId,
        sessionName: host.label || host.hostname || currentSessionId,
        preferredDirectory: sessionLog?.directory,
        initialLine: termRef.current ? getSessionLogInitialLine(termRef.current) : "",
      });
      if (startResult?.success) {
        if (!startResult?.started && startResult?.canceled) return;
        setIsSessionLogging(!!startResult?.started);
      } else {
        toast.error(startResult?.error || "Failed to start session log");
      }
    } catch (err) {
      logger.error("[Terminal] Failed to toggle manual session log:", err);
      toast.error("Failed to toggle session log");
    }
  }, [
    getManualSessionLogStatus,
    host.hostname,
    host.label,
    sessionId,
    sessionLog?.directory,
    startManualSessionLog,
    stopManualSessionLog,
  ]);

  useEffect(() => {
    const currentSessionId = sessionRef.current ?? sessionId;
    if (!currentSessionId) {
      setIsSessionLogging(false);
      return;
    }

    let cancelled = false;
    void getManualSessionLogStatus({ sessionId: currentSessionId }).then((result) => {
      if (!cancelled) setIsSessionLogging(!!result?.isLogging);
    }).catch(() => {
      if (!cancelled) setIsSessionLogging(false);
    });

    return () => {
      cancelled = true;
    };
  }, [getManualSessionLogStatus, sessionId, status]);

  const handleToolbarRecordingToggle = useCallback(() => {
    const recording = getScriptRecordingSnapshot();
    if (recording.sessionId && recording.sessionId !== sessionId) {
      toast.error(t('scripts.recording.alreadyActive'));
      return;
    }
    if (recording.sessionId === sessionId) {
      window.dispatchEvent(new CustomEvent('netcatty:script:recording:stop', { detail: { sessionId } }));
      return;
    }
    window.dispatchEvent(new CustomEvent('netcatty:script:recording:start', { detail: { sessionId } }));
  }, [sessionId, t]);

  const renderControls = useCallback((opts?: { showClose?: boolean }) => (
    <TerminalToolbar
      status={status}
      host={host}
      compactToolbar={compactToolbar}
      snippets={snippets}
      snippetPackages={snippetPackages}
      onSnippetClick={(snippet) => { void executeSnippet(snippet); }}
      onOpenSFTP={handleOpenSFTP}
      onSendYmodem={isSerialConnection ? handleSendYmodem : undefined}
      onReceiveYmodem={isSerialConnection ? handleReceiveYmodem : undefined}
      onOpenScripts={onOpenScripts ?? (() => {})}
      onOpenHistory={onOpenHistory}
      onOpenTheme={onOpenTheme ?? (() => {})}
      onConfigureOsc7={shouldOfferOsc7SetupAction({
        protocol: host.protocol,
        isLocalConnection,
        isSerialConnection,
        isNetworkDevice,
      }) ? () => setOsc7SetupOpen(true) : undefined}
      onUpdateHost={handleUpdateHostFromTerminal}
      showClose={opts?.showClose}
      // Workspace toolbar X closes/destroys this pane session. Detach to a
      // standalone tab remains a separate control (SquareArrowOutUpRight).
      onClose={() => onCloseSession?.(sessionId)}
      isSearchOpen={isSearchOpen}
      onToggleSearch={handleToggleSearch}
      showLogButton
      onToggleSessionLog={handleToggleSessionLog}
      isSessionLogging={isSessionLogging}
      isSessionLogDisabled={status !== "connected" && !isSessionLogging}
      isComposeBarOpen={inWorkspace ? isWorkspaceComposeBarOpen : isComposeBarOpen}
      onToggleComposeBar={inWorkspace ? onToggleComposeBar : () => setIsComposeBarOpen(prev => !prev)}
      terminalEncoding={terminalEncoding}
      onSetTerminalEncoding={handleSetTerminalEncoding}
      recordingIndicator={recorder.isRecording ? (
        <ScriptRecordingIndicator
          elapsedMs={recorder.elapsedMs}
          isPaused={recorder.isPaused}
          onPause={recorder.pauseRecording}
          onResume={recorder.resumeRecording}
          onStop={() => {
            void recorder.stopRecording().then(({ code }) => {
              setRecordedCode(code);
              setSaveRecordingOpen(true);
            });
          }}
        />
      ) : undefined}
      onStartRecording={status === 'connected' ? handleToolbarRecordingToggle : undefined}
    />
  ), [
    compactToolbar,
    executeSnippet,
    handleOpenSFTP,
    handleReceiveYmodem,
    handleSendYmodem,
    handleSetTerminalEncoding,
    handleToggleSessionLog,
    handleToggleSearch,
    handleToolbarRecordingToggle,
    host,
    inWorkspace,
    isLocalConnection,
    isNetworkDevice,
    isSerialConnection,
    isComposeBarOpen,
    isSearchOpen,
    isSessionLogging,
    isWorkspaceComposeBarOpen,
    onCloseSession,
    onOpenScripts,
    onOpenHistory,
    onOpenTheme,
    onToggleComposeBar,
    setIsComposeBarOpen,
    handleUpdateHostFromTerminal,
    sessionId,
    snippetPackages,
    snippets,
    status,
    terminalEncoding,
    recorder,
  ]);

  const terminalPreviewVars = useMemo(() => {
    const { background, foreground, cursor } = effectiveTheme.colors;
    return {
      ['--terminal-ui-bg' as never]: background,
      ['--terminal-ui-fg' as never]: foreground,
      ['--terminal-ui-border' as never]: `color-mix(in srgb, ${foreground} 8%, ${background} 92%)`,
      ['--terminal-ui-toolbar-btn' as never]: `color-mix(in srgb, ${background} 88%, ${foreground} 12%)`,
      ['--terminal-ui-toolbar-btn-hover' as never]: `color-mix(in srgb, ${background} 78%, ${foreground} 22%)`,
      ['--terminal-ui-toolbar-btn-active' as never]: `color-mix(in srgb, ${cursor} 78%, ${background} 22%)`,
    };
  }, [effectiveTheme.colors]);

  const effectiveComposeBarOpen = inWorkspace ? !!isWorkspaceComposeBarOpen : isComposeBarOpen;

  xTermRuntimeContextRef.current = {
    host,
    fontFamilyId,
    resolvedFontFamily,
    fontSize: effectiveFontSize,
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
    commandBufferRef,
    scriptRecorderRef: recorderRef,
    passwordPromptActiveRef,
    onOutputTriggerUserInputRef: noteOutputTriggerUserInputRef,
    promptLineBreakStateRef,
    sudoAutofillRef,
    requestSearchFocus,
    serialLocalEcho: serialConfig?.localEcho,
    serialLineMode: serialConfig?.lineMode,
    serialLineBufferRef,
    telnetLocalEchoRef,
    onTerminalLogData: captureTerminalLogData,
    onCwdChange: (cwd: string) => {
      terminalCwdTracker.setRendererCwd(cwd);
      knownCwdRef.current = cwd;
      onTerminalCwdChange?.(sessionId, cwd);
    },
    onTitleChange: (title: string | null) => {
      onTerminalTitleChange?.(sessionId, title);
    },
    onBell: () => {
      onTerminalBell?.(sessionId);
    },
    onOsc52ReadRequest: handleOsc52ReadRequest,
    onAutocompleteKeyEvent: (e: KeyboardEvent) => autocompleteKeyEventRef.current?.(e) ?? true,
    onAutocompleteInput: (data: string) => autocompleteInputRef.current?.(data),
    terminalContextActionsRef,
    isRestoringSelectionRef,
  };

  const safeFitRef = useRef(safeFit);
  safeFitRef.current = safeFit;

  const wakeSoftHiddenRuntime = useCallback(() => {
    if (!softHiddenRef.current) return;
    terminalHiddenRendererStore.clearSoftHidden(sessionId);
    softHiddenRef.current = false;
    xtermRuntimeRef.current?.ensureWebglRenderer();
    xtermRuntimeRef.current?.clearTextureAtlas();
    safeFitRef.current({ force: true });
  }, [sessionId]);

  const resumeRendererAfterCancelledHibernateUpgrade = useCallback(() => {
    if (hibernatedRef.current || softHiddenRef.current || !hasRuntimeRef.current) return;
    xtermRuntimeRef.current?.ensureWebglRenderer();
    xtermRuntimeRef.current?.clearTextureAtlas();
    safeFitRef.current({ force: true });
  }, []);

  useEffect(() => {
    return terminalHiddenRendererStore.subscribe(() => {
      if (!terminalHiddenRendererStore.consumeEvictionRequest(sessionId)) return;
      if (!softHiddenRef.current || hibernatedRef.current) return;
      // Resume the soft-hidden renderer before the asynchronous full-hibernate
      // upgrade. If the pane is revealed while the upgrade is draining output
      // or serializing, it then already has a live renderer instead of waiting
      // on the upgrade promise to settle.
      wakeSoftHiddenRuntime();
      void fullHibernateRuntime().then(
        (completed) => {
          if (!completed) resumeRendererAfterCancelledHibernateUpgrade();
        },
        (error) => {
          logger.error("[Terminal] Failed to upgrade soft-hidden runtime to hibernate", { sessionId, error });
          resumeRendererAfterCancelledHibernateUpgrade();
        },
      );
    });
  }, [fullHibernateRuntime, resumeRendererAfterCancelledHibernateUpgrade, sessionId, wakeSoftHiddenRuntime]);

  const wakeFromHibernateRuntime = useCallback((
    getPayload: () => TerminalHibernateWakePayload,
    options: { sessionConnected: boolean },
  ): boolean | Promise<boolean> => {
    if (wakeInProgressRef.current) {
      return wakePromiseRef.current ?? false;
    }
    if (hasRuntimeRef.current) {
      logger.warn("[Terminal] Wake skipped", {
        sessionId,
        hasRuntime: hasRuntimeRef.current,
      });
      return false;
    }
    const container = containerRef.current;
    const runtimeContext = xTermRuntimeContextRef.current;
    if (!container || !runtimeContext) {
      logger.warn("[Terminal] Wake skipped: missing mount prerequisites", {
        sessionId,
        hasContainer: !!container,
        hasRuntimeContext: !!runtimeContext,
      });
      return false;
    }
    if (options.sessionConnected && !sessionRef.current) {
      logger.warn("[Terminal] Wake skipped: missing backend session", { sessionId });
      return false;
    }

    wakeInProgressRef.current = true;
    setPasswordPickerState(null);

    const stopHibernateListeners = () => {
      const backendId = sessionRef.current;
      disposeDataRef.current?.();
      disposeDataRef.current = null;
      disposeExitRef.current?.();
      disposeExitRef.current = null;
      if (backendId) {
        flushTerminalSessionFlowAck(backendId);
        clearTerminalSessionFlowAck(backendId);
        terminalBackend.setSessionFlowPaused?.(backendId, false);
      }
    };

    const wakePromise = wakeTerminalFromHibernate({
      refs: terminalRuntimeRefs,
      runtimeContext,
      container,
      getPayload,
      stopHibernateListeners,
      sessionConnected: options.sessionConnected,
      getSessionConnected: () => getSessionConnectedRef.current(),
      reattachSession: (term) => {
        sessionStartersRef.current?.reattachSession(term);
      },
      safeFit: (...args) => safeFitRef.current(...args),
      resizeSession,
      forceSyncRenderAfterResize,
      lastFittedSizeRef,
      isBootActiveRef,
      sessionId,
      updateStatus: (next) => updateStatusRef.current(next),
      replayChunkBytes: resolveTerminalHibernateReplayChunkBytes(terminalSettings),
    }).then((ok) => ok).catch((err) => {
      logger.error("[Terminal] Failed to resume from hibernate", err);
      return false;
    }).finally(() => {
      wakeInProgressRef.current = false;
      if (wakePromiseRef.current === wakePromise) {
        wakePromiseRef.current = null;
      }
    });
    wakePromiseRef.current = wakePromise;
    return wakePromise;
  }, [sessionId, terminalBackend, terminalRuntimeRefs, resizeSession, terminalSettings]);

  wakeHibernatedRuntimeForReconnectRef.current = async () => {
    if (!hibernatedRef.current) {
      return Boolean(termRef.current);
    }

    const getPayload = (): TerminalHibernateWakePayload => ({
      snapshot: hibernateSnapshotRef.current,
      viewportSnapshot: hibernateViewportSnapshotRef.current || hibernateSnapshotRef.current,
      scrollbackSnapshot: hibernateScrollbackSnapshotRef.current,
      pendingBuffer: hibernatePendingBufferRef.current,
      alternateScreen: hibernateAlternateScreenRef.current,
    });

    logger.info("[Terminal] Waking hibernated runtime for reconnect", {
      sessionId,
      snapshotChars: hibernateSnapshotRef.current.length,
      viewportChars: hibernateViewportSnapshotRef.current.length,
      scrollbackChars: hibernateScrollbackSnapshotRef.current.length,
      pendingChars: hibernatePendingBufferRef.current.length,
    });

    const accepted = await Promise.resolve(wakeFromHibernateRuntime(getPayload, { sessionConnected: false }));
    if (accepted === false || !termRef.current) {
      return false;
    }

    clearHibernateRuntimeState();
    return true;
  };

  const hibernateFileTransferActive = isTerminalFileTransferActive({
    zmodemActive: zmodem.active,
    ymodemInProgress,
    isDraggingOver,
  });
  hibernateFileTransferActiveRef.current = hibernateFileTransferActive;

  useTerminalHibernateEffect({
    sessionId,
    isVisible,
    isVisibleRef,
    getSessionConnectedRef,
    status,
    isSearchOpen,
    hibernateEnabled: hibernateEnabled,
    hibernateDelayMs: resolveTerminalHibernateDelayMs(terminalSettings),
    fileTransferActive: hibernateFileTransferActive,
    hibernatedRef,
    softHiddenRef,
    hibernatePendingBufferRef,
    hibernateSnapshotRef,
    hibernateViewportSnapshotRef,
    hibernateScrollbackSnapshotRef,
    hibernateContextSnapshotRef,
    hibernateContextViewportSnapshotRef,
    hibernateContextScrollbackSnapshotRef,
    hibernateAlternateScreenRef,
    hasRuntimeRef,
    onHibernate: hibernateRuntime,
    onSoftHideWake: wakeSoftHiddenRuntime,
    onWake: wakeFromHibernateRuntime,
  });

  useTerminalEffects({ CONNECTION_TIMEOUT, Error, XTERM_PERFORMANCE_CONFIG, applyUserCursorPreference, auth, autocompleteCloseRef, autocompleteInputRef, autocompleteKeyEventRef, captureTerminalLogData, chainHosts: resolvedChainHosts, chainProgress, clearTerminalCwd, commandBufferRef, connectionLogBufferRef, containerRef, createPromptLineBreakState, createReplaySafeTerminalLogSanitizer, createXTermRuntime, deferTerminalResizeRef, disableTerminalFontZoomRef, effectiveFontSize, effectiveFontWeight, effectiveTheme, error, executeSnippetCommand, finalizeTerminalLogData, fitAddonRef, fontFamilyId, fontSize, fontWeightFixupDoneRef, forceCloseHibernatedSession, forceSyncRenderAfterResize, handleOsc52ReadRequest, handleTerminalDataCaptureOnce, hasConnectedRef, hasRuntimeRef, host, hotkeySchemeRef, hibernatedRef, identities, inWorkspace, isBootActiveRef, isBroadcastEnabledRef, isComposeBarOpen: effectiveComposeBarOpen, isConnectionAwaitingUserInput, isConnectionPastTcpDial, isFocusMode, isFocused, isLocalConnection, isNetworkDevice, isResizing: deferTerminalResize, isRestoringSelectionRef, isSearchOpen, isSerialConnection, isVisible, isVisibleRef, keyBindingsRef, keys, knownCwdRef, lastFittedSizeRef, lastToastedErrorRef, logger, mouseTrackingRef, needsHostKeyVerification, onBroadcastInputRef, onBroadcastInterruptPriorityChange, onCommandExecuted, onCommandSubmitted, onHotkeyActionRef, onOutputTriggerUserInputRef: noteOutputTriggerUserInputRef, onSnippetShortkeyRef, onSnippetExecutorChange, onTerminalCwdChange, onTerminalTitleChange, onTerminalBell, onTerminalFontSizeChange, paneLayoutKey, passwordPromptActiveRef, pendingAuthRef, pendingOutputScrollRef, prepareRestoredReconnect, prevIsResizingRef, promptLineBreakStateRef, resizeSession, resolveHostAuth, resolvedFontFamily, safeFit, scriptRecorderRef: recorderRef, searchAddonRef, serialConfig, serialLineBufferRef, serializeAddonRef, sessionId, sessionRef, sessionStarters, setError, setHasMouseTracking, setHasSelection, setIsCancelling, setIsDisconnectedDialogDismissed, requestSearchFocus, setNeedsHostKeyVerification, setPendingHostKeyInfo, setPendingHostKeyRequestId, setProgressLogs, setProgressValue, setSelectionOverlayPosition, setShowLogs, setStatus, setTimeLeft, shouldEnableNativeUserInputAutoScroll, shouldProbeSessionCwd, shouldStartTerminalBackend, snippetsRef, splitResizeActive: isResizing, status, statusRef, sudoAutofillRef, t, teardown, telnetLocalEchoRef, termRef, terminalAltKeyOptions, terminalBackend, terminalContextActionsRef, terminalCwdTracker, terminalDataCapturedRef, terminalLogSanitizerRef, terminalSettings, terminalSettingsRef, toHostKeyInfo, toast, updateStatus, useEffect, useLayoutEffect, xtermRuntimeRef, zmodem, zmodemToastedRef, restoreState });

  return (
    <>
      <TerminalView ctx={{ Activity, ArrowDownToLine, ArrowUpFromLine, Button, Clock3, Copy, Cpu, HardDrive, HoverCard, HoverCardContent, HoverCardTrigger, Maximize2, MemoryStick, Radio, Sparkles, SquareArrowOutUpRight, TerminalAutocomplete, TerminalComposeBar, TerminalConnectionDialog, TerminalContextMenu, TerminalSearchBar, Tooltip, TooltipContent, TooltipTrigger, ZmodemOverwriteDialog, ZmodemProgressIndicator, auth, autocompleteAcceptTextRef, autocompleteCloseRef, autocompleteHostOs, autocompleteInputRef, autocompleteKeyEventRef, autocompleteRepositionRef, autocompleteSettings, chainProgress, cn, compactToolbar, lineTimestampsAvailable, containerRef, effectiveFontSize, effectiveFontWeight, effectiveTheme, error, executeSnippet, executeSnippetCommand, handleAddSelectionToAI, handleCancelConnect, handleCloseDisconnectedSession, handleCloseSearch, handleDismissDisconnectedDialog, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleFindNext, handleFindPrevious, handleHostKeyAddAndContinue, handleHostKeyClose, handleHostKeyContinue, handleOsc52ReadResponse, handleOsc7SetupConfirm, handleOsc7SetupOpenChange, handleReceiveYmodem, handleRetry, handleSearch, handleSendYmodem, handleTopOverlayMouseDownCapture, hasMouseTracking, hasSelection, host, hotkeyScheme, inWorkspace, isBroadcastEnabled, isCancelling, isComposeBarOpen: effectiveComposeBarOpen, isConnectionAwaitingUserInput, isDraggingOver, isFocusMode, isLocalConnection, remoteDragDropUsesZmodem, isSerialConnection, isSearchOpen, isSupportedOs, isSystemSidebarEligible, isVisible, keyBindings, keys, knownCwdRef, needsHostKeyVerification, onAddSelectionToAI, onBroadcastInput, onCloseSession, onDetach, onDetachDragEnd, onDetachDragStart, onDetachPointerDown, onEndSessionDrag, onExpandToFocus, onOpenSystem, onRename, onSplitHorizontal, onSplitVertical, onStartSessionDrag, onToggleBroadcast, onUpdateHost: handleUpdateHostFromTerminal, osc52ReadPromptVisible, osc7SetupOpen, osc7SetupRunning, pendingHostKeyInfo, progressLogs, progressValue, renderControls, resolvedFontFamily, restoreState, scrollToBottomAfterProgrammaticInput, searchMatchCount, searchFocusToken, scriptExecutionOverlay: activeScriptRun ? (
        <ScriptExecutionOverlay
          run={activeScriptRun}
          onPause={() => { void pauseScriptRun(activeScriptRun.runId); }}
          onResume={() => { void resumeScriptRun(activeScriptRun.runId); }}
          onStop={() => { void stopScriptRun(activeScriptRun.runId); }}
          onDismiss={dismissScriptOverlay}
          compactTopChrome={terminalSettings?.showHostInfoBar === false}
        />
      ) : null, selectionOverlayPosition, sessionDisplayName, sessionId, sessionRef, setIsComposeBarOpen, setShowLogs, shouldShowConnectionDialog, showLogs, showSelectionAIAction, snippets, status, sudoHintRef, sudoHintText, passwordPickerState, onPasswordPickerSelect: handlePasswordPickerSelect, passwordPickerTitle, passwordPickerEmptyText, t, termRef, terminalBackend, terminalContextActions, terminalCwdTracker, terminalPreviewVars, terminalSettings, timeLeft, toast, zmodem }} />
      <ScriptSaveRecordingDialog
        open={saveRecordingOpen}
        code={recordedCode}
        packages={snippetPackages}
        defaultName={`recorded-${new Date().toISOString().slice(0, 10)}`}
        onClose={() => setSaveRecordingOpen(false)}
        onSave={({ name, packagePath, code, editAfterSave }) => {
          window.dispatchEvent(new CustomEvent('netcatty:scripts:save-recorded', {
            detail: { name, packagePath, code, editAfterSave },
          }));
          setSaveRecordingOpen(false);
        }}
      />
    </>
  );
};

const Terminal = memo(TerminalComponent, terminalPropsAreEqual);
Terminal.displayName = "Terminal";

export default Terminal;
