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
        className="w-64 p-0 app-no-drag"
        align="end"
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-3 py-2 border-b border-border/60">
          <div className="text-sm font-medium">{t('topTabs.controlPanel')}</div>
        </div>

        <div className="p-2">
          {showExternalMcpToggle ? (
            <div className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/40">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <Plug size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{t('topTabs.controlPanel.externalMcp')}</span>
              </div>
              <Switch
                checked={externalMcpEnabled}
                onCheckedChange={onToggleExternalMcp}
                aria-label={t(externalMcpEnabled ? 'topTabs.externalMcp.disable' : 'topTabs.externalMcp.enable')}
              />
            </div>
          ) : null}

          <div className="rounded-md px-2 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <Droplets size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{t('topTabs.windowOpacity')}</span>
              </div>
              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                {opacityPercent}%
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
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
            </div>
            <div className="mt-2 flex items-center gap-1">
              {OPACITY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setWindowOpacity(preset.value)}
                  className={cn(
                    'h-6 flex-1 rounded-md text-[11px] font-medium transition-colors',
                    windowOpacity === preset.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/40">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {isDark
                ? <Sun size={14} className="shrink-0 text-muted-foreground" />
                : <Moon size={14} className="shrink-0 text-muted-foreground" />}
              <span className="truncate">{t('topTabs.controlPanel.theme')}</span>
            </div>
            <button
              type="button"
              onClick={onToggleTheme}
              className="h-6 shrink-0 rounded-md bg-muted/50 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {isDark ? t('topTabs.controlPanel.theme.light') : t('topTabs.controlPanel.theme.dark')}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default TopTabsQuickControls;
