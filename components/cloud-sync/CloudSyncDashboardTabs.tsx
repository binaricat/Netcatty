import React, { type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Database, Github, History, Server, Trash2 } from 'lucide-react';
import type { CloudProvider, SyncPayload } from '../../domain/sync';
import type { useCloudSync } from '../../application/state/useCloudSync';
import { isProviderReadyForSync } from '../../domain/sync';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { GoogleDriveIcon, OneDriveIcon, ProviderCard, Toggle } from './CloudSyncControls';
import { LocalBackupsPanel } from './CloudSyncLocalBackupsPanel';

type SyncController = ReturnType<typeof useCloudSync>;
type Translate = (key: string, values?: Record<string, string | number>) => string;

interface CloudSyncDashboardTabsProps {
  activeTab: 'providers' | 'status';
  setActiveTab: Dispatch<SetStateAction<'providers' | 'status'>>;
  t: Translate;
  sync: SyncController;
  resolvedLocale: string | null;
  localBackupsRef: RefObject<HTMLDivElement | null>;
  isConnectDisabled: (provider: CloudProvider) => boolean;
  handleConnectGitHub: () => Promise<void>;
  handleConnectGoogle: () => Promise<void>;
  handleConnectOneDrive: () => Promise<void>;
  openWebdavDialog: () => void;
  openS3Dialog: () => void;
  handleOpenHistory: () => Promise<void>;
  handleSync: (provider: CloudProvider) => Promise<void>;
  onApplyPayload: (payload: SyncPayload) => void | Promise<void>;
  onApplyLocalPayload?: (payload: SyncPayload) => void | Promise<void>;
  setShowClearLocalDialog: Dispatch<SetStateAction<boolean>>;
}

export const CloudSyncDashboardTabs: React.FC<CloudSyncDashboardTabsProps> = ({
  activeTab,
  setActiveTab,
  t,
  sync,
  resolvedLocale,
  localBackupsRef,
  isConnectDisabled,
  handleConnectGitHub,
  handleConnectGoogle,
  handleConnectOneDrive,
  openWebdavDialog,
  openS3Dialog,
  handleOpenHistory,
  handleSync,
  onApplyPayload,
  onApplyLocalPayload,
  setShowClearLocalDialog
}) => (
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'providers' | 'status')} className="space-y-4">
                <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="providers">{t('cloudSync.providers.title')}</TabsTrigger>
                    <TabsTrigger value="status">{t('cloudSync.status.title')}</TabsTrigger>
                </TabsList>

                <TabsContent value="providers" className="space-y-3">
                    <ProviderCard
                        provider="github"
                        name="GitHub Gist"
                        icon={<Github size={24} />}
                        isConnected={isProviderReadyForSync(sync.providers.github)}
                        isSyncing={sync.providers.github.status === 'syncing'}
                        isConnecting={sync.providers.github.status === 'connecting'}
                        account={sync.providers.github.account}
                        lastSync={sync.providers.github.lastSync}
                        error={sync.providers.github.error}
                        disabled={isConnectDisabled('github')}
                        onConnect={handleConnectGitHub}
                        onDisconnect={() => sync.disconnectProvider('github')}
                        onSync={() => handleSync('github')}
                        extraActions={
                            isProviderReadyForSync(sync.providers.github) ? (
                                <Button size="sm" variant="ghost" onClick={handleOpenHistory} className="gap-1">
                                    <History size={14} />
                                    {t('cloudSync.revisionHistory.viewButton')}
                                </Button>
                            ) : undefined
                        }
                    />

                    <ProviderCard
                        provider="google"
                        name="Google Drive"
                        icon={<GoogleDriveIcon className="w-6 h-6" />}
                        isConnected={isProviderReadyForSync(sync.providers.google)}
                        isSyncing={sync.providers.google.status === 'syncing'}
                        isConnecting={
                            sync.providers.google.status === 'connecting' ||
                            sync.pendingBrowserAuthProvider === 'google'
                        }
                        account={sync.providers.google.account}
                        lastSync={sync.providers.google.lastSync}
                        error={sync.providers.google.error}
                        disabled={isConnectDisabled('google')}
                        onConnect={handleConnectGoogle}
                        onCancelConnect={sync.cancelOAuthConnect}
                        onDisconnect={() => sync.disconnectProvider('google')}
                        onSync={() => handleSync('google')}
                    />

                    <ProviderCard
                        provider="onedrive"
                        name="Microsoft OneDrive"
                        icon={<OneDriveIcon className="w-6 h-6" />}
                        isConnected={isProviderReadyForSync(sync.providers.onedrive)}
                        isSyncing={sync.providers.onedrive.status === 'syncing'}
                        isConnecting={
                            sync.providers.onedrive.status === 'connecting' ||
                            sync.pendingBrowserAuthProvider === 'onedrive'
                        }
                        account={sync.providers.onedrive.account}
                        lastSync={sync.providers.onedrive.lastSync}
                        error={sync.providers.onedrive.error}
                        disabled={isConnectDisabled('onedrive')}
                        onConnect={handleConnectOneDrive}
                        onCancelConnect={sync.cancelOAuthConnect}
                        onDisconnect={() => sync.disconnectProvider('onedrive')}
                        onSync={() => handleSync('onedrive')}
                    />

                    <ProviderCard
                        provider="webdav"
                        name={t('cloudSync.provider.webdav')}
                        icon={<Server size={24} />}
                        isConnected={isProviderReadyForSync(sync.providers.webdav)}
                        isSyncing={sync.providers.webdav.status === 'syncing'}
                        isConnecting={sync.providers.webdav.status === 'connecting'}
                        account={sync.providers.webdav.account}
                        lastSync={sync.providers.webdav.lastSync}
                        error={sync.providers.webdav.error}
                        disabled={isConnectDisabled('webdav')}
                        onEdit={openWebdavDialog}
                        onConnect={openWebdavDialog}
                        onDisconnect={() => sync.disconnectProvider('webdav')}
                        onSync={() => handleSync('webdav')}
                    />

                    <ProviderCard
                        provider="s3"
                        name={t('cloudSync.provider.s3')}
                        icon={<Database size={24} />}
                        isConnected={isProviderReadyForSync(sync.providers.s3)}
                        isSyncing={sync.providers.s3.status === 'syncing'}
                        isConnecting={sync.providers.s3.status === 'connecting'}
                        account={sync.providers.s3.account}
                        lastSync={sync.providers.s3.lastSync}
                        error={sync.providers.s3.error}
                        disabled={isConnectDisabled('s3')}
                        onEdit={openS3Dialog}
                        onConnect={openS3Dialog}
                        onDisconnect={() => sync.disconnectProvider('s3')}
                        onSync={() => handleSync('s3')}
                    />
                </TabsContent>

                <TabsContent value="status" className="space-y-4">
                    <div className="p-4 rounded-lg border bg-card">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-medium">{t('cloudSync.autoSync.title')}</div>
                                <div className="text-xs text-muted-foreground">
                                    {t('cloudSync.autoSync.desc')}
                                </div>
                            </div>
                            <Toggle
                                checked={sync.autoSyncEnabled}
                                onChange={(enabled) => sync.setAutoSync(enabled)}
                                disabled={!sync.hasAnyConnectedProvider}
                            />
                        </div>
                    </div>

                    {sync.hasAnyConnectedProvider && (
                        <div className="space-y-3">
                            {/* Version Info Cards */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 rounded-lg border bg-card">
                                    <div className="text-xs text-muted-foreground mb-1">{t('cloudSync.status.localVersion')}</div>
                                    <div className="text-lg font-semibold">v{sync.localVersion}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {sync.localUpdatedAt
                                            ? new Date(sync.localUpdatedAt).toLocaleString(resolvedLocale || undefined)
                                            : t('cloudSync.lastSync.never')}
                                    </div>
                                </div>
                                <div className="p-3 rounded-lg border bg-card">
                                    <div className="text-xs text-muted-foreground mb-1">{t('cloudSync.status.remoteVersion')}</div>
                                    <div className="text-lg font-semibold">v{sync.remoteVersion}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {sync.remoteUpdatedAt
                                            ? new Date(sync.remoteUpdatedAt).toLocaleString(resolvedLocale || undefined)
                                            : t('cloudSync.lastSync.never')}
                                    </div>
                                </div>
                            </div>

                            {/* Sync History */}
                            {sync.syncHistory.length > 0 && (
                                <div className="rounded-lg border bg-card">
                                    <div className="px-3 py-2 border-b border-border/60">
                                        <div className="text-sm font-medium">{t('cloudSync.history.title')}</div>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto">
                                        {sync.syncHistory.slice(0, 10).map((entry) => (
                                            <div key={entry.id} className="px-3 py-2 flex items-center gap-2 border-b border-border/30 last:border-b-0">
                                                <div className={cn(
                                                    "w-2 h-2 rounded-full shrink-0",
                                                    entry.success ? "bg-green-500" : "bg-red-500"
                                                )} />
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs font-medium capitalize">
                                                            {entry.action === 'upload'
                                                                ? t('cloudSync.history.upload')
                                                                : entry.action === 'download'
                                                                    ? t('cloudSync.history.download')
                                                                    : t('cloudSync.history.resolved')}
                                                        </span>
                                                        <span className="text-xs text-muted-foreground">
                                                            v{entry.localVersion}
                                                        </span>
                                                    </div>
                                                    <div className="text-[10px] text-muted-foreground truncate">
                                                        {new Date(entry.timestamp).toLocaleString(resolvedLocale || undefined)}
                                                        {entry.deviceName && ` · ${entry.deviceName}`}
                                                    </div>
                                                </div>
                                                {entry.error && (
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <span className="text-xs text-red-500 truncate max-w-24 cursor-default">
                                                                {t('cloudSync.history.error')}
                                                            </span>
                                                        </TooltipTrigger>
                                                        <TooltipContent>{entry.error}</TooltipContent>
                                                    </Tooltip>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <div ref={localBackupsRef}>
                        <LocalBackupsPanel
                            onApplyPayload={onApplyLocalPayload ?? onApplyPayload}
                        />
                    </div>

                    {/* Clear Local Data */}
                    <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/5">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-medium">{t('cloudSync.clearLocal.title')}</div>
                                <div className="text-xs text-muted-foreground">
                                    {t('cloudSync.clearLocal.desc')}
                                </div>
                            </div>
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => setShowClearLocalDialog(true)}
                            >
                                <Trash2 size={14} className="mr-1" />
                                {t('cloudSync.clearLocal.button')}
                            </Button>
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
);
