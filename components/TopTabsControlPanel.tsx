import React, { useMemo, useState } from 'react';
import {
  Cloud,
  CloudOff,
  Droplets,
  Loader2,
  Moon,
  Plug,
  Settings,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useCloudSync } from '../application/state/useCloudSync';
import { isProviderReadyForSync, type CloudProvider } from '../domain/sync';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Switch } from './ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const OPACITY_PRESETS = [
  { label: '100%', value: 1 },
  { label: '85%', value: 0.85 },
  { label: '70%', value: 0.7 },
] as const;

export interface TopTabsControlPanelProps {
  theme: string;
  onToggleTheme: () => void;
  externalMcpEnabled: boolean;
  onToggleExternalMcp: (enabled: boolean) => void;
  showExternalMcpToggle?: boolean;
  windowOpacity: number;
  setWindowOpacity: (opacity: number) => void;
  onOpenSettings?: () => void;
  onSyncNow?: () => Promise<void>;
  className?: string;
  style?: React.CSSProperties;
}

function useSyncSummary() {
  const { t } = useI18n();
  const sync = useCloudSync();

  return useMemo(() => {
    const getConnectedProvider = (): CloudProvider | null => {
      if (isProviderReadyForSync(sync.providers.github)) return 'github';
      if (isProviderReadyForSync(sync.providers.google)) return 'google';
      if (isProviderReadyForSync(sync.providers.onedrive)) return 'onedrive';
      if (isProviderReadyForSync(sync.providers.webdav)) return 'webdav';
      if (isProviderReadyForSync(sync.providers.s3)) return 's3';
      return null;
    };

    const connectedProvider = getConnectedProvider();
    const hasVersionMismatch = sync.hasAnyConnectedProvider
      && sync.localVersion !== sync.remoteVersion;
    const hasPendingSync = sync.pendingLocalSync || hasVersionMismatch;

    let statusLabel = t('sync.notConfigured');
    if (sync.overallSyncStatus === 'syncing' || sync.isSyncing) {
      statusLabel = t('sync.syncing');
    } else if (
      sync.overallSyncStatus === 'error'
      || sync.overallSyncStatus === 'conflict'
      || sync.overallSyncStatus === 'blocked'
    ) {
      statusLabel = t('sync.error');
    } else if (hasPendingSync) {
      statusLabel = t('sync.pending');
    } else if (sync.hasAnyConnectedProvider) {
      statusLabel = t('sync.active');
    }

    const hasAttention = (
      sync.overallSyncStatus === 'error'
      || sync.overallSyncStatus === 'conflict'
      || sync.overallSyncStatus === 'blocked'
      || hasPendingSync
    );

    return {
      connectedProvider,
      hasAnyConnectedProvider: sync.hasAnyConnectedProvider,
      hasAttention,
      isSyncing: sync.isSyncing || sync.overallSyncStatus === 'syncing',
      statusLabel,
    };
  }, [sync, t]);
}

export const TopTabsControlPanel: React.FC<TopTabsControlPanelProps> = ({
  theme,
  onToggleTheme,
  externalMcpEnabled,
  onToggleExternalMcp,
  showExternalMcpToggle = true,
  windowOpacity,
  setWindowOpacity,
  onOpenSettings,
  onSyncNow,
  className,
  style,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isSyncingManual, setIsSyncingManual] = useState(false);
  const syncSummary = useSyncSummary();
  const opacityPercent = Math.round(windowOpacity * 100);
  const isDark = theme === 'dark';

  const triggerActive = (
    (showExternalMcpToggle && externalMcpEnabled)
    || opacityPercent < 100
    || syncSummary.hasAttention
  );

  const handleSyncNow = async () => {
    if (!onSyncNow || isSyncingManual || syncSummary.isSyncing) return;
    setIsSyncingManual(true);
    try {
      await onSyncNow();
    } finally {
      setIsSyncingManual(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7 shrink-0 app-no-drag relative top-tab-utility-btn', className)}
              style={{
                ...style,
                color: triggerActive
                  ? 'hsl(var(--primary))'
                  : (style?.color ?? 'var(--top-tabs-muted, hsl(var(--muted-foreground)))'),
              }}
              aria-label={t('topTabs.controlPanel')}
              data-section="top-tabs-control-panel"
            >
              <SlidersHorizontal size={16} />
              {syncSummary.hasAttention ? (
                <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-amber-500 ring-2 ring-background" />
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('topTabs.controlPanel')}</TooltipContent>
      </Tooltip>

      <PopoverContent
        className="w-72 p-0 app-no-drag"
        align="end"
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-3 py-2.5 border-b border-border/60">
          <div className="text-sm font-medium">{t('topTabs.controlPanel')}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t('topTabs.controlPanel.description')}
          </div>
        </div>

        <div className="p-3 space-y-3">
          {showExternalMcpToggle ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/70 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Plug size={14} className="shrink-0" />
                  <span className="truncate">{t('topTabs.controlPanel.externalMcp')}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t(externalMcpEnabled ? 'topTabs.externalMcp.disable' : 'topTabs.externalMcp.enable')}
                </div>
              </div>
              <Switch
                checked={externalMcpEnabled}
                onCheckedChange={onToggleExternalMcp}
                aria-label={t(externalMcpEnabled ? 'topTabs.externalMcp.disable' : 'topTabs.externalMcp.enable')}
              />
            </div>
          ) : null}

          <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Droplets size={14} className="shrink-0" />
                <span>{t('topTabs.windowOpacity')}</span>
              </div>
              <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">
                {opacityPercent}%
              </span>
            </div>
            <input
              type="range"
              min={50}
              max={100}
              step={1}
              value={opacityPercent}
              onChange={(event) => setWindowOpacity(Number(event.target.value) / 100)}
              className="w-full accent-primary"
              aria-label={t('topTabs.windowOpacity')}
            />
            <div className="flex items-center gap-1.5">
              {OPACITY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setWindowOpacity(preset.value)}
                  className={cn(
                    'flex-1 px-2 py-1 rounded-md text-xs font-medium transition-colors border',
                    windowOpacity === preset.value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted/50 text-muted-foreground border-border hover:text-foreground',
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/70 px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {isDark ? <Sun size={14} className="shrink-0" /> : <Moon size={14} className="shrink-0" />}
                <span className="truncate">{t('topTabs.controlPanel.theme')}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {isDark ? t('topTabs.controlPanel.theme.dark') : t('topTabs.controlPanel.theme.light')}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={onToggleTheme}
            >
              {t('topTabs.toggleTheme')}
            </Button>
          </div>

          <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium min-w-0">
                {syncSummary.isSyncing ? (
                  <Loader2 size={14} className="shrink-0 animate-spin" />
                ) : syncSummary.hasAnyConnectedProvider ? (
                  <Cloud size={14} className="shrink-0" />
                ) : (
                  <CloudOff size={14} className="shrink-0" />
                )}
                <span className="truncate">{t('sync.cloudSync')}</span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {syncSummary.statusLabel}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 flex-1"
                disabled={!onSyncNow || isSyncingManual || syncSummary.isSyncing || !syncSummary.hasAnyConnectedProvider}
                onClick={() => { void handleSyncNow(); }}
              >
                {isSyncingManual || syncSummary.isSyncing ? t('sync.syncing') : t('sync.syncNow')}
              </Button>
              {onOpenSettings ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label={t('sync.settings')}
                  onClick={() => {
                    setIsOpen(false);
                    onOpenSettings();
                  }}
                >
                  <Settings size={14} />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default TopTabsControlPanel;
