/**
 * Terminal Connection Dialog
 * Full connection overlay with host info, progress indicator, and auth/progress content
 */
import { Fingerprint, Loader2, Plug, TerminalSquare, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Host, SSHKey } from '../../types';
import { formatHostPort, resolveTelnetPort } from '../../domain/host';
import { isPluginHostProtocol } from '../../domain/pluginConnection';
import { DistroAvatar } from '../DistroAvatar';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { TerminalAuthDialog, TerminalAuthDialogProps } from './TerminalAuthDialog';
import { TerminalConnectionProgress, TerminalConnectionProgressProps } from './TerminalConnectionProgress';
import { HostKeyInfo, TerminalHostKeyVerification } from './TerminalHostKeyVerification';
import {
    resolveDisconnectedDialogTerminalRoot,
    restoreTerminalFocusFromDisconnectedDialog,
    shouldClaimDisconnectedDialogFocus,
    shouldReconnectDisconnectedDialogOnEnterKey,
    shouldRestoreDisconnectedDialogTerminalFocus,
} from './terminalHelpers';

export interface ChainProgress {
    currentHop: number;
    totalHops: number;
    currentHostLabel: string;
}

export interface TerminalConnectionDialogProps {
    host: Host;
    status: 'connecting' | 'connected' | 'disconnected';
    restoreState?: 'restored-disconnected';
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
    showEnterReconnectHint?: boolean;
    /** False for unfocused split siblings — do not claim body/document focus. */
    isFocusedPane?: boolean;
    hostKeyVerification?: {
        hostKeyInfo: HostKeyInfo;
        onClose: () => void;
        onContinue: () => void;
        onAddAndContinue: () => void;
    };
    // Progress props
    progressProps: Omit<TerminalConnectionProgressProps, 'status' | 'error' | 'showLogs' | 'showEnterReconnectHint'>;
}

// Helper to get protocol display info
const getProtocolInfo = (host: Host): { i18nKey: string; showPort: boolean; port: number } => {
    // Check moshEnabled first since mosh uses protocol: "ssh" with moshEnabled: true
    if (host.moshEnabled) {
        return { i18nKey: 'terminal.connection.protocol.mosh', showPort: true, port: host.port || 22 };
    }
    // ET likewise uses protocol: "ssh" with etEnabled: true. Show the ET
    // server port (default 2022) rather than the SSH port: ET connectivity
    // hinges on the etserver port, so surfacing the SSH port (22) here is
    // misleading when troubleshooting a connection that is actually stuck on
    // the ET port.
    if (host.etEnabled) {
        return { i18nKey: 'terminal.connection.protocol.et', showPort: true, port: host.etPort || 2022 };
    }
    const protocol = host.protocol || 'ssh';
    if (isPluginHostProtocol(protocol)) {
        return { i18nKey: 'terminal.connection.protocol.plugin', showPort: false, port: 0 };
    }
    switch (protocol) {
        case 'local':
            return { i18nKey: 'terminal.connection.protocol.local', showPort: false, port: 0 };
        case 'telnet':
            // Telnet uses telnetPort, not port (which is SSH port)
            return { i18nKey: 'terminal.connection.protocol.telnet', showPort: true, port: resolveTelnetPort(host) };
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
    restoreState,
    error,
    progressValue,
    chainProgress,
    needsAuth,
    showLogs,
    _setShowLogs: setShowLogs, // Rename back to setShowLogs for internal use
    authProps,
    keys,
    onDismissDisconnected,
    showEnterReconnectHint,
    isFocusedPane,
    hostKeyVerification,
    progressProps,
}) => {
    const { t } = useI18n();
    const hasError = Boolean(error);
    const isRestoredDisconnected = status === 'disconnected' && restoreState === 'restored-disconnected';
    const isConnecting = status === 'connecting';
    const canDismissDisconnected = status === 'disconnected' && !needsAuth && !!onDismissDisconnected;
    const protocolInfo = getProtocolInfo(host);
    const isVerifyingHostKey = Boolean(hostKeyVerification);
    const isHostKeyChanged = hostKeyVerification?.hostKeyInfo.status === 'changed';
    const shouldCompleteProgress = hasError || (!isConnecting && !needsAuth);
    // When the disconnected overlay is up and Enter-reconnect is advertised,
    // keep a focus sink on the overlay itself so body/document focus loss cannot
    // make the hint lie (#2544). Auth/host-key flows keep their own inputs.
    const onRetry = progressProps.onRetry;
    const canEnterReconnectFromDialog = Boolean(
        showEnterReconnectHint
        && status === 'disconnected'
        && !needsAuth
        && !isVerifyingHostKey
        && onRetry,
    );
    const dialogFocusRef = useRef<HTMLDivElement | null>(null);
    // Unmount cleanup keeps [] deps; read the latest pane ownership then.
    const isFocusedPaneRef = useRef(isFocusedPane);
    isFocusedPaneRef.current = isFocusedPane;

    // Claim focus only when Enter-reconnect mode turns on — not on every
    // showLogs/error rerender (those would steal keyboard focus off buttons).
    useEffect(() => {
        if (!canEnterReconnectFromDialog) return;
        const node = dialogFocusRef.current;
        if (!node) return;
        const sessionRoot = node.closest("[data-session-id]");
        const focusOverlay = () => {
            if (typeof document === "undefined") return;
            if (!shouldClaimDisconnectedDialogFocus({
                activeElement: document.activeElement,
                dialogNode: node,
                sessionRoot,
                documentBody: document.body,
                documentElement: document.documentElement,
                isFocusedPane,
            })) {
                return;
            }
            node.focus({ preventScroll: true });
        };
        focusOverlay();
        // Re-assert after paint/microtasks so late blur from xterm teardown
        // cannot leave focus on document.body — still never steals other panes.
        const timer = window.setTimeout(focusOverlay, 0);
        return () => window.clearTimeout(timer);
    }, [canEnterReconnectFromDialog, isFocusedPane]);

    // Restore xterm focus only when this overlay unmounts (connected / dismiss).
    // Do not key on Enter-reconnect mode: reconnect may keep the dialog mounted
    // for connecting / auth / host-key, and restoring then routes keyboard behind
    // the blocking overlay.
    useEffect(() => {
        const node = dialogFocusRef.current;
        if (!node) return;
        // Capture the terminal root while the dialog is still mounted — after
        // unmount, parentElement is null and popup trees have no data-session-id.
        const sessionRoot = resolveDisconnectedDialogTerminalRoot(
            node,
            node.closest("[data-session-id]"),
        );
        return () => {
            if (typeof document === "undefined") return;
            if (!shouldRestoreDisconnectedDialogTerminalFocus(node)) return;
            restoreTerminalFocusFromDisconnectedDialog({
                activeElement: document.activeElement,
                dialogNode: node,
                sessionRoot,
                documentBody: document.body,
                documentElement: document.documentElement,
                isFocusedPane: isFocusedPaneRef.current,
            });
        };
    }, []);

    const handleDialogKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!shouldReconnectDisconnectedDialogOnEnterKey({
            key: event.key,
            enabled: canEnterReconnectFromDialog,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            isComposing: event.nativeEvent.isComposing,
            target: event.target,
        })) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        onRetry?.();
    }, [canEnterReconnectFromDialog, onRetry]);
    const targetFirstSegmentWidth = isVerifyingHostKey || shouldCompleteProgress
        ? 100
        : Math.min(100, progressValue * 2);
    const targetSecondSegmentWidth = isVerifyingHostKey
        ? 0
        : shouldCompleteProgress
            ? 100
            : Math.max(0, Math.min(100, (progressValue - 50) * 2));
    const [secondSegmentUnlocked, setSecondSegmentUnlocked] = React.useState(
        () => shouldCompleteProgress || targetSecondSegmentWidth <= 0
    );
    const secondSegmentUnlockTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (secondSegmentUnlockTimerRef.current) {
                clearTimeout(secondSegmentUnlockTimerRef.current);
            }
        };
    }, []);

    React.useEffect(() => {
        if (needsAuth || isVerifyingHostKey || targetSecondSegmentWidth <= 0 || shouldCompleteProgress) {
            if (secondSegmentUnlockTimerRef.current) {
                clearTimeout(secondSegmentUnlockTimerRef.current);
                secondSegmentUnlockTimerRef.current = null;
            }
            setSecondSegmentUnlocked(shouldCompleteProgress);
            return;
        }

        if (secondSegmentUnlocked || secondSegmentUnlockTimerRef.current) return;

        secondSegmentUnlockTimerRef.current = setTimeout(() => {
            secondSegmentUnlockTimerRef.current = null;
            setSecondSegmentUnlocked(true);
        }, 320);
    }, [isVerifyingHostKey, needsAuth, secondSegmentUnlocked, shouldCompleteProgress, targetSecondSegmentWidth]);

    const firstSegmentWidth = targetFirstSegmentWidth;
    const secondSegmentWidth = shouldCompleteProgress || secondSegmentUnlocked ? targetSecondSegmentWidth : 0;

    return (
        <div
            className="absolute inset-0 z-20 flex items-center justify-center"
            style={{
                backgroundColor: needsAuth
                    ? 'var(--terminal-ui-bg, var(--background))'
                    : 'color-mix(in srgb, var(--terminal-ui-bg, var(--background)) 35%, transparent)',
            }}
            onMouseDown={(event) => {
                // Clicking the dimmed backdrop (not a control) should park focus
                // on the overlay so the next Enter still reconnects.
                if (!canEnterReconnectFromDialog) return;
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                if (target.closest("button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='menuitem'], [role='textbox']")) {
                    return;
                }
                dialogFocusRef.current?.focus({ preventScroll: true });
            }}
        >
            <div
                ref={dialogFocusRef}
                tabIndex={canEnterReconnectFromDialog ? -1 : undefined}
                data-terminal-disconnected-dialog={canEnterReconnectFromDialog ? 'true' : undefined}
                onKeyDown={handleDialogKeyDown}
                className="w-[540px] max-w-[88vw] rounded-xl shadow-xl p-4 space-y-3 transition-all duration-200 outline-none"
                style={{
                    backgroundColor: 'color-mix(in srgb, var(--terminal-ui-bg, var(--background)) 95%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--terminal-ui-fg, var(--foreground)) 12%, var(--terminal-ui-bg, var(--background)) 88%)',
                    color: 'var(--terminal-ui-fg, var(--foreground))',
                }}
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <DistroAvatar host={host} fallback={host.label.slice(0, 2).toUpperCase()} size="md" className="shrink-0" />
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
                        {status === 'connecting' && !needsAuth && !isVerifyingHostKey && (
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
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        aria-label={t('terminal.connection.dismissDisconnectedDialog')}
                                        onClick={onDismissDisconnected}
                                    >
                                        <X size={14} />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('terminal.connection.dismissDisconnectedDialog')}</TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center gap-3">
                        <div className={cn(
                            "h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0",
                            needsAuth || isVerifyingHostKey
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
                                style={{ width: needsAuth ? '0%' : `${firstSegmentWidth}%` }}
                            />
                        </div>
                        <div className={cn(
                            "h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-200",
                            isHostKeyChanged
                                ? "bg-destructive/15 text-destructive ring-2 ring-destructive/25 animate-pulse"
                                : isVerifyingHostKey
                                    ? "bg-amber-500/15 text-amber-400 ring-2 ring-amber-400/25 animate-pulse"
                                    : progressValue > 50 && !hasError
                                        ? "bg-primary/15 text-primary"
                                        : hasError
                                            ? "bg-destructive/20 text-destructive"
                                            : "bg-muted text-muted-foreground"
                        )}>
                            <Fingerprint size={13} />
                        </div>
                        <div className="flex-1 h-1.5 rounded-full bg-border/60 overflow-hidden relative">
                            <div
                                className={cn(
                                    "absolute inset-y-0 left-0 rounded-full transition-all duration-300",
                                    error ? "bg-destructive" : "bg-primary"
                                )}
                                style={{ width: needsAuth || isVerifyingHostKey ? '0%' : `${secondSegmentWidth}%` }}
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
                ) : hostKeyVerification ? (
                    <TerminalHostKeyVerification
                        hostKeyInfo={hostKeyVerification.hostKeyInfo}
                        showLogs={showLogs}
                        progressLogs={progressProps.progressLogs}
                        onClose={hostKeyVerification.onClose}
                        onContinue={hostKeyVerification.onContinue}
                        onAddAndContinue={hostKeyVerification.onAddAndContinue}
                    />
                ) : (
                    <>
                        {isRestoredDisconnected && (
                            <div className="rounded-md border border-border/35 bg-background/35 p-3 text-xs leading-5">
                                <div className="font-semibold">{t('terminal.restore.placeholder.title')}</div>
                                <div
                                    className="mt-1"
                                    style={{ color: 'color-mix(in srgb, var(--terminal-ui-fg, var(--foreground)) 68%, transparent)' }}
                                >
                                    {t('terminal.restore.placeholder.desc')}
                                </div>
                            </div>
                        )}
                        <TerminalConnectionProgress
                            status={status}
                            error={error}
                            showLogs={showLogs}
                            showEnterReconnectHint={showEnterReconnectHint}
                            reconnectLabel={isRestoredDisconnected ? t('terminal.restore.placeholder.reconnect') : undefined}
                            {...progressProps}
                        />
                    </>
                )}
            </div>
        </div>
    );
};

export default TerminalConnectionDialog;
