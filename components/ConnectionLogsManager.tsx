import {
    Bookmark,
    ChevronDown,
    CircleUserRound,
    Server,
    Terminal,
    Trash2,
    Usb,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { resolveHostIconAppearance } from "../domain/hostIcon";
import { cn } from "../lib/utils";
import { ConnectionLog, Host } from "../types";
import { DistroAvatar } from "./DistroAvatar";
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
    const customHostIcon = resolveHostIconAppearance({
        iconMode: log.hostIconMode,
        iconId: log.hostIconId,
        iconColorMode: log.hostIconColorMode,
        iconColor: log.hostIconColor,
        iconColorCustom: log.hostIconColorCustom,
    });
    const hasPersistedHostIcon = !isLocal && !isSerial && (!!log.hostDistro || !!customHostIcon);

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
                        isSerial
                            ? "bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950"
                            : isLocal
                                ? "bg-slate-600 text-white dark:bg-slate-300 dark:text-slate-950"
                                : "bg-primary text-primary-foreground"
                    )}>
                        {isSerial ? <Usb size={17} /> : isLocal ? <Terminal size={17} /> : <Server size={17} />}
                    </div>
                )}
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{isLocal ? t("logs.localTerminal") : log.hostLabel}</div>
                    <div className="text-xs text-muted-foreground truncate">
                        {isLocal ? "local" : isSerial ? `serial, ${log.hostname}` : `${log.protocol}, ${log.username}`}
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

    // Track how many items to show
    const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_LIMIT);

    // Sort logs by newest first
    const filteredLogs = useMemo(() => {
        return [...logs].sort((a, b) => b.startTime - a.startTime);
    }, [logs]);

    const displayedLogs = useMemo(() => {
        return filteredLogs.slice(0, renderLimit);
    }, [filteredLogs, renderLimit]);

    const hasMore = filteredLogs.length > renderLimit;

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

    // Rendered items
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
            {/* Table Header */}
            {displayedLogs.length > 0 && (
                <div className="flex items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30 bg-secondary/30">
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
                                <Terminal size={32} className="opacity-60" />
                            </div>
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                                {t("logs.empty.title")}
                            </h3>
                            <p className="text-sm text-center max-w-sm">
                                {t("logs.empty.desc")}
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
