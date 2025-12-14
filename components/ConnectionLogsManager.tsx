import {
    Bookmark,
    ChevronDown,
    Server,
    Terminal,
    Trash2,
    User,
} from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { cn } from "../lib/utils";
import { ConnectionLog, Host } from "../types";
import { ScrollArea } from "./ui/scroll-area";

interface ConnectionLogsManagerProps {
    logs: ConnectionLog[];
    hosts: Host[];
    onToggleSaved: (id: string) => void;
    onDelete: (id: string) => void;
    onClearUnsaved: () => void;
    onOpenLogView: (log: ConnectionLog) => void;
}

// Format date for display
const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
};

// Format time range
const formatTimeRange = (start: number, end?: number) => {
    const startDate = new Date(start);
    const startTime = startDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
    });

    if (!end) {
        return `${startTime} - ongoing`;
    }

    const endDate = new Date(end);
    const endTime = endDate.toLocaleTimeString("en-US", {
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
    const isLocal = log.protocol === "local" || log.hostname === "localhost";

    return (
        <div
            className="group flex items-center gap-4 px-4 py-3 hover:bg-secondary/60 transition-colors border-b border-border/30 last:border-b-0 cursor-pointer"
            onClick={onClick}
        >
            {/* Date column */}
            <div className="w-32 shrink-0">
                <div className="text-sm font-medium">{formatDate(log.startTime)}</div>
                <div className="text-xs text-muted-foreground">
                    {formatTimeRange(log.startTime, log.endTime)}
                </div>
            </div>

            {/* User column */}
            <div className="flex items-center gap-2 w-56 shrink-0">
                <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <User size={14} />
                </div>
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{log.localUsername}</div>
                    <div className="text-xs text-muted-foreground truncate">{log.localHostname}</div>
                </div>
            </div>

            {/* Host column */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className={cn(
                    "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                    isLocal ? "bg-emerald-500/10 text-emerald-500" : "bg-blue-500/10 text-blue-500"
                )}>
                    {isLocal ? <Terminal size={14} /> : <Server size={14} />}
                </div>
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{isLocal ? "Local Terminal" : log.hostLabel}</div>
                    <div className="text-xs text-muted-foreground truncate">
                        {isLocal ? "local" : `${log.protocol}, ${log.username}`}
                    </div>
                </div>
            </div>

            {/* Saved column */}
            <div className="flex items-center gap-2 shrink-0">
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
                    title={log.saved ? "Unsave" : "Save"}
                >
                    <Bookmark size={16} fill={log.saved ? "currentColor" : "none"} />
                </button>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete(log.id);
                    }}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete"
                >
                    <Trash2 size={16} />
                </button>
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
    const RENDER_LIMIT = 100;

    // Sort logs by newest first
    const filteredLogs = useMemo(() => {
        return [...logs].sort((a, b) => b.startTime - a.startTime);
    }, [logs]);

    const displayedLogs = useMemo(() => {
        return filteredLogs.slice(0, RENDER_LIMIT);
    }, [filteredLogs]);

    const hasMore = filteredLogs.length > RENDER_LIMIT;

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
                        Date
                        <ChevronDown size={12} />
                    </div>
                    <div className="w-56 shrink-0">User</div>
                    <div className="flex-1">Host</div>
                    <div className="w-20 shrink-0 flex items-center gap-1">
                        Saved
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
                                No Connection Logs
                            </h3>
                            <p className="text-sm text-center max-w-sm">
                                Your connection history will appear here when you connect to hosts or open local terminals.
                            </p>
                        </div>
                    ) : (
                        <>
                            {renderedItems}
                            {hasMore && (
                                <div className="text-center py-4 text-sm text-muted-foreground">
                                    Showing {RENDER_LIMIT} of {filteredLogs.length} logs.
                                </div>
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
