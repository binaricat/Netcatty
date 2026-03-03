import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { FileText, Download, Palette, X } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { cn } from "../lib/utils";
import { ConnectionLog, TerminalTheme } from "../types";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import { useCustomThemes } from "../application/state/customThemeStore";
import { Button } from "./ui/button";
import ThemeCustomizeModal from "./terminal/ThemeCustomizeModal";

interface LogViewProps {
    log: ConnectionLog;
    defaultTerminalTheme: TerminalTheme;
    defaultFontSize: number;
    isVisible: boolean;
    onClose: () => void;
    onUpdateLog: (logId: string, updates: Partial<ConnectionLog>) => void;
}

const LogViewComponent: React.FC<LogViewProps> = ({
    log,
    defaultTerminalTheme,
    defaultFontSize,
    isVisible,
    onClose,
    onUpdateLog,
}) => {
    const { t, resolvedLocale } = useI18n();
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [themeModalOpen, setThemeModalOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);

    // Subscribe to custom theme changes so editing triggers re-render
    const customThemes = useCustomThemes();

    // Use log's saved theme/fontSize or fall back to defaults
    const currentTheme = useMemo(() => {
        if (log.themeId) {
            return TERMINAL_THEMES.find(t => t.id === log.themeId)
                || customThemes.find(t => t.id === log.themeId)
                || defaultTerminalTheme;
        }
        return defaultTerminalTheme;
    }, [log.themeId, defaultTerminalTheme, customThemes]);

    const currentFontSize = log.fontSize ?? defaultFontSize;

    // Format date for display
    const formattedDate = useMemo(() => {
        const date = new Date(log.startTime);
        return date.toLocaleString(resolvedLocale || undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }, [log.startTime, resolvedLocale]);

    // Handle theme change
    const handleThemeChange = useCallback((themeId: string) => {
        onUpdateLog(log.id, { themeId });
    }, [log.id, onUpdateLog]);

    // Handle font size change
    const handleFontSizeChange = useCallback((fontSize: number) => {
        onUpdateLog(log.id, { fontSize });
    }, [log.id, onUpdateLog]);

    // Handle export
    const handleExport = useCallback(async () => {
        if (!log.terminalData || isExporting) return;

        setIsExporting(true);
        try {
            const { netcattyBridge } = await import("../infrastructure/services/netcattyBridge");
            const bridge = netcattyBridge.get();
            if (bridge?.exportSessionLog) {
                await bridge.exportSessionLog({
                    terminalData: log.terminalData,
                    hostLabel: log.hostLabel,
                    hostname: log.hostname,
                    startTime: log.startTime,
                    format: 'txt',
                });
            }
        } catch (err) {
            console.error('Failed to export session log:', err);
        } finally {
            setIsExporting(false);
        }
    }, [log.terminalData, log.hostLabel, log.hostname, log.startTime, isExporting]);

    // Initialize terminal
    useEffect(() => {
        if (!containerRef.current || !isVisible) return;

        // Create terminal
        const term = new XTerm({
            fontFamily: '"JetBrains Mono", "SF Mono", Monaco, Menlo, monospace',
            fontSize: currentFontSize,
            cursorBlink: false,
            cursorStyle: "underline",
            allowProposedApi: true,
            disableStdin: true, // Read-only mode
            theme: currentTheme.colors,
            scrollback: 10000,
        });

        termRef.current = term;

        // Create fit addon
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddonRef.current = fitAddon;

        // Open terminal
        term.open(containerRef.current);

        // Try to load WebGL addon for better performance
        try {
            const webglAddon = new WebglAddon();
            term.loadAddon(webglAddon);
        } catch {
            // WebGL not available, canvas renderer will be used
        }

        // Fit terminal
        setTimeout(() => {
            try {
                fitAddon.fit();
            } catch {
                // Ignore fit errors
            }
        }, 50);

        // Write terminal data if available
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
        // Only re-create terminal when visibility or terminalData changes
        // Theme and font size updates are handled separately
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, log.id, log.terminalData]);

    // Update theme instantly without recreating terminal
    useEffect(() => {
        if (termRef.current && isReady) {
            termRef.current.options.theme = currentTheme.colors;
        }
    }, [currentTheme, isReady]);

    // Update font size instantly without recreating terminal
    useEffect(() => {
        if (termRef.current && isReady) {
            termRef.current.options.fontSize = currentFontSize;
            // Refit after font size change
            setTimeout(() => {
                try {
                    fitAddonRef.current?.fit();
                } catch {
                    // Ignore fit errors
                }
            }, 10);
        }
    }, [currentFontSize, isReady]);

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
                            {isLocal ? t("logs.localTerminal") : log.hostname}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {formattedDate} • {log.localUsername}@{log.localHostname}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {/* Export button */}
                    {log.terminalData && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 h-8 px-2"
                            onClick={handleExport}
                            disabled={isExporting}
                            title={t("logView.export")}
                        >
                            <Download size={14} />
                            <span className="text-xs">{t("logView.export")}</span>
                        </Button>
                    )}

                    {/* Theme & font customization button */}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 h-8 px-2"
                        onClick={() => setThemeModalOpen(true)}
                        title={t("logView.customizeAppearance")}
                    >
                        <Palette size={14} />
                        <span className="text-xs">{t("logView.appearance")}</span>
                    </Button>

                    <span className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded">
                        {t("logView.readOnly")}
                    </span>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <X size={16} />
                    </Button>
                </div>
            </div>

            {/* Terminal container */}
            <div
                className="flex-1 overflow-hidden p-2"
                style={{ backgroundColor: currentTheme?.colors?.background || '#000000' }}
            >
                <div ref={containerRef} className="h-full w-full" />
            </div>

            {/* Theme Customize Modal */}
            <ThemeCustomizeModal
                open={themeModalOpen}
                onClose={() => setThemeModalOpen(false)}
                currentThemeId={currentTheme.id}
                currentFontSize={currentFontSize}
                onThemeChange={handleThemeChange}
                onFontSizeChange={handleFontSizeChange}
            />
        </div>
    );
};

// Memoization comparison
const logViewAreEqual = (prev: LogViewProps, next: LogViewProps): boolean => {
    return (
        prev.log.id === next.log.id &&
        prev.log.themeId === next.log.themeId &&
        prev.log.fontSize === next.log.fontSize &&
        prev.isVisible === next.isVisible &&
        prev.defaultFontSize === next.defaultFontSize &&
        prev.defaultTerminalTheme.id === next.defaultTerminalTheme.id
    );
};

export default memo(LogViewComponent, logViewAreEqual);
