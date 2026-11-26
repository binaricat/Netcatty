import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  History,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  clearRemoteDesktopAuditEntries,
  exportRemoteDesktopAuditJson,
  listRemoteDesktopAuditEntries,
  subscribeRemoteDesktopAuditLog,
  type RemoteDesktopAuditEntry,
  type RemoteDesktopAuditOutcome,
} from '../../infrastructure/remoteDesktop/remoteDesktopAuditLog';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { tr } from './remoteDesktopHelpers';

export interface RemoteDesktopAuditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional remote desktop session ID to filter by default. */
  sessionId?: string;
  /** Optional host display name shown in the dialog subtitle. */
  hostLabel?: string;
}

type OutcomeFilter = 'all' | 'ok' | 'preempted' | 'issues';

function formatAuditTimestamp(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (sameDay) return time;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function outcomeBadgeClass(outcome: RemoteDesktopAuditOutcome): string {
  switch (outcome) {
    case 'ok':
      return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400';
    case 'preempted':
      return 'border-amber-500/35 bg-amber-500/12 text-amber-600 dark:text-amber-400';
    case 'blocked':
    case 'denied':
      return 'border-orange-500/35 bg-orange-500/12 text-orange-600 dark:text-orange-400';
    case 'error':
    default:
      return 'border-red-500/35 bg-red-500/12 text-red-600 dark:text-red-400';
  }
}

export const RemoteDesktopAuditDialog: React.FC<RemoteDesktopAuditDialogProps> = React.memo(({
  open,
  onOpenChange,
  sessionId,
  hostLabel,
}) => {
  const { t, resolvedLocale } = useI18n();
  const isZh = resolvedLocale.toLowerCase().startsWith('zh');

  const [scopeAll, setScopeAll] = useState<boolean>(!sessionId);
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [entries, setEntries] = useState<RemoteDesktopAuditEntry[]>([]);

  useEffect(() => {
    setScopeAll(!sessionId);
  }, [sessionId]);

  const effectiveSessionId = scopeAll ? undefined : sessionId;

  const refreshEntries = useCallback(() => {
    setEntries(listRemoteDesktopAuditEntries(effectiveSessionId));
  }, [effectiveSessionId]);

  useEffect(() => {
    if (!open) return;
    refreshEntries();
    return subscribeRemoteDesktopAuditLog(refreshEntries);
  }, [open, refreshEntries]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (outcomeFilter === 'ok' && entry.outcome !== 'ok') return false;
      if (outcomeFilter === 'preempted' && entry.outcome !== 'preempted') return false;
      if (
        outcomeFilter === 'issues'
        && entry.outcome !== 'error'
        && entry.outcome !== 'blocked'
        && entry.outcome !== 'denied'
      ) {
        return false;
      }
      if (!q) return true;
      return (
        entry.summary.toLowerCase().includes(q)
        || (entry.hostLabel?.toLowerCase().includes(q) ?? false)
        || (entry.hostname?.toLowerCase().includes(q) ?? false)
        || (entry.errorCode?.toLowerCase().includes(q) ?? false)
        || (entry.error?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [entries, outcomeFilter, query]);

  const handleCopyJson = useCallback(async () => {
    const json = exportRemoteDesktopAuditJson(effectiveSessionId);
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard permission errors in headless environments
    }
  }, [effectiveSessionId]);

  const handleClear = useCallback(() => {
    clearRemoteDesktopAuditEntries(effectiveSessionId);
    refreshEntries();
  }, [effectiveSessionId, refreshEntries]);

  const formatOutcomeLabel = (outcome: RemoteDesktopAuditOutcome): string => {
    switch (outcome) {
      case 'ok':
        return tr(t, 'remoteDesktop.ai.audit.outcomeOk', isZh ? '成功' : 'OK');
      case 'preempted':
        return tr(t, 'remoteDesktop.ai.audit.outcomePreempted', isZh ? '已接管' : 'Preempted');
      case 'blocked':
        return tr(t, 'remoteDesktop.ai.audit.outcomeBlocked', isZh ? '已拦截' : 'Blocked');
      case 'denied':
        return tr(t, 'remoteDesktop.ai.audit.outcomeDenied', isZh ? '已拒绝' : 'Denied');
      case 'error':
      default:
        return tr(t, 'remoteDesktop.ai.audit.outcomeError', isZh ? '失败' : 'Error');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <History size={17} className="text-primary" />
            <span>
              {tr(
                t,
                'remoteDesktop.ai.audit.title',
                isZh ? 'AI 桌面操控审计日志' : 'AI Computer Use Audit Log',
              )}
            </span>
          </DialogTitle>
          <DialogDescription>
            {hostLabel && !scopeAll
              ? tr(
                  t,
                  'remoteDesktop.ai.audit.subtitleHost',
                  isZh
                    ? `记录此远程桌面 (${hostLabel}) 上执行的 AI 鼠标与键盘操作。`
                    : `Mouse and keyboard actions executed by AI on ${hostLabel}.`,
                )
              : tr(
                  t,
                  'remoteDesktop.ai.audit.subtitleAll',
                  isZh
                    ? '本地记录最近 500 条 AI 远程桌面操控记录（敏感文本已脱敏）。'
                    : 'Local ring buffer of the latest 500 AI remote desktop actions (sensitive text redacted).',
                )}
          </DialogDescription>
        </DialogHeader>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr(
                t,
                'remoteDesktop.ai.audit.searchPlaceholder',
                isZh ? '按操作、主机或错误码筛选...' : 'Filter by action, host, or error code...',
              )}
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {sessionId && (
            <div className="inline-flex rounded-md border border-border/70 bg-muted/40 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setScopeAll(false)}
                className={cn(
                  'rounded px-2 py-1 transition-colors cursor-pointer',
                  !scopeAll
                    ? 'bg-background font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tr(t, 'remoteDesktop.ai.audit.scopeSession', isZh ? '当前会话' : 'This session')}
              </button>
              <button
                type="button"
                onClick={() => setScopeAll(true)}
                className={cn(
                  'rounded px-2 py-1 transition-colors cursor-pointer',
                  scopeAll
                    ? 'bg-background font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tr(t, 'remoteDesktop.ai.audit.scopeAll', isZh ? '全部' : 'All')}
              </button>
            </div>
          )}

          <div className="inline-flex rounded-md border border-border/70 bg-muted/40 p-0.5 text-[11px]">
            {(
              [
                ['all', tr(t, 'remoteDesktop.ai.audit.filterAll', isZh ? '全部' : 'All')],
                ['ok', tr(t, 'remoteDesktop.ai.audit.filterOk', isZh ? '成功' : 'OK')],
                ['preempted', tr(t, 'remoteDesktop.ai.audit.filterPreempted', isZh ? '接管' : 'Preempted')],
                ['issues', tr(t, 'remoteDesktop.ai.audit.filterIssues', isZh ? '拦截/错误' : 'Blocked/Err')],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setOutcomeFilter(value)}
                className={cn(
                  'rounded px-2 py-1 transition-colors cursor-pointer',
                  outcomeFilter === value
                    ? 'bg-background font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Entries list */}
        <div
          data-testid="remote-desktop-audit-list"
          className="max-h-[380px] min-h-[160px] overflow-y-auto rounded-lg border border-border/70 bg-muted/20 divide-y divide-border/50"
        >
          {filteredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center text-xs text-muted-foreground">
              <History size={20} className="opacity-40" />
              <span>
                {tr(
                  t,
                  'remoteDesktop.ai.audit.empty',
                  isZh ? '暂无 AI 远程桌面操控记录。' : 'No AI remote desktop actions recorded yet.',
                )}
              </span>
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <div key={entry.id} className="px-3.5 py-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        'inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4',
                        outcomeBadgeClass(entry.outcome),
                      )}
                    >
                      {formatOutcomeLabel(entry.outcome)}
                    </span>
                    {entry.protocol && (
                      <span className="inline-flex items-center rounded border border-border/70 bg-background px-1.5 py-0 font-mono text-[10px] uppercase leading-4 text-muted-foreground">
                        {entry.protocol}
                      </span>
                    )}
                    {entry.hostLabel && (
                      <span className="font-medium text-foreground">{entry.hostLabel}</span>
                    )}
                    {entry.highRiskChords && entry.highRiskChords.length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/12 px-1.5 py-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        <ShieldAlert size={10} />
                        {entry.highRiskChords.join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                    <span>
                      {entry.completedActions}/{entry.actionCount}
                    </span>
                    {typeof entry.durationMs === 'number' && <span>{entry.durationMs}ms</span>}
                    <span>{formatAuditTimestamp(entry.timestamp)}</span>
                  </div>
                </div>

                <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-foreground/90">
                  {entry.summary}
                </p>

                {(entry.error || entry.errorCode) && (
                  <div className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">
                      {entry.errorCode ? `[${entry.errorCode}] ` : ''}
                      {entry.error ?? ''}
                    </span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyJson}
              disabled={entries.length === 0}
              className="gap-1.5"
            >
              {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
              <span>
                {copied
                  ? tr(t, 'remoteDesktop.ai.audit.copied', isZh ? '已复制' : 'Copied')
                  : tr(t, 'remoteDesktop.ai.audit.copyJson', isZh ? '复制 JSON' : 'Copy JSON')}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClear}
              disabled={entries.length === 0}
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <Trash2 size={13} />
              <span>{tr(t, 'remoteDesktop.ai.audit.clear', isZh ? '清空' : 'Clear')}</span>
            </Button>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {tr(t, 'common.close', isZh ? '关闭' : 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export default RemoteDesktopAuditDialog;
