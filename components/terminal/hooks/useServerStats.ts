import { useState, useEffect, useCallback, useRef } from 'react';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';

export interface DiskInfo {
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
  netInterfaces: NetInterfaceInfo[];  // Per-interface network stats
  lastUpdated: number | null;   // Timestamp of last successful update
}

interface UseServerStatsOptions {
  sessionId: string;
  enabled: boolean;           // Whether stats collection is enabled (from settings)
  refreshInterval: number;    // Refresh interval in seconds
  isSupportedOs: boolean;     // Only collect stats for Linux/macOS servers
  isConnected: boolean;       // Only collect when connected
  isVisible: boolean;         // Pause background polling for hidden terminals
}

export function useServerStats({
  sessionId,
  enabled,
  refreshInterval,
  isSupportedOs,
  isConnected,
  isVisible,
}: UseServerStatsOptions) {
  const [stats, setStats] = useState<ServerStats>({
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
    netInterfaces: [],
    lastUpdated: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);
  const hasFetchedRef = useRef(false);
  const connectedAtRef = useRef(0);
  const fetchGenerationRef = useRef(0);
  // Auto-disable polling after a few consecutive failures. This covers
  // hosts the banner classifier could not identify (e.g. Juniper JUNOS,
  // Arista EOS, Cisco NX-OS — all of which advertise themselves as
  // OpenSSH but do not support the POSIX stats shell command). Without
  // this, the hook would keep retrying forever and generate an AAA
  // session log every refresh interval.
  const CONSECUTIVE_FAILURE_LIMIT = 3;
  const consecutiveFailuresRef = useRef(0);
  const givenUpRef = useRef(false);

  const fetchStats = useCallback(async () => {
    if (!enabled || !isSupportedOs || !isConnected || !isVisible || !sessionId) {
      return;
    }
    if (givenUpRef.current) {
      return;
    }

    const bridge = netcattyBridge.get();
    if (!bridge?.getServerStats) {
      return;
    }

    const generation = ++fetchGenerationRef.current;
    setIsLoading(true);
    setError(null);

    const markFailure = (message: string) => {
      consecutiveFailuresRef.current += 1;
      setError(message);
      if (consecutiveFailuresRef.current >= CONSECUTIVE_FAILURE_LIMIT) {
        // Stop polling this session. The caller's useEffect sees the
        // givenUp flag via the next render cycle and we also clear the
        // interval locally so no further ticks fire.
        givenUpRef.current = true;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    };

    try {
      const result = await bridge.getServerStats(sessionId);

      // Discard stale responses from before a hide/show cycle or reconnect
      if (!isMountedRef.current || generation !== fetchGenerationRef.current) return;

      if (result.success && result.stats) {
        hasFetchedRef.current = true;
        consecutiveFailuresRef.current = 0;
        setStats({
          cpu: result.stats.cpu,
          cpuCores: result.stats.cpuCores,
          cpuPerCore: result.stats.cpuPerCore || [],
          memTotal: result.stats.memTotal,
          memUsed: result.stats.memUsed,
          memFree: result.stats.memFree,
          memBuffers: result.stats.memBuffers,
          memCached: result.stats.memCached,
          swapTotal: result.stats.swapTotal ?? null,
          swapUsed: result.stats.swapUsed ?? null,
          topProcesses: result.stats.topProcesses || [],
          diskPercent: result.stats.diskPercent,
          diskUsed: result.stats.diskUsed,
          diskTotal: result.stats.diskTotal,
          disks: result.stats.disks || [],
          netRxSpeed: result.stats.netRxSpeed || 0,
          netTxSpeed: result.stats.netTxSpeed || 0,
          netInterfaces: result.stats.netInterfaces || [],
          lastUpdated: Date.now(),
        });
      } else if (result.error) {
        markFailure(result.error);
      } else {
        // Response was not marked as success but has no error — treat as
        // a soft failure. This happens e.g. when the stats shell pipeline
        // returns a parse failure on a host that isn't a typical Linux
        // distro (JUNOS, NX-OS, EOS).
        markFailure('No stats returned');
      }
    } catch (err) {
      if (isMountedRef.current && generation === fetchGenerationRef.current) {
        markFailure(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      if (isMountedRef.current && generation === fetchGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [sessionId, enabled, isSupportedOs, isConnected, isVisible]);

  // When the session changes (e.g., same tab reconnects to a different host
  // while staying connected), reset the failure counter. Without this, a
  // JUNOS session that tripped the counter would permanently suppress
  // polling even after the tab reconnects to a Linux host.
  useEffect(() => {
    consecutiveFailuresRef.current = 0;
    givenUpRef.current = false;
  }, [sessionId]);

  // Initial fetch and periodic refresh
  useEffect(() => {
    isMountedRef.current = true;

    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!enabled || !isSupportedOs || !isConnected) {
      // Reset stats and fetch state when disabled or not connected.
      // Also reset the give-up flag so that a reconnect (possibly to a
      // different host at the same sessionId slot) gets a fresh chance.
      hasFetchedRef.current = false;
      connectedAtRef.current = 0;
      consecutiveFailuresRef.current = 0;
      givenUpRef.current = false;

      setStats({
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
        netInterfaces: [],
        lastUpdated: null,
      });
      return;
    }

    // Track when the connection became available for delay calculation
    // (must be before the isVisible check so hidden tabs record connection time)
    if (connectedAtRef.current === 0) {
      connectedAtRef.current = Date.now();
    }

    if (!isVisible) {
      return () => {
        isMountedRef.current = false;
  
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    }

    // Invalidate any in-flight request from a previous visible/hidden cycle
    // so stale responses don't overwrite the reset network stats below.
    fetchGenerationRef.current++;

    // Fetch immediately when resuming from hidden, or with a delay on first connect.
    // When resuming, reset delta-based network stats (both aggregate and per-interface)
    // so the first sample doesn't show averaged-over-hidden-interval throughput.
    if (hasFetchedRef.current) {
      setStats(prev => ({
        ...prev,
        netRxSpeed: 0,
        netTxSpeed: 0,
        netInterfaces: prev.netInterfaces.map(iface => ({ ...iface, rxSpeed: 0, txSpeed: 0 })),
      }));
    }
    // Skip the warmup delay if the connection has been established long enough
    // (e.g., tab was hidden while connected and is now becoming visible).
    const connectionAge = Date.now() - connectedAtRef.current;
    const needsWarmup = !hasFetchedRef.current && connectionAge < 2000;
    // If we already gave up on this session (exceeded the consecutive
    // failure limit), don't even schedule new timers on effect reruns
    // such as visibility/tab-focus/settings changes. The cleanup at
    // disconnect/sessionId change clears the flag for a fresh attempt.
    const initialTimer = givenUpRef.current
      ? null
      : setTimeout(fetchStats, needsWarmup ? 2000 : 0);

    // Set up periodic refresh
    const intervalMs = Math.max(5, refreshInterval) * 1000; // Minimum 5 seconds
    if (!givenUpRef.current) {
      intervalRef.current = setInterval(fetchStats, intervalMs);
    }

    return () => {
      isMountedRef.current = false;
      if (initialTimer) clearTimeout(initialTimer);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, isSupportedOs, isConnected, isVisible, refreshInterval, fetchStats]);

  // Manual refresh function
  const refresh = useCallback(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    stats,
    isLoading,
    error,
    refresh,
  };
}
