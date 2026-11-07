// Product display order; descendants stay with their system mount group.
const SYSTEM_MOUNTS = ["/", "/boot", "/etc", "/usr", "/var", "/home", "/opt", "/srv", "/tmp"];
const mountNames = new Intl.Collator("en", { numeric: true });

function mountPriority(mountPoint: string): number {
  const rank = SYSTEM_MOUNTS.findIndex(path =>
    mountPoint === path || (path !== "/" && mountPoint.startsWith(`${path}/`)),
  );
  return rank < 0 ? SYSTEM_MOUNTS.length : rank;
}

export interface MonitorDiskRow {
  mountPoint: string;
  percent: number | null;
  used?: number | null;
  total?: number | null;
  diskReadSpeed?: number | null;
  diskWriteSpeed?: number | null;
}

export type MonitorDiskListRow =
  | { kind: "disk"; disk: MonitorDiskRow; alert: boolean }
  | { kind: "system"; count: number; expanded: boolean; alert: boolean };

export interface MonitorDiskListStats {
  disks: readonly MonitorDiskRow[];
  diskPercent?: number | null;
  diskUsed?: number | null;
  diskTotal?: number | null;
}

export function isMonitorSystemDisk(mountPoint: string): boolean {
  const priority = mountPriority(mountPoint);
  return priority > 0 && priority < SYSTEM_MOUNTS.length;
}

export function monitorSystemDiskAlert(disk: MonitorDiskRow): boolean {
  return isMonitorSystemDisk(disk.mountPoint)
    && typeof disk.percent === "number" && Number.isFinite(disk.percent) && disk.percent > 80;
}

/** One layout drives both columns, including a matching slot for the group header. */
export function buildMonitorDiskListLayout(stats?: MonitorDiskListStats | null, manuallyExpanded = false) {
  const disks = sortMonitorDisks(stats?.disks.length ? stats.disks : [{
    mountPoint: "/", percent: stats?.diskPercent ?? null,
    used: stats?.diskUsed ?? null, total: stats?.diskTotal ?? null,
  }]);
  const system = disks.filter(disk => isMonitorSystemDisk(disk.mountPoint));
  const forcedExpanded = system.some(monitorSystemDiskAlert);
  const expanded = forcedExpanded || manuallyExpanded;
  const rows: MonitorDiskListRow[] = disks
    .filter(disk => !isMonitorSystemDisk(disk.mountPoint))
    .map(disk => ({ kind: "disk", disk, alert: false }));
  if (system.length) {
    rows.push({ kind: "system", count: system.length, expanded, alert: forcedExpanded });
    if (expanded) rows.push(...system.map(disk => ({ kind: "disk" as const, disk, alert: monitorSystemDiskAlert(disk) })));
  }
  return { rows, expanded, forcedExpanded };
}

export type MonitorDiskListLayout = ReturnType<typeof buildMonitorDiskListLayout>;

/** Sort a copy so capacity cards and other consumers retain the reported order. */
export function sortMonitorDisks<T extends { mountPoint: string }>(disks: readonly T[]): T[] {
  return [...disks].sort((a, b) =>
    mountPriority(a.mountPoint) - mountPriority(b.mountPoint)
    || mountNames.compare(a.mountPoint, b.mountPoint),
  );
}
