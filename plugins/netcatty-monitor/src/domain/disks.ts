import type { MonitorDiskRow } from './types';

// Exact parity with Netcatty domain/monitorDisks.ts and electron/bridges/sshBridge/monitorDiskIo.cjs,
// extended with IOPS, %util busy, and queue depth from /sys/block/*/stat (11-field Linux block stats).
const SYSTEM_MOUNTS = ['/', '/boot', '/etc', '/usr', '/var', '/home', '/opt', '/srv', '/tmp'];
const mountNames = new Intl.Collator('en', { numeric: true });

// Format per device: name:readSectors:writeSectors[:readsCompleted:writesCompleted:ioTicksMs:inFlight]
export const DISK_IO_ASSIGNMENT = String.raw`diskio=$(if [ -r /proc/uptime ]; then awk '{printf "%s;",$1}' /proc/uptime; for d in /sys/block/*; do [ -e "$d/device" ] && [ -r "$d/stat" ] || continue; awk -v path="$d" 'NF>=10 {n=split(path,a,"/");printf "%s:%s:%s:%s:%s:%s:%s,",a[n],$3,$7,$1,$5,$10,$9} NF>=7 && NF<10 {n=split(path,a,"/");printf "%s:%s:%s,",a[n],$3,$7}' "$d/stat"; done; fi)`;

export const PARTITION_IO_ASSIGNMENT = String.raw`partitionio=$(if [ -r /proc/uptime ]; then awk 'NR==1 {printf "%s;",$1;next} NF>=7 {n=split(FILENAME,a,"/");gsub(/:/,"-",a[n-1]);printf "%s:%s:%s,",a[n-1],$3,$7}' /proc/uptime /sys/dev/block/*/stat 2>/dev/null; fi); diskmounts=$(awk '{gsub(/:/,"-",$3);printf "%s:%s,",$5,$3}' /proc/self/mountinfo 2>/dev/null)`;

export interface DiskIoDeviceCounters {
  readSectors: number;
  writeSectors: number;
  readsCompleted?: number;
  writesCompleted?: number;
  ioTicksMs?: number;
  inFlight?: number;
}

export interface DiskIoSnapshot {
  timestamp: number;
  devices: Map<string, DiskIoDeviceCounters>;
}

export interface DiskIoRates {
  diskReadSpeed: number | null;
  diskWriteSpeed: number | null;
  diskReadIops: number | null;
  diskWriteIops: number | null;
  diskUtilPercent: number | null;
  diskQueueDepth: number | null;
}

export type MonitorDiskListRow =
  | { kind: 'disk'; disk: MonitorDiskRow; alert: boolean }
  | { kind: 'system'; count: number; expanded: boolean; alert: boolean };

export interface MonitorDiskListStats {
  disks: readonly MonitorDiskRow[];
  diskPercent?: number | null;
  diskUsed?: number | null;
  diskTotal?: number | null;
}

function mountPriority(mountPoint: string): number {
  const rank = SYSTEM_MOUNTS.findIndex(
    (path) => mountPoint === path || (path !== '/' && mountPoint.startsWith(`${path}/`)),
  );
  return rank < 0 ? SYSTEM_MOUNTS.length : rank;
}

export function isMonitorSystemDisk(mountPoint: string): boolean {
  const priority = mountPriority(mountPoint);
  return priority > 0 && priority < SYSTEM_MOUNTS.length;
}

export function monitorSystemDiskAlert(disk: MonitorDiskRow, threshold = 80): boolean {
  return (
    isMonitorSystemDisk(disk.mountPoint) &&
    ((typeof disk.percent === 'number' && Number.isFinite(disk.percent) && disk.percent > threshold) ||
      (typeof disk.inodePercent === 'number' && Number.isFinite(disk.inodePercent) && disk.inodePercent > threshold))
  );
}

export function sortMonitorDisks<T extends { mountPoint: string }>(disks: readonly T[]): T[] {
  return [...disks].sort(
    (a, b) => mountPriority(a.mountPoint) - mountPriority(b.mountPoint) || mountNames.compare(a.mountPoint, b.mountPoint),
  );
}

export function buildMonitorDiskListLayout(
  stats?: MonitorDiskListStats | null,
  manuallyExpanded = false,
  alertThreshold = 80,
) {
  const disks = sortMonitorDisks(
    stats?.disks.length
      ? stats.disks
      : [
          {
            mountPoint: '/',
            percent: stats?.diskPercent ?? null,
            used: stats?.diskUsed ?? null,
            total: stats?.diskTotal ?? null,
          },
        ],
  );
  const system = disks.filter((disk) => isMonitorSystemDisk(disk.mountPoint));
  const forcedExpanded = system.some((disk) => monitorSystemDiskAlert(disk, alertThreshold));
  const expanded = forcedExpanded || manuallyExpanded;
  const rows: MonitorDiskListRow[] = disks
    .filter((disk) => !isMonitorSystemDisk(disk.mountPoint))
    .map((disk) => ({
      kind: 'disk',
      disk,
      alert: (disk.percent ?? 0) > alertThreshold || (disk.inodePercent ?? 0) > alertThreshold,
    }));
  if (system.length) {
    rows.push({ kind: 'system', count: system.length, expanded, alert: forcedExpanded });
    if (expanded) {
      rows.push(
        ...system.map((disk) => ({
          kind: 'disk' as const,
          disk,
          alert: monitorSystemDiskAlert(disk, alertThreshold),
        })),
      );
    }
  }
  return { rows, expanded, forcedExpanded };
}

export function parseDiskIo(text: string | null | undefined): DiskIoSnapshot | null {
  if (typeof text !== 'string') return null;
  const [time, counters, ...extra] = text.trim().split(';');
  const timestamp = Number(time);
  if (!time || extra.length || !Number.isFinite(timestamp) || timestamp < 0 || !counters) return null;
  const devices = new Map<string, DiskIoDeviceCounters>();
  for (const entry of counters.replace(/,$/, '').split(',')) {
    const fields = entry.split(':');
    const [name, read, write, readsComp, writesComp, ioTicks, inFlight] = fields;
    if (
      (fields.length !== 3 && fields.length !== 7) ||
      !/^[a-zA-Z0-9_.!-]+$/.test(name) ||
      devices.has(name) ||
      !/^\d+$/.test(read) ||
      !/^\d+$/.test(write)
    ) {
      return null;
    }
    const readSectors = Number(read);
    const writeSectors = Number(write);
    if (!Number.isSafeInteger(readSectors) || !Number.isSafeInteger(writeSectors)) return null;
    const item: DiskIoDeviceCounters = { readSectors, writeSectors };
    if (fields.length === 7) {
      if (!/^\d+$/.test(readsComp) || !/^\d+$/.test(writesComp) || !/^\d+$/.test(ioTicks) || !/^\d+$/.test(inFlight)) {
        return null;
      }
      item.readsCompleted = Number(readsComp);
      item.writesCompleted = Number(writesComp);
      item.ioTicksMs = Number(ioTicks);
      item.inFlight = Number(inFlight);
    }
    devices.set(name, item);
  }
  return { timestamp, devices };
}

export function diskIoRates(
  current: DiskIoSnapshot | null | undefined,
  previous: DiskIoSnapshot | null | undefined,
): DiskIoRates {
  const unavailable: DiskIoRates = {
    diskReadSpeed: null,
    diskWriteSpeed: null,
    diskReadIops: null,
    diskWriteIops: null,
    diskUtilPercent: null,
    diskQueueDepth: null,
  };
  if (!current || !previous || current.devices.size !== previous.devices.size) return unavailable;
  const seconds = current.timestamp - previous.timestamp;
  if (!(seconds > 0)) return unavailable;
  let read = 0;
  let write = 0;
  let hasExtended = true;
  let readOps = 0;
  let writeOps = 0;
  let maxUtil = 0;
  let totalInFlight = 0;
  for (const [name, counters] of current.devices) {
    const before = previous.devices.get(name);
    if (!before || counters.readSectors < before.readSectors || counters.writeSectors < before.writeSectors) {
      return unavailable;
    }
    read += (counters.readSectors - before.readSectors) * 512;
    write += (counters.writeSectors - before.writeSectors) * 512;
    if (
      counters.readsCompleted != null &&
      before.readsCompleted != null &&
      counters.writesCompleted != null &&
      before.writesCompleted != null &&
      counters.ioTicksMs != null &&
      before.ioTicksMs != null &&
      counters.readsCompleted >= before.readsCompleted &&
      counters.writesCompleted >= before.writesCompleted &&
      counters.ioTicksMs >= before.ioTicksMs
    ) {
      readOps += counters.readsCompleted - before.readsCompleted;
      writeOps += counters.writesCompleted - before.writesCompleted;
      const devUtil = ((counters.ioTicksMs - before.ioTicksMs) / (seconds * 1000)) * 100;
      if (devUtil > maxUtil) maxUtil = devUtil;
      totalInFlight += counters.inFlight ?? 0;
    } else {
      hasExtended = false;
    }
  }
  return {
    diskReadSpeed: read / seconds,
    diskWriteSpeed: write / seconds,
    diskReadIops: hasExtended ? Number((readOps / seconds).toFixed(1)) : null,
    diskWriteIops: hasExtended ? Number((writeOps / seconds).toFixed(1)) : null,
    diskUtilPercent: hasExtended ? Number(Math.max(0, Math.min(100, maxUtil)).toFixed(1)) : null,
    diskQueueDepth: hasExtended ? totalInFlight : null,
  };
}

export function withPartitionIo(
  disks: readonly MonitorDiskRow[],
  mounts: string | null | undefined,
  current: DiskIoSnapshot | null | undefined,
  previous: DiskIoSnapshot | null | undefined,
): MonitorDiskRow[] {
  const devices = new Map<string, string>();
  for (const entry of (mounts || '').split(',')) {
    const separator = entry.lastIndexOf(':');
    if (separator < 0) continue;
    const mount = entry
      .slice(0, separator)
      .replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    devices.set(mount, entry.slice(separator + 1));
  }
  return disks.map((disk) => {
    const name = devices.get(disk.mountPoint);
    if (!name) return disk;
    const sample = (snapshot: DiskIoSnapshot | null | undefined): DiskIoSnapshot | null =>
      snapshot?.devices.has(name)
        ? { timestamp: snapshot.timestamp, devices: new Map([[name, snapshot.devices.get(name)!]]) }
        : null;
    const rates = diskIoRates(sample(current), sample(previous));
    return rates.diskReadSpeed == null
      ? disk
      : { ...disk, diskReadSpeed: rates.diskReadSpeed, diskWriteSpeed: rates.diskWriteSpeed };
  });
}
