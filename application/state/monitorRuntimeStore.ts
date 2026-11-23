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
export function isIdleMonitorSnapshot(value: MonitorSnapshot): boolean {
  return value.running.length === 0
    && value.count === 0
    && value.hostCount === 0
    && value.activeSessions.length === 0
    && Object.keys(value.hosts).length === 0
    && Object.keys(value.startedAt).length === 0;
}

/** An idle runtime polled again: only `takenAt` moved, nothing to render. */
function isUnchangedIdleSnapshot(previous: MonitorSnapshot, next: MonitorSnapshot): boolean {
  return isIdleMonitorSnapshot(previous)
    && isIdleMonitorSnapshot(next)
    && previous.epoch === next.epoch
    && previous.runtimeId === next.runtimeId
    && Boolean(previous.unavailable) === Boolean(next.unavailable);
}

export function publishMonitorSnapshot(next: MonitorSnapshot) {
  const merged = mergeMonitorSnapshotHistory(snapshot, next);
  // The runtime is polled even when nothing is monitored; do not wake every
  // subscriber (host-key dialog, monitor panels) for an unchanged idle reply.
  if (merged === snapshot || isUnchangedIdleSnapshot(snapshot, merged)) return;
  snapshot = merged;
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
