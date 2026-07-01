import React from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import type { ScriptRun } from '@/types/global/netcatty-bridge-script.d.ts';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils.ts';

export interface ScriptRunLogDialogProps {
  run: ScriptRun | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatDuration(startedAt: number, endedAt?: number) {
  const ms = (endedAt ?? Date.now()) - startedAt;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export const ScriptRunLogDialog: React.FC<ScriptRunLogDialogProps> = ({
  run,
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  if (!run) return null;

  const label = run.scriptLabel || run.scriptId || t('scripts.running.unnamed');
  const elapsed = formatDuration(run.startedAt, run.endedAt);
  const statusLabel = t(`scripts.running.status.${run.status}`);
  const logText = run.logs.map((entry) => entry.message).join('\n');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('scripts.running.logTitle', { name: label })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{statusLabel}</span>
            <span aria-hidden>·</span>
            <span>{t('scripts.running.operationsCount', { count: run.stepIndex ?? 0 })}</span>
            <span aria-hidden>·</span>
            <span>{t('scripts.running.elapsed', { elapsed })}</span>
          </div>
          {run.error ? (
            <div className="text-xs text-destructive">{run.error}</div>
          ) : null}
          {run.waitingFor ? (
            <div className="text-xs text-muted-foreground">
              {t('scripts.running.waitingFor', { pattern: run.waitingFor })}
            </div>
          ) : null}
          <pre className={cn(
            'text-xs bg-secondary/40 rounded-md p-3 max-h-[min(60vh,420px)] overflow-auto whitespace-pre-wrap font-mono leading-relaxed',
            !logText && 'text-muted-foreground italic',
          )}
          >
            {logText || t('scripts.running.logEmpty')}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
};
