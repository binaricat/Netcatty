import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Slash, XCircle } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';

// Palette of accent colors for host identity (works on light and dark backgrounds)
const HOST_COLORS = [
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#34d399', // emerald
  '#fb923c', // orange
  '#f472b6', // pink
  '#38bdf8', // sky
  '#facc15', // yellow
  '#f87171', // red
];

function getHostColor(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return HOST_COLORS[h % HOST_COLORS.length];
}

export interface TerminalToolCallProps {
  command: string;
  hostLabel: string;
  hostSessionId: string;
  statusLabel?: string;
  fullCommand?: string;  // untruncated command for expanded view
  result?: unknown;
  isError?: boolean;
  isLoading?: boolean;
  isInterrupted?: boolean;
}

export const TerminalToolCall = ({
  command,
  hostLabel,
  hostSessionId,
  statusLabel,
  fullCommand,
  result,
  isError,
  isLoading,
  isInterrupted,
}: TerminalToolCallProps) => {
  const [expanded, setExpanded] = useState(false);
  const color = getHostColor(hostSessionId);
  const hasDetails = result !== undefined || isInterrupted;

  const statusIcon = isLoading ? (
    <Loader2 size={11} className="animate-spin shrink-0" style={{ color }} />
  ) : isInterrupted ? (
    <Slash size={11} className="text-muted-foreground/55 shrink-0" />
  ) : isError ? (
    <XCircle size={11} className="text-red-400/70 shrink-0" />
  ) : result !== undefined ? (
    <CheckCircle2 size={11} className="shrink-0" style={{ color }} />
  ) : null;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border text-[12px]',
        isLoading ? 'bg-primary/5' : 'bg-muted/10',
      )}
      style={{
        borderColor: `${color}30`,
        borderLeftColor: color,
        borderLeftWidth: 3,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex flex-col gap-0.5 px-3 py-1.5 hover:bg-muted/20 transition-colors cursor-pointer text-left"
      >
        <div className="flex items-center gap-1.5">
          {expanded
            ? <ChevronDown size={11} className="text-muted-foreground/40 shrink-0" />
            : <ChevronRight size={11} className="text-muted-foreground/40 shrink-0" />
          }
          {hostLabel ? (
            <>
              {/* With host info: colored dot + host name */}
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span className="font-medium text-foreground/85 truncate flex-1 text-[12px]">{hostLabel}</span>
            </>
          ) : (
            /* No host info (ACP agents): command is the primary content */
            <span className="font-mono text-foreground/80 truncate flex-1 text-[12px]">
              {command || (isLoading ? '…' : '—')}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/40 shrink-0 font-mono">terminal_execute</span>
          {statusLabel && (
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide bg-primary/12 text-primary shrink-0">
              {statusLabel}
            </span>
          )}
          {statusIcon}
        </div>

        {/* Row 2: command preview — only shown when host is known */}
        {hostLabel && (
          <div className="pl-[22px] truncate font-mono text-muted-foreground/65 text-[11px]">
            {command || '—'}
          </div>
        )}
      </button>

      {/* Expanded: full command + result */}
      {expanded && hasDetails && (
        <div className="border-t" style={{ borderColor: `${color}22` }}>
          {/* Full command (if it may have been truncated) */}
          {fullCommand && fullCommand !== command && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">
                Command
              </div>
              <pre className="text-[11px] font-mono text-muted-foreground/60 whitespace-pre-wrap break-all">
                {fullCommand}
              </pre>
            </div>
          )}

          {result !== undefined && (
            <div className="px-3 py-2 border-t" style={{ borderColor: `${color}22` }}>
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">
                Result
              </div>
              <pre className={cn(
                'text-[11px] font-mono whitespace-pre-wrap break-all',
                isError ? 'text-red-400/60' : 'text-muted-foreground/50',
              )}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}

          {isInterrupted && result === undefined && (
            <div className="px-3 py-2 border-t" style={{ borderColor: `${color}22` }}>
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">
                Status
              </div>
              <div className="text-[11px] text-muted-foreground/50">Interrupted</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
