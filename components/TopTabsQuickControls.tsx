import React, { useState } from 'react';
import {
  Droplets,
  Moon,
  Plug,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useI18n } from '../application/i18n/I18nProvider';
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

export interface TopTabsQuickControlsProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  externalMcpEnabled: boolean;
  onToggleExternalMcp: (enabled: boolean) => void;
  showExternalMcpToggle?: boolean;
  windowOpacity: number;
  setWindowOpacity: (opacity: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

export const TopTabsQuickControls: React.FC<TopTabsQuickControlsProps> = ({
  theme,
  onToggleTheme,
  externalMcpEnabled,
  onToggleExternalMcp,
  showExternalMcpToggle = true,
  windowOpacity,
  setWindowOpacity,
  className,
  style,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const opacityPercent = Math.round(windowOpacity * 100);
  const isDark = theme === 'dark';
  const triggerActive = (
    (showExternalMcpToggle && externalMcpEnabled)
    || opacityPercent < 100
  );

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn', className)}
              style={{
                ...style,
                color: triggerActive
                  ? 'hsl(var(--primary))'
                  : (style?.color ?? 'var(--top-tabs-muted, hsl(var(--muted-foreground)))'),
              }}
              aria-label={t('topTabs.controlPanel')}
              data-section="top-tabs-quick-controls"
            >
              <SlidersHorizontal size={16} />
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
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default TopTabsQuickControls;
