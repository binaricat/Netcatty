import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { FileText, X } from "lucide-react";
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { ConnectionLog, TerminalTheme } from "../types";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import { Button } from "./ui/button";

interface LogViewProps {
    log: ConnectionLog;
    terminalTheme: TerminalTheme;
    fontSize: number;
    isVisible: boolean;
    onClose: () => void;
}

const LogViewComponent: React.FC<LogViewProps> = ({
    log,
    terminalTheme,
    fontSize,
    isVisible,
    onClose,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [isReady, setIsReady] = useState(false);

    console.log('[LogView] Render', { logId: log.id, isVisible, hasTerminalData: !!log.terminalData });

    // Format date for display
    const formattedDate = useMemo(() => {
        const date = new Date(log.startTime);
        return date.toLocaleString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }, [log.startTime]);

    // Initialize terminal
    useEffect(() => {
        console.log('[LogView] useEffect', { isVisible, hasContainer: !!containerRef.current });
        if (!containerRef.current || !isVisible) return;

        console.log('[LogView] Creating terminal');

        // Create terminal
        const term = new XTerm({
            fontFamily: '"JetBrains Mono", "SF Mono", Monaco, Menlo, monospace',
            fontSize: fontSize,
            cursorBlink: false,
            cursorStyle: "underline",
            allowProposedApi: true,
            disableStdin: true, // Read-only mode
            theme: terminalTheme.theme,
            scrollback: 10000,
        });

        termRef.current = term;

        // Create fit addon
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddonRef.current = fitAddon;

        // Open terminal
        term.open(containerRef.current);
        console.log('[LogView] Terminal opened');

        // Try to load WebGL addon for better performance
        try {
            const webglAddon = new WebglAddon();
            term.loadAddon(webglAddon);
        } catch (e) {
            // WebGL not available, canvas renderer will be used
        }

        // Fit terminal
        setTimeout(() => {
            try {
                fitAddon.fit();
                console.log('[LogView] Terminal fitted');
            } catch {
                // Ignore fit errors
            }
        }, 50);

        // Write terminal data if available
        console.log('[LogView] Writing data, hasTerminalData:', !!log.terminalData, 'length:', log.terminalData?.length);
        if (log.terminalData) {
            term.write(log.terminalData);
        } else {
            // No terminal data available
            term.writeln("\x1b[2m--- No terminal data captured for this session ---\x1b[0m");
            term.writeln("");
            term.writeln(`\x1b[36mHost:\x1b[0m ${log.hostname}`);
            term.writeln(`\x1b[36mUser:\x1b[0m ${log.username}`);
            term.writeln(`\x1b[36mProtocol:\x1b[0m ${log.protocol}`);
            term.writeln(`\x1b[36mTime:\x1b[0m ${formattedDate}`);
            if (log.endTime) {
                const duration = Math.round((log.endTime - log.startTime) / 1000);
                const minutes = Math.floor(duration / 60);
                const seconds = duration % 60;
                term.writeln(`\x1b[36mDuration:\x1b[0m ${minutes}m ${seconds}s`);
            }
        }

        setIsReady(true);

        // Cleanup
        return () => {
            term.dispose();
            termRef.current = null;
            fitAddonRef.current = null;
            setIsReady(false);
        };
    }, [isVisible, log.terminalData, log.hostname, log.username, log.protocol, formattedDate, log.endTime, log.startTime, fontSize, terminalTheme.theme]);

    // Update theme
    useEffect(() => {
        if (termRef.current && isReady) {
            termRef.current.options.theme = terminalTheme.theme;
        }
    }, [terminalTheme, isReady]);

    // Handle resize
    useEffect(() => {
        if (!isVisible || !fitAddonRef.current) return;

        const handleResize = () => {
            if (fitAddonRef.current) {
                try {
                    fitAddonRef.current.fit();
                } catch {
                    // Ignore fit errors
                }
            }
        };

        const resizeObserver = new ResizeObserver(handleResize);
        if (containerRef.current?.parentElement) {
            resizeObserver.observe(containerRef.current.parentElement);
        }

        return () => {
            resizeObserver.disconnect();
        };
    }, [isVisible]);

    const isLocal = log.protocol === "local" || log.hostname === "localhost";

    return (
        <div className="h-full w-full flex flex-col bg-background">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 bg-secondary/30 shrink-0">
                <div className="flex items-center gap-3">
                    <div
                        className={cn(
                            "h-8 w-8 rounded-lg flex items-center justify-center",
                            isLocal
                                ? "bg-emerald-500/10 text-emerald-500"
                                : "bg-blue-500/10 text-blue-500"
                        )}
                    >
                        <FileText size={16} />
                    </div>
                    <div>
                        <div className="text-sm font-medium">
                            {isLocal ? "Local Terminal" : log.hostname}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {formattedDate} • {log.localUsername}@{log.localHostname}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded">
                        Read-only Log Replay
                    </span>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <X size={16} />
                    </Button>
                </div>
            </div>

            {/* Terminal container */}
            <div
                className="flex-1 overflow-hidden p-2"
                style={{ backgroundColor: terminalTheme?.theme?.background || '#000000' }}
            >
                <div ref={containerRef} className="h-full w-full" />
            </div>
        </div>
    );
};

// Memoization comparison
const logViewAreEqual = (prev: LogViewProps, next: LogViewProps): boolean => {
    return (
        prev.log.id === next.log.id &&
        prev.isVisible === next.isVisible &&
        prev.fontSize === next.fontSize &&
        prev.terminalTheme.id === next.terminalTheme.id
    );
};

export default memo(LogViewComponent, logViewAreEqual);
