export interface MountedDiskUsage {
  capacityKey?: string;
  mountPoint: string;
  used: number;
  total: number;
}

export interface AggregatedDiskUsage {
  used: number;
  total: number;
  percent: number;
}

export function aggregateMountedDiskUsage(
  disks: readonly MountedDiskUsage[],
): AggregatedDiskUsage | null {
  const capacityGroups = new Map<string, { used: number; total: number }>();

  for (const disk of disks) {
    if (!Number.isFinite(disk.used) || !Number.isFinite(disk.total)) continue;
    if (disk.used < 0 || disk.total <= 0) continue;
    const identity = disk.capacityKey?.trim() || `mount:${disk.mountPoint}`;
    const existing = capacityGroups.get(identity);
    capacityGroups.set(identity, {
      used: Math.max(existing?.used ?? 0, disk.used),
      total: Math.max(existing?.total ?? 0, disk.total),
    });
  }

  let used = 0;
  let total = 0;
  for (const group of capacityGroups.values()) {
    used += group.used;
    total += group.total;
  }

  if (total <= 0) return null;

  return {
    used,
    total,
    percent: Math.max(0, Math.min(100, (used / total) * 100)),
  };
}
