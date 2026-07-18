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
  let used = 0;
  let total = 0;
  const seenCapacityKeys = new Set<string>();

  for (const disk of disks) {
    if (!Number.isFinite(disk.used) || !Number.isFinite(disk.total)) continue;
    if (disk.used < 0 || disk.total <= 0 || disk.used > disk.total) continue;
    const identity = disk.capacityKey?.trim() || `mount:${disk.mountPoint}`;
    if (seenCapacityKeys.has(identity)) continue;
    seenCapacityKeys.add(identity);
    used += disk.used;
    total += disk.total;
  }

  if (total <= 0) return null;

  return {
    used,
    total,
    percent: Math.max(0, Math.min(100, (used / total) * 100)),
  };
}
