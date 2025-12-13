import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Maximize2 } from "lucide-react";
import React, { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { logger } from "../lib/logger";
import { cn } from "../lib/utils";
import {
  Host,
  KnownHost,
  SSHKey,
  Snippet,
  TerminalSession,
  TerminalTheme,
  TerminalSettings,
  KeyBinding,
} from "../types";
import { checkAppShortcut, getAppLevelActions, getTerminalPassthroughActions } from "../application/state/useGlobalHotkeys";
import { useTerminalBackend } from "../application/state/useTerminalBackend";
import KnownHostConfirmDialog, { HostKeyInfo } from "./KnownHostConfirmDialog";
import SFTPModal from "./SFTPModal";
import { Button } from "./ui/button";
import { toast } from "./ui/toast";
import { TERMINAL_FONTS } from "../infrastructure/config/fonts";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";

// Import terminal sub-components
import { TerminalConnectionDialog } from "./terminal/TerminalConnectionDialog";
import { TerminalToolbar } from "./terminal/TerminalToolbar";
import { TerminalContextMenu } from "./terminal/TerminalContextMenu";
import { TerminalSearchBar } from "./terminal/TerminalSearchBar";
import { createHighlightProcessor } from "./terminal/keywordHighlight";
import {
  XTERM_PERFORMANCE_CONFIG,
  type XTermPlatform,
  resolveXTermPerformanceConfig,
} from "../infrastructure/config/xtermPerformance";

interface TerminalProps {
  host: Host;
  keys: SSHKey[];
  snippets: Snippet[];
  allHosts?: Host[]; // All hosts for chain resolution
  knownHosts?: KnownHost[]; // Known hosts for verification
  isVisible: boolean;
  inWorkspace?: boolean;
  isResizing?: boolean;
  isFocusMode?: boolean; // Whether workspace is in focus mode
  isFocused?: boolean; // Whether this terminal should have keyboard focus (for split views)
  fontSize: number;
  terminalTheme: TerminalTheme;
  terminalSettings?: TerminalSettings; // Global terminal settings
  sessionId: string;
  startupCommand?: string; // Command to run after connection (for snippet runner)
  // Hotkey configuration
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  keyBindings?: KeyBinding[];
  // Hotkey action callbacks
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onStatusChange?: (
    sessionId: string,
    status: TerminalSession["status"],
  ) => void;
  onSessionExit?: (sessionId: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onUpdateHost?: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void; // Callback to add host to known hosts
  onExpandToFocus?: () => void; // Callback to switch workspace to focus mode
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void; // Callback when a command is executed
  // Split actions
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
}

// xterm.js doesn't need async initialization like ghostty-web

const TerminalComponent: React.FC<TerminalProps> = ({
  host,
  keys,
  snippets,
  allHosts = [],
  knownHosts: _knownHosts = [], // Reserved for future host key verification UI
  isVisible,
  inWorkspace,
  isResizing,
  isFocusMode,
  isFocused,
  fontSize,
  terminalTheme,
  terminalSettings,
  sessionId,
  startupCommand,
  hotkeyScheme = 'disabled',
  keyBindings = [],
  onHotkeyAction,
  onStatusChange,
  onSessionExit,
  onOsDetected,
  onCloseSession,
  onUpdateHost,
  onAddKnownHost,
  onExpandToFocus,
  onCommandExecuted,
  onSplitHorizontal,
  onSplitVertical,
}) => {
  const CONNECTION_TIMEOUT = 12000;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const disposeDataRef = useRef<(() => void) | null>(null);
  const disposeExitRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const hasRunStartupCommandRef = useRef(false); // Track if startup command has been executed
  const commandBufferRef = useRef<string>(""); // Buffer for tracking typed commands

  // Ref to store latest terminalSettings for use in boot function (avoids stale closure)
  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;

  // Keyword highlight processor - processes terminal output for keyword highlighting
  const highlightProcessorRef = useRef<(text: string) => string>((t) => t);

  // Update highlight processor when settings change
  useEffect(() => {
    highlightProcessorRef.current = createHighlightProcessor(
      terminalSettings?.keywordHighlightRules ?? [],
      terminalSettings?.keywordHighlightEnabled ?? false
    );
  }, [terminalSettings?.keywordHighlightEnabled, terminalSettings?.keywordHighlightRules]);

  // Refs to store latest hotkey config for use in keyboard handler
  const hotkeySchemeRef = useRef(hotkeyScheme);
  const keyBindingsRef = useRef(keyBindings);
  const onHotkeyActionRef = useRef(onHotkeyAction);
  hotkeySchemeRef.current = hotkeyScheme;
  keyBindingsRef.current = keyBindings;
  onHotkeyActionRef.current = onHotkeyAction;

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
  const [progressValue, setProgressValue] = useState(15);
  const [hasSelection, setHasSelection] = useState(false);

  // Search state
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchMatchCount, setSearchMatchCount] = useState<{ current: number; total: number } | null>(null);
  const searchTermRef = useRef<string>(''); // Store current search term for findNext/findPrevious

  // Chain connection progress state
  const [chainProgress, setChainProgress] = useState<{
    currentHop: number;
    totalHops: number;
    currentHostLabel: string;
  } | null>(null);

  // Auth dialog state for hosts without credentials
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authRetryMessage, setAuthRetryMessage] = useState<string | null>(null); // Error message for auth retry
  const [authUsername, setAuthUsername] = useState(host.username || "root");
  const [authMethod, setAuthMethod] = useState<"password" | "key">("password");
  const [authPassword, setAuthPassword] = useState("");
  const [authKeyId, setAuthKeyId] = useState<string | null>(null);
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(true);

  useEffect(() => {
    if (!error) {
      lastToastedErrorRef.current = null;
      return;
    }
    if (lastToastedErrorRef.current === error) return;
    lastToastedErrorRef.current = error;
    toast.error(error, "Connection Error");
  }, [error]);

  // Pending connection credentials (set after auth dialog submit)
  const pendingAuthRef = useRef<{
    username: string;
    password?: string;
    keyId?: string;
  } | null>(null);

  // Known host verification state
  const [needsHostKeyVerification, setNeedsHostKeyVerification] =
    useState(false);
  const [pendingHostKeyInfo, setPendingHostKeyInfo] =
    useState<HostKeyInfo | null>(null);
  const pendingConnectionRef = useRef<(() => void) | null>(null);

  // Calculate effective theme: host-specific theme takes priority over global
  const effectiveTheme = useMemo(() => {
    if (host.theme) {
      const hostTheme = TERMINAL_THEMES.find(t => t.id === host.theme);
      if (hostTheme) return hostTheme;
    }
    return terminalTheme;
  }, [host.theme, terminalTheme]);

  // Resolve host chain to actual host objects
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
    termRef.current?.dispose();
    termRef.current = null;
    fitAddonRef.current?.dispose();
    fitAddonRef.current = null;
    serializeAddonRef.current?.dispose();
    serializeAddonRef.current = null;
    searchAddonRef.current?.dispose();
    searchAddonRef.current = null;
  };

  const runDistroDetection = async (key?: SSHKey) => {
    if (!terminalBackend.execAvailable()) return;
    try {
      const res = await terminalBackend.execCommand({
        hostname: host.hostname,
        username: host.username || "root",
        port: host.port || 22,
        password: host.password, // Always include for fallback
        privateKey: key?.privateKey,
        command: "cat /etc/os-release 2>/dev/null || uname -a",
        timeout: 8000,
      });
      const data = `${res.stdout || ""}\n${res.stderr || ""}`;
      const idMatch = data.match(/ID=([\\w\\-]+)/i);
      const distro = idMatch
        ? idMatch[1].replace(/"/g, "")
        : (data.split(/\\s+/)[0] || "").toLowerCase();
      if (distro) onOsDetected?.(host.id, distro);
    } catch (err) {
      logger.warn("OS probe failed", err);
    }
  };

  useEffect(() => {
    let disposed = false;
    // Don't set status yet - will determine after checking auth requirements
    setError(null);
    hasConnectedRef.current = false;
    setProgressLogs([]);
    setShowLogs(false);
    setIsCancelling(false);

    const boot = async () => {
      try {
        if (disposed || !containerRef.current) return;

        const platform: XTermPlatform = (() => {
          if (
            typeof process !== "undefined" &&
            (process.platform === "darwin" ||
              process.platform === "win32" ||
              process.platform === "linux")
          ) {
            return process.platform;
          }

          if (typeof navigator !== "undefined") {
            const ua = navigator.userAgent.toLowerCase();
            if (ua.includes("win")) return "win32";
            if (ua.includes("linux")) return "linux";
          }

          return "darwin";
        })();

        const deviceMemoryGb =
          typeof navigator !== "undefined" &&
            typeof (navigator as { deviceMemory?: number }).deviceMemory === "number"
            ? (navigator as { deviceMemory?: number }).deviceMemory
            : undefined;

        const performanceConfig = resolveXTermPerformanceConfig({
          platform,
          deviceMemoryGb,
        });

        // Get font family from host config or use default fallback
        const hostFontId = host.fontFamily || 'menlo';
        const fontObj = TERMINAL_FONTS.find(f => f.id === hostFontId) || TERMINAL_FONTS[0];
        const fontFamily = fontObj.family;

        // Use host-specific font size if available, otherwise use the global fontSize prop
        const effectiveFontSize = host.fontSize || fontSize;

        // Apply terminal settings with defaults (use ref to get latest values)
        const settings = terminalSettingsRef.current;
        const cursorStyle = settings?.cursorShape ?? 'block';
        const cursorBlink = settings?.cursorBlink ?? true;
        const scrollback = settings?.scrollback ?? 10000;
        const fontLigatures = settings?.fontLigatures ?? true;
        const drawBoldTextInBrightColors = settings?.drawBoldInBrightColors ?? true;
        const fontWeight = settings?.fontWeight ?? 400;
        const fontWeightBold = settings?.fontWeightBold ?? 700;
        // linePadding 0-10 maps to lineHeight 1.0-2.0
        const lineHeight = 1 + (settings?.linePadding ?? 0) / 10;
        const minimumContrastRatio = settings?.minimumContrastRatio ?? 1;
        const scrollOnUserInput = settings?.scrollOnInput ?? true;
        const altIsMeta = settings?.altAsMeta ?? false;
        const wordSeparator = settings?.wordSeparators ?? " ()[]{}'\"";

        const term = new XTerm({
          ...performanceConfig.options,
          fontSize: effectiveFontSize,
          fontFamily: fontFamily,
          fontWeight: fontWeight as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 'normal' | 'bold',
          fontWeightBold: fontWeightBold as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 'normal' | 'bold',
          lineHeight,
          cursorStyle,
          cursorBlink,
          scrollback,
          allowProposedApi: fontLigatures, // Required for font ligatures
          drawBoldTextInBrightColors,
          minimumContrastRatio,
          scrollOnUserInput,
          altClickMovesCursor: !altIsMeta, // If altAsMeta is true, don't use alt for cursor movement
          wordSeparator,
          theme: {
            ...terminalTheme.colors,
            selectionBackground: terminalTheme.colors.selection,
          },
        });

        type MaybeRenderer = {
          constructor?: { name?: string };
          type?: string;
        };

        type IntrospectableTerminal = XTerm & {
          _core?: {
            _renderService?: {
              _renderer?: MaybeRenderer;
            };
          };
          options?: {
            rendererType?: string;
          };
        };

        const logRenderer = (attempt = 0) => {
          // Peek into private renderer to tell if WebGL is active; stored on window for DevTools checks
          const introspected = term as IntrospectableTerminal;
          const renderer = introspected._core?._renderService?._renderer;
          const candidates = [
            renderer?.type,
            renderer?.constructor?.name,
            introspected.options?.rendererType,
          ];
          const rendererName =
            candidates.find((value) => typeof value === "string" && value.length > 0) ||
            undefined;
          const normalized = rendererName
            ? rendererName.toLowerCase().includes("webgl")
              ? "webgl"
              : rendererName.toLowerCase().includes("canvas")
                ? "canvas"
                : rendererName
            : "unknown";
          logger.info(`[XTerm] renderer=${normalized}`);
          const scopedWindow = window as Window & { __xtermRenderer?: string };
          scopedWindow.__xtermRenderer = normalized;
          if (normalized === "unknown" && attempt < 3) {
            setTimeout(() => logRenderer(attempt + 1), 150);
          }
        };

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        termRef.current = term;
        fitAddonRef.current = fitAddon;

        const serializeAddon = new SerializeAddon();
        term.loadAddon(serializeAddon);
        serializeAddonRef.current = serializeAddon;

        // Load search addon for terminal text search
        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;

        try {
          term.open(containerRef.current);

          // Load WebGL addon for GPU-accelerated rendering unless canvas is preferred for macOS/low-memory profiles
          let webglLoaded = false;
          const scopedWindow = window as Window & {
            __xtermWebGLLoaded?: boolean;
            __xtermRendererPreference?: string;
          };

          if (performanceConfig.useWebGLAddon) {
            try {
              // Try enabling the new glyph handler for faster glyph caching if supported by the addon version
              const webglAddon = (() => {
                const webglOptions: Record<string, unknown> = {
                  useCustomGlyphHandler: true,
                };
                try {
                  // xterm-addon-webgl >=0.18 supports this flag; older versions ignore/fail so we guard
                  const WebglCtor = WebglAddon as unknown as new (
                    options?: unknown,
                  ) => WebglAddon;
                  return new WebglCtor(webglOptions);
                } catch {
                  return new WebglAddon();
                }
              })();
              webglAddon.onContextLoss(() => {
                logger.warn("[XTerm] WebGL context loss detected, disposing addon");
                webglAddon.dispose();
              });
              term.loadAddon(webglAddon);
              webglLoaded = true;
            } catch (webglErr) {
              logger.warn(
                "[XTerm] WebGL addon failed, using canvas renderer. Error:",
                webglErr instanceof Error ? webglErr.message : webglErr,
              );
              // Canvas renderer will be used as fallback - it's actually faster on some Macs
            }
          } else {
            logger.info(
              "[XTerm] Skipping WebGL addon (canvas preferred for macOS profile or low-memory devices)",
            );
          }

          // Store whether WebGL was successfully loaded for diagnostics
          scopedWindow.__xtermWebGLLoaded = webglLoaded;
          scopedWindow.__xtermRendererPreference = performanceConfig.preferCanvasRenderer ? "canvas" : "webgl";

          // Load web links addon for clickable URLs
          const webLinksAddon = new WebLinksAddon((event, uri) => {
            // Check if the required modifier key is held (read from ref for real-time updates)
            const currentLinkModifier = terminalSettingsRef.current?.linkModifier ?? 'none';
            let shouldOpen = false;
            switch (currentLinkModifier) {
              case 'none':
                shouldOpen = true;
                break;
              case 'ctrl':
                shouldOpen = event.ctrlKey;
                break;
              case 'alt':
                shouldOpen = event.altKey;
                break;
              case 'meta':
                shouldOpen = event.metaKey;
                break;
            }
            if (shouldOpen) {
              // Open URL in default browser
              if (terminalBackend.openExternalAvailable()) {
                void terminalBackend.openExternal(uri);
              } else {
                window.open(uri, '_blank');
              }
            }
          });
          term.loadAddon(webLinksAddon);

          logRenderer();

          // Attach custom key event handler to intercept app-level shortcuts
          // This allows keyboard shortcuts to work even when terminal is focused
          // Always attach the handler - it will check the ref values dynamically
          const appLevelActions = getAppLevelActions();
          const terminalActions = getTerminalPassthroughActions();

          term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
            // Handle Ctrl+F / Cmd+F for search regardless of hotkey settings
            if ((e.ctrlKey || e.metaKey) && e.key === 'f' && e.type === 'keydown') {
              e.preventDefault();
              setIsSearchOpen(true);
              return false;
            }

            // Read current values from refs
            const currentScheme = hotkeySchemeRef.current;
            const currentBindings = keyBindingsRef.current;
            const hotkeyCallback = onHotkeyActionRef.current;

            // Skip if hotkeys are disabled
            if (currentScheme === 'disabled' || currentBindings.length === 0) {
              return true; // Let xterm handle it
            }

            const isMac = currentScheme === 'mac';

            // Check if this matches any of our shortcuts
            const matched = checkAppShortcut(e, currentBindings, isMac);
            if (!matched) return true; // Let xterm handle it

            const { action } = matched;

            // App-level actions: call the callback directly and prevent xterm from handling
            if (appLevelActions.has(action)) {
              e.preventDefault();
              if (hotkeyCallback) {
                hotkeyCallback(action, e);
              }
              return false;
            }

            // Terminal-level actions: handle here
            if (terminalActions.has(action)) {
              e.preventDefault();
              switch (action) {
                case 'copy': {
                  const selection = term.getSelection();
                  if (selection) {
                    navigator.clipboard.writeText(selection);
                  }
                  break;
                }
                case 'paste': {
                  navigator.clipboard.readText().then((text) => {
                    const id = sessionRef.current;
                    if (id) terminalBackend.writeToSession(id, text);
                  });
                  break;
                }
                case 'selectAll': {
                  term.selectAll();
                  break;
                }
                case 'clearBuffer': {
                  term.clear();
                  break;
                }
                case 'searchTerminal': {
                  // Open search UI
                  setIsSearchOpen(true);
                  break;
                }
              }
              return false;
            }

            return true; // Let xterm handle other keys
          });

          // Add middle-click paste support
          const middleClickPaste = settings?.middleClickPaste ?? true;
          if (middleClickPaste && containerRef.current) {
            const handleMiddleClick = async (e: MouseEvent) => {
              if (e.button === 1) { // Middle mouse button
                e.preventDefault();
                try {
                  const text = await navigator.clipboard.readText();
                  if (text && sessionRef.current) {
                    terminalBackend.writeToSession(sessionRef.current, text);
                  }
                } catch (err) {
                  logger.warn('[Terminal] Failed to paste from clipboard:', err);
                }
              }
            };
            containerRef.current.addEventListener('auxclick', handleMiddleClick);
            // Store cleanup function
            const container = containerRef.current;
            const cleanup = () => container.removeEventListener('auxclick', handleMiddleClick);
            // Add to disposal - we'll handle this in the main cleanup
            const originalDispose = disposeDataRef.current;
            disposeDataRef.current = () => {
              cleanup();
              originalDispose?.();
            };
          }

          fitAddon.fit();
          term.focus();
        } catch (openErr) {
          logger.error("[XTerm] Failed to open terminal:", openErr);
          throw openErr;
        }

        term.onData((data) => {
          const id = sessionRef.current;
          if (id) {
            terminalBackend.writeToSession(id, data);

            // Track command input for shell history
            if (status === "connected" && onCommandExecuted) {
              // Handle control characters
              if (data === "\r" || data === "\n") {
                // Enter pressed - command submitted
                const cmd = commandBufferRef.current.trim();
                if (cmd) {
                  onCommandExecuted(cmd, host.id, host.label, sessionId);
                }
                commandBufferRef.current = "";
              } else if (data === "\x7f" || data === "\b") {
                // Backspace - remove last character
                commandBufferRef.current = commandBufferRef.current.slice(
                  0,
                  -1,
                );
              } else if (data === "\x03") {
                // Ctrl+C - clear buffer
                commandBufferRef.current = "";
              } else if (data === "\x15") {
                // Ctrl+U - clear line
                commandBufferRef.current = "";
              } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
                // Regular printable character
                commandBufferRef.current += data;
              } else if (data.length > 1 && !data.startsWith("\x1b")) {
                // Pasted text (multiple chars, not escape sequence)
                commandBufferRef.current += data;
              }
            }
          }
        });

        // Add debouncing for resize events to prevent excessive calls on macOS
        let resizeTimeout: NodeJS.Timeout | null = null;
        const resizeDebounceMs = XTERM_PERFORMANCE_CONFIG.resize.debounceMs;
        term.onResize(({ cols, rows }) => {
          const id = sessionRef.current;
          if (id) {
            // Debounce resize to prevent rapid successive calls
            if (resizeTimeout) {
              clearTimeout(resizeTimeout);
            }
            resizeTimeout = setTimeout(() => {
              terminalBackend.resizeSession(id, cols, rows);
              resizeTimeout = null;
            }, resizeDebounceMs); // Debounce for smooth resizing on macOS
          }
        });

        if (host.protocol === "local" || host.hostname === "localhost") {
          setStatus("connecting");
          setProgressLogs(["Initializing local shell..."]);
          await startLocal(term);
        } else if (host.protocol === "telnet") {
          setStatus("connecting");
          setProgressLogs(["Initializing Telnet connection..."]);
          await startTelnet(term);
        } else if (host.moshEnabled) {
          setStatus("connecting");
          setProgressLogs(["Initializing Mosh connection..."]);
          await startMosh(term);
        } else {
          // SSH connection (default)
          // Check if host needs authentication info
          const hasPassword = host.authMethod === "password" && host.password;
          const hasKey = host.authMethod === "key" && host.identityFileId;
          const hasPendingAuth = pendingAuthRef.current;

          if (!hasPassword && !hasKey && !hasPendingAuth && !host.username) {
            // No auth info available - show auth dialog without starting connection
            setNeedsAuth(true);
            // Keep status as disconnected - don't trigger timeout timer
            setStatus("disconnected");
            return;
          }

          setStatus("connecting");
          setProgressLogs(["Initializing secure channel..."]);
          await startSSH(term);
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
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Effect only runs on host.id/sessionId change, internal functions are stable
  }, [host.id, sessionId]);

  // Connection timeline and timeout visuals
  useEffect(() => {
    // Don't run timeout timer when showing auth dialog (user is entering credentials)
    if (status !== "connecting" || needsAuth) return;
    const scripted = [
      "Resolving host and keys...",
      "Negotiating ciphers...",
      "Exchanging keys...",
      "Authenticating user...",
      "Waiting for server greeting...",
    ];
    let idx = 0;
    const stepTimer = setInterval(() => {
      setProgressLogs((prev) => {
        if (idx >= scripted.length) return prev;
        const next = scripted[idx++];
        return prev.includes(next) ? prev : [...prev, next];
      });
    }, 900);

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
        // Smooth asymptotic approach - slows down as it gets higher
        const remaining = 95 - prev;
        // Larger increment since we update less frequently (200ms instead of 100ms)
        const increment = Math.max(1, remaining * 0.15);
        return Math.min(95, prev + increment);
      });
    }, 200); // Reduced from 100ms to 200ms to cut re-renders in half

    return () => {
      clearInterval(stepTimer);
      clearInterval(countdown);
      clearTimeout(timeout);
      clearInterval(prog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateStatus is a stable internal helper
  }, [status, needsAuth]);

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

    if (XTERM_PERFORMANCE_CONFIG.resize.useRAF && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(runFit);
    } else {
      runFit();
    }
  };

  // Effect for global fontSize/terminalTheme/terminalSettings changes (from Settings)
  useEffect(() => {
    if (termRef.current) {
      // Only apply global settings if host doesn't have specific overrides
      const effectiveFontSize = host.fontSize || fontSize;
      termRef.current.options.fontSize = effectiveFontSize;

      // Use effectiveTheme which respects host-specific theme override
      termRef.current.options.theme = {
        ...effectiveTheme.colors,
        selectionBackground: effectiveTheme.colors.selection,
      };

      // Apply all terminal settings for real-time updates
      if (terminalSettings) {
        // Cursor settings
        termRef.current.options.cursorStyle = terminalSettings.cursorShape;
        termRef.current.options.cursorBlink = terminalSettings.cursorBlink;

        // Buffer settings
        termRef.current.options.scrollback = terminalSettings.scrollback;

        // Font settings
        termRef.current.options.fontWeight = terminalSettings.fontWeight as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
        termRef.current.options.fontWeightBold = terminalSettings.fontWeightBold as 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
        termRef.current.options.lineHeight = 1 + terminalSettings.linePadding / 10;
        termRef.current.options.drawBoldTextInBrightColors = terminalSettings.drawBoldInBrightColors;

        // Accessibility
        termRef.current.options.minimumContrastRatio = terminalSettings.minimumContrastRatio;

        // Input behavior
        termRef.current.options.scrollOnUserInput = terminalSettings.scrollOnInput;
        termRef.current.options.altClickMovesCursor = !terminalSettings.altAsMeta;
        termRef.current.options.wordSeparator = terminalSettings.wordSeparators;
      }

      // Refit after settings change (especially important for lineHeight changes)
      setTimeout(() => safeFit(), 50);
    }
  }, [fontSize, effectiveTheme, terminalSettings, host.fontSize]);

  // Effect for host-specific font/theme changes (from ThemeCustomizeModal)
  useEffect(() => {
    if (termRef.current) {
      // Apply host-specific font size
      const effectiveFontSize = host.fontSize || fontSize;
      termRef.current.options.fontSize = effectiveFontSize;

      // Apply host-specific font family
      const hostFontId = host.fontFamily || 'menlo';
      const fontObj = TERMINAL_FONTS.find(f => f.id === hostFontId) || TERMINAL_FONTS[0];
      termRef.current.options.fontFamily = fontObj.family;

      // Apply effective theme (host-specific or global)
      termRef.current.options.theme = {
        ...effectiveTheme.colors,
        selectionBackground: effectiveTheme.colors.selection,
      };

      // Refit after changes
      setTimeout(() => safeFit(), 50);
    }
  }, [host.fontSize, host.fontFamily, host.theme, fontSize, effectiveTheme]);

  // Separate effect for visibility-triggered fit (less frequent)
  useEffect(() => {
    if (isVisible && fitAddonRef.current) {
      // Small delay to ensure container is properly sized
      const timer = setTimeout(() => safeFit(), 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  // Re-fit once webfonts are ready so canvas sizing uses correct font metrics
  useEffect(() => {
    let cancelled = false;
    const waitForFonts = async () => {
      try {
        // FontFaceSet is available in modern browsers
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
  }, [host.id, sessionId, resizeSession]);

  // Debounced fit for resize operations - only fit when not actively resizing
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver(() => {
      // Skip fit during active resize drag
      if (isResizing) return;

      // Clear previous timeout
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      // Wait 250ms after last resize event before fitting (increased for performance)
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

  // Fit when resizing ends (isResizing changes from true to false)
  const prevIsResizingRef = useRef(isResizing);
  useEffect(() => {
    if (prevIsResizingRef.current && !isResizing && isVisible) {
      // Resizing just ended, fit the terminal
      const timer = setTimeout(() => {
        safeFit();
      }, 100);
      return () => clearTimeout(timer);
    }
    prevIsResizingRef.current = isResizing;
  }, [isResizing, isVisible]);

  // Re-fit when inWorkspace changes (terminal moves into/out of workspace)
  useEffect(() => {
    if (!isVisible || !fitAddonRef.current) return;
    // Delay fit to allow layout changes to complete
    const timer = setTimeout(() => {
      safeFit();
    }, 100);
    return () => clearTimeout(timer);
  }, [inWorkspace, isVisible]);

  // Auto-focus terminal when tab becomes visible (only for solo tabs, not split views)
  useEffect(() => {
    // In split view mode (inWorkspace && !isFocusMode), focus is controlled by isFocused prop
    // Only auto-focus for solo tabs or focus mode
    const shouldAutoFocus = isVisible && termRef.current && (!inWorkspace || isFocusMode);
    if (shouldAutoFocus) {
      // Small delay to ensure the tab switch animation completes
      const timer = setTimeout(() => {
        termRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible, inWorkspace, isFocusMode]);

  // Focus terminal when isFocused prop becomes true (for split view navigation)
  useEffect(() => {
    if (isFocused && termRef.current && isVisible) {
      // Small delay to ensure state updates complete
      const timer = setTimeout(() => {
        termRef.current?.focus();
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [isFocused, isVisible, sessionId]);

  // Track terminal selection for context menu and copyOnSelect
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onSelectionChange = () => {
      const selection = term.getSelection();
      const hasText = !!selection && selection.length > 0;
      setHasSelection(hasText);

      // Copy on select if enabled
      if (hasText && terminalSettings?.copyOnSelect) {
        navigator.clipboard.writeText(selection).catch(err => {
          logger.warn('Copy on select failed:', err);
        });
      }
    };

    term.onSelectionChange(onSelectionChange);
    // No need to return cleanup as xterm handles it when disposed
  }, [terminalSettings?.copyOnSelect]);

  useEffect(() => {
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      // Clear previous timeout
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      // Wait 250ms after last resize event before fitting (increased for performance)
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

  const startSSH = async (term: XTerm) => {
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

    if (!terminalBackend.backendAvailable()) {
      setError("Native SSH bridge unavailable. Launch via Electron app.");
      term.writeln(
        "\r\n[netcatty SSH bridge unavailable. Please run the desktop build to connect.]",
      );
      updateStatus("disconnected");
      return;
    }

    // Use pending auth if available, otherwise use host config
    const pendingAuth = pendingAuthRef.current;
    const effectiveUsername = pendingAuth?.username || host.username || "root";
    // Always include password if available for fallback authentication
    const effectivePassword = pendingAuth?.password || host.password;
    const effectiveKeyId = pendingAuth?.keyId || host.identityFileId;

    const key = effectiveKeyId
      ? keys.find((k) => k.id === effectiveKeyId)
      : undefined;

    // Prepare proxy configuration if set
    const proxyConfig = host.proxyConfig
      ? {
        type: host.proxyConfig.type,
        host: host.proxyConfig.host,
        port: host.proxyConfig.port,
        username: host.proxyConfig.username,
        password: host.proxyConfig.password,
      }
      : undefined;

    // Prepare jump host chain configuration
    const jumpHosts = resolvedChainHosts.map((jumpHost) => {
      const jumpKey = jumpHost.identityFileId
        ? keys.find((k) => k.id === jumpHost.identityFileId)
        : undefined;
      return {
        hostname: jumpHost.hostname,
        port: jumpHost.port || 22,
        username: jumpHost.username || "root",
        password: jumpHost.password, // Always include for fallback
        privateKey: jumpKey?.privateKey,
        label: jumpHost.label,
      };
    });

    // Initialize chain progress if we have jump hosts
    const totalHops = jumpHosts.length + 1; // jump hosts + target
    let unsubscribeChainProgress: (() => void) | undefined;

    if (jumpHosts.length > 0) {
      setChainProgress({
        currentHop: 1,
        totalHops,
        currentHostLabel:
          jumpHosts[0]?.label || jumpHosts[0]?.hostname || host.hostname,
      });
      setProgressLogs((prev) => [
        ...prev,
        `Starting chain connection (${totalHops} hops)...`,
      ]);

      // Subscribe to chain progress events from IPC
      {
        const unsub = terminalBackend.onChainProgress(
          (hop, total, label, status) => {
            setChainProgress({
              currentHop: hop,
              totalHops: total,
              currentHostLabel: label,
            });
            setProgressLogs((prev) => [
              ...prev,
              `Chain ${hop} of ${total}: ${label} - ${status}`,
            ]);
            // Update progress value based on chain hop
            const hopProgress = (hop / total) * 80 + 10;
            setProgressValue(Math.min(95, hopProgress));
          },
        );
        if (unsub) unsubscribeChainProgress = unsub;
      }
    }

    try {
      // Build environment variables, including TERM from settings
      const termEnv: Record<string, string> = {
        TERM: terminalSettings?.terminalEmulationType ?? 'xterm-256color',
      };

      // Add host-specific environment variables
      if (host.environmentVariables) {
        for (const { name, value } of host.environmentVariables) {
          if (name) termEnv[name] = value;
        }
      }

      // DEBUG: Log key info for troubleshooting
      console.log('[Terminal] Starting SSH session with key info:', {
        keyId: key?.id,
        keyLabel: key?.label,
        keySource: key?.source,
        hasCredentialId: !!key?.credentialId,
        hasRpId: !!key?.rpId,
        hasPublicKey: !!key?.publicKey,
        hasPrivateKey: !!key?.privateKey,
      });

      const id = await terminalBackend.startSSHSession({
        sessionId,
        hostname: host.hostname,
        username: effectiveUsername,
        port: host.port || 22,
        password: effectivePassword,
        privateKey: key?.privateKey,
        certificate: key?.certificate,
        publicKey: key?.publicKey,
        credentialId: key?.credentialId,
        rpId: key?.rpId,
        keyId: key?.id,
        keySource: key?.source,
        userVerification:
          key?.source === "biometric" ? "required" : "preferred",
        agentForwarding: host.agentForwarding,
        cols: term.cols,
        rows: term.rows,
        charset: host.charset,
        // Environment variables including TERM
        env: termEnv,
        // New: proxy and jump host configuration
        proxy: proxyConfig,
        jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
      });

      // Clean up chain progress listener after successful connection
      if (unsubscribeChainProgress) {
        unsubscribeChainProgress();
      }

      sessionRef.current = id;

      disposeDataRef.current = terminalBackend.onSessionData(id, (chunk) => {
        // Apply keyword highlighting before writing to terminal
        term.write(highlightProcessorRef.current(chunk));
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          setChainProgress(null); // Clear chain progress on connect
          // Trigger fit after connection to ensure proper terminal size
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                // Send updated size to remote
                if (sessionRef.current) {
                  terminalBackend.resizeSession(sessionRef.current, term.cols, term.rows);
                }
              } catch (err) {
                logger.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });

      disposeExitRef.current = terminalBackend.onSessionExit(id, (evt) => {
        updateStatus("disconnected");
        setChainProgress(null); // Clear chain progress on disconnect
        term.writeln(
          `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        );
        onSessionExit?.(sessionId);
      });

      // Run startup command from host config or snippet
      const commandToRun = startupCommand || host.startupCommand;
      if (commandToRun && !hasRunStartupCommandRef.current) {
        hasRunStartupCommandRef.current = true;
        setTimeout(() => {
          if (sessionRef.current) {
            terminalBackend.writeToSession(sessionRef.current, `${commandToRun}\r`);
            // Track startup command execution in shell history
            if (onCommandExecuted) {
              onCommandExecuted(commandToRun, host.id, host.label, sessionId);
            }
          }
        }, 600);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Check if this is an authentication failure
      const isAuthError =
        message.toLowerCase().includes("authentication") ||
        message.toLowerCase().includes("auth") ||
        message.toLowerCase().includes("password") ||
        message.toLowerCase().includes("permission denied");

      if (isAuthError) {
        // Show auth dialog for password retry
        setError(null); // Clear error so we show auth dialog instead
        setNeedsAuth(true);
        setAuthRetryMessage(
          "Authentication failed. Please check your credentials and try again.",
        );
        setAuthPassword(""); // Clear password for re-entry
        setProgressLogs((prev) => [
          ...prev,
          "Authentication failed. Please try again.",
        ]);
        // Stay in connecting state to show auth dialog
        setStatus("connecting");
      } else {
        setError(message);
        term.writeln(`\r\n[Failed to start SSH: ${message}]`);
        updateStatus("disconnected");
      }

      setChainProgress(null); // Clear chain progress on error
      // Clean up chain progress listener on error
      if (unsubscribeChainProgress) {
        unsubscribeChainProgress();
      }
    }

    // Trigger distro detection once connected (hidden exec, no terminal output)
    setTimeout(() => runDistroDetection(key), 600);
  };

  const startTelnet = async (term: XTerm) => {
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

    if (!terminalBackend.telnetAvailable()) {
      setError("Telnet bridge unavailable. Please run the desktop build.");
      term.writeln(
        "\r\n[Telnet bridge unavailable. Please run the desktop build.]",
      );
      updateStatus("disconnected");
      return;
    }

    try {
      // Build environment variables, including TERM from settings
      const telnetEnv: Record<string, string> = {
        TERM: terminalSettings?.terminalEmulationType ?? 'xterm-256color',
      };

      // Add host-specific environment variables
      if (host.environmentVariables) {
        for (const { name, value } of host.environmentVariables) {
          if (name) telnetEnv[name] = value;
        }
      }

      const id = await terminalBackend.startTelnetSession({
        sessionId,
        hostname: host.hostname,
        port: host.telnetPort || host.port || 23,
        cols: term.cols,
        rows: term.rows,
        charset: host.charset,
        env: telnetEnv,
      });

      sessionRef.current = id;

      disposeDataRef.current = terminalBackend.onSessionData(id, (chunk) => {
        // Apply keyword highlighting before writing to terminal
        term.write(highlightProcessorRef.current(chunk));
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                if (sessionRef.current) {
                  terminalBackend.resizeSession(sessionRef.current, term.cols, term.rows);
                }
              } catch (err) {
                logger.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });

      disposeExitRef.current = terminalBackend.onSessionExit(id, (evt) => {
        updateStatus("disconnected");
        term.writeln(
          `\r\n[Telnet session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        );
        onSessionExit?.(sessionId);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      term.writeln(`\r\n[Failed to start Telnet: ${message}]`);
      updateStatus("disconnected");
    }
  };

  const startMosh = async (term: XTerm) => {
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

    if (!terminalBackend.moshAvailable()) {
      setError("Mosh bridge unavailable. Please run the desktop build.");
      term.writeln(
        "\r\n[Mosh bridge unavailable. Please run the desktop build.]",
      );
      updateStatus("disconnected");
      return;
    }

    try {
      // Build environment variables, including TERM from settings
      const moshEnv: Record<string, string> = {
        TERM: terminalSettings?.terminalEmulationType ?? 'xterm-256color',
      };

      // Add host-specific environment variables
      if (host.environmentVariables) {
        for (const { name, value } of host.environmentVariables) {
          if (name) moshEnv[name] = value;
        }
      }

      const id = await terminalBackend.startMoshSession({
        sessionId,
        hostname: host.hostname,
        username: host.username || "root",
        port: host.port || 22,
        moshServerPath: host.moshServerPath,
        agentForwarding: host.agentForwarding,
        cols: term.cols,
        rows: term.rows,
        charset: host.charset,
        env: moshEnv,
      });

      sessionRef.current = id;

      disposeDataRef.current = terminalBackend.onSessionData(id, (chunk) => {
        // Apply keyword highlighting before writing to terminal
        term.write(highlightProcessorRef.current(chunk));
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                if (sessionRef.current) {
                  terminalBackend.resizeSession(sessionRef.current, term.cols, term.rows);
                }
              } catch (err) {
                logger.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });

      disposeExitRef.current = terminalBackend.onSessionExit(id, (evt) => {
        updateStatus("disconnected");
        term.writeln(
          `\r\n[Mosh session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        );
        onSessionExit?.(sessionId);
      });

      // Run startup command if specified
      const commandToRun = startupCommand || host.startupCommand;
      if (commandToRun && !hasRunStartupCommandRef.current) {
        hasRunStartupCommandRef.current = true;
        setTimeout(() => {
          if (sessionRef.current) {
            terminalBackend.writeToSession(sessionRef.current, `${commandToRun}\r`);
            if (onCommandExecuted) {
              onCommandExecuted(commandToRun, host.id, host.label, sessionId);
            }
          }
        }, 600);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      term.writeln(`\r\n[Failed to start Mosh: ${message}]`);
      updateStatus("disconnected");
    }
  };

  const startLocal = async (term: XTerm) => {
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

    if (!terminalBackend.localAvailable()) {
      setError("Local shell bridge unavailable. Please run the desktop build.");
      term.writeln(
        "\r\n[Local shell bridge unavailable. Please run the desktop build to spawn a local terminal.]",
      );
      updateStatus("disconnected");
      return;
    }

    try {
      const id = await terminalBackend.startLocalSession({
        sessionId,
        cols: term.cols,
        rows: term.rows,
        env: {
          TERM: terminalSettings?.terminalEmulationType ?? 'xterm-256color',
        },
      });
      sessionRef.current = id;
      disposeDataRef.current = terminalBackend.onSessionData(id, (chunk) => {
        // Apply keyword highlighting before writing to terminal
        term.write(highlightProcessorRef.current(chunk));
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          // Trigger fit after connection to ensure proper terminal size
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                // Send updated size to remote
                if (sessionRef.current) {
                  terminalBackend.resizeSession(sessionRef.current, term.cols, term.rows);
                }
              } catch (err) {
                logger.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });
      disposeExitRef.current = terminalBackend.onSessionExit(id, (evt) => {
        updateStatus("disconnected");
        term.writeln(
          `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        );
        onSessionExit?.(sessionId);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      term.writeln(`\r\n[Failed to start local shell: ${message}]`);
      updateStatus("disconnected");
    }
  };

  const handleSnippetClick = (cmd: string) => {
    if (sessionRef.current) {
      terminalBackend.writeToSession(sessionRef.current, `${cmd}\r`);
      setIsScriptsOpen(false);
      termRef.current?.focus();
      return;
    }
    termRef.current?.writeln("\r\n[No active SSH session]");
  };

  const handleCancelConnect = () => {
    setIsCancelling(true);
    setNeedsAuth(false);
    setAuthRetryMessage(null); // Clear auth retry message
    setNeedsHostKeyVerification(false);
    setPendingHostKeyInfo(null);
    setError("Connection cancelled");
    setProgressLogs((prev) => [...prev, "Cancelled by user."]);
    cleanupSession();
    updateStatus("disconnected");
    setChainProgress(null); // Clear chain progress on cancel
    setTimeout(() => setIsCancelling(false), 600);
    onCloseSession?.(sessionId);
  };

  // Handle known host verification - Close (cancel)
  const handleHostKeyClose = () => {
    setNeedsHostKeyVerification(false);
    setPendingHostKeyInfo(null);
    handleCancelConnect();
  };

  // Handle known host verification - Continue without adding
  const handleHostKeyContinue = () => {
    setNeedsHostKeyVerification(false);
    // Resume connection without adding to known hosts
    if (pendingConnectionRef.current) {
      pendingConnectionRef.current();
      pendingConnectionRef.current = null;
    }
    setPendingHostKeyInfo(null);
  };

  // Handle known host verification - Add and continue
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
    // Resume connection
    if (pendingConnectionRef.current) {
      pendingConnectionRef.current();
      pendingConnectionRef.current = null;
    }
    setPendingHostKeyInfo(null);
  };

  const handleRetry = () => {
    if (!termRef.current) return;
    cleanupSession();
    setNeedsAuth(false);
    setAuthRetryMessage(null); // Clear auth retry message
    pendingAuthRef.current = null;
    setStatus("connecting");
    setError(null);
    setProgressLogs(["Retrying secure channel..."]);
    setShowLogs(true);
    if (host.protocol === "local" || host.hostname === "localhost") {
      startLocal(termRef.current);
    } else {
      startSSH(termRef.current);
    }
  };

  const isAuthValid = () => {
    if (!authUsername.trim()) return false;
    if (authMethod === "password") return authPassword.trim().length > 0;
    if (authMethod === "key") return !!authKeyId;
    return false;
  };

  const handleAuthSubmit = () => {
    if (!isAuthValid()) return;

    // Set pending auth credentials
    pendingAuthRef.current = {
      username: authUsername,
      password: authMethod === "password" ? authPassword : undefined,
      keyId: authMethod === "key" ? (authKeyId ?? undefined) : undefined,
    };

    // Save credentials to host if requested
    if (saveCredentials && onUpdateHost) {
      const updatedHost: Host = {
        ...host,
        username: authUsername,
        authMethod: authMethod,
        password: authMethod === "password" ? authPassword : undefined,
        identityFileId:
          authMethod === "key" ? (authKeyId ?? undefined) : undefined,
      };
      onUpdateHost(updatedHost);
    }

    // Hide auth dialog and start connection
    setNeedsAuth(false);
    setAuthRetryMessage(null); // Clear any previous auth error message
    setStatus("connecting");
    setProgressLogs(["Authenticating with provided credentials..."]);

    if (termRef.current) {
      // Clear terminal before connecting
      try {
        termRef.current.clear?.();
      } catch (err) {
        logger.warn("Failed to clear terminal", err);
      }
      startSSH(termRef.current);
    }
  };

  // Context menu handlers
  const handleContextCopy = () => {
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection);
    }
  };

  const handleContextPaste = async () => {
    const term = termRef.current;
    if (!term) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text && sessionRef.current) terminalBackend.writeToSession(sessionRef.current, text);
    } catch (err) {
      logger.warn("Failed to paste from clipboard", err);
    }
  };

  const handleContextSelectAll = () => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    setHasSelection(true);
  };

  const handleContextClear = () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
  };

  const handleContextSelectWord = () => {
    const term = termRef.current;
    if (!term) return;
    // xterm.js selectWord selects the word under cursor
    // Since we don't have a cursor position from right-click, we can select all as fallback
    // A proper implementation would require tracking the click position
    term.selectAll();
    setHasSelection(true);
  };

  // Search handlers
  const handleToggleSearch = useCallback(() => {
    setIsSearchOpen((prev) => !prev);
    // Clear match count when closing
    if (isSearchOpen) {
      setSearchMatchCount(null);
      searchAddonRef.current?.clearDecorations();
    }
  }, [isSearchOpen]);

  const handleSearch = useCallback((term: string): boolean => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !term) {
      setSearchMatchCount(null);
      return false;
    }

    // Store the search term for findNext/findPrevious
    searchTermRef.current = term;

    // Clear previous decorations
    searchAddon.clearDecorations();

    // Perform search (findNext from current position or start)
    const found = searchAddon.findNext(term, {
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      decorations: {
        matchBackground: '#FFFF0044',
        matchBorder: '#FFFF00',
        matchOverviewRuler: '#FFFF00',
        activeMatchBackground: '#FF880088',
        activeMatchBorder: '#FF8800',
        activeMatchColorOverviewRuler: '#FF8800',
      },
    });

    // Update match count after search
    // Note: xterm search addon doesn't expose match count directly
    // We'll track it by counting via findAll (if available) or estimate
    if (found) {
      // For now, we don't have exact count from the addon
      // We'll show a basic indicator
      setSearchMatchCount({ current: 1, total: 1 }); // Placeholder
    } else {
      setSearchMatchCount({ current: 0, total: 0 });
    }

    return found;
  }, []);

  const handleFindNext = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    const found = searchAddon.findNext(term, {
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      decorations: {
        matchBackground: '#FFFF0044',
        matchBorder: '#FFFF00',
        matchOverviewRuler: '#FFFF00',
        activeMatchBackground: '#FF880088',
        activeMatchBorder: '#FF8800',
        activeMatchColorOverviewRuler: '#FF8800',
      },
    });
    return found;
  }, []);

  const handleFindPrevious = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    const found = searchAddon.findPrevious(term, {
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      decorations: {
        matchBackground: '#FFFF0044',
        matchBorder: '#FFFF00',
        matchOverviewRuler: '#FFFF00',
        activeMatchBackground: '#FF880088',
        activeMatchBorder: '#FF8800',
        activeMatchColorOverviewRuler: '#FF8800',
      },
    });
    return found;
  }, []);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchMatchCount(null);
    searchAddonRef.current?.clearDecorations();
    // Refocus terminal after closing search
    termRef.current?.focus();
  }, []);

  const renderControls = (opts?: { showClose?: boolean }) => (
    <TerminalToolbar
      status={status}
      snippets={snippets}
      host={host}
      isScriptsOpen={isScriptsOpen}
      setIsScriptsOpen={setIsScriptsOpen}
      onOpenSFTP={() => setShowSFTP((v) => !v)}
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
  // Reserved for future status indicator enhancements
  const _isConnecting = status === "connecting";
  const _hasError = Boolean(error);

  return (
    <TerminalContextMenu
      hasSelection={hasSelection}
      hotkeyScheme={hotkeyScheme}
      rightClickBehavior={terminalSettings?.rightClickBehavior}
      onCopy={handleContextCopy}
      onPaste={handleContextPaste}
      onSelectAll={handleContextSelectAll}
      onClear={handleContextClear}
      onSelectWord={handleContextSelectWord}
      onSplitHorizontal={onSplitHorizontal}
      onSplitVertical={onSplitVertical}
      onClose={inWorkspace ? () => onCloseSession?.(sessionId) : undefined}
    >
      <div className="relative h-full w-full flex overflow-hidden bg-gradient-to-br from-[#050910] via-[#06101a] to-[#0b1220]">
        {/* Unified statusbar for both single host and workspace modes */}
        <div className="absolute left-0 right-0 top-0 z-20 pointer-events-none">
          <div className="flex items-center gap-1 px-2 py-1 bg-black/55 text-white backdrop-blur-md pointer-events-auto min-w-0">
            <div className="flex-1 min-w-0 flex items-center gap-1 text-[11px] font-semibold">
              <span
                className={cn(
                  "truncate",
                  inWorkspace ? "max-w-[80px]" : "max-w-[200px]",
                )}
              >
                {host.label}
              </span>
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full flex-shrink-0",
                  statusDotTone,
                )}
              />
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {/* Expand to focus mode button - only show in workspace split view mode */}
              {inWorkspace && !isFocusMode && onExpandToFocus && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-white/70 hover:text-white hover:bg-white/10"
                  onClick={onExpandToFocus}
                  title="Focus Mode"
                >
                  <Maximize2 size={12} />
                </Button>
              )}
              {renderControls({ showClose: inWorkspace })}
            </div>
          </div>
          {/* Search bar - full width below status bar */}
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
            style={{ top: isSearchOpen ? "64px" : "40px", paddingLeft: 6, backgroundColor: effectiveTheme.colors.background }}
          />


          {/* Known Host Verification Dialog */}
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

          {status !== "connected" && !needsHostKeyVerification && (
            <TerminalConnectionDialog
              host={host}
              status={status}
              error={error}
              progressValue={progressValue}
              chainProgress={chainProgress}
              needsAuth={needsAuth}
              showLogs={showLogs}
              _setShowLogs={setShowLogs}
              keys={keys}
              authProps={{
                authMethod,
                setAuthMethod,
                authUsername,
                setAuthUsername,
                authPassword,
                setAuthPassword,
                authKeyId,
                setAuthKeyId,
                showAuthPassword,
                setShowAuthPassword,
                authRetryMessage,
                onSubmit: handleAuthSubmit,
                onSubmitWithoutSave: () => {
                  setSaveCredentials(false);
                  handleAuthSubmit();
                },
                onCancel: handleCancelConnect,
                isValid: isAuthValid(),
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

        {/* SFTP Modal - rendered outside terminal container to avoid affecting terminal width */}
        <SFTPModal
          host={host}
          credentials={{
            username: host.username,
            hostname: host.hostname,
            port: host.port,
            password: host.password, // Always include for fallback
            privateKey: host.identityFileId
              ? keys.find((k) => k.id === host.identityFileId)?.privateKey
              : undefined,
          }}
          open={showSFTP && status === "connected"}
          onClose={() => setShowSFTP(false)}
        />
      </div>
    </TerminalContextMenu>
  );
};

// Memoized Terminal - only re-renders when props change
const Terminal = memo(TerminalComponent);
Terminal.displayName = "Terminal";

export default Terminal;
