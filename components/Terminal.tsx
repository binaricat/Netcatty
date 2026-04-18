import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Cpu, HardDrive, Maximize2, MemoryStick, Radio, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useI18n } from "../application/i18n/I18nProvider";
import { logger } from "../lib/logger";
import { cn, normalizeLineEndings, wrapBracketedPaste } from "../lib/utils";
import {
  Host,
  Identity,
  KnownHost,
  SerialConfig,
  SSHKey,
  Snippet,
  TerminalSession,
  TerminalTheme,
  TerminalSettings,
  KeyBinding,
} from "../types";
import {
  shouldEnableNativeUserInputAutoScroll,
  shouldScrollOnTerminalInput,
} from "../domain/terminalScroll";
import {
  resolveHostTerminalThemeId,
} from "../domain/terminalAppearance";
import { classifyDistroId } from "../domain/host";
import { resolveHostAuth } from "../domain/sshAuth";
import { useTerminalBackend } from "../application/state/useTerminalBackend";
import KnownHostConfirmDialog, { HostKeyInfo } from "./KnownHostConfirmDialog";
// SFTPModal removed - SFTP is now handled by SftpSidePanel in TerminalLayer
import { Button } from "./ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { toast } from "./ui/toast";
import { useAvailableFonts } from "../application/state/fontStore";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import { useCustomThemes } from "../application/state/customThemeStore";

import { TerminalConnectionDialog } from "./terminal/TerminalConnectionDialog";
import { TerminalToolbar } from "./terminal/TerminalToolbar";
import { TerminalComposeBar } from "./terminal/TerminalComposeBar";
import { TerminalContextMenu } from "./terminal/TerminalContextMenu";
import { TerminalSearchBar } from "./terminal/TerminalSearchBar";
import { ZmodemProgressIndicator } from "./terminal/ZmodemProgressIndicator";
import { useZmodemTransfer } from "./terminal/hooks/useZmodemTransfer";
import { createTerminalSessionStarters, type PendingAuth } from "./terminal/runtime/createTerminalSessionStarters";
import { createXTermRuntime, primaryFontFamily, type XTermRuntime } from "./terminal/runtime/createXTermRuntime";
import { shouldPreserveTerminalFocusOnMouseDown } from "./terminal/toolbarFocus";
import { preserveTerminalViewportInScrollback } from "./terminal/clearTerminalViewport";
import { XTERM_PERFORMANCE_CONFIG } from "../infrastructure/config/xtermPerformance";
import { useTerminalSearch } from "./terminal/hooks/useTerminalSearch";
import { useTerminalContextActions } from "./terminal/hooks/useTerminalContextActions";
import { useTerminalAuthState } from "./terminal/hooks/useTerminalAuthState";
import { useServerStats } from "./terminal/hooks/useServerStats";
import { extractDropEntries, getPathForFile, DropEntry } from "../lib/sftpFileUtils";
import { useTerminalAutocomplete, AutocompletePopup } from "./terminal/autocomplete";

/**
 * Extract unique root paths from drop entries for local terminal path insertion.
 * For nested files, extracts the root folder path; for single files, uses the full path.
 * Paths with spaces are quoted.
 */
function extractRootPathsFromDropEntries(dropEntries: DropEntry[]): string[] {
  const paths: string[] = [];
  const seenPaths = new Set<string>();

  for (const entry of dropEntries) {
    if (!entry.file) continue;

    const fullPath = getPathForFile(entry.file);
    if (!fullPath) continue;

    const pathParts = entry.relativePath.split('/');

    if (pathParts.length > 1) {
      // Nested file in a folder - extract the root folder path
      const rootFolderName = pathParts[0];
      const separator = fullPath.includes('\\') ? '\\' : '/';

      // Find the position of the root folder name in the full path
      const rootFolderIndex = fullPath.lastIndexOf(separator + rootFolderName + separator);
      const altRootFolderIndex = fullPath.lastIndexOf(separator + rootFolderName);
      const folderStartIndex = rootFolderIndex !== -1
        ? rootFolderIndex + 1
        : (altRootFolderIndex !== -1 ? altRootFolderIndex + 1 : -1);

      if (folderStartIndex !== -1) {
        const folderEndIndex = folderStartIndex + rootFolderName.length;
        const folderPath = fullPath.substring(0, folderEndIndex);

        if (!seenPaths.has(folderPath)) {
          paths.push(folderPath.includes(' ') ? `"${folderPath}"` : folderPath);
          seenPaths.add(folderPath);
        }
      }
    } else {
      // Single file (not in a folder)
      if (!seenPaths.has(fullPath)) {
        paths.push(fullPath.includes(' ') ? `"${fullPath}"` : fullPath);
        seenPaths.add(fullPath);
      }
    }
  }

  return paths;
}

interface TerminalProps {
  host: Host;
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  chainHosts?: Host[];
  themePreviewId?: string;
  knownHosts?: KnownHost[];
  isVisible: boolean;
  inWorkspace?: boolean;
  isResizing?: boolean;
  isFocusMode?: boolean;
  isFocused?: boolean;
  fontFamilyId: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  followAppTerminalTheme?: boolean;
  terminalSettings?: TerminalSettings;
  sessionId: string;
  startupCommand?: string;
  noAutoRun?: boolean;
  serialConfig?: SerialConfig;
  hotkeyScheme?: "disabled" | "mac" | "pc";
  keyBindings?: KeyBinding[];
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onStatusChange?: (sessionId: string, status: TerminalSession["status"]) => void;
  onSessionExit?: (sessionId: string, evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onUpdateHost?: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onExpandToFocus?: () => void;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onOpenSftp?: (
    host: Host,
    initialPath?: string,
    pendingUploadEntries?: DropEntry[],
    sourceSessionId?: string,
  ) => void;
  onOpenScripts?: () => void;
  onOpenTheme?: () => void;
  isBroadcastEnabled?: boolean;
  onToggleBroadcast?: () => void;
  onToggleComposeBar?: () => void;
  isWorkspaceComposeBarOpen?: boolean;
  onBroadcastInput?: (data: string, sourceSessionId: string) => void;
  onSnippetExecutorChange?: (
    sessionId: string,
    executor: ((command: string, noAutoRun?: boolean) => void) | null,
  ) => void;
  // Session log configuration for real-time streaming
  sessionLog?: { enabled: boolean; directory: string; format: string };
}

// Helper function to format network speed (bytes/sec) to human-readable format
function formatNetSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) {
    return `${bytesPerSec}B/s`;
  } else if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)}K/s`;
  } else if (bytesPerSec < 1024 * 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)}M/s`;
  } else {
    return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(1)}G/s`;
  }
}

const TerminalComponent: React.FC<TerminalProps> = ({
  host,
  keys,
  identities,
  snippets,
  chainHosts = [],
  themePreviewId,
  knownHosts: _knownHosts = [],
  isVisible,
  inWorkspace,
  isResizing,
  isFocusMode,
  isFocused,
  fontFamilyId,
  fontSize,
  terminalTheme,
  followAppTerminalTheme = false,
  terminalSettings,
  sessionId,
  startupCommand,
  noAutoRun,
  serialConfig,
  hotkeyScheme = "disabled",
  keyBindings = [],
  onHotkeyAction,
  onStatusChange,
  onSessionExit,
  onTerminalDataCapture,
  onOsDetected,
  onCloseSession,
  onUpdateHost,
  onAddKnownHost,
  onExpandToFocus,
  onCommandExecuted,
  onSplitHorizontal,
  onSplitVertical,
  onOpenSftp,
  onOpenScripts,
  onOpenTheme,
  isBroadcastEnabled,
  onToggleBroadcast,
  onToggleComposeBar,
  isWorkspaceComposeBarOpen,
  onBroadcastInput,
  onSnippetExecutorChange,
  sessionLog,
}) => {
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
  const knownCwdRef = useRef<string | undefined>(undefined);
  const disposeDataRef = useRef<(() => void) | null>(null);
  const disposeExitRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const hasRunStartupCommandRef = useRef(false);
  // Token for an in-flight retry chain. handleRetry sets this to a fresh
  // symbol; any cancel/close/teardown/subsequent-retry invalidates it. The
  // chained xterm.write callbacks verify the token before proceeding so a
  // cancelled retry can't fire a startNewSession after the fact.
  const retryTokenRef = useRef<symbol | null>(null);
  const terminalDataCapturedRef = useRef(false);
  const onTerminalDataCaptureRef = useRef(onTerminalDataCapture);
  const commandBufferRef = useRef<string>("");
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

  useEffect(() => {
    if (xtermRuntimeRef.current) {
      // Merge global rules with host-level rules
      const globalRules = terminalSettings?.keywordHighlightRules ?? [];
      const hostRules = host?.keywordHighlightRules ?? [];

      const globalEnabled = terminalSettings?.keywordHighlightEnabled ?? false;
      // Host-level toggle: undefined = inherit global, true/false = explicit override
      const hostEnabled = host?.keywordHighlightEnabled;

      // Global and host-level highlights are independent:
      // global toggle controls global rules, host toggle controls host-specific rules
      const effectiveGlobalEnabled = globalEnabled;
      const effectiveHostEnabled = hostEnabled ?? false;

      const mergedRules = [
        ...(effectiveGlobalEnabled ? globalRules : []),
        ...(effectiveHostEnabled ? hostRules : [])
      ];
      const isEnabled = effectiveGlobalEnabled || effectiveHostEnabled;

      xtermRuntimeRef.current.keywordHighlighter.setRules(mergedRules, isEnabled);
    }
  }, [
    terminalSettings?.keywordHighlightEnabled,
    terminalSettings?.keywordHighlightRules,
    host?.keywordHighlightEnabled,
    host?.keywordHighlightRules
  ]);

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

  // Autocomplete handler refs (set after hook initialization)
  const autocompleteKeyEventRef = useRef<((e: KeyboardEvent) => boolean) | undefined>(undefined);
  const autocompleteInputRef = useRef<((data: string) => void) | undefined>(undefined);
  const autocompleteRepositionRef = useRef<(() => void) | undefined>(undefined);

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
  const [isDisconnectedDialogDismissed, setIsDisconnectedDialogDismissed] = useState(false);

  const statusRef = useRef<TerminalSession["status"]>(status);
  statusRef.current = status;

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

  const [chainProgress, setChainProgress] = useState<{
    currentHop: number;
    totalHops: number;
    currentHostLabel: string;
  } | null>(null);

  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);
  // pendingUploadEntries removed - drag-drop uploads now handled by SftpSidePanel
  const [isComposeBarOpen, setIsComposeBarOpen] = useState(false);
  const [terminalEncoding, setTerminalEncoding] = useState<'utf-8' | 'gb18030'>(() => {
    if (host?.charset && /^gb/i.test(String(host.charset).trim())) return 'gb18030';
    return 'utf-8';
  });
  const terminalEncodingRef = useRef(terminalEncoding);
  terminalEncodingRef.current = terminalEncoding;

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

  // Terminal autocomplete — onAcceptText writes directly to session (no CustomEvent)
  const autocompleteAcceptTextRef = useRef<((text: string) => void) | undefined>(undefined);
  autocompleteAcceptTextRef.current = (text: string) => {
    const id = sessionRef.current;
    if (id && text) {
      // Serial line mode: buffer text and handle local echo instead of direct send
      if (host.protocol === "serial" && serialConfig?.lineMode) {
        for (const ch of text) {
          if (ch === "\r") {
            const line = serialLineBufferRef.current + "\r";
            terminalBackend.writeToSession(id, line);
            serialLineBufferRef.current = "";
            if (serialConfig?.localEcho) termRef.current?.write("\r\n");
          } else if (ch === "\x15") {
            if (serialConfig?.localEcho && serialLineBufferRef.current.length > 0) {
              termRef.current?.write("\b \b".repeat(serialLineBufferRef.current.length));
            }
            serialLineBufferRef.current = "";
          } else if (ch === "\b" || ch === "\x7f") {
            if (serialLineBufferRef.current.length > 0) {
              serialLineBufferRef.current = serialLineBufferRef.current.slice(0, -1);
              if (serialConfig?.localEcho) termRef.current?.write("\b \b");
            }
          } else if (ch.charCodeAt(0) >= 32) {
            serialLineBufferRef.current += ch;
            if (serialConfig?.localEcho) termRef.current?.write(ch);
          }
        }
        // Still update commandBuffer and broadcast for serial line mode
        // (fall through to shared bookkeeping below — don't return early)
      } else if (host.protocol === "serial" && serialConfig?.localEcho) {
        // Serial character mode with local echo: echo accepted text locally
        terminalBackend.writeToSession(id, text);
        for (const ch of text) {
          if (ch === "\r") {
            termRef.current?.write("\r\n");
          } else if (ch.charCodeAt(0) >= 32) {
            termRef.current?.write(ch);
          }
        }
      } else {
        terminalBackend.writeToSession(id, text);
      }

      // Broadcast to other sessions if broadcast mode is enabled
      if (isBroadcastEnabledRef.current && onBroadcastInputRef.current) {
        onBroadcastInputRef.current(text, sessionId);
      }

      // Update command buffer for onCommandExecuted tracking
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          const cmd = commandBufferRef.current.trim();
          if (cmd && onCommandExecuted) onCommandExecuted(cmd, host.id, host.label, sessionId);
          commandBufferRef.current = "";
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

  const autocomplete = useTerminalAutocomplete({
    termRef,
    sessionId,
    hostId: host.id,
    hostOs: host.os || (host.protocol === "local"
      ? (navigator.platform?.startsWith("Win") ? "windows" : navigator.platform?.startsWith("Mac") ? "macos" : "linux")
      : "linux"),
    settings: terminalSettings ? {
      enabled: terminalSettings.autocompleteEnabled ?? true,
      showGhostText: terminalSettings.autocompleteGhostText ?? true,
      showPopupMenu: terminalSettings.autocompletePopupMenu ?? true,
      debounceMs: terminalSettings.autocompleteDebounceMs ?? 100,
      minChars: terminalSettings.autocompleteMinChars ?? 1,
      maxSuggestions: terminalSettings.autocompleteMaxSuggestions ?? 8,
    } : undefined,
    onAcceptText: (text) => autocompleteAcceptTextRef.current?.(text),
    protocol: host.protocol,
    getCwd: () => knownCwdRef.current ?? xtermRuntimeRef.current?.currentCwd,
  });

  // Wire up autocomplete handler refs so createXTermRuntime can use them
  autocompleteKeyEventRef.current = autocomplete.handleKeyEvent;
  autocompleteInputRef.current = autocomplete.handleInput;
  autocompleteRepositionRef.current = autocomplete.repositionPopup;
  const autocompleteClosePopup = autocomplete.closePopup;

  useEffect(() => {
    knownCwdRef.current = undefined;
  }, [sessionId, host.id]);

  useEffect(() => {
    if (host.protocol === "local" || host.protocol === "serial" || host.protocol === "telnet") {
      return;
    }
    if (status !== "connected" || !sessionRef.current || knownCwdRef.current) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!sessionRef.current) return;
      try {
        const result = await terminalBackend.getSessionPwd(sessionRef.current);
        if (!cancelled && result.success && result.cwd) {
          knownCwdRef.current = result.cwd;
        }
      } catch {
        // Best effort only.
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [host.protocol, status, terminalBackend]);

  useEffect(() => {
    if (!isVisible) {
      autocompleteClosePopup();
    }
  }, [isVisible, autocompleteClosePopup]);

  // Check if this is a local or serial connection (doesn't need connection dialog during connecting)
  const isLocalConnection = host.protocol === "local";
  const isSerialConnection = host.protocol === "serial";

  // Server stats (CPU, Memory, Disk) — only for Linux/macOS, and never
  // for hosts classified as network devices (either via explicit
  // deviceType='network' or via SSH banner detection that populated
  // host.distro with a network-vendor ID). See #674: polling the stats
  // command on Cisco / Huawei / Juniper etc. generates one AAA session
  // log entry per poll because each exec channel is counted as a new
  // session on those devices.
  //
  // IMPORTANT: this gating must NOT go through getEffectiveHostDistro()
  // because that honors the manual distro override (`distroMode: 'manual'`
  // + `manualDistro`) which is purely a cosmetic icon choice. A user who
  // pinned an "ubuntu" icon on what is actually a Cisco host would
  // otherwise silently re-enable the polling loop and re-introduce the
  // AAA log flood this patch is meant to eliminate. The display icon can
  // still be overridden (see DistroAvatar) — gating uses the raw detected
  // `host.distro` and the explicit `host.deviceType` only.
  const detectedDeviceClass = classifyDistroId(host.distro);
  const isNetworkDevice =
    host.deviceType === 'network' || detectedDeviceClass === 'network-device';
  const isSupportedOs =
    !isNetworkDevice &&
    (host.os === 'linux' || host.os === 'macos' || detectedDeviceClass === 'linux-like');
  const { stats: serverStats } = useServerStats({
    sessionId,
    enabled: terminalSettings?.showServerStats ?? true,
    refreshInterval: terminalSettings?.serverStatsRefreshInterval ?? 5,
    isSupportedOs,
    isConnected: status === 'connected',
    isVisible,
  });

  const zmodem = useZmodemTransfer(sessionId);

  const zmodemToastedRef = useRef(false);
  useEffect(() => {
    if (zmodem.active) {
      zmodemToastedRef.current = false;
      return;
    }
    if (zmodemToastedRef.current) return;
    if (zmodem.error) {
      zmodemToastedRef.current = true;
      toast.error(zmodem.error, 'ZMODEM');
    } else if (zmodem.filename) {
      zmodemToastedRef.current = true;
      toast.success(
        `${zmodem.transferType === 'upload' ? 'Uploaded' : 'Downloaded'}: ${zmodem.filename}`,
        'ZMODEM',
      );
    }
  }, [zmodem.active, zmodem.error, zmodem.filename, zmodem.transferType]);

  useEffect(() => {
    if (!error) {
      lastToastedErrorRef.current = null;
      return;
    }
    if (lastToastedErrorRef.current === error) return;
    lastToastedErrorRef.current = error;
    toast.error(error, t("terminal.connectionErrorTitle"));
  }, [error, t]);

  const pendingAuthRef = useRef<PendingAuth>(null);
  const sessionStartersRef = useRef<ReturnType<typeof createTerminalSessionStarters> | null>(null);
  const auth = useTerminalAuthState({
    host,
    pendingAuthRef,
    termRef,
    onUpdateHost,
    onStartSsh: (term) => {
      sessionStartersRef.current?.startSSH(term);
    },
    setStatus: (next) => setStatus(next),
    setProgressLogs,
  });

  const [needsHostKeyVerification, setNeedsHostKeyVerification] = useState(false);
  const [pendingHostKeyInfo, setPendingHostKeyInfo] = useState<HostKeyInfo | null>(null);
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
    return (availableFonts.find((f) => f.id === resolvedFontId) || availableFonts[0]).family;
  }, [availableFonts, fontFamilyId, hasFontFamilyOverride, host.fontFamily]);

  const effectiveTheme = useMemo(() => {
    // When "Follow Application Theme" is on and there's no active
    // preview, skip per-host overrides — all terminals should use the
    // UI-matched theme passed via terminalTheme prop.
    if (followAppTerminalTheme && !themePreviewId) return terminalTheme;
    const themeId = themePreviewId ?? resolveHostTerminalThemeId(
      { theme: host.theme, themeOverride: host.themeOverride } as Pick<Host, 'theme' | 'themeOverride'>,
      terminalTheme.id,
    );
    if (themeId) {
      const hostTheme = TERMINAL_THEMES.find((t) => t.id === themeId)
        || customThemes.find((t) => t.id === themeId);
      if (hostTheme) return hostTheme;
    }
    return terminalTheme;
  }, [customThemes, followAppTerminalTheme, host.theme, host.themeOverride, terminalTheme, themePreviewId]);

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
    captureHandler(capturedSessionId, data);
  }, []);

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
    resolvedChainHosts,
    sessionId,
    startupCommand,
    noAutoRun,
    terminalSettings,
    terminalSettingsRef,
    terminalBackend,
    serialConfig,
    isVisibleRef,
    pendingOutputScrollRef,
    sessionRef,
    hasConnectedRef,
    hasRunStartupCommandRef,
    disposeDataRef,
    disposeExitRef,
    fitAddonRef,
    serializeAddonRef,
    pendingAuthRef,
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
      // Sync terminal encoding to SSH backend before first data arrives
      const isSSH = host.protocol !== 'local' && host.protocol !== 'serial' && host.protocol !== 'telnet' && host.protocol !== 'mosh' && !host.moshEnabled && !host.id?.startsWith('local-') && !host.id?.startsWith('serial-') && host.hostname !== 'localhost';
      if (isSSH) {
        setSessionEncoding(id, terminalEncodingRef.current);
      }
    },
    onSessionExit,
    onTerminalDataCapture: handleTerminalDataCaptureOnce,
    onOsDetected,
    onCommandExecuted,
    sessionLog,
  });
  sessionStartersRef.current = sessionStarters;

  useEffect(() => {
    let disposed = false;
    terminalDataCapturedRef.current = false;
    setError(null);
    hasConnectedRef.current = false;
    pendingOutputScrollRef.current = false;
    setProgressLogs([]);
    setShowLogs(false);
    setIsCancelling(false);
    setIsDisconnectedDialogDismissed(false);

    const boot = async () => {
      try {
        if (disposed || !containerRef.current) return;

        const runtime = createXTermRuntime({
          container: containerRef.current,
          host,
          fontFamilyId,
          fontSize,
          terminalTheme: effectiveTheme,
          terminalSettingsRef,
          terminalBackend,
          sessionRef,
          hotkeySchemeRef,
          keyBindingsRef,
          onHotkeyActionRef,
          isBroadcastEnabledRef,
          onBroadcastInputRef,
          snippetsRef,
          sessionId,
          statusRef,
          onCommandExecuted,
          commandBufferRef,
          setIsSearchOpen,
          // Serial-specific options
          serialLocalEcho: serialConfig?.localEcho,
          serialLineMode: serialConfig?.lineMode,
          serialLineBufferRef,
          onCwdChange: (cwd: string) => {
            knownCwdRef.current = cwd;
          },
          onOsc52ReadRequest: handleOsc52ReadRequest,
          // Autocomplete integration
          onAutocompleteKeyEvent: (e: KeyboardEvent) => autocompleteKeyEventRef.current?.(e) ?? true,
          onAutocompleteInput: (data: string) => autocompleteInputRef.current?.(data),
          isRestoringSelectionRef,
        });

        xtermRuntimeRef.current = runtime;
        termRef.current = runtime.term;
        fitAddonRef.current = runtime.fitAddon;
        serializeAddonRef.current = runtime.serializeAddon;
        searchAddonRef.current = runtime.searchAddon;

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

        if (host.protocol === "serial") {
          setStatus("connecting");
          setProgressLogs(["Initializing serial connection..."]);
          await sessionStarters.startSerial(term);
        } else if (host.protocol === "local" || host.hostname === "localhost") {
          setStatus("connecting");
          setProgressLogs(["Initializing local shell..."]);
          await sessionStarters.startLocal(term);
        } else if (host.protocol === "telnet") {
          setStatus("connecting");
          setProgressLogs(["Initializing Telnet connection..."]);
          await sessionStarters.startTelnet(term);
        } else if (host.moshEnabled) {
          setStatus("connecting");
          setProgressLogs(["Initializing Mosh connection..."]);
          await sessionStarters.startMosh(term);
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

          setStatus("connecting");
          setProgressLogs(["Initializing secure channel..."]);
          await sessionStarters.startSSH(term);
        }
      } catch (err) {
        logger.error("Failed to initialize terminal", err);
        setError(err instanceof Error ? err.message : String(err));
        updateStatus("disconnected");
      }
    };

    boot();

    return () => {
      disposed = true;
      if (!terminalDataCapturedRef.current && serializeAddonRef.current) {
        try {
          const terminalData = serializeAddonRef.current.serialize();
          logger.info("[Terminal] Capturing data on unmount", { sessionId, dataLength: terminalData.length });
          handleTerminalDataCaptureOnce(sessionId, terminalData);
        } catch (err) {
          logger.warn("Failed to serialize terminal data on unmount:", err);
        }
      }
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Effect only runs on host.id/sessionId change, internal functions are stable
  }, [handleTerminalDataCaptureOnce, host.id, sessionId]);

  // Connection timeline and timeout visuals
  useEffect(() => {
    if (status !== "connecting" || auth.needsAuth) return;

    // Local terminal and serial connections don't need timeout/progress UI
    if (isLocalConnection || isSerialConnection) return;

    setTimeLeft(CONNECTION_TIMEOUT / 1000);
    const countdown = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    const timeout = setTimeout(() => {
      setError("Connection timed out. Please try again.");
      updateStatus("disconnected");
      setProgressLogs((prev) => [...prev, "Connection timed out."]);
    }, CONNECTION_TIMEOUT);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateStatus is a stable internal helper
  }, [status, auth.needsAuth, host.protocol, host.hostname]);

  useEffect(() => {
    if (status === "connecting") {
      setIsDisconnectedDialogDismissed(false);
    }
  }, [status]);

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
        lastFittedSizeRef.current = { width, height };
        fitAddon.fit();
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

  // Sync xterm theme before browser paint so canvas + DOM CSS vars update in the same frame
  useLayoutEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = {
        ...effectiveTheme.colors,
        selectionBackground: effectiveTheme.colors.selection,
        scrollbarSliderBackground: effectiveTheme.colors.foreground + '33',
        scrollbarSliderHoverBackground: effectiveTheme.colors.foreground + '66',
        scrollbarSliderActiveBackground: effectiveTheme.colors.foreground + '80',
      };
    }
  }, [effectiveTheme]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = effectiveFontSize;
      termRef.current.options.fontFamily = resolvedFontFamily;

      if (terminalSettings) {
        termRef.current.options.cursorStyle = terminalSettings.cursorShape;
        termRef.current.options.cursorBlink = terminalSettings.cursorBlink;
        termRef.current.options.scrollback = terminalSettings.scrollback === 0 ? 999999 : terminalSettings.scrollback;
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
        const resolvedFontWeightBold = (() => {
          const fontFamily = termRef.current?.options.fontFamily || "";
          if (typeof document === "undefined" || !document.fonts?.check) {
            return terminalSettings.fontWeightBold;
          }
          const weightSpec = `${terminalSettings.fontWeightBold} ${effectiveFontSize}px ${primaryFontFamily(fontFamily)}`;
          return document.fonts.check(weightSpec)
            ? terminalSettings.fontWeightBold
            : effectiveFontWeight;
        })();

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
        termRef.current.options.altClickMovesCursor = !terminalSettings.altAsMeta;
        termRef.current.options.wordSeparator = terminalSettings.wordSeparators;
        termRef.current.options.ignoreBracketedPasteMode = terminalSettings.disableBracketedPaste ?? false;
      }

      if (isVisibleRef.current) {
        setTimeout(() => safeFit({ force: true, requireVisible: true }), 50);
      } else {
        lastFittedSizeRef.current = null;
      }
    }
  }, [effectiveFontSize, effectiveFontWeight, resolvedFontFamily, terminalSettings]);

  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(() => {
      safeFit({ requireVisible: true });
      if (pendingOutputScrollRef.current) {
        termRef.current?.scrollToBottom();
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            termRef.current?.scrollToBottom();
          });
        }
        pendingOutputScrollRef.current = false;
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [isVisible]);

  useEffect(() => {
    let cancelled = false;
    const waitForFonts = async () => {
      try {
        const fontFaceSet = document.fonts as FontFaceSet | undefined;
        if (!fontFaceSet?.ready) return;
        await fontFaceSet.ready;
        if (cancelled) return;

        const term = termRef.current as {
          cols: number;
          rows: number;
          renderer?: { remeasureFont?: () => void };
        } | null;
        const fitAddon = fitAddonRef.current;
        try {
          term?.renderer?.remeasureFont?.();
        } catch (err) {
          logger.warn("Font remeasure failed", err);
        }

        try {
          fitAddon?.fit();
        } catch (err) {
          logger.warn("Fit after fonts ready failed", err);
        }

        if (terminalSettings && termRef.current) {
          const fontFamily = termRef.current.options?.fontFamily || "";
          if (typeof document !== "undefined" && document.fonts?.check) {
            const weightSpec = `${terminalSettings.fontWeightBold} ${effectiveFontSize}px ${primaryFontFamily(fontFamily)}`;
            const resolvedBold = document.fonts.check(weightSpec)
              ? terminalSettings.fontWeightBold
              : effectiveFontWeight;
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
        }

        const id = sessionRef.current;
        if (id && term) {
          try {
            resizeSession(id, term.cols, term.rows);
          } catch (err) {
            logger.warn("Resize session after fonts ready failed", err);
          }
        }
      } catch (err) {
        logger.warn("Waiting for fonts failed", err);
      }
    };

    waitForFonts();
    return () => {
      cancelled = true;
    };
  }, [effectiveFontSize, effectiveFontWeight, resizeSession, terminalSettings]);

  useEffect(() => {
    if (!isVisible || !containerRef.current || !fitAddonRef.current) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver(() => {
      if (isResizing || !isVisibleRef.current) return;
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
  }, [isVisible, isResizing]);

  const prevIsResizingRef = useRef(isResizing);
  useEffect(() => {
    if (prevIsResizingRef.current && !isResizing && isVisible) {
      const timer = setTimeout(() => {
        safeFit({ force: true, requireVisible: true });
      }, 100);
      return () => clearTimeout(timer);
    }
    prevIsResizingRef.current = isResizing;
  }, [isResizing, isVisible]);

  useEffect(() => {
    if (!isVisible || !fitAddonRef.current) return;
    // Fit twice: once after initial layout (100ms) and again after layout settles
    // (350ms) to handle race conditions during split operations where the container
    // dimensions may not be final on the first pass.
    const timer1 = setTimeout(() => {
      safeFit({ requireVisible: true });
    }, 100);
    const timer2 = setTimeout(() => {
      safeFit({ force: true, requireVisible: true });
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

    const onSelectionChange = () => {
      const selection = term.getSelection();
      const hasText = !!selection && selection.length > 0;
      setHasSelection(hasText);

      if (hasText && terminalSettings?.copyOnSelect && !isRestoringSelectionRef.current) {
        navigator.clipboard.writeText(selection).catch((err) => {
          logger.warn("Copy on select failed:", err);
        });
      }
    };

    const disposable = term.onSelectionChange(onSelectionChange);
    return () => disposable.dispose();
  }, [terminalSettings?.copyOnSelect]);

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
  // - contextmenu: xterm.js calls textarea.select() which steals focus
  // - mouseup (button 2): tmux interprets the right-button release as a
  //   dismiss action, closing the popup menu immediately after it appears
  // Both are intercepted at the capture phase before xterm.js's own listeners.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleContextMenuCapture = (e: MouseEvent) => {
      if (mouseTrackingRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    const handleMouseUpCapture = (e: MouseEvent) => {
      if (e.button === 2 && mouseTrackingRef.current) {
        e.stopImmediatePropagation();
      }
    };

    el.addEventListener('contextmenu', handleContextMenuCapture, true);
    el.addEventListener('mouseup', handleMouseUpCapture, true);
    return () => {
      el.removeEventListener('contextmenu', handleContextMenuCapture, true);
      el.removeEventListener('mouseup', handleMouseUpCapture, true);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!isVisible) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      if (!isVisibleRef.current) return;
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
  }, [isVisible]);

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

  const executeSnippetCommand = useCallback((command: string, noAutoRun?: boolean) => {
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

    terminalBackend.writeToSession(id, data);
    scrollToBottomAfterProgrammaticInput(data);
    term.focus();
  }, [scrollToBottomAfterProgrammaticInput, terminalBackend]);

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

  const terminalContextActions = useTerminalContextActions({
    termRef,
    sessionRef,
    terminalBackend,
    onHasSelectionChange: setHasSelection,
    disableBracketedPasteRef,
    scrollOnPasteRef,
  });

  const handleSetTerminalEncoding = (encoding: 'utf-8' | 'gb18030') => {
    setTerminalEncoding(encoding);
    if (sessionRef.current) {
      setSessionEncoding(sessionRef.current, encoding);
    }
  };

  const handleOpenSFTP = async () => {
    if (onOpenSftp) {
      // Delegate to parent (TerminalLayer) for shared SFTP side panel
      let initialPath: string | undefined = undefined;
      if (sessionRef.current) {
        try {
          const result = await terminalBackend.getSessionPwd(sessionRef.current);
          if (result.success && result.cwd) {
            initialPath = result.cwd;
          }
        } catch {
          // Silently fail
        }
      }
      onOpenSftp(host, initialPath, undefined, sessionId);
      return;
    }

    // Fallback: toggle internal SFTP state (shouldn't happen with new architecture)
    if (showSFTP) {
      setShowSFTP(false);
      return;
    }
    setShowSFTP(true);
  };

  const handleCancelConnect = () => {
    retryTokenRef.current = null;
    setIsCancelling(true);
    auth.setNeedsAuth(false);
    auth.setAuthRetryMessage(null);
    setNeedsHostKeyVerification(false);
    setPendingHostKeyInfo(null);
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
    handleCancelConnect();
  };

  const handleHostKeyContinue = () => {
    setNeedsHostKeyVerification(false);
    if (pendingConnectionRef.current) {
      pendingConnectionRef.current();
      pendingConnectionRef.current = null;
    }
    setPendingHostKeyInfo(null);
  };

  const handleHostKeyAddAndContinue = () => {
    if (pendingHostKeyInfo && onAddKnownHost) {
      const newKnownHost: KnownHost = {
        id: `kh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        hostname: pendingHostKeyInfo.hostname,
        port: pendingHostKeyInfo.port || host.port || 22,
        keyType: pendingHostKeyInfo.keyType,
        publicKey: pendingHostKeyInfo.fingerprint,
        discoveredAt: Date.now(),
      };
      onAddKnownHost(newKnownHost);
    }
    setNeedsHostKeyVerification(false);
    if (pendingConnectionRef.current) {
      pendingConnectionRef.current();
      pendingConnectionRef.current = null;
    }
    setPendingHostKeyInfo(null);
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

  const shouldShowConnectionDialog = status !== "connected"
    && !needsHostKeyVerification
    && !((isLocalConnection || isSerialConnection) && status === "connecting")
    && !(status === "disconnected" && isDisconnectedDialogDismissed);

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    if (!e.dataTransfer.types.includes('Files')) {
      return;
    }

    // Only handle drops on connected terminals
    if (status !== 'connected') {
      toast.error(t("terminal.dragDrop.notConnected"), t("terminal.dragDrop.errorTitle"));
      return;
    }

    try {
      const dropEntries = await extractDropEntries(e.dataTransfer);

      if (dropEntries.length === 0) {
        return;
      }

      if (isLocalConnection) {
        // Local terminal: Insert absolute paths
        const paths = extractRootPathsFromDropEntries(dropEntries);

        if (paths.length > 0 && termRef.current && sessionRef.current) {
          const pathsText = paths.join(' ');
          // Write the paths to the terminal
          terminalBackend.writeToSession(sessionRef.current, pathsText);
          scrollToBottomAfterProgrammaticInput(pathsText);
          termRef.current.focus();
        }
      } else {
        // Remote terminal: Trigger SFTP upload via parent
        if (onOpenSftp) {
          let initialPath: string | undefined = undefined;
          if (sessionRef.current) {
            try {
              const result = await terminalBackend.getSessionPwd(sessionRef.current);
              if (result.success && result.cwd) {
                initialPath = result.cwd;
              }
            } catch {
              // Silently fail
            }
          }
          onOpenSftp(host, initialPath, dropEntries, sessionId);
        }
      }
    } catch (error) {
      logger.error("Failed to handle file drop", error);
      toast.error(t("terminal.dragDrop.errorMessage"), t("terminal.dragDrop.errorTitle"));
    }
  };

  const renderControls = (opts?: { showClose?: boolean }) => (
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
  );

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
    ['--terminal-ui-toolbar-btn-active' as never]: `var(--terminal-preview-toolbar-btn-active, color-mix(in srgb, ${effectiveTheme.colors.background} 68%, ${effectiveTheme.colors.foreground} 32%))`,
  }), [effectiveTheme.colors.background, effectiveTheme.colors.foreground]);

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
      onClose={inWorkspace ? () => onCloseSession?.(sessionId) : undefined}
    >
      <div
        className={cn(
          "relative h-full w-full flex overflow-hidden bg-gradient-to-br from-[#050910] via-[#06101a] to-[#0b1220]",
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
            </div>
            {/* Server Stats Display */}
            {terminalSettings?.showServerStats && status === 'connected' && serverStats.lastUpdated && (
              <div className="flex items-center gap-2.5 ml-2 text-[10px] opacity-80 flex-nowrap overflow-hidden min-w-0">
                {/* CPU with HoverCard for per-core details */}
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                      title={t("terminal.serverStats.cpu")}
                    >
                      <Cpu size={10} className="flex-shrink-0" />
                      <span>
                        {serverStats.cpu !== null ? `${serverStats.cpu}%` : '--'}
                        {serverStats.cpuCores !== null && ` (${serverStats.cpuCores}C)`}
                      </span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    className="w-auto p-3"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                  >
                    <div className="text-xs space-y-2">
                      <div className="font-medium text-sm mb-2">{t("terminal.serverStats.cpuCores")}</div>
                      {serverStats.cpuPerCore.length > 0 ? (
                        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(4, serverStats.cpuPerCore.length)}, 1fr)` }}>
                          {serverStats.cpuPerCore.map((usage, index) => (
                            <div key={index} className="flex flex-col items-center gap-1 min-w-[48px]">
                              <div className="text-[10px] text-muted-foreground">Core {index}</div>
                              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all",
                                    usage >= 90 ? "bg-red-500" : usage >= 70 ? "bg-amber-500" : "bg-emerald-500"
                                  )}
                                  style={{ width: `${usage}%` }}
                                />
                              </div>
                              <div className={cn(
                                "text-[11px] font-medium",
                                usage >= 90 ? "text-red-400" : usage >= 70 ? "text-amber-400" : "text-emerald-400"
                              )}>
                                {usage}%
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : serverStats.cpu !== null ? (
                        <div className="flex flex-col gap-1.5 min-w-[160px]">
                          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                serverStats.cpu >= 90 ? "bg-red-500" : serverStats.cpu >= 70 ? "bg-amber-500" : "bg-emerald-500"
                              )}
                              style={{ width: `${serverStats.cpu}%` }}
                            />
                          </div>
                          <div className={cn(
                            "text-center text-[11px] font-medium",
                            serverStats.cpu >= 90 ? "text-red-400" : serverStats.cpu >= 70 ? "text-amber-400" : "text-emerald-400"
                          )}>
                            {serverStats.cpu}% · {serverStats.cpuCores ?? '?'} cores
                          </div>
                        </div>
                      ) : (
                        <div className="text-muted-foreground">{t("terminal.serverStats.noData")}</div>
                      )}
                    </div>
                  </HoverCardContent>
                </HoverCard>
                {/* Memory with HoverCard for htop-style bar and top processes */}
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                      title={t("terminal.serverStats.memory")}
                    >
                      <MemoryStick size={10} className="flex-shrink-0" />
                      <span>
                        {serverStats.memUsed !== null && serverStats.memTotal !== null
                          ? `${(serverStats.memUsed / 1024).toFixed(1)}/${(serverStats.memTotal / 1024).toFixed(1)}G`
                          : '--'}
                      </span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    className="w-auto p-3"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                  >
                    <div className="text-xs space-y-3 min-w-[280px]">
                      <div className="font-medium text-sm">{t("terminal.serverStats.memoryDetails")}</div>
                      {/* htop-style memory bar */}
                      {serverStats.memTotal !== null && (
                        <div className="space-y-1.5">
                          <div className="w-full h-3 bg-muted rounded overflow-hidden flex">
                            {/* Used (green) */}
                            {serverStats.memUsed !== null && serverStats.memUsed > 0 && (
                              <div
                                className="h-full bg-emerald-500"
                                style={{ width: `${(serverStats.memUsed / serverStats.memTotal) * 100}%` }}
                                title={`${t("terminal.serverStats.memUsed")}: ${(serverStats.memUsed / 1024).toFixed(1)}G`}
                              />
                            )}
                            {/* Buffers (blue) */}
                            {serverStats.memBuffers !== null && serverStats.memBuffers > 0 && (
                              <div
                                className="h-full bg-blue-500"
                                style={{ width: `${(serverStats.memBuffers / serverStats.memTotal) * 100}%` }}
                                title={`${t("terminal.serverStats.memBuffers")}: ${(serverStats.memBuffers / 1024).toFixed(1)}G`}
                              />
                            )}
                            {/* Cached (amber/orange) */}
                            {serverStats.memCached !== null && serverStats.memCached > 0 && (
                              <div
                                className="h-full bg-amber-500"
                                style={{ width: `${(serverStats.memCached / serverStats.memTotal) * 100}%` }}
                                title={`${t("terminal.serverStats.memCached")}: ${(serverStats.memCached / 1024).toFixed(1)}G`}
                              />
                            )}
                          </div>
                          {/* Legend */}
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-emerald-500" />
                              <span>{t("terminal.serverStats.memUsed")}: {serverStats.memUsed !== null ? `${(serverStats.memUsed / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-blue-500" />
                              <span>{t("terminal.serverStats.memBuffers")}: {serverStats.memBuffers !== null ? `${(serverStats.memBuffers / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-amber-500" />
                              <span>{t("terminal.serverStats.memCached")}: {serverStats.memCached !== null ? `${(serverStats.memCached / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-muted border border-border" />
                              <span>{t("terminal.serverStats.memFree")}: {serverStats.memFree !== null ? `${(serverStats.memFree / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Swap bar */}
                      {serverStats.swapTotal !== null && serverStats.swapTotal > 0 && (
                        <div className="space-y-1.5">
                          <div className="font-medium text-[11px] text-muted-foreground">{t("terminal.serverStats.swap")}</div>
                          <div className="w-full h-3 bg-muted rounded overflow-hidden flex">
                            {serverStats.swapUsed !== null && serverStats.swapUsed > 0 && (
                              <div
                                className="h-full bg-rose-500"
                                style={{ width: `${(serverStats.swapUsed / serverStats.swapTotal) * 100}%` }}
                                title={`${t("terminal.serverStats.swapUsed")}: ${(serverStats.swapUsed / 1024).toFixed(1)}G`}
                              />
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-rose-500" />
                              <span>{t("terminal.serverStats.swapUsed")}: {serverStats.swapUsed !== null ? `${(serverStats.swapUsed / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-sm bg-muted border border-border" />
                              <span>{t("terminal.serverStats.swapFree")}: {serverStats.swapTotal !== null && serverStats.swapUsed !== null ? `${((serverStats.swapTotal - serverStats.swapUsed) / 1024).toFixed(1)}G` : '--'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">{t("terminal.serverStats.swapTotal")}: {`${(serverStats.swapTotal / 1024).toFixed(1)}G`}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Top 10 processes */}
                      {serverStats.topProcesses.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="font-medium text-[11px] text-muted-foreground">{t("terminal.serverStats.topProcesses")}</div>
                          <div className="space-y-0.5 max-h-[150px] overflow-y-auto">
                            {serverStats.topProcesses.map((proc, index) => (
                              <div key={index} className="flex items-center gap-2 text-[10px]">
                                <span className="w-[32px] text-right text-muted-foreground">{proc.memPercent.toFixed(1)}%</span>
                                <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-emerald-500 rounded-full"
                                    style={{ width: `${Math.min(100, proc.memPercent * 2)}%` }}
                                  />
                                </div>
                                <span className="flex-shrink-0 font-mono truncate max-w-[140px]" title={proc.command}>
                                  {proc.command.split('/').pop()?.split(' ')[0] || proc.command}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </HoverCardContent>
                </HoverCard>
                {/* Disk - with HoverCard for disk details */}
                <HoverCard openDelay={200} closeDelay={100}>
                  <HoverCardTrigger asChild>
                    <button
                      className="flex items-center gap-0.5 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                      title={t("terminal.serverStats.disk")}
                    >
                      <HardDrive size={10} className="flex-shrink-0" />
                      <span className={cn(
                        serverStats.diskPercent !== null && serverStats.diskPercent >= 90 && "text-red-400",
                        serverStats.diskPercent !== null && serverStats.diskPercent >= 80 && serverStats.diskPercent < 90 && "text-amber-400"
                      )}>
                        {serverStats.diskUsed !== null && serverStats.diskTotal !== null && serverStats.diskPercent !== null
                          ? `${serverStats.diskUsed}/${serverStats.diskTotal}G (${serverStats.diskPercent}%)`
                          : serverStats.diskPercent !== null
                            ? `${serverStats.diskPercent}%`
                            : '--'}
                      </span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    className="w-auto p-3"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                  >
                    <div className="text-xs space-y-2">
                      <div className="font-medium text-sm mb-2">{t("terminal.serverStats.diskDetails")}</div>
                      {serverStats.disks.length > 0 ? (
                        <div className="space-y-2 max-h-[200px] overflow-y-auto">
                          {serverStats.disks.map((disk, index) => (
                            <div key={index} className="flex flex-col gap-1 min-w-[180px]">
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px]" title={disk.mountPoint}>
                                  {disk.mountPoint}
                                </span>
                                <span className={cn(
                                  "text-[11px] font-medium whitespace-nowrap",
                                  disk.percent >= 90 ? "text-red-400" : disk.percent >= 80 ? "text-amber-400" : "text-emerald-400"
                                )}>
                                  {disk.used}/{disk.total}G ({disk.percent}%)
                                </span>
                              </div>
                              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all",
                                    disk.percent >= 90 ? "bg-red-500" : disk.percent >= 80 ? "bg-amber-500" : "bg-emerald-500"
                                  )}
                                  style={{ width: `${disk.percent}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-muted-foreground">{t("terminal.serverStats.noData")}</div>
                      )}
                    </div>
                  </HoverCardContent>
                </HoverCard>
                {/* Network - with HoverCard for per-interface details */}
                {serverStats.netInterfaces.length > 0 && (
                  <HoverCard openDelay={200} closeDelay={100}>
                    <HoverCardTrigger asChild>
                      <button
                        className="flex items-center gap-1 hover:opacity-100 opacity-80 transition-opacity cursor-pointer flex-shrink-0"
                        title={t("terminal.serverStats.network")}
                      >
                        <ArrowDownToLine size={9} className="flex-shrink-0 text-emerald-400" />
                        <span>{formatNetSpeed(serverStats.netRxSpeed)}</span>
                        <ArrowUpFromLine size={9} className="flex-shrink-0 text-sky-400" />
                        <span>{formatNetSpeed(serverStats.netTxSpeed)}</span>
                      </button>
                    </HoverCardTrigger>
                    <HoverCardContent
                      className="w-auto p-3"
                      side="bottom"
                      align="start"
                      sideOffset={8}
                    >
                      <div className="text-xs space-y-2">
                        <div className="font-medium text-sm mb-2">{t("terminal.serverStats.networkDetails")}</div>
                        <div className="space-y-2 max-h-[200px] overflow-y-auto">
                          {serverStats.netInterfaces.map((iface, index) => (
                            <div key={index} className="flex items-center justify-between gap-4 min-w-[200px]">
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {iface.name}
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="flex items-center gap-0.5 text-emerald-400">
                                  <ArrowDownToLine size={9} />
                                  {formatNetSpeed(iface.rxSpeed)}
                                </span>
                                <span className="flex items-center gap-0.5 text-sky-400">
                                  <ArrowUpFromLine size={9} />
                                  {formatNetSpeed(iface.txSpeed)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                )}
              </div>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {inWorkspace && onToggleBroadcast && (
                <Button
                  variant="secondary"
                  size="icon"
                  className={cn(
                    "h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)]",
                    "bg-transparent hover:bg-transparent",
                    isBroadcastEnabled && "text-green-500",
                  )}
                  onClick={onToggleBroadcast}
                  title={
                    isBroadcastEnabled
                      ? t("terminal.toolbar.broadcastDisable")
                      : t("terminal.toolbar.broadcastEnable")
                  }
                  aria-label={
                    isBroadcastEnabled
                      ? t("terminal.toolbar.broadcastDisable")
                      : t("terminal.toolbar.broadcastEnable")
                  }
                >
                  <Radio size={12} />
                </Button>
              )}
              {inWorkspace && !isFocusMode && onExpandToFocus && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent"
                  onClick={onExpandToFocus}
                  title={t("terminal.toolbar.focusMode")}
                  aria-label={t("terminal.toolbar.focusMode")}
                >
                  <Maximize2 size={12} />
                </Button>
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
          className="h-full flex-1 min-w-0 relative overflow-hidden pt-8"
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

          {/* Autocomplete popup — rendered via Portal to escape overflow:hidden */}
          {isVisible && autocomplete.state.popupVisible && autocomplete.state.suggestions.length > 0 &&
            ReactDOM.createPortal(
              <AutocompletePopup
                suggestions={autocomplete.state.suggestions}
                selectedIndex={autocomplete.state.selectedIndex}
                position={autocomplete.state.popupPosition}
                cursorLineTop={autocomplete.state.popupCursorLineTop}
                cursorLineBottom={autocomplete.state.popupCursorLineBottom}
                visible={autocomplete.state.popupVisible}
                expandUpward={autocomplete.state.expandUpward}
                themeColors={effectiveTheme.colors}
                onSelect={autocomplete.selectSuggestion}
                subDirPanels={autocomplete.state.subDirPanels}
                subDirFocusLevel={autocomplete.state.subDirFocusLevel}
                containerRef={containerRef}
                onRequestReposition={autocomplete.repositionPopup}
                searchBarOffset={isSearchOpen ? 64 : 30}
                onDismiss={autocompleteClosePopup}
              />,
              document.body,
            )
          }

          {needsHostKeyVerification && pendingHostKeyInfo && (
            <div className="absolute inset-0 z-30 bg-background">
              <KnownHostConfirmDialog
                host={host}
                hostKeyInfo={pendingHostKeyInfo}
                onClose={handleHostKeyClose}
                onContinue={handleHostKeyContinue}
                onAddAndContinue={handleHostKeyAddAndContinue}
              />
            </div>
          )}

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
        </div>

        {/* Compose Bar (solo sessions only; workspace uses TerminalLayer's global bar) */}
        {isComposeBarOpen && !inWorkspace && (
          <TerminalComposeBar
            onSend={(text) => {
              if (sessionRef.current) {
                const payload = text + '\r';
                terminalBackend.writeToSession(sessionRef.current, payload);
                scrollToBottomAfterProgrammaticInput(payload);
                onBroadcastInput?.(payload, sessionRef.current);
              }
            }}
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
};

const Terminal = memo(TerminalComponent);
Terminal.displayName = "Terminal";

export default Terminal;
