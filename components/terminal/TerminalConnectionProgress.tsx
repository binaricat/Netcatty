/**
 * Terminal Connection Progress
 * Displays connection progress with logs and timeout
 */
import { Loader2, Play } from 'lucide-react';
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
    isCancelling: _isCancelling,
    showLogs,
    progressLogs,
    onCancelConnect: _onCancelConnect,
    onCloseSession,
    onRetry,
}) => {
    const { t } = useI18n();

    return (
        <>
            <div className="flex items-start justify-between gap-3 text-[11px] text-muted-foreground">
                <div className="flex min-w-0 items-start gap-2">
                    {status === 'connecting' ? (
                        <>
                            <Loader2 className="h-3 w-3 mt-0.5 flex-shrink-0 animate-spin" />
                            <span className="min-w-0 whitespace-pre-wrap break-words leading-5">
                                {t('terminal.progress.timeoutIn', { seconds: timeLeft })}
                            </span>
                        </>
                    ) : (
                        <>
                            <div className="mt-[0.4rem] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-destructive" />
                            <span className="min-w-0 whitespace-pre-wrap break-words leading-5 text-destructive">
                                {error || t('terminal.progress.disconnected')}
                            </span>
                        </>
                    )}
                </div>
            </div>

            {showLogs && (
                <div className="rounded-md border border-border/35 bg-background/40">
                    <ScrollArea className="max-h-44 p-2.5">
                        <div className="space-y-1 text-xs text-foreground/90">
                            {progressLogs.map((line, idx) => (
                                <div key={idx} className="flex items-start gap-2">
                                    <div className="mt-[0.4rem] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />
                                    <div className="min-w-0 break-words leading-5">{line}</div>
                                </div>
                            ))}
                            {error && (
                                <div className="flex items-start gap-2 text-destructive">
                                    <div className="mt-[0.4rem] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-destructive" />
                                    <div className="min-w-0 break-words leading-5">{error}</div>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </div>
            )}

            <div className="flex justify-end gap-2">
                {status !== 'connecting' && (
                    <>
                        <Button variant="ghost" size="sm" className="h-7 px-3 text-[11px]" onClick={onCloseSession}>
                            {t('terminal.toolbar.closeSession')}
                        </Button>
                        <Button size="sm" className="h-7 px-3 text-[11px]" onClick={onRetry}>
                            <Play className="h-3 w-3 mr-1.5" /> {t('terminal.progress.startOver')}
                        </Button>
                    </>
                )}
            </div>
        </>
    );
};

export default TerminalConnectionProgress;
