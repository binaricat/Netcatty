/**
 * Terminal Connection Dialog
 * Full connection overlay with host info, progress indicator, and auth/progress content
 */
import { User } from 'lucide-react';
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
    progressProps,
}) => {
    const { t } = useI18n();
    const hasError = Boolean(error);
    const isConnecting = status === 'connecting';
    const protocolInfo = getProtocolInfo(host);

    return (
        <div className={cn(
            "absolute inset-0 z-20 flex items-center justify-center",
            needsAuth ? "bg-black" : "bg-black/30"
        )}>
            <div className="w-[560px] max-w-[90vw] bg-background/95 border border-border/60 rounded-2xl shadow-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} className="h-10 w-10" />
                        <div>
                            {/* Show chain progress if available */}
                            {chainProgress ? (
                                <>
                                    <div className="text-sm font-semibold">
                                        <span className="text-muted-foreground">
                                            {t('terminal.connection.chainOf', {
                                                current: chainProgress.currentHop,
                                                total: chainProgress.totalHops,
                                            })}
                                            {': '}
                                        </span>
                                        <span>{chainProgress.currentHostLabel}</span>
                                    </div>
                                    <div className="text-[11px] text-muted-foreground font-mono">
                                        {t(protocolInfo.i18nKey)} {protocolInfo.showPort ? `${host.hostname}:${protocolInfo.port}` : host.hostname}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="text-sm font-semibold">{host.label}</div>
                                    <div className="text-[11px] text-muted-foreground font-mono">
                                        {t(protocolInfo.i18nKey)} {protocolInfo.showPort ? `${host.hostname}:${protocolInfo.port}` : host.hostname}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                    {!needsAuth && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={() => setShowLogs(!showLogs)}
                        >
                            {showLogs ? t('terminal.connection.hideLogs') : t('terminal.connection.showLogs')}
                        </Button>
                    )}
                </div>

                {/* Progress indicator - icons with progress bar below */}
                <div className="space-y-2">
                    <div className="flex items-center gap-3">
                        <div className={cn(
                            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                            needsAuth
                                ? "bg-primary text-primary-foreground"
                                : hasError
                                    ? "bg-destructive/20 text-destructive"
                                    : isConnecting
                                        ? "bg-primary/15 text-primary"
                                        : "bg-muted text-muted-foreground"
                        )}>
                            <User size={14} />
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
                            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                            hasError ? "bg-destructive/20 text-destructive" : "bg-muted text-muted-foreground"
                        )}>
                            {'>_'}
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
