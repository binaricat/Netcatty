import React from 'react';
import {
  formatPluginViewBadgeLabel,
  isPluginViewBadgeVisible,
  type PluginViewBadgeDisplay,
  type PluginViewBadgeTone,
} from '../../domain/pluginViewBadge';
import { cn } from '../../lib/utils';

const TONE_CLASSES: Record<PluginViewBadgeTone, string> = {
  default: 'bg-primary text-primary-foreground',
  info: 'bg-sky-600 text-white dark:bg-sky-500 dark:text-white',
  warning: 'bg-amber-500 text-zinc-950',
  danger: 'bg-red-500 text-white dark:bg-red-500 dark:text-white',
};

export interface PluginViewBadgeProps {
  badge: PluginViewBadgeDisplay | null | undefined;
  /**
   * - `inline`: expanded left sidebar row pill/dot aligned right
   * - `overlay`: collapsed left sidebar icon rail corner badge
   * - `compact-overlay`: compact 24px terminal sidebar launcher corner badge
   */
  variant: 'inline' | 'overlay' | 'compact-overlay';
  className?: string;
}

export const PluginViewBadge: React.FC<PluginViewBadgeProps> = ({
  badge,
  variant,
  className,
}) => {
  if (!isPluginViewBadgeVisible(badge)) return null;
  const label = formatPluginViewBadgeLabel(badge);
  const toneClass = TONE_CLASSES[badge.tone] ?? TONE_CLASSES.default;

  if (label === null) {
    return (
      <span
        aria-hidden="true"
        data-plugin-view-badge="dot"
        data-plugin-view-badge-tone={badge.tone}
        className={cn(
          'pointer-events-none shrink-0 rounded-full',
          toneClass,
          variant === 'inline' && 'ml-auto h-2 w-2',
          variant === 'overlay' && 'absolute -top-0.5 -right-0.5 h-2 w-2 ring-2 ring-secondary',
          variant === 'compact-overlay' && 'absolute -top-0.5 -right-0.5 h-1.5 w-1.5 ring-1 ring-background',
          className,
        )}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-plugin-view-badge={label}
      data-plugin-view-badge-tone={badge.tone}
      className={cn(
        'pointer-events-none shrink-0 inline-flex items-center justify-center rounded-full font-semibold leading-none tabular-nums select-none',
        toneClass,
        variant === 'inline' && 'ml-auto min-w-[18px] h-[18px] px-1.5 text-[10px]',
        variant === 'overlay' && 'absolute -top-1.5 -right-2 min-w-[15px] h-[15px] px-1 text-[9px] font-bold ring-2 ring-secondary',
        variant === 'compact-overlay' && 'absolute -top-1 -right-1 min-w-[13px] h-[13px] px-0.5 text-[8px] font-bold ring-1 ring-background',
        className,
      )}
    >
      {label}
    </span>
  );
};
