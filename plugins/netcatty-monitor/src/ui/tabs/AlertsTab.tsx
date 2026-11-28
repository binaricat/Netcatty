import React, { useState } from 'react';
import { DEFAULT_ALERT_THRESHOLDS } from '../../domain/alerts';
import { formatRelativeAge } from '../../domain/formatting';
import type { I18nKey, MonitorLocale } from '../../domain/i18n';
import type { AlertEvent, AlertThresholds } from '../../domain/types';

export interface AlertsTabProps {
  alerts: AlertEvent[];
  thresholds: AlertThresholds;
  hostFilterId?: string | null;
  locale: MonitorLocale;
  t: (key: I18nKey) => string;
  onSaveThresholds: (next: AlertThresholds) => void;
  onAckAlert: (id: string) => void;
  onAckAll: () => void;
  onClearResolved: () => void;
}

export default function AlertsTab({
  alerts,
  thresholds,
  hostFilterId,
  locale,
  t,
  onSaveThresholds,
  onAckAlert,
  onAckAll,
  onClearResolved,
}: AlertsTabProps) {
  const [draft, setDraft] = useState<AlertThresholds>(thresholds);
  const visibleAlerts = hostFilterId ? alerts.filter((a) => a.hostId === hostFilterId) : alerts;

  const setNum = (key: keyof AlertThresholds, raw: string) => {
    const val = Number(raw);
    if (!Number.isFinite(val)) return;
    setDraft((prev) => ({ ...prev, [key]: val }));
  };

  return (
    <div className="nm-content">
      {/* Incident Timeline */}
      <section className="nm-panel-card" style={{ marginBottom: 14 }}>
        <div className="nm-panel-card-head">
          <h3 className="nm-panel-card-title">
            {t('incidentTimeline')} ({visibleAlerts.filter((a) => !a.resolvedAt).length})
          </h3>
          <div className="nm-toolbar-group">
            <button type="button" className="nm-btn nm-btn-sm" onClick={onAckAll}>
              {t('acknowledgeAll')}
            </button>
            <button type="button" className="nm-btn nm-btn-sm" onClick={onClearResolved}>
              {t('clearResolved')}
            </button>
          </div>
        </div>

        {visibleAlerts.length === 0 ? (
          <p className="nm-panel-card-sub">{t('noAlerts')}</p>
        ) : (
          <div className="nm-disk-list">
            {visibleAlerts.map((ev) => (
              <div
                key={ev.id}
                className={`nm-alert-row ${ev.severity === 'critical' ? 'nm-alert-crit' : 'nm-alert-warn'} ${ev.resolvedAt ? 'nm-alert-resolved' : ''}`}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      className={`nm-badge ${
                        ev.severity === 'critical'
                          ? 'nm-badge-crit'
                          : ev.severity === 'info'
                            ? 'nm-badge-info'
                            : 'nm-badge-warn'
                      }`}
                    >
                      {ev.severity.toUpperCase()}
                    </span>
                    <strong>{ev.message}</strong>
                    {ev.resolvedAt && <span className="nm-badge nm-badge-ok">RESOLVED</span>}
                  </div>
                  <div className="nm-panel-card-sub nm-mono">
                    {formatRelativeAge(ev.at, Date.now(), locale)}
                    {ev.threshold != null ? ` · threshold ${ev.threshold}` : ''}
                  </div>
                </div>
                {!ev.acknowledged && !ev.resolvedAt && (
                  <button type="button" className="nm-btn nm-btn-sm" onClick={() => onAckAlert(ev.id)}>
                    {t('acknowledge')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Threshold & Hysteresis Configuration */}
      <section className="nm-panel-card">
        <div className="nm-panel-card-head">
          <h3 className="nm-panel-card-title">{t('alertRulesTitle')}</h3>
          <div className="nm-toolbar-group">
            <button
              type="button"
              className="nm-btn nm-btn-sm"
              onClick={() => {
                setDraft({ ...DEFAULT_ALERT_THRESHOLDS });
                onSaveThresholds({ ...DEFAULT_ALERT_THRESHOLDS });
              }}
            >
              {t('resetDefaults')}
            </button>
            <button type="button" className="nm-btn nm-btn-sm nm-btn-primary" onClick={() => onSaveThresholds(draft)}>
              {t('saveThresholds')}
            </button>
          </div>
        </div>

        <div className="nm-threshold-grid">
          <div className="nm-threshold-item">
            <strong>{t('metricCpu')} (%)</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.cpuWarning} onChange={(e) => setNum('cpuWarning', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.cpuCritical} onChange={(e) => setNum('cpuCritical', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('thresholdIowait')}</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" className="nm-input" min={5} max={100} value={draft.iowaitWarning} onChange={(e) => setNum('iowaitWarning', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.iowaitCritical} onChange={(e) => setNum('iowaitCritical', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('metricMemory')} (%)</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.memoryWarning} onChange={(e) => setNum('memoryWarning', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.memoryCritical} onChange={(e) => setNum('memoryCritical', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('metricDisk')} (%)</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.diskWarning} onChange={(e) => setNum('diskWarning', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.diskCritical} onChange={(e) => setNum('diskCritical', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('thresholdInode')}</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.inodeWarning} onChange={(e) => setNum('inodeWarning', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" className="nm-input" min={10} max={100} value={draft.inodeCritical} onChange={(e) => setNum('inodeCritical', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('metricLoad')} (× cores)</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" step="0.1" className="nm-input" min={0.2} max={20} value={draft.loadPerCoreWarning} onChange={(e) => setNum('loadPerCoreWarning', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" step="0.1" className="nm-input" min={0.5} max={40} value={draft.loadPerCoreCritical} onChange={(e) => setNum('loadPerCoreCritical', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('thresholdNetDrops')}</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" className="nm-input" min={1} max={100000} value={draft.netDropsWarning} onChange={(e) => setNum('netDropsWarning', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" className="nm-input" min={5} max={1000000} value={draft.netDropsCritical} onChange={(e) => setNum('netDropsCritical', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('metricLatency')} (ms)</strong>
            <div className="nm-threshold-inputs">
              <label className="nm-field-label">
                <span>{t('thresholdWarn')}</span>
                <input type="number" className="nm-input" min={20} max={5000} value={draft.latencyWarningMs} onChange={(e) => setNum('latencyWarningMs', e.target.value)} />
              </label>
              <label className="nm-field-label">
                <span>{t('thresholdCrit')}</span>
                <input type="number" className="nm-input" min={50} max={10000} value={draft.latencyCriticalMs} onChange={(e) => setNum('latencyCriticalMs', e.target.value)} />
              </label>
            </div>
          </div>

          <div className="nm-threshold-item">
            <strong>{t('thresholdConsecutive')}</strong>
            <label className="nm-field-label">
              <span>1–10</span>
              <input type="number" className="nm-input" min={1} max={10} value={draft.consecutivePolls} onChange={(e) => setNum('consecutivePolls', e.target.value)} />
            </label>
          </div>
        </div>

        <label className="nm-checkbox-row" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={draft.alertOnOffline}
            onChange={(e) => setDraft((prev) => ({ ...prev, alertOnOffline: e.target.checked }))}
          />
          <span>{t('thresholdOffline')}</span>
        </label>
      </section>
    </div>
  );
}
