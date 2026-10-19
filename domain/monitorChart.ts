import type { MonitorPoint } from "./monitorRuntime";

export type MonitorTrendField = "cpu" | "memory" | "rx" | "tx";

/** Keep extrema within each two-pixel column; hit testing still uses raw samples. */
export function buildMonitorTrendGeometry(
  points: MonitorPoint[], field: MonitorTrendField, range: number, interval: number, end: number,
) {
  const start = end - range * 60000;
  const visible = points.filter((p) => p.at >= start && p.at <= end);
  const max = field === "cpu" || field === "memory" ? 100
    : Math.max(1, ...visible.map((p) => Number.isFinite(p[field]) ? p[field]! : 0));
  const runs: MonitorPoint[][] = [];
  let run: MonitorPoint[] = [];
  for (const p of visible) {
    if (p[field] == null || !Number.isFinite(p[field])) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    if (run.length && p.at - run[run.length - 1].at > interval * 2500) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length) runs.push(run);
  const segments = runs.map((samples) => {
    const selected = new Set([samples[0], samples[samples.length - 1]]);
    const columns = new Map<number, { min: MonitorPoint; max: MonitorPoint }>();
    for (const p of samples) {
      const column = Math.min(149, Math.floor(((p.at - start) / (end - start)) * 150));
      const extremes = columns.get(column);
      if (!extremes) columns.set(column, { min: p, max: p });
      else {
        if (p[field]! < extremes.min[field]!) extremes.min = p;
        if (p[field]! > extremes.max[field]!) extremes.max = p;
      }
    }
    for (const extremes of columns.values()) {
      selected.add(extremes.min);
      selected.add(extremes.max);
    }
    const coordinates = samples.filter((p) => selected.has(p)).map((p) => ({
      x: Math.max(0, Math.min(300, ((p.at - start) / (end - start)) * 300)),
      y: 58 - (Math.min(max, Math.max(0, p[field]!)) / max) * 54,
    }));
    const last = coordinates[coordinates.length - 1];
    return {
      path: coordinates.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" "),
      firstX: coordinates[0].x, x: last.x, y: last.y,
    };
  });
  return { start, end, visible, max, segments };
}

/** Hit actual samples within cursor tolerance, never an interpolated reading. */
export function findMonitorChartPoint(
  points: MonitorPoint[],
  field: MonitorTrendField,
  at: number,
  tolerance: number,
): MonitorPoint | null {
  let closest: MonitorPoint | null = null;
  let distance = tolerance;
  for (const point of points) {
    const value = point[field];
    if (value == null || !Number.isFinite(value)) continue;
    const delta = Math.abs(point.at - at);
    if (delta <= distance) {
      closest = point;
      distance = delta;
    }
  }
  return closest;
}
