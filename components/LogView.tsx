import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
    AlertCircle,
    ArrowDownToLine,
    ArrowUpFromLine,
    Bot,
    Camera,
    Clock,
    Download,
    FileText,
    Film,
    FolderOpen,
    HardDrive,
    History,
    Lock,
    Maximize2,
    Monitor,
    Palette,
    Play,
    Plug,
    Server,
    Trash2,
    Unplug,
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
import {
    buildRemoveRecordingClipUpdate,
    findRecordingSeekTargetForEvent,
    getConnectionLogRecordingClips,
} from "../domain/remoteDesktopRecording";
import { applyCustomAccentToTerminalTheme } from "../domain/terminalAppearance";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import {
    listRemoteDesktopSessionAuditEntries,
    subscribeRemoteDesktopSessionAuditLog,
    type RemoteDesktopAuditEntry,
} from "../application/state/remoteDesktopLogActions";
import { cn } from "../lib/utils";
import {
    ConnectionLog,
    RemoteDesktopRecordingClip,
    RemoteDesktopSessionEventKind,
    TerminalTheme,
} from "../types";
import { formatRecordingBytes, formatRecordingDuration } from "./ConnectionLogsManager";
import { RdpProtocolIcon, SshTunnelIcon, VncProtocolIcon } from "./icons/RemoteDesktopIcons";
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

interface UnifiedTimelineEntry {
    id: string;
    timestamp: number;
    source: "session" | "ai";
    kind: RemoteDesktopSessionEventKind | "ai_action";
    summary: string;
    detail?: string;
    outcome?: RemoteDesktopAuditEntry["outcome"];
    seekTarget: { clipId: string; offsetSeconds: number } | null;
}

async function getDesktopBridge(): Promise<NetcattyBridge | undefined> {
    const { netcattyBridge } = await import("../infrastructure/services/netcattyBridge");
    return netcattyBridge.get();
}

function buildDefaultRecordingExportName(log: ConnectionLog, clipIndex?: number, totalClips?: number): string {
    const safeHost = (log.hostLabel || log.hostname || "remote-desktop")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        || "remote-desktop";
    const iso = new Date(log.startTime).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const clipSuffix = totalClips && totalClips > 1 && typeof clipIndex === "number"
        ? `_clip${clipIndex + 1}`
        : "";
    return `${safeHost}_${log.protocol}_${iso}${clipSuffix}.webm`;
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

function formatClockTime(timestamp: number): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "--:--:--";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderTimelineIcon(entry: UnifiedTimelineEntry) {
    if (entry.source === "ai") {
        return <Bot size={12} className="text-cyan-400" />;
    }
    switch (entry.kind) {
        case "connected":
        case "reconnected":
            return <Plug size={12} className="text-emerald-500" />;
        case "disconnected":
            return <Unplug size={12} className="text-muted-foreground" />;
        case "resized":
            return <Maximize2 size={12} className="text-sky-500" />;
        case "clipboard_upload":
            return <ArrowUpFromLine size={12} className="text-blue-500" />;
        case "clipboard_download":
            return <ArrowDownToLine size={12} className="text-emerald-500" />;
        case "shared_folder_mounted":
        case "shared_folder_unmounted":
            return <FolderOpen size={12} className="text-amber-500" />;
        case "screenshot":
            return <Camera size={12} className="text-violet-500" />;
        case "recording_started":
        case "recording_stopped":
            return <Video size={12} className="text-rose-500" />;
        case "error":
        default:
            return <AlertCircle size={12} className="text-destructive" />;
    }
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
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const pendingSeekSecondsRef = useRef<number | null>(null);

    const [isReady, setIsReady] = useState(false);
    const [themeModalOpen, setThemeModalOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [previewTheme, setPreviewTheme] = useState<TerminalTheme | null>(null);

    // Multi-clip recording selection & playback state
    const clips = useMemo<RemoteDesktopRecordingClip[]>(
        () => getConnectionLogRecordingClips(log),
        [log],
    );
    const [selectedClipId, setSelectedClipId] = useState<string | null>(
        () => clips[clips.length - 1]?.id ?? null,
    );

    useEffect(() => {
        if (clips.length === 0) {
            setSelectedClipId(null);
            return;
        }
        if (!selectedClipId || !clips.some((clip) => clip.id === selectedClipId)) {
            setSelectedClipId(clips[clips.length - 1].id);
        }
    }, [clips, selectedClipId]);

    const activeClipIndex = useMemo(() => {
        if (clips.length === 0) return -1;
        const idx = selectedClipId ? clips.findIndex((clip) => clip.id === selectedClipId) : -1;
        return idx >= 0 ? idx : clips.length - 1;
    }, [clips, selectedClipId]);

    const activeClip = activeClipIndex >= 0 ? clips[activeClipIndex] : null;

    const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
    const [posterUrl, setPosterUrl] = useState<string | null>(null);
    const [sessionThumbnailUrl, setSessionThumbnailUrl] = useState<string | null>(null);
    const [recordingStatus, setRecordingStatus] = useState<"idle" | "loading" | "ready" | "missing" | "error">("idle");
    const [deleteRecordingOpen, setDeleteRecordingOpen] = useState(false);
    const [isDeletingRecording, setIsDeletingRecording] = useState(false);
    const [timelineOpen, setTimelineOpen] = useState(true);

    // AI Computer Use audit log entries for this remote desktop session
    const [aiAuditEntries, setAiAuditEntries] = useState<RemoteDesktopAuditEntry[]>(() =>
        isRemoteDesktop && log.sessionId ? listRemoteDesktopSessionAuditEntries(log.sessionId) : [],
    );

    useEffect(() => {
        if (!isRemoteDesktop || !log.sessionId) {
            setAiAuditEntries([]);
            return undefined;
        }
        const refresh = () => setAiAuditEntries(listRemoteDesktopSessionAuditEntries(log.sessionId));
        refresh();
        return subscribeRemoteDesktopSessionAuditLog(refresh);
    }, [isRemoteDesktop, log.sessionId]);

    // Merge structured session events and AI audit entries chronologically
    const timelineEntries = useMemo<UnifiedTimelineEntry[]>(() => {
        if (!isRemoteDesktop) return [];
        const merged: UnifiedTimelineEntry[] = [];
        for (const ev of log.remoteDesktopEvents ?? []) {
            merged.push({
                id: ev.id,
                timestamp: ev.timestamp,
                source: "session",
                kind: ev.kind,
                summary: ev.summary,
                detail: ev.detail,
                seekTarget: clips.length > 0 ? findRecordingSeekTargetForEvent(clips, ev.timestamp) : null,
            });
        }
        for (const audit of aiAuditEntries) {
            merged.push({
                id: `ai-${audit.id}`,
                timestamp: audit.timestamp,
                source: "ai",
                kind: "ai_action",
                summary: audit.summary,
                detail: audit.error || (audit.highRiskChords?.length ? audit.highRiskChords.join(", ") : undefined),
                outcome: audit.outcome,
                seekTarget: clips.length > 0 ? findRecordingSeekTargetForEvent(clips, audit.timestamp) : null,
            });
        }
        merged.sort((a, b) => a.timestamp - b.timestamp);
        return merged;
    }, [aiAuditEntries, clips, isRemoteDesktop, log.remoteDesktopEvents]);

    // Subscribe to custom theme changes so editing triggers re-render
    const customThemes = useCustomThemes();
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

    // Release Chromium hardware video decoder & media pipeline buffers immediately.
    // Capture `videoRef.current` during effect setup because React clears refs to `null`
    // before running effect cleanups on unmount / hide / clip switch.
    const activeClipId = activeClip?.id ?? null;
    const releaseVideoElement = useCallback((target?: HTMLVideoElement | null) => {
        const video = target ?? videoRef.current;
        if (!video) return;
        try {
            video.pause();
            video.removeAttribute("src");
            video.load();
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return undefined;
        return () => {
            releaseVideoElement(video);
        };
    }, [activeClipId, isVisible, playbackUrl, releaseVideoElement]);

    // Resolve active clip playback URL + poster thumbnail URL
    useEffect(() => {
        if (!isRemoteDesktop || !activeClipId) {
            releaseVideoElement();
            setPlaybackUrl(null);
            setPosterUrl(null);
            setRecordingStatus("idle");
            return;
        }
        let cancelled = false;
        setRecordingStatus("loading");
        setPlaybackUrl(null);
        setPosterUrl(null);
        void getDesktopBridge()
            .then(async (bridge) => {
                if (cancelled) return;
                if (!bridge?.remoteDesktopRecordings?.getPlaybackUrl) {
                    setRecordingStatus("missing");
                    return;
                }
                const [playRes, thumbRes] = await Promise.all([
                    bridge.remoteDesktopRecordings.getPlaybackUrl({ recordingId: activeClipId }),
                    bridge.remoteDesktopRecordings.getThumbnailUrl
                        ? bridge.remoteDesktopRecordings.getThumbnailUrl({ id: activeClipId }).catch(() => null)
                        : Promise.resolve(null),
                ]);
                if (cancelled) return;
                if (thumbRes?.exists && thumbRes.url) {
                    setPosterUrl(thumbRes.url);
                }
                if (playRes?.exists && playRes.url) {
                    setPlaybackUrl(playRes.url);
                    setRecordingStatus("ready");
                } else {
                    setPlaybackUrl(null);
                    setRecordingStatus("missing");
                }
            })
            .catch(() => {
                if (cancelled) return;
                setPlaybackUrl(null);
                setPosterUrl(null);
                setRecordingStatus("missing");
            });

        return () => {
            cancelled = true;
            releaseVideoElement();
        };
    }, [activeClipId, isRemoteDesktop, releaseVideoElement]);

    // Resolve optional session-level thumbnail for unrecorded sessions
    const sessionThumbnailId = log.remoteDesktopMeta?.thumbnailId ?? null;
    useEffect(() => {
        if (!isRemoteDesktop || activeClipId || !sessionThumbnailId) {
            setSessionThumbnailUrl(null);
            return;
        }
        let cancelled = false;
        void getDesktopBridge()
            .then((bridge) => bridge?.remoteDesktopRecordings?.getThumbnailUrl?.({ id: sessionThumbnailId }))
            .then((res) => {
                if (!cancelled && res?.exists && res.url) {
                    setSessionThumbnailUrl(res.url);
                } else if (!cancelled) {
                    setSessionThumbnailUrl(null);
                }
            })
            .catch(() => {
                if (!cancelled) setSessionThumbnailUrl(null);
            });
        return () => {
            cancelled = true;
        };
    }, [activeClipId, isRemoteDesktop, sessionThumbnailId]);

    const handleSeekToEvent = useCallback(
        (target: { clipId: string; offsetSeconds: number }) => {
            const safeSec = Math.max(0, target.offsetSeconds);
            if (target.clipId !== activeClipId) {
                pendingSeekSecondsRef.current = safeSec;
                setSelectedClipId(target.clipId);
                return;
            }
            const video = videoRef.current;
            if (!video || video.readyState < 1) {
                pendingSeekSecondsRef.current = safeSec;
                return;
            }
            try {
                const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : safeSec;
                video.currentTime = Math.min(safeSec, maxTime);
                void video.play().catch(() => {});
            } catch {
                // ignore seek error if metadata not ready yet
            }
        },
        [activeClipId],
    );

    const handleVideoLoadedMetadata = useCallback(() => {
        const pending = pendingSeekSecondsRef.current;
        if (pending === null) return;
        pendingSeekSecondsRef.current = null;
        const video = videoRef.current;
        if (!video) return;
        try {
            const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : pending;
            video.currentTime = Math.min(pending, maxTime);
            void video.play().catch(() => {});
        } catch {
            // ignore
        }
    }, []);

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

    const handleThemeChange = useCallback((themeId: string) => {
        onUpdateLog(log.id, { themeId });
    }, [log.id, onUpdateLog]);

    useEffect(() => {
        if (!themeModalOpen) {
            setPreviewTheme(null);
        }
    }, [themeModalOpen]);

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

    // Handle WebM recording export for active clip
    const handleExportRecording = useCallback(async () => {
        if (!activeClip || isExporting) return;
        setIsExporting(true);
        try {
            const bridge = await getDesktopBridge();
            if (!bridge?.remoteDesktopRecordings?.export) return;
            const res = await bridge.remoteDesktopRecordings.export({
                recordingId: activeClip.id,
                defaultFileName: buildDefaultRecordingExportName(log, activeClipIndex, clips.length),
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
    }, [activeClip, activeClipIndex, clips.length, isExporting, log, t]);

    // Handle WebM recording delete for active clip
    const handleConfirmDeleteRecording = useCallback(async () => {
        if (!activeClip || isDeletingRecording) return;
        setIsDeletingRecording(true);
        try {
            const bridge = await getDesktopBridge();
            await bridge?.remoteDesktopRecordings?.delete?.({ recordingId: activeClip.id });
            releaseVideoElement();
            onUpdateLog(log.id, buildRemoveRecordingClipUpdate(log, activeClip.id));
            setPlaybackUrl(null);
            setPosterUrl(null);
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
    }, [activeClip, isDeletingRecording, log, onUpdateLog, releaseVideoElement, t]);

    // Initialize terminal (skipped completely for remote desktop sessions)
    useEffect(() => {
        if (isRemoteDesktop || !containerRef.current || !isVisible) return;

        const term = new XTerm({
            fontFamily: '"JetBrains Mono", "SF Mono", Monaco, Menlo, monospace',
            fontSize: currentFontSize,
            cursorBlink: false,
            cursorStyle: "underline",
            allowProposedApi: true,
            disableStdin: true,
            theme: currentTheme.colors,
            scrollback: 10000,
        });

        termRef.current = term;

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddonRef.current = fitAddon;

        term.open(containerRef.current);

        try {
            const webglAddon = new WebglAddon();
            term.loadAddon(webglAddon);
        } catch {
            // WebGL not available, canvas renderer will be used
        }

        const initialFitTimer = setTimeout(() => {
            try {
                fitAddon.fit();
            } catch {
                // Ignore fit errors
            }
        }, 50);

        if (log.terminalData) {
            term.write(log.terminalData);
        } else {
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

        return () => {
            clearTimeout(initialFitTimer);
            term.dispose();
            termRef.current = null;
            fitAddonRef.current = null;
            setIsReady(false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRemoteDesktop, isVisible, log.id, log.terminalData]);

    useEffect(() => {
        if (termRef.current && isReady) {
            termRef.current.options.theme = currentTheme.colors;
        }
    }, [currentTheme, isReady]);

    useEffect(() => {
        if (!termRef.current || !isReady) return;
        termRef.current.options.fontSize = currentFontSize;
        const refitTimer = setTimeout(() => {
            try {
                fitAddonRef.current?.fit();
            } catch {
                // Ignore fit errors
            }
        }, 10);
        return () => clearTimeout(refitTimer);
    }, [currentFontSize, isReady]);

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
    const meta = log.remoteDesktopMeta;
    const resolutionText = activeClip?.width && activeClip?.height
        ? `${activeClip.width}\u00d7${activeClip.height}`
        : meta?.resolution
            ? `${meta.resolution.width}\u00d7${meta.resolution.height}`
            : null;

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
                    {/* Remote Desktop Timeline Toggle (when recordings + timeline both exist) */}
                    {isRemoteDesktop && activeClip && timelineEntries.length > 0 && (
                        <Button
                            variant={timelineOpen ? "secondary" : "ghost"}
                            size="sm"
                            data-testid="log-view-timeline-toggle"
                            className="gap-1.5 h-7 px-2 text-xs"
                            onClick={() => setTimelineOpen((prev) => !prev)}
                        >
                            <History size={13} />
                            <span>{t("logView.remoteDesktop.timeline")}</span>
                            <span className="font-mono text-[10px] opacity-75">{timelineEntries.length}</span>
                        </Button>
                    )}

                    {/* Remote Desktop Recording actions */}
                    {isRemoteDesktop && activeClip && (
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
                activeClip ? (
                    <div
                        data-log-view="remote-desktop-recording"
                        className="flex-1 min-h-0 flex overflow-hidden bg-neutral-950 text-neutral-100"
                    >
                        {/* Main Video Column */}
                        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                            <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-hidden">
                                {isVisible && recordingStatus === "ready" && playbackUrl ? (
                                    <video
                                        ref={videoRef}
                                        key={activeClip.id}
                                        data-recording-player={activeClip.id}
                                        controls
                                        playsInline
                                        preload="metadata"
                                        poster={posterUrl || undefined}
                                        src={playbackUrl}
                                        className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
                                        onLoadedMetadata={handleVideoLoadedMetadata}
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

                            {/* Multi-clip switcher strip */}
                            {clips.length > 1 && (
                                <div
                                    data-testid="log-view-clip-strip"
                                    className="flex items-center gap-1.5 overflow-x-auto border-t border-neutral-800/90 bg-neutral-900/75 px-4 py-2 shrink-0"
                                >
                                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-neutral-400 mr-1 shrink-0">
                                        <Film size={12} />
                                        {t("logs.recording.clipsCount", { count: clips.length })}
                                    </span>
                                    {clips.map((clip, idx) => {
                                        const selected = clip.id === activeClip.id;
                                        return (
                                            <button
                                                key={clip.id}
                                                type="button"
                                                data-clip-id={clip.id}
                                                onClick={() => {
                                                    pendingSeekSecondsRef.current = null;
                                                    setSelectedClipId(clip.id);
                                                }}
                                                className={cn(
                                                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-mono tabular-nums transition-colors shrink-0 cursor-pointer",
                                                    selected
                                                        ? "border-primary/60 bg-primary/20 text-white"
                                                        : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700",
                                                )}
                                            >
                                                <span>#{idx + 1}</span>
                                                <span>{formatRecordingDuration(clip.durationMs)}</span>
                                                {clip.bytes > 0 && (
                                                    <span className="opacity-70">{formatRecordingBytes(clip.bytes)}</span>
                                                )}
                                                {clip.hasAudio && <Volume2 size={11} className="text-emerald-400" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

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
                                    {resolutionText && (
                                        <span className="inline-flex items-center gap-1 font-mono text-neutral-400">
                                            <Monitor size={12} />
                                            {resolutionText}
                                        </span>
                                    )}
                                    {meta?.securityLabel && (
                                        <span className="inline-flex items-center gap-1 text-neutral-400">
                                            <Lock size={11} />
                                            {meta.securityLabel}
                                        </span>
                                    )}
                                    {meta?.tunneled && (
                                        <span className="inline-flex items-center gap-1 text-emerald-400">
                                            <SshTunnelIcon size={11} />
                                            SSH
                                        </span>
                                    )}
                                </div>
                                <div className="flex flex-wrap items-center gap-3 tabular-nums text-neutral-400">
                                    {typeof activeClip.durationMs === "number" && (
                                        <span className="inline-flex items-center gap-1">
                                            <Clock size={12} />
                                            {formatRecordingDuration(activeClip.durationMs)}
                                        </span>
                                    )}
                                    {typeof activeClip.bytes === "number" && activeClip.bytes > 0 && (
                                        <span className="inline-flex items-center gap-1">
                                            <HardDrive size={12} />
                                            {formatRecordingBytes(activeClip.bytes)}
                                        </span>
                                    )}
                                    {activeClip.hasAudio && (
                                        <span className="inline-flex items-center gap-1 text-emerald-400">
                                            <Volume2 size={12} />
                                            {t("logView.recording.withAudio")}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Collapsible Event Timeline Drawer (Video-linked seek) */}
                        {timelineOpen && timelineEntries.length > 0 && (
                            <aside
                                data-testid="log-view-timeline-drawer"
                                className="w-80 shrink-0 border-l border-neutral-800 bg-neutral-900/95 flex flex-col min-h-0"
                            >
                                <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-neutral-800 shrink-0">
                                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-200">
                                        <History size={13} className="text-primary" />
                                        <span>{t("logView.remoteDesktop.timeline")}</span>
                                    </span>
                                    <span className="font-mono text-[11px] text-neutral-500">
                                        {timelineEntries.length}
                                    </span>
                                </div>
                                <div className="flex-1 overflow-y-auto divide-y divide-neutral-800/80">
                                    {timelineEntries.map((entry) => {
                                        const canSeek = Boolean(entry.seekTarget);
                                        return (
                                            <div
                                                key={entry.id}
                                                className={cn(
                                                    "px-3.5 py-2.5 text-xs transition-colors",
                                                    canSeek && "hover:bg-neutral-800/60 cursor-pointer",
                                                )}
                                                onClick={() => {
                                                    if (entry.seekTarget) {
                                                        handleSeekToEvent(entry.seekTarget);
                                                    }
                                                }}
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="inline-flex items-center gap-1.5 min-w-0 font-medium text-neutral-200">
                                                        {renderTimelineIcon(entry)}
                                                        <span className="truncate">{entry.summary}</span>
                                                        {entry.source === "ai" && entry.outcome && entry.outcome !== "ok" && (
                                                            <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0 text-[9px] uppercase text-amber-300 shrink-0">
                                                                {entry.outcome}
                                                            </span>
                                                        )}
                                                    </span>
                                                    {entry.seekTarget ? (
                                                        <span
                                                            data-seek-seconds={Math.round(entry.seekTarget.offsetSeconds)}
                                                            className="inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] text-primary shrink-0"
                                                        >
                                                            <Play size={9} className="fill-current" />
                                                            {formatRecordingDuration(entry.seekTarget.offsetSeconds * 1000)}
                                                        </span>
                                                    ) : (
                                                        <span className="font-mono text-[10px] text-neutral-500 shrink-0">
                                                            {formatClockTime(entry.timestamp)}
                                                        </span>
                                                    )}
                                                </div>
                                                {entry.detail && (
                                                    <p className="mt-1 text-[11px] text-neutral-400 break-words leading-relaxed">
                                                        {entry.detail}
                                                    </p>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </aside>
                        )}
                    </div>
                ) : (
                    <div
                        data-log-view="remote-desktop-metadata"
                        className="flex-1 min-h-0 overflow-auto p-6"
                    >
                        <div className="mx-auto w-full max-w-3xl space-y-5">
                            <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm space-y-5">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="flex items-center gap-3 min-w-0">
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
                                                {meta?.tunneled && (
                                                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                                                        <SshTunnelIcon size={10} />
                                                        SSH
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-muted-foreground">
                                                {t("logView.remoteDesktop.noRecordingSubtitle")}
                                            </p>
                                        </div>
                                    </div>

                                    {sessionThumbnailUrl && (
                                        <div className="overflow-hidden rounded-lg border border-border/70 bg-black shadow-xs shrink-0">
                                            <img
                                                src={sessionThumbnailUrl}
                                                alt={log.hostLabel || log.hostname}
                                                data-testid="log-view-session-thumbnail"
                                                className="h-24 w-40 object-cover"
                                            />
                                        </div>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 rounded-xl border border-border/60 bg-secondary/35 p-4 text-xs">
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.host")}</span>
                                        <span className="font-mono break-all text-right text-foreground">{log.hostname}</span>
                                    </div>
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.protocol")}</span>
                                        <span className="uppercase text-right text-foreground">{log.protocol}</span>
                                    </div>
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.user")}</span>
                                        <span className="text-right text-foreground">{log.username || "—"}</span>
                                    </div>
                                    {resolutionText && (
                                        <div className="flex items-baseline justify-between gap-3">
                                            <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.resolution")}</span>
                                            <span className="font-mono text-right text-foreground">{resolutionText}</span>
                                        </div>
                                    )}
                                    {meta?.securityLabel && (
                                        <div className="flex items-baseline justify-between gap-3">
                                            <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.security")}</span>
                                            <span className="text-right text-foreground">{meta.securityLabel}</span>
                                        </div>
                                    )}
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.started")}</span>
                                        <span className="text-right text-foreground">{formattedDate}</span>
                                    </div>
                                    <div className="flex items-baseline justify-between gap-3">
                                        <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.ended")}</span>
                                        <span className="text-right text-foreground">{formattedEndDate || t("logs.ongoing")}</span>
                                    </div>
                                    {sessionDuration && (
                                        <div className="flex items-baseline justify-between gap-3">
                                            <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.duration")}</span>
                                            <span className="text-right text-foreground">{sessionDuration}</span>
                                        </div>
                                    )}
                                    {meta?.disconnectReason && (
                                        <div className="flex items-baseline justify-between gap-3 sm:col-span-2">
                                            <span className="text-muted-foreground shrink-0">{t("logView.remoteDesktop.disconnectReason")}</span>
                                            <span className="text-right text-foreground break-words">{meta.disconnectReason}</span>
                                        </div>
                                    )}
                                </div>

                                <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-background px-3.5 py-3 text-xs text-muted-foreground">
                                    <Video size={15} className="mt-0.5 shrink-0 text-primary" />
                                    <span>{t("logView.remoteDesktop.recordingTip")}</span>
                                </div>
                            </div>

                            {/* Structured Session Activity Timeline */}
                            {timelineEntries.length > 0 && (
                                <div
                                    data-testid="log-view-session-timeline"
                                    className="rounded-2xl border border-border/70 bg-card shadow-sm overflow-hidden"
                                >
                                    <div className="flex items-center justify-between px-5 py-3 border-b border-border/60 bg-secondary/25">
                                        <span className="inline-flex items-center gap-2 text-xs font-semibold text-foreground">
                                            <History size={14} className="text-primary" />
                                            <span>{t("logView.remoteDesktop.timeline")}</span>
                                        </span>
                                        <span className="font-mono text-[11px] text-muted-foreground">
                                            {timelineEntries.length}
                                        </span>
                                    </div>
                                    <div className="divide-y divide-border/50">
                                        {timelineEntries.map((entry) => (
                                            <div key={entry.id} className="flex items-start gap-3 px-5 py-3 text-xs">
                                                <span className="mt-0.5 shrink-0">{renderTimelineIcon(entry)}</span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                                                            <span>{entry.summary}</span>
                                                            {entry.source === "ai" && entry.outcome && entry.outcome !== "ok" && (
                                                                <span className="rounded border border-amber-500/40 bg-amber-500/12 px-1 py-0 text-[9px] uppercase text-amber-600 dark:text-amber-400">
                                                                    {entry.outcome}
                                                                </span>
                                                            )}
                                                        </span>
                                                        <span className="font-mono text-[11px] text-muted-foreground shrink-0 tabular-nums">
                                                            {formatClockTime(entry.timestamp)}
                                                        </span>
                                                    </div>
                                                    {entry.detail && (
                                                        <p className="mt-0.5 text-[11px] text-muted-foreground break-words">
                                                            {entry.detail}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
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
        prev.log.recordings === next.log.recordings &&
        prev.log.remoteDesktopEvents === next.log.remoteDesktopEvents &&
        prev.log.remoteDesktopMeta === next.log.remoteDesktopMeta &&
        prev.log.endTime === next.log.endTime &&
        prev.isVisible === next.isVisible &&
        prev.defaultFontSize === next.defaultFontSize &&
        prev.defaultTerminalTheme.id === next.defaultTerminalTheme.id
    );
};

export default memo(LogViewComponent, logViewAreEqual);
