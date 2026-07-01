import { CircleHelp } from 'lucide-react';
import React, { useState } from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const HELP_STEP_KEYS = [
  'scripts.recording.helpStep1',
  'scripts.recording.helpStep2',
  'scripts.recording.helpStep3',
  'scripts.recording.helpStep4',
  'scripts.recording.helpStep5',
] as const;

const HELP_TIP_KEYS = [
  'scripts.recording.helpTip1',
  'scripts.recording.helpTip2',
  'scripts.recording.helpTip3',
  'scripts.recording.helpTip4',
] as const;

export interface ScriptRecordingHelpDialogProps {
  triggerClassName?: string;
}

export const ScriptRecordingHelpDialog: React.FC<ScriptRecordingHelpDialogProps> = ({
  triggerClassName,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('scripts.recording.helpTitle')}
            className={triggerClassName ?? 'shrink-0 h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors'}
          >
            <CircleHelp size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('scripts.recording.helpTitle')}</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('scripts.recording.helpTitle')}</DialogTitle>
            <DialogDescription>{t('scripts.recording.helpIntro')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <ol className="list-none">
              {HELP_STEP_KEYS.map((key, index) => (
                <li
                  key={key}
                  className={cn(
                    'flex items-start gap-3 py-3',
                    index < HELP_STEP_KEYS.length - 1 && 'border-b border-border/50',
                  )}
                >
                  <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold tabular-nums leading-none mt-px">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-foreground text-sm leading-relaxed">{t(key)}</span>
                </li>
              ))}
            </ol>

            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">{t('scripts.recording.helpTipsTitle')}</p>
              <ul className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
                {HELP_TIP_KEYS.map((key) => (
                  <li key={key} className="flex gap-2">
                    <span className="shrink-0">•</span>
                    <span>{t(key)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setOpen(false)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
