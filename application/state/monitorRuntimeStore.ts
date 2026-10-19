import { useSyncExternalStore } from "react";
import { mergeMonitorSnapshotHistory, type MonitorSnapshot, type MonitorHistoryCursor } from "../../domain/monitorRuntime";
const empty: MonitorSnapshot = {
  historyMode: "replace",
  running: [],
  count: 0,
  hostCount: 0,
  epoch: 0,
  runtimeId: "",
  takenAt: 0,
  activeSessions: [],
  startedAt: {},
  hosts: {},
};
let snapshot = empty;
const listeners = new Set<() => void>();
export function publishMonitorSnapshot(next: MonitorSnapshot) {
  snapshot = mergeMonitorSnapshotHistory(snapshot, next);
  for (const l of listeners) l();
}
export function getMonitorHistoryCursor(): MonitorHistoryCursor {
  return {
    runtimeId: snapshot.runtimeId,
    epoch: snapshot.epoch,
    after: Object.fromEntries(Object.entries(snapshot.hosts).map(([id, host]) => [id, { at: host.points.at(-1)?.at ?? 0, statsAt: host.statsAt ?? host.at, historyId: host.historyId }])),
  };
}
export function publishMonitorUnavailable() {
  publishMonitorSnapshot({ ...empty, unavailable: true });
}
export function useMonitorSnapshot() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => snapshot,
    () => empty,
  );
}
export const monitorActions: {
  start: (id: string) => void;
  stop: (id: string) => void;
  stopAll: () => void;
  retry: (
    id: string,
    credentials?: { username: string; password: string },
  ) => void;
} = {
  start: () => {},
  stop: () => {},
  stopAll: () => {},
  retry: () => {},
};
