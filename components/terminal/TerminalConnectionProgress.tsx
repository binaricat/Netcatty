/**
 * Terminal Connection Progress
 * Displays connection progress with logs and timeout
 */
import { AlertCircle, Clock, Play } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';

export interface TerminalConnectionProgressProps {
    status: 'connecting' | 'connected' | 'disconnected';
    error: string | null;
    timeLeft: number;
    isCancelling: boolean;
    showLogs: boolean;
    progressLogs: string[];
    onCancelConnect: () => void;
    onCloseSession: () => void;
    onRetry: () => void;
}

export const TerminalConnectionProgress: React.FC<TerminalConnectionProgressProps> = ({
    status,
    error,
    timeLeft,
    isCancelling,
    showLogs,
    progressLogs,
    onCancelConnect,
    onCloseSession,
    onRetry,
}) => {
    const { t } = useI18n();

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-2">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        <span>
                            {status === 'connecting'
                                ? t('terminal.progress.timeoutIn', { seconds: timeLeft })
                                : t('terminal.progress.disconnected')}
                        </span>
                    </div>
                    {error && (
                        <div className="max-w-[36rem] text-base leading-7 text-foreground/88">
                            {error}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {status === 'connecting' ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 rounded-md border border-border/60 px-3 text-muted-foreground hover:text-foreground"
                            onClick={onCancelConnect}
                            disabled={isCancelling}
                        >
                            {isCancelling ? t('terminal.progress.cancelling') : t('common.close')}
                        </Button>
                    ) : (
                        <div className="flex gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 rounded-md border border-border/60 px-3 text-muted-foreground hover:text-foreground"
                                onClick={onCloseSession}
                            >
                                {t('terminal.toolbar.closeSession')}
                            </Button>
                            <Button size="sm" className="h-9 rounded-md px-4" onClick={onRetry}>
                                <Play className="h-3 w-3 mr-2" /> {t('terminal.progress.startOver')}
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {showLogs && (
                <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/10">
                    <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
                        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                            {t('terminal.connection.traceLabel')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {progressLogs.length + (error ? 1 : 0)}
                        </div>
                    </div>
                    <ScrollArea className="max-h-56">
                        <div className="space-y-1 px-4 py-3 text-[13px] leading-6 text-foreground/90">
                            {progressLogs.map((line, idx) => (
                                <div key={idx} className="grid grid-cols-[10px_minmax(0,1fr)] items-start gap-3 py-1">
                                    <div className="mt-2 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    <div className="min-w-0 break-words">{line}</div>
                                </div>
                            ))}
                            {error && (
                                <div className="mt-2 grid grid-cols-[10px_minmax(0,1fr)] items-start gap-3 border-t border-destructive/25 pt-3 text-destructive">
                                    <AlertCircle className="mt-1 h-3.5 w-3.5" />
                                    <div className="min-w-0 break-words">{error}</div>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </div>
            )}
        </div>
    );
};

export default TerminalConnectionProgress;
