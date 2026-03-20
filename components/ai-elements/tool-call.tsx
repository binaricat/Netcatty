import { cn } from '../../lib/utils';
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle, Slash } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { useState } from 'react';

export interface ToolCallProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  subtitle?: string;
  statusLabel?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  isLoading?: boolean;
  isInterrupted?: boolean;
}

export const ToolCall = ({ name, subtitle, statusLabel, args, result, isError, isLoading, isInterrupted, className, ...props }: ToolCallProps) => {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = isLoading ? (
    <Loader2 size={12} className="animate-spin text-blue-400/70" />
  ) : isInterrupted ? (
    <Slash size={12} className="text-muted-foreground/55" />
  ) : isError ? (
    <XCircle size={12} className="text-red-400/70" />
  ) : result !== undefined ? (
    <CheckCircle2 size={12} className="text-green-400/70" />
  ) : null;

  return (
    <div className={cn(
      'overflow-hidden rounded-md border text-[12px]',
      isLoading ? 'border-primary/30 bg-primary/5' : 'border-border/25 bg-muted/10',
      className,
    )} {...props}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors cursor-pointer"
      >
        {expanded
          ? <ChevronDown size={12} className="text-muted-foreground/40 shrink-0" />
          : <ChevronRight size={12} className="text-muted-foreground/40 shrink-0" />
        }
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-muted-foreground/78">{name}</div>
          {subtitle && (
            <div className="truncate text-[10px] text-muted-foreground/55">{subtitle}</div>
          )}
        </div>
        {statusLabel && (
          <span className={cn(
            'rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
            isLoading ? 'bg-primary/12 text-primary' : 'bg-muted/30 text-muted-foreground/65',
          )}>
            {statusLabel}
          </span>
        )}
        {statusIcon}
      </button>
      {expanded && (
        <div className="border-t border-border/20">
          {args && Object.keys(args).length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">Arguments</div>
              <pre className="text-[11px] font-mono text-muted-foreground/50 whitespace-pre-wrap break-all">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result !== undefined && (
            <div className="px-3 py-2 border-t border-border/20">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">Result</div>
              <pre className={cn(
                'text-[11px] font-mono whitespace-pre-wrap break-all',
                isError ? 'text-red-400/60' : 'text-muted-foreground/50',
              )}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
          {isInterrupted && result === undefined && (
            <div className="px-3 py-2 border-t border-border/20">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">Status</div>
              <div className="text-[11px] text-muted-foreground/50">
                Interrupted
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
