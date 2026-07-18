import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';

export interface DiskInfo {
  capacityKey?: string;       // Filesystem or shared-pool identity for deduplication
  mountPoint: string;
  used: number;               // Used in GB
  total: number;              // Total in GB
  percent: number;            // Usage percentage
}

export interface NetInterfaceInfo {
  name: string;               // Interface name (e.g., eth0, ens33)
  rxBytes: number;            // Total received bytes
  txBytes: number;            // Total transmitted bytes
  rxSpeed: number;            // Receive speed (bytes/sec)
  txSpeed: number;            // Transmit speed (bytes/sec)
}

export interface ProcessInfo {
  pid: string;
  memPercent: number;
  command: string;
}

export interface ServerStats {
  hostname?: string;            // Remote hostname
  osName?: string;              // Remote operating system name
  kernelRelease?: string;       // Remote kernel release
  uptimeSeconds?: number | null;// Remote uptime in seconds
  loadAverage?: number[];       // 1/5/15 minute load average
  cpu: number | null;           // CPU usage percentage (0-100)
  cpuCores: number | null;      // Number of CPU cores
  cpuPerCore: number[];         // Per-core CPU usage array
  memTotal: number | null;      // Total memory in MB
  memUsed: number | null;       // Used memory in MB (excluding buffers/cache)
  memFree: number | null;       // Free memory in MB
  memBuffers: number | null;    // Buffers in MB
  memCached: number | null;     // Cached in MB
  swapTotal: number | null;     // Total swap in MB
  swapUsed: number | null;      // Used swap in MB
  topProcesses: ProcessInfo[];  // Top 10 processes by memory
  diskPercent: number | null;   // Disk usage percentage for root partition
  diskUsed: number | null;      // Disk used in GB
  diskTotal: number | null;     // Total disk in GB
  disks: DiskInfo[];            // All mounted disks
  netRxSpeed: number;           // Total network receive speed (bytes/sec)
  netTxSpeed: number;           // Total network transmit speed (bytes/sec)
  latencyMs: number | null;     // TCP connection establishment latency to the SSH endpoint
  netInterfaces: NetInterfaceInfo[];  // Per-interface network stats
  lastUpdated: number | null;   // Timestamp of last successful update
}

interface UseServerStatsOptions {
  sessionId: string;
  enabled: boolean;           // Whether stats collection is enabled (from settings)
  refreshInterval: number;    // Refresh interval in seconds
  isSupportedOs: boolean;     // Only collect stats for Linux/macOS servers
  isConnected: boolean;       // Only collect when connected
}

interface ServerStatsState {
  stats: ServerStats;
  isLoading: boolean;
  error: string | null;
}

interface ServerStatsClient {
  enabled: boolean;
  refreshInterval: number;
  isSupportedOs: boolean;
  isConnected: boolean;
}

type ServerStatsListener = (state: ServerStatsState) => void;

interface SharedServerStatsSession {
  sessionId: string;
  state: ServerStatsState;
  listeners: Set<ServerStatsListener>;
  clients: Map<number, ServerStatsClient>;
  intervalRef: ReturnType<typeof setInterval> | null;
  initialTimerRef: ReturnType<typeof setTimeout> | null;
  connectedAt: number;
  hasFetched: boolean;
  fetchGeneration: number;
  consecutiveFailures: number;
  givenUp: boolean;
  pollIntervalMs: number | null;
  pollingActive: boolean;
  inflight: Promise<void> | null;
  inflightGeneration: number | null;
}

const CONSECUTIVE_FAILURE_LIMIT = 3;
const serverStatsSessions = new Map<string, SharedServerStatsSession>();
let nextClientId = 1;

function createEmptyServerStats(): ServerStats {
  return {
    hostname: undefined,
    osName: undefined,
    kernelRelease: undefined,
    uptimeSeconds: null,
    loadAverage: [],
    cpu: null,
    cpuCores: null,
    cpuPerCore: [],
    memTotal: null,
    memUsed: null,
    memFree: null,
    memBuffers: null,
    memCached: null,
    swapTotal: null,
    swapUsed: null,
    topProcesses: [],
    diskPercent: null,
    diskUsed: null,
    diskTotal: null,
    disks: [],
    netRxSpeed: 0,
    netTxSpeed: 0,
    latencyMs: null,
    netInterfaces: [],
    lastUpdated: null,
  };
}

function createInitialState(): ServerStatsState {
  return {
    stats: createEmptyServerStats(),
    isLoading: false,
    error: null,
  };
}

function getSharedServerStatsSession(sessionId: string): SharedServerStatsSession {
  const existing = serverStatsSessions.get(sessionId);
  if (existing) return existing;

  const session: SharedServerStatsSession = {
    sessionId,
    state: createInitialState(),
    listeners: new Set(),
    clients: new Map(),
    intervalRef: null,
    initialTimerRef: null,
    connectedAt: 0,
    hasFetched: false,
    fetchGeneration: 0,
    consecutiveFailures: 0,
    givenUp: false,
    pollIntervalMs: null,
    pollingActive: false,
    inflight: null,
    inflightGeneration: null,
  };
  serverStatsSessions.set(sessionId, session);
  return session;
}

function emitServerStatsState(session: SharedServerStatsSession): void {
  for (const listener of session.listeners) {
    listener(session.state);
  }
}

function updateServerStatsState(session: SharedServerStatsSession, patch: Partial<ServerStatsState>): void {
  session.state = { ...session.state, ...patch };
  emitServerStatsState(session);
}

function clearServerStatsTimers(session: SharedServerStatsSession): void {
  if (session.initialTimerRef) {
    clearTimeout(session.initialTimerRef);
    session.initialTimerRef = null;
  }
  if (session.intervalRef) {
    clearInterval(session.intervalRef);
    session.intervalRef = null;
  }
  session.pollingActive = false;
  session.pollIntervalMs = null;
}

function resetServerStatsSession(session: SharedServerStatsSession): void {
  clearServerStatsTimers(session);
  session.connectedAt = 0;
  session.hasFetched = false;
  session.fetchGeneration += 1;
  session.consecutiveFailures = 0;
  session.givenUp = false;
  updateServerStatsState(session, createInitialState());
}

function getActiveServerStatsClients(session: SharedServerStatsSession): ServerStatsClient[] {
  return Array.from(session.clients.values()).filter((client) => (
    client.enabled && client.isSupportedOs && client.isConnected
  ));
}

function normalizeServerStats(stats: Partial<ServerStats>): ServerStats {
  return {
    hostname: stats.hostname,
    osName: stats.osName,
    kernelRelease: stats.kernelRelease,
    uptimeSeconds: Number.isFinite(stats.uptimeSeconds) ? Number(stats.uptimeSeconds) : null,
    loadAverage: Array.isArray(stats.loadAverage) ? stats.loadAverage : [],
    cpu: stats.cpu ?? null,
    cpuCores: stats.cpuCores ?? null,
    cpuPerCore: stats.cpuPerCore || [],
    memTotal: stats.memTotal ?? null,
    memUsed: stats.memUsed ?? null,
    memFree: stats.memFree ?? null,
    memBuffers: stats.memBuffers ?? null,
    memCached: stats.memCached ?? null,
    swapTotal: stats.swapTotal ?? null,
    swapUsed: stats.swapUsed ?? null,
    topProcesses: stats.topProcesses || [],
    diskPercent: stats.diskPercent ?? null,
    diskUsed: stats.diskUsed ?? null,
    diskTotal: stats.diskTotal ?? null,
    disks: stats.disks || [],
    netRxSpeed: stats.netRxSpeed || 0,
    netTxSpeed: stats.netTxSpeed || 0,
    latencyMs: Number.isFinite(stats.latencyMs) ? Number(stats.latencyMs) : null,
    netInterfaces: stats.netInterfaces || [],
    lastUpdated: Date.now(),
  };
}

function markServerStatsFailure(session: SharedServerStatsSession, message: string): void {
  session.consecutiveFailures += 1;
  updateServerStatsState(session, { error: message });
  if (session.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
    // Stop polling this session. This covers network devices that advertise
    // OpenSSH but do not support the POSIX stats shell command.
    session.givenUp = true;
    clearServerStatsTimers(session);
  }
}

async function fetchSharedServerStats(session: SharedServerStatsSession, force = false): Promise<void> {
  if (!session.sessionId) return;
  if (session.inflight && session.inflightGeneration === session.fetchGeneration) {
    await session.inflight;
    return;
  }
  if (session.givenUp && !force) return;
  if (getActiveServerStatsClients(session).length === 0) return;

  const bridge = netcattyBridge.get();
  if (!bridge?.getServerStats) return;

  if (force) {
    session.givenUp = false;
    session.consecutiveFailures = 0;
  }

  const generation = session.fetchGeneration;
  session.inflightGeneration = generation;
  updateServerStatsState(session, { isLoading: true, error: null });

  const request = (async () => {
    try {
      const result = await bridge.getServerStats(session.sessionId);

      // Discard stale responses from before a polling restart or reconnect.
      if (generation !== session.fetchGeneration) return;

      if (result.pending) {
        // Transient "not ready yet", e.g. a Mosh session whose SSH handshake
        // has not finished. Do not count this toward the hard-failure cutoff.
        return;
      }

      if (result.success && result.stats) {
        session.hasFetched = true;
        session.consecutiveFailures = 0;
        updateServerStatsState(session, {
          stats: normalizeServerStats(result.stats),
          error: null,
        });
      } else if (result.error) {
        markServerStatsFailure(session, result.error);
      } else {
        markServerStatsFailure(session, 'No stats returned');
      }
    } catch (err) {
      if (generation === session.fetchGeneration) {
        markServerStatsFailure(session, err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      if (generation === session.fetchGeneration) {
        updateServerStatsState(session, { isLoading: false });
      }
    }
  })();

  session.inflight = request;
  try {
    await request;
  } finally {
    if (session.inflight === request) {
      session.inflight = null;
      session.inflightGeneration = null;
    }
  }
}

function reconcileSharedServerStatsSession(session: SharedServerStatsSession): void {
  const activeClients = getActiveServerStatsClients(session);

  if (activeClients.length === 0) {
    resetServerStatsSession(session);
    return;
  }

  if (session.connectedAt === 0) {
    session.connectedAt = Date.now();
  }

  const intervalMs = Math.max(5, Math.min(...activeClients.map((client) => client.refreshInterval))) * 1000;
  const shouldRestartPolling = !session.pollingActive || session.pollIntervalMs !== intervalMs;
  if (!shouldRestartPolling) return;
  if (session.givenUp) return;

  clearServerStatsTimers(session);
  session.fetchGeneration += 1;
  session.pollingActive = true;
  session.pollIntervalMs = intervalMs;

  const connectionAge = Date.now() - session.connectedAt;
  const needsWarmup = !session.hasFetched && connectionAge < 2000;

  session.initialTimerRef = setTimeout(() => {
    session.initialTimerRef = null;
    void fetchSharedServerStats(session);
  }, needsWarmup ? 2000 : 0);
  session.intervalRef = setInterval(() => {
    void fetchSharedServerStats(session);
  }, intervalMs);
}

function maybeDisposeSharedServerStatsSession(session: SharedServerStatsSession): void {
  if (session.clients.size > 0 || session.listeners.size > 0) return;
  clearServerStatsTimers(session);
  session.fetchGeneration += 1;
  serverStatsSessions.delete(session.sessionId);
}

export function useServerStats({
  sessionId,
  enabled,
  refreshInterval,
  isSupportedOs,
  isConnected,
}: UseServerStatsOptions) {
  const clientIdRef = useRef<number | null>(null);
  if (clientIdRef.current === null) {
    clientIdRef.current = nextClientId;
    nextClientId += 1;
  }

  const [state, setState] = useState<ServerStatsState>(() => getSharedServerStatsSession(sessionId).state);

  useEffect(() => {
    const session = getSharedServerStatsSession(sessionId);
    const clientId = clientIdRef.current;
    if (clientId === null) return;

    const listener: ServerStatsListener = (nextState) => {
      setState(nextState);
    };

    session.listeners.add(listener);
    setState(session.state);

    return () => {
      session.listeners.delete(listener);
      session.clients.delete(clientId);
      reconcileSharedServerStatsSession(session);
      maybeDisposeSharedServerStatsSession(session);
    };
  }, [sessionId]);

  useEffect(() => {
    const session = getSharedServerStatsSession(sessionId);
    const clientId = clientIdRef.current;
    if (clientId === null) return;

    session.clients.set(clientId, {
      enabled,
      refreshInterval,
      isSupportedOs,
      isConnected,
    });
    setState(session.state);
    reconcileSharedServerStatsSession(session);
  }, [sessionId, enabled, refreshInterval, isSupportedOs, isConnected]);

  const refresh = useCallback(() => {
    const session = getSharedServerStatsSession(sessionId);
    void fetchSharedServerStats(session, true).finally(() => {
      reconcileSharedServerStatsSession(session);
    });
  }, [sessionId]);

  return {
    stats: state.stats,
    isLoading: state.isLoading,
    error: state.error,
    refresh,
  };
}
