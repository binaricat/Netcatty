import { ArrowDownToLine, ArrowUpFromLine, X } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface ZmodemProgressIndicatorProps {
  transferType: 'upload' | 'download' | null;
  filename: string | null;
  transferred: number;
  total: number;
  fileIndex: number;
  fileCount: number;
  finalizing: boolean;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export const ZmodemProgressIndicator: React.FC<ZmodemProgressIndicatorProps> = ({
  transferType,
  filename,
  transferred,
  total,
  fileIndex,
  fileCount,
  finalizing,
  onCancel,
}) => {
  const { t } = useI18n();
  const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  const Icon = transferType === 'upload' ? ArrowUpFromLine : ArrowDownToLine;
  const label = finalizing
    ? t('zmodem.waitingForRemote')
    : transferType === 'upload'
      ? t('zmodem.uploading')
      : t('zmodem.downloading');
  const fileInfo = fileCount > 0 ? ` (${fileIndex + 1}/${fileCount})` : '';

  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm min-w-[240px] max-w-[360px]"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--terminal-ui-bg, #000000) 90%, transparent)',
        border: '1px solid color-mix(in srgb, var(--terminal-ui-fg, #ffffff) 15%, var(--terminal-ui-bg, #000000))',
        color: 'var(--terminal-ui-fg, #ffffff)',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon className="h-4 w-4 flex-shrink-0 opacity-60" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-xs font-medium truncate">
            {filename || label}{fileInfo}
          </span>
          <span className="text-[10px] opacity-60 flex-shrink-0">{percent}%</span>
        </div>
        <div className="w-full h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'color-mix(in srgb, var(--terminal-ui-fg, #ffffff) 10%, transparent)' }}>
          <div
            className="h-full rounded-full transition-all duration-150"
            style={{
              width: `${percent}%`,
              backgroundColor: transferType === 'upload' ? '#3b82f6' : '#22c55e',
            }}
          />
        </div>
        <div className="text-[10px] opacity-50 mt-0.5">
          {formatBytes(transferred)} / {formatBytes(total)}
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onCancel}
            className="flex-shrink-0 p-1 rounded transition-colors hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5 opacity-60" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('zmodem.cancelTransfer')}</TooltipContent>
      </Tooltip>
    </div>
  );
};
