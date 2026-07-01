import React from 'react';
import { DistroAvatar } from '../DistroAvatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { hostDisplayTitle } from '@/domain/hostDisplay.ts';
import { cn } from '@/lib/utils';
import type { Host } from '@/domain/models';

export interface SnippetTargetsSectionProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  targetHosts: Host[];
  onEditTargets: () => void;
  hint?: string;
  variant?: 'card' | 'embedded';
  targetsAllHosts?: boolean;
  onTargetsAllHostsChange?: (checked: boolean) => void;
}

const actionButtonClass = (embedded: boolean) => cn(
  'shrink-0 rounded-md transition-colors',
  embedded ? 'h-6 px-2 text-[11px]' : 'h-6 px-2 text-xs',
);

const TargetsBody: React.FC<{
  t: SnippetTargetsSectionProps['t'];
  targetHosts: Host[];
  onEditTargets: () => void;
  hint?: string;
  embedded?: boolean;
  targetsAllHosts?: boolean;
  onTargetsAllHostsChange?: (checked: boolean) => void;
}> = ({
  t,
  targetHosts,
  onEditTargets,
  hint,
  embedded = false,
  targetsAllHosts = false,
  onTargetsAllHostsChange,
}) => (
  <>
    <div className="flex items-center justify-between gap-3">
      <p className={cn(
        'font-semibold text-muted-foreground shrink-0',
        embedded ? 'text-[11px]' : 'text-xs',
      )}
      >
        {t('snippets.targets.title')}
      </p>

      <div className="flex items-center gap-1 min-w-0">
        {!targetsAllHosts ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn(actionButtonClass(embedded), 'text-primary')}
            onClick={onEditTargets}
          >
            {targetHosts.length > 0 ? t('action.edit') : t('snippets.targets.add')}
          </Button>
        ) : null}

        {onTargetsAllHostsChange ? (
          <button
            type="button"
            aria-pressed={targetsAllHosts}
            aria-label={t('snippets.targets.allHosts')}
            className={cn(
              actionButtonClass(embedded),
              targetsAllHosts
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            onClick={() => onTargetsAllHostsChange(!targetsAllHosts)}
          >
            {t('snippets.targets.allHostsShort')}
          </button>
        ) : null}
      </div>
    </div>

    {hint && !targetsAllHosts ? (
      <p className="text-[11px] text-muted-foreground leading-relaxed">{hint}</p>
    ) : null}

    {targetsAllHosts ? (
      <p className={cn(
        'text-muted-foreground/80',
        embedded ? 'text-[10px]' : 'text-[11px]',
      )}
      >
        {t('snippets.targets.allHostsActive')}
      </p>
    ) : targetHosts.length === 0 ? (
      embedded ? null : (
        <Button
          variant="secondary"
          className="w-full h-10"
          onClick={onEditTargets}
        >
          {t('snippets.targets.add')}
        </Button>
      )
    ) : (
      <div className={cn('gap-2', embedded ? 'flex flex-wrap' : 'space-y-2')}>
        {targetHosts.map((host) => (
          embedded ? (
            <div
              key={host.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border/60 bg-background/60 text-xs max-w-full"
            >
              <DistroAvatar host={host} fallback={host.os[0].toUpperCase()} size="sm" />
              <span className="truncate font-medium">{hostDisplayTitle(host)}</span>
            </div>
          ) : (
            <div
              key={host.id}
              className="flex items-center gap-3 px-3 py-2 bg-background/60 border border-border/70 rounded-lg"
            >
              <DistroAvatar host={host} fallback={host.os[0].toUpperCase()} size="log" />
              <div className="min-w-0 flex-1 text-sm font-semibold truncate">
                {hostDisplayTitle(host)}
              </div>
            </div>
          )
        ))}
      </div>
    )}
  </>
);

export const SnippetTargetsSection: React.FC<SnippetTargetsSectionProps> = ({
  t,
  targetHosts,
  onEditTargets,
  hint,
  variant = 'card',
  targetsAllHosts,
  onTargetsAllHostsChange,
}) => {
  const body = (
    <TargetsBody
      t={t}
      targetHosts={targetHosts}
      onEditTargets={onEditTargets}
      hint={hint}
      embedded={variant === 'embedded'}
      targetsAllHosts={targetsAllHosts}
      onTargetsAllHostsChange={onTargetsAllHostsChange}
    />
  );

  if (variant === 'embedded') {
    return <div className="space-y-2">{body}</div>;
  }

  return (
    <Card className="p-3 space-y-3 bg-card border-border/80">
      {body}
    </Card>
  );
};
