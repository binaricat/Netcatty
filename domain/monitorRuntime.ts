import type { MonitorPanel } from "./monitorPanels";
export type MonitorStats = NonNullable<
  Awaited<ReturnType<NonNullable<NetcattyBridge["getServerStats"]>>>["stats"]
> & { networkReady?: boolean };
export type MonitorPoint = {
  at: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  rx: number | null;
  tx: number | null;
};
export type MonitorHostState = {
  historyId: string;
  status:
    | "queued"
    | "connecting"
    | "live"
    | "login"
    | "error"
    | "unsupported"
    | "disconnected"
    | "limit";
  at: number;
  /** GPU publication can advance independently of the primary sample/history. */
  statsAt?: number;
  /** Omitted by incremental replies when the receiver already has this sample. */
  stats?: MonitorStats | null;
  points: MonitorPoint[];
};
export type MonitorSnapshot = {
  historyMode: "replace" | "append";
  running: string[];
  count: number;
  hostCount: number;
  epoch: number;
  runtimeId: string;
  takenAt: number;
  activeSessions: string[];
  startedAt: Record<string, number>;
  unavailable?: boolean;
  hosts: Record<string, MonitorHostState>;
};

export type MonitorHistoryCursor = {
  runtimeId: string;
  epoch: number;
  after: Record<string, { at: number; statsAt: number; historyId: string }>;
};

/** Incremental transport keeps the full bounded history in the renderer. */
export function mergeMonitorSnapshotHistory(previous: MonitorSnapshot, next: MonitorSnapshot): MonitorSnapshot {
  if (previous.runtimeId !== next.runtimeId) {
    // An old worker reply can still be in transit after its replacement starts.
    if (previous.runtimeId && next.runtimeId && next.takenAt <= previous.takenAt) return previous;
    return next;
  }
  if (next.epoch < previous.epoch) return previous;
  if (next.epoch > previous.epoch) return next;
  if (next.takenAt < previous.takenAt) return previous;
  if (next.historyMode === "replace") return next;
  return {
    ...next,
    hosts: Object.fromEntries(Object.entries(next.hosts).map(([id, host]) => {
      if (previous.hosts[id]?.historyId !== host.historyId) return [id, host];
      const retained = previous.hosts[id]?.points ?? [];
      const last = retained.at(-1)?.at ?? 0;
      const added = host.points.filter((point) => point.at > last);
      const points = added.length || (retained[0] && next.takenAt - retained[0].at > 30 * 60000)
        ? [...retained, ...added].filter((point) => next.takenAt - point.at <= 30 * 60000).slice(-1800)
        : retained;
      return [id, { ...host, stats: host.stats === undefined ? previous.hosts[id]?.stats : host.stats,
        points }];
    })),
  };
}

const filteredHistories = new WeakMap<MonitorPoint[], Map<number, MonitorPoint[]>>();
function pointsSince(points: MonitorPoint[], startedAt: number) {
  if (!points.length || points[0].at > startedAt) return points;
  let cache = filteredHistories.get(points);
  if (!cache) {
    cache = new Map();
    filteredHistories.set(points, cache);
  }
  let filtered = cache.get(startedAt);
  if (!filtered) {
    filtered = points.filter((point) => point.at > startedAt);
    cache.set(startedAt, filtered);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
  }
  return filtered;
}

/** A panel only displays samples collected during its current cadence/run. */
export function monitorStateSince(state: MonitorHostState | undefined, startedAt: number | undefined): MonitorHostState | undefined {
  if (!state || typeof startedAt !== "number") return undefined;
  const fresh = state.at > startedAt;
  if (fresh && (!state.points.length || state.points[0].at > startedAt)) return state;
  return {
    ...state,
    at: fresh ? state.at : 0,
    stats: fresh ? state.stats : null,
    status: !fresh && state.status === "live" ? "queued" : state.status,
    points: pointsSince(state.points, startedAt),
  };
}
export type MonitorPanelDemand = {
  id: string;
  runId: string;
  interval: MonitorPanel["interval"];
  hosts: {
    id: string;
    options?: NetcattySSHOptions;
    status?: "login" | "error";
  }[];
};
