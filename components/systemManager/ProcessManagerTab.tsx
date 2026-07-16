import {
  Gauge, LayoutList, Loader2, Pause, Play, Skull, XCircle,
} from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { VariableSizeVirtualList } from '../ui/VariableSizeVirtualList';
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
  SystemPanelStatusBadge,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type SortKey = 'cpuPercent' | 'memPercent' | 'pid' | 'command' | 'user';
type ProcessFilter = 'all' | 'running';
type ProcessSignal = 'STOP' | 'CONT' | 'TERM' | 'KILL';

interface PendingProcessSignal {
  pid: number;
  signal: ProcessSignal;
}

function processSignalTitleKey(signal: ProcessSignal): string {
  switch (signal) {
    case 'STOP': return 'systemManager.processes.stop';
    case 'CONT': return 'systemManager.processes.cont';
    case 'TERM': return 'systemManager.processes.term';
    case 'KILL': return 'systemManager.processes.kill';
  }
}

const PROCESS_CACHE_TTL_MS = 30_000;
const PROCESS_ROW_HEIGHT = 56;
const PROCESS_DETAIL_HEIGHT = 112;
const PROCESS_OVERSCAN_ROWS = 8;

const processListCache = new Map<string, {
  processes: SystemProcessInfo[];
  updatedAt: number;
}>();

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

function getCachedProcesses(sessionId: string): SystemProcessInfo[] | null {
  const cached = processListCache.get(sessionId);
  if (!cached) return null;
  if (Date.now() - cached.updatedAt > PROCESS_CACHE_TTL_MS) {
    processListCache.delete(sessionId);
    return null;
  }
  return cached.processes;
}

const ProcessListLoading = memo(function ProcessListLoading({
  message,
}: {
  message: string;
}) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center px-4 py-10 text-center text-xs text-muted-foreground">
      <Loader2 size={18} className="mb-2 animate-spin opacity-70" />
      <span>{message}</span>
    </div>
  );
});

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

  const actions = (
    <div className="flex w-[112px] shrink-0 items-center justify-end gap-1">
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
  );

  return (
    <div className="h-full overflow-hidden">
      <SystemPanelRow
        selected={selected}
        onClick={() => onToggle(proc.pid)}
        title={proc.command}
        subtitle={`${proc.user || '—'} · PID ${proc.pid}`}
        className="h-14"
        trailing={(
          <div className="flex w-[88px] shrink-0 items-center justify-end">
            <SystemPanelStatusBadge tone={getProcessTone(proc)}>
              {t(getProcessStatusLabelKey(proc))}
            </SystemPanelStatusBadge>
          </div>
        )}
        actions={actions}
      />
      {selected && (
        <SystemPanelDetailStrip className="h-28 overflow-hidden">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-muted-foreground mb-2">
            <span className="min-w-0 truncate">{t('systemManager.processes.ppid')}: {proc.ppid}</span>
            <span className="min-w-0 truncate">{t('systemManager.processes.stat')}: {proc.stat}</span>
            <span className="min-w-0 truncate">{t('systemManager.processes.elapsed')}: {proc.elapsed || '—'}</span>
            <span className="min-w-0 truncate">{t('systemManager.processes.rss')}: {formatKb(proc.rssKb)}</span>
            <span className="col-span-2 min-w-0 truncate">{t('systemManager.processes.vsz')}: {formatKb(proc.vszKb)}</span>
          </div>
          <div className="space-y-1">
            <ResourceBar label="CPU" value={proc.cpuPercent} />
            <ResourceBar label="MEM" value={proc.memPercent} />
          </div>
        </SystemPanelDetailStrip>
      )}
    </div>
  );
});

interface ProcessVirtualListProps {
  processes: SystemProcessInfo[];
  selectedPid: number | null;
  onToggle: (pid: number) => void;
  onSignal: (pid: number, signal: string) => void;
  onRenice: (pid: number) => void;
}

const ProcessVirtualList = memo(function ProcessVirtualList({
  processes,
  selectedPid,
  onToggle,
  onSignal,
  onRenice,
}: ProcessVirtualListProps) {
  const getItemHeight = useCallback(
    (proc: SystemProcessInfo) => (
      proc.pid === selectedPid
        ? PROCESS_ROW_HEIGHT + PROCESS_DETAIL_HEIGHT
        : PROCESS_ROW_HEIGHT
    ),
    [selectedPid],
  );

  const renderItem = useCallback((proc: SystemProcessInfo) => (
    <ProcessRow
      proc={proc}
      selected={selectedPid === proc.pid}
      onToggle={onToggle}
      onSignal={onSignal}
      onRenice={onRenice}
    />
  ), [onRenice, onSignal, onToggle, selectedPid]);

  return (
    <VariableSizeVirtualList<SystemProcessInfo>
      items={processes}
      getItemHeight={getItemHeight}
      className="flex-1 min-h-0"
      overscan={PROCESS_OVERSCAN_ROWS}
      getItemKey={(proc) => String(proc.pid)}
      renderItem={renderItem}
    />
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
  const [pendingSignal, setPendingSignal] = useState<PendingProcessSignal | null>(null);
  const [signalBusy, setSignalBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cachedProcesses, setCachedProcesses] = useState<SystemProcessInfo[] | null>(() => getCachedProcesses(sessionId));
  const [cachedProcessesSessionId, setCachedProcessesSessionId] = useState(sessionId);
  const [processListPending, setProcessListPending] = useState(false);
  const processFetchGenerationRef = useRef(0);
  const currentSessionIdRef = useRef(sessionId);

  if (currentSessionIdRef.current !== sessionId) {
    currentSessionIdRef.current = sessionId;
    processFetchGenerationRef.current += 1;
  }

  useEffect(() => {
    processFetchGenerationRef.current += 1;
    setCachedProcesses(getCachedProcesses(sessionId));
    setCachedProcessesSessionId(sessionId);
    setProcessListPending(false);
    // Drop in-flight dialogs so a confirm cannot act on a different host/session.
    setPendingSignal(null);
    setSignalBusy(false);
    setReniceTarget(null);
    setSelectedPid(null);
    setActionError(null);
  }, [sessionId]);

  useEffect(() => () => {
    processFetchGenerationRef.current += 1;
  }, []);

  const fetcher = useCallback(async () => {
    const fetchGeneration = processFetchGenerationRef.current;
    const fetchSessionId = sessionId;
    const isCurrentFetch = () => (
      processFetchGenerationRef.current === fetchGeneration
      && currentSessionIdRef.current === fetchSessionId
    );
    try {
      const result = await backend.listSystemProcesses(sessionId);
      if (!isCurrentFetch()) return null;
      if (result.pending) {
        setProcessListPending(true);
        return null;
      }
      setProcessListPending(false);
      if (!result.success || !result.processes) {
        throw new Error(result.error || stableT('systemManager.errors.loadProcesses'));
      }
      return result.processes;
    } catch (err) {
      if (!isCurrentFetch()) return null;
      setProcessListPending(false);
      throw err;
    }
  }, [backend, sessionId, stableT]);

  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const { data: processes, error, loading, refresh } = usePolling<SystemProcessInfo[]>(
    fetcher,
    intervalMs,
    isVisible,
    mergeProcesses,
    { resetKey: sessionId },
  );

  useEffect(() => {
    if (!processes) return;
    processListCache.set(sessionId, { processes, updatedAt: Date.now() });
    setCachedProcesses(processes);
    setCachedProcessesSessionId(sessionId);
  }, [processes, sessionId]);

  const sessionCachedProcesses = cachedProcessesSessionId === sessionId
    ? cachedProcesses
    : getCachedProcesses(sessionId);
  const visibleProcesses = processes ?? sessionCachedProcesses;
  const showingCachedProcesses = processes === null && sessionCachedProcesses !== null;

  const matched = useMemo<SystemProcessInfo[]>(() => {
    const list = visibleProcesses ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (filter === 'running' && !isProcessRunning(p.stat)) return false;
      if (!q) return true;
      return String(p.pid).includes(q)
        || String(p.ppid).includes(q)
        || p.user.toLowerCase().includes(q)
        || p.command.toLowerCase().includes(q);
    });
  }, [visibleProcesses, query, filter]);

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
  const displayList = useStableListOrder<SystemProcessInfo, number>(
    matched,
    (p) => p.pid,
    sortToken,
    compareProcesses,
  );
  const isProcessRefreshActive = loading || processListPending;
  const showInitialLoading = isProcessRefreshActive && displayList.length === 0;
  const showBlockingError = Boolean(error && !isProcessRefreshActive && displayList.length === 0);
  const showInlineRefreshError = Boolean(error && !isProcessRefreshActive && displayList.length > 0);

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

  const requestSignal = useCallback((pid: number, signal: string) => {
    if (signal !== 'STOP' && signal !== 'CONT' && signal !== 'TERM' && signal !== 'KILL') return;
    setPendingSignal({ pid, signal });
  }, []);

  const executeSignal = useCallback(async (pid: number, signal: ProcessSignal) => {
    setSignalBusy(true);
    setActionError(null);
    try {
      const result = await backend.signalSystemProcess({ sessionId, pid, signal });
      if (!result.success) {
        setActionError(result.error || t('systemManager.errors.actionFailed'));
        return;
      }
      void refresh();
    } finally {
      setSignalBusy(false);
    }
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
            loading={isProcessRefreshActive}
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
        <span className={cn(showingCachedProcesses && isProcessRefreshActive && 'inline-flex items-center gap-1.5')}>
          {showingCachedProcesses && isProcessRefreshActive && <Loader2 size={10} className="animate-spin" />}
          {t('systemManager.processes.meta', { count: String(displayList.length) })}
        </span>
      </SystemPanelMetaBar>

      {actionError && <SystemPanelInlineError message={actionError} />}
      {showInlineRefreshError && error && <SystemPanelInlineError message={error} />}

      {(showBlockingError || showInitialLoading || (!error && displayList.length === 0 && !loading && !showInitialLoading)) ? (
        <SystemPanelList>
          {showBlockingError && error && (
            <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
          )}
          {showInitialLoading && (
            <ProcessListLoading message={t('systemManager.processes.loading')} />
          )}
          {!error && displayList.length === 0 && !loading && !showInitialLoading && (
            <SystemPanelEmpty icon={LayoutList} message={t('systemManager.empty')} />
          )}
        </SystemPanelList>
      ) : (
        <ProcessVirtualList
          processes={displayList}
          selectedPid={selectedPid}
          onToggle={togglePid}
          onSignal={requestSignal}
          onRenice={openRenicePrompt}
        />
      )}

      <SystemPanelConfirmDialog
        open={pendingSignal !== null}
        title={pendingSignal ? t(processSignalTitleKey(pendingSignal.signal)) : ''}
        message={pendingSignal
          ? t(
            pendingSignal.signal === 'KILL'
              ? 'systemManager.processes.confirmKill'
              : 'systemManager.processes.confirmSignal',
            { pid: String(pendingSignal.pid), signal: pendingSignal.signal },
          )
          : ''}
        confirmLabel={pendingSignal ? t(processSignalTitleKey(pendingSignal.signal)) : ''}
        destructive={pendingSignal?.signal === 'KILL' || pendingSignal?.signal === 'TERM'}
        busy={signalBusy}
        onOpenChange={(open) => {
          if (!open && !signalBusy) setPendingSignal(null);
        }}
        onConfirm={() => {
          const target = pendingSignal;
          if (!target) return;
          setPendingSignal(null);
          void executeSignal(target.pid, target.signal);
        }}
      />

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
