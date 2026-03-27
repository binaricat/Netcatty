/**
 * Terminal Connection Dialog
 * Full connection overlay with host info, progress indicator, and auth/progress content
 */
import { Loader2, Plug, TerminalSquare, X } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Host, SSHKey } from '../../types';
import { formatHostPort } from '../../domain/host';
import { DistroAvatar } from '../DistroAvatar';
import { Button } from '../ui/button';
import { TerminalAuthDialog, TerminalAuthDialogProps } from './TerminalAuthDialog';
import { TerminalConnectionProgress, TerminalConnectionProgressProps } from './TerminalConnectionProgress';

export interface ChainProgress {
    currentHop: number;
    totalHops: number;
    currentHostLabel: string;
}

export interface TerminalConnectionDialogProps {
    host: Host;
    status: 'connecting' | 'connected' | 'disconnected';
    error: string | null;
    progressValue: number;
    chainProgress: ChainProgress | null;
    needsAuth: boolean;
    showLogs: boolean;
    _setShowLogs: (show: boolean) => void;
    // Auth dialog props
    authProps: Omit<TerminalAuthDialogProps, 'keys'>;
    keys: SSHKey[];
    onDismissDisconnected?: () => void;
    // Progress props
    progressProps: Omit<TerminalConnectionProgressProps, 'status' | 'error' | 'showLogs'>;
}

// Helper to get protocol display info
const getProtocolInfo = (host: Host): { i18nKey: string; showPort: boolean; port: number } => {
    // Check moshEnabled first since mosh uses protocol: "ssh" with moshEnabled: true
    if (host.moshEnabled) {
        return { i18nKey: 'terminal.connection.protocol.mosh', showPort: true, port: host.port || 22 };
    }
    const protocol = host.protocol || 'ssh';
    switch (protocol) {
        case 'local':
            return { i18nKey: 'terminal.connection.protocol.local', showPort: false, port: 0 };
        case 'telnet':
            // Telnet uses telnetPort, not port (which is SSH port)
            return { i18nKey: 'terminal.connection.protocol.telnet', showPort: true, port: host.telnetPort ?? host.port ?? 23 };
        case 'mosh':
            return { i18nKey: 'terminal.connection.protocol.mosh', showPort: true, port: host.port || 22 };
        case 'serial':
            return { i18nKey: 'terminal.connection.protocol.serial', showPort: false, port: 0 };
        case 'ssh':
        default:
            return { i18nKey: 'terminal.connection.protocol.ssh', showPort: true, port: host.port || 22 };
    }
};

export const TerminalConnectionDialog: React.FC<TerminalConnectionDialogProps> = ({
    host,
    status,
    error,
    progressValue,
    chainProgress,
    needsAuth,
    showLogs,
    _setShowLogs: setShowLogs, // Rename back to setShowLogs for internal use
    authProps,
    keys,
    onDismissDisconnected,
    progressProps,
}) => {
    const { t } = useI18n();
    const hasError = Boolean(error);
    const isConnecting = status === 'connecting';
    const canDismissDisconnected = status === 'disconnected' && !needsAuth && !!onDismissDisconnected;
    const protocolInfo = getProtocolInfo(host);

    return (
        <div className={cn(
            "absolute inset-0 z-20 flex items-center justify-center",
            needsAuth ? "bg-black" : "bg-black/30"
        )}>
            <div
                className="w-[480px] max-w-[88vw] rounded-xl shadow-xl p-4 space-y-3"
                style={{
                    backgroundColor: 'color-mix(in srgb, var(--terminal-ui-bg, var(--background)) 95%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--terminal-ui-fg, var(--foreground)) 12%, var(--terminal-ui-bg, var(--background)) 88%)',
                    color: 'var(--terminal-ui-fg, var(--foreground))',
                }}
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-8 w-8 rounded-md shrink-0" />
                        <div className="min-w-0">
                            {chainProgress ? (
                                <>
                                    <div className="text-xs font-semibold truncate">
                                        <span className="text-muted-foreground">
                                            {t('terminal.connection.chainOf', {
                                                current: chainProgress.currentHop,
                                                total: chainProgress.totalHops,
                                            })}
                                            {': '}
                                        </span>
                                        <span>{chainProgress.currentHostLabel}</span>
                                    </div>
                                    <div
                                        className="text-[10px] font-mono truncate"
                                        style={{ color: 'color-mix(in srgb, var(--terminal-ui-fg, var(--foreground)) 58%, transparent)' }}
                                    >
                                        {t(protocolInfo.i18nKey)} {protocolInfo.showPort ? formatHostPort(host.hostname, protocolInfo.port) : host.hostname}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="text-base font-semibold truncate">{host.label}</div>
                                    <div
                                        className="text-[10px] font-mono truncate"
                                        style={{ color: 'color-mix(in srgb, var(--terminal-ui-fg, var(--foreground)) 58%, transparent)' }}
                                    >
                                        {t(protocolInfo.i18nKey)} {protocolInfo.showPort ? formatHostPort(host.hostname, protocolInfo.port) : host.hostname}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                        {!needsAuth && (
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-3 text-[11px]"
                                onClick={() => setShowLogs(!showLogs)}
                            >
                                {showLogs ? t('terminal.connection.hideLogs') : t('terminal.connection.showLogs')}
                            </Button>
                        )}
                        {status === 'connecting' && !needsAuth && (
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-3 text-[11px]"
                                onClick={progressProps.onCancelConnect}
                                disabled={progressProps.isCancelling}
                            >
                                {progressProps.isCancelling ? t('terminal.progress.cancelling') : t('common.close')}
                            </Button>
                        )}
                        {canDismissDisconnected && (
                            <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                aria-label={t('terminal.connection.dismissDisconnectedDialog')}
                                title={t('terminal.connection.dismissDisconnectedDialog')}
                                onClick={onDismissDisconnected}
                            >
                                <X size={14} />
                            </Button>
                        )}
                    </div>
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center gap-3">
                        <div className={cn(
                            "h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0",
                            needsAuth
                                ? "bg-primary text-primary-foreground"
                                : hasError
                                    ? "bg-destructive/20 text-destructive"
                                : isConnecting
                                        ? "bg-primary/15 text-primary"
                                        : "bg-muted text-muted-foreground"
                        )}>
                            <Plug size={13} />
                        </div>
                        <div className="flex-1 h-1.5 rounded-full bg-border/60 overflow-hidden relative">
                            <div
                                className={cn(
                                    "absolute inset-y-0 left-0 rounded-full transition-all duration-300",
                                    error ? "bg-destructive" : "bg-primary"
                                )}
                                style={{
                                    width: needsAuth ? '0%' : status === 'connecting' ? `${progressValue}%` : error ? '100%' : '100%',
                                }}
                            />
                        </div>
                        <div className={cn(
                            "h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0",
                            hasError ? "bg-destructive/20 text-destructive" : "bg-muted text-muted-foreground"
                        )}>
                            {isConnecting ? (
                                <Loader2 size={13} className="animate-spin" />
                            ) : (
                                <TerminalSquare size={13} />
                            )}
                        </div>
                    </div>
                </div>

                {needsAuth ? (
                    <TerminalAuthDialog {...authProps} keys={keys} />
                ) : (
                    <TerminalConnectionProgress
                        status={status}
                        error={error}
                        showLogs={showLogs}
                        {...progressProps}
                    />
                )}
            </div>
        </div>
    );
};

export default TerminalConnectionDialog;
