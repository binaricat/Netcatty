import React, { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Database, Github, History, Plug, Server, Trash2 } from 'lucide-react';
import type {
  CloudProvider,
  ConvergentFieldConflict,
  ConvergentMigrationPreview,
  SyncPayload,
} from '../../domain/sync';
import { isBuiltinCloudProvider } from '../../domain/sync';
import { isPluginCloudProviderId } from '../../domain/cloudProviderIds';
import { planPluginSyncConnect, hasPluginProviderStoredConfig } from '../../domain/pluginSyncConnect';
import { planPluginSyncCredential, syncConfigurationSchemaWithoutSecretRequirements } from '../../domain/pluginSyncCredential';
import { pluginConfigurationMatchesSchema } from '../../domain/pluginConfigurationSchema';
import type { useCloudSync } from '../../application/state/useCloudSync';
import { storePluginSyncSecretsThenConnect } from '../../application/pluginSyncConnectWithSecrets';
import { cleanOneDriveErrorMessage, isProviderReadyForSync } from '../../domain/sync';
import { pluginExtensionBridge } from '../../application/state/pluginExtensionBridge';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { toast } from '../ui/toast';
import { GoogleDriveIcon, OneDriveIcon, ProviderCard, Toggle } from './CloudSyncControls';
import { LocalBackupsPanel } from './CloudSyncLocalBackupsPanel';
import { ConvergentSyncPanel } from './ConvergentSyncPanel';
import { SettingsAnchor } from '../settings/settings-ui';

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
  convergentConfig: { enabled: boolean; initialized: boolean };
  convergentPreview: ConvergentMigrationPreview | null;
  convergentBusy: boolean;
  convergentError: string | null;
  convergentConflicts: ConvergentFieldConflict[];
  onToggleConvergent: (enabled: boolean) => void | Promise<void>;
  onConfirmConvergentMigration: () => void | Promise<void>;
  onCancelConvergentMigration: () => void;
  onResolveConvergentConflict: (addressKey: string, candidateDot: string) => void | Promise<void>;
  onDowngradeConvergent: () => void | Promise<void>;
  /** Disconnect other legacy providers before connecting a plugin backend. */
  disconnectOtherProviders?: (current: CloudProvider) => Promise<void>;
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
  setShowClearLocalDialog,
  convergentConfig,
  convergentPreview,
  convergentBusy,
  convergentError,
  convergentConflicts,
  onToggleConvergent,
  onConfirmConvergentMigration,
  onCancelConvergentMigration,
  onResolveConvergentConflict,
  onDowngradeConvergent,
  disconnectOtherProviders,
}) => {
  const [pluginSyncProviders, setPluginSyncProviders] = useState<Array<{
    id: string;
    title: string;
    configurationSchema?: unknown;
  }>>([]);
  const [pluginConnectBusy, setPluginConnectBusy] = useState<string | null>(null);
  const [pluginConfigDialog, setPluginConfigDialog] = useState<{
    providerId: string;
    title: string;
    configurationSchema?: unknown;
  } | null>(null);
  const [pluginConfigText, setPluginConfigText] = useState('{}');
  const [pluginConfigError, setPluginConfigError] = useState<string | null>(null);
  const [pluginConfigSaving, setPluginConfigSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const listed = await pluginExtensionBridge.listProviders('sync');
        if (cancelled) return;
        setPluginSyncProviders(
          (listed ?? []).map((entry) => {
            const nested = (entry as {
              provider?: {
                id?: string;
                label?: string;
                configurationSchema?: unknown;
              };
              pluginDisplayName?: string;
            }).provider;
            const id = String(nested?.id ?? '');
            return {
              id,
              title: String(
                nested?.label
                ?? (entry as { pluginDisplayName?: string }).pluginDisplayName
                ?? id
                ?? 'Plugin sync',
              ),
              configurationSchema: nested?.configurationSchema,
            };
          }).filter((entry) => entry.id.length > 0 && isPluginCloudProviderId(entry.id)),
        );
      } catch {
        if (!cancelled) setPluginSyncProviders([]);
      }
    };
    void refresh();
    const unsubscribe = pluginExtensionBridge.onContributionsChanged(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const openPluginConfigDialog = (
    providerId: string,
    title: string,
    configurationSchema: unknown | undefined,
  ) => {
    const connection = sync.providers[providerId];
    // Include falsy scalars and JSON null so Edit can re-save them.
    const seed = hasPluginProviderStoredConfig(connection) ? connection!.config : {};
    setPluginConfigText(JSON.stringify(seed, null, 2));
    setPluginConfigError(null);
    setPluginConfigDialog({ providerId, title, configurationSchema });
  };

  const runPluginConnect = async (providerId: string, configuration: unknown): Promise<boolean> => {
    setPluginConnectBusy(providerId);
    try {
      if (disconnectOtherProviders) {
        await disconnectOtherProviders(providerId as CloudProvider);
      }
      const credentialPlan = planPluginSyncCredential(configuration, {
        configurationSchema: pluginSyncProviders.find((entry) => entry.id === providerId)
          ?.configurationSchema,
      });
      const stored = sync.providers[providerId]?.credential;
      const existingCredential =
        stored
        && typeof stored === 'object'
        && stored.kind === 'secret'
        && typeof stored.id === 'string'
          ? stored as { kind: 'secret'; id: string; key: string }
          : undefined;
      if (credentialPlan.secrets.length > 0) {
        const { putPluginSyncSecret, deletePluginSyncSecrets, restorePluginSyncSecrets } = await import(
          '../../infrastructure/services/adapters/pluginSyncIpcHost'
        );
        // Put secrets before connect; roll back just-created keys if connect fails
        // so a rejected password/token is not left readable in plugin_secrets.
        // Overwrites restore the previous plaintext from the host stash.
        await storePluginSyncSecretsThenConnect({
          providerId,
          secrets: credentialPlan.secrets.map((secret) => ({
            secretKey: secret.secretKey,
            value: secret.value,
          })),
          putSecret: putPluginSyncSecret,
          deleteSecrets: deletePluginSyncSecrets,
          restoreSecrets: restorePluginSyncSecrets,
          connect: async (credential) => {
            await sync.connectPluginProvider(
              providerId,
              credentialPlan.configuration,
              credential,
            );
          },
        });
      } else {
        await sync.connectPluginProvider(
          providerId,
          credentialPlan.configuration,
          existingCredential,
        );
      }
      toast.success(t('cloudSync.connect.plugin.success'));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message, t('cloudSync.connect.plugin.failedTitle'));
      return false;
    } finally {
      setPluginConnectBusy(null);
    }
  };

  const handlePluginConnect = async (providerId: string) => {
    const listed = pluginSyncProviders.find((entry) => entry.id === providerId);
    const connection = sync.providers[providerId];
    // Config may be a valid falsy scalar or JSON null — property presence, not truthiness.
    const hasStoredConfig = hasPluginProviderStoredConfig(connection);
    const plan = planPluginSyncConnect({
      configurationSchema: listed?.configurationSchema,
      storedConfig: connection?.config,
      hasStoredConfig,
    });
    if (plan.action === 'prompt') {
      openPluginConfigDialog(
        providerId,
        listed?.title ?? providerId,
        listed?.configurationSchema,
      );
      return;
    }
    await runPluginConnect(providerId, plan.configuration);
  };

  const handleSavePluginConfig = async () => {
    if (!pluginConfigDialog) return;
    let configuration: unknown;
    try {
      configuration = JSON.parse(pluginConfigText) as unknown;
    } catch {
      setPluginConfigError(t('cloudSync.pluginConfig.invalidJson'));
      return;
    }
    if (pluginConfigDialog.configurationSchema !== undefined) {
      const connection = sync.providers[pluginConfigDialog.providerId];
      const hasStoredSecret = connection?.credential != null
        && typeof connection.credential === 'object'
        && (connection.credential as { kind?: string }).kind === 'secret';
      // Edit seeds stripped config; required secret fields stay satisfied by the
      // durable SecretRef until the user re-enters plaintext secrets.
      const schema = hasStoredSecret
        ? syncConfigurationSchemaWithoutSecretRequirements(pluginConfigDialog.configurationSchema)
        : pluginConfigDialog.configurationSchema;
      if (!pluginConfigurationMatchesSchema(schema, configuration)) {
        setPluginConfigError(t('cloudSync.pluginConfig.schemaInvalid'));
        return;
      }
    }
    setPluginConfigError(null);
    setPluginConfigSaving(true);
    try {
      const ok = await runPluginConnect(pluginConfigDialog.providerId, configuration);
      if (ok) setPluginConfigDialog(null);
      // On failure toast already shown; keep dialog open for correction.
    } finally {
      setPluginConfigSaving(false);
    }
  };

  const pluginProviderIds = new Set<string>([
    ...pluginSyncProviders.map((entry) => entry.id),
    ...Object.keys(sync.providers).filter((id) => !isBuiltinCloudProvider(id)),
  ]);

  return (
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'providers' | 'status')} className="space-y-4">
                <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="providers">{t('cloudSync.providers.title')}</TabsTrigger>
                    <TabsTrigger value="status">{t('cloudSync.status.title')}</TabsTrigger>
                </TabsList>

                <TabsContent value="providers" className="space-y-3">
                    <SettingsAnchor anchorId="sync-providers" className="space-y-3">
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
                        error={
                            sync.providers.onedrive.error
                                ? cleanOneDriveErrorMessage(sync.providers.onedrive.error)
                                : undefined
                        }
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

                    {[...pluginProviderIds].sort().map((providerId) => {
                        const connection = sync.providers[providerId];
                        const listed = pluginSyncProviders.find((entry) => entry.id === providerId);
                        const title = listed?.title ?? providerId;
                        const connected = connection ? isProviderReadyForSync(connection) : false;
                        const hasStoredConfig = hasPluginProviderStoredConfig(connection);
                        const needsConfig = planPluginSyncConnect({
                          configurationSchema: listed?.configurationSchema,
                          storedConfig: connection?.config,
                          hasStoredConfig,
                        }).action === 'prompt';
                        return (
                            <ProviderCard
                                key={providerId}
                                provider={providerId as CloudProvider}
                                name={title}
                                icon={<Plug size={24} />}
                                isConnected={connected}
                                isSyncing={connection?.status === 'syncing'}
                                isConnecting={
                                    connection?.status === 'connecting'
                                    || pluginConnectBusy === providerId
                                }
                                account={connection?.account
                                  ? {
                                      // Never load plugin-supplied avatar URLs in the main
                                      // renderer (offline plugin network boundary).
                                      id: connection.account.id,
                                      name: connection.account.name,
                                      email: connection.account.email,
                                    }
                                  : undefined}
                                lastSync={connection?.lastSync}
                                error={connection?.error}
                                disabled={isConnectDisabled(providerId as CloudProvider)}
                                onEdit={
                                  connected || needsConfig || hasStoredConfig
                                    ? () => openPluginConfigDialog(
                                      providerId,
                                      title,
                                      listed?.configurationSchema,
                                    )
                                    : undefined
                                }
                                onConnect={() => {
                                  void handlePluginConnect(providerId);
                                }}
                                onDisconnect={() => sync.disconnectProvider(providerId as CloudProvider)}
                                onSync={() => handleSync(providerId as CloudProvider)}
                            />
                        );
                    })}

                    <Dialog
                      open={pluginConfigDialog != null}
                      onOpenChange={(open) => {
                        if (!open && !pluginConfigSaving) setPluginConfigDialog(null);
                      }}
                    >
                      <DialogContent className="sm:max-w-[480px]">
                        <DialogHeader>
                          <DialogTitle>
                            {t('cloudSync.pluginConfig.title', {
                              name: pluginConfigDialog?.title ?? '',
                            })}
                          </DialogTitle>
                          <DialogDescription>
                            {t('cloudSync.pluginConfig.desc')}
                          </DialogDescription>
                        </DialogHeader>
                        <textarea
                          value={pluginConfigText}
                          onChange={(event) => {
                            setPluginConfigText(event.target.value);
                            if (pluginConfigError) setPluginConfigError(null);
                          }}
                          spellCheck={false}
                          disabled={pluginConfigSaving}
                          className="min-h-40 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={t('cloudSync.pluginConfig.label')}
                        />
                        {pluginConfigError ? (
                          <p role="alert" className="text-xs text-destructive">{pluginConfigError}</p>
                        ) : null}
                        <DialogFooter>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={pluginConfigSaving}
                            onClick={() => setPluginConfigDialog(null)}
                          >
                            {t('common.cancel')}
                          </Button>
                          <Button
                            type="button"
                            disabled={pluginConfigSaving}
                            onClick={() => { void handleSavePluginConfig(); }}
                          >
                            {pluginConfigSaving
                              ? t('cloudSync.provider.connecting')
                              : t('cloudSync.provider.connect')}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    </SettingsAnchor>
                </TabsContent>

                <TabsContent value="status" className="space-y-4">
                    <ConvergentSyncPanel
                        t={t}
                        resolvedLocale={resolvedLocale}
                        config={convergentConfig}
                        preview={convergentPreview}
                        busy={convergentBusy}
                        error={convergentError}
                        conflicts={convergentConflicts}
                        onToggle={onToggleConvergent}
                        onConfirmMigration={onConfirmConvergentMigration}
                        onCancelMigration={onCancelConvergentMigration}
                        onResolveConflict={onResolveConvergentConflict}
                        onDowngrade={onDowngradeConvergent}
                    />

                    <SettingsAnchor anchorId="sync-auto-sync" className="p-4 rounded-lg border bg-card">
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
                    </SettingsAnchor>

                    <SettingsAnchor anchorId="sync-strategy" className="p-4 rounded-lg border bg-card space-y-3">
                        <div>
                            <div className="text-sm font-medium">{t('cloudSync.strategy.title')}</div>
                            <div className="text-xs text-muted-foreground">
                                {t('cloudSync.strategy.desc')}
                            </div>
                        </div>
                        <Select
                            value={sync.syncStrategy}
                            onValueChange={(value) => sync.setSyncStrategy(value as typeof sync.syncStrategy)}
                        >
                            <SelectTrigger
                                aria-label={t('cloudSync.strategy.title')}
                                className="h-10"
                            >
                                {sync.syncStrategy === 'preferCloud'
                                    ? t('cloudSync.strategy.preferCloud')
                                    : sync.syncStrategy === 'preferLocal'
                                        ? t('cloudSync.strategy.preferLocal')
                                        : t('cloudSync.strategy.smartMerge')}
                            </SelectTrigger>
                            <SelectContent className="max-w-[min(520px,var(--radix-select-trigger-width))]">
                                <SelectItem value="smartMerge" className="items-start py-2">
                                    <div className="space-y-0.5">
                                        <div>{t('cloudSync.strategy.smartMerge')}</div>
                                        <div className="text-xs text-muted-foreground leading-snug">
                                            {t('cloudSync.strategy.smartMergeDesc')}
                                        </div>
                                    </div>
                                </SelectItem>
                                <SelectItem value="preferCloud" className="items-start py-2">
                                    <div className="space-y-0.5">
                                        <div>{t('cloudSync.strategy.preferCloud')}</div>
                                        <div className="text-xs text-muted-foreground leading-snug">
                                            {t('cloudSync.strategy.preferCloudDesc')}
                                        </div>
                                    </div>
                                </SelectItem>
                                <SelectItem value="preferLocal" className="items-start py-2">
                                    <div className="space-y-0.5">
                                        <div>{t('cloudSync.strategy.preferLocal')}</div>
                                        <div className="text-xs text-muted-foreground leading-snug">
                                            {t('cloudSync.strategy.preferLocalDesc')}
                                        </div>
                                    </div>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingsAnchor>

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

                    <SettingsAnchor anchorId="sync-local-backups">
                    <div ref={localBackupsRef}>
                        <LocalBackupsPanel
                            onApplyPayload={onApplyLocalPayload ?? onApplyPayload}
                        />
                    </div>
                    </SettingsAnchor>

                    {/* Clear Local Data */}
                    <SettingsAnchor anchorId="sync-clear-local" className="p-4 rounded-lg border border-destructive/30 bg-destructive/5">
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
                    </SettingsAnchor>
                </TabsContent>
            </Tabs>
  );
};
