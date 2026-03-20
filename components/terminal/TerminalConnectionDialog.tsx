/**
 * Terminal Connection Dialog
 * Full connection overlay with host info, progress indicator, and auth/progress content
 */
import { Loader2, TerminalSquare, User, X } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Host, SSHKey } from '../../types';
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
    const statusLabel = needsAuth
        ? t('terminal.connection.status.authentication')
        : status === 'connecting'
            ? t('terminal.connection.status.connecting')
            : t('terminal.connection.status.disconnected');
    const protocolInfo = getProtocolInfo(host);

    return (
        <div className={cn(
            "absolute inset-0 z-20 flex items-center justify-center px-6 py-8",
            needsAuth ? "bg-black/70 backdrop-blur-[1.5px]" : "bg-black/45 backdrop-blur-[1px]"
        )}>
            <div className="w-[620px] max-w-[92vw] overflow-hidden rounded-xl border border-border/70 bg-background/95 shadow-[0_32px_90px_-40px_rgba(0,0,0,0.88)]">
                <div className="border-b border-border/60 px-6 py-5">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-4">
                            <DistroAvatar
                                host={host}
                                fallback={host.label.slice(0, 2).toUpperCase()}
                                className="h-11 w-11 rounded-lg ring-1 ring-white/10"
                            />
                            <div className="min-w-0">
                                <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground/80">
                                    <span
                                        className={cn(
                                            "inline-block h-1.5 w-1.5 rounded-full",
                                            needsAuth
                                                ? "bg-primary"
                                                : hasError
                                                    ? "bg-destructive"
                                                    : isConnecting
                                                        ? "bg-amber-400"
                                                        : "bg-muted-foreground"
                                        )}
                                    />
                                    <span>{statusLabel}</span>
                                </div>
                                <div className="truncate text-[28px] font-semibold leading-none tracking-tight text-foreground">
                                    {host.label}
                                </div>
                                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                                    <span className="text-foreground/70">{t(protocolInfo.i18nKey)}</span>
                                    <span className="text-border/80">/</span>
                                    <span className="truncate font-mono text-[13px]">
                                        {protocolInfo.showPort ? `${host.hostname}:${protocolInfo.port}` : host.hostname}
                                    </span>
                                </div>
                                {chainProgress && (
                                    <div className="mt-2 text-[12px] text-muted-foreground">
                                        {t('terminal.connection.chainOf', {
                                            current: chainProgress.currentHop,
                                            total: chainProgress.totalHops,
                                        })}
                                        {': '}
                                        <span className="text-foreground/80">{chainProgress.currentHostLabel}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            {!needsAuth && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 rounded-md border border-border/60 px-3 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => setShowLogs(!showLogs)}
                                >
                                    {showLogs ? t('terminal.connection.hideLogs') : t('terminal.connection.showLogs')}
                                </Button>
                            )}
                            {canDismissDisconnected && (
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
                                    aria-label={t('terminal.connection.dismissDisconnectedDialog')}
                                    title={t('terminal.connection.dismissDisconnectedDialog')}
                                    onClick={onDismissDisconnected}
                                >
                                    <X size={14} />
                                </Button>
                            )}
                        </div>
                    </div>
                </div>

                <div className="border-b border-border/60 px-6 py-4">
                    <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] items-center gap-4">
                        <div className={cn(
                            "flex h-10 w-10 items-center justify-center rounded-md border border-border/70 bg-muted/15",
                            needsAuth
                                ? "text-primary"
                                : hasError
                                    ? "text-destructive"
                                    : isConnecting
                                        ? "text-primary"
                                        : "text-muted-foreground"
                        )}>
                            <User size={15} />
                        </div>
                        <div className={cn(
                            "relative h-[2px] overflow-hidden bg-border/60",
                            hasError && "bg-destructive/20"
                        )}>
                            <div
                                className={cn(
                                    "absolute inset-y-0 left-0 transition-all duration-300",
                                    error ? "bg-destructive" : "bg-primary"
                                )}
                                style={{
                                    width: needsAuth ? '0%' : status === 'connecting' ? `${progressValue}%` : '100%',
                                }}
                            />
                        </div>
                        <div className={cn(
                            "flex h-10 w-10 items-center justify-center rounded-md border border-border/70 bg-muted/15",
                            hasError ? "text-destructive" : "text-muted-foreground"
                        )}>
                            {isConnecting ? <Loader2 size={15} className="animate-spin" /> : <TerminalSquare size={15} />}
                        </div>
                    </div>
                </div>

                <div className="px-6 py-5">
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
        </div>
    );
};

export default TerminalConnectionDialog;
