import React, { memo } from 'react';
import { cn } from '../../lib/utils';

interface ResourceBarProps {
  label: string;
  value: number | null | undefined;
  className?: string;
  /** Slightly taller track for GPU cards. */
  size?: 'sm' | 'md';
}

function barTone(clamped: number): string {
  if (clamped > 85) return 'bg-destructive/80';
  if (clamped > 60) return 'bg-amber-500/80';
  return 'bg-primary/75';
}

export const ResourceBar = memo(function ResourceBar({
  label,
  value,
  className,
  size = 'sm',
}: ResourceBarProps) {
  const finite = typeof value === 'number' && Number.isFinite(value);
  const clamped = finite ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className={cn('flex items-center gap-2 min-w-0', className)}>
      {label ? (
        <span className="text-[10px] text-muted-foreground w-7 shrink-0">{label}</span>
      ) : null}
      <div
        className={cn(
          'flex-1 rounded-full bg-muted/50 overflow-hidden min-w-[48px]',
          size === 'md' ? 'h-1.5' : 'h-1',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none',
            finite ? barTone(clamped) : 'opacity-0',
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground w-10 text-right shrink-0">
        {finite ? `${value.toFixed(1)}%` : '--'}
      </span>
    </div>
  );
});
