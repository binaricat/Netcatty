import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';
import { Check, ChevronDown, ChevronRight, CheckCircle2, Loader2, ShieldAlert, X, XCircle, Slash } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useI18n } from '../../application/i18n/I18nProvider';

/**
 * Format tool result for display. Extracts stdout/stderr from structured
 * command results for terminal-like output.
 */
function formatToolResult(result: unknown): string {
  let parsed = result;

  if (typeof parsed === 'string') {
    try {
      const obj = JSON.parse(parsed);
      if (obj && typeof obj === 'object') parsed = obj;
    } catch {
      return parsed;
    }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.stdout === 'string' || typeof obj.stderr === 'string') {
      const parts: string[] = [];
      if (typeof obj.stdout === 'string' && obj.stdout) parts.push(obj.stdout);
      if (typeof obj.stderr === 'string' && obj.stderr) parts.push(obj.stderr);
      if (typeof obj.exitCode === 'number' && obj.exitCode !== 0) {
        parts.push(`exit code: ${obj.exitCode}`);
      }
      if (parts.length > 0) return parts.join('\n');
    }
  }

  if (typeof parsed === 'string') return parsed;
  return JSON.stringify(parsed, null, 2);
}

export interface ToolCallProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  className?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  isLoading?: boolean;
  isInterrupted?: boolean;
  /** Approval state for this tool call (from the approval gate). */
  approvalStatus?: 'pending' | 'approved' | 'denied';
  /** Called when user approves this tool call. */
  onApprove?: () => void;
  /** Called when user rejects this tool call. */
  onReject?: () => void;
}

export const ToolCall = ({
  name, args, result, isError, isLoading, isInterrupted,
  approvalStatus, onApprove, onReject,
  className, ...props
}: ToolCallProps) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const approveBtnRef = useRef<HTMLButtonElement>(null);
  const [responded, setResponded] = useState(false);

  const isPendingApproval = approvalStatus === 'pending' && !responded;

  const handleApprove = useCallback(() => {
    if (!isPendingApproval) return;
    setResponded(true);
    onApprove?.();
  }, [isPendingApproval, onApprove]);

  const handleReject = useCallback(() => {
    if (!isPendingApproval) return;
    setResponded(true);
    onReject?.();
  }, [isPendingApproval, onReject]);

  // Keyboard: Enter = approve, Escape = reject (when pending)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isPendingApproval) return;
    if (e.key === 'Enter') { e.preventDefault(); handleApprove(); }
    else if (e.key === 'Escape') { e.preventDefault(); handleReject(); }
  }, [isPendingApproval, handleApprove, handleReject]);

  // Auto-focus and auto-scroll when approval is pending
  useEffect(() => {
    if (isPendingApproval && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
      // Small delay to let the UI render, then expand and focus
      setExpanded(true);
      setTimeout(() => approveBtnRef.current?.focus(), 100);
    }
  }, [isPendingApproval]);

  // Reset responded state when approvalStatus changes (e.g. new approval)
  useEffect(() => {
    if (approvalStatus === 'pending') setResponded(false);
  }, [approvalStatus]);

  // Border/bg color based on approval status
  const borderClass = approvalStatus === 'pending'
    ? 'border-yellow-500/30 bg-yellow-500/[0.04]'
    : approvalStatus === 'approved'
      ? 'border-green-500/20 bg-green-500/[0.03]'
      : approvalStatus === 'denied'
        ? 'border-red-500/20 bg-red-500/[0.03]'
        : 'border-border/25 bg-muted/10';
  const statusIconClass = 'shrink-0';

  const statusIcon = approvalStatus === 'pending' ? (
    <ShieldAlert size={12} className={cn('text-yellow-500/70', statusIconClass)} />
  ) : isLoading ? (
    <Loader2 size={12} className={cn('animate-spin text-blue-400/70', statusIconClass)} />
  ) : isInterrupted ? (
    <Slash size={12} className={cn('text-muted-foreground/55', statusIconClass)} />
  ) : isError ? (
    <XCircle size={12} className={cn('text-red-400/70', statusIconClass)} />
  ) : result !== undefined ? (
    <CheckCircle2 size={12} className={cn('text-green-400/70', statusIconClass)} />
  ) : null;

  return (
    <div
      ref={cardRef}
      tabIndex={isPendingApproval ? 0 : undefined}
      onKeyDown={isPendingApproval ? handleKeyDown : undefined}
      className={cn('rounded-md border overflow-hidden text-[12px] outline-none', borderClass, className)}
      {...props}
    >
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors cursor-pointer"
      >
        {expanded
          ? <ChevronDown size={12} className="text-muted-foreground/40 shrink-0" />
          : <ChevronRight size={12} className="text-muted-foreground/40 shrink-0" />
        }
        {name === 'terminal_execute' && args?.command ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-muted-foreground/70 truncate cursor-default">
                <span className="text-muted-foreground/40">$ </span>{String(args.command)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{String(args.command)}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="font-mono text-muted-foreground/70 truncate">{name}</span>
        )}
        <span className="flex-1" />
        {/* Approval badge for resolved approvals */}
        {approvalStatus === 'approved' && (
          <Badge className="text-[10px] px-1.5 py-0 bg-green-600/20 text-green-400 border-green-600/30">
            {t('ai.chat.toolApproved')}
          </Badge>
        )}
        {approvalStatus === 'denied' && (
          <Badge className="text-[10px] px-1.5 py-0 bg-red-600/20 text-red-400 border-red-600/30">
            {t('ai.chat.toolDenied')}
          </Badge>
        )}
        {statusIcon}
      </button>

      {expanded && (
        <div className="border-t border-border/20">
          {args && Object.keys(args).length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">Arguments</div>
              <pre className="max-h-64 overflow-auto text-[11px] font-mono text-muted-foreground/50 whitespace-pre [overflow-wrap:normal]">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {/* Inline approval buttons */}
          {isPendingApproval && (
            <div className="px-3 py-2 border-t border-border/20">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground/30">
                  {t('ai.chat.toolApprovalHint')}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px] border-red-500/20 text-red-400/80 hover:bg-red-500/10 hover:text-red-400"
                    onClick={handleReject}
                  >
                    <X size={11} className="mr-0.5" />
                    {t('ai.chat.reject')}
                  </Button>
                  <Button
                    ref={approveBtnRef}
                    size="sm"
                    className="h-6 px-2.5 text-[11px] bg-green-600/80 hover:bg-green-600 text-white"
                    onClick={handleApprove}
                  >
                    <Check size={11} className="mr-0.5" />
                    {t('ai.chat.approve')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {result !== undefined && (
            <div className="px-3 py-2 border-t border-border/20">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">Result</div>
              <pre className={cn(
                'max-h-64 overflow-auto text-[11px] font-mono whitespace-pre [overflow-wrap:normal]',
                isError ? 'text-red-400/60' : 'text-muted-foreground/50',
              )}>
                {formatToolResult(result)}
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
