import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Cpu, HardDrive, Maximize2, MemoryStick, Radio, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useI18n } from "../application/i18n/I18nProvider";
import { logger } from "../lib/logger";
import { cn } from "../lib/utils";
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
import { resolveHostAuth } from "../domain/sshAuth";
import { useTerminalBackend } from "../application/state/useTerminalBackend";
import KnownHostConfirmDialog, { HostKeyInfo } from "./KnownHostConfirmDialog";
import SFTPModal from "./SFTPModal";
import { Button } from "./ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { toast } from "./ui/toast";
import { useAvailableFonts } from "../application/state/fontStore";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";

import { TerminalConnectionDialog } from "./terminal/TerminalConnectionDialog";
import { TerminalToolbar } from "./terminal/TerminalToolbar";
import { TerminalContextMenu } from "./terminal/TerminalContextMenu";
import { TerminalSearchBar } from "./terminal/TerminalSearchBar";
import { createTerminalSessionStarters, type PendingAuth } from "./terminal/runtime/createTerminalSessionStarters";
import { createXTermRuntime, type XTermRuntime } from "./terminal/runtime/createXTermRuntime";
import { XTERM_PERFORMANCE_CONFIG } from "../infrastructure/config/xtermPerformance";
import { useTerminalSearch } from "./terminal/hooks/useTerminalSearch";
import { useTerminalContextActions } from "./terminal/hooks/useTerminalContextActions";
import { useTerminalAuthState } from "./terminal/hooks/useTerminalAuthState";
import { useServerStats } from "./terminal/hooks/useServerStats";
import { extractDropEntries, getPathForFile, DropEntry } from "../lib/sftpFileUtils";

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
  allHosts?: Host[];
  knownHosts?: KnownHost[];
  isVisible: boolean;
  inWorkspace?: boolean;
  isResizing?: boolean;
  isFocusMode?: boolean;
  isFocused?: boolean;
  fontFamilyId: string;
  fontSize: number;
  terminalTheme: TerminalTheme;
  terminalSettings?: TerminalSettings;
  sessionId: string;
  startupCommand?: string;
  serialConfig?: SerialConfig;
  onUpdateTerminalThemeId?: (themeId: string) => void;
  onUpdateTerminalFontFamilyId?: (fontFamilyId: string) => void;
  onUpdateTerminalFontSize?: (fontSize: number) => void;
  hotkeyScheme?: "disabled" | "mac" | "pc";
  keyBindings?: KeyBinding[];
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onStatusChange?: (sessionId: string, status: TerminalSession["status"]) => void;
  onSessionExit?: (sessionId: string) => void;
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
  isBroadcastEnabled?: boolean;
  onToggleBroadcast?: () => void;
  onBroadcastInput?: (data: string, sourceSessionId: string) => void;
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
  allHosts = [],
  knownHosts: _knownHosts = [],
  isVisible,
  inWorkspace,
  isResizing,
  isFocusMode,
  isFocused,
  fontFamilyId,
  fontSize,
  terminalTheme,
  terminalSettings,
  sessionId,
  startupCommand,
  serialConfig,
  onUpdateTerminalThemeId,
  onUpdateTerminalFontFamilyId,
  onUpdateTerminalFontSize,
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
  isBroadcastEnabled,
  onToggleBroadcast,
  onBroadcastInput,
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
  const disposeDataRef = useRef<(() => void) | null>(null);
  const disposeExitRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const hasRunStartupCommandRef = useRef(false);
  const commandBufferRef = useRef<string>("");
  const serialLineBufferRef = useRef<string>("");

  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;

  useEffect(() => {
    if (xtermRuntimeRef.current) {
      xtermRuntimeRef.current.keywordHighlighter.setRules(
        terminalSettings?.keywordHighlightRules ?? [],
        terminalSettings?.keywordHighlightEnabled ?? false
      );
    }
  }, [terminalSettings?.keywordHighlightEnabled, terminalSettings?.keywordHighlightRules]);

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

  const terminalBackend = useTerminalBackend();
  const { resizeSession } = terminalBackend;



  const [isScriptsOpen, setIsScriptsOpen] = useState(false);
  const [status, setStatus] = useState<TerminalSession["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const lastToastedErrorRef = useRef<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [timeLeft, setTimeLeft] = useState(CONNECTION_TIMEOUT / 1000);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showSFTP, setShowSFTP] = useState(false);
  const [sftpInitialPath, setSftpInitialPath] = useState<string | undefined>(undefined);
  const [progressValue, setProgressValue] = useState(15);
  const [hasSelection, setHasSelection] = useState(false);

  const statusRef = useRef<TerminalSession["status"]>(status);
  statusRef.current = status;

  const [chainProgress, setChainProgress] = useState<{
    currentHop: number;
    totalHops: number;
    currentHostLabel: string;
  } | null>(null);

  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [pendingUploadEntries, setPendingUploadEntries] = useState<DropEntry[]>([]);

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

  // Check if this is a local or serial connection (doesn't need connection dialog during connecting)
  const isLocalConnection = host.protocol === "local";
  const isSerialConnection = host.protocol === "serial";

  // Server stats (CPU, Memory, Disk) for Linux servers
  const { stats: serverStats } = useServerStats({
    sessionId,
    enabled: terminalSettings?.showServerStats ?? true,
    refreshInterval: terminalSettings?.serverStatsRefreshInterval ?? 5,
    isLinux: host.os === 'linux',
    isConnected: status === 'connected',
  });

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

  const effectiveTheme = useMemo(() => {
    if (host.theme) {
      const hostTheme = TERMINAL_THEMES.find((t) => t.id === host.theme);
      if (hostTheme) return hostTheme;
    }
    return terminalTheme;
  }, [host.theme, terminalTheme]);

  const resolvedChainHosts =
    (host.hostChain?.hostIds
      ?.map((id) => allHosts.find((h) => h.id === id))
      .filter(Boolean) as Host[]) || [];

  const updateStatus = (next: TerminalSession["status"]) => {
    setStatus(next);
    hasConnectedRef.current = next === "connected";
    onStatusChange?.(sessionId, next);
  };

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
    terminalSettings,
    terminalBackend,
    serialConfig,
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
    onSessionExit,
    onTerminalDataCapture,
    onOsDetected,
    onCommandExecuted,
  });
  sessionStartersRef.current = sessionStarters;

  useEffect(() => {
    let disposed = false;
    setError(null);
    hasConnectedRef.current = false;
    setProgressLogs([]);
    setShowLogs(false);
    setIsCancelling(false);

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
        });

        xtermRuntimeRef.current = runtime;
        termRef.current = runtime.term;
        fitAddonRef.current = runtime.fitAddon;
        serializeAddonRef.current = runtime.serializeAddon;
        searchAddonRef.current = runtime.searchAddon;

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
      if (onTerminalDataCapture && serializeAddonRef.current) {
        try {
          const terminalData = serializeAddonRef.current.serialize();
          logger.info("[Terminal] Capturing data on unmount", { sessionId, dataLength: terminalData.length });
          onTerminalDataCapture(sessionId, terminalData);
        } catch (err) {
          logger.warn("Failed to serialize terminal data on unmount:", err);
        }
      }
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Effect only runs on host.id/sessionId change, internal functions are stable
  }, [host.id, sessionId]);

  // Connection timeline and timeout visuals
  useEffect(() => {
    if (status !== "connecting" || auth.needsAuth) return;

    // Local terminal and serial connections don't need timeout/progress UI
    if (isLocalConnection || isSerialConnection) return;

    // Only show SSH-specific scripted logs for SSH connections
    const isSSH = host.protocol !== "telnet";

    let stepTimer: ReturnType<typeof setInterval> | undefined;
    if (isSSH) {
      const scripted = [
        "Resolving host and keys...",
        "Negotiating ciphers...",
        "Exchanging keys...",
        "Authenticating user...",
        "Waiting for server greeting...",
      ];
      let idx = 0;
      stepTimer = setInterval(() => {
        setProgressLogs((prev) => {
          if (idx >= scripted.length) return prev;
          const next = scripted[idx++];
          return prev.includes(next) ? prev : [...prev, next];
        });
      }, 900);
    }

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
      if (stepTimer) clearInterval(stepTimer);
      clearInterval(countdown);
      clearTimeout(timeout);
      clearInterval(prog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateStatus is a stable internal helper
  }, [status, auth.needsAuth, host.protocol, host.hostname]);

  const safeFit = () => {
    const fitAddon = fitAddonRef.current;
    if (!fitAddon) return;

    const runFit = () => {
      try {
        fitAddon.fit();
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

  useEffect(() => {
    if (termRef.current) {
      const effectiveFontSize = host.fontSize || fontSize;
      termRef.current.options.fontSize = effectiveFontSize;

      termRef.current.options.theme = {
        ...effectiveTheme.colors,
        selectionBackground: effectiveTheme.colors.selection,
      };

      if (terminalSettings) {
        termRef.current.options.cursorStyle = terminalSettings.cursorShape;
        termRef.current.options.cursorBlink = terminalSettings.cursorBlink;
        termRef.current.options.scrollback = terminalSettings.scrollback;
        termRef.current.options.fontWeight = terminalSettings.fontWeight as
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
          const weightSpec = `${terminalSettings.fontWeightBold} ${effectiveFontSize}px ${fontFamily}`;
          return document.fonts.check(weightSpec)
            ? terminalSettings.fontWeightBold
            : terminalSettings.fontWeight;
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
        termRef.current.options.scrollOnUserInput = terminalSettings.scrollOnInput;
        termRef.current.options.altClickMovesCursor = !terminalSettings.altAsMeta;
        termRef.current.options.wordSeparator = terminalSettings.wordSeparators;
      }

      setTimeout(() => safeFit(), 50);
    }
  }, [fontSize, effectiveTheme, terminalSettings, host.fontSize]);

  useEffect(() => {
    if (termRef.current) {
      const effectiveFontSize = host.fontSize || fontSize;
      termRef.current.options.fontSize = effectiveFontSize;

      const hostFontId = host.fontFamily || fontFamilyId || "menlo";
      const fontObj = availableFonts.find((f) => f.id === hostFontId) || availableFonts[0];
      termRef.current.options.fontFamily = fontObj.family;

      termRef.current.options.theme = {
        ...effectiveTheme.colors,
        selectionBackground: effectiveTheme.colors.selection,
      };

      setTimeout(() => safeFit(), 50);
    }
  }, [host.fontSize, host.fontFamily, host.theme, fontFamilyId, fontSize, effectiveTheme, availableFonts]);

  useEffect(() => {
    if (isVisible && fitAddonRef.current) {
      const timer = setTimeout(() => safeFit(), 50);
      return () => clearTimeout(timer);
    }
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
          const effectiveFontSize = host.fontSize || fontSize;
          if (typeof document !== "undefined" && document.fonts?.check) {
            const weightSpec = `${terminalSettings.fontWeightBold} ${effectiveFontSize}px ${fontFamily}`;
            const resolvedBold = document.fonts.check(weightSpec)
              ? terminalSettings.fontWeightBold
              : terminalSettings.fontWeight;
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
  }, [host.id, host.fontFamily, host.fontSize, fontFamilyId, fontSize, resizeSession, sessionId, terminalSettings]);

  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver(() => {
      if (isResizing) return;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        safeFit();
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
        safeFit();
      }, 100);
      return () => clearTimeout(timer);
    }
    prevIsResizingRef.current = isResizing;
  }, [isResizing, isVisible]);

  useEffect(() => {
    if (!isVisible || !fitAddonRef.current) return;
    const timer = setTimeout(() => {
      safeFit();
    }, 100);
    return () => clearTimeout(timer);
  }, [inWorkspace, isVisible]);

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

      if (hasText && terminalSettings?.copyOnSelect) {
        navigator.clipboard.writeText(selection).catch((err) => {
          logger.warn("Copy on select failed:", err);
        });
      }
    };

    term.onSelectionChange(onSelectionChange);
  }, [terminalSettings?.copyOnSelect]);

  useEffect(() => {
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        safeFit();
      }, 250);
    };

    window.addEventListener("resize", handler);
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      window.removeEventListener("resize", handler);
    };
  }, []);

  const terminalContextActions = useTerminalContextActions({
    termRef,
    sessionRef,
    terminalBackend,
    onHasSelectionChange: setHasSelection,
  });

  const handleSnippetClick = (cmd: string) => {
    if (sessionRef.current) {
      terminalBackend.writeToSession(sessionRef.current, `${cmd}\r`);
      setIsScriptsOpen(false);
      termRef.current?.focus();
      return;
    }
    termRef.current?.writeln("\r\n[No active SSH session]");
  };

  const handleOpenSFTP = async () => {
    // If SFTP is already open, toggle it off
    if (showSFTP) {
      setShowSFTP(false);
      return;
    }

    // Try to get the current working directory from the terminal session
    let initialPath: string | undefined = undefined;
    if (sessionRef.current) {
      try {
        const result = await terminalBackend.getSessionPwd(sessionRef.current);
        if (result.success && result.cwd) {
          initialPath = result.cwd;
        }
      } catch {
        // Silently fail and open SFTP without initial path
      }
    }

    // Use flushSync to ensure initialPath state is committed before opening SFTP modal
    // This prevents React's batching from causing the modal to open with stale/undefined initialPath
    flushSync(() => {
      setSftpInitialPath(initialPath);
    });
    setShowSFTP(true);
  };

  const handleCancelConnect = () => {
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
    auth.resetForRetry();
    setStatus("connecting");
    setError(null);
    setProgressLogs(["Retrying secure channel..."]);
    setShowLogs(true);
    if (host.protocol === "local" || host.hostname === "localhost") {
      sessionStarters.startLocal(termRef.current);
    } else {
      sessionStarters.startSSH(termRef.current);
    }
  };

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
          termRef.current.focus();
        }
      } else {
        // Remote terminal: Trigger SFTP upload
        // Get current working directory for SFTP initial path
        let initialPath: string | undefined = undefined;
        if (sessionRef.current) {
          try {
            const result = await terminalBackend.getSessionPwd(sessionRef.current);
            if (result.success && result.cwd) {
              initialPath = result.cwd;
            }
          } catch {
            // Silently fail and open SFTP without initial path
          }
        }

        setPendingUploadEntries(dropEntries);
        // Use flushSync to ensure sftpInitialPath is updated synchronously
        // before setShowSFTP(true) triggers the modal open
        flushSync(() => {
          setSftpInitialPath(initialPath);
        });
        setShowSFTP(true);
      }
    } catch (error) {
      logger.error("Failed to handle file drop", error);
      toast.error(t("terminal.dragDrop.errorMessage"), t("terminal.dragDrop.errorTitle"));
    }
  };

  const renderControls = (opts?: { showClose?: boolean }) => (
    <TerminalToolbar
      status={status}
      snippets={snippets}
      host={host}
      defaultThemeId={terminalTheme.id}
      defaultFontFamilyId={fontFamilyId}
      defaultFontSize={fontSize}
      onUpdateTerminalThemeId={onUpdateTerminalThemeId}
      onUpdateTerminalFontFamilyId={onUpdateTerminalFontFamilyId}
      onUpdateTerminalFontSize={onUpdateTerminalFontSize}
      isScriptsOpen={isScriptsOpen}
      setIsScriptsOpen={setIsScriptsOpen}
      onOpenSFTP={handleOpenSFTP}
      onSnippetClick={handleSnippetClick}
      onUpdateHost={onUpdateHost}
      showClose={opts?.showClose}
      onClose={() => onCloseSession?.(sessionId)}
      isSearchOpen={isSearchOpen}
      onToggleSearch={handleToggleSearch}
    />
  );

  const statusDotTone =
    status === "connected"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : "bg-rose-500";
  const _isConnecting = status === "connecting";
  const _hasError = Boolean(error);

  return (
    <TerminalContextMenu
      hasSelection={hasSelection}
      hotkeyScheme={hotkeyScheme}
      keyBindings={keyBindings}
      rightClickBehavior={terminalSettings?.rightClickBehavior}
      onCopy={terminalContextActions.onCopy}
      onPaste={terminalContextActions.onPaste}
      onSelectAll={terminalContextActions.onSelectAll}
      onClear={terminalContextActions.onClear}
      onSelectWord={terminalContextActions.onSelectWord}
      onSplitHorizontal={onSplitHorizontal}
      onSplitVertical={onSplitVertical}
      onClose={inWorkspace ? () => onCloseSession?.(sessionId) : undefined}
    >
      <div 
        className="relative h-full w-full flex overflow-hidden bg-gradient-to-br from-[#050910] via-[#06101a] to-[#0b1220]"
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
            className="flex items-center gap-1 px-2 py-0.5 backdrop-blur-md pointer-events-auto min-w-0 border-b-[0.5px]"
            style={{
              backgroundColor: effectiveTheme.colors.background,
              color: effectiveTheme.colors.foreground,
              borderColor: `color-mix(in srgb, ${effectiveTheme.colors.foreground} 8%, ${effectiveTheme.colors.background} 92%)`,
              ['--terminal-toolbar-fg' as never]: effectiveTheme.colors.foreground,
              ['--terminal-toolbar-bg' as never]: effectiveTheme.colors.background,
              ['--terminal-toolbar-btn' as never]: `color-mix(in srgb, ${effectiveTheme.colors.background} 88%, ${effectiveTheme.colors.foreground} 12%)`,
              ['--terminal-toolbar-btn-hover' as never]: `color-mix(in srgb, ${effectiveTheme.colors.background} 78%, ${effectiveTheme.colors.foreground} 22%)`,
              ['--terminal-toolbar-btn-active' as never]: `color-mix(in srgb, ${effectiveTheme.colors.background} 68%, ${effectiveTheme.colors.foreground} 32%)`,
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
            {/* Server Stats Display - Linux only */}
            {host.os === 'linux' && terminalSettings?.showServerStats && status === 'connected' && serverStats.lastUpdated && (
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
          className="h-full flex-1 min-w-0 transition-all duration-300 relative overflow-hidden pt-8"
          style={{ backgroundColor: effectiveTheme.colors.background }}
        >
          <div
            ref={containerRef}
            className="absolute inset-x-0 bottom-0"
            style={{
              top: isSearchOpen ? "64px" : "30px",
              paddingLeft: 6,
              backgroundColor: effectiveTheme.colors.background,
            }}
          />

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

          {/* Connection dialog: skip for local/serial during connecting phase, but show on error */}
          {status !== "connected" && !needsHostKeyVerification && !(
            (isLocalConnection || isSerialConnection) && status === "connecting"
          ) && (
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
                onCancel: handleCancelConnect,
                onRetry: handleRetry,
              }}
            />
          )}
        </div>

        <SFTPModal
          host={host}
          credentials={(() => {
            const resolvedAuth = resolveHostAuth({ host, keys, identities });

            // Build proxy config if present
            const proxyConfig = host.proxyConfig
              ? {
                type: host.proxyConfig.type,
                host: host.proxyConfig.host,
                port: host.proxyConfig.port,
                username: host.proxyConfig.username,
                password: host.proxyConfig.password,
              }
              : undefined;

            // Build jump hosts array if host chain is configured
            let jumpHosts: NetcattyJumpHost[] | undefined;
            if (host.hostChain?.hostIds && host.hostChain.hostIds.length > 0) {
              jumpHosts = host.hostChain.hostIds
                .map((hostId) => allHosts.find((h) => h.id === hostId))
                .filter((h): h is Host => !!h)
                .map((jumpHost) => {
                  const jumpAuth = resolveHostAuth({
                    host: jumpHost,
                    keys,
                    identities,
                  });
                  const jumpKey = jumpAuth.key;
                  return {
                    hostname: jumpHost.hostname,
                    port: jumpHost.port || 22,
                    username: jumpAuth.username || "root",
                    password: jumpAuth.password,
                    privateKey: jumpKey?.privateKey,
                    certificate: jumpKey?.certificate,
                    passphrase: jumpAuth.passphrase || jumpKey?.passphrase,
                    publicKey: jumpKey?.publicKey,
                    keyId: jumpAuth.keyId,
                    keySource: jumpKey?.source,
                    label: jumpHost.label,
                  };
                });
            }

            return {
              username: resolvedAuth.username,
              hostname: host.hostname,
              port: host.port,
              password: resolvedAuth.password,
              privateKey: resolvedAuth.key?.privateKey,
              certificate: resolvedAuth.key?.certificate,
              passphrase: resolvedAuth.passphrase,
              publicKey: resolvedAuth.key?.publicKey,
              keyId: resolvedAuth.keyId,
              keySource: resolvedAuth.key?.source,
              proxy: proxyConfig,
              jumpHosts: jumpHosts && jumpHosts.length > 0 ? jumpHosts : undefined,
              sftpSudo: host.sftpSudo,
            };
          })()}
          open={showSFTP && status === "connected"}
          onClose={() => {
            setShowSFTP(false);
            setPendingUploadEntries([]);
          }}
          initialPath={sftpInitialPath}
          initialEntriesToUpload={pendingUploadEntries}
        />
      </div>
    </TerminalContextMenu>
  );
};

const Terminal = memo(TerminalComponent);
Terminal.displayName = "Terminal";

export default Terminal;
