import React, { useEffect, useRef, useState } from 'react';
import { Ghostty, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web';
import { Host, SSHKey, Snippet, TerminalSession, TerminalTheme } from '../types';
import { Zap, FolderInput, Loader2, AlertCircle, ShieldCheck, Clock, Play, X } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ScrollArea } from './ui/scroll-area';
import SFTPPanel from './SFTPPanel';

interface TerminalProps {
  host: Host;
  keys: SSHKey[];
  snippets: Snippet[];
  isVisible: boolean;
  inWorkspace?: boolean;
  fontSize: number;
  terminalTheme: TerminalTheme;
  sessionId: string;
  onStatusChange?: (status: TerminalSession['status']) => void;
  onSessionExit?: (sessionId: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCloseSession?: () => void;
}

let ghosttyPromise: Promise<Ghostty> | null = null;
const ensureGhostty = () => {
  if (!ghosttyPromise) {
    ghosttyPromise = Ghostty.load('ghostty-vt.wasm');
  }
  return ghosttyPromise;
};

const TerminalComponent: React.FC<TerminalProps> = ({
  host,
  keys,
  snippets,
  isVisible,
  inWorkspace,
  fontSize,
  terminalTheme,
  sessionId,
  onStatusChange,
  onSessionExit,
  onOsDetected,
  onCloseSession,
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

  const updateStatus = (next: TerminalSession['status']) => {
    setStatus(next);
    hasConnectedRef.current = next === 'connected';
    onStatusChange?.(next);
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
    setStatus('connecting');
    setError(null);
    hasConnectedRef.current = false;
    setProgressLogs(['Initializing secure channel...']);
    setShowLogs(false);
    setIsCancelling(false);

    const boot = async () => {
      try {
        const ghostty = await ensureGhostty();
        if (disposed || !containerRef.current) return;

        const term = new GhosttyTerminal({
          cursorBlink: true,
          fontSize,
          fontFamily: '"JetBrains Mono", monospace',
          theme: {
            ...terminalTheme.colors,
            selectionBackground: terminalTheme.colors.selection,
          },
          ghostty,
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
          await startLocal(term);
        } else {
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

    setProgressValue(15);
    const prog = setInterval(() => {
      setProgressValue((prev) => {
        if (prev >= 92) return 35;
        return prev + Math.random() * 8 + 4;
      });
    }, 450);

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
    if (isVisible) {
      safeFit();
    }
  }, [fontSize, terminalTheme, isVisible]);

  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      safeFit();
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isVisible]);

  useEffect(() => {
    const handler = () => {
      // Defer slightly to allow layout to settle after window resize.
      requestAnimationFrame(() => safeFit());
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
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

    const key = host.identityFileId
      ? keys.find((k) => k.id === host.identityFileId)
      : undefined;

    try {
      const id = await window.nebula.startSSHSession({
        sessionId,
        hostname: host.hostname,
        username: host.username || 'root',
        port: host.port || 22,
        password: host.authMethod !== 'key' ? host.password : undefined,
        privateKey: key?.privateKey,
        keyId: key?.id,
        agentForwarding: host.agentForwarding,
        cols: term.cols,
        rows: term.rows,
        charset: host.charset,
      });

      sessionRef.current = id;

      disposeDataRef.current = window.nebula.onSessionData(id, (chunk) => {
        term.write(chunk);
        if (!hasConnectedRef.current) updateStatus('connected');
      });

      disposeExitRef.current = window.nebula.onSessionExit(id, (evt) => {
        updateStatus('disconnected');
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
        if (!hasConnectedRef.current) updateStatus('connected');
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
    setError('Connection cancelled');
    setProgressLogs((prev) => [...prev, 'Cancelled by user.']);
    cleanupSession();
    updateStatus('disconnected');
    setTimeout(() => setIsCancelling(false), 600);
  };

  const handleRetry = () => {
    if (!termRef.current) return;
    cleanupSession();
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
              onCloseSession?.();
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

  return (
    <div className="relative h-full w-full flex overflow-hidden bg-gradient-to-br from-[#050910] via-[#06101a] to-[#0b1220] border-l border-border/70">
      {!inWorkspace && (
        <div className="absolute top-4 right-6 z-10 flex gap-2">
          {renderControls('default')}
        </div>
      )}

      {inWorkspace && (
        <div className="absolute left-0 right-0 top-0 z-20 pointer-events-none">
          <div className="flex items-center gap-2 px-2 py-1 bg-black/55 text-white backdrop-blur-md pointer-events-auto">
            <div className="flex-1 min-w-0 flex items-center gap-2 text-[11px] font-semibold truncate">
              <span className="truncate">{host.label}</span>
              <span className={cn("inline-block h-2 w-2 rounded-full", statusDotTone)} />
              <span className="text-white/80 font-mono text-[10px] font-normal truncate">
                {host.username}@{host.hostname}:{host.port || 22}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {renderControls('compact', { showClose: true })}
            </div>
          </div>
        </div>
      )}

      <div
        className={cn(
          "h-full flex-1 min-w-0 transition-all duration-300 relative",
          inWorkspace ? "pt-9 px-2 pb-2" : "p-2"
        )}
        style={{ backgroundColor: terminalTheme.colors.background }}
      >
        <div ref={containerRef} className="h-full w-full" />
        {error && (
          <div className="absolute bottom-3 left-3 text-xs text-destructive bg-background/80 border border-destructive/40 rounded px-3 py-2 shadow-lg">
            {error}
          </div>
        )}

        {status !== 'connected' && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30">
            <div className="w-[560px] max-w-[90vw] bg-background/95 border border-border/60 rounded-2xl shadow-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-semibold">
                    {host.label.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{host.label}</div>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {host.username}@{host.hostname}:{host.port || 22}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => setShowLogs((v) => !v)}
                >
                  {showLogs ? 'Hide logs' : 'Show logs'}
                </Button>
              </div>

              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-primary/15 text-primary flex items-center justify-center shadow-inner">
                  {status === 'connecting' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                </div>
                <div className="flex-1 h-1.5 rounded-full bg-border/60 overflow-hidden relative">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 bg-gradient-to-r from-primary via-primary/60 to-primary/80 transition-all duration-400 ease-out"
                    )}
                    style={{ width: status === 'connecting' ? `${progressValue}%` : '100%' }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 w-full opacity-20 bg-[radial-gradient(circle,_rgba(255,255,255,0.6)_0%,_rgba(255,255,255,0)_60%)] animate-[shimmer_1.6s_linear_infinite]"
                    style={{
                      backgroundSize: '120px 120px',
                      maskImage: 'linear-gradient(90deg, transparent 0%, black 15%, black 85%, transparent 100%)'
                    }}
                  />
                </div>
                <div className="h-8 w-8 rounded-full border border-border/70 flex items-center justify-center">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>

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
                      {isCancelling ? 'Cancelling...' : 'Cancel'}
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
            </div>
          </div>
        )}

        <div
          className={cn(
            "absolute inset-y-0 right-0 w-[360px] z-30 border-l border-border/60 bg-background/95 shadow-2xl transform transition-transform duration-200 ease-out",
            showSFTP && status === 'connected' ? "translate-x-0 opacity-100" : "translate-x-full opacity-0 pointer-events-none"
          )}
        >
          <SFTPPanel
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
            isVisible={showSFTP && status === 'connected'}
            onClose={() => setShowSFTP(false)}
          />
        </div>
      </div>
    </div>
  );
};

export default TerminalComponent;
