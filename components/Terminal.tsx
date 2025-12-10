import React, { useEffect, useRef, useState, memo } from 'react';
import { init as initGhostty, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web';
import { Host, SSHKey, Snippet, TerminalSession, TerminalTheme, KnownHost, ProxyConfig, HostChainConfig } from '../types';
import { Zap, FolderInput, Loader2, AlertCircle, ShieldCheck, Clock, Play, X, Lock, Key, User, Eye, EyeOff, ChevronDown } from 'lucide-react';
import { DistroAvatar } from './DistroAvatar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ScrollArea } from './ui/scroll-area';
import SFTPModal from './SFTPModal';
import KnownHostConfirmDialog, { HostKeyInfo } from './KnownHostConfirmDialog';

interface TerminalProps {
  host: Host;
  keys: SSHKey[];
  snippets: Snippet[];
  allHosts?: Host[]; // All hosts for chain resolution
  knownHosts?: KnownHost[]; // Known hosts for verification
  isVisible: boolean;
  inWorkspace?: boolean;
  isResizing?: boolean;
  fontSize: number;
  terminalTheme: TerminalTheme;
  sessionId: string;
  onStatusChange?: (sessionId: string, status: TerminalSession['status']) => void;
  onSessionExit?: (sessionId: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onUpdateHost?: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void; // Callback to add host to known hosts
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
  fontSize,
  terminalTheme,
  sessionId,
  onStatusChange,
  onSessionExit,
  onOsDetected,
  onCloseSession,
  onUpdateHost,
  onAddKnownHost,
}) => {
  const CONNECTION_TIMEOUT = 12000;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<GhosttyTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const disposeDataRef = useRef<(() => void) | null>(null);
  const disposeExitRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);

  const [isScriptsOpen, setIsScriptsOpen] = useState(false);
  const [status, setStatus] = useState<TerminalSession['status']>('connecting');
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
  const [authUsername, setAuthUsername] = useState(host.username || 'root');
  const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
  const [authPassword, setAuthPassword] = useState('');
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
  const [needsHostKeyVerification, setNeedsHostKeyVerification] = useState(false);
  const [pendingHostKeyInfo, setPendingHostKeyInfo] = useState<HostKeyInfo | null>(null);
  const pendingConnectionRef = useRef<(() => void) | null>(null);

  // Resolve host chain to actual host objects
  const resolvedChainHosts = host.hostChain?.hostIds
    ?.map(id => allHosts.find(h => h.id === id))
    .filter(Boolean) as Host[] || [];

  const updateStatus = (next: TerminalSession['status']) => {
    setStatus(next);
    hasConnectedRef.current = next === 'connected';
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
        username: host.username || 'root',
        port: host.port || 22,
        password: host.authMethod !== 'key' ? host.password : undefined,
        privateKey: key?.privateKey,
        command: 'cat /etc/os-release 2>/dev/null || uname -a',
        timeout: 8000,
      });
      const data = `${res.stdout || ''}\n${res.stderr || ''}`;
      const idMatch = data.match(/ID=([\\w\\-]+)/i);
      const distro = idMatch ? idMatch[1].replace(/"/g, '') : (data.split(/\\s+/)[0] || '').toLowerCase();
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
          cursorBlink: false,  // Disable cursor blinking for better performance
          fontSize,
          fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", "SF Mono", "Menlo", "DejaVu Sans Mono", monospace',
          scrollback: 5000,  // Reduced from default 10000 for better performance
          smoothScrollDuration: 0,  // Disable smooth scrolling to reduce render overhead
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
          }
        });

        term.onResize(({ cols, rows }) => {
          const id = sessionRef.current;
          if (id && window.nebula?.resizeSession) {
            window.nebula.resizeSession(id, cols, rows);
          }
        });

        if (host.protocol === 'local' || host.hostname === 'localhost') {
          setStatus('connecting');
          setProgressLogs(['Initializing secure channel...']);
          await startLocal(term);
        } else {
          // Check if host needs authentication info
          const hasPassword = host.authMethod === 'password' && host.password;
          const hasKey = host.authMethod === 'key' && host.identityFileId;
          const hasPendingAuth = pendingAuthRef.current;

          if (!hasPassword && !hasKey && !hasPendingAuth && !host.username) {
            // No auth info available - show auth dialog without starting connection
            setNeedsAuth(true);
            // Keep status as disconnected - don't trigger timeout timer
            setStatus('disconnected');
            return;
          }

          setStatus('connecting');
          setProgressLogs(['Initializing secure channel...']);
          await startSSH(term);
        }
      } catch (err) {
        console.error("Failed to initialize terminal", err);
        setError(err instanceof Error ? err.message : String(err));
        updateStatus('disconnected');
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
    if (status !== 'connecting') return;
    const scripted = [
      'Resolving host and keys...',
      'Negotiating ciphers...',
      'Exchanging keys...',
      'Authenticating user...',
      'Waiting for server greeting...',
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
      setError('Connection timed out. Please try again.');
      updateStatus('disconnected');
      setProgressLogs((prev) => [...prev, 'Connection timed out.']);
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
    }, 200);  // Reduced from 100ms to 200ms to cut re-renders in half

    return () => {
      clearInterval(stepTimer);
      clearInterval(countdown);
      clearTimeout(timeout);
      clearInterval(prog);
    };
  }, [status]);

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
        if (!(document as any).fonts?.ready) return;
        await (document as any).fonts.ready;
        if (cancelled) return;

        const term = termRef.current as any;
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

    window.addEventListener('resize', handler);
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      window.removeEventListener('resize', handler);
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
        "\r\n[netcatty SSH bridge unavailable. Please run the desktop build to connect.]"
      );
      updateStatus('disconnected');
      return;
    }

    // Use pending auth if available, otherwise use host config
    const pendingAuth = pendingAuthRef.current;
    const effectiveUsername = pendingAuth?.username || host.username || 'root';
    const effectivePassword = pendingAuth?.password || (host.authMethod !== 'key' ? host.password : undefined);
    const effectiveKeyId = pendingAuth?.keyId || host.identityFileId;

    const key = effectiveKeyId
      ? keys.find((k) => k.id === effectiveKeyId)
      : undefined;

    // Prepare proxy configuration if set
    const proxyConfig = host.proxyConfig ? {
      type: host.proxyConfig.type,
      host: host.proxyConfig.host,
      port: host.proxyConfig.port,
      username: host.proxyConfig.username,
      password: host.proxyConfig.password,
    } : undefined;

    // Prepare jump host chain configuration
    const jumpHosts = resolvedChainHosts.map(jumpHost => {
      const jumpKey = jumpHost.identityFileId 
        ? keys.find(k => k.id === jumpHost.identityFileId) 
        : undefined;
      return {
        hostname: jumpHost.hostname,
        port: jumpHost.port || 22,
        username: jumpHost.username || 'root',
        password: jumpHost.authMethod !== 'key' ? jumpHost.password : undefined,
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
        currentHostLabel: jumpHosts[0]?.label || jumpHosts[0]?.hostname || host.hostname,
      });
      setProgressLogs(prev => [...prev, `Starting chain connection (${totalHops} hops)...`]);
      
      // Subscribe to chain progress events from IPC
      if (window.nebula?.onChainProgress) {
        unsubscribeChainProgress = window.nebula.onChainProgress((hop, total, label, status) => {
          setChainProgress({
            currentHop: hop,
            totalHops: total,
            currentHostLabel: label,
          });
          setProgressLogs(prev => [...prev, `Chain ${hop} of ${total}: ${label} - ${status}`]);
          // Update progress value based on chain hop
          const hopProgress = (hop / total) * 80 + 10;
          setProgressValue(Math.min(95, hopProgress));
        });
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
        env: host.environmentVariables?.reduce((acc, { name, value }) => {
          if (name) acc[name] = value;
          return acc;
        }, {} as Record<string, string>),
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
          updateStatus('connected');
          setChainProgress(null); // Clear chain progress on connect
          // Trigger fit after connection to ensure proper terminal size
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                // Send updated size to remote
                if (sessionRef.current && window.nebula?.resizeSession) {
                  window.nebula.resizeSession(sessionRef.current, term.cols, term.rows);
                }
              } catch (err) {
                console.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });

      disposeExitRef.current = window.nebula.onSessionExit(id, (evt) => {
        updateStatus('disconnected');
        setChainProgress(null); // Clear chain progress on disconnect
        term.writeln(
          `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`
        );
        onSessionExit?.(sessionId);
      });

      if (host.startupCommand) {
        setTimeout(() => {
          if (sessionRef.current) {
            window.nebula?.writeToSession(
              sessionRef.current,
              `${host.startupCommand}\r`
            );
          }
        }, 600);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setChainProgress(null); // Clear chain progress on error
      // Clean up chain progress listener on error
      if (unsubscribeChainProgress) {
        unsubscribeChainProgress();
      }
      term.writeln(`\r\n[Failed to start SSH: ${message}]`);
      updateStatus('disconnected');
    }

    // Trigger distro detection once connected (hidden exec, no terminal output)
    setTimeout(() => runDistroDetection(key), 600);
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
      term.writeln("\r\n[Local shell bridge unavailable. Please run the desktop build to spawn a local terminal.]");
      updateStatus('disconnected');
      return;
    }

    try {
      const id = await startLocalSession({ sessionId, cols: term.cols, rows: term.rows });
      sessionRef.current = id;
      disposeDataRef.current = window.nebula?.onSessionData(id, (chunk) => {
        term.write(chunk);
        if (!hasConnectedRef.current) {
          updateStatus('connected');
          // Trigger fit after connection to ensure proper terminal size
          setTimeout(() => {
            if (fitAddonRef.current) {
              try {
                fitAddonRef.current.fit();
                // Send updated size to remote
                if (sessionRef.current && window.nebula?.resizeSession) {
                  window.nebula.resizeSession(sessionRef.current, term.cols, term.rows);
                }
              } catch (err) {
                console.warn("Post-connect fit failed", err);
              }
            }
          }, 100);
        }
      });
      disposeExitRef.current = window.nebula?.onSessionExit(id, (evt) => {
        updateStatus('disconnected');
        term.writeln(
          `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`
        );
        onSessionExit?.(sessionId);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      term.writeln(`\r\n[Failed to start local shell: ${message}]`);
      updateStatus('disconnected');
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
    setNeedsHostKeyVerification(false);
    setPendingHostKeyInfo(null);
    setError('Connection cancelled');
    setProgressLogs((prev) => [...prev, 'Cancelled by user.']);
    cleanupSession();
    updateStatus('disconnected');
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
    pendingAuthRef.current = null;
    setStatus('connecting');
    setError(null);
    setProgressLogs(['Retrying secure channel...']);
    setShowLogs(true);
    if (host.protocol === 'local' || host.hostname === 'localhost') {
      startLocal(termRef.current);
    } else {
      startSSH(termRef.current);
    }
  };

  const isAuthValid = () => {
    if (!authUsername.trim()) return false;
    if (authMethod === 'password') return authPassword.trim().length > 0;
    if (authMethod === 'key') return !!authKeyId;
    return false;
  };

  const handleAuthSubmit = () => {
    if (!isAuthValid()) return;

    // Set pending auth credentials
    pendingAuthRef.current = {
      username: authUsername,
      password: authMethod === 'password' ? authPassword : undefined,
      keyId: authMethod === 'key' ? authKeyId ?? undefined : undefined,
    };

    // Save credentials to host if requested
    if (saveCredentials && onUpdateHost) {
      const updatedHost: Host = {
        ...host,
        username: authUsername,
        authMethod: authMethod,
        password: authMethod === 'password' ? authPassword : undefined,
        identityFileId: authMethod === 'key' ? authKeyId ?? undefined : undefined,
      };
      onUpdateHost(updatedHost);
    }

    // Hide auth dialog and start connection
    setNeedsAuth(false);
    setStatus('connecting');
    setProgressLogs(['Authenticating with provided credentials...']);

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

  const renderControls = (variant: 'default' | 'compact', opts?: { showClose?: boolean }) => {
    const isCompact = variant === 'compact';
    const buttonBase = isCompact
      ? "h-7 px-2 text-[11px] bg-white/5 hover:bg-white/10 text-white shadow-none border-none"
      : "h-8 px-3 text-xs backdrop-blur-md border border-white/10 shadow-lg";
    const scriptsButtonBase = isCompact
      ? "h-7 px-2 text-[11px] bg-white/5 hover:bg-white/10 text-white shadow-none border-none"
      : "h-8 px-3 text-xs bg-muted/20 hover:bg-muted/80 backdrop-blur-md border border-white/10 text-white shadow-lg";

    return (
      <>
        <Button
          variant="secondary"
          size="sm"
          className={buttonBase}
          disabled={status !== 'connected'}
          title={status === 'connected' ? "Open SFTP" : "Available after connect"}
          onClick={() => setShowSFTP((v) => !v)}
        >
          <FolderInput size={12} className="mr-2" /> SFTP
        </Button>

        <Popover open={isScriptsOpen} onOpenChange={setIsScriptsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className={scriptsButtonBase}
            >
              <Zap size={12} className="mr-2" /> Scripts
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align={isCompact ? "start" : "end"}>
            <div className="px-3 py-2 text-[10px] uppercase text-muted-foreground font-semibold bg-muted/30 border-b">
              Library
            </div>
            <ScrollArea className="h-64">
              <div className="py-1">
                {snippets.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground italic">
                    No snippets available
                  </div>
                ) : (
                  snippets.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => handleSnippetClick(s.command)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors flex flex-col gap-0.5"
                    >
                      <span className="font-medium">{s.label}</span>
                      <span className="text-muted-foreground truncate font-mono text-[10px]">
                        {s.command}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>

        {opts?.showClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              onCloseSession?.(sessionId);
            }}
            title="Close session"
          >
            <X size={12} />
          </Button>
        )}
      </>
    );
  };

  const statusDotTone = status === 'connected'
    ? "bg-emerald-400"
    : status === 'connecting'
      ? "bg-amber-400"
      : "bg-rose-500";
  const isConnecting = status === 'connecting';
  const hasError = Boolean(error);

  return (
    <div className="relative h-full w-full flex overflow-hidden bg-gradient-to-br from-[#050910] via-[#06101a] to-[#0b1220]">
      {!inWorkspace && (
        <div className="absolute top-4 right-6 z-10 flex gap-2">
          {renderControls('default')}
        </div>
      )}

      {inWorkspace && (
        <div className="absolute left-0 right-0 top-0 z-20 pointer-events-none">
          <div className="flex items-center gap-1 px-2 py-1 bg-black/55 text-white backdrop-blur-md pointer-events-auto min-w-0">
            <div className="flex-1 min-w-0 flex items-center gap-1 text-[11px] font-semibold">
              <span className="truncate max-w-[80px]">{host.label}</span>
              <span className={cn("inline-block h-2 w-2 rounded-full flex-shrink-0", statusDotTone)} />
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {renderControls('compact', { showClose: true })}
            </div>
          </div>
        </div>
      )}

      <div
        className={cn(
          "h-full flex-1 min-w-0 transition-all duration-300 relative overflow-hidden",
          inWorkspace ? "pt-8" : ""
        )}
        style={{ backgroundColor: terminalTheme.colors.background }}
      >
        <div ref={containerRef} className="absolute inset-x-0 bottom-0 top-3" style={inWorkspace ? { top: '40px', paddingLeft: '16px' } : { paddingLeft: '16px' }} />
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

        {status !== 'connected' && !needsHostKeyVerification && (
          <div className={cn(
            "absolute inset-0 z-20 flex items-center justify-center",
            needsAuth ? "bg-black" : "bg-black/30"
          )}>
            <div className="w-[560px] max-w-[90vw] bg-background/95 border border-border/60 rounded-2xl shadow-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-10 w-10" />
                  <div>
                    {/* Show chain progress if available */}
                    {chainProgress ? (
                      <>
                        <div className="text-sm font-semibold">
                          <span className="text-muted-foreground">Chain</span>{' '}
                          <span className="font-bold">{chainProgress.currentHop}</span>{' '}
                          <span className="text-muted-foreground">of</span>{' '}
                          <span>{chainProgress.totalHops}:</span>{' '}
                          <span>{chainProgress.currentHostLabel}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono">
                          SSH {host.hostname}:{host.port || 22}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm font-semibold">{host.label}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">
                          SSH {host.hostname}:{host.port || 22}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                {!needsAuth && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => setShowLogs((v) => !v)}
                  >
                    {showLogs ? 'Hide logs' : 'Show logs'}
                  </Button>
                )}
              </div>

              {/* Progress indicator - icons with progress bar below */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                    needsAuth
                      ? "bg-primary text-primary-foreground"
                      : hasError
                        ? "bg-destructive/20 text-destructive"
                        : isConnecting
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground"
                  )}>
                    <User size={14} />
                  </div>
                  <div className="flex-1 h-1.5 rounded-full bg-border/60 overflow-hidden relative">
                    <div
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full transition-all duration-300",
                        error ? "bg-destructive" : "bg-primary"
                      )}
                      style={{
                        width: needsAuth ? '0%' : status === 'connecting' ? `${progressValue}%` : error ? '100%' : '100%',
                      }}
                    />
                  </div>
                  <div className={cn(
                    "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                    hasError ? "bg-destructive/20 text-destructive" : "bg-muted text-muted-foreground"
                  )}>
                    {'>_'}
                  </div>
                </div>
              </div>

              {needsAuth ? (
                /* Auth form */
                <>
                  {/* Auth method tabs */}
                  <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
                    <button
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                        authMethod === 'password'
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                      )}
                      onClick={() => setAuthMethod('password')}
                    >
                      <Lock size={14} />
                      Password
                    </button>
                    <button
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                        authMethod === 'key'
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                      )}
                      onClick={() => setAuthMethod('key')}
                    >
                      <Key size={14} />
                      Public Key
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="auth-username">Username</Label>
                      <Input
                        id="auth-username"
                        value={authUsername}
                        onChange={(e) => setAuthUsername(e.target.value)}
                        placeholder="root"
                      />
                    </div>

                    {authMethod === 'password' ? (
                      <div className="space-y-2">
                        <Label htmlFor="auth-password">Password</Label>
                        <div className="relative">
                          <Input
                            id="auth-password"
                            type={showAuthPassword ? 'text' : 'password'}
                            value={authPassword}
                            onChange={(e) => setAuthPassword(e.target.value)}
                            placeholder="Enter password"
                            className="pr-10"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && authUsername.trim() && authPassword.trim()) {
                                handleAuthSubmit();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            onClick={() => setShowAuthPassword(!showAuthPassword)}
                          >
                            {showAuthPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label>Select Key</Label>
                        {keys.filter(k => k.category === 'key').length === 0 ? (
                          <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
                            No keys available. Add keys in the Keychain section.
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-40 overflow-y-auto">
                            {keys.filter(k => k.category === 'key').map((key) => (
                              <button
                                key={key.id}
                                className={cn(
                                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left",
                                  authKeyId === key.id
                                    ? "border-primary bg-primary/5"
                                    : "border-border/50 hover:bg-secondary/50"
                                )}
                                onClick={() => setAuthKeyId(key.id)}
                              >
                                <div className={cn(
                                  "h-8 w-8 rounded-lg flex items-center justify-center",
                                  key.source === 'biometric' ? "bg-purple-500/20 text-purple-500" : "bg-primary/20 text-primary"
                                )}>
                                  <Key size={14} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium truncate">{key.label}</div>
                                  <div className="text-xs text-muted-foreground">Type {key.type}</div>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <Button variant="secondary" onClick={handleCancelConnect}>
                      Close
                    </Button>
                    <div className="flex items-center gap-2">
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            disabled={!isAuthValid()}
                            onClick={handleAuthSubmit}
                          >
                            Continue & Save
                            <ChevronDown size={14} className="ml-2" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-40 p-1 z-50" align="end">
                          <button
                            className="w-full px-3 py-2 text-sm text-left hover:bg-secondary rounded-md"
                            onClick={() => {
                              setSaveCredentials(false);
                              handleAuthSubmit();
                            }}
                            disabled={!isAuthValid()}
                          >
                            Continue
                          </button>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </>
              ) : (
                /* Connection progress */
                <>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Clock className="h-3 w-3" />
                      <span>
                        {status === 'connecting'
                          ? `Timeout in ${timeLeft}s`
                          : error || 'Disconnected'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {status === 'connecting' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          onClick={handleCancelConnect}
                          disabled={isCancelling}
                        >
                          {isCancelling ? 'Cancelling...' : 'Close'}
                        </Button>
                      ) : (
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" className="h-8" onClick={handleCancelConnect}>
                            Close
                          </Button>
                          <Button size="sm" className="h-8" onClick={handleRetry}>
                            <Play className="h-3 w-3 mr-2" /> Start over
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {showLogs && (
                    <div className="rounded-xl border border-border/60 bg-background/70 shadow-inner">
                      <ScrollArea className="max-h-52 p-3">
                        <div className="space-y-2 text-sm text-foreground/90">
                          {progressLogs.map((line, idx) => (
                            <div key={idx} className="flex items-start gap-2">
                              <div className="mt-0.5">
                                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                              </div>
                              <div>{line}</div>
                            </div>
                          ))}
                          {error && (
                            <div className="flex items-start gap-2 text-destructive">
                              <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
                              <div>{error}</div>
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

      </div>

      {/* SFTP Modal - rendered outside terminal container to avoid affecting terminal width */}
      <SFTPModal
        host={host}
        credentials={{
          username: host.username,
          hostname: host.hostname,
          port: host.port,
          password: host.authMethod !== 'key' ? host.password : undefined,
          privateKey: host.authMethod === 'key'
            ? keys.find(k => k.id === host.identityFileId)?.privateKey
            : undefined,
        }}
        open={showSFTP && status === 'connected'}
        onClose={() => setShowSFTP(false)}
      />
    </div>
  );
};

// Memoized Terminal - only re-renders when props change
const Terminal = memo(TerminalComponent);
Terminal.displayName = 'Terminal';

export default Terminal;
