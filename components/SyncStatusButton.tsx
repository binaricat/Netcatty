/**
 * SyncStatusButton - Cloud Sync Status Indicator for Top Bar
 *
 * Shows current sync state with cloud icon and colored indicators:
 * - Green dot: All synced
 * - Blue dot + spin: Syncing in progress
 * - Red dot: Error
 * - Gray dot: No providers connected
 *
 * Clicking opens a popover with sync status details and history.
 */

import React, { useState } from 'react';
import {
    Cloud,
    CloudOff,
    Github,
    Loader2,
    RefreshCw,
    Settings,
    X,
    ArrowUp,
    ArrowDown,
    Database,
    Server,
} from 'lucide-react';
import { useCloudSync } from '../application/state/useCloudSync';
import { isProviderReadyForSync, type CloudProvider } from '../domain/sync';
import { useI18n } from '../application/i18n/I18nProvider';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from './ui/popover';
import { toast } from './ui/toast';

// ============================================================================
// Provider Icons
// ============================================================================

const GoogleDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M7.71 3.5L1.15 15l3.43 6 6.55-11.5L7.71 3.5zm1.73 0l6.55 11.5H23L16.45 3.5H9.44zM8 15l-3.43 6h13.72l3.43-6H8z" />
    </svg>
);

const OneDriveIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M10.5 18.5c0 .55-.45 1-1 1h-5c-2.21 0-4-1.79-4-4 0-1.86 1.28-3.41 3-3.86v-.14c0-2.21 1.79-4 4-4 1.1 0 2.1.45 2.82 1.18A5.003 5.003 0 0 1 15 4c2.76 0 5 2.24 5 5 0 .16 0 .32-.02.47A4.5 4.5 0 0 1 24 13.5c0 2.49-2.01 4.5-4.5 4.5h-8c-.55 0-1-.45-1-1s.45-1 1-1h8c1.38 0 2.5-1.12 2.5-2.5s-1.12-2.5-2.5-2.5H19c-.28 0-.5-.22-.5-.5 0-2.21-1.79-4-4-4-1.87 0-3.44 1.28-3.88 3.02-.09.37-.41.63-.79.63-1.66 0-3 1.34-3 3v.5c0 .28-.22.5-.5.5-1.38 0-2.5 1.12-2.5 2.5s1.12 2.5 2.5 2.5h5c.55 0 1 .45 1 1z" />
    </svg>
);

const providerIcons: Record<CloudProvider, React.ReactNode> = {
    github: <Github size={16} />,
    google: <GoogleDriveIcon className="w-4 h-4" />,
    onedrive: <OneDriveIcon className="w-4 h-4" />,
    webdav: <Server size={16} />,
    s3: <Database size={16} />,
};

const providerNames: Record<CloudProvider, string> = {
    github: 'GitHub Gist',
    google: 'Google Drive',
    onedrive: 'OneDrive',
    webdav: 'WebDAV',
    s3: 'S3 Compatible',
};

// ============================================================================
// Status Dot Component
// ============================================================================

interface StatusIndicatorProps {
    status: 'synced' | 'syncing' | 'error' | 'none';
    size?: 'sm' | 'md';
    className?: string;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status, size = 'sm', className }) => {
    const sizeClass = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';

    const baseClasses = cn(
        'rounded-full',
        sizeClass,
        status === 'syncing' && 'animate-pulse',
        className
    );

    const colors = {
        synced: 'bg-green-500',
        syncing: 'bg-blue-500',
        error: 'bg-red-500',
        none: 'bg-muted-foreground/30',
    };

    return <span className={cn(baseClasses, colors[status])} />;
};

// ============================================================================
// Main SyncStatusButton Component
// ============================================================================

interface SyncStatusButtonProps {
    onOpenSettings?: () => void;
    onSyncNow?: () => Promise<void>; // Callback to trigger sync with current data
    className?: string;
}

export const SyncStatusButton: React.FC<SyncStatusButtonProps> = ({
    onOpenSettings,
    onSyncNow,
    className,
}) => {
    const { t } = useI18n();
    const [isOpen, setIsOpen] = useState(false);
    const [isSyncingManual, setIsSyncingManual] = useState(false);
    const sync = useCloudSync();

    // State is now automatically synced via useSyncExternalStore - no manual refresh needed

    // Get connected provider (include syncing status as it's still connected)
    const getConnectedProvider = (): CloudProvider | null => {
        if (isProviderReadyForSync(sync.providers.github)) return 'github';
        if (isProviderReadyForSync(sync.providers.google)) return 'google';
        if (isProviderReadyForSync(sync.providers.onedrive)) return 'onedrive';
        if (isProviderReadyForSync(sync.providers.webdav)) return 'webdav';
        if (isProviderReadyForSync(sync.providers.s3)) return 's3';
        return null;
    };

    const connectedProvider = getConnectedProvider();
    const providerConnection = connectedProvider ? sync.providers[connectedProvider] : null;

    // Determine overall status for the button indicator
    const getOverallStatus = (): StatusIndicatorProps['status'] => {
        if (sync.overallSyncStatus === 'syncing') return 'syncing';
        if (
            sync.overallSyncStatus === 'error' ||
            sync.overallSyncStatus === 'conflict' ||
            sync.overallSyncStatus === 'blocked'
        ) {
            return 'error';
        }
        if (sync.overallSyncStatus === 'synced') return 'synced';
        return 'none';
    };

    const overallStatus = getOverallStatus();

    // Get the button icon based on state
    const getButtonIcon = () => {
        if (sync.isSyncing) return <Loader2 size={16} className="animate-spin" />;
        if (sync.hasAnyConnectedProvider) return <Cloud size={16} />;
        return <CloudOff size={16} />;
    };

    const formatTime = (timestamp?: number): string => {
        if (!timestamp) return t('time.never');
        const diff = Date.now() - timestamp;
        if (diff < 60000) return t('time.justNow');
        if (diff < 3600000) return t('time.minutesAgo', { minutes: Math.floor(diff / 60000) });
        return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    // Create a unique key based on sync state to force re-render
    const syncStateKey = `${sync.localVersion}-${sync.remoteVersion}-${sync.syncHistory.length}`;

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                        "h-8 w-8 relative text-muted-foreground hover:text-foreground app-no-drag",
                        className
                    )}
                    title={t('sync.cloudSync')}
                >
                    {getButtonIcon()}

                    {/* Status indicator dot */}
                    <StatusIndicator
                        status={overallStatus}
                        size="sm"
                        className="absolute top-0.5 right-0.5 ring-2 ring-background"
                    />
                </Button>
            </PopoverTrigger>

            <PopoverContent
                key={syncStateKey}
                className="w-80 p-0"
                align="end"
                sideOffset={8}
            >
                {/* Header */}
                <div className="px-3 py-2.5 border-b border-border/60">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {overallStatus === 'synced' && (
                                <Cloud size={16} className="text-green-500" />
                            )}
                            {overallStatus === 'syncing' && (
                                <Loader2 size={16} className="text-blue-500 animate-spin" />
                            )}
                            {overallStatus === 'error' && (
                                <Cloud size={16} className="text-red-500" />
                            )}
                            {overallStatus === 'none' && (
                                <CloudOff size={16} className="text-muted-foreground" />
                            )}

                            <span className="text-sm font-medium">
                                {overallStatus === 'synced' && t('sync.active')}
                                {overallStatus === 'syncing' && t('sync.syncing')}
                                {overallStatus === 'error' && t('sync.error')}
                                {overallStatus === 'none' && t('sync.notConfigured')}
                            </span>
                        </div>

                        {onOpenSettings && (
                            <button
                                onClick={() => {
                                    setIsOpen(false);
                                    onOpenSettings();
                                }}
                                className="p-1 rounded hover:bg-muted transition-colors"
                                title={t('sync.settings')}
                            >
                                <Settings size={14} className="text-muted-foreground" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Content based on state */}
                <div className="p-3">
                    {!sync.hasAnyConnectedProvider ? (
                        // No provider connected
                        <div className="text-center py-4">
                            <CloudOff size={32} className="mx-auto mb-2 text-muted-foreground" />
                            <p className="text-sm font-medium mb-1">{t('sync.notConfigured')}</p>
                            <p className="text-xs text-muted-foreground mb-3">
                                {t('sync.autoSync.noProvider')}
                            </p>
                            <Button
                                size="sm"
                                className="w-full"
                                onClick={() => {
                                    setIsOpen(false);
                                    onOpenSettings?.();
                                }}
                            >
                                {t('sync.settings')}
                            </Button>
                        </div>
                    ) : (
                        // Provider connected - show details
                        <div className="space-y-3">
                            {/* Connected Provider Info */}
                            {connectedProvider && providerConnection && (
                                <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                                    <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                                        {providerIcons[connectedProvider]}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium">{providerNames[connectedProvider]}</span>
                                            <StatusIndicator status={overallStatus} />
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            {providerConnection.account?.avatarUrl && (
                                                <img
                                                    src={providerConnection.account.avatarUrl}
                                                    alt=""
                                                    className="w-4 h-4 rounded-full"
                                                    referrerPolicy="no-referrer"
                                                />
                                            )}
                                            <span className="text-xs text-muted-foreground truncate">
                                                {providerConnection.account?.name ||
                                                  providerConnection.account?.email ||
                                                  t('sync.connected')}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Version Info */}
                            <div className="grid grid-cols-2 gap-2">
                                <div className="p-2 rounded-lg bg-muted/30">
                                    <div className="text-[10px] text-muted-foreground uppercase mb-0.5">
                                      {t('cloudSync.conflict.local')}
                                    </div>
                                    <div className="text-sm font-medium">v{sync.localVersion}</div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {formatTime(sync.localUpdatedAt)}
                                    </div>
                                </div>
                                <div className="p-2 rounded-lg bg-muted/30">
                                    <div className="text-[10px] text-muted-foreground uppercase mb-0.5">
                                      {t('cloudSync.conflict.cloud')}
                                    </div>
                                    <div className="text-sm font-medium">v{sync.remoteVersion}</div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {formatTime(sync.remoteUpdatedAt)}
                                    </div>
                                </div>
                            </div>

                            {/* Recent Sync History */}
                            {sync.syncHistory.length > 0 && (
                                <div>
                                    <div className="text-xs text-muted-foreground mb-1.5">
                                      {t('sync.recentActivity')}
                                    </div>
                                    <div className="space-y-1 max-h-32 overflow-y-auto">
                                        {sync.syncHistory.slice(0, 5).map((entry) => (
                                            <div key={entry.id} className="flex items-center gap-2 text-xs py-1">
                                                <div className={cn(
                                                    "w-4 h-4 rounded-full flex items-center justify-center shrink-0",
                                                    entry.success ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
                                                )}>
                                                    {entry.success ? (
                                                        entry.action === 'upload' ? <ArrowUp size={10} /> : <ArrowDown size={10} />
                                                    ) : (
                                                        <X size={10} />
                                                    )}
                                                </div>
                                                <span className="text-muted-foreground flex-1 truncate">
                                                    {entry.action === 'upload'
                                                      ? t('sync.history.uploaded')
                                                      : entry.action === 'download'
                                                        ? t('sync.history.downloaded')
                                                        : t('sync.history.resolved')}{' '}
                                                    v{entry.localVersion}
                                                </span>
                                                <span className="text-muted-foreground/60 shrink-0">
                                                    {formatTime(entry.timestamp)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Sync Button */}
                            <Button
                                size="sm"
                                variant="outline"
                                className="w-full gap-1"
                                disabled={sync.isSyncing || isSyncingManual}
                                onClick={async () => {
                                    if (onSyncNow) {
                                        setIsSyncingManual(true);
                                         try {
                                             await onSyncNow();
                                            toast.success(t('sync.toast.completedMessage'), t('sync.cloudSync'));
                                         } catch (error) {
                                            toast.error(
                                                error instanceof Error ? error.message : t('sync.failed'),
                                                t('sync.toast.errorTitle'),
                                            );
                                         } finally {
                                            setIsSyncingManual(false);
                                         }
                                    } else {
                                        setIsOpen(false);
                                        onOpenSettings?.();
                                    }
                                }}
                            >
                                {(sync.isSyncing || isSyncingManual) ? (
                                    <Loader2 size={14} className="animate-spin" />
                                ) : (
                                    <RefreshCw size={14} />
                                )}
                                {t('sync.syncNow')}
                            </Button>
                        </div>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
};

export default SyncStatusButton;
