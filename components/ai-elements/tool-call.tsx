import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';
import { Check, ChevronDown, ChevronRight, CheckCircle2, Copy, Loader2, ShieldAlert, X, XCircle, Slash } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cancelApprovalTimeout } from '../../infrastructure/ai/shared/approvalGate';

export const MAX_TOOL_COMMAND_TOOLTIP_CHARS = 240;
/** Collapsed approval command block max height (px). Full text remains scrollable. */
export const APPROVAL_COMMAND_COLLAPSED_MAX_HEIGHT_PX = 144;
/** Expanded approval command block max height (px). */
export const APPROVAL_COMMAND_EXPANDED_MAX_HEIGHT_PX = 384;
/** Prefer expand control when the raw command exceeds this many characters. */
export const APPROVAL_COMMAND_EXPAND_CHAR_THRESHOLD = 180;

const NESTED_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"]';

/**
 * Enter on the pending-card root means Approve Once. Enter on nested review
 * controls (Copy / Expand / action buttons) must not approve — those controls
 * also stopPropagation on Enter so the card handler is a second line of defense.
 */
export function isNestedInteractiveApprovalTarget(
  target: { closest?: (selector: string) => unknown } | null,
  currentTarget: unknown,
): boolean {
  if (!target || target === currentTarget) return false;
  if (typeof target.closest !== 'function') return false;
  return Boolean(target.closest(NESTED_INTERACTIVE_SELECTOR));
}

export function truncateToolCommandTooltip(
  command: string,
  maxChars = MAX_TOOL_COMMAND_TOOLTIP_CHARS,
): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Pull the user-meaningful shell command out of the tool-call args.
 *
 * Different tool surfaces hand us different shapes:
 *   - Netcatty's own `terminal_execute` MCP tool → `{command: "<string>"}`
 *   - Codex `local_shell`                      → `{command: ["zsh","-lc","<full>"]}`
 *   - Codex command_execution (SDK)             → `{command: "/bin/zsh -lc '<full>'"}`
 *   - Claude `Bash`                             → `{command: "<string>"}`
 *
 * The SDK form is a STRING that wraps the real command in `<shell> -lc '<full>'`,
 * so we unwrap that wrapper too (the array branch already did the equivalent) —
 * otherwise the outer shell quotes leak into the title.
 *
 * And under the "Skill + CLI" integration, the agent's shell tool wraps a
 * call to our internal `netcatty-tool-cli` binary, so the real intent is one
 * level deeper:
 *
 *   netcatty-tool-cli exec --session <id> --chat-session <id> -- <real-cmd>
 *
 * We unwrap both layers so the chat panel shows what the user actually
 * cares about (the remote command), not Codex's wrapper title which is
 * just the local path to the CLI binary.
 */
export function extractDisplayCommand(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const raw = (args as { command?: unknown }).command;

  let cmdString: string;
  if (typeof raw === 'string') {
    if (!raw) return null;
    cmdString = raw;
  } else if (Array.isArray(raw) && raw.length > 0) {
    const isShellWrap =
      raw.length >= 3 &&
      /(?:^|\/)(sh|bash|zsh|fish|ash|dash)$/.test(String(raw[0] ?? '')) &&
      /^-l?c$/.test(String(raw[1] ?? ''));
    cmdString = isShellWrap
      ? String(raw[raw.length - 1] ?? '')
      : raw.map((p) => String(p)).join(' ');
  } else {
    return null;
  }

  // Unwrap a STRING shell wrapper, e.g. Codex SDK's `/bin/zsh -lc '<full>'`.
  // The array branch above already extracts the inner command; the string form
  // (codex command_execution) does not, so strip `<shell> -l?c <quote>…<quote>`
  // here. Without this the outer quote leaks into the netcatty-cli title below.
  const strWrap = cmdString.match(
    /^(?:\S*\/)?(?:sh|bash|zsh|fish|ash|dash)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/,
  );
  if (strWrap) cmdString = strWrap[2];

  // Netcatty CLI wrapper extraction.
  // Packaged / Windows paths may be `netcatty-tool-cli.cjs` or `.cmd`; strip the
  // optional extension so the subcommand after the binary is still found.
  const cliIdx = cmdString.search(/netcatty-tool-cli(?:\.(?:cjs|cmd|exe|js))?/i);
  if (cliIdx >= 0) {
    const cliMatch = cmdString.slice(cliIdx).match(/^netcatty-tool-cli(?:\.(?:cjs|cmd|exe|js))?/i);
    const cliTokenLen = cliMatch?.[0]?.length ?? 'netcatty-tool-cli'.length;
    const afterCli = cmdString
      .slice(cliIdx + cliTokenLen)
      .replace(/^["']?\s*/, '');
    const subMatch = afterCli.match(/^(\S+)/);
    const sub = subMatch ? subMatch[1] : '';

    if (sub === 'exec' || sub === 'job-start') {
      // Pull out the command after the ` -- ` separator.
      const dashIdx = afterCli.indexOf(' -- ');
      if (dashIdx >= 0) {
        let inner = afterCli.slice(dashIdx + 4).trim();
        if (
          inner.length >= 2 &&
          ((inner[0] === '"' && inner.endsWith('"')) ||
            (inner[0] === "'" && inner.endsWith("'")))
        ) {
          inner = inner.slice(1, -1);
        }
        return inner;
      }
    }
    if (sub === 'job-poll') return 'netcatty: poll job';
    if (sub === 'job-stop') return 'netcatty: stop job';
    if (sub === 'session') return 'netcatty: inspect session';
    if (sub === 'env') return 'netcatty: list sessions';
    if (sub === 'status') return 'netcatty: status';
    if (sub) return `netcatty: ${sub}`;
  }

  return cmdString;
}

export interface ApprovalExecutionContext {
  sessionId?: string;
  cwd?: string;
  shell?: string;
  reason?: string;
}

function rawCommandString(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const raw = (args as { command?: unknown }).command;
  if (typeof raw === 'string') return raw || null;
  if (Array.isArray(raw) && raw.length > 0) return raw.map((p) => String(p)).join(' ');
  return null;
}

const APPROVAL_CONTEXT_ARG_KEYS = new Set([
  'command',
  'cwd',
  'working_directory',
  'workdir',
  'workingDirectory',
  'sessionId',
  'shell',
  'reason',
]);

/**
 * True when pending args still carry review-relevant fields beyond the
 * command block / execution-context strip (e.g. commandActions).
 */
export function approvalArgsHaveExtraContext(
  args: Record<string, unknown> | undefined,
): boolean {
  if (!args) return false;
  return Object.keys(args).some((key) => !APPROVAL_CONTEXT_ARG_KEYS.has(key));
}

/**
 * True when the reviewable display command was unwrapped from a Skills+CLI /
 * shell wrapper — the pending card should still surface target flags.
 */
export function approvalCommandWasUnwrapped(
  args: Record<string, unknown> | undefined,
  displayCommand: string | null,
): boolean {
  if (!displayCommand) return false;
  const raw = rawCommandString(args);
  if (!raw || raw === displayCommand) return false;
  return raw.includes('netcatty-tool-cli') || /(?:^|\/)(sh|bash|zsh|fish|ash|dash)\s+-l?c\s+/.test(raw)
    || (Array.isArray(args?.command) && args.command.length >= 3);
}

/**
 * Best-effort execution context for approval review (session / cwd / shell).
 * Never invents host names; only surfaces fields already present on tool args
 * or explicit netcatty-tool-cli flags in the command string.
 */
export function extractApprovalExecutionContext(
  args: Record<string, unknown> | undefined,
): ApprovalExecutionContext | null {
  if (!args) return null;

  let sessionId = typeof args.sessionId === 'string' && args.sessionId.trim()
    ? args.sessionId.trim()
    : undefined;

  const cwdCandidate = [args.cwd, args.working_directory, args.workdir, args.workingDirectory]
    .find((value) => typeof value === 'string' && value.trim());
  const cwd = typeof cwdCandidate === 'string' ? cwdCandidate.trim() : undefined;

  let shell = typeof args.shell === 'string' && args.shell.trim()
    ? args.shell.trim()
    : undefined;

  const reason = typeof args.reason === 'string' && args.reason.trim()
    ? args.reason.trim()
    : undefined;

  const raw = (args as { command?: unknown }).command;
  if (!shell) {
    if (Array.isArray(raw) && raw.length >= 2) {
      const first = String(raw[0] ?? '');
      const shellMatch = first.match(/(?:^|\/)(sh|bash|zsh|fish|ash|dash)$/);
      if (shellMatch) shell = shellMatch[1];
    } else if (typeof raw === 'string') {
      const shellMatch = raw.match(/^(?:\S*\/)?(sh|bash|zsh|fish|ash|dash)\s+-l?c\s+/);
      if (shellMatch) shell = shellMatch[1];
    }
  }

  // Skills+CLI wrappers keep the Netcatty target only on CLI flags after unwrap.
  if (!sessionId) {
    const cmd = rawCommandString(args);
    if (cmd && cmd.includes('netcatty-tool-cli')) {
      const sessionMatch = cmd.match(/--session(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const fromFlag = sessionMatch?.[1] ?? sessionMatch?.[2] ?? sessionMatch?.[3];
      if (fromFlag) sessionId = fromFlag;
    }
  }

  if (!sessionId && !cwd && !shell && !reason) return null;
  return { sessionId, cwd, shell, reason };
}

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
  approvalTarget?: { label: string; hostname: string };
  className?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  isLoading?: boolean;
  isInterrupted?: boolean;
  /** Approval state for this tool call (from the approval gate). */
  approvalStatus?: 'pending' | 'approved' | 'denied';
  /** Pending approval id used to cancel the auto-deny timer on review. */
  approvalId?: string;
  /** Called when user approves this tool call. */
  onApprove?: () => void;
  /** Called when user rejects this tool call. */
  onReject?: () => void;
  /** Called when user approves once without persisting a grant rule. */
  onApproveOnce?: () => void;
  /** Called when user approves and persists an always-allow grant rule. */
  onAlwaysAllow?: () => void;
  /** Optional source-specific label for the persistent/session approval action. */
  alwaysAllowLabel?: string;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof document === 'undefined') return false;
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export const ToolCall = ({
  name, args, result, isError, isLoading, isInterrupted, approvalTarget,
  approvalStatus, approvalId, onApprove, onReject, onApproveOnce, onAlwaysAllow, alwaysAllowLabel,
  className, ...props
}: ToolCallProps) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [commandExpanded, setCommandExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [frozenCommand, setFrozenCommand] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const approveBtnRef = useRef<HTMLButtonElement>(null);
  const [responded, setResponded] = useState(false);

  const isPendingApproval = approvalStatus === 'pending' && !responded;
  const liveDisplayCommand = extractDisplayCommand(args);
  const reviewCommand = isPendingApproval
    ? (frozenCommand ?? liveDisplayCommand)
    : liveDisplayCommand;
  const executionContext = extractApprovalExecutionContext(args);
  const showApprovalCommand = Boolean(isPendingApproval && reviewCommand);
  const showArgsAlongsideCommand = Boolean(
    showApprovalCommand
    && args
    && Object.keys(args).length > 0
    && (approvalCommandWasUnwrapped(args, reviewCommand) || approvalArgsHaveExtraContext(args)),
  );
  const commandNeedsExpand = Boolean(
    reviewCommand
    && (reviewCommand.length > APPROVAL_COMMAND_EXPAND_CHAR_THRESHOLD
      || reviewCommand.includes('\n')),
  );

  // Each review interaction re-arms the Catty idle window (capped by hard
  // deadline). Do not one-shot cancel — subsequent focus/scroll/key events
  // must keep extending idle while the user is still deciding.
  const markReviewing = useCallback(() => {
    if (!isPendingApproval || !approvalId) return;
    cancelApprovalTimeout(approvalId);
  }, [approvalId, isPendingApproval]);

  const handleApproveOnce = useCallback(() => {
    if (!isPendingApproval) return;
    setResponded(true);
    (onApproveOnce ?? onApprove)?.();
  }, [isPendingApproval, onApproveOnce, onApprove]);

  const handleAlwaysAllow = useCallback(() => {
    if (!isPendingApproval) return;
    setResponded(true);
    (onAlwaysAllow ?? onApprove)?.();
  }, [isPendingApproval, onAlwaysAllow, onApprove]);

  const handleReject = useCallback(() => {
    if (!isPendingApproval) return;
    setResponded(true);
    onReject?.();
  }, [isPendingApproval, onReject]);

  const handleCopyCommand = useCallback(async () => {
    if (!reviewCommand) return;
    markReviewing();
    const ok = await copyTextToClipboard(reviewCommand);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [markReviewing, reviewCommand]);

  // Keyboard: Enter = approve, Escape = reject (when pending).
  // Ignore Enter from nested controls (Copy / Expand / action buttons) so it
  // activates that control instead of approving the pending command.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isPendingApproval) return;
    if (e.key === 'Enter') {
      if (isNestedInteractiveApprovalTarget(e.target as HTMLElement | null, e.currentTarget)) {
        return;
      }
      e.preventDefault();
      handleApproveOnce();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleReject();
    } else {
      // Typing / navigation while reviewing cancels the idle auto-deny timer.
      markReviewing();
    }
  }, [isPendingApproval, handleApproveOnce, handleReject, markReviewing]);

  // Auto-focus and auto-scroll when approval is pending.
  // Do not treat this programmatic expand/focus as user review (timeout stays armed).
  useEffect(() => {
    if (!isPendingApproval || !cardRef.current) return;
    cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    setExpanded(true);
    const focusTimer = setTimeout(() => approveBtnRef.current?.focus(), 100);
    return () => clearTimeout(focusTimer);
  }, [isPendingApproval]);

  // Freeze the reviewable command for the life of this pending approval.
  // Do not reset review/timeout state when args identity churns while still pending.
  useEffect(() => {
    if (approvalStatus === 'pending') {
      setResponded(false);
      setCommandExpanded(false);
      setFrozenCommand(extractDisplayCommand(args));
      return;
    }
    setFrozenCommand(null);
    setCommandExpanded(false);
    // Intentionally depend only on approvalStatus so late arg patches cannot
    // replace the command the user is already reviewing.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freeze on pending enter
  }, [approvalStatus]);

  // If the first pending paint had no command yet, accept the first non-empty one.
  useEffect(() => {
    if (!isPendingApproval || frozenCommand) return;
    const next = extractDisplayCommand(args);
    if (next) setFrozenCommand(next);
  }, [args, frozenCommand, isPendingApproval]);

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

  const headerCommand = reviewCommand ?? liveDisplayCommand;

  return (
    <div
      ref={cardRef}
      tabIndex={isPendingApproval ? 0 : undefined}
      onKeyDown={isPendingApproval ? handleKeyDown : undefined}
      onPointerDownCapture={isPendingApproval ? markReviewing : undefined}
      className={cn('min-w-0 rounded-md border overflow-hidden text-[12px] outline-none', borderClass, className)}
      {...props}
    >
      <button
        type="button"
        onClick={() => {
          if (isPendingApproval) markReviewing();
          setExpanded((e) => !e);
        }}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 transition-colors cursor-pointer"
      >
        {expanded
          ? <ChevronDown size={12} className="text-muted-foreground/40 shrink-0" />
          : <ChevronRight size={12} className="text-muted-foreground/40 shrink-0" />
        }
        {headerCommand ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-muted-foreground/70 truncate cursor-default">
                <span className="text-muted-foreground/40">$ </span>{headerCommand}
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              collisionPadding={12}
              className="w-[calc(100vw-24px)] max-w-[420px] whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]"
            >
              {truncateToolCommandTooltip(headerCommand)}
            </TooltipContent>
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

      {isPendingApproval && approvalTarget && (
        <div className="border-t border-border/20 px-3 py-1.5 text-xs font-medium">
          {t('ai.chat.targetLabel')}: {approvalTarget.label}
          {approvalTarget.hostname && approvalTarget.hostname !== approvalTarget.label && (
            <span className="ml-1 text-muted-foreground">({approvalTarget.hostname})</span>
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-border/20">
          {showApprovalCommand && reviewCommand && (
            <div className="px-3 py-2 space-y-1.5">
              {executionContext && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/45">
                  <span className="font-medium uppercase tracking-wider text-muted-foreground/30">
                    {t('ai.chat.targetLabel')}
                  </span>
                  {executionContext.sessionId && (
                    <span className="font-mono truncate" title={executionContext.sessionId}>
                      {t('ai.chat.approvalSession')}: {executionContext.sessionId}
                    </span>
                  )}
                  {executionContext.shell && (
                    <span className="font-mono">
                      {t('ai.chat.approvalShell')}: {executionContext.shell}
                    </span>
                  )}
                  {executionContext.cwd && (
                    <span className="font-mono truncate" title={executionContext.cwd}>
                      {t('ai.chat.approvalCwd')}: {executionContext.cwd}
                    </span>
                  )}
                  {executionContext.reason && (
                    <span className="truncate" title={executionContext.reason}>
                      {t('ai.chat.approvalReason')}: {executionContext.reason}
                    </span>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30">
                  {t('ai.chat.rawCommand')}
                </div>
                <div className="flex items-center gap-1">
                  {commandNeedsExpand && (
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground px-1.5 py-0.5 rounded hover:bg-muted/30"
                      onClick={() => {
                        markReviewing();
                        setCommandExpanded((v) => !v);
                      }}
                      onKeyDown={(e) => {
                        // Keep Enter on this control; let Escape bubble to card reject.
                        if (e.key === 'Enter') e.stopPropagation();
                      }}
                    >
                      {commandExpanded ? t('ai.chat.collapse') : t('ai.chat.expand')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground px-1.5 py-0.5 rounded hover:bg-muted/30"
                    onClick={() => { void handleCopyCommand(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.stopPropagation();
                    }}
                  >
                    <Copy size={10} className="shrink-0" />
                    {copied ? t('ai.chat.commandCopied') : t('ai.chat.copyCommand')}
                  </button>
                </div>
              </div>
              <pre
                className={cn(
                  'overflow-auto rounded-md border border-border/25 bg-muted/20 px-2.5 py-2',
                  'text-[11px] font-mono leading-relaxed text-foreground/80',
                  'whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
                )}
                style={{
                  maxHeight: commandExpanded
                    ? APPROVAL_COMMAND_EXPANDED_MAX_HEIGHT_PX
                    : APPROVAL_COMMAND_COLLAPSED_MAX_HEIGHT_PX,
                }}
                onScroll={markReviewing}
                onWheel={markReviewing}
              >
                {reviewCommand}
              </pre>
            </div>
          )}

          {args && Object.keys(args).length > 0 && (!showApprovalCommand || showArgsAlongsideCommand) && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/30 mb-1">
                {showArgsAlongsideCommand ? t('ai.chat.approvalInvocation') : 'Arguments'}
              </div>
              {/*
                Args-only approvals (Codex file-change/permissions, write tools with
                JSON args) have no command pre — wheel/trackpad scroll must re-arm
                idle the same way the command overflow block does.
              */}
              <pre
                className="max-h-64 overflow-auto text-[11px] font-mono text-muted-foreground/50 whitespace-pre [overflow-wrap:normal]"
                onScroll={isPendingApproval ? markReviewing : undefined}
                onWheel={isPendingApproval ? markReviewing : undefined}
              >
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {/* Inline approval buttons */}
          {isPendingApproval && (
            <div className="min-w-0 px-3 py-2 border-t border-border/20">
              <p className="mb-2 text-[10px] leading-snug text-muted-foreground/40">
                {t('ai.chat.toolApprovalHint')}
              </p>
              <div className="flex w-full min-w-0 items-stretch gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 min-w-0 flex-1 gap-1 px-1.5 text-[11px] font-normal border-red-500/25 text-red-400/90 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/40"
                  onClick={handleReject}
                >
                  <X size={12} className="shrink-0" />
                  <span className="truncate">{t('ai.chat.reject')}</span>
                </Button>
                <Button
                  ref={approveBtnRef}
                  variant="outline"
                  size="sm"
                  className="h-7 min-w-0 flex-1 gap-1 px-1.5 text-[11px] font-normal border-green-500/25 text-green-400/90 hover:bg-green-500/10 hover:text-green-400 hover:border-green-500/40"
                  onClick={handleApproveOnce}
                >
                  <Check size={12} className="shrink-0" />
                  <span className="truncate">{t('ai.chat.approveOnce')}</span>
                </Button>
                {onAlwaysAllow && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 min-w-0 flex-1 gap-1 px-1.5 text-[11px] font-normal border-green-500/35 text-green-300/95 hover:bg-green-500/10 hover:text-green-300 hover:border-green-500/50"
                    onClick={handleAlwaysAllow}
                  >
                    <Check size={12} className="shrink-0" />
                    <span className="truncate">{alwaysAllowLabel || t('ai.chat.alwaysAllow')}</span>
                  </Button>
                )}
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
