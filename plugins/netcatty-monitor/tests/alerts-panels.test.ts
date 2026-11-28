import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAlertHysteresis,
  computeAlertBadge,
  DEFAULT_ALERT_THRESHOLDS,
  evaluateHostHealth,
  mergeAlertFeed,
} from '../src/domain/alerts.js';
import {
  normalizeMonitorPanels,
  normalizeVisibleWidgets,
  rebaseMonitorPanel,
  reorderMonitorHosts,
} from '../src/domain/panels.js';
import type { HostRuntimeState } from '../src/domain/types.js';

function makeLiveState(overrides: Partial<NonNullable<HostRuntimeState['stats']>> = {}): HostRuntimeState {
  return {
    hostId: 'hb_1',
    status: 'live',
    updatedAt: 1000,
    points: [],
    stats: {
      osFamily: 'linux',
      cpu: 25,
      cpuCores: 4,
      cpuPerCore: [25, 25, 25, 25],
      gpu: null,
      gpuName: null,
      gpuMemUsed: null,
      gpuMemTotal: null,
      gpus: [],
      thermals: [],
      memTotal: 16384,
      memUsed: 4096,
      memFree: 8192,
      memBuffers: 1024,
      memCached: 3072,
      swapTotal: 2048,
      swapUsed: 0,
      topProcesses: [],
      diskPercent: 42,
      diskUsed: 42,
      diskTotal: 100,
      disks: [{ mountPoint: '/', percent: 42, used: 42, total: 100 }],
      diskReadSpeed: null,
      diskWriteSpeed: null,
      networkReady: true,
      netRxSpeed: 1000,
      netTxSpeed: 500,
      latencyMs: 25,
      responseLatencyMs: 30,
      netInterfaces: [],
      hostname: 'web-01',
      osName: 'Ubuntu 24.04',
      kernelRelease: '6.8.0',
      uptimeSeconds: 7200,
      loadAverage: [0.5, 0.4, 0.3],
      ...overrides,
    },
  };
}

test('evaluateHostHealth computes health score and violations across metrics', () => {
  const healthy = evaluateHostHealth(makeLiveState(), DEFAULT_ALERT_THRESHOLDS);
  assert.equal(healthy.health.level, 'healthy');
  assert.equal(healthy.health.score, 100);
  assert.equal(healthy.violations.length, 0);

  const degraded = evaluateHostHealth(
    makeLiveState({ cpu: 97, memUsed: 14500, latencyMs: 250 }),
    DEFAULT_ALERT_THRESHOLDS,
  );
  assert.equal(degraded.health.level, 'critical');
  assert.ok(degraded.health.score < 60);
  assert.equal(degraded.violations.some((v) => v.metric === 'cpu' && v.severity === 'critical'), true);
  assert.equal(degraded.violations.some((v) => v.metric === 'memory' && v.severity === 'warning'), true);
  assert.equal(degraded.violations.some((v) => v.metric === 'latencyMs' && v.severity === 'warning'), true);
});

test('mergeAlertFeed deduplicates active alerts and auto-resolves cleared metrics', () => {
  const { violations } = evaluateHostHealth(makeLiveState({ cpu: 96 }), DEFAULT_ALERT_THRESHOLDS);
  let feed = mergeAlertFeed([], 'hb_1', 'web-01', violations, 10_000);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].resolvedAt, null);

  // Repeating violation updates in-place instead of duplicating
  feed = mergeAlertFeed(feed, 'hb_1', 'web-01', violations, 15_000);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].at, 15_000);

  // Clearing violation marks alert resolved
  feed = mergeAlertFeed(feed, 'hb_1', 'web-01', [], 20_000);
  assert.equal(feed[0].resolvedAt, 20_000);
});

test('computeAlertBadge tracks warning/critical tones, ack/resolve clearing, clamping, and EN/zh-CN tooltips', () => {
  assert.equal(computeAlertBadge([]), null);

  const warnAlert = {
    id: 'a1',
    hostId: 'hb_1',
    hostLabel: 'web-01',
    metric: 'cpu' as const,
    severity: 'warning' as const,
    value: 84,
    threshold: 80,
    message: 'web-01: CPU 84%\nline2',
    at: 1000,
    acknowledged: false,
    resolvedAt: null,
  };
  const warnBadge = computeAlertBadge([warnAlert], 'en');
  assert.deepEqual(warnBadge, {
    count: 1,
    tone: 'warning',
    tooltip: '1 active alert: web-01: CPU 84% line2',
  });

  const critAlert = {
    ...warnAlert,
    id: 'a2',
    metric: 'memory' as const,
    severity: 'critical' as const,
    message: 'web-01: MEM 97%',
  };
  const critBadgeEn = computeAlertBadge([critAlert, warnAlert], 'en');
  assert.equal(critBadgeEn?.count, 2);
  assert.equal(critBadgeEn?.tone, 'danger');
  assert.match(critBadgeEn?.tooltip ?? '', /2 active alerts \(1 critical\)/);

  const critBadgeZh = computeAlertBadge([critAlert, warnAlert], 'zh-CN');
  assert.equal(critBadgeZh?.count, 2);
  assert.equal(critBadgeZh?.tone, 'danger');
  assert.match(critBadgeZh?.tooltip ?? '', /2 条告警（1 条严重）/);

  // Acknowledged or resolved alerts do not contribute to the sidebar badge
  assert.equal(
    computeAlertBadge([
      { ...warnAlert, acknowledged: true },
      { ...critAlert, resolvedAt: 2000 },
    ]),
    null,
  );
});

test('panel normalization, dedupe, reorder, and rebase preserve Netcatty parity', () => {
  const normalized = normalizeMonitorPanels([
    { id: 'b', name: 'Production', hostIds: ['h1', 'h1', 'h2'], interval: 5, range: 15, view: 'charts' },
    { id: 'a', name: 'Production', hostIds: ['h3'], interval: 99, range: 999 },
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].name, 'Production (2)');
  assert.deepEqual(normalized[0].hostIds, ['h1', 'h2']);
  assert.equal(normalized[1].name, 'Production');
  assert.equal(normalized[1].interval, 5);
  assert.equal(normalized[1].range, 30);

  assert.deepEqual(reorderMonitorHosts(['h1', 'h2', 'h3'], 'h3', 'h1'), ['h3', 'h1', 'h2']);

  const updated = rebaseMonitorPanel(normalized, normalized[0], {
    ...normalized[0],
    description: 'Updated',
  });
  assert.equal(updated[0].description, 'Updated');

  // Commercial view modes (wallboard, compare) and 1m/60m ranges
  const commercial = normalizeMonitorPanels([
    { id: 'noc', name: 'NOC', hostIds: ['h1', 'h2'], view: 'wallboard', interval: 2, range: 60 },
    { id: 'cmp', name: 'Compare', hostIds: ['h1', 'h2'], compareHostIds: ['h1', 'h2'], view: 'compare', interval: 1, range: 1 },
  ]);
  assert.equal(commercial[0].view, 'wallboard');
  assert.equal(commercial[0].range, 60);
  assert.equal(commercial[1].view, 'compare');
  assert.equal(commercial[1].range, 1);
  assert.deepEqual(commercial[1].compareHostIds, ['h1', 'h2']);

  assert.deepEqual(normalizeVisibleWidgets(['cpuBreakdown', 'invalid' as never, 'cpuBreakdown', 'gpuThermals']), [
    'cpuBreakdown',
    'gpuThermals',
  ]);
});

test('commercial alert rules (iowait, inode, netDrops) and hysteresis filter transient spikes', () => {
  const { violations } = evaluateHostHealth(
    makeLiveState({
      cpuIowait: 42,
      disks: [{ mountPoint: '/', percent: 42, used: 42, total: 100, inodePercent: 96 }],
      netDropsDelta: 16,
    }),
    DEFAULT_ALERT_THRESHOLDS,
  );
  assert.equal(violations.some((v) => v.metric === 'cpuIowait' && v.severity === 'critical'), true);
  assert.equal(violations.some((v) => v.metric === 'inode' && v.severity === 'critical'), true);
  assert.equal(violations.some((v) => v.metric === 'netDrops' && v.severity === 'warning'), true);

  const streaks = new Map<string, number>();
  // Poll 1: suppressed when consecutivePolls = 2
  const firstPass = applyAlertHysteresis(streaks, 'hb_1', violations, 2, { immediateMetrics: new Set(['offline']) });
  assert.equal(firstPass.length, 0);

  // Poll 2: consecutive breach passes hysteresis
  const secondPass = applyAlertHysteresis(streaks, 'hb_1', violations, 2, { immediateMetrics: new Set(['offline']) });
  assert.equal(secondPass.length, violations.length);

  // Immediate metric (offline) bypasses hysteresis on poll 1
  const offlinePass = applyAlertHysteresis(
    streaks,
    'hb_2',
    [{ metric: 'offline', severity: 'critical', value: null, threshold: null, label: 'Host unreachable' }],
    3,
    { immediateMetrics: new Set(['offline']) },
  );
  assert.equal(offlinePass.length, 1);

  // Healthy poll resets streaks
  const recovered = applyAlertHysteresis(streaks, 'hb_1', [], 2);
  assert.equal(recovered.length, 0);
  const spikeAgain = applyAlertHysteresis(streaks, 'hb_1', violations, 2);
  assert.equal(spikeAgain.length, 0);
});
