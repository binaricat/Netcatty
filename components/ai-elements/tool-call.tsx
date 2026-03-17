import { cn } from '../../lib/utils';
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle, Slash } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { useState } from 'react';

export interface ToolCallProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  isLoading?: boolean;
  isInterrupted?: boolean;
}

export const ToolCall = ({ name, args, result, isError, isLoading, isInterrupted, className, ...props }: ToolCallProps) => {
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
    <div className={cn('rounded-md border border-border/25 bg-muted/10 overflow-hidden text-[12px]', className)} {...props}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors cursor-pointer"
      >
        {expanded
          ? <ChevronDown size={12} className="text-muted-foreground/40 shrink-0" />
          : <ChevronRight size={12} className="text-muted-foreground/40 shrink-0" />
        }
        <span className="font-mono text-muted-foreground/70 truncate">{name}</span>
        <span className="flex-1" />
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
