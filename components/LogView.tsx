import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
    AlertCircle,
    Clock,
    Download,
    FileText,
    HardDrive,
    Palette,
    Server,
    Trash2,
    User,
    Video,
    VideoOff,
    Volume2,
    X,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useAppearanceChromeStore } from "../application/state/appearanceChromeStore";
import { useCustomThemes } from "../application/state/customThemeStore";
import { isRdpProtocol, isRemoteDesktopProtocol } from "../domain/remoteDesktop";
import { applyCustomAccentToTerminalTheme } from "../domain/terminalAppearance";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import { cn } from "../lib/utils";
import { ConnectionLog, TerminalTheme } from "../types";
import { formatRecordingBytes, formatRecordingDuration } from "./ConnectionLogsManager";
import { RdpProtocolIcon, VncProtocolIcon } from "./icons/RemoteDesktopIcons";
import { getProtocolBadgeClass } from "./protocolVisuals";
import ThemeCustomizeModal from "./terminal/ThemeCustomizeModal";
import { Button } from "./ui/button";
import { toast } from "./ui/toast";
import { VaultDeleteConfirmDialog } from "./vault/VaultDeleteConfirmDialog";

interface LogViewProps {
    log: ConnectionLog;
    defaultTerminalTheme: TerminalTheme;
    defaultFontSize: number;
    isVisible: boolean;
    onClose: () => void;
    onUpdateLog: (logId: string, updates: Partial<ConnectionLog>) => void;
}

async function getDesktopBridge(): Promise<NetcattyBridge | undefined> {
    const { netcattyBridge } = await import("../infrastructure/services/netcattyBridge");
    return netcattyBridge.get();
}

function buildDefaultRecordingExportName(log: ConnectionLog): string {
    const safeHost = (log.hostLabel || log.hostname || "remote-desktop")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        || "remote-desktop";
    const iso = new Date(log.startTime).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `${safeHost}_${log.protocol}_${iso}.webm`;
}

function formatSessionDuration(startTime: number, endTime?: number): string | null {
    if (!endTime || endTime < startTime) return null;
    const totalSeconds = Math.round((endTime - startTime) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
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
    const isRemoteDesktop = isRemoteDesktopProtocol(log.protocol);
    const isRdp = isRdpProtocol(log.protocol);
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [themeModalOpen, setThemeModalOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [previewTheme, setPreviewTheme] = useState<TerminalTheme | null>(null);

    // Remote desktop recording playback state
    const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
    const [recordingStatus, setRecordingStatus] = useState<"idle" | "loading" | "ready" | "missing" | "error">("idle");
    const [deleteRecordingOpen, setDeleteRecordingOpen] = useState(false);
    const [isDeletingRecording, setIsDeletingRecording] = useState(false);

    // Subscribe to custom theme changes so editing triggers re-render
    const customThemes = useCustomThemes();
    // Leaf accent: published defaultTerminalTheme is the stable base catalog
    // theme; apply live custom accent here so log replay matches terminal chrome
    // without thrashing AppShell on every HSL tick.
    const { accentMode, customAccent } = useAppearanceChromeStore();
    const explicitThemeId = useMemo(() => {
        if (!log.themeId) return undefined;
        const exists = TERMINAL_THEMES.some((theme) => theme.id === log.themeId)
            || customThemes.some((theme) => theme.id === log.themeId);
        return exists ? log.themeId : undefined;
    }, [customThemes, log.themeId]);

    useEffect(() => {
        if (log.themeId && !explicitThemeId) {
            onUpdateLog(log.id, { themeId: undefined });
        }
    }, [explicitThemeId, log.id, log.themeId, onUpdateLog]);

    // Resolve recording playback URL for remote desktop logs
    useEffect(() => {
        if (!isRemoteDesktop || !log.recordingId) {
            setPlaybackUrl(null);
            setRecordingStatus("idle");
            return;
        }
        let cancelled = false;
        setRecordingStatus("loading");
        setPlaybackUrl(null);
        void getDesktopBridge()
            .then((bridge) => {
                if (cancelled) return;
                if (!bridge?.remoteDesktopRecordings?.getPlaybackUrl) {
                    setRecordingStatus("missing");
                    return;
                }
                return bridge.remoteDesktopRecordings
                    .getPlaybackUrl({ recordingId: log.recordingId as string })
                    .then((res) => {
                        if (cancelled) return;
                        if (res?.exists && res.url) {
                            setPlaybackUrl(res.url);
                            setRecordingStatus("ready");
                        } else {
                            setPlaybackUrl(null);
                            setRecordingStatus("missing");
                        }
                    });
            })
            .catch(() => {
                if (cancelled) return;
                setPlaybackUrl(null);
                setRecordingStatus("missing");
            });

        return () => {
            cancelled = true;
        };
    }, [isRemoteDesktop, log.recordingId]);

    // Use log's saved theme/fontSize or fall back to defaults
    const currentTheme = useMemo(() => {
        if (previewTheme) {
            return previewTheme;
        }
        const baseTheme = explicitThemeId
            ? (TERMINAL_THEMES.find(theme => theme.id === explicitThemeId)
                || customThemes.find(theme => theme.id === explicitThemeId)
                || defaultTerminalTheme)
            : defaultTerminalTheme;
        return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
    }, [accentMode, customAccent, customThemes, defaultTerminalTheme, explicitThemeId, previewTheme]);

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

    const formattedEndDate = useMemo(() => {
        if (!log.endTime) return null;
        return new Date(log.endTime).toLocaleString(resolvedLocale || undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }, [log.endTime, resolvedLocale]);

    // Handle theme change
    const handleThemeChange = useCallback((themeId: string) => {
        onUpdateLog(log.id, { themeId });
    }, [log.id, onUpdateLog]);

    useEffect(() => {
        if (!themeModalOpen) {
            setPreviewTheme(null);
        }
    }, [themeModalOpen]);

    // Handle font size change
    const handleFontSizeChange = useCallback((fontSize: number) => {
        onUpdateLog(log.id, { fontSize });
    }, [log.id, onUpdateLog]);

    // Handle terminal log export
    const handleExport = useCallback(async () => {
        if (!log.terminalData || isExporting) return;

        setIsExporting(true);
        try {
            const bridge = await getDesktopBridge();
            if (bridge?.exportSessionLog) {
                await bridge.exportSessionLog({
                    terminalData: log.terminalData,
                    hostLabel: log.hostLabel,
                    hostname: log.hostname,
                    startTime: log.startTime,
                    format: "txt",
                });
            }
        } catch (err) {
            console.error("Failed to export session log:", err);
        } finally {
            setIsExporting(false);
        }
    }, [log.terminalData, log.hostLabel, log.hostname, log.startTime, isExporting]);

    // Handle WebM recording export
    const handleExportRecording = useCallback(async () => {
        if (!log.recordingId || isExporting) return;
        setIsExporting(true);
        try {
            const bridge = await getDesktopBridge();
            if (!bridge?.remoteDesktopRecordings?.export) return;
            const res = await bridge.remoteDesktopRecordings.export({
                recordingId: log.recordingId,
                defaultFileName: buildDefaultRecordingExportName(log),
            });
            if (res?.saved) {
                toast.success(t("logView.recording.exportSuccess"), res.filePath || log.hostLabel);
            }
        } catch (err) {
            console.error("Failed to export recording:", err);
            toast.error(
                err instanceof Error ? err.message : t("logView.recording.exportFailed"),
                log.hostLabel,
            );
        } finally {
            setIsExporting(false);
        }
    }, [isExporting, log, t]);

    // Handle WebM recording delete
    const handleConfirmDeleteRecording = useCallback(async () => {
        if (!log.recordingId || isDeletingRecording) return;
        setIsDeletingRecording(true);
        try {
            const bridge = await getDesktopBridge();
            await bridge?.remoteDesktopRecordings?.delete?.({ recordingId: log.recordingId });
            onUpdateLog(log.id, {
                recordingId: undefined,
                recordingMimeType: undefined,
                recordingDurationMs: undefined,
                recordingBytes: undefined,
                recordingHasAudio: undefined,
            });
            setPlaybackUrl(null);
            setRecordingStatus("idle");
            setDeleteRecordingOpen(false);
            toast.success(t("logView.recording.deleted"), log.hostLabel);
        } catch (err) {
            console.error("Failed to delete recording:", err);
            toast.error(
                err instanceof Error ? err.message : t("logView.recording.deleteFailed"),
                log.hostLabel,
            );
        } finally {
            setIsDeletingRecording(false);
        }
    }, [isDeletingRecording, log.hostLabel, log.id, log.recordingId, onUpdateLog, t]);

    // Initialize terminal (skipped completely for remote desktop sessions)
    useEffect(() => {
        if (isRemoteDesktop || !containerRef.current || !isVisible) return;

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
        const initialFitTimer = setTimeout(() => {
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
            clearTimeout(initialFitTimer);
            term.dispose();
            termRef.current = null;
            fitAddonRef.current = null;
            setIsReady(false);
        };
        // Only re-create terminal when visibility or terminalData changes
        // Theme and font size updates are handled separately
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRemoteDesktop, isVisible, log.id, log.terminalData]);

    // Update theme instantly without recreating terminal
    useEffect(() => {
        if (termRef.current && isReady) {
            termRef.current.options.theme = currentTheme.colors;
        }
    }, [currentTheme, isReady]);

    // Update font size instantly without recreating terminal
    useEffect(() => {
        if (!termRef.current || !isReady) return;
        termRef.current.options.fontSize = currentFontSize;
        // Refit after font size change
        const refitTimer = setTimeout(() => {
            try {
                fitAddonRef.current?.fit();
            } catch {
                // Ignore fit errors
            }
        }, 10);
        return () => clearTimeout(refitTimer);
    }, [currentFontSize, isReady]);

    // Handle resize
    useEffect(() => {
        if (isRemoteDesktop || !isVisible || !fitAddonRef.current) return;

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
    }, [isRemoteDesktop, isVisible]);

    const isLocal = log.protocol === "local" || log.hostname === "localhost";
    const sessionDuration = formatSessionDuration(log.startTime, log.endTime);

    return (
        <div className="h-full w-full flex flex-col bg-background">
            {/* Header */}
            <div className="flex h-9 items-center justify-between gap-3 px-3 py-1 border-b border-border/50 bg-secondary/30 shrink-0">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div
                        className={cn(
                            "h-6 w-6 shrink-0 rounded-md flex items-center justify-center",
                            isRemoteDesktop
                                ? isRdp
                                    ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                    : "bg-teal-500/15 text-teal-600 dark:text-teal-400"
                                : isLocal
                                    ? "bg-emerald-500/10 text-emerald-500"
                                    : "bg-blue-500/10 text-blue-500",
                        )}
                    >
                        {isRemoteDesktop ? (
                            isRdp ? <RdpProtocolIcon size={14} /> : <VncProtocolIcon size={14} />
                        ) : (
                            <FileText size={14} />
                        )}
                    </div>
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <div className="min-w-0 text-sm font-medium leading-5 truncate">
                            {isLocal ? t("logs.localTerminal") : (log.hostLabel || log.hostname)}
                        </div>
                        <div className="text-xs leading-4 truncate text-muted-foreground">
                            {formattedDate} • {log.localUsername}@{log.localHostname}
                        </div>
                    </div>
                </div>
                <div className="flex h-7 shrink-0 items-center gap-1.5">
                    {/* Remote Desktop Recording actions */}
                    {isRemoteDesktop && log.recordingId && (
                        <>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1.5 h-7 px-2 text-xs"
                                onClick={handleExportRecording}
                                disabled={isExporting || recordingStatus === "missing"}
                            >
                                <Download size={14} />
                                <span className="text-xs">{t("logView.recording.download")}</span>
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1.5 h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteRecordingOpen(true)}
                                disabled={isDeletingRecording}
                            >
                                <Trash2 size={14} />
                                <span className="text-xs">{t("logView.recording.delete")}</span>
                            </Button>
                        </>
                    )}

                    {/* Terminal Export button */}
                    {!isRemoteDesktop && log.terminalData && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 h-7 px-2 text-xs"
                            onClick={handleExport}
                            disabled={isExporting}
                        >
                            <Download size={14} />
                            <span className="text-xs">{t("logView.export")}</span>
                        </Button>
                    )}

                    {/* Theme & font customization button (terminal logs only) */}
                    {!isRemoteDesktop && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 h-7 px-2 text-xs"
                            onClick={() => setThemeModalOpen(true)}
                        >
                            <Palette size={14} />
                            <span className="text-xs">{t("logView.appearance")}</span>
                        </Button>
                    )}

                    <span className="h-6 inline-flex items-center rounded bg-secondary px-2 text-xs text-muted-foreground">
                        {t("logView.readOnly")}
                    </span>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
                        <X size={14} />
                    </Button>
                </div>
            </div>

            {/* Body */}
            {isRemoteDesktop ? (
                log.recordingId ? (
                    <div
                        data-log-view="remote-desktop-recording"
                        className="flex-1 min-h-0 flex flex-col bg-neutral-950 text-neutral-100"
                    >
                        <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-hidden">
                            {recordingStatus === "ready" && playbackUrl ? (
                                <video
                                    data-recording-player={log.recordingId}
                                    controls
                                    playsInline
                                    preload="metadata"
                                    src={playbackUrl}
                                    className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
                                    onError={() => setRecordingStatus("error")}
                                />
                            ) : recordingStatus === "missing" || recordingStatus === "error" ? (
                                <div
                                    data-recording-missing="true"
                                    className="max-w-md rounded-xl border border-neutral-800 bg-neutral-900/90 p-6 text-center space-y-3"
                                >
                                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
                                        {recordingStatus === "missing" ? (
                                            <VideoOff size={22} />
                                        ) : (
                                            <AlertCircle size={22} />
                                        )}
                                    </div>
                                    <h3 className="text-sm font-semibold text-neutral-100">
                                        {recordingStatus === "missing"
                                            ? t("logView.recording.missingTitle")
                                            : t("logView.recording.playbackErrorTitle")}
                                    </h3>
                                    <p className="text-xs text-neutral-400 leading-relaxed">
                                        {recordingStatus === "missing"
                                            ? t("logView.recording.missingDesc")
                                            : t("logView.recording.playbackErrorDesc")}
                                    </p>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 text-xs text-neutral-400">
                                    <Video size={16} className="animate-pulse" />
                                    <span>{t("logView.recording.loading")}</span>
                                </div>
                            )}
                        </div>

                        {/* Metadata Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-900/90 px-4 py-2.5 text-xs text-neutral-300 shrink-0">
                            <div className="flex flex-wrap items-center gap-3">
                                <span
                                    className={cn(
                                        "inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4",
                                        getProtocolBadgeClass(isRdp ? "rdp" : "vnc"),
                                    )}
                                >
                                    {log.protocol.toUpperCase()}
                                </span>
                                <span className="inline-flex items-center gap-1.5 font-mono text-neutral-200">
                                    <Server size={12} className="text-neutral-400" />
                                    {log.hostname}
                                </span>
                                {log.username && (
                                    <span className="inline-flex items-center gap-1.5 text-neutral-300">
                                        <User size={12} className="text-neutral-400" />
                                        {log.username}
                                    </span>
                                )}
                            </div>
                            <div className="flex flex-wrap items-center gap-3 tabular-nums text-neutral-400">
                                {typeof log.recordingDurationMs === "number" && (
                                    <span className="inline-flex items-center gap-1">
                                        <Clock size={12} />
                                        {formatRecordingDuration(log.recordingDurationMs)}
                                    </span>
                                )}
                                {typeof log.recordingBytes === "number" && log.recordingBytes > 0 && (
                                    <span className="inline-flex items-center gap-1">
                                        <HardDrive size={12} />
                                        {formatRecordingBytes(log.recordingBytes)}
                                    </span>
                                )}
                                {log.recordingHasAudio && (
                                    <span className="inline-flex items-center gap-1 text-emerald-400">
                                        <Volume2 size={12} />
                                        {t("logView.recording.withAudio")}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div
                        data-log-view="remote-desktop-metadata"
                        className="flex-1 min-h-0 flex items-center justify-center p-6 overflow-auto"
                    >
                        <div className="w-full max-w-lg rounded-2xl border border-border/70 bg-card p-6 shadow-sm space-y-5">
                            <div className="flex items-center gap-3">
                                <div
                                    className={cn(
                                        "h-11 w-11 rounded-xl flex items-center justify-center shrink-0",
                                        isRdp
                                            ? "bg-blue-500/12 text-blue-600 dark:text-blue-400"
                                            : "bg-teal-500/12 text-teal-600 dark:text-teal-400",
                                    )}
                                >
                                    {isRdp ? <RdpProtocolIcon size={22} /> : <VncProtocolIcon size={22} />}
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-base font-semibold truncate">
                                            {log.hostLabel || log.hostname}
                                        </h3>
                                        <span
                                            className={cn(
                                                "inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4 shrink-0",
                                                getProtocolBadgeClass(isRdp ? "rdp" : "vnc"),
                                            )}
                                        >
                                            {log.protocol.toUpperCase()}
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {t("logView.remoteDesktop.noRecordingSubtitle")}
                                    </p>
                                </div>
                            </div>

                            <div className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 rounded-xl border border-border/60 bg-secondary/35 p-4 text-xs">
                                <span className="text-muted-foreground">{t("logView.remoteDesktop.host")}</span>
                                <span className="font-mono break-all text-foreground">{log.hostname}</span>

                                <span className="text-muted-foreground">{t("logView.remoteDesktop.protocol")}</span>
                                <span className="uppercase text-foreground">{log.protocol}</span>

                                <span className="text-muted-foreground">{t("logView.remoteDesktop.user")}</span>
                                <span className="text-foreground">{log.username || "—"}</span>

                                <span className="text-muted-foreground">{t("logView.remoteDesktop.started")}</span>
                                <span className="text-foreground">{formattedDate}</span>

                                <span className="text-muted-foreground">{t("logView.remoteDesktop.ended")}</span>
                                <span className="text-foreground">{formattedEndDate || t("logs.ongoing")}</span>

                                {sessionDuration && (
                                    <>
                                        <span className="text-muted-foreground">{t("logView.remoteDesktop.duration")}</span>
                                        <span className="text-foreground">{sessionDuration}</span>
                                    </>
                                )}
                            </div>

                            <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-background px-3.5 py-3 text-xs text-muted-foreground">
                                <Video size={15} className="mt-0.5 shrink-0 text-primary" />
                                <span>{t("logView.remoteDesktop.recordingTip")}</span>
                            </div>
                        </div>
                    </div>
                )
            ) : (
                <div
                    className="flex-1 overflow-hidden p-2"
                    style={{ backgroundColor: currentTheme?.colors?.background || "#000000" }}
                >
                    <div ref={containerRef} className="h-full w-full" />
                </div>
            )}

            {/* Theme Customize Modal */}
            {!isRemoteDesktop && (
                <ThemeCustomizeModal
                    open={themeModalOpen}
                    onClose={() => setThemeModalOpen(false)}
                    currentThemeId={explicitThemeId}
                    displayThemeId={currentTheme.id}
                    currentFontSize={currentFontSize}
                    onThemeChange={handleThemeChange}
                    onThemeReset={() => onUpdateLog(log.id, { themeId: undefined })}
                    onFontSizeChange={handleFontSizeChange}
                    onPreviewThemeChange={setPreviewTheme}
                />
            )}

            {/* Delete Recording Confirm Dialog */}
            <VaultDeleteConfirmDialog
                open={deleteRecordingOpen}
                title={t("logView.recording.deleteConfirmTitle")}
                description={t("logView.recording.deleteConfirmDesc")}
                confirmLabel={t("logView.recording.delete")}
                disabled={isDeletingRecording}
                onOpenChange={setDeleteRecordingOpen}
                onConfirm={handleConfirmDeleteRecording}
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
        prev.log.recordingId === next.log.recordingId &&
        prev.log.recordingBytes === next.log.recordingBytes &&
        prev.log.recordingDurationMs === next.log.recordingDurationMs &&
        prev.log.endTime === next.log.endTime &&
        prev.isVisible === next.isVisible &&
        prev.defaultFontSize === next.defaultFontSize &&
        prev.defaultTerminalTheme.id === next.defaultTerminalTheme.id
    );
};

export default memo(LogViewComponent, logViewAreEqual);
