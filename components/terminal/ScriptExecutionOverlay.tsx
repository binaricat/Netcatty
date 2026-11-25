import { Check, Loader2, Pause, Play, Square, X } from 'lucide-react';
import React, { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import type { ScriptRun } from '@/types/global/netcatty-bridge-script.d.ts';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils.ts';

export interface ScriptExecutionOverlayProps {
  run: ScriptRun;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDismiss: () => void;
  /**
   * Host info bar is hidden: no full toolbar. Sit the banner higher and stack
   * above the compact speed-dial (cover it for the run duration).
   */
  compactTopChrome?: boolean;
}

/** Default top offset under the full host-info toolbar. */
export const SCRIPT_OVERLAY_TOP_DEFAULT_PX = 34;
/** Top offset when only the compact speed-dial is present. */
export const SCRIPT_OVERLAY_TOP_COMPACT_PX = 8;
/** Completed script results remain visible briefly before dismissing themselves. */
export const SCRIPT_OVERLAY_FINISHED_DISMISS_DELAY_MS = 5_000;

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0) {
    return `${minutes}:${String(rest).padStart(2, '0')}`;
  }
  return `${rest}s`;
}

function resolveWaitingPattern(
  run: ScriptRun,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (!run.waitingFor) return undefined;
  if (run.waitingFor === 'shell prompt' || run.waitingFor.includes(' | ')) {
    return t('scripts.running.waitingForShellPrompt');
  }
  return run.waitingFor;
}

function isLowValueActivityLabel(label?: string) {
  if (!label) return true;
  const normalized = label.trim().toLowerCase();
  return normalized === 'log' || normalized.startsWith('sleep ');
}

function DotSeparator() {
  return <span className="text-muted-foreground/35 px-0.5">·</span>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Accent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('text-primary font-semibold tabular-nums', className)}>
      {children}
    </span>
  );
}

function ScriptStatusIcon({ status }: { status: ScriptRun['status'] }) {
  const iconClass = 'block';
  const boxClass = 'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center';
  if (status === 'completed') {
    return (
      <span className={boxClass} aria-hidden>
        <Check size={14} className={cn(iconClass, 'text-emerald-500')} />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className={boxClass} aria-hidden>
        <X size={14} className={cn(iconClass, 'text-destructive')} />
      </span>
    );
  }
  return (
    <span className={boxClass} aria-hidden>
      <Loader2 size={14} className={cn(iconClass, 'animate-spin text-primary')} />
    </span>
  );
}

function ScriptStatusLine({
  run,
  elapsedMs,
  lastSent,
  t,
}: {
  run: ScriptRun;
  elapsedMs: number;
  lastSent?: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const label = run.scriptLabel || t('scripts.running.unnamed');
  const opCount = run.stepIndex ?? 0;
  const elapsed = formatElapsed(elapsedMs);
  const waitingPattern = resolveWaitingPattern(run, t);
  const isFinished = run.status === 'completed' || run.status === 'failed';

  const opsSegment = (
    <>
      <Muted>{t('scripts.running.opsPrefix')}</Muted>
      <Accent>{opCount}</Accent>
      <Muted>{t('scripts.running.opsSuffix')}</Muted>
    </>
  );

  const elapsedSegment = <Accent>{elapsed}</Accent>;

  const activitySegment = !isLowValueActivityLabel(run.activityLabel) ? (
    <>
      <DotSeparator />
      <span className="text-foreground/90">{run.activityLabel}</span>
    </>
  ) : null;

  const progressSegment = run.progressMode === 'determinate' && run.progressTotal ? (
    <>
      <DotSeparator />
      <Muted>{run.progressLabel || t('scripts.running.progressFallback')}</Muted>
      {' '}
      <Accent>
        {run.progressCurrent ?? 0}
        /
        {run.progressTotal}
      </Accent>
    </>
  ) : null;

  const pausedSegment = run.status === 'paused' ? (
    <>
      <DotSeparator />
      <span className="text-amber-500 font-medium">{t('scripts.running.status.paused')}</span>
    </>
  ) : null;

  const waitingSegment = waitingPattern ? (
    <>
      <DotSeparator />
      <Muted>{t('scripts.running.waitingForLabel')}</Muted>
      {' '}
      <span className="text-amber-500 font-medium">{waitingPattern}</span>
    </>
  ) : null;

  const lastSentSegment = !waitingPattern && lastSent ? (
    <>
      <DotSeparator />
      <Muted>{t('scripts.running.lastSentLabel')}</Muted>
      {' '}
      <span className="text-primary/90 font-mono">{lastSent}</span>
    </>
  ) : null;

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 leading-4">
      <ScriptStatusIcon status={run.status} />
      <span className="shrink-0 whitespace-nowrap font-semibold text-foreground">{label}</span>
      <span className="inline-flex min-w-0 flex-1 items-center truncate">
        {(isFinished || opCount > 0) ? (
          <>
            <DotSeparator />
            {opsSegment}
          </>
        ) : null}
        <DotSeparator />
        {elapsedSegment}
        {!isFinished ? (
          <>
            {progressSegment}
            {activitySegment}
            {pausedSegment}
            {waitingSegment}
            {lastSentSegment}
          </>
        ) : null}
      </span>
    </span>
  );
}

export const ScriptExecutionOverlay: React.FC<ScriptExecutionOverlayProps> = ({
  run,
  onPause,
  onResume,
  onStop,
  onDismiss,
  compactTopChrome = false,
}) => {
  const { t } = useI18n();
  const [tick, setTick] = useState(0);
  const isFinished = run.status === 'completed' || run.status === 'failed';
  const dismissFinishedRun = useEffectEvent(onDismiss);

  useEffect(() => {
    if (isFinished) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isFinished, run.runId]);

  useEffect(() => {
    if (!isFinished) return undefined;
    const timer = setTimeout(dismissFinishedRun, SCRIPT_OVERLAY_FINISHED_DISMISS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isFinished, run.runId]);

  void tick;

  const elapsedMs = run.elapsedMs
    ?? (run.endedAt ? run.endedAt - run.startedAt : Date.now() - run.startedAt);
  const lastSent = [...(run.logs || [])].reverse().find((entry) => entry.message.startsWith('→ '))?.message.slice(2);
  const errorMessage = run.status === 'failed' ? run.error : undefined;

  const statusLine = useMemo(
    () => (
      <ScriptStatusLine run={run} elapsedMs={elapsedMs} lastSent={lastSent} t={t} />
    ),
    [run, elapsedMs, lastSent, t],
  );

  return (
    <div
      // z-40 sits above the compact speed-dial (z-30) so the full-width banner
      // covers the toggle while a script is running — no right-edge gutter.
      className="absolute left-2 right-2 z-40 rounded-md border shadow-md backdrop-blur-md pointer-events-auto px-3 py-2"
      style={{
        top: compactTopChrome ? SCRIPT_OVERLAY_TOP_COMPACT_PX : SCRIPT_OVERLAY_TOP_DEFAULT_PX,
        backgroundColor: 'color-mix(in srgb, var(--terminal-ui-bg) 92%, transparent)',
        borderColor: 'var(--terminal-ui-border)',
        color: 'var(--terminal-ui-fg)',
      }}
      data-section="script-execution-overlay"
      data-compact-top-chrome={compactTopChrome ? "true" : "false"}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex min-w-0 flex-1 items-center text-[11px] leading-4">
          {statusLine}
        </div>
        {errorMessage ? (
          <div
            className="min-w-0 max-w-[42%] shrink truncate text-right text-[11px] leading-4 text-destructive"
            title={errorMessage}
          >
            {errorMessage}
          </div>
        ) : null}
        <div className="flex items-center gap-1 shrink-0">
          {isFinished ? (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onDismiss} aria-label={t('scripts.running.dismiss')}>
                    <X size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('scripts.running.dismiss')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <>
              {run.status === 'running' ? (
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onPause}>
                  <Pause size={14} />
                </Button>
              ) : null}
              {run.status === 'paused' ? (
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onResume}>
                  <Play size={14} />
                </Button>
              ) : null}
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onStop}>
                <Square size={14} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
