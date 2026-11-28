import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_ALERT_THRESHOLDS } from '../src/domain/alerts.js';
import { createTranslator } from '../src/domain/i18n.js';
import type { HostRuntimeState, MonitorHostRef, MonitorPanel } from '../src/domain/types.js';

// Provide minimal DOM globals required by @remote-dom/core when importing host-react in Node SSR tests.
const g = globalThis as Record<string, unknown>;
for (const name of ['HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent']) {
  if (typeof g[name] === 'undefined') {
    g[name] = class {};
  }
}
const { FleetOverview } = await import('../src/ui/FleetOverview.js');
const { OverviewTab } = await import('../src/ui/tabs/OverviewTab.js');

const sampleHost: MonitorHostRef = {
  hostId: 'hb_prod_1',
  hostBindingToken: 'hb_prod_1',
  label: 'prod-eu-01',
  hostname: '10.0.1.24',
  port: 22,
  username: 'ops',
  group: 'Production',
  tags: ['web', 'eu'],
  notes: 'Primary ingress node',
};

const sampleState: HostRuntimeState = {
  hostId: 'hb_prod_1',
  status: 'live',
  updatedAt: Date.now(),
  points: [
    { at: Date.now() - 10_000, cpu: 32, memory: 58, disk: 48, rx: 120_000, tx: 60_000, diskRead: 40_000, diskWrite: 20_000, latencyMs: 22 },
    { at: Date.now(), cpu: 41, memory: 61, disk: 48, rx: 140_000, tx: 75_000, diskRead: 50_000, diskWrite: 25_000, latencyMs: 19 },
  ],
  stats: {
    osFamily: 'linux',
    cpu: 41,
    cpuCores: 4,
    cpuPerCore: [38, 44, 40, 42],
    cpuIowait: 1.2,
    cpuSteal: 0.1,
    gpu: 55,
    gpuName: 'NVIDIA L4',
    gpuMemUsed: 4096,
    gpuMemTotal: 24576,
    gpus: [{ index: 0, name: 'NVIDIA L4', vendor: 'nvidia', utilization: 55, memoryUsed: 4096, memoryTotal: 24576, temperatureC: 58, powerWatts: 62.5 }],
    thermals: [{ id: 'pkg', label: 'x86_pkg_temp', temperatureC: 54.0 }],
    memTotal: 16384,
    memUsed: 10000,
    memFree: 2048,
    memBuffers: 512,
    memCached: 3824,
    swapTotal: 2048,
    swapUsed: 128,
    topProcesses: [],
    diskPercent: 48,
    diskUsed: 96,
    diskTotal: 200,
    disks: [
      { mountPoint: '/', percent: 48, used: 96, total: 200, filesystemType: 'ext4', diskReadSpeed: 50_000, diskWriteSpeed: 25_000 },
      { mountPoint: '/boot', percent: 35, used: 0.35, total: 1, filesystemType: 'ext4' },
    ],
    diskReadSpeed: 50_000,
    diskWriteSpeed: 25_000,
    networkReady: true,
    netRxSpeed: 140_000,
    netTxSpeed: 75_000,
    latencyMs: 19,
    responseLatencyMs: 24,
    netInterfaces: [{ name: 'eth0', rxBytes: 1_000_000, txBytes: 500_000, rxSpeed: 140_000, txSpeed: 75_000 }],
    hostname: 'prod-eu-01.internal',
    osName: 'Ubuntu 24.04 LTS',
    kernelRelease: '6.8.0-45-generic',
    uptimeSeconds: 184_000,
    loadAverage: [0.82, 0.75, 0.68],
  },
};

const samplePanel: MonitorPanel = {
  id: 'default',
  name: 'Production',
  description: '',
  hostIds: ['hb_prod_1'],
  view: 'charts',
  interval: 5,
  range: 15,
  sort: 'manual',
};

test('FleetOverview renders zero inline <svg>/<canvas> and uses host-rendered PluginMetricChart', () => {
  const html = renderToStaticMarkup(
    <FleetOverview
      panel={samplePanel}
      hosts={[sampleHost]}
      runtimeHosts={{ hb_prod_1: sampleState }}
      pinnedHostIds={new Set(['hb_prod_1'])}
      hiddenColumns={[]}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      running
      locale="en"
      t={createTranslator('en')}
      onUpdatePanel={() => {}}
      onToggleRunning={() => {}}
      onRefreshNow={() => {}}
      onAddHosts={() => {}}
      onRemoveHost={() => {}}
      onTogglePin={() => {}}
      onReorderHost={() => {}}
      onToggleColumn={() => {}}
      onInspectHost={() => {}}
      onRetryHost={() => {}}
      onOpenSession={() => {}}
      onExportSnapshot={() => {}}
    />,
  );
  assert.doesNotMatch(html, /<svg\b|<canvas\b/i, 'Plugin markup must never emit inline <svg> or <canvas>');
  assert.match(html, /data-plugin-widget="metric-chart"/);
  for (const icon of ['hosts', 'online', 'warnings', 'critical', 'cpu', 'memory']) {
    assert.match(html, new RegExp(`asset:assets/ui/${icon}\\.svg`), `Expected KPI icon ${icon}.svg`);
  }
  assert.match(html, /prod-eu-01/);
  assert.match(html, /41%/);
});

test('OverviewTab renders 4 metric-chart widgets, per-core bars, disk grouping, GPU, and bilingual zh-CN labels', () => {
  const html = renderToStaticMarkup(
    <OverviewTab
      host={sampleHost}
      state={sampleState}
      interval={5}
      range={15}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      locale="zh-CN"
      t={createTranslator('zh-CN')}
    />,
  );
  assert.doesNotMatch(html, /<svg\b|<canvas\b/i);
  const chartCount = (html.match(/data-plugin-widget="metric-chart"/g) ?? []).length;
  assert.equal(chartCount, 4);
  assert.match(html, /NVIDIA L4/);
  assert.match(html, /x86_pkg_temp/);
  assert.match(html, /系统挂载点/);
});

test('FleetOverview table mode uses PluginDataGrid and AlertsTab renders active alerts + thresholds', async () => {
  const AlertsTab = (await import('../src/ui/tabs/AlertsTab.js')).default;
  const tableHtml = renderToStaticMarkup(
    <FleetOverview
      panel={{ ...samplePanel, view: 'list' }}
      hosts={[sampleHost]}
      runtimeHosts={{ hb_prod_1: sampleState }}
      pinnedHostIds={new Set()}
      hiddenColumns={['tags']}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      running
      locale="en"
      t={createTranslator('en')}
      onUpdatePanel={() => {}}
      onToggleRunning={() => {}}
      onRefreshNow={() => {}}
      onAddHosts={() => {}}
      onRemoveHost={() => {}}
      onTogglePin={() => {}}
      onReorderHost={() => {}}
      onToggleColumn={() => {}}
      onInspectHost={() => {}}
      onRetryHost={() => {}}
      onOpenSession={() => {}}
      onExportSnapshot={() => {}}
    />,
  );
  assert.doesNotMatch(tableHtml, /<svg\b|<canvas\b/i);
  assert.match(tableHtml, /data-plugin-widget="data-grid"/);

  const alertsHtml = renderToStaticMarkup(
    <AlertsTab
      alerts={[
        {
          id: 'a1',
          hostId: 'hb_prod_1',
          hostLabel: 'prod-eu-01',
          metric: 'cpu',
          severity: 'critical',
          value: 98,
          threshold: 95,
          message: 'prod-eu-01: CPU 98%',
          at: Date.now(),
          acknowledged: false,
          resolvedAt: null,
        },
      ]}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      locale="en"
      t={createTranslator('en')}
      onSaveThresholds={() => {}}
      onAckAlert={() => {}}
      onAckAll={() => {}}
      onClearResolved={() => {}}
    />,
  );
  assert.doesNotMatch(alertsHtml, /<svg\b|<canvas\b/i);
  assert.match(alertsHtml, /prod-eu-01: CPU 98%/);
  assert.match(alertsHtml, /Save Thresholds/);
});

test('RDP/VNC probe host renders latency metric-chart and Remote Desktop action with zero inline svg', () => {
  const rdpHost: MonitorHostRef = {
    hostId: 'hb_rdp_1',
    hostBindingToken: 'hb_rdp_1',
    label: 'Windows Jumpbox',
    hostname: '10.0.9.4',
    port: 3389,
    protocol: 'rdp',
  };
  const rdpState: HostRuntimeState = {
    hostId: 'hb_rdp_1',
    mode: 'probe',
    status: 'live',
    updatedAt: Date.now(),
    stats: null,
    probe: {
      reachable: true,
      protocol: 'rdp',
      port: 3389,
      rttMs: 26,
      bannerVerified: true,
      bannerDetail: 'RDP-NLA',
      checkedAt: Date.now(),
    },
    points: [
      { at: Date.now() - 10_000, cpu: null, memory: null, disk: null, rx: null, tx: null, diskRead: null, diskWrite: null, latencyMs: 24 },
      { at: Date.now(), cpu: null, memory: null, disk: null, rx: null, tx: null, diskRead: null, diskWrite: null, latencyMs: 26 },
    ],
  };

  const fleetHtml = renderToStaticMarkup(
    <FleetOverview
      panel={{ ...samplePanel, hostIds: ['hb_rdp_1'], view: 'charts' }}
      hosts={[rdpHost]}
      runtimeHosts={{ hb_rdp_1: rdpState }}
      pinnedHostIds={new Set()}
      hiddenColumns={[]}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      running
      locale="en"
      t={createTranslator('en')}
      onUpdatePanel={() => {}}
      onToggleRunning={() => {}}
      onRefreshNow={() => {}}
      onAddHosts={() => {}}
      onRemoveHost={() => {}}
      onTogglePin={() => {}}
      onReorderHost={() => {}}
      onToggleColumn={() => {}}
      onInspectHost={() => {}}
      onRetryHost={() => {}}
      onOpenSession={() => {}}
      onExportSnapshot={() => {}}
    />,
  );
  assert.doesNotMatch(fleetHtml, /<svg\b|<canvas\b/i);
  assert.match(fleetHtml, /data-plugin-widget="metric-chart"/);
  assert.match(fleetHtml, /Remote Desktop/);
  assert.match(fleetHtml, /Banner Verified/);

  const detailHtml = renderToStaticMarkup(
    <OverviewTab
      host={rdpHost}
      state={rdpState}
      interval={5}
      range={15}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      locale="en"
      t={createTranslator('en')}
    />,
  );
  assert.doesNotMatch(detailHtml, /<svg\b|<canvas\b/i);
  assert.match(detailHtml, /Reachability &amp; TCP Latency/);
  assert.match(detailHtml, /24 ms \/ 25 ms \/ 26 ms/);
});

test('FleetOverview wallboard and compare modes render commercial widgets with zero inline svg', () => {
  const secondHost: MonitorHostRef = {
    ...sampleHost,
    hostId: 'hb_prod_2',
    hostBindingToken: 'hb_prod_2',
    label: 'prod-us-02',
    hostname: '10.0.2.30',
  };
  const secondState: HostRuntimeState = {
    ...sampleState,
    hostId: 'hb_prod_2',
  };

  const wallboardHtml = renderToStaticMarkup(
    <FleetOverview
      panel={{ ...samplePanel, hostIds: ['hb_prod_1', 'hb_prod_2'], view: 'wallboard' }}
      hosts={[sampleHost, secondHost]}
      runtimeHosts={{ hb_prod_1: sampleState, hb_prod_2: secondState }}
      pinnedHostIds={new Set()}
      hiddenColumns={[]}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      running
      locale="en"
      t={createTranslator('en')}
      onUpdatePanel={() => {}}
      onToggleRunning={() => {}}
      onRefreshNow={() => {}}
      onAddHosts={() => {}}
      onRemoveHost={() => {}}
      onTogglePin={() => {}}
      onReorderHost={() => {}}
      onToggleColumn={() => {}}
      onInspectHost={() => {}}
      onRetryHost={() => {}}
      onOpenSession={() => {}}
      onExportSnapshot={() => {}}
    />,
  );
  assert.doesNotMatch(wallboardHtml, /<svg\b|<canvas\b/i);
  assert.match(wallboardHtml, /nm-wallboard-grid/);
  assert.match(wallboardHtml, /prod-eu-01/);
  assert.match(wallboardHtml, /prod-us-02/);

  const compareHtml = renderToStaticMarkup(
    <FleetOverview
      panel={{
        ...samplePanel,
        hostIds: ['hb_prod_1', 'hb_prod_2'],
        compareHostIds: ['hb_prod_1', 'hb_prod_2'],
        view: 'compare',
      }}
      hosts={[sampleHost, secondHost]}
      runtimeHosts={{ hb_prod_1: sampleState, hb_prod_2: secondState }}
      pinnedHostIds={new Set()}
      hiddenColumns={[]}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      running
      locale="en"
      t={createTranslator('en')}
      onUpdatePanel={() => {}}
      onToggleRunning={() => {}}
      onRefreshNow={() => {}}
      onAddHosts={() => {}}
      onRemoveHost={() => {}}
      onTogglePin={() => {}}
      onReorderHost={() => {}}
      onToggleColumn={() => {}}
      onInspectHost={() => {}}
      onRetryHost={() => {}}
      onOpenSession={() => {}}
      onExportSnapshot={() => {}}
    />,
  );
  assert.doesNotMatch(compareHtml, /<svg\b|<canvas\b/i);
  assert.equal((compareHtml.match(/data-plugin-widget="metric-chart"/g) ?? []).length, 4);
  assert.match(compareHtml, /data-plugin-widget="data-grid"/);
  assert.match(compareHtml, /Compare CPU/);
});

test('OverviewTab renders PSI, Inodes, Open FDs, and honors visibleWidgets filtering', () => {
  const richState: HostRuntimeState = {
    ...sampleState,
    stats: {
      ...sampleState.stats!,
      cpuUser: 28.4,
      cpuSystem: 11.3,
      cpuIowait: 1.2,
      cpuSteal: 0.1,
      contextSwitchesPerSec: 18_400,
      interruptsPerSec: 6_200,
      procsRunning: 3,
      procsBlocked: 0,
      psi: { cpuSome10: 1.4, cpuSome60: 1.1, memSome10: 0.2, memSome60: 0.1, memFull10: 0.0, ioSome10: 2.1, ioSome60: 1.8, ioFull10: 0.4 },
      diskReadIops: 420,
      diskWriteIops: 180,
      diskUtilPercent: 34,
      diskQueueDepth: 2,
      netRxPps: 1200,
      netTxPps: 800,
      tcpRetransmitsPerSec: 1.2,
      fdUsed: 2048,
      fdMax: 65536,
      activeUsers: 2,
      rebootRequired: true,
      disks: [
        { mountPoint: '/', percent: 48, used: 96, total: 200, filesystemType: 'ext4', inodePercent: 31 },
      ],
    },
  };

  const fullHtml = renderToStaticMarkup(
    <OverviewTab
      host={sampleHost}
      state={richState}
      interval={5}
      range={15}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      locale="en"
      t={createTranslator('en')}
    />,
  );
  assert.doesNotMatch(fullHtml, /<svg\b|<canvas\b/i);
  assert.match(fullHtml, /CPU some/);
  assert.match(fullHtml, /Inodes: 31%/);
  assert.match(fullHtml, /Open FDs/);
  assert.match(fullHtml, /NVIDIA L4/);

  // Hide gpu + disks widgets via visibleWidgets
  const filteredHtml = renderToStaticMarkup(
    <OverviewTab
      host={sampleHost}
      state={richState}
      interval={5}
      range={15}
      thresholds={DEFAULT_ALERT_THRESHOLDS}
      visibleWidgets={['cpuBreakdown', 'memoryPsi']}
      locale="en"
      t={createTranslator('en')}
    />,
  );
  assert.equal((filteredHtml.match(/data-plugin-widget="metric-chart"/g) ?? []).length, 2);
  assert.doesNotMatch(filteredHtml, /NVIDIA L4/);
});
