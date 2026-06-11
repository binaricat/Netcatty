import {
  Gauge, LayoutList, Pause, Play, Skull, XCircle,
} from 'lucide-react';
import React, { memo, useCallback, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import {
  getProcessFlags,
  getProcessStatusLabelKey,
  getProcessTone,
} from '../../domain/systemManager/processState';
import type { SystemProcessInfo } from '../../domain/systemManager/types';
import { systemProcessInfoEqual } from '../../domain/systemManager/pollEquals';
import { cn } from '../../lib/utils';
import { ResourceBar } from './ResourceBar';
import { useStableListOrder, mergePollListByKey } from './listStable';
import {
  SystemPanelDetailStrip,
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelInlineError,
  SystemPanelList,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSearch,
  SystemPanelSegmented,
  SystemPanelShell,
  SystemPanelCollapsible,
  SystemPanelStatusBadge,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type SortKey = 'cpuPercent' | 'memPercent' | 'pid' | 'command' | 'user';
type ProcessFilter = 'all' | 'running';

const SORT_OPTIONS: Array<{ key: SortKey; labelKey: string }> = [
  { key: 'cpuPercent', labelKey: 'systemManager.processes.sort.cpu' },
  { key: 'memPercent', labelKey: 'systemManager.processes.sort.mem' },
  { key: 'pid', labelKey: 'systemManager.processes.sort.pid' },
  { key: 'command', labelKey: 'systemManager.processes.sort.command' },
  { key: 'user', labelKey: 'systemManager.processes.sort.user' },
];

function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

function isProcessRunning(stat: string): boolean {
  return /R/i.test(stat);
}

const mergeProcesses = (
  prev: SystemProcessInfo[] | null,
  next: SystemProcessInfo[],
) => mergePollListByKey(prev, next, (p) => p.pid, systemProcessInfoEqual);

interface ProcessRowProps {
  proc: SystemProcessInfo;
  selected: boolean;
  onToggle: (pid: number) => void;
  onSignal: (pid: number, signal: string) => void;
  onRenice: (pid: number) => void;
}

const ProcessRow = memo(function ProcessRow({
  proc,
  selected,
  onToggle,
  onSignal,
  onRenice,
}: ProcessRowProps) {
  const { t } = useI18n();
  const { isStopped, isZombie } = getProcessFlags(proc);

  return (
    <>
      <SystemPanelRow
        selected={selected}
        onClick={() => onToggle(proc.pid)}
        title={proc.command}
        subtitle={`${proc.user || '—'} · PID ${proc.pid}`}
        trailing={(
          <div className="flex shrink-0 items-center gap-1">
            <SystemPanelStatusBadge tone={getProcessTone(proc)}>
              {t(getProcessStatusLabelKey(proc))}
            </SystemPanelStatusBadge>
            {!isStopped && !isZombie && (
              <SystemPanelRoundButton
                title={t('systemManager.processes.stop')}
                onClick={() => onSignal(proc.pid, 'STOP')}
              >
                <Pause size={12} />
              </SystemPanelRoundButton>
            )}
            {isStopped && !isZombie && (
              <SystemPanelRoundButton
                title={t('systemManager.processes.cont')}
                onClick={() => onSignal(proc.pid, 'CONT')}
              >
                <Play size={12} />
              </SystemPanelRoundButton>
            )}
            <SystemPanelRoundButton
              title={t('systemManager.processes.term')}
              onClick={() => onSignal(proc.pid, 'TERM')}
            >
              <XCircle size={12} />
            </SystemPanelRoundButton>
            <SystemPanelRoundButton
              title={t('systemManager.processes.kill')}
              destructive
              onClick={() => onSignal(proc.pid, 'KILL')}
            >
              <Skull size={12} />
            </SystemPanelRoundButton>
            <SystemPanelRoundButton
              title={t('systemManager.processes.renice')}
              onClick={() => onRenice(proc.pid)}
            >
              <Gauge size={12} />
            </SystemPanelRoundButton>
          </div>
        )}
      />
      <SystemPanelCollapsible open={selected}>
        <SystemPanelDetailStrip>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-muted-foreground mb-2">
            <span>{t('systemManager.processes.ppid')}: {proc.ppid}</span>
            <span>{t('systemManager.processes.stat')}: {proc.stat}</span>
            <span>{t('systemManager.processes.elapsed')}: {proc.elapsed || '—'}</span>
            <span>{t('systemManager.processes.rss')}: {formatKb(proc.rssKb)}</span>
            <span className="col-span-2">{t('systemManager.processes.vsz')}: {formatKb(proc.vszKb)}</span>
          </div>
          <div className="space-y-1">
            <ResourceBar label="CPU" value={proc.cpuPercent} />
            <ResourceBar label="MEM" value={proc.memPercent} />
          </div>
        </SystemPanelDetailStrip>
      </SystemPanelCollapsible>
    </>
  );
});

interface ProcessManagerTabProps {
  sessionId: string;
  isVisible: boolean;
  backend: Backend;
  refreshIntervalSec: number;
}

export const ProcessManagerTab = memo(function ProcessManagerTab({
  sessionId,
  isVisible,
  backend,
  refreshIntervalSec,
}: ProcessManagerTabProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('cpuPercent');
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState<ProcessFilter>('all');
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [reniceTarget, setReniceTarget] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetcher = useCallback(async () => {
    const result = await backend.listSystemProcesses(sessionId);
    if (result.pending) return null;
    if (!result.success || !result.processes) {
      throw new Error(result.error || stableT('systemManager.errors.loadProcesses'));
    }
    return result.processes;
  }, [backend, sessionId, stableT]);

  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const { data: processes, error, loading, refresh } = usePolling<SystemProcessInfo[]>(
    fetcher,
    intervalMs,
    isVisible,
    mergeProcesses,
  );

  const matched = useMemo(() => {
    const list = processes ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (filter === 'running' && !isProcessRunning(p.stat)) return false;
      if (!q) return true;
      return String(p.pid).includes(q)
        || String(p.ppid).includes(q)
        || p.user.toLowerCase().includes(q)
        || p.command.toLowerCase().includes(q);
    });
  }, [processes, query, filter]);

  const compareProcesses = useCallback((a: SystemProcessInfo, b: SystemProcessInfo) => {
    let cmp = 0;
    if (sortKey === 'command' || sortKey === 'user') {
      cmp = a[sortKey].localeCompare(b[sortKey]);
    } else {
      const av = a[sortKey];
      const bv = b[sortKey];
      cmp = Number(av) < Number(bv) ? -1 : Number(av) > Number(bv) ? 1 : 0;
    }
    const primary = sortAsc ? cmp : -cmp;
    if (primary !== 0) return primary;
    return a.pid - b.pid;
  }, [sortAsc, sortKey]);

  const sortToken = `${sortKey}|${sortAsc}|${filter}|${query}`;
  const displayList = useStableListOrder(matched, (p) => p.pid, sortToken, compareProcesses);

  const cycleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === 'command' || key === 'user');
    }
  };

  const togglePid = useCallback((pid: number) => {
    setSelectedPid((cur) => (cur === pid ? null : pid));
  }, []);

  const signalProcess = useCallback(async (pid: number, signal: string) => {
    const confirmKey = signal === 'KILL'
      ? 'systemManager.processes.confirmKill'
      : 'systemManager.processes.confirmSignal';
    const ok = window.confirm(t(confirmKey, { pid: String(pid), signal }));
    if (!ok) return;
    setActionError(null);
    const result = await backend.signalSystemProcess({ sessionId, pid, signal });
    if (!result.success) {
      setActionError(result.error || t('systemManager.errors.actionFailed'));
      return;
    }
    void refresh();
  }, [backend, refresh, sessionId, t]);

  const reniceProcess = useCallback(async (pid: number, nice: number) => {
    setActionError(null);
    const result = await backend.signalSystemProcess({ sessionId, pid, nice });
    if (!result.success) {
      setActionError(result.error || t('systemManager.errors.actionFailed'));
      return;
    }
    void refresh();
  }, [backend, refresh, sessionId, t]);

  const openRenicePrompt = useCallback((pid: number) => {
    setReniceTarget(pid);
  }, []);

  return (
    <SystemPanelShell section="system-manager-processes">
      <SystemPanelToolbar
        trailing={(
          <SystemPanelRefreshButton
            title={t('history.action.refresh')}
            loading={loading}
            onClick={() => void refresh()}
          />
        )}
      >
        <SystemPanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t('systemManager.processes.search')}
        />
      </SystemPanelToolbar>

      <SystemPanelSegmented
        value={filter}
        options={[
          { id: 'all', label: t('systemManager.processes.filter.all') },
          { id: 'running', label: t('systemManager.processes.filter.running') },
        ]}
        onChange={setFilter}
      />

      <SystemPanelMetaBar trailing={(
        <div className="flex shrink-0 items-center gap-0.5">
          {SORT_OPTIONS.map(({ key, labelKey }) => (
            <button
              key={key}
              type="button"
              onClick={() => cycleSort(key)}
              className={cn(
                'shrink-0 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                sortKey === key
                  ? 'text-foreground bg-muted/60'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(labelKey)}{sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </button>
          ))}
        </div>
      )}>
        {t('systemManager.processes.meta', { count: String(displayList.length) })}
      </SystemPanelMetaBar>

      {actionError && <SystemPanelInlineError message={actionError} />}

      <SystemPanelList>
        {error && (
          <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
        )}
        {!error && displayList.length === 0 && !loading && (
          <SystemPanelEmpty icon={LayoutList} message={t('systemManager.empty')} />
        )}
        {displayList.map((proc) => (
          <ProcessRow
            key={proc.pid}
            proc={proc}
            selected={selectedPid === proc.pid}
            onToggle={togglePid}
            onSignal={signalProcess}
            onRenice={openRenicePrompt}
          />
        ))}
      </SystemPanelList>

      <SystemPanelPromptDialog
        open={reniceTarget !== null}
        title={t('systemManager.processes.renice')}
        fields={[{
          id: 'nice',
          label: t('systemManager.processes.renicePrompt'),
          initialValue: '0',
          mono: true,
        }]}
        confirmLabel={t('systemManager.processes.renice')}
        validate={(values) => {
          const nice = Number(values.nice);
          if (!Number.isFinite(nice) || nice < -20 || nice > 19) {
            return t('systemManager.processes.reniceInvalid');
          }
          return null;
        }}
        onOpenChange={(open) => { if (!open) setReniceTarget(null); }}
        onSubmit={(values) => {
          const pid = reniceTarget;
          setReniceTarget(null);
          if (pid === null) return;
          void reniceProcess(pid, Number(values.nice));
        }}
      />
    </SystemPanelShell>
  );
});
