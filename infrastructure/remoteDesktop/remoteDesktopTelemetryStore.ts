import type { RemoteDesktopStatsEvent } from '../services/netcattyBridge';

export interface RemoteDesktopTelemetrySnapshot {
  networkStats: RemoteDesktopStatsEvent | null;
  fps: number;
}

const EMPTY_TELEMETRY: RemoteDesktopTelemetrySnapshot = Object.freeze({
  networkStats: null,
  fps: 0,
});

const snapshots = new Map<string, RemoteDesktopTelemetrySnapshot>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = listeners.get(sessionId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener();
    } catch {
      // ignore subscriber errors
    }
  }
}

export function getRemoteDesktopTelemetry(sessionId: string): RemoteDesktopTelemetrySnapshot {
  return snapshots.get(sessionId) ?? EMPTY_TELEMETRY;
}

export function publishRemoteDesktopNetworkStats(
  sessionId: string,
  next: RemoteDesktopStatsEvent | null,
): void {
  const prev = snapshots.get(sessionId);
  const prevStats = prev?.networkStats ?? null;
  if (prevStats === next) return;
  if (
    prevStats
    && next
    && prevStats.rttMs === next.rttMs
    && prevStats.rxBps === next.rxBps
    && prevStats.txBps === next.txBps
    && prevStats.totalRxBytes === next.totalRxBytes
    && prevStats.totalTxBytes === next.totalTxBytes
  ) {
    return;
  }
  snapshots.set(sessionId, {
    networkStats: next,
    fps: prev?.fps ?? 0,
  });
  notify(sessionId);
}

export function publishRemoteDesktopFps(sessionId: string, fps: number): void {
  const normalized = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 0;
  const prev = snapshots.get(sessionId);
  if ((prev?.fps ?? 0) === normalized) return;
  snapshots.set(sessionId, {
    networkStats: prev?.networkStats ?? null,
    fps: normalized,
  });
  notify(sessionId);
}

export function clearRemoteDesktopTelemetry(sessionId: string): void {
  if (!snapshots.has(sessionId)) return;
  snapshots.delete(sessionId);
  notify(sessionId);
}

export function subscribeRemoteDesktopTelemetry(
  sessionId: string,
  listener: () => void,
): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(sessionId);
  };
}
