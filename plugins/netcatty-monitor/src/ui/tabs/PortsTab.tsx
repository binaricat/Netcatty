import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PluginDataGrid, type PluginDataGridColumn } from '@netcatty/plugin-sdk/host-react';
import { formatCompactCount } from '../../domain/formatting';
import type { I18nKey } from '../../domain/i18n';
import type { MonitorHostRef, PortRow, SocketSummary, SystemAuditSnapshot } from '../../domain/types';
import type { MonitorHostBridge } from '../../services/hostBridge';
import type { MonitorEngine } from '../../services/monitorEngine';

export interface PortsTabProps {
  host: MonitorHostRef;
  engine: MonitorEngine;
  bridge: MonitorHostBridge;
  t: (key: I18nKey) => string;
}

export default function PortsTab({ host, engine, bridge, t }: PortsTabProps) {
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [summary, setSummary] = useState<SocketSummary>({
    total: 0,
    established: 0,
    listen: 0,
    synRecv: 0,
    timeWait: 0,
    closeWait: 0,
    other: 0,
  });
  const [audit, setAudit] = useState<SystemAuditSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [portsData, auditData] = await Promise.all([
        engine.fetchPorts(host),
        engine.fetchSystemAudit(host).catch(() => null),
      ]);
      setPorts(portsData.ports);
      setSummary(portsData.summary);
      setAudit(auditData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [engine, host]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ports;
    return ports.filter(
      (p) =>
        p.protocol.includes(q) ||
        p.localAddress.toLowerCase().includes(q) ||
        String(p.port ?? '').includes(q) ||
        p.process.toLowerCase().includes(q),
    );
  }, [ports, query]);

  const columns = useMemo<PluginDataGridColumn[]>(
    () => [
      { name: 'protocol', type: 'text', width: 84, sortable: true },
      { name: 'state', type: 'text', width: 96, sortable: true },
      { name: 'port', type: 'number', width: 88, sortable: true },
      { name: 'localAddress', type: 'text', width: 200 },
      { name: 'peerAddress', type: 'text', width: 160 },
      { name: 'process', type: 'text', width: 170, sortable: true },
      { name: 'pid', type: 'number', width: 84, sortable: true },
    ],
    [],
  );

  const handleCopyDiag = () => {
    const lines = [
      `Host: ${host.label} (${host.hostname ?? ''})`,
      `Sockets: total=${summary.total} listen=${summary.listen} established=${summary.established} syn_recv=${summary.synRecv} time_wait=${summary.timeWait} close_wait=${summary.closeWait}`,
      ...(audit?.fdUsed != null && audit?.fdMax != null ? [`Open FDs: ${audit.fdUsed} / ${audit.fdMax}`] : []),
      ...(audit?.failedAuthCount != null ? [`Failed SSH Auth (24h): ${audit.failedAuthCount}`] : []),
      `Listening Ports (${ports.length}):`,
      ...ports.slice(0, 30).map((p) => `  ${p.protocol} ${p.localAddress}:${p.port ?? '*'} ${p.process || ''}`),
    ];
    void bridge.copyText(lines.join('\n'), `Copy Network & Audit Diagnostics (${host.label})`);
  };

  return (
    <div className="nm-content-flush">
      <div className="nm-kpi-strip" style={{ padding: '0 0 10px', borderBottom: 'none' }}>
        <div className="nm-kpi-card">
          <span className="nm-kpi-label">{t('socketsTotal')}</span>
          <span className="nm-kpi-value nm-mono">{summary.total}</span>
        </div>
        <div className="nm-kpi-card">
          <span className="nm-kpi-label">{t('socketsListen')}</span>
          <span className="nm-kpi-value nm-mono" style={{ color: 'var(--plugin-ok)' }}>
            {summary.listen}
          </span>
        </div>
        <div className="nm-kpi-card">
          <span className="nm-kpi-label">{t('socketsEstablished')}</span>
          <span className="nm-kpi-value nm-mono" style={{ color: 'var(--plugin-sky)' }}>
            {summary.established}
          </span>
        </div>
        <div className="nm-kpi-card">
          <span className="nm-kpi-label">{t('socketsSynRecv')}</span>
          <span className="nm-kpi-value nm-mono" style={{ color: summary.synRecv > 50 ? 'var(--plugin-warn)' : undefined }}>
            {summary.synRecv}
          </span>
        </div>
        <div className="nm-kpi-card">
          <span className="nm-kpi-label">{t('socketsTimeWait')}</span>
          <span className="nm-kpi-value nm-mono">{summary.timeWait}</span>
        </div>
        <div className="nm-kpi-card">
          <span className="nm-kpi-label">{t('socketsCloseWait')}</span>
          <span className="nm-kpi-value nm-mono" style={{ color: summary.closeWait > 0 ? 'var(--plugin-warn)' : undefined }}>
            {summary.closeWait}
          </span>
        </div>
      </div>

      <div className="nm-toolbar" style={{ padding: '0 0 8px', borderBottom: 'none' }}>
        <input
          type="search"
          className="nm-input nm-search"
          placeholder={t('searchPorts')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="nm-toolbar-group">
          <button type="button" className="nm-btn" onClick={handleCopyDiag}>
            {t('copyDiagnostics')}
          </button>
          <button type="button" className="nm-btn" onClick={() => void load()} disabled={loading}>
            {t('refreshNow')}
          </button>
        </div>
      </div>

      {error && (
        <div className="nm-inline-banner" style={{ borderColor: 'var(--plugin-crit)' }}>
          <span>{error}</span>
        </div>
      )}

      <div className="nm-grid-wrap">
        <PluginDataGrid
          columns={columns}
          rows={filtered.map((p) => ({
            protocol: p.protocol,
            state: p.state,
            port: p.port ?? '--',
            localAddress: p.localAddress,
            peerAddress: p.peerAddress,
            process: p.process || '--',
            pid: p.pid ?? '--',
          }))}
          loading={loading && ports.length === 0}
          emptyMessage={t('loadingData')}
        />
      </div>

      {/* System & Security Audit Panel */}
      {audit && (
        <div className="nm-audit-grid">
          <section className="nm-panel-card">
            <div className="nm-panel-card-head">
              <h3 className="nm-panel-card-title">{t('auditTitle')}</h3>
              {audit.rebootRequired && <span className="nm-badge nm-badge-warn">{t('rebootPending')}</span>}
            </div>
            <div className="nm-micro-grid nm-mono">
              <div className="nm-micro-pill">
                <span className="nm-micro-label">{t('openFds')}</span>
                <span className="nm-micro-val">
                  {audit.fdUsed != null && audit.fdMax != null
                    ? `${formatCompactCount(audit.fdUsed)} / ${formatCompactCount(audit.fdMax)}`
                    : '--'}
                </span>
              </div>
              <div className="nm-micro-pill">
                <span className="nm-micro-label">{t('activeUsersLabel')}</span>
                <span className="nm-micro-val">{audit.loggedInUsers.length}</span>
              </div>
              <div className="nm-micro-pill">
                <span className="nm-micro-label">{t('failedAuth24h')}</span>
                <span
                  className="nm-micro-val"
                  style={{ color: (audit.failedAuthCount ?? 0) >= 20 ? 'var(--plugin-warn)' : undefined }}
                >
                  {audit.failedAuthCount ?? '--'}
                </span>
              </div>
            </div>
          </section>

          <section className="nm-panel-card">
            <h3 className="nm-panel-card-title">{t('recentLogins')}</h3>
            <ul className="nm-audit-list nm-mono">
              {audit.recentLogins.length === 0 ? (
                <li>--</li>
              ) : (
                audit.recentLogins.map((line, i) => <li key={i}>{line}</li>)
              )}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
