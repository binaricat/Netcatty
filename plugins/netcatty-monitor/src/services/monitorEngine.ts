import { applyAlertHysteresis, evaluateHostHealth, mergeAlertFeed, DEFAULT_ALERT_THRESHOLDS } from '../domain/alerts';
import {
  buildContainerActionCommand,
  buildContainerLogsCommand,
  buildGpuProbeCommand,
  buildLinuxDiskCommand,
  buildPortsCommand,
  buildPrimaryStatsCommand,
  buildProcessSignalCommand,
  buildProcessesCommand,
  buildServiceActionCommand,
  buildServiceLogsCommand,
  buildServicesAndContainersCommand,
  buildSystemAuditCommand,
  buildWindowsStatsCommand,
  type SafeContainerAction,
  type SafeProcessSignal,
  type SafeServiceAction,
} from '../domain/collectors';
import { formatMemoryPercent } from '../domain/formatting';
import { parseGpuStats } from '../domain/gpu';
import {
  parsePortsOutput,
  parsePrimaryStatsOutput,
  parseProcessesOutput,
  parseServicesAndContainersOutput,
  parseSystemAuditOutput,
  type TelemetryDeltaState,
} from '../domain/parsers';
import type {
  AlertEvent,
  AlertThresholds,
  ContainerRow,
  HostRuntimeState,
  MonitorHostRef,
  MonitorInterval,
  MonitorPoint,
  PortRow,
  ProcessRow,
  SocketSummary,
  SystemAuditSnapshot,
  SystemdServiceRow,
} from '../domain/types';
import type { MonitorHostBridge } from './hostBridge';

const MAX_CONCURRENT_EXECS = 12;
const HISTORY_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_MAX_POINTS = 1200;
const GPU_CADENCE_MS = 15_000;
const MIN_PROBE_INTERVAL_SEC = 5;
const IMMEDIATE_ALERT_METRICS = new Set(['offline'] as const);

export function isProbeProtocol(protocol?: string | null): protocol is 'rdp' | 'vnc' {
  const p = String(protocol || '').toLowerCase();
  return p === 'rdp' || p === 'vnc';
}

interface HostInternal {
  host: MonitorHostRef;
  state: HostRuntimeState;
  delta: TelemetryDeltaState;
  failures: number;
  sampling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastGpuProbeAt: number;
  cachedGpu: {
    gpu: number | null;
    gpuName: string | null;
    gpuMemUsed: number | null;
    gpuMemTotal: number | null;
    gpus: NonNullable<HostRuntimeState['stats']>['gpus'];
  } | null;
  useWindowsFallback: boolean;
}

export interface MonitorEngineSnapshot {
  running: boolean;
  hosts: Record<string, HostRuntimeState>;
  alerts: AlertEvent[];
  thresholds: AlertThresholds;
}

export class MonitorEngine {
  readonly #bridge: MonitorHostBridge;
  readonly #entries = new Map<string, HostInternal>();
  readonly #listeners = new Set<() => void>();
  #running = false;
  #disposed = false;
  #intervalSec: MonitorInterval = 5;
  #thresholds: AlertThresholds = { ...DEFAULT_ALERT_THRESHOLDS };
  #alerts: AlertEvent[] = [];
  readonly #alertStreaks = new Map<string, number>();
  #activeExecs = 0;
  readonly #waiters: Array<() => void> = [];
  readonly #now: () => number;

  constructor(bridge: MonitorHostBridge, options: { now?: () => number; thresholds?: AlertThresholds } = {}) {
    this.#bridge = bridge;
    this.#now = options.now ?? Date.now;
    if (options.thresholds) this.#thresholds = { ...options.thresholds };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  getSnapshot(): MonitorEngineSnapshot {
    const hosts: Record<string, HostRuntimeState> = {};
    for (const [id, entry] of this.#entries) {
      hosts[id] = entry.state;
    }
    return {
      running: this.#running,
      hosts,
      alerts: this.#alerts,
      thresholds: this.#thresholds,
    };
  }

  setThresholds(thresholds: AlertThresholds): void {
    this.#thresholds = { ...thresholds };
    for (const entry of this.#entries.values()) {
      const { violations } = evaluateHostHealth(entry.state, this.#thresholds);
      this.#alerts = mergeAlertFeed(this.#alerts, entry.host.hostId, entry.host.label, violations, this.#now());
    }
    this.#emit();
  }

  acknowledgeAlert(alertId: string): void {
    this.#alerts = this.#alerts.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a));
    this.#emit();
  }

  acknowledgeAllAlerts(): void {
    this.#alerts = this.#alerts.map((a) => ({ ...a, acknowledged: true }));
    this.#emit();
  }

  clearResolvedAlerts(): void {
    this.#alerts = this.#alerts.filter((a) => !a.resolvedAt);
    this.#emit();
  }

  setIntervalSeconds(interval: MonitorInterval): void {
    if (this.#intervalSec === interval) return;
    this.#intervalSec = interval;
    if (this.#running) {
      for (const entry of this.#entries.values()) {
        this.#clearTimer(entry);
        if (!entry.sampling && entry.state.status !== 'unsupported') {
          this.#scheduleNext(entry, 50);
        }
      }
    }
  }

  reconcileHosts(hosts: readonly MonitorHostRef[], options: { running: boolean; interval: MonitorInterval }): void {
    this.#intervalSec = options.interval;
    const nextIds = new Set(hosts.map((h) => h.hostId));

    for (const [id, entry] of this.#entries) {
      if (!nextIds.has(id)) {
        this.#clearTimer(entry);
        this.#entries.delete(id);
      }
    }

    for (const host of hosts) {
      const existing = this.#entries.get(host.hostId);
      if (existing) {
        existing.host = host;
      } else {
        const mode: 'ssh' | 'probe' = isProbeProtocol(host.protocol) ? 'probe' : 'ssh';
        this.#entries.set(host.hostId, {
          host,
          state: {
            hostId: host.hostId,
            mode,
            status: options.running ? 'queued' : 'idle',
            error: null,
            updatedAt: 0,
            stats: null,
            probe: null,
            points: [],
          },
          delta: {},
          failures: 0,
          sampling: false,
          timer: null,
          lastGpuProbeAt: 0,
          cachedGpu: null,
          useWindowsFallback: false,
        });
      }
    }

    const wasRunning = this.#running;
    this.#running = options.running;

    if (!this.#running) {
      for (const entry of this.#entries.values()) {
        this.#clearTimer(entry);
        if (entry.state.status === 'queued' || entry.state.status === 'connecting') {
          entry.state = { ...entry.state, status: 'idle' };
        }
      }
    } else {
      for (const entry of this.#entries.values()) {
        if (!entry.sampling && !entry.timer && entry.state.status !== 'unsupported') {
          if (!wasRunning || entry.state.status === 'idle' || entry.state.status === 'queued') {
            this.#scheduleNext(entry, 0);
          }
        }
      }
    }
    this.#emit();
  }

  retryHost(hostId: string): void {
    const entry = this.#entries.get(hostId);
    if (!entry || this.#disposed) return;
    this.#clearTimer(entry);
    entry.failures = 0;
    entry.useWindowsFallback = false;
    entry.state = { ...entry.state, status: 'queued', error: null };
    this.#emit();
    void this.#collectHost(entry);
  }

  refreshAllNow(): void {
    if (this.#disposed) return;
    for (const entry of this.#entries.values()) {
      this.#clearTimer(entry);
      if (!entry.sampling && entry.state.status !== 'unsupported') {
        void this.#collectHost(entry);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#running = false;
    for (const entry of this.#entries.values()) {
      this.#clearTimer(entry);
    }
    this.#entries.clear();
    this.#listeners.clear();
  }

  #clearTimer(entry: HostInternal): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  #scheduleNext(entry: HostInternal, delayMs: number): void {
    if (this.#disposed || !this.#running) return;
    this.#clearTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#collectHost(entry);
    }, delayMs);
    (entry.timer as unknown as { unref?: () => void })?.unref?.();
  }

  async #acquireSlot(): Promise<void> {
    if (this.#activeExecs < MAX_CONCURRENT_EXECS) {
      this.#activeExecs += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #releaseSlot(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#activeExecs = Math.max(0, this.#activeExecs - 1);
  }

  async #execBounded(host: MonitorHostRef, command: string, timeoutMs = 10_000, maxOutputBytes = 256 * 1024) {
    await this.#acquireSlot();
    try {
      return await this.#bridge.execHostCommand({
        hostBindingToken: host.hostBindingToken || host.hostId,
        command,
        timeoutMs,
        maxOutputBytes,
      });
    } finally {
      this.#releaseSlot();
    }
  }

  async #collectHost(entry: HostInternal): Promise<void> {
    if (this.#disposed || entry.sampling || !this.#entries.has(entry.host.hostId)) return;
    if (isProbeProtocol(entry.host.protocol)) {
      await this.#collectProbe(entry, entry.host.protocol);
      return;
    }
    entry.sampling = true;
    if (entry.state.status === 'idle' || entry.state.status === 'queued') {
      entry.state = { ...entry.state, status: 'connecting', error: null };
      this.#emit();
    }

    const startedAt = this.#now();
    try {
      const cmd = entry.useWindowsFallback ? buildWindowsStatsCommand() : buildPrimaryStatsCommand();
      const primary = await this.#execBounded(entry.host, cmd, 10_000, 256 * 1024);
      if (this.#disposed || !this.#entries.has(entry.host.hostId)) return;

      let parsed = parsePrimaryStatsOutput(primary.stdout, entry.delta, {
        now: this.#now(),
        latencyMs: primary.latencyMs,
        responseLatencyMs: primary.responseLatencyMs,
      });

      // Fallback to Windows OpenSSH PowerShell probe if uname failed or reported non-POSIX Windows
      if (!parsed.ok && !entry.useWindowsFallback && (parsed.unsupported || /not supported|Unable to parse/i.test(parsed.error))) {
        try {
          const winRes = await this.#execBounded(entry.host, buildWindowsStatsCommand(), 10_000, 128 * 1024);
          const winParsed = parsePrimaryStatsOutput(winRes.stdout, entry.delta, {
            now: this.#now(),
            latencyMs: winRes.latencyMs,
            responseLatencyMs: winRes.responseLatencyMs,
          });
          if (winParsed.ok) {
            entry.useWindowsFallback = true;
            parsed = winParsed;
          }
        } catch {
          // Keep original error
        }
      }

      if (!parsed.ok) {
        entry.failures += 1;
        entry.state = {
          ...entry.state,
          status: parsed.unsupported ? 'unsupported' : 'error',
          error: parsed.error,
          updatedAt: this.#now(),
        };
      } else {
        // Fetch Linux disks in a dedicated Dropbear-safe exec when primary omitted them
        if (parsed.needsSeparateLinuxDisks) {
          try {
            const diskRes = await this.#execBounded(entry.host, buildLinuxDiskCommand(), 10_000, 128 * 1024);
            const merged = parsePrimaryStatsOutput(primary.stdout, entry.delta, {
              now: this.#now(),
              latencyMs: primary.latencyMs,
              responseLatencyMs: primary.responseLatencyMs,
              linuxDiskStdout: diskRes.stdout,
            });
            if (merged.ok) parsed = merged;
          } catch {
            // Keep primary stats even if disk probe failed
          }
        }

        // Optional slower-cadence GPU probe on Linux
        const now = this.#now();
        if (parsed.stats.osFamily === 'linux' && now - entry.lastGpuProbeAt >= GPU_CADENCE_MS) {
          entry.lastGpuProbeAt = now;
          try {
            const gpuRes = await this.#execBounded(entry.host, buildGpuProbeCommand(), 4_000, 64 * 1024);
            entry.cachedGpu = parseGpuStats(gpuRes.stdout);
          } catch {
            // Non-fatal
          }
        }

        const stats = entry.cachedGpu
          ? {
              ...parsed.stats,
              ...entry.cachedGpu,
            }
          : parsed.stats;

        entry.delta = parsed.nextDelta;
        entry.failures = 0;

        const memPct = formatMemoryPercent(stats.memUsed, stats.memTotal);
        const swapPct = formatMemoryPercent(stats.swapUsed, stats.swapTotal);
        const totalIops =
          stats.diskReadIops != null || stats.diskWriteIops != null
            ? Number(((stats.diskReadIops ?? 0) + (stats.diskWriteIops ?? 0)).toFixed(1))
            : null;
        const point: MonitorPoint = {
          at: now,
          cpu: stats.cpu,
          cpuUser: stats.cpuUser ?? null,
          cpuSystem: stats.cpuSystem ?? null,
          cpuIowait: stats.cpuIowait ?? null,
          cpuSteal: stats.cpuSteal ?? null,
          memory: memPct == null ? null : Number(memPct.toFixed(1)),
          swap: swapPct == null ? null : Number(swapPct.toFixed(1)),
          disk: stats.diskPercent,
          rx: stats.networkReady ? stats.netRxSpeed : null,
          tx: stats.networkReady ? stats.netTxSpeed : null,
          diskRead: stats.diskReadSpeed,
          diskWrite: stats.diskWriteSpeed,
          diskIops: totalIops,
          latencyMs: stats.latencyMs ?? stats.responseLatencyMs,
        };
        const cutoff = now - HISTORY_WINDOW_MS;
        const points = [...entry.state.points.filter((p) => p.at >= cutoff), point].slice(-HISTORY_MAX_POINTS);

        entry.state = {
          hostId: entry.host.hostId,
          status: 'live',
          error: null,
          updatedAt: now,
          stats,
          points,
          lastCommandDurationMs: Math.max(0, now - startedAt),
        };
      }
    } catch (err) {
      if (this.#disposed || !this.#entries.has(entry.host.hostId)) return;
      const msg = err instanceof Error ? err.message : String(err);
      entry.failures += 1;
      const isAuth = /auth|permission|passphrase|login|unauthenticated/i.test(msg);
      const isUnsupported = /unsupported|single-channel|bastion/i.test(msg);
      entry.state = {
        ...entry.state,
        status: isUnsupported ? 'unsupported' : isAuth ? 'login' : 'error',
        error: msg,
        updatedAt: this.#now(),
      };
    } finally {
      entry.sampling = false;
      const { violations } = evaluateHostHealth(entry.state, this.#thresholds);
      const confirmed = applyAlertHysteresis(
        this.#alertStreaks,
        entry.host.hostId,
        violations,
        this.#thresholds.consecutivePolls,
        { immediateMetrics: IMMEDIATE_ALERT_METRICS },
      );
      this.#alerts = mergeAlertFeed(this.#alerts, entry.host.hostId, entry.host.label, confirmed, this.#now());
      this.#emit();

      if (!this.#disposed && this.#running && entry.state.status !== 'unsupported') {
        const backoffFactor = entry.failures > 0 ? Math.min(6, 2 ** entry.failures) : 1;
        const delayMs = this.#intervalSec * 1000 * backoffFactor;
        this.#scheduleNext(entry, delayMs);
      }
    }
  }

  async #collectProbe(entry: HostInternal, protocol: 'rdp' | 'vnc'): Promise<void> {
    if (this.#disposed || entry.sampling || !this.#entries.has(entry.host.hostId)) return;
    entry.sampling = true;
    if (entry.state.status === 'idle' || entry.state.status === 'queued') {
      entry.state = { ...entry.state, mode: 'probe', status: 'connecting', error: null };
      this.#emit();
    }
    const startedAt = this.#now();
    try {
      await this.#acquireSlot();
      let probe;
      try {
        probe = await this.#bridge.probeHost({
          hostBindingToken: entry.host.hostBindingToken || entry.host.hostId,
          protocol,
          ...(typeof entry.host.port === 'number' ? { port: entry.host.port } : {}),
          timeoutMs: 5_000,
        });
      } finally {
        this.#releaseSlot();
      }
      if (this.#disposed || !this.#entries.has(entry.host.hostId)) return;
      const now = probe.checkedAt || this.#now();
      if (probe.reachable) {
        entry.failures = 0;
      } else {
        entry.failures += 1;
      }
      const point: MonitorPoint = {
        at: now,
        cpu: null,
        memory: null,
        disk: null,
        rx: null,
        tx: null,
        diskRead: null,
        diskWrite: null,
        latencyMs: probe.reachable ? probe.rttMs : null,
      };
      const cutoff = now - HISTORY_WINDOW_MS;
      const points = [...entry.state.points.filter((p) => p.at >= cutoff), point].slice(-HISTORY_MAX_POINTS);
      entry.state = {
        hostId: entry.host.hostId,
        mode: 'probe',
        status: probe.reachable ? 'live' : 'offline',
        error: probe.reachable ? null : (probe.error ?? 'Host unreachable'),
        updatedAt: now,
        stats: null,
        probe,
        points,
        lastCommandDurationMs: Math.max(0, this.#now() - startedAt),
      };
    } catch (err) {
      if (this.#disposed || !this.#entries.has(entry.host.hostId)) return;
      const msg = err instanceof Error ? err.message : String(err);
      entry.failures += 1;
      entry.state = {
        ...entry.state,
        mode: 'probe',
        status: /unsupported/i.test(msg) ? 'unsupported' : 'offline',
        error: msg,
        updatedAt: this.#now(),
      };
    } finally {
      entry.sampling = false;
      const { violations } = evaluateHostHealth(entry.state, this.#thresholds);
      const confirmed = applyAlertHysteresis(
        this.#alertStreaks,
        entry.host.hostId,
        violations,
        this.#thresholds.consecutivePolls,
        { immediateMetrics: IMMEDIATE_ALERT_METRICS },
      );
      this.#alerts = mergeAlertFeed(this.#alerts, entry.host.hostId, entry.host.label, confirmed, this.#now());
      this.#emit();
      if (!this.#disposed && this.#running && entry.state.status !== 'unsupported') {
        const baseSec = Math.max(this.#intervalSec, MIN_PROBE_INTERVAL_SEC);
        const backoffFactor = entry.failures > 0 ? Math.min(6, 2 ** entry.failures) : 1;
        this.#scheduleNext(entry, baseSec * 1000 * backoffFactor);
      }
    }
  }

  // Active-tab-only operational probes (never polled for background fleet hosts)
  async fetchProcesses(host: MonitorHostRef): Promise<ProcessRow[]> {
    const res = await this.#execBounded(host, buildProcessesCommand(150), 10_000, 512 * 1024);
    return parseProcessesOutput(res.stdout);
  }

  async sendProcessSignal(host: MonitorHostRef, pid: number, signal: SafeProcessSignal): Promise<void> {
    const cmd = buildProcessSignalCommand(pid, signal);
    const res = await this.#execBounded(host, cmd, 8_000, 16 * 1024);
    if (res.exitCode && res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `Signal ${signal} failed with exit code ${res.exitCode}`);
    }
  }

  async fetchServicesAndContainers(host: MonitorHostRef): Promise<{
    services: SystemdServiceRow[];
    containers: ContainerRow[];
  }> {
    const res = await this.#execBounded(host, buildServicesAndContainersCommand(), 10_000, 512 * 1024);
    return parseServicesAndContainersOutput(res.stdout);
  }

  async fetchServiceLogs(host: MonitorHostRef, unit: string, lines = 120): Promise<string> {
    const res = await this.#execBounded(host, buildServiceLogsCommand(unit, lines), 10_000, 512 * 1024);
    return res.stdout || res.stderr || '(no log output)';
  }

  async fetchContainerLogs(host: MonitorHostRef, runtime: 'docker' | 'podman', id: string, lines = 120): Promise<string> {
    const res = await this.#execBounded(host, buildContainerLogsCommand(runtime, id, lines), 10_000, 512 * 1024);
    return res.stdout || res.stderr || '(no log output)';
  }

  async fetchPorts(host: MonitorHostRef): Promise<{ ports: PortRow[]; summary: SocketSummary }> {
    const res = await this.#execBounded(host, buildPortsCommand(), 10_000, 512 * 1024);
    return parsePortsOutput(res.stdout);
  }

  async fetchSystemAudit(host: MonitorHostRef): Promise<SystemAuditSnapshot> {
    const res = await this.#execBounded(host, buildSystemAuditCommand(), 10_000, 128 * 1024);
    return parseSystemAuditOutput(res.stdout);
  }

  async runServiceAction(host: MonitorHostRef, unit: string, action: SafeServiceAction): Promise<string> {
    const cmd = buildServiceActionCommand(unit, action);
    const res = await this.#execBounded(host, cmd, 15_000, 32 * 1024);
    if (res.exitCode && res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || `systemctl ${action} ${unit} exited with ${res.exitCode}`);
    }
    return res.stdout || `systemctl ${action} ${unit}: OK`;
  }

  async runContainerAction(
    host: MonitorHostRef,
    runtime: 'docker' | 'podman',
    id: string,
    action: SafeContainerAction,
  ): Promise<string> {
    const cmd = buildContainerActionCommand(runtime, id, action);
    const res = await this.#execBounded(host, cmd, 15_000, 32 * 1024);
    if (res.exitCode && res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || `${runtime} ${action} ${id} exited with ${res.exitCode}`);
    }
    return res.stdout || `${runtime} ${action} ${id}: OK`;
  }
}

export function isHostStateStale(state: HostRuntimeState | undefined, intervalSec: number, now = Date.now()): boolean {
  if (!state || state.status !== 'live' || !state.updatedAt) return false;
  return now - state.updatedAt > Math.max(5_000, intervalSec * 2_500);
}
