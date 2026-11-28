import type { MonitorInterval, MonitorPanel, MonitorRangeMinutes, MonitorViewMode, OverviewWidgetKey } from './types';

export const MONITOR_INTERVALS: readonly MonitorInterval[] = [1, 2, 3, 5, 10, 30, 60];
export const MONITOR_RANGES: readonly MonitorRangeMinutes[] = [1, 5, 15, 30, 60];
export const DEFAULT_MONITOR_INTERVAL: MonitorInterval = 5;

export const ALL_OVERVIEW_WIDGETS: readonly OverviewWidgetKey[] = [
  'cpuBreakdown',
  'memoryPsi',
  'networkTcp',
  'diskIoMounts',
  'perCore',
  'gpuThermals',
  'systemSecurity',
];

export function normalizeVisibleWidgets(raw: unknown): OverviewWidgetKey[] {
  if (!Array.isArray(raw)) return [...ALL_OVERVIEW_WIDGETS];
  const valid = raw.filter((k): k is OverviewWidgetKey =>
    typeof k === 'string' && (ALL_OVERVIEW_WIDGETS as readonly string[]).includes(k),
  );
  return valid.length > 0 ? [...new Set(valid)] : [...ALL_OVERVIEW_WIDGETS];
}

function normalizeViewMode(value: unknown): MonitorViewMode {
  if (value === 'charts' || value === 'list' || value === 'wallboard' || value === 'compare') return value;
  return 'list';
}

function normalizeRange(value: unknown): MonitorRangeMinutes {
  if (value === 1 || value === 5 || value === 15 || value === 30 || value === 60) return value;
  return 30;
}

export function normalizeMonitorPanels(value: unknown): MonitorPanel[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const panels = value.flatMap((raw): MonitorPanel[] => {
    if (!raw || typeof raw !== 'object') return [];
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim()) {
      return [];
    }
    ids.add(p.id);
    const sortVal =
      p.sort === 'name' || p.sort === 'health' || p.sort === 'cpu' || p.sort === 'memory'
        ? p.sort
        : 'manual';
    const hostIds = Array.isArray(p.hostIds)
      ? [...new Set(p.hostIds.filter((id): id is string => typeof id === 'string' && !!id))]
      : [];
    const compareHostIds = Array.isArray(p.compareHostIds)
      ? [...new Set(p.compareHostIds.filter((id): id is string => typeof id === 'string' && hostIds.includes(id)))].slice(0, 6)
      : undefined;
    return [
      {
        id: p.id,
        name: p.name.trim().slice(0, 120),
        description: typeof p.description === 'string' ? p.description.slice(0, 1000) : '',
        hostIds,
        view: normalizeViewMode(p.view),
        interval: MONITOR_INTERVALS.includes(p.interval as MonitorInterval)
          ? (p.interval as MonitorInterval)
          : DEFAULT_MONITOR_INTERVAL,
        range: normalizeRange(p.range),
        sort: sortVal,
        ...(compareHostIds && compareHostIds.length > 0 ? { compareHostIds } : {}),
      },
    ];
  });
  const reserved = new Set(panels.map((p) => p.name.toLowerCase()));
  const seenNames = new Set<string>();
  const namesById = new Map<string, string>();
  for (const p of [...panels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = p.name.toLowerCase();
    if (!seenNames.has(key)) {
      seenNames.add(key);
      continue;
    }
    let suffix = 2;
    let name: string;
    do {
      const ending = ` (${suffix++})`;
      name = p.name.slice(0, 120 - ending.length).trimEnd() + ending;
    } while (reserved.has(name.toLowerCase()));
    reserved.add(name.toLowerCase());
    namesById.set(p.id, name);
  }
  return panels.map((p) => (namesById.has(p.id) ? { ...p, name: namesById.get(p.id)! } : p));
}

export function reorderMonitorHosts(hostIds: string[], from: string, to: string): string[] {
  const fromIndex = hostIds.indexOf(from);
  const toIndex = hostIds.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return hostIds;
  const next = [...hostIds];
  next.splice(fromIndex, 1);
  next.splice(toIndex, 0, from);
  return next;
}

export function rebaseMonitorPanel(
  latest: MonitorPanel[],
  base: MonitorPanel | null,
  next: MonitorPanel,
): MonitorPanel[] {
  const current = latest.find((p) => p.id === next.id);
  if (base && !current) throw new Error('monitor.deleted');
  const merged = { ...(current ?? next) };
  for (const field of Object.keys(next) as (keyof MonitorPanel)[]) {
    if (!base || JSON.stringify(base[field]) !== JSON.stringify(next[field])) {
      Object.assign(merged, { [field]: next[field] });
    }
  }
  if (latest.some((p) => p.id !== merged.id && p.name.toLowerCase() === merged.name.trim().toLowerCase())) {
    throw new Error('monitor.duplicateName');
  }
  return normalizeMonitorPanels(
    current ? latest.map((p) => (p.id === next.id ? merged : p)) : [...latest, merged],
  );
}
