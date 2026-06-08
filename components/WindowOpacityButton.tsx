import React, { useState } from 'react';
import { Droplets } from 'lucide-react';
import { useI18n } from '../application/i18n/I18nProvider';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const OPACITY_PRESETS = [
  { label: '100%', value: 1 },
  { label: '85%', value: 0.85 },
  { label: '70%', value: 0.7 },
] as const;

interface WindowOpacityButtonProps {
  windowOpacity: number;
  setWindowOpacity: (opacity: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

export const WindowOpacityButton: React.FC<WindowOpacityButtonProps> = ({
  windowOpacity,
  setWindowOpacity,
  className,
  style,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const percent = Math.round(windowOpacity * 100);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7 shrink-0 app-no-drag', className)}
              style={style}
              aria-label={t('topTabs.windowOpacity')}
            >
              <Droplets
                size={16}
                className={percent < 100 ? 'opacity-80' : undefined}
              />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('topTabs.windowOpacity')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-60 p-3 app-no-drag"
        align="end"
        sideOffset={6}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="space-y-2">
          <div className="text-sm font-medium">{t('topTabs.windowOpacity')}</div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={percent}
              onChange={(e) => setWindowOpacity(Number(e.target.value) / 100)}
              className="flex-1 accent-primary"
            />
            <span className="text-xs text-muted-foreground w-9 text-right tabular-nums">
              {percent}%
            </span>
          </div>
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
      </PopoverContent>
    </Popover>
  );
};

export default WindowOpacityButton;
