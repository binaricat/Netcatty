import {
  FitAddon,
  Terminal as GhosttyTerminal,
  init as initGhostty,
} from "ghostty-web";
import { Maximize2 } from "lucide-react";
import React, { memo, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import {
  Host,
  KnownHost,
  SSHKey,
  Snippet,
  TerminalSession,
  TerminalTheme,
} from "../types";
import KnownHostConfirmDialog, { HostKeyInfo } from "./KnownHostConfirmDialog";
import SFTPModal from "./SFTPModal";
import { Button } from "./ui/button";

// Import terminal sub-components
import { TerminalConnectionDialog } from "./terminal/TerminalConnectionDialog";
import { TerminalToolbar } from "./terminal/TerminalToolbar";

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
  fontSize: number;
  terminalTheme: TerminalTheme;
  sessionId: string;
  startupCommand?: string; // Command to run after connection (for snippet runner)
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
}

let ghosttyInitialized = false;
let ghosttyInitPromise: Promise<void> | null = null;
const ensureGhostty = async () => {
  if (ghosttyInitialized) return;
  if (!ghosttyInitPromise) {
    ghosttyInitPromise = initGhostty();
  }
  await ghosttyInitPromise;
  ghosttyInitialized = true;
};

const TerminalComponent: React.FC<TerminalProps> = ({
  host,
  keys,
  snippets,
  allHosts = [],
  knownHosts = [],
  isVisible,
  inWorkspace,
  isResizing,
  isFocusMode,
  fontSize,
  terminalTheme,
  sessionId,
  startupCommand,
  onStatusChange,
  onSessionExit,
  onOsDetected,
  onCloseSession,
  onUpdateHost,
  onAddKnownHost,
  onExpandToFocus,
  onCommandExecuted,
}) => {
  const CONNECTION_TIMEOUT = 12000;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<GhosttyTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const disposeDataRef = useRef<(() => void) | null>(null);
  const disposeExitRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const hasRunStartupCommandRef = useRef(false); // Track if startup command has been executed
  const commandBufferRef = useRef<string>(""); // Buffer for tracking typed commands

  const [isScriptsOpen, setIsScriptsOpen] = useState(false);
  const [status, setStatus] = useState<TerminalSession["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [timeLeft, setTimeLeft] = useState(CONNECTION_TIMEOUT / 1000);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showSFTP, setShowSFTP] = useState(false);
  const [progressValue, setProgressValue] = useState(15);

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

    if (sessionRef.current && window.nebula?.closeSession) {
      try {
        window.nebula.closeSession(sessionRef.current);
      } catch (err) {
        console.warn("Failed to close SSH session", err);
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
  };

  const runDistroDetection = async (key?: SSHKey) => {
    if (!window.nebula?.execCommand) return;
    try {
      const res = await window.nebula.execCommand({
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
      console.warn("OS probe failed", err);
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
        await ensureGhostty();
        if (disposed || !containerRef.current) return;

        const term = new GhosttyTerminal({
          cursorBlink: false, // Disable cursor blinking for better performance
          fontSize,
          fontFamily:
            '"JetBrains Mono", "Cascadia Code", "Fira Code", "SF Mono", "Menlo", "DejaVu Sans Mono", monospace',
          scrollback: 5000, // Reduced from default 10000 for better performance
          smoothScrollDuration: 0, // Disable smooth scrolling to reduce render overhead
          theme: {
            ...terminalTheme.colors,
            selectionBackground: terminalTheme.colors.selection,
          },
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        termRef.current = term;
        fitAddonRef.current = fitAddon;

        term.open(containerRef.current);
        fitAddon.fit();
        term.focus();

        term.onData((data) => {
          const id = sessionRef.current;
          if (id && window.nebula?.writeToSession) {
            window.nebula.writeToSession(id, data);

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

        term.onResize(({ cols, rows }) => {
          const id = sessionRef.current;
          if (id && window.nebula?.resizeSession) {
            window.nebula.resizeSession(id, cols, rows);
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
        console.error("Failed to initialize terminal", err);
        setError(err instanceof Error ? err.message : String(err));
        updateStatus("disconnected");
      }
    };

    boot();

    return () => {
      disposed = true;
      teardown();
    };
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
  }, [status, needsAuth]);

  const safeFit = () => {
    if (!fitAddonRef.current) return;
    try {
      fitAddonRef.current.fit();
    } catch (err) {
      console.warn("Fit failed", err);
    }
  };

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      termRef.current.options.theme = {
        ...terminalTheme.colors,
        selectionBackground: terminalTheme.colors.selection,
      };
    }
    // Note: ghostty-web handles fontSize/theme changes internally with its own resize logic
    // We only need safeFit() on visibility change, not on every theme update
  }, [fontSize, terminalTheme]);

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
          console.warn("Font remeasure failed", err);
        }

        try {
          fitAddon?.fit();
        } catch (err) {
          console.warn("Fit after fonts ready failed", err);
        }

        const id = sessionRef.current;
        if (id && term && window.nebula?.resizeSession) {
          try {
            window.nebula.resizeSession(id, term.cols, term.rows);
          } catch (err) {
            console.warn("Resize session after fonts ready failed", err);
          }
        }
      } catch (err) {
        console.warn("Waiting for fonts failed", err);
      }
    };

    waitForFonts();
    return () => {
      cancelled = true;
    };
  }, [host.id, sessionId]);

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

  const startSSH = async (term: GhosttyTerminal) => {
    try {
      term.clear?.();
    } catch (err) {
      console.warn("Failed to clear terminal before connect", err);
    }

    if (!window.nebula?.startSSHSession) {
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
      if (window.nebula?.onChainProgress) {
        unsubscribeChainProgress = window.nebula.onChainProgress(
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
      }
    }

    try {
      const id = await window.nebula.startSSHSession({
        sessionId,
        hostname: host.hostname,
        username: effectiveUsername,
        port: host.port || 22,
        password: effectivePassword,
        privateKey: key?.privateKey,
        keyId: key?.id,
        agentForwarding: host.agentForwarding,
        cols: term.cols,
        rows: term.rows,
        charset: host.charset,
        // Environment variables
        env: host.environmentVariables?.reduce(
          (acc, { name, value }) => {
            if (name) acc[name] = value;
            return acc;
          },
          {} as Record<string, string>,
        ),
        // New: proxy and jump host configuration
        proxy: proxyConfig,
        jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
      });

      // Clean up chain progress listener after successful connection
      if (unsubscribeChainProgress) {
        unsubscribeChainProgress();
      }

      sessionRef.current = id;

      disposeDataRef.current = window.nebula.onSessionData(id, (chunk) => {
        term.write(chunk);
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          setChainProgress(null); // Clear chain progress on connect
          // Trigger fit after connection to ensure proper terminal size
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                // Send updated size to remote
                if (sessionRef.current && window.nebula?.resizeSession) {
                  window.nebula.resizeSession(
                    sessionRef.current,
                    term.cols,
                    term.rows,
                  );
                }
              } catch (err) {
                console.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });

      disposeExitRef.current = window.nebula.onSessionExit(id, (evt) => {
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
            window.nebula?.writeToSession(
              sessionRef.current,
              `${commandToRun}\r`,
            );
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

  const startTelnet = async (term: GhosttyTerminal) => {
    try {
      term.clear?.();
    } catch (err) {
      console.warn("Failed to clear terminal before connect", err);
    }

    const startTelnetSession = window.nebula?.startTelnetSession;
    if (!startTelnetSession) {
      setError("Telnet bridge unavailable. Please run the desktop build.");
      term.writeln(
        "\r\n[Telnet bridge unavailable. Please run the desktop build.]",
      );
      updateStatus("disconnected");
      return;
    }

    try {
      const id = await startTelnetSession({
        sessionId,
        hostname: host.hostname,
        port: host.telnetPort || host.port || 23,
        cols: term.cols,
        rows: term.rows,
        charset: host.charset,
        env: host.environmentVariables?.reduce(
          (acc, { name, value }) => {
            if (name) acc[name] = value;
            return acc;
          },
          {} as Record<string, string>,
        ),
      });

      sessionRef.current = id;

      disposeDataRef.current = window.nebula?.onSessionData(id, (chunk) => {
        term.write(chunk);
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                if (sessionRef.current && window.nebula?.resizeSession) {
                  window.nebula.resizeSession(
                    sessionRef.current,
                    term.cols,
                    term.rows,
                  );
                }
              } catch (err) {
                console.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });

      disposeExitRef.current = window.nebula?.onSessionExit(id, (evt) => {
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

  const startMosh = async (term: GhosttyTerminal) => {
    try {
      term.clear?.();
    } catch (err) {
      console.warn("Failed to clear terminal before connect", err);
    }

    const startMoshSession = window.nebula?.startMoshSession;
    if (!startMoshSession) {
      setError("Mosh bridge unavailable. Please run the desktop build.");
      term.writeln(
        "\r\n[Mosh bridge unavailable. Please run the desktop build.]",
      );
      updateStatus("disconnected");
      return;
    }

    try {
      const id = await startMoshSession({
        sessionId,
        hostname: host.hostname,
        username: host.username || "root",
        port: host.port || 22,
        moshServerPath: host.moshServerPath,
        agentForwarding: host.agentForwarding,
        cols: term.cols,
        rows: term.rows,
        charset: host.charset,
        env: host.environmentVariables?.reduce(
          (acc, { name, value }) => {
            if (name) acc[name] = value;
            return acc;
          },
          {} as Record<string, string>,
        ),
      });

      sessionRef.current = id;

      disposeDataRef.current = window.nebula?.onSessionData(id, (chunk) => {
        term.write(chunk);
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                if (sessionRef.current && window.nebula?.resizeSession) {
                  window.nebula.resizeSession(
                    sessionRef.current,
                    term.cols,
                    term.rows,
                  );
                }
              } catch (err) {
                console.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });

      disposeExitRef.current = window.nebula?.onSessionExit(id, (evt) => {
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
            window.nebula?.writeToSession(
              sessionRef.current,
              `${commandToRun}\r`,
            );
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

  const startLocal = async (term: GhosttyTerminal) => {
    try {
      term.clear?.();
    } catch (err) {
      console.warn("Failed to clear terminal before connect", err);
    }

    const startLocalSession = window.nebula?.startLocalSession;
    if (!startLocalSession) {
      setError("Local shell bridge unavailable. Please run the desktop build.");
      term.writeln(
        "\r\n[Local shell bridge unavailable. Please run the desktop build to spawn a local terminal.]",
      );
      updateStatus("disconnected");
      return;
    }

    try {
      const id = await startLocalSession({
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
      sessionRef.current = id;
      disposeDataRef.current = window.nebula?.onSessionData(id, (chunk) => {
        term.write(chunk);
        if (!hasConnectedRef.current) {
          updateStatus("connected");
          // Trigger fit after connection to ensure proper terminal size
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                // Send updated size to remote
                if (sessionRef.current && window.nebula?.resizeSession) {
                  window.nebula.resizeSession(
                    sessionRef.current,
                    term.cols,
                    term.rows,
                  );
                }
              } catch (err) {
                console.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });
      disposeExitRef.current = window.nebula?.onSessionExit(id, (evt) => {
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
    if (sessionRef.current && window.nebula?.writeToSession) {
      window.nebula.writeToSession(sessionRef.current, `${cmd}\r`);
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
        console.warn("Failed to clear terminal", err);
      }
      startSSH(termRef.current);
    }
  };

  const renderControls = (opts?: { showClose?: boolean }) => (
    <TerminalToolbar
      status={status}
      snippets={snippets}
      isScriptsOpen={isScriptsOpen}
      setIsScriptsOpen={setIsScriptsOpen}
      onOpenSFTP={() => setShowSFTP((v) => !v)}
      onSnippetClick={handleSnippetClick}
      showClose={opts?.showClose}
      onClose={() => onCloseSession?.(sessionId)}
    />
  );

  const statusDotTone =
    status === "connected"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : "bg-rose-500";
  const isConnecting = status === "connecting";
  const hasError = Boolean(error);

  return (
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
      </div>

      <div
        className="h-full flex-1 min-w-0 transition-all duration-300 relative overflow-hidden pt-8"
        style={{ backgroundColor: terminalTheme.colors.background }}
      >
        <div
          ref={containerRef}
          className="absolute inset-x-0 bottom-0"
          style={{ top: "40px", paddingLeft: "16px" }}
        />
        {error && (
          <div className="absolute bottom-3 left-3 text-xs text-destructive bg-background/80 border border-destructive/40 rounded px-3 py-2 shadow-lg">
            {error}
          </div>
        )}

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
            setShowLogs={setShowLogs}
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
  );
};

// Memoized Terminal - only re-renders when props change
const Terminal = memo(TerminalComponent);
Terminal.displayName = "Terminal";

export default Terminal;
