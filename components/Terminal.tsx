import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Cpu, Copy, HardDrive, Maximize2, MemoryStick, Radio, ArrowDownToLine, ArrowUpFromLine, Sparkles } from "lucide-react";
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
  shouldEnableNativeUserInputAutoScroll,
  shouldScrollOnTerminalInput,
} from "../domain/terminalScroll";
import {
  applyCustomAccentToTerminalTheme,
  resolveHostTerminalThemeId,
} from "../domain/terminalAppearance";
import { classifyDistroId, shouldProbeSessionCwd } from "../domain/host";
import { resolveHostAuth } from "../domain/sshAuth";
import { useTerminalBackend } from "../application/state/useTerminalBackend";
import { useTerminalLayoutSuppressActive } from "../application/state/terminalLayoutSuppressStore";
// SFTPModal removed - SFTP is now handled by SftpSidePanel in TerminalLayer
import { Button } from "./ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { toast } from "./ui/toast";
import { useAvailableFonts } from "../application/state/fontStore";
import { composeFontFamilyStack, type SupportedPlatform } from "../infrastructure/config/cjkFonts";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import { useCustomThemes } from "../application/state/customThemeStore";

import { TerminalConnectionDialog } from "./terminal/TerminalConnectionDialog";
import { HostKeyInfo } from "./terminal/TerminalHostKeyVerification";
import { createKnownHostFromHostKeyInfo, toHostKeyInfo } from "./terminal/hostKeyVerification";
import { TerminalToolbar } from "./terminal/TerminalToolbar";
import { TerminalComposeBar } from "./terminal/TerminalComposeBar";
import { TerminalContextMenu } from "./terminal/TerminalContextMenu";
import { TerminalSearchBar } from "./terminal/TerminalSearchBar";
import { ZmodemOverwriteDialog } from "./terminal/ZmodemOverwriteDialog";
import { ZmodemProgressIndicator } from "./terminal/ZmodemProgressIndicator";
import { createReplaySafeTerminalLogSanitizer } from "./terminal/replaySafeTerminalLog";
import { createConnectionLogBuffer } from "./terminal/connectionLogBuffer";
import { useZmodemTransfer } from "./terminal/hooks/useZmodemTransfer";
import { createTerminalSessionStarters, type PendingAuth } from "./terminal/runtime/createTerminalSessionStarters";
import { createXTermRuntime, type XTermRuntime } from "./terminal/runtime/createXTermRuntime";
import { applyUserCursorPreference } from "./terminal/runtime/cursorPreference";
import { terminalAltKeyOptions } from "./terminal/runtime/altKeyOptions";
import {
  createPromptLineBreakState,
  type PromptLineBreakState,
} from "./terminal/runtime/promptLineBreak";
import {
  prepareSudoAutofillInput,
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
import { TerminalAutocomplete } from "./terminal/TerminalAutocomplete";
import { createTerminalCwdTracker, resolvePreferredTerminalCwd } from "./terminal/sftpCwd";
import { useTerminalEffects } from "./terminal/useTerminalEffects";
import { TerminalView } from "./terminal/TerminalView";
import {
  forceSyncRenderAfterResize,
  MAX_CONNECTION_LOG_DATA_CHARS,
  shouldHideConnectingDialogForConnectionReuse,
  shouldShowTerminalConnectionDialog,
  type TerminalProps,
} from "./terminal/terminalHelpers";
import { terminalPropsAreEqual } from "./terminal/terminalMemo";

const TerminalComponent: React.FC<TerminalProps> = ({
  host,
  keys,
  identities,
  snippets,
  chainHosts = [],
  themePreviewId,
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
  startupCommand,
  noAutoRun,
  reuseConnectionFromSessionId,
  serialConfig,
  hotkeyScheme = "disabled",
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
  onOpenScripts,
  onOpenTheme,
  isBroadcastEnabled,
  onToggleBroadcast,
  onToggleComposeBar,
  isWorkspaceComposeBarOpen,
  onBroadcastInput,
  onSnippetExecutorChange,
  sessionLog,
  sshDebugLogEnabled,
  sudoAutofillPassword,
  onAddSelectionToAI,
}) => {
  const layoutSuppressActive = useTerminalLayoutSuppressActive();
  const deferTerminalResize = isResizing || layoutSuppressActive;

  // Timeout for connection - increased to 120s to allow time for keyboard-interactive (2FA) authentication
  const CONNECTION_TIMEOUT = 120000;
  const { t } = useI18n();
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
  const sessionRef = useRef<string | null>(null);
  const isBootActiveRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const hasRunStartupCommandRef = useRef(false);
  // Token for an in-flight retry chain. handleRetry sets this to a fresh
  // symbol; any cancel/close/teardown/subsequent-retry invalidates it. The
  // chained xterm.write callbacks verify the token before proceeding so a
  // cancelled retry can't fire a startNewSession after the fact.
  const retryTokenRef = useRef<symbol | null>(null);
  const terminalDataCapturedRef = useRef(false);
  const connectionLogBufferRef = useRef(createConnectionLogBuffer(MAX_CONNECTION_LOG_DATA_CHARS));
  const terminalLogSanitizerRef = useRef(createReplaySafeTerminalLogSanitizer());
  const onTerminalDataCaptureRef = useRef(onTerminalDataCapture);
  const commandBufferRef = useRef<string>("");
  const promptLineBreakStateRef = useRef<PromptLineBreakState>(createPromptLineBreakState());
  const [hasMouseTracking, setHasMouseTracking] = useState(false);
  const mouseTrackingRef = useRef(false);
  const serialLineBufferRef = useRef<string>("");

  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;
  onTerminalDataCaptureRef.current = onTerminalDataCapture;
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const pendingOutputScrollRef = useRef(false);
  const lastFittedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const fontWeightFixupDoneRef = useRef(false);

  const captureTerminalLogData = useCallback((data: string) => {
    const replaySafeData = terminalLogSanitizerRef.current.append(data);
    if (!replaySafeData) return;
    connectionLogBufferRef.current.append(replaySafeData);
  }, []);

  const finalizeTerminalLogData = useCallback(() => {
    const replaySafeData = terminalLogSanitizerRef.current.finish();
    if (replaySafeData) {
      connectionLogBufferRef.current.append(replaySafeData);
    }
    return connectionLogBufferRef.current.toString();
  }, []);

  const writeLocalTerminalData = useCallback((data: string) => {
    if (!data) return;
    captureTerminalLogData(data);
    termRef.current?.write(data);
  }, [captureTerminalLogData]);

  const hotkeySchemeRef = useRef(hotkeyScheme);
  const keyBindingsRef = useRef(keyBindings);
  const onHotkeyActionRef = useRef(onHotkeyAction);
  hotkeySchemeRef.current = hotkeyScheme;
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
  const { resizeSession, setSessionEncoding } = terminalBackend;



  // isScriptsOpen state removed - scripts now handled by side panel
  const [status, setStatus] = useState<TerminalSession["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const lastToastedErrorRef = useRef<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [timeLeft, setTimeLeft] = useState(CONNECTION_TIMEOUT / 1000);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showSFTP, setShowSFTP] = useState(false);
  const [progressValue, setProgressValue] = useState(15);
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionOverlayPosition, setSelectionOverlayPosition] = useState<{ left: number; top: number } | null>(null);
  const [isDisconnectedDialogDismissed, setIsDisconnectedDialogDismissed] = useState(false);
  const [connectionReuseFellBack, setConnectionReuseFellBack] = useState(false);

  const statusRef = useRef<TerminalSession["status"]>(status);
  statusRef.current = status;
  const sudoAutofillRef = useRef<SudoPasswordAutofill | null>(null);
  const sudoAutofillPasswordRef = useRef(sudoAutofillPassword);
  sudoAutofillPasswordRef.current = sudoAutofillPassword;

  const [chainProgress, setChainProgress] = useState<{
    currentHop: number;
    totalHops: number;
    currentHostLabel: string;
  } | null>(null);

  // pendingUploadEntries removed - drag-drop uploads now handled by SftpSidePanel
  const [isComposeBarOpen, setIsComposeBarOpen] = useState(false);
  const [terminalEncoding, setTerminalEncoding] = useState<'utf-8' | 'gb18030'>(() => {
    if (host?.charset && /^gb/i.test(String(host.charset).trim())) return 'gb18030';
    return 'utf-8';
  });
  const terminalEncodingRef = useRef(terminalEncoding);
  terminalEncodingRef.current = terminalEncoding;
  // True only after the user actively picks an encoding from the toolbar.
  // onSessionAttached uses this to decide whether to override the backend's
  // initial charset for telnet/serial reconnects — on a first attach we
  // must not overwrite arbitrary host.charset values (latin1/shift_jis/...)
  // that the UI's two-value state can't represent.
  const userPickedEncodingRef = useRef(false);

  const terminalSearch = useTerminalSearch({ searchAddonRef, termRef });
  const {
    isSearchOpen,
    setIsSearchOpen,
    searchMatchCount,
    handleToggleSearch,
    handleSearch,
    handleFindNext,
    handleFindPrevious,
    handleCloseSearch,
  } = terminalSearch;

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
        } else if (ch === "\b" || ch === "\x7f") {
          // Backspace: remove last character (Windows fuzzy replacement uses \b)
          commandBufferRef.current = commandBufferRef.current.slice(0, -1);
        } else if (ch.charCodeAt(0) >= 32) {
          commandBufferRef.current += ch;
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
  const autocompleteSettings = terminalSettings ? {
    enabled: terminalSettings.autocompleteEnabled ?? true,
    showGhostText: terminalSettings.autocompleteGhostText ?? true,
    showPopupMenu: terminalSettings.autocompletePopupMenu ?? true,
    debounceMs: terminalSettings.autocompleteDebounceMs ?? 100,
    minChars: terminalSettings.autocompleteMinChars ?? 1,
    maxSuggestions: terminalSettings.autocompleteMaxSuggestions ?? 8,
  } : undefined;

  const resolveSftpInitialPath = useCallback(async (options?: { preferFreshBackend?: boolean }): Promise<string | undefined> => {
    const cwd = await resolvePreferredTerminalCwd({
      rendererCwd: terminalCwdTracker.getRendererCwd(),
      sessionId: sessionRef.current,
      getSessionPwd: (id, options) => terminalBackend.getSessionPwd(id, options),
      preferFreshBackend: options?.preferFreshBackend,
    });
    return cwd ?? undefined;
  }, [terminalBackend, terminalCwdTracker]);

  const clearTerminalCwd = useCallback(() => {
    terminalCwdTracker.clearRendererCwd();
    knownCwdRef.current = undefined;
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

  // Check if this is a local or serial connection (doesn't need connection dialog during connecting)
  const isLocalConnection = host.protocol === "local";
  const isSerialConnection = host.protocol === "serial";

  // Server stats (CPU, Memory, Disk) — only for Linux/macOS, never for
  // network devices. See isNetworkDevice above for why the gating uses the
  // raw detected distro / explicit deviceType (not getEffectiveHostDistro);
  // #674 covers the AAA-log-flood motivation for stats specifically.
  const isSupportedOs =
    !isNetworkDevice &&
    (host.os === 'linux' || host.os === 'macos' || detectedDeviceClass === 'linux-like');
  // Server-stats polling now lives inside <TerminalServerStats> (rendered by
  // TerminalView) so its ~5s refresh only re-renders that widget, not the whole
  // terminal. We just forward `isSupportedOs` via ctx.

  const zmodem = useZmodemTransfer(sessionId);

  const zmodemToastedRef = useRef(false);

  const pendingAuthRef = useRef<PendingAuth>(null);
  useEffect(() => {
    sudoAutofillRef.current?.updatePassword(sudoAutofillPassword);
  }, [sudoAutofillPassword]);
  const sessionStartersRef = useRef<ReturnType<typeof createTerminalSessionStarters> | null>(null);
  const auth = useTerminalAuthState({
    host,
    pendingAuthRef,
    termRef,
    onUpdateHost,
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
    const resolvedFontId = hostFontId || "menlo";
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
    // When "Follow Application Theme" is on and there's no active
    // preview, skip per-host overrides — all terminals should use the
    // UI-matched theme passed via terminalTheme prop.
    if (followAppTerminalTheme && !themePreviewId) {
      return applyCustomAccentToTerminalTheme(terminalTheme, accentMode, customAccent);
    }
    const themeId = themePreviewId ?? resolveHostTerminalThemeId(
      { theme: host.theme, themeOverride: host.themeOverride } as Pick<Host, 'theme' | 'themeOverride'>,
      terminalTheme.id,
    );
    let baseTheme = terminalTheme;
    if (themeId) {
      const hostTheme = TERMINAL_THEMES.find((t) => t.id === themeId)
        || customThemes.find((t) => t.id === themeId);
      if (hostTheme) baseTheme = hostTheme;
    }
    return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
  }, [accentMode, customAccent, customThemes, followAppTerminalTheme, host.theme, host.themeOverride, terminalTheme, themePreviewId]);

  const resolvedChainHosts =
    chainHosts;

  const updateStatus = (next: TerminalSession["status"]) => {
    setStatus(next);
    hasConnectedRef.current = next === "connected";
    onStatusChange?.(sessionId, next);
  };

  const handleTerminalDataCaptureOnce = useCallback((capturedSessionId: string, data: string) => {
    const captureHandler = onTerminalDataCaptureRef.current;
    if (!captureHandler || terminalDataCapturedRef.current) return;
    terminalDataCapturedRef.current = true;
    const replaySafeLogData = finalizeTerminalLogData();
    const capturedData = replaySafeLogData || data;
    captureHandler(capturedSessionId, capturedData);
  }, [finalizeTerminalLogData]);

  const cleanupSession = () => {
    disposeDataRef.current?.();
    disposeDataRef.current = null;
    disposeExitRef.current?.();
    disposeExitRef.current = null;

    if (sessionRef.current) {
      try {
        terminalBackend.closeSession(sessionRef.current);
      } catch (err) {
        logger.warn("Failed to close SSH session", err);
      }
    }
    sessionRef.current = null;
  };

  const teardown = () => {
    isBootActiveRef.current = false;
    retryTokenRef.current = null;
    cleanupSession();
    xtermRuntimeRef.current?.dispose();
    xtermRuntimeRef.current = null;
    termRef.current = null;
    fitAddonRef.current = null;
    serializeAddonRef.current = null;
    searchAddonRef.current = null;
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
    terminalSettings,
    terminalSettingsRef,
    terminalBackend,
    serialConfig,
    isVisibleRef,
    isBootActiveRef,
    pendingOutputScrollRef,
    sessionRef,
    hasConnectedRef,
    hasRunStartupCommandRef,
    disposeDataRef,
    disposeExitRef,
    fitAddonRef,
    serializeAddonRef,
    pendingAuthRef,
    promptLineBreakStateRef,
    sudoAutofillRef,
    onSudoHint: (active: boolean) => sudoHintRef.current?.(active) ?? false,
    updateStatus,
    setStatus,
    setError,
    setNeedsAuth: auth.setNeedsAuth,
    setAuthRetryMessage: auth.setAuthRetryMessage,
    setAuthPassword: auth.setAuthPassword,
    setProgressLogs,
    setProgressValue,
    setChainProgress,
    t,
    onSessionAttached: (id: string) => {
      clearTerminalCwd();
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
      if (isSSH) {
        setSessionEncoding(id, terminalEncodingRef.current);
        return;
      }
      // Telnet / serial: the backend already applied host.charset
      // (including arbitrary iconv labels like latin1 / shift_jis that
      // the UI's two-value state can't represent) through start*Session
      // options, so don't clobber it on first attach. Only re-sync once
      // the user has explicitly picked from the toolbar menu — that's
      // the signal they want the UI choice to win on reconnect.
      if ((isTelnet || isSerial) && userPickedEncodingRef.current) {
        setSessionEncoding(id, terminalEncodingRef.current);
      }
    },
    onSessionExit: (closedSessionId, evt) => {
      clearTerminalCwd();
      onSessionExit?.(closedSessionId, evt);
    },
    onTerminalDataCapture: handleTerminalDataCaptureOnce,
    onTerminalLogData: captureTerminalLogData,
    onOsDetected,
    onCommandExecuted,
    sessionLog,
    sshDebugLogEnabled,
    sudoAutofillPassword,
    sudoAutofillPasswordRef,
  });
  sessionStartersRef.current = sessionStarters;

  useEffect(() => {
    setConnectionReuseFellBack(false);
    if (!reuseConnectionFromSessionId) return undefined;

    return terminalBackend.onConnectionReuseFallback?.((fallbackSessionId) => {
      if (fallbackSessionId === sessionId) {
        setConnectionReuseFellBack(true);
      }
    });
  }, [reuseConnectionFromSessionId, sessionId, terminalBackend]);

  const safeFit = (options?: { force?: boolean; requireVisible?: boolean }) => {
    const fitAddon = fitAddonRef.current;
    if (!fitAddon) return;
    if (options?.requireVisible && !isVisibleRef.current) return;

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
        }
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
      typeof requestAnimationFrame === "function"
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

  const scrollToBottomAfterProgrammaticInput = useCallback((data: string) => {
    if (termRef.current && shouldScrollOnTerminalInput(terminalSettingsRef.current, data)) {
      termRef.current.scrollToBottom();
    }
  }, []);

  const executeSnippetCommand = useCallback((
    command: string,
    noAutoRun?: boolean,
    options?: { broadcast?: boolean },
  ) => {
    const term = termRef.current;
    const id = sessionRef.current;
    if (!term || !id) return;

    let data = normalizeLineEndings(command);
    const isMultiLine = data.includes('\n');
    // Wrap in bracketed paste BEFORE appending \r so the Enter is sent
    // outside the paste markers — otherwise shells treat it as pasted text
    // instead of a submit action.
    if (isMultiLine && term.modes.bracketedPasteMode && !disableBracketedPasteRef.current) {
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
      onBroadcastInputRef.current(data, sessionId);
    }

    data = prepareProgrammaticSudoInput(data);
    terminalBackend.writeToSession(id, data);
    scrollToBottomAfterProgrammaticInput(data);
    term.focus();
  }, [prepareProgrammaticSudoInput, scrollToBottomAfterProgrammaticInput, terminalBackend, sessionId]);

  const executeSnippet = useCallback(async (snippet: Snippet) => {
    const command = await resolveSnippetCommand(snippet);
    if (command === null) return;
    executeSnippetCommand(command, snippet.noAutoRun);
  }, [executeSnippetCommand]);

  const onSnippetShortkeyRef = useRef(executeSnippet);
  onSnippetShortkeyRef.current = executeSnippet;

  const terminalContextActions = useTerminalContextActions({
    termRef,
    sourceSessionId: sessionId,
    sessionRef,
    onHasSelectionChange: setHasSelection,
    scrollOnPasteRef,
    isBroadcastEnabledRef,
    onBroadcastInputRef,
    isLocalConnection,
    terminalBackend,
  });
  // Kept fresh on every render so the mouseTracking capture handler at
  // handleContextMenuCapture (which is bound once per sessionId) can
  // still invoke the latest paste / select-word callbacks without
  // re-binding on every action identity change. See #941.
  const terminalContextActionsRef = useRef(terminalContextActions);
  terminalContextActionsRef.current = terminalContextActions;

  const handleAddSelectionToAI = useCallback(() => {
    const selection = termRef.current?.getSelection() ?? "";
    if (!selection.trim()) return;
    onAddSelectionToAI?.(sessionId, selection);
  }, [onAddSelectionToAI, sessionId]);

  const handleSetTerminalEncoding = useCallback((encoding: 'utf-8' | 'gb18030') => {
    setTerminalEncoding(encoding);
    userPickedEncodingRef.current = true;
    if (sessionRef.current) {
      setSessionEncoding(sessionRef.current, encoding);
    }
  }, [setSessionEncoding]);

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

  const handleCancelConnect = () => {
    if (pendingHostKeyRequestId) {
      void terminalBackend.respondHostKeyVerification(pendingHostKeyRequestId, false);
    }
    retryTokenRef.current = null;
    setIsCancelling(true);
    auth.setNeedsAuth(false);
    auth.setAuthRetryMessage(null);
    setNeedsHostKeyVerification(false);
    setPendingHostKeyInfo(null);
    setPendingHostKeyRequestId(null);
    setError("Connection cancelled");
    setProgressLogs((prev) => [...prev, "Cancelled by user."]);
    cleanupSession();
    updateStatus("disconnected");
    setChainProgress(null);
    setTimeout(() => setIsCancelling(false), 600);
    onCloseSession?.(sessionId);
  };

  const handleDismissDisconnectedDialog = () => {
    setIsDisconnectedDialogDismissed(true);
  };

  const handleCloseDisconnectedSession = () => {
    retryTokenRef.current = null;
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

  const handleRetry = () => {
    if (!termRef.current) return;
    cleanupSession();
    const term = termRef.current;
    // Claim a fresh retry token. If the user cancels / closes / unmounts /
    // kicks off another retry while the chained writes below are still
    // queued, the token will be invalidated and our callbacks will abort
    // before opening a ghost backend session with no owning UI.
    const retryToken = Symbol("retry");
    retryTokenRef.current = retryToken;
    const retryStillActive = () => retryTokenRef.current === retryToken && termRef.current === term;

    auth.resetForRetry();
    terminalDataCapturedRef.current = false;
    hasRunStartupCommandRef.current = false;
    setIsDisconnectedDialogDismissed(false);
    setConnectionReuseFellBack(false);
    setStatus("connecting");
    setError(null);
    setProgressLogs(["Retrying secure channel..."]);
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
    scrollToBottomAfterProgrammaticInput,
    containerRef,
  });

  const renderControls = useCallback((opts?: { showClose?: boolean }) => (
    <TerminalToolbar
      status={status}
      host={host}
      onOpenSFTP={handleOpenSFTP}
      onOpenScripts={onOpenScripts ?? (() => {})}
      onOpenTheme={onOpenTheme ?? (() => {})}
      onUpdateHost={onUpdateHost}
      showClose={opts?.showClose}
      onClose={() => onCloseSession?.(sessionId)}
      isSearchOpen={isSearchOpen}
      onToggleSearch={handleToggleSearch}
      isComposeBarOpen={inWorkspace ? isWorkspaceComposeBarOpen : isComposeBarOpen}
      onToggleComposeBar={inWorkspace ? onToggleComposeBar : () => setIsComposeBarOpen(prev => !prev)}
      terminalEncoding={terminalEncoding}
      onSetTerminalEncoding={handleSetTerminalEncoding}
    />
  ), [
    handleOpenSFTP,
    handleSetTerminalEncoding,
    handleToggleSearch,
    host,
    inWorkspace,
    isComposeBarOpen,
    isSearchOpen,
    isWorkspaceComposeBarOpen,
    onCloseSession,
    onOpenScripts,
    onOpenTheme,
    onToggleComposeBar,
    onUpdateHost,
    sessionId,
    status,
    terminalEncoding,
  ]);

  const statusDotTone =
    status === "connected"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : "bg-rose-500";
  const terminalPreviewVars = useMemo(() => ({
    ['--terminal-ui-bg' as never]: `var(--terminal-preview-bg, ${effectiveTheme.colors.background})`,
    ['--terminal-ui-fg' as never]: `var(--terminal-preview-fg, ${effectiveTheme.colors.foreground})`,
    ['--terminal-ui-border' as never]: `var(--terminal-preview-border, color-mix(in srgb, ${effectiveTheme.colors.foreground} 8%, ${effectiveTheme.colors.background} 92%))`,
    ['--terminal-ui-toolbar-btn' as never]: `var(--terminal-preview-toolbar-btn, color-mix(in srgb, ${effectiveTheme.colors.background} 88%, ${effectiveTheme.colors.foreground} 12%))`,
    ['--terminal-ui-toolbar-btn-hover' as never]: `var(--terminal-preview-toolbar-btn-hover, color-mix(in srgb, ${effectiveTheme.colors.background} 78%, ${effectiveTheme.colors.foreground} 22%))`,
    ['--terminal-ui-toolbar-btn-active' as never]: `var(--terminal-preview-toolbar-btn-active, color-mix(in srgb, ${effectiveTheme.colors.cursor} 78%, ${effectiveTheme.colors.background} 22%))`,
  }), [effectiveTheme.colors.background, effectiveTheme.colors.cursor, effectiveTheme.colors.foreground]);

  const effectiveComposeBarOpen = inWorkspace ? !!isWorkspaceComposeBarOpen : isComposeBarOpen;

  useTerminalEffects({ CONNECTION_TIMEOUT, Error, XTERM_PERFORMANCE_CONFIG, applyUserCursorPreference, auth, autocompleteCloseRef, autocompleteInputRef, autocompleteKeyEventRef, captureTerminalLogData, clearTerminalCwd, commandBufferRef, connectionLogBufferRef, containerRef, createPromptLineBreakState, createReplaySafeTerminalLogSanitizer, createXTermRuntime, effectiveFontSize, effectiveFontWeight, effectiveTheme, error, executeSnippetCommand, fitAddonRef, fontFamilyId, fontSize, fontWeightFixupDoneRef, forceSyncRenderAfterResize, handleOsc52ReadRequest, handleTerminalDataCaptureOnce, hasConnectedRef, host, hotkeySchemeRef, identities, inWorkspace, isBootActiveRef, isBroadcastEnabledRef, isComposeBarOpen: effectiveComposeBarOpen, isFocusMode, isFocused, isLocalConnection, isNetworkDevice, isResizing: deferTerminalResize, isRestoringSelectionRef, isSearchOpen, isSerialConnection, isVisible, isVisibleRef, keyBindingsRef, keys, knownCwdRef, lastFittedSizeRef, lastToastedErrorRef, logger, mouseTrackingRef, onBroadcastInputRef, onCommandExecuted, onCommandSubmitted, onHotkeyActionRef, onSnippetShortkeyRef, onSnippetExecutorChange, onTerminalCwdChange, onTerminalFontSizeChange, paneLayoutKey, pendingAuthRef, pendingOutputScrollRef, prevIsResizingRef, promptLineBreakStateRef, resizeSession, resolveHostAuth, resolvedFontFamily, safeFit, searchAddonRef, serialConfig, serialLineBufferRef, serializeAddonRef, sessionId, sessionRef, sessionStarters, setError, setHasMouseTracking, setHasSelection, setIsCancelling, setIsDisconnectedDialogDismissed, setIsSearchOpen, setNeedsHostKeyVerification, setPendingHostKeyInfo, setPendingHostKeyRequestId, setProgressLogs, setProgressValue, setSelectionOverlayPosition, setShowLogs, setStatus, setTimeLeft, shouldEnableNativeUserInputAutoScroll, shouldProbeSessionCwd, snippetsRef, status, statusRef, sudoAutofillRef, t, teardown, termRef, terminalAltKeyOptions, terminalBackend, terminalContextActionsRef, terminalCwdTracker, terminalDataCapturedRef, terminalLogSanitizerRef, terminalSettings, terminalSettingsRef, toHostKeyInfo, toast, updateStatus, useEffect, useLayoutEffect, xtermRuntimeRef, zmodem, zmodemToastedRef });

  return <TerminalView ctx={{ ArrowDownToLine, ArrowUpFromLine, Button, Copy, Cpu, HardDrive, HoverCard, HoverCardContent, HoverCardTrigger, Maximize2, MemoryStick, Radio, Sparkles, TerminalAutocomplete, TerminalComposeBar, TerminalConnectionDialog, TerminalContextMenu, TerminalSearchBar, Tooltip, TooltipContent, TooltipTrigger, ZmodemOverwriteDialog, ZmodemProgressIndicator, auth, autocompleteAcceptTextRef, autocompleteCloseRef, autocompleteHostOs, autocompleteInputRef, autocompleteKeyEventRef, autocompleteRepositionRef, autocompleteSettings, chainProgress, cn, containerRef, effectiveTheme, error, executeSnippet, executeSnippetCommand, handleAddSelectionToAI, handleCancelConnect, handleCloseDisconnectedSession, handleCloseSearch, handleDismissDisconnectedDialog, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleFindNext, handleFindPrevious, handleHostKeyAddAndContinue, handleHostKeyClose, handleHostKeyContinue, handleOsc52ReadResponse, handleRetry, handleSearch, handleTopOverlayMouseDownCapture, hasMouseTracking, hasSelection, host, hotkeyScheme, inWorkspace, isBroadcastEnabled, isCancelling, isComposeBarOpen, isDraggingOver, isFocusMode, isLocalConnection, isSearchOpen, isSupportedOs, keyBindings, keys, knownCwdRef, needsHostKeyVerification, onAddSelectionToAI, onBroadcastInput, onCloseSession, onExpandToFocus, onSplitHorizontal, onSplitVertical, onToggleBroadcast, osc52ReadPromptVisible, pendingHostKeyInfo, progressLogs, progressValue, renderControls, scrollToBottomAfterProgrammaticInput, searchMatchCount, selectionOverlayPosition, sessionId, sessionRef, setIsComposeBarOpen, setShowLogs, shouldShowConnectionDialog, showLogs, snippets, status, statusDotTone, sudoHintRef, sudoHintText: t("terminal.sudoHint.pressEnter"), t, termRef, terminalBackend, terminalContextActions, terminalCwdTracker, terminalPreviewVars, terminalSettings, timeLeft, toast, zmodem }} />;
};

const Terminal = memo(TerminalComponent, terminalPropsAreEqual);
Terminal.displayName = "Terminal";

export default Terminal;
