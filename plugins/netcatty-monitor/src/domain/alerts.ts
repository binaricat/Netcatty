import { formatMemoryPercent } from './formatting';
import type {
  AlertEvent,
  AlertMetric,
  AlertSeverity,
  AlertThresholds,
  HealthSummary,
  HostRuntimeState,
} from './types';

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  cpuWarning: 80,
  cpuCritical: 95,
  iowaitWarning: 20,
  iowaitCritical: 40,
  memoryWarning: 85,
  memoryCritical: 95,
  swapWarning: 60,
  swapCritical: 85,
  diskWarning: 80,
  diskCritical: 92,
  inodeWarning: 80,
  inodeCritical: 95,
  loadPerCoreWarning: 1.5,
  loadPerCoreCritical: 3.0,
  netDropsWarning: 10,
  netDropsCritical: 100,
  latencyWarningMs: 180,
  latencyCriticalMs: 400,
  consecutivePolls: 2,
  alertOnOffline: true,
};

export function normalizeAlertThresholds(raw: unknown): AlertThresholds {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ALERT_THRESHOLDS };
  const r = raw as Record<string, unknown>;
  const num = (key: keyof AlertThresholds, min: number, max: number) => {
    const val = Number(r[key]);
    const fallback = DEFAULT_ALERT_THRESHOLDS[key] as number;
    return Number.isFinite(val) ? Math.max(min, Math.min(max, val)) : fallback;
  };
  return {
    cpuWarning: num('cpuWarning', 10, 100),
    cpuCritical: num('cpuCritical', 10, 100),
    iowaitWarning: num('iowaitWarning', 5, 100),
    iowaitCritical: num('iowaitCritical', 10, 100),
    memoryWarning: num('memoryWarning', 10, 100),
    memoryCritical: num('memoryCritical', 10, 100),
    swapWarning: num('swapWarning', 10, 100),
    swapCritical: num('swapCritical', 10, 100),
    diskWarning: num('diskWarning', 10, 100),
    diskCritical: num('diskCritical', 10, 100),
    inodeWarning: num('inodeWarning', 10, 100),
    inodeCritical: num('inodeCritical', 10, 100),
    loadPerCoreWarning: num('loadPerCoreWarning', 0.2, 20),
    loadPerCoreCritical: num('loadPerCoreCritical', 0.5, 40),
    netDropsWarning: num('netDropsWarning', 1, 100_000),
    netDropsCritical: num('netDropsCritical', 5, 1_000_000),
    latencyWarningMs: num('latencyWarningMs', 20, 5000),
    latencyCriticalMs: num('latencyCriticalMs', 50, 10000),
    consecutivePolls: Math.round(num('consecutivePolls', 1, 10)),
    alertOnOffline: typeof r.alertOnOffline === 'boolean' ? r.alertOnOffline : DEFAULT_ALERT_THRESHOLDS.alertOnOffline,
  };
}

export interface EvaluatedViolation {
  metric: AlertMetric;
  severity: AlertSeverity;
  value: number | null;
  threshold: number | null;
  label: string;
}

export function evaluateHostHealth(
  state: HostRuntimeState | undefined,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): { health: HealthSummary; violations: EvaluatedViolation[] } {
  if (!state || state.status === 'idle' || state.status === 'queued' || state.status === 'connecting') {
    return {
      health: { score: 100, level: 'pending', badges: [] },
      violations: [],
    };
  }
  if (state.status === 'offline' || state.status === 'error' || state.status === 'disconnected' || state.status === 'login') {
    const violations: EvaluatedViolation[] = thresholds.alertOnOffline
      ? [{ metric: 'offline', severity: 'critical', value: null, threshold: null, label: state.status.toUpperCase() }]
      : [];
    return {
      health: {
        score: 0,
        level: 'offline',
        badges: violations.map((v) => ({ metric: v.metric, severity: v.severity, label: v.label })),
      },
      violations,
    };
  }
  if (state.mode === 'probe' && state.probe) {
    const violations: EvaluatedViolation[] = [];
    let penalty = 0;
    const rtt = state.probe.rttMs;
    if (rtt != null && Number.isFinite(rtt)) {
      if (rtt >= thresholds.latencyCriticalMs) {
        violations.push({ metric: 'latencyMs', severity: 'critical', value: rtt, threshold: thresholds.latencyCriticalMs, label: `${Math.round(rtt)}ms` });
        penalty += 30;
      } else if (rtt >= thresholds.latencyWarningMs) {
        violations.push({ metric: 'latencyMs', severity: 'warning', value: rtt, threshold: thresholds.latencyWarningMs, label: `${Math.round(rtt)}ms` });
        penalty += 14;
      }
    }
    const score = Math.max(0, Math.min(100, 100 - penalty));
    const level: HealthSummary['level'] = violations.some((v) => v.severity === 'critical')
      ? 'critical'
      : violations.some((v) => v.severity === 'warning')
        ? 'warning'
        : 'healthy';
    return {
      health: {
        score,
        level,
        badges: violations.map((v) => ({ metric: v.metric, severity: v.severity, label: v.label })),
      },
      violations,
    };
  }
  if (!state.stats) {
    return {
      health: { score: 100, level: 'pending', badges: [] },
      violations: [],
    };
  }

  const stats = state.stats;
  const violations: EvaluatedViolation[] = [];
  let penalty = 0;

  const checkUpper = (
    metric: AlertMetric,
    value: number | null | undefined,
    warn: number,
    crit: number,
    format: (v: number) => string,
  ) => {
    if (value == null || !Number.isFinite(value)) return;
    if (value >= crit) {
      violations.push({ metric, severity: 'critical', value, threshold: crit, label: format(value) });
      penalty += 30;
    } else if (value >= warn) {
      violations.push({ metric, severity: 'warning', value, threshold: warn, label: format(value) });
      penalty += 14;
    }
  };

  checkUpper('cpu', stats.cpu, thresholds.cpuWarning, thresholds.cpuCritical, (v) => `CPU ${Math.round(v)}%`);
  checkUpper('cpuIowait', stats.cpuIowait, thresholds.iowaitWarning, thresholds.iowaitCritical, (v) => `IOWAIT ${v.toFixed(1)}%`);

  const memPct = formatMemoryPercent(stats.memUsed, stats.memTotal);
  checkUpper('memory', memPct, thresholds.memoryWarning, thresholds.memoryCritical, (v) => `MEM ${Math.round(v)}%`);

  const swapPct = formatMemoryPercent(stats.swapUsed, stats.swapTotal);
  checkUpper('swap', swapPct, thresholds.swapWarning, thresholds.swapCritical, (v) => `SWAP ${Math.round(v)}%`);

  const maxDiskPct = stats.disks.reduce<number | null>(
    (acc, d) => (typeof d.percent === 'number' && Number.isFinite(d.percent) ? (acc == null ? d.percent : Math.max(acc, d.percent)) : acc),
    stats.diskPercent,
  );
  checkUpper('disk', maxDiskPct, thresholds.diskWarning, thresholds.diskCritical, (v) => `DISK ${Math.round(v)}%`);

  const maxInodePct = stats.disks.reduce<number | null>(
    (acc, d) =>
      typeof d.inodePercent === 'number' && Number.isFinite(d.inodePercent)
        ? acc == null
          ? d.inodePercent
          : Math.max(acc, d.inodePercent)
        : acc,
    null,
  );
  checkUpper('inode', maxInodePct, thresholds.inodeWarning, thresholds.inodeCritical, (v) => `INODE ${Math.round(v)}%`);

  if (stats.loadAverage.length > 0 && stats.cpuCores && stats.cpuCores > 0) {
    const loadPerCore = stats.loadAverage[0] / stats.cpuCores;
    checkUpper(
      'loadPerCore',
      loadPerCore,
      thresholds.loadPerCoreWarning,
      thresholds.loadPerCoreCritical,
      (v) => `LOAD ${v.toFixed(2)}x`,
    );
  }

  if (stats.networkReady && typeof stats.netDropsDelta === 'number' && stats.netDropsDelta > 0) {
    checkUpper(
      'netDrops',
      stats.netDropsDelta,
      thresholds.netDropsWarning,
      thresholds.netDropsCritical,
      (v) => `DROPS +${Math.round(v)}`,
    );
  }

  const latency = stats.latencyMs ?? stats.responseLatencyMs;
  checkUpper(
    'latencyMs',
    latency,
    thresholds.latencyWarningMs,
    thresholds.latencyCriticalMs,
    (v) => `${Math.round(v)}ms`,
  );

  const score = Math.max(0, Math.min(100, 100 - penalty));
  const hasCritical = violations.some((v) => v.severity === 'critical');
  const hasWarning = violations.some((v) => v.severity === 'warning');
  const level: HealthSummary['level'] = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

  return {
    health: {
      score,
      level,
      badges: violations.map((v) => ({ metric: v.metric, severity: v.severity, label: v.label })),
    },
    violations,
  };
}

/**
 * Hysteresis filter: prevents alert flapping by requiring `consecutivePolls` consecutive
 * breaches for a (hostId, metric) pair before emitting an alert into the incident feed.
 */
export function applyAlertHysteresis(
  streaks: Map<string, number>,
  hostId: string,
  violations: readonly EvaluatedViolation[],
  consecutivePolls: number,
  options: { immediateMetrics?: ReadonlySet<AlertMetric> } = {},
): EvaluatedViolation[] {
  const required = Math.max(1, Math.round(consecutivePolls || 1));
  const activeMetrics = new Set(violations.map((v) => v.metric));
  const prefix = `${hostId}:`;
  for (const key of [...streaks.keys()]) {
    if (key.startsWith(prefix)) {
      const metric = key.slice(prefix.length) as AlertMetric;
      if (!activeMetrics.has(metric)) streaks.delete(key);
    }
  }
  const confirmed: EvaluatedViolation[] = [];
  for (const v of violations) {
    const key = `${prefix}${v.metric}`;
    const count = (streaks.get(key) ?? 0) + 1;
    streaks.set(key, count);
    if (count >= required || options.immediateMetrics?.has(v.metric)) {
      confirmed.push(v);
    }
  }
  return confirmed;
}

export function mergeAlertFeed(
  existing: readonly AlertEvent[],
  hostId: string,
  hostLabel: string,
  violations: readonly EvaluatedViolation[],
  now = Date.now(),
  maxEvents = 200,
): AlertEvent[] {
  const next = existing.map((ev) => ({ ...ev }));
  const activeMetrics = new Set(violations.map((v) => v.metric));

  for (const ev of next) {
    if (ev.hostId === hostId && !ev.resolvedAt && !activeMetrics.has(ev.metric)) {
      ev.resolvedAt = now;
    }
  }

  for (const v of violations) {
    const open = next.find((ev) => ev.hostId === hostId && ev.metric === v.metric && !ev.resolvedAt);
    if (open) {
      if (open.severity !== v.severity) {
        open.severity = v.severity;
        open.acknowledged = false;
      }
      open.value = v.value;
      open.threshold = v.threshold;
      open.message = `${hostLabel}: ${v.label}`;
      open.at = now;
    } else {
      next.unshift({
        id: `${hostId}:${v.metric}:${now}`,
        hostId,
        hostLabel,
        metric: v.metric,
        severity: v.severity,
        value: v.value,
        threshold: v.threshold,
        message: `${hostLabel}: ${v.label}`,
        startedAt: now,
        at: now,
        acknowledged: false,
        resolvedAt: null,
      });
    }
  }

  return next.slice(0, maxEvents);
}

export interface AlertSidebarBadge {
  count: number;
  tone: 'warning' | 'danger';
  tooltip: string;
}

export function computeAlertBadge(
  alerts: readonly AlertEvent[],
  locale: 'en' | 'zh-CN' = 'en',
): AlertSidebarBadge | null {
  const active = alerts.filter((a) => !a.resolvedAt && !a.acknowledged);
  if (active.length === 0) return null;

  const count = Math.min(999, active.length);
  const criticalCount = active.filter((a) => a.severity === 'critical').length;
  const tone: 'warning' | 'danger' = criticalCount > 0 ? 'danger' : 'warning';
  const topMsg = (active[0]?.message ?? '').replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();

  const summary =
    locale === 'zh-CN'
      ? criticalCount > 0
        ? `${count} 条告警（${criticalCount} 条严重）${topMsg ? `：${topMsg}` : ''}`
        : `${count} 条告警${topMsg ? `：${topMsg}` : ''}`
      : criticalCount > 0
        ? `${count} active alert${count === 1 ? '' : 's'} (${criticalCount} critical)${topMsg ? `: ${topMsg}` : ''}`
        : `${count} active alert${count === 1 ? '' : 's'}${topMsg ? `: ${topMsg}` : ''}`;

  return {
    count,
    tone,
    tooltip: summary.slice(0, 160),
  };
}
