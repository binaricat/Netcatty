import { Pause, Play, Square } from 'lucide-react';
import React from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils.ts';

export interface ScriptRecordingIndicatorProps {
  elapsedMs: number;
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

function formatElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export const ScriptRecordingIndicator: React.FC<ScriptRecordingIndicatorProps> = ({
  elapsedMs,
  isPaused,
  onPause,
  onResume,
  onStop,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex items-center gap-1 text-red-500 font-medium">
        <span className={cn('inline-block h-2 w-2 rounded-full bg-red-500', !isPaused && 'animate-pulse')} />
        REC
      </span>
      <span className="tabular-nums text-muted-foreground">{formatElapsed(elapsedMs)}</span>
      {isPaused ? (
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onResume} title={t('scripts.recording.resume')}>
          <Play size={14} />
        </Button>
      ) : (
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onPause} title={t('scripts.recording.pause')}>
          <Pause size={14} />
        </Button>
      )}
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onStop} title={t('scripts.recording.stop')}>
        <Square size={14} />
      </Button>
    </div>
  );
};
