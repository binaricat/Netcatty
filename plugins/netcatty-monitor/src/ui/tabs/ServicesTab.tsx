import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PluginDataGrid, type PluginDataGridColumn } from '@netcatty/plugin-sdk/host-react';
import type { SafeContainerAction, SafeServiceAction } from '../../domain/collectors';
import type { I18nKey } from '../../domain/i18n';
import type { ContainerRow, MonitorHostRef, SystemdServiceRow } from '../../domain/types';
import type { MonitorHostBridge } from '../../services/hostBridge';
import type { MonitorEngine } from '../../services/monitorEngine';

export interface ServicesTabProps {
  host: MonitorHostRef;
  engine: MonitorEngine;
  bridge: MonitorHostBridge;
  t: (key: I18nKey) => string;
}

type PendingOp =
  | { kind: 'service'; unit: string; action: SafeServiceAction }
  | { kind: 'container'; runtime: 'docker' | 'podman'; id: string; name: string; action: SafeContainerAction };

export default function ServicesTab({ host, engine, bridge, t }: ServicesTabProps) {
  const [services, setServices] = useState<SystemdServiceRow[]>([]);
  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [subMode, setSubMode] = useState<'services' | 'containers'>('services');
  const [stateFilter, setStateFilter] = useState<'all' | 'active' | 'failed'>('all');
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [logTitle, setLogTitle] = useState<string | null>(null);
  const [logText, setLogText] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  const [pendingOp, setPendingOp] = useState<PendingOp | null>(null);
  const [opBusy, setOpBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await engine.fetchServicesAndContainers(host);
      setServices(data.services);
      setContainers(data.containers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [engine, host]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredServices = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services.filter((s) => {
      if (stateFilter === 'active' && s.activeState !== 'active') return false;
      if (stateFilter === 'failed' && s.activeState !== 'failed') return false;
      if (!q) return true;
      return s.unit.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [services, stateFilter, query]);

  const filteredContainers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return containers.filter((c) => {
      if (stateFilter === 'active' && c.state !== 'running') return false;
      if (stateFilter === 'failed' && c.state === 'running') return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    });
  }, [containers, stateFilter, query]);

  const serviceColumns = useMemo<PluginDataGridColumn[]>(
    () => [
      { name: 'unit', type: 'text', width: 230, sortable: true },
      { name: 'active', type: 'text', width: 95, sortable: true },
      { name: 'sub', type: 'text', width: 95 },
      { name: 'load', type: 'text', width: 88 },
      { name: 'description', type: 'text', width: 340 },
    ],
    [],
  );

  const containerColumns = useMemo<PluginDataGridColumn[]>(
    () => [
      { name: 'runtime', type: 'text', width: 82 },
      { name: 'name', type: 'text', width: 175, sortable: true },
      { name: 'state', type: 'text', width: 95, sortable: true },
      { name: 'status', type: 'text', width: 165 },
      { name: 'image', type: 'text', width: 220 },
      { name: 'ports', type: 'text', width: 180 },
    ],
    [],
  );

  const openLogs = async (
    target: { kind: 'service'; unit: string } | { kind: 'container'; runtime: 'docker' | 'podman'; id: string; name: string },
  ) => {
    setLogLoading(true);
    setLogTitle(target.kind === 'service' ? target.unit : `${target.runtime}:${target.name}`);
    setLogText(t('logsLoading'));
    try {
      const out =
        target.kind === 'service'
          ? await engine.fetchServiceLogs(host, target.unit, 120)
          : await engine.fetchContainerLogs(host, target.runtime, target.id, 120);
      setLogText(out);
    } catch (err) {
      setLogText(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLoading(false);
    }
  };

  const executeOp = async (op: PendingOp) => {
    setOpBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg =
        op.kind === 'service'
          ? await engine.runServiceAction(host, op.unit, op.action)
          : await engine.runContainerAction(host, op.runtime, op.id, op.action);
      setNotice(msg);
      setPendingOp(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingOp(null);
    } finally {
      setOpBusy(false);
    }
  };

  const requestOp = async (op: PendingOp) => {
    const targetLabel = op.kind === 'service' ? op.unit : `${op.runtime}:${op.name}`;
    const hostConfirmed = await bridge.confirmAction({
      title: t('confirmOpTitle'),
      message: `${op.action.toUpperCase()} ${targetLabel} on ${host.label}?`,
      confirmLabel: op.action.toUpperCase(),
      destructive: op.action === 'stop',
    });
    if (hostConfirmed === true) {
      await executeOp(op);
    } else if (hostConfirmed === null) {
      // Fallback to inline modal when host ui.confirm is not available
      setPendingOp(op);
    }
  };

  const selectedService = subMode === 'services' && selectedIdx != null ? filteredServices[selectedIdx] ?? null : null;
  const selectedContainer = subMode === 'containers' && selectedIdx != null ? filteredContainers[selectedIdx] ?? null : null;

  return (
    <div className="nm-content-flush">
      <div className="nm-toolbar" style={{ padding: '0 0 8px', borderBottom: 'none' }}>
        <div className="nm-toolbar-group">
          <div className="nm-segmented">
            <button
              type="button"
              className={`nm-seg-btn ${subMode === 'services' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => {
                setSubMode('services');
                setSelectedIdx(null);
              }}
            >
              {t('servicesTitle')} ({services.length})
            </button>
            <button
              type="button"
              className={`nm-seg-btn ${subMode === 'containers' ? 'nm-seg-btn-active' : ''}`}
              onClick={() => {
                setSubMode('containers');
                setSelectedIdx(null);
              }}
            >
              {t('containersTitle')} ({containers.length})
            </button>
          </div>
          <input
            type="search"
            className="nm-input nm-search"
            placeholder={t('searchServices')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="nm-select"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as 'all' | 'active' | 'failed')}
          >
            <option value="all">{t('allStates')}</option>
            <option value="active">{t('activeOnly')}</option>
            <option value="failed">{t('failedOnly')}</option>
          </select>
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
      {notice && (
        <div className="nm-inline-banner" style={{ borderColor: 'var(--plugin-ok)' }}>
          <span className="nm-mono">{notice}</span>
        </div>
      )}

      {selectedService && (
        <div className="nm-action-bar">
          <span className="nm-mono">
            <strong>{selectedService.unit}</strong> · {selectedService.activeState}/{selectedService.subState}
          </span>
          <div className="nm-toolbar-group">
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              disabled={opBusy}
              onClick={() => void requestOp({ kind: 'service', unit: selectedService.unit, action: 'start' })}
            >
              {t('actionStart')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              disabled={opBusy}
              onClick={() => void requestOp({ kind: 'service', unit: selectedService.unit, action: 'restart' })}
            >
              {t('actionRestart')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              disabled={opBusy}
              onClick={() => void requestOp({ kind: 'service', unit: selectedService.unit, action: 'reload' })}
            >
              {t('actionReload')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm nm-btn-danger"
              disabled={opBusy}
              onClick={() => void requestOp({ kind: 'service', unit: selectedService.unit, action: 'stop' })}
            >
              {t('actionStop')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm nm-btn-primary"
              onClick={() => void openLogs({ kind: 'service', unit: selectedService.unit })}
            >
              {t('viewLogs')} (journalctl)
            </button>
          </div>
        </div>
      )}

      {selectedContainer && (
        <div className="nm-action-bar">
          <span className="nm-mono">
            <strong>{selectedContainer.name}</strong> ({selectedContainer.id}) · {selectedContainer.state}
          </span>
          <div className="nm-toolbar-group">
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              disabled={opBusy}
              onClick={() =>
                void requestOp({
                  kind: 'container',
                  runtime: selectedContainer.runtime,
                  id: selectedContainer.id,
                  name: selectedContainer.name,
                  action: 'start',
                })
              }
            >
              {t('actionStart')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              disabled={opBusy}
              onClick={() =>
                void requestOp({
                  kind: 'container',
                  runtime: selectedContainer.runtime,
                  id: selectedContainer.id,
                  name: selectedContainer.name,
                  action: 'restart',
                })
              }
            >
              {t('actionRestart')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm nm-btn-danger"
              disabled={opBusy}
              onClick={() =>
                void requestOp({
                  kind: 'container',
                  runtime: selectedContainer.runtime,
                  id: selectedContainer.id,
                  name: selectedContainer.name,
                  action: 'stop',
                })
              }
            >
              {t('actionStop')}
            </button>
            <button
              type="button"
              className="nm-btn nm-btn-sm nm-btn-primary"
              onClick={() =>
                void openLogs({
                  kind: 'container',
                  runtime: selectedContainer.runtime,
                  id: selectedContainer.id,
                  name: selectedContainer.name,
                })
              }
            >
              {t('viewLogs')} ({selectedContainer.runtime} logs)
            </button>
          </div>
        </div>
      )}

      <div className="nm-grid-wrap">
        {subMode === 'services' ? (
          <PluginDataGrid
            columns={serviceColumns}
            rows={filteredServices.map((s) => ({
              unit: s.unit,
              active: s.activeState,
              sub: s.subState,
              load: s.loadState,
              description: s.description,
            }))}
            loading={loading && services.length === 0}
            onCellSelect={({ rowIndex }) => setSelectedIdx(rowIndex)}
            onCellDoubleClick={({ rowIndex }) => {
              const svc = filteredServices[rowIndex];
              if (svc) void openLogs({ kind: 'service', unit: svc.unit });
            }}
            emptyMessage={t('noServices')}
          />
        ) : (
          <PluginDataGrid
            columns={containerColumns}
            rows={filteredContainers.map((c) => ({
              runtime: c.runtime,
              name: c.name,
              state: c.state,
              status: c.status,
              image: c.image,
              ports: c.ports || '--',
            }))}
            loading={loading && containers.length === 0}
            onCellSelect={({ rowIndex }) => setSelectedIdx(rowIndex)}
            onCellDoubleClick={({ rowIndex }) => {
              const ctr = filteredContainers[rowIndex];
              if (ctr) {
                void openLogs({ kind: 'container', runtime: ctr.runtime, id: ctr.id, name: ctr.name });
              }
            }}
            emptyMessage={t('noContainers')}
          />
        )}
      </div>

      {logTitle && (
        <div className="nm-log-panel">
          <div className="nm-log-head">
            <span className="nm-mono">{logTitle}</span>
            <div className="nm-toolbar-group">
              <button
                type="button"
                className="nm-btn nm-btn-sm"
                disabled={logLoading}
                onClick={() => void bridge.copyText(logText, `Copy Logs (${logTitle})`)}
              >
                {t('copyCommand')}
              </button>
              <button type="button" className="nm-btn nm-btn-sm" onClick={() => setLogTitle(null)}>
                {t('closeLogs')}
              </button>
            </div>
          </div>
          <pre className="nm-log-pre nm-mono">{logText}</pre>
        </div>
      )}

      {pendingOp && (
        <div className="nm-modal-backdrop">
          <div className="nm-modal-card">
            <h3 className="nm-panel-card-title">{t('confirmOpTitle')}</h3>
            <p className="nm-panel-card-sub">
              <strong className="nm-mono">{pendingOp.action.toUpperCase()}</strong>{' '}
              <span className="nm-mono">
                {pendingOp.kind === 'service' ? pendingOp.unit : `${pendingOp.runtime}:${pendingOp.name}`}
              </span>{' '}
              ({host.label})?
            </p>
            <div className="nm-modal-actions">
              <button type="button" className="nm-btn" onClick={() => setPendingOp(null)} disabled={opBusy}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className={`nm-btn ${pendingOp.action === 'stop' ? 'nm-btn-danger' : 'nm-btn-primary'}`}
                onClick={() => void executeOp(pendingOp)}
                disabled={opBusy}
              >
                {pendingOp.action.toUpperCase()}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
