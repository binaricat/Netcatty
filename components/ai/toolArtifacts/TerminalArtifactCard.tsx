import { AlertCircle, SquareTerminal } from 'lucide-react';
import React from 'react';
import { cn } from '../../../lib/utils';
import type { TerminalToolArtifact } from './terminalToolArtifact';

interface TerminalArtifactCardProps {
  artifact: TerminalToolArtifact;
  className?: string;
}

function formatLineRange(artifact: Extract<TerminalToolArtifact, { kind: 'terminal.context' }>): string {
  if (artifact.returnedLines === 0) {
    return `0 / ${artifact.totalLines} lines`;
  }
  return `lines ${artifact.startLine + 1}-${artifact.endLine + 1} / ${artifact.totalLines}`;
}

function formatSubtitle(artifact: Extract<TerminalToolArtifact, { kind: 'terminal.context' }>): string {
  const parts = [
    formatLineRange(artifact),
    artifact.source,
    artifact.hasMoreBefore || artifact.hasMoreAfter ? 'more available' : null,
  ].filter(Boolean);
  return parts.join(' | ');
}

export const TerminalArtifactCard = React.forwardRef<HTMLDivElement, TerminalArtifactCardProps>(({
  artifact,
  className,
}, ref) => {
  if (artifact.kind === 'error') {
    return (
      <div className={cn(
        'flex w-full items-center gap-2.5 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2',
        className,
      )} ref={ref}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
          <AlertCircle size={15} />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[12px] font-medium text-foreground/85">
            Terminal read failed
          </div>
          <div className="truncate text-[11px] text-muted-foreground/60">
            {artifact.message}
          </div>
        </div>
      </div>
    );
  }

  const title = artifact.label || artifact.sessionId;

  return (
    <div className={cn(
      'flex w-full items-center gap-2.5 rounded-md border border-border/25 bg-muted/10 px-2.5 py-2',
      className,
    )} ref={ref}>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-500">
        <SquareTerminal size={15} />
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-[12px] font-medium text-foreground/85">
          {title}
        </div>
        <div className="truncate text-[11px] text-muted-foreground/60">
          {formatSubtitle(artifact)}
        </div>
      </div>
    </div>
  );
});
TerminalArtifactCard.displayName = 'TerminalArtifactCard';
