import {
    Bookmark,
    ChevronDown,
    CircleUserRound,
    Monitor,
    Server,
    Terminal,
    Trash2,
    Usb,
    Video,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { resolveHostIconAppearance } from "../domain/hostIcon";
import { isRdpProtocol, isRemoteDesktopProtocol, isVncProtocol } from "../domain/remoteDesktop";
import { getConnectionLogRecordingSummary } from "../domain/remoteDesktopRecording";
import { cn } from "../lib/utils";
import { ConnectionLog, Host } from "../types";
import { DistroAvatar } from "./DistroAvatar";
import { RdpProtocolIcon, VncProtocolIcon } from "./icons/RemoteDesktopIcons";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ConnectionLogsManagerProps {
    logs: ConnectionLog[];
    hosts: Host[];
    onToggleSaved: (id: string) => void;
    onDelete: (id: string) => void;
    onClearUnsaved: () => void;
    onOpenLogView: (log: ConnectionLog) => void;
}

export type ConnectionLogFilter = "all" | "terminal" | "remoteDesktop" | "recorded";

export function formatRecordingDuration(durationMs?: number): string {
    if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
        return "00:00";
    }
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRecordingBytes(bytes?: number): string {
    if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIdx = 0;
    while (size >= 1024 && unitIdx < units.length - 1) {
        size /= 1024;
        unitIdx += 1;
    }
    const formatted = unitIdx === 0
        ? String(Math.round(size))
        : String(parseFloat(size.toFixed(size >= 10 ? 1 : 2)));
    return `${formatted} ${units[unitIdx]}`;
}

// Format date for display
const formatDate = (timestamp: number, locale: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(locale || undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
};

// Format time range
const formatTimeRange = (start: number, end: number | undefined, locale: string, ongoingLabel: string) => {
    const startDate = new Date(start);
    const startTime = startDate.toLocaleTimeString(locale || undefined, {
        hour: "2-digit",
        minute: "2-digit",
    });

    if (!end) {
        return `${startTime} - ${ongoingLabel}`;
    }

    const endDate = new Date(end);
    const endTime = endDate.toLocaleTimeString(locale || undefined, {
        hour: "2-digit",
        minute: "2-digit",
    });

    return `${startTime} - ${endTime}`;
};

// Log Item Component
interface LogItemProps {
    log: ConnectionLog;
    onToggleSaved: (id: string) => void;
    onDelete: (id: string) => void;
    onClick: () => void;
}

const LogItem = memo<LogItemProps>(({ log, onToggleSaved, onDelete, onClick }) => {
    const { t, resolvedLocale } = useI18n();
    const isLocal = log.protocol === "local" || log.hostname === "localhost";
    const isSerial = log.protocol === "serial";
    const isRdp = isRdpProtocol(log.protocol);
    const isVnc = isVncProtocol(log.protocol);
    const isRemoteDesktop = isRdp || isVnc;
    const customHostIcon = resolveHostIconAppearance({
        iconMode: log.hostIconMode,
        iconId: log.hostIconId,
        iconColorMode: log.hostIconColorMode,
        iconColor: log.hostIconColor,
        iconColorCustom: log.hostIconColorCustom,
    });
    const hasPersistedHostIcon = !isLocal && !isSerial && !isRemoteDesktop && (!!log.hostDistro || !!customHostIcon);
    const recordingSummary = getConnectionLogRecordingSummary(log);
    const recordingSizeText = formatRecordingBytes(recordingSummary.totalBytes);
    const recordingDurationText = formatRecordingDuration(recordingSummary.totalDurationMs);
    const resolutionText = log.remoteDesktopMeta?.resolution
        ? `${log.remoteDesktopMeta.resolution.width}\u00d7${log.remoteDesktopMeta.resolution.height}`
        : "";
    const subtitleParts: string[] = [];
    if (isLocal) {
        subtitleParts.push("local");
    } else if (isSerial) {
        subtitleParts.push(`serial, ${log.hostname}`);
    } else if (log.username) {
        subtitleParts.push(`${log.protocol}, ${log.username}`);
    } else {
        subtitleParts.push(`${log.protocol}, ${log.hostname}`);
    }
    if (isRemoteDesktop && resolutionText) {
        subtitleParts.push(resolutionText);
    }
    if (isRemoteDesktop && log.remoteDesktopMeta?.securityLabel) {
        subtitleParts.push(log.remoteDesktopMeta.securityLabel);
    }

    return (
        <div
            className="group flex items-center gap-4 px-4 py-3 hover:bg-secondary/60 transition-colors border-b border-border/30 last:border-b-0 cursor-pointer"
            onClick={onClick}
        >
            {/* Date column */}
            <div className="w-32 shrink-0">
                <div className="text-sm font-medium">{formatDate(log.startTime, resolvedLocale)}</div>
                <div className="text-xs text-muted-foreground">
                    {formatTimeRange(log.startTime, log.endTime, resolvedLocale, t("logs.ongoing"))}
                </div>
            </div>

            {/* User column */}
            <div className="flex items-center gap-2 w-56 shrink-0">
                <div className="h-9 w-9 rounded-xl bg-emerald-600 text-white dark:bg-emerald-400 dark:text-slate-950 flex items-center justify-center shrink-0">
                    <CircleUserRound size={18} strokeWidth={2.25} />
                </div>
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{log.localUsername}</div>
                    <div className="text-xs text-muted-foreground truncate">{log.localHostname}</div>
                </div>
            </div>

            {/* Host column */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
                {hasPersistedHostIcon ? (
                    <DistroAvatar
                        host={{
                            os: log.hostOs ?? "linux",
                            distro: log.hostDistro,
                            distroMode: "auto",
                            iconMode: log.hostIconMode,
                            iconId: log.hostIconId,
                            iconColorMode: log.hostIconColorMode,
                            iconColor: log.hostIconColor,
                            iconColorCustom: log.hostIconColorCustom,
                        }}
                        fallback={(log.hostOs ?? "linux")[0].toUpperCase()}
                        size="log"
                    />
                ) : (
                    <div className={cn(
                        "h-9 w-9 rounded-xl flex items-center justify-center shrink-0",
                        isRdp
                            ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                            : isVnc
                                ? "bg-teal-500/15 text-teal-600 dark:text-teal-400"
                                : isSerial
                                    ? "bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950"
                                    : isLocal
                                        ? "bg-slate-600 text-white dark:bg-slate-300 dark:text-slate-950"
                                        : "bg-primary text-primary-foreground"
                    )}>
                        {isRdp ? (
                            <RdpProtocolIcon size={17} />
                        ) : isVnc ? (
                            <VncProtocolIcon size={17} />
                        ) : isSerial ? (
                            <Usb size={17} />
                        ) : isLocal ? (
                            <Terminal size={17} />
                        ) : (
                            <Server size={17} />
                        )}
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="text-sm font-medium truncate">
                            {isLocal ? t("logs.localTerminal") : log.hostLabel}
                        </div>
                        {recordingSummary.primaryClip && (
                            <span
                                data-recording-badge={recordingSummary.primaryClip.id}
                                className="inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-primary shrink-0"
                            >
                                <Video size={12} />
                                <span>
                                    {recordingSummary.clipCount > 1
                                        ? `${t("logs.recording.clipsCount", { count: recordingSummary.clipCount })} · `
                                        : ""}
                                    {recordingDurationText}
                                    {recordingSizeText ? ` · ${recordingSizeText}` : ""}
                                </span>
                            </span>
                        )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                        {subtitleParts.join(" · ")}
                    </div>
                </div>
            </div>

            {/* Saved column */}
            <div className="flex items-center gap-2 shrink-0">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleSaved(log.id);
                            }}
                            className={cn(
                                "p-1.5 rounded-md transition-colors",
                                log.saved
                                    ? "text-primary bg-primary/10"
                                    : "text-muted-foreground hover:text-primary hover:bg-primary/10"
                            )}
                        >
                            <Bookmark size={16} fill={log.saved ? "currentColor" : "none"} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{log.saved ? t("logs.action.unsave") : t("logs.action.save")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(log.id);
                            }}
                            className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                        >
                            <Trash2 size={16} />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("logs.action.delete")}</TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
});

LogItem.displayName = "LogItem";

const ConnectionLogsManager: React.FC<ConnectionLogsManagerProps> = ({
    logs,
    hosts: _hosts,
    onToggleSaved,
    onDelete,
    onClearUnsaved: _onClearUnsaved,
    onOpenLogView,
}) => {
    const { t } = useI18n();
    const INITIAL_RENDER_LIMIT = 30;
    const LOAD_MORE_COUNT = 30;

    const [filter, setFilter] = useState<ConnectionLogFilter>("all");
    const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_LIMIT);

    const filterCounts = useMemo(() => {
        let terminal = 0;
        let remoteDesktop = 0;
        let recorded = 0;
        for (const log of logs) {
            if (isRemoteDesktopProtocol(log.protocol)) {
                remoteDesktop += 1;
            } else {
                terminal += 1;
            }
            if (getConnectionLogRecordingSummary(log).clipCount > 0) {
                recorded += 1;
            }
        }
        return { all: logs.length, terminal, remoteDesktop, recorded };
    }, [logs]);

    const showFilterBar = logs.length > 0 && (filterCounts.remoteDesktop > 0 || filterCounts.recorded > 0);
    const effectiveFilter: ConnectionLogFilter = showFilterBar ? filter : "all";

    // Filter and sort logs by newest first
    const filteredLogs = useMemo(() => {
        const subset = effectiveFilter === "all"
            ? logs
            : logs.filter((log) => {
                if (effectiveFilter === "remoteDesktop") return isRemoteDesktopProtocol(log.protocol);
                if (effectiveFilter === "terminal") return !isRemoteDesktopProtocol(log.protocol);
                return getConnectionLogRecordingSummary(log).clipCount > 0;
            });
        return [...subset].sort((a, b) => b.startTime - a.startTime);
    }, [effectiveFilter, logs]);

    const displayedLogs = useMemo(() => {
        return filteredLogs.slice(0, renderLimit);
    }, [filteredLogs, renderLimit]);

    const hasMore = filteredLogs.length > renderLimit;

    const handleChangeFilter = useCallback((next: ConnectionLogFilter) => {
        setFilter(next);
        setRenderLimit(INITIAL_RENDER_LIMIT);
    }, []);

    const handleLoadMore = useCallback(() => {
        setRenderLimit(prev => prev + LOAD_MORE_COUNT);
    }, []);

    const handleToggleSaved = useCallback(
        (id: string) => onToggleSaved(id),
        [onToggleSaved],
    );

    const handleDelete = useCallback(
        (id: string) => onDelete(id),
        [onDelete],
    );

    const renderedItems = useMemo(() => {
        return displayedLogs.map((log) => (
            <LogItem
                key={log.id}
                log={log}
                onToggleSaved={handleToggleSaved}
                onDelete={handleDelete}
                onClick={() => onOpenLogView(log)}
            />
        ));
    }, [displayedLogs, handleToggleSaved, handleDelete, onOpenLogView]);

    return (
        <div className="h-full flex flex-col">
            {/* Protocol / Recording Filter Bar */}
            {showFilterBar && (
                <div
                    data-testid="logs-filter-bar"
                    className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-border/30 bg-background shrink-0"
                >
                    {(
                        [
                            { id: "all" as const, label: t("logs.filter.all"), count: filterCounts.all, icon: null },
                            { id: "terminal" as const, label: t("logs.filter.terminal"), count: filterCounts.terminal, icon: <Terminal size={12} /> },
                            { id: "remoteDesktop" as const, label: t("logs.filter.remoteDesktop"), count: filterCounts.remoteDesktop, icon: <Monitor size={12} /> },
                            { id: "recorded" as const, label: t("logs.filter.recorded"), count: filterCounts.recorded, icon: <Video size={12} /> },
                        ]
                    ).map((item) => {
                        const active = effectiveFilter === item.id;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                data-logs-filter={item.id}
                                onClick={() => handleChangeFilter(item.id)}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                                    active
                                        ? "bg-primary/12 text-primary border border-primary/25"
                                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/60 border border-transparent",
                                )}
                            >
                                {item.icon}
                                <span>{item.label}</span>
                                <span className="font-mono text-[10px] opacity-75 tabular-nums">{item.count}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Table Header */}
            {displayedLogs.length > 0 && (
                <div className="flex items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30 bg-secondary/30 shrink-0">
                    <div className="w-32 shrink-0 flex items-center gap-1">
                        {t("logs.table.date")}
                        <ChevronDown size={12} />
                    </div>
                    <div className="w-56 shrink-0">{t("logs.table.user")}</div>
                    <div className="flex-1">{t("logs.table.host")}</div>
                    <div className="w-20 shrink-0 flex items-center gap-1">
                        {t("logs.table.saved")}
                        <Bookmark size={12} />
                    </div>
                </div>
            )}

            {/* Content */}
            <ScrollArea className="flex-1">
                <div>
                    {displayedLogs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                            <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                                {effectiveFilter === "recorded" ? (
                                    <Video size={32} className="opacity-60" />
                                ) : effectiveFilter === "remoteDesktop" ? (
                                    <Monitor size={32} className="opacity-60" />
                                ) : (
                                    <Terminal size={32} className="opacity-60" />
                                )}
                            </div>
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                                {effectiveFilter === "all" ? t("logs.empty.title") : t("logs.filter.emptyTitle")}
                            </h3>
                            <p className="text-sm text-center max-w-sm">
                                {effectiveFilter === "all" ? t("logs.empty.desc") : t("logs.filter.emptyDesc")}
                            </p>
                        </div>
                    ) : (
                        <>
                            {renderedItems}
                            {hasMore && (
                                <button
                                    onClick={handleLoadMore}
                                    className="w-full py-3 text-sm text-primary hover:bg-secondary/50 transition-colors"
                                >
                                    {t("logs.loadMore", { count: Math.min(LOAD_MORE_COUNT, filteredLogs.length - renderLimit) })}
                                </button>
                            )}
                        </>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};

// Custom comparison
const logsManagerAreEqual = (
    prev: ConnectionLogsManagerProps,
    next: ConnectionLogsManagerProps,
): boolean => {
    return prev.logs === next.logs && prev.hosts === next.hosts;
};

export default memo(ConnectionLogsManager, logsManagerAreEqual);
