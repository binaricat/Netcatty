import React, { useState } from 'react';
import {
  ChevronDown,
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
  const [isOpacityExpanded, setIsOpacityExpanded] = useState(false);
  const opacityPercent = Math.round(windowOpacity * 100);
  const isPresetActive = (value: number) => Math.round(value * 100) === opacityPercent;
  const isDark = theme === 'dark';
  const externalMcpLabelId = React.useId();

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setIsOpacityExpanded(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn', className)}
              style={{
                ...style,
                color: style?.color ?? 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
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
      >
        <div className="px-3 py-2 border-b border-border/60">
          <div className="text-sm font-medium">{t('topTabs.controlPanel')}</div>
        </div>

        <div className="p-2">
          <div>
            <div className="rounded-md">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/40"
                aria-expanded={isOpacityExpanded}
                onClick={() => setIsOpacityExpanded((current) => !current)}
              >
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <Droplets size={14} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{t('topTabs.windowOpacity')}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-xs tabular-nums text-muted-foreground">{opacityPercent}%</span>
                  <ChevronDown
                    size={14}
                    className={cn(
                      'text-muted-foreground transition-transform',
                      isOpacityExpanded && 'rotate-180',
                    )}
                  />
                </div>
              </button>

              {isOpacityExpanded ? (
                <div className="space-y-2 px-2 pb-2">
                  <div className="flex items-center gap-2">
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
                  <div className="flex items-center gap-1" role="group" aria-label={t('topTabs.windowOpacity')}>
                    {OPACITY_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setWindowOpacity(preset.value)}
                        aria-pressed={isPresetActive(preset.value)}
                        className={cn(
                          'h-6 flex-1 rounded-md text-[11px] font-medium transition-colors',
                          isPresetActive(preset.value)
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
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

          {showExternalMcpToggle ? (
            <div className="mt-1 border-t border-border/60 pt-1">
              <div className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/40">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <Plug size={14} className="shrink-0 text-muted-foreground" />
                  <span id={externalMcpLabelId} className="truncate">{t('topTabs.controlPanel.externalMcp')}</span>
                </div>
                <Switch
                  checked={externalMcpEnabled}
                  onCheckedChange={onToggleExternalMcp}
                  aria-labelledby={externalMcpLabelId}
                />
              </div>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default TopTabsQuickControls;
