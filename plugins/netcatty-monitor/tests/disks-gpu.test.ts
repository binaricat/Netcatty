import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonitorDiskListLayout,
  diskIoRates,
  isMonitorSystemDisk,
  parseDiskIo,
  sortMonitorDisks,
  withPartitionIo,
} from '../src/domain/disks.js';
import { parseGpuStats, parseThermalSensors } from '../src/domain/gpu.js';
import {
  formatCompactCount,
  formatDiskGiB,
  formatIops,
  formatMarkdownDiagnostics,
  formatMemoryMiB,
  formatMonitorRate,
  formatUptime,
} from '../src/domain/formatting.js';

test('disk grouping and system-disk auto-expand alert preserves Netcatty parity', () => {
  assert.equal(isMonitorSystemDisk('/'), false);
  assert.equal(isMonitorSystemDisk('/boot'), true);
  assert.equal(isMonitorSystemDisk('/var/lib/docker'), true);
  assert.equal(isMonitorSystemDisk('/data'), false);

  const sorted = sortMonitorDisks([
    { mountPoint: '/data' },
    { mountPoint: '/var' },
    { mountPoint: '/' },
    { mountPoint: '/boot' },
  ]);
  assert.deepEqual(
    sorted.map((d) => d.mountPoint),
    ['/', '/boot', '/var', '/data'],
  );

  // Under 80%: collapsed by default
  const collapsed = buildMonitorDiskListLayout({
    disks: [
      { mountPoint: '/', percent: 50, used: 50, total: 100 },
      { mountPoint: '/boot', percent: 40, used: 0.4, total: 1 },
      { mountPoint: '/data', percent: 60, used: 600, total: 1000 },
    ],
  });
  assert.equal(collapsed.expanded, false);
  assert.equal(collapsed.forcedExpanded, false);
  assert.equal(collapsed.rows.length, 3); // '/', '/data', system header

  // System disk > 80%: forced expanded
  const alerted = buildMonitorDiskListLayout({
    disks: [
      { mountPoint: '/', percent: 50, used: 50, total: 100 },
      { mountPoint: '/var', percent: 88, used: 44, total: 50 },
    ],
  });
  assert.equal(alerted.forcedExpanded, true);
  assert.equal(alerted.expanded, true);
  assert.equal(alerted.rows.some((r) => r.kind === 'disk' && r.disk.mountPoint === '/var' && r.alert), true);
});

test('disk I/O and partition I/O calculation', () => {
  const prev = parseDiskIo('10.0;sda:1000:2000');
  const curr = parseDiskIo('12.0;sda:1100:2200');
  const rates = diskIoRates(curr, prev);
  assert.equal(rates.diskReadSpeed, (100 * 512) / 2);
  assert.equal(rates.diskWriteSpeed, (200 * 512) / 2);

  const pPrev = parseDiskIo('10.0;8-1:500:500');
  const pCurr = parseDiskIo('12.0;8-1:520:540');
  const disks = withPartitionIo([{ mountPoint: '/mnt/my drive', percent: 30, used: 30, total: 100 }], '/mnt/my\\040drive:8-1,', pCurr, pPrev);
  assert.equal(disks[0].diskReadSpeed, (20 * 512) / 2);
  assert.equal(disks[0].diskWriteSpeed, (40 * 512) / 2);
});

test('GPU & thermal sensor parsing supports multi-GPU + temp + power + commas in product name', () => {
  const output =
    'GPU:55 12288 49152 NVIDIA RTX 4090, Founders ;; 0\tNVIDIA RTX 4090, Founders\t70\t8192\t24576\t64\t285.5 ;; 1\tNVIDIA RTX 4090, Founders\t40\t4096\t24576\t58\t190.2';
  const parsed = parseGpuStats(output);
  assert.equal(parsed.gpu, 55);
  assert.equal(parsed.gpuMemUsed, 12288);
  assert.equal(parsed.gpuMemTotal, 49152);
  assert.equal(parsed.gpus.length, 2);
  assert.equal(parsed.gpus[0].name, 'NVIDIA RTX 4090, Founders');
  assert.equal(parsed.gpus[0].vendor, 'nvidia');
  assert.equal(parsed.gpus[0].temperatureC, 64);
  assert.equal(parsed.gpus[0].powerWatts, 285.5);

  const thermals = parseThermalSensors('x86_pkg_temp:61200,nvme:41000,nvme:44000');
  assert.equal(thermals.length, 3);
  assert.equal(thermals[0].temperatureC, 61.2);
  assert.equal(thermals[2].label, 'nvme #2');
});

test('formatting helpers match Netcatty conventions', () => {
  assert.equal(formatMonitorRate(1500), '1.5 KB/s');
  assert.equal(formatMonitorRate(2_500_000), '2.5 MB/s');
  assert.equal(formatMonitorRate(3_200_000_000), '3.2 GB/s');
  assert.equal(formatMonitorRate(null), '--');
  assert.equal(formatMemoryMiB(16384), '16.0 GiB');
  assert.equal(formatDiskGiB(1536), '1.50 TiB');
  assert.equal(formatUptime(90061, 'en'), '1d 1h');
  assert.equal(formatUptime(90061, 'zh-CN'), '1天 1小时');
  assert.equal(formatCompactCount(42_500), '42.5k');
  assert.equal(formatIops(1850, 420), '1.9k/420 IOPS');

  const md = formatMarkdownDiagnostics({
    title: 'Prod Fleet',
    generatedAt: '2026-11-28T00:00:00Z',
    hosts: [
      {
        label: 'web-01',
        hostname: '10.0.0.1',
        status: 'live',
        cpu: 42,
        memPercent: 60,
        diskPercent: 55,
        load: '0.80 / 0.70 / 0.60',
        latency: '18 ms',
        os: 'Ubuntu 24.04',
      },
    ],
    activeAlerts: [],
  });
  assert.match(md, /# Netcatty Monitor Diagnostics — Prod Fleet/);
  assert.match(md, /\| web-01 \(10\.0\.0\.1\) \| live \| 42\.0% \| 60\.0% \| 55% \|/);
});

test('7-field disk I/O computes IOPS, %util, queue depth, and inode alert auto-expands system disks', () => {
  const prev = parseDiskIo('10.0;nvme0n1:1000:2000:500:300:1000:1');
  const curr = parseDiskIo('12.0;nvme0n1:1200:2400:900:500:2200:3');
  const rates = diskIoRates(curr, prev);
  assert.equal(rates.diskReadSpeed, (200 * 512) / 2);
  assert.equal(rates.diskWriteSpeed, (400 * 512) / 2);
  assert.equal(rates.diskReadIops, 200);
  assert.equal(rates.diskWriteIops, 100);
  assert.equal(rates.diskUtilPercent, 60);
  assert.equal(rates.diskQueueDepth, 3);

  const inodeAlert = buildMonitorDiskListLayout({
    disks: [
      { mountPoint: '/', percent: 40, used: 40, total: 100, inodePercent: 20 },
      { mountPoint: '/var', percent: 30, used: 15, total: 50, inodePercent: 92 },
    ],
  });
  assert.equal(inodeAlert.forcedExpanded, true);
  assert.equal(inodeAlert.rows.some((r) => r.kind === 'disk' && r.disk.mountPoint === '/var' && r.alert), true);
});
