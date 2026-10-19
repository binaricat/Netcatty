export const MONITOR_INTERVALS = [1, 2, 3, 5, 10, 30, 60] as const;
export const DEFAULT_MONITOR_INTERVAL = 5;

/** Portable configuration only. Never add samples, connection state or errors here. */
export interface MonitorPanel {
  id: string;
  name: string;
  description: string;
  hostIds: string[];
  view: "list" | "charts";
  interval: (typeof MONITOR_INTERVALS)[number];
  range: 5 | 15 | 30;
  sort: "manual" | "name";
}

export function normalizeMonitorPanels(value: unknown): MonitorPanel[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const panels = value.flatMap((raw): MonitorPanel[] => {
    if (!raw || typeof raw !== "object") return [];
    const p = raw as Record<string, unknown>;
    if (
      typeof p.id !== "string" ||
      !p.id ||
      ids.has(p.id) ||
      typeof p.name !== "string" ||
      !p.name.trim()
    )
      return [];
    ids.add(p.id);
    return [
      {
        id: p.id,
        name: p.name.trim().slice(0, 120),
        description:
          typeof p.description === "string" ? p.description.slice(0, 1000) : "",
        hostIds: Array.isArray(p.hostIds)
          ? [
              ...new Set(
                p.hostIds.filter(
                  (id): id is string => typeof id === "string" && !!id,
                ),
              ),
            ]
          : [],
        view: p.view === "charts" ? "charts" : "list",
        interval: MONITOR_INTERVALS.includes(p.interval as MonitorPanel["interval"])
          ? p.interval as MonitorPanel["interval"]
          : DEFAULT_MONITOR_INTERVAL,
        range: p.range === 5 || p.range === 15 ? p.range : 30,
        sort: p.sort === "name" ? "name" : "manual",
      },
    ];
  });
  // Independent devices can create the same name with different IDs. Keep
  // every configuration, and choose suffixes by ID so merge order cannot
  // change which panel is renamed. Reserve existing names before allocating.
  const reserved = new Set(panels.map((p) => p.name.toLowerCase()));
  const seenNames = new Set<string>();
  const namesById = new Map<string, string>();
  for (const p of [...panels].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
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
  return panels.map((p) =>
    namesById.has(p.id) ? { ...p, name: namesById.get(p.id)! } : p,
  );
}

/** Move within the displayed ordering, then persist it as the saved ordering. */
export function reorderMonitorHosts(hostIds: string[], from: string, to: string): string[] {
  const fromIndex = hostIds.indexOf(from);
  const toIndex = hostIds.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return hostIds;
  const next = [...hostIds];
  next.splice(fromIndex, 1);
  next.splice(toIndex, 0, from);
  return next;
}

/** Rebase only edited fields onto the latest disk entity; deletion wins over a stale editor. */
export function rebaseMonitorPanel(
  latest: MonitorPanel[],
  base: MonitorPanel | null,
  next: MonitorPanel,
): MonitorPanel[] {
  const current = latest.find((p) => p.id === next.id);
  if (base && !current) throw new Error("monitor.deleted");
  const merged = { ...(current ?? next) };
  for (const field of Object.keys(next) as (keyof MonitorPanel)[]) {
    if (!base || JSON.stringify(base[field]) !== JSON.stringify(next[field])) {
      Object.assign(merged, { [field]: next[field] });
    }
  }
  if (
    latest.some(
      (p) =>
        p.id !== merged.id &&
        p.name.toLowerCase() === merged.name.trim().toLowerCase(),
    )
  ) {
    throw new Error("monitor.duplicateName");
  }
  return normalizeMonitorPanels(
    current
      ? latest.map((p) => (p.id === next.id ? merged : p))
      : [...latest, merged],
  );
}
