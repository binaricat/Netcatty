import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PluginDataGrid, type PluginDataGridColumn, type PluginDataGridSort } from '@netcatty/plugin-sdk/host-react';
import type { SafeProcessSignal } from '../../domain/collectors';
import { formatRssKb } from '../../domain/formatting';
import type { I18nKey } from '../../domain/i18n';
import type { MonitorHostRef, ProcessRow } from '../../domain/types';
import type { MonitorHostBridge } from '../../services/hostBridge';
import type { MonitorEngine } from '../../services/monitorEngine';

export interface ProcessesTabProps {
  host: MonitorHostRef;
  engine: MonitorEngine;
  bridge: MonitorHostBridge;
  t: (key: I18nKey) => string;
}

type ProcStateFilter = 'all' | 'running' | 'sleeping' | 'zombie';

function matchesProcState(state: string, filter: ProcStateFilter): boolean {
  if (filter === 'all') return true;
  const ch = state.charAt(0).toUpperCase();
  if (filter === 'running') return ch === 'R';
  if (filter === 'sleeping') return ch === 'S' || ch === 'D' || ch === 'I';
  if (filter === 'zombie') return ch === 'Z';
  return true;
}

export default function ProcessesTab({ host, engine, bridge, t }: ProcessesTabProps) {
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<ProcStateFilter>('all');
  const [sort, setSort] = useState<PluginDataGridSort | null>({ column: 'cpu', direction: 'desc' });
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [pendingSignal, setPendingSignal] = useState<{ proc: ProcessRow; signal: SafeProcessSignal } | null>(null);
  const [signalBusy, setSignalBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await engine.fetchProcesses(host);
      setRows(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [engine, host]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 6_000);
    return () => clearInterval(timer);
  }, [load]);

  const topCpu = useMemo(() => [...rows].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5), [rows]);
  const topMem = useMemo(() => [...rows].sort((a, b) => b.memPercent - a.memPercent).slice(0, 5), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (!matchesProcState(r.state, stateFilter)) return false;
      if (!q) return true;
      return (
        String(r.pid).includes(q) ||
        r.user.toLowerCase().includes(q) ||
        r.command.toLowerCase().includes(q)
      );
    });

    if (sort) {
      const dir = sort.direction === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        switch (sort.column) {
          case 'pid': return (a.pid - b.pid) * dir;
          case 'user': return a.user.localeCompare(b.user) * dir;
          case 'cpu': return (a.cpuPercent - b.cpuPercent) * dir;
          case 'mem': return (a.memPercent - b.memPercent) * dir;
          case 'rss': return (a.rssKb - b.rssKb) * dir;
          case 'state': return a.state.localeCompare(b.state) * dir;
          default: return a.command.localeCompare(b.command) * dir;
        }
      });
    }
    return list;
  }, [rows, query, stateFilter, sort]);

  const columns = useMemo<PluginDataGridColumn[]>(
    () => [
      { name: 'pid', type: 'number', width: 78, sortable: true },
      { name: 'user', type: 'text', width: 105, sortable: true },
      { name: 'cpu', type: 'number', width: 78, sortable: true },
      { name: 'mem', type: 'number', width: 78, sortable: true },
      { name: 'rss', type: 'text', width: 92, sortable: true },
      { name: 'state', type: 'text', width: 68, sortable: true },
      { name: 'elapsed', type: 'text', width: 96 },
      { name: 'command', type: 'text', width: 420, sortable: true },
    ],
    [],
  );

  const gridRows = useMemo(
    () =>
      filtered.map((p) => ({
        pid: p.pid,
        user: p.user,
        cpu: `${p.cpuPercent.toFixed(1)}%`,
        mem: `${p.memPercent.toFixed(1)}%`,
        rss: formatRssKb(p.rssKb),
        state: p.state,
        elapsed: p.elapsed,
        command: p.command,
      })),
    [filtered],
  );

  const selectedProc = selectedIdx != null ? filtered[selectedIdx] ?? null : null;

  const confirmSignal = async () => {
    if (!pendingSignal) return;
    setSignalBusy(true);
    try {
      await engine.sendProcessSignal(host, pendingSignal.proc.pid, pendingSignal.signal);
      setPendingSignal(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingSignal(null);
    } finally {
      setSignalBusy(false);
    }
  };

  return (
    <div className="nm-content-flush">
      {/* Top-5 CPU & Memory Quick Summary Strip */}
      {rows.length > 0 && (
        <div className="nm-top-strip">
          <div className="nm-top-box">
            <div className="nm-micro-label">{t('procTopCpu')}</div>
            {topCpu.map((p) => (
              <div key={`cpu-${p.pid}`} className="nm-top-row nm-mono">
                <span className="nm-top-cmd">
                  {p.pid} · {p.command}
                </span>
                <strong>{p.cpuPercent.toFixed(1)}%</strong>
              </div>
            ))}
          </div>
          <div className="nm-top-box">
            <div className="nm-micro-label">{t('procTopMem')}</div>
            {topMem.map((p) => (
              <div key={`mem-${p.pid}`} className="nm-top-row nm-mono">
                <span className="nm-top-cmd">
                  {p.pid} · {p.command}
                </span>
                <strong>
                  {p.memPercent.toFixed(1)}% ({formatRssKb(p.rssKb)})
                </strong>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="nm-toolbar" style={{ padding: '0 0 8px', borderBottom: 'none' }}>
        <div className="nm-toolbar-group">
          <input
            type="search"
            className="nm-input nm-search"
            placeholder={t('searchProcesses')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="nm-segmented">
            {(['all', 'running', 'sleeping', 'zombie'] as const).map((st) => (
              <button
                key={st}
                type="button"
                className={`nm-seg-btn ${stateFilter === st ? 'nm-seg-btn-active' : ''}`}
                onClick={() => setStateFilter(st)}
              >
                {t(
                  st === 'all'
                    ? 'procStateAll'
                    : st === 'running'
                      ? 'procStateRunning'
                      : st === 'sleeping'
                        ? 'procStateSleeping'
                        : 'procStateZombie',
                )}
              </button>
            ))}
          </div>
          <span className="nm-badge nm-mono">{filtered.length}</span>
        </div>
        <button type="button" className="nm-btn" onClick={() => void load()} disabled={loading}>
          {t('refreshNow')}
        </button>
      </div>

      {error && (
        <div className="nm-inline-banner" style={{ borderColor: 'var(--plugin-crit)' }}>
          <span>{error}</span>
        </div>
      )}

      {selectedProc && (
        <div className="nm-action-bar">
          <span className="nm-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '52%' }}>
            PID {selectedProc.pid} ({selectedProc.user}) — {selectedProc.command}
          </span>
          <div className="nm-toolbar-group">
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              onClick={() => void bridge.copyText(selectedProc.command, 'Copy Process Command')}
            >
              {t('copyCommand')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              disabled={selectedProc.pid <= 1}
              onClick={() => setPendingSignal({ proc: selectedProc, signal: 'SIGHUP' })}
            >
              SIGHUP
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              disabled={selectedProc.pid <= 1}
              onClick={() => setPendingSignal({ proc: selectedProc, signal: 'SIGTERM' })}
            >
              {t('processKillTerm')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm nm-btn-danger"
              disabled={selectedProc.pid <= 1}
              onClick={() => setPendingSignal({ proc: selectedProc, signal: 'SIGKILL' })}
            >
              {t('processKillForce')}
            </button>
          </div>
        </div>
      )}

      <div className="nm-grid-wrap">
        <PluginDataGrid
          columns={columns}
          rows={gridRows}
          sort={sort}
          loading={loading && rows.length === 0}
          onSortChange={setSort}
          onCellSelect={({ rowIndex }) => setSelectedIdx(rowIndex)}
          emptyMessage={t('loadingData')}
        />
      </div>

      {pendingSignal && (
        <div className="nm-modal-backdrop">
          <div className="nm-modal-card">
            <h3 className="nm-panel-card-title">{t('processConfirmTitle')}</h3>
            <p className="nm-panel-card-sub">
              {t('processConfirmBody')} <strong className="nm-mono">{pendingSignal.proc.pid}</strong> ({pendingSignal.signal})?
            </p>
            <pre className="nm-log-pre nm-mono" style={{ maxHeight: 90 }}>
              {pendingSignal.proc.command}
            </pre>
            <div className="nm-modal-actions">
              <button type="button" className="nm-btn" onClick={() => setPendingSignal(null)} disabled={signalBusy}>
                {t('processCancel')}
              </button>
              <button type="button" className="nm-btn nm-btn-danger" onClick={() => void confirmSignal()} disabled={signalBusy}>
                {t('processSendSignal')} ({pendingSignal.signal})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
