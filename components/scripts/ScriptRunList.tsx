import { Check, FileText, Loader2, Pause, Play, Square, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import type { ScriptRun } from '@/types/global/netcatty-bridge-script.d.ts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils.ts';
import { ScriptRunLogDialog } from './ScriptRunLogDialog';

export interface ScriptRunListProps {
  runs: ScriptRun[];
  onStop: (runId: string) => void;
  onPause: (runId: string) => void;
  onResume: (runId: string) => void;
}

function formatDuration(startedAt: number, endedAt?: number) {
  const ms = (endedAt ?? Date.now()) - startedAt;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function ScriptStatusIcon({ status }: { status: ScriptRun['status'] }) {
  if (status === 'completed') {
    return <Check size={14} className="text-emerald-500 shrink-0" aria-hidden />;
  }
  if (status === 'failed') {
    return <X size={14} className="text-destructive shrink-0" aria-hidden />;
  }
  return <Loader2 size={14} className="animate-spin text-primary shrink-0" aria-hidden />;
}

function resolveRunMeta(run: ScriptRun, t: (key: string, params?: Record<string, string | number>) => string) {
  const elapsed = formatDuration(run.startedAt, run.endedAt);
  const parts: string[] = [t(`scripts.running.status.${run.status}`)];

  if ((run.stepIndex ?? 0) > 0 || run.status === 'running' || run.status === 'paused') {
    parts.push(t('scripts.running.operationsCount', { count: run.stepIndex ?? 0 }));
  }

  if (run.status === 'running' || run.status === 'paused') {
    if (run.progressMode === 'determinate' && run.progressTotal) {
      parts.push(t('scripts.running.determinateProgress', {
        label: run.progressLabel || t('scripts.running.progressFallback'),
        current: run.progressCurrent ?? 0,
        total: run.progressTotal,
      }));
    } else if (run.activityLabel) {
      parts.push(run.activityLabel);
    } else if (run.waitingFor) {
      parts.push(t('scripts.running.waitingFor', { pattern: run.waitingFor }));
    }
  }

  parts.push(t('scripts.running.elapsed', { elapsed }));
  return parts.join(' · ');
}

function sortRuns(runs: ScriptRun[]): ScriptRun[] {
  const rank = (status: ScriptRun['status']) => {
    if (status === 'running') return 0;
    if (status === 'paused') return 1;
    return 2;
  };
  return [...runs].sort((a, b) => {
    const rankDiff = rank(a.status) - rank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return b.startedAt - a.startedAt;
  });
}

export const ScriptRunList: React.FC<ScriptRunListProps> = ({
  runs,
  onStop,
  onPause,
  onResume,
}) => {
  const { t } = useI18n();
  const [logRunId, setLogRunId] = useState<string | null>(null);

  const sortedRuns = useMemo(() => sortRuns(runs), [runs]);
  const logRun = sortedRuns.find((run) => run.runId === logRunId) ?? null;

  if (runs.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-sm text-muted-foreground">
        {t('scripts.running.empty')}
      </div>
    );
  }

  return (
    <>
      <div className="py-1">
        {sortedRuns.map((run) => {
          const label = run.scriptLabel || run.scriptId || t('scripts.running.unnamed');
          const isActive = run.status === 'running' || run.status === 'paused';
          return (
            <div
              key={run.runId}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-accent/40 transition-colors"
            >
              <ScriptStatusIcon status={run.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{label}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {resolveRunMeta(run, t)}
                </div>
                {run.error ? (
                  <div className="truncate text-[10px] text-destructive">{run.error}</div>
                ) : null}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={t('scripts.running.viewLogs')}
                  onClick={() => setLogRunId(run.runId)}
                >
                  <FileText size={14} />
                </Button>
                {run.status === 'running' ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={t('scripts.running.pause')}
                    onClick={() => onPause(run.runId)}
                  >
                    <Pause size={14} />
                  </Button>
                ) : null}
                {run.status === 'paused' ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={t('scripts.running.resume')}
                    onClick={() => onResume(run.runId)}
                  >
                    <Play size={14} />
                  </Button>
                ) : null}
                {isActive ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn('h-7 w-7', isActive && 'text-destructive hover:text-destructive')}
                    aria-label={t('scripts.running.stop')}
                    onClick={() => onStop(run.runId)}
                  >
                    <Square size={14} />
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <ScriptRunLogDialog
        run={logRun}
        open={Boolean(logRun)}
        onOpenChange={(open) => {
          if (!open) setLogRunId(null);
        }}
      />
    </>
  );
};
