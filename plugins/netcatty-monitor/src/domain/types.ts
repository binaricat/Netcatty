export type MonitorInterval = 1 | 2 | 3 | 5 | 10 | 30 | 60;
export type MonitorRangeMinutes = 1 | 5 | 15 | 30 | 60;
export type MonitorViewMode = 'charts' | 'list' | 'wallboard' | 'compare';
export type MonitorHostStatus =
  | 'idle'
  | 'queued'
  | 'connecting'
  | 'live'
  | 'offline'
  | 'login'
  | 'error'
  | 'unsupported'
  | 'disconnected';

export type MonitorOsFamily = 'linux' | 'macos' | 'freebsd' | 'openbsd' | 'netbsd' | 'windows' | 'unknown';

export type OverviewWidgetKey =
  | 'cpuBreakdown'
  | 'memoryPsi'
  | 'networkTcp'
  | 'diskIoMounts'
  | 'perCore'
  | 'gpuThermals'
  | 'systemSecurity';

export interface MonitorGpuCard {
  index: number;
  name: string;
  vendor?: 'nvidia' | 'amd' | 'intel' | 'unknown';
  utilization: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  temperatureC?: number | null;
  powerWatts?: number | null;
}

export interface MonitorThermalSensor {
  id: string;
  label: string;
  temperatureC: number;
  criticalC?: number | null;
}

export interface MonitorPsiMetrics {
  cpuSome10: number | null;
  cpuSome60: number | null;
  memSome10: number | null;
  memSome60: number | null;
  memFull10: number | null;
  ioSome10: number | null;
  ioSome60: number | null;
  ioFull10: number | null;
}

export interface MonitorDiskRow {
  mountPoint: string;
  used: number | null;
  total: number | null;
  percent: number | null;
  inodeUsed?: number | null;
  inodeTotal?: number | null;
  inodePercent?: number | null;
  capacityKey?: string;
  filesystemType?: string;
  diskReadSpeed?: number | null;
  diskWriteSpeed?: number | null;
}

export interface MonitorNetInterface {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxSpeed: number;
  txSpeed: number;
  rxPackets?: number;
  txPackets?: number;
  rxPps?: number;
  txPps?: number;
  rxErrors?: number;
  txErrors?: number;
  rxDrops?: number;
  txDrops?: number;
}

export interface MonitorTopProcess {
  pid: string;
  memPercent: number;
  command: string;
}

export interface MonitorStats {
  osFamily: MonitorOsFamily;
  cpu: number | null;
  cpuUser?: number | null;
  cpuSystem?: number | null;
  cpuIdle?: number | null;
  cpuIowait?: number | null;
  cpuSteal?: number | null;
  cpuCores: number | null;
  cpuPerCore: number[];
  contextSwitchesPerSec?: number | null;
  interruptsPerSec?: number | null;
  procsRunning?: number | null;
  procsBlocked?: number | null;
  gpu: number | null;
  gpuName: string | null;
  gpuMemUsed: number | null;
  gpuMemTotal: number | null;
  gpus: MonitorGpuCard[];
  thermals: MonitorThermalSensor[];
  psi?: MonitorPsiMetrics | null;
  memTotal: number | null;
  memUsed: number | null;
  memFree: number | null;
  memActive?: number | null;
  memSlab?: number | null;
  memBuffers: number | null;
  memCached: number | null;
  swapTotal: number | null;
  swapUsed: number | null;
  topProcesses: MonitorTopProcess[];
  diskPercent: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  disks: MonitorDiskRow[];
  diskReadSpeed: number | null;
  diskWriteSpeed: number | null;
  diskReadIops?: number | null;
  diskWriteIops?: number | null;
  diskUtilPercent?: number | null;
  diskQueueDepth?: number | null;
  networkReady: boolean;
  netRxSpeed: number;
  netTxSpeed: number;
  netRxPps?: number;
  netTxPps?: number;
  netErrorsDelta?: number;
  netDropsDelta?: number;
  tcpRetransmitsPerSec?: number | null;
  fdUsed?: number | null;
  fdMax?: number | null;
  activeUsers?: number | null;
  rebootRequired?: boolean;
  latencyMs: number | null;
  responseLatencyMs: number | null;
  netInterfaces: MonitorNetInterface[];
  hostname: string;
  osName: string;
  kernelRelease: string;
  uptimeSeconds: number | null;
  loadAverage: number[];
}

export interface MonitorPoint {
  at: number;
  cpu: number | null;
  cpuUser?: number | null;
  cpuSystem?: number | null;
  cpuIowait?: number | null;
  cpuSteal?: number | null;
  memory: number | null;
  swap?: number | null;
  disk: number | null;
  rx: number | null;
  tx: number | null;
  diskRead: number | null;
  diskWrite: number | null;
  diskIops?: number | null;
  latencyMs: number | null;
}

export interface MonitorHostRef {
  hostId: string;
  label: string;
  hostname?: string;
  port?: number;
  username?: string;
  protocol?: string;
  group?: string;
  tags?: string[];
  notes?: string;
  os?: string;
  hostBindingToken?: string;
}

export interface MonitorPanel {
  id: string;
  name: string;
  description: string;
  hostIds: string[];
  view: MonitorViewMode;
  interval: MonitorInterval;
  range: MonitorRangeMinutes;
  sort: 'manual' | 'name' | 'health' | 'cpu' | 'memory';
  compareHostIds?: string[];
}

export interface ProcessRow {
  pid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  rssKb: number;
  state: string;
  elapsed: string;
  command: string;
}

export interface SystemdServiceRow {
  unit: string;
  loadState: string;
  activeState: string;
  subState: string;
  description: string;
}

export interface ContainerRow {
  runtime: 'docker' | 'podman';
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface PortRow {
  protocol: string;
  state: string;
  localAddress: string;
  port: number | null;
  peerAddress: string;
  process: string;
  pid: number | null;
}

export interface SocketSummary {
  total: number;
  established: number;
  listen: number;
  synRecv: number;
  timeWait: number;
  closeWait: number;
  other: number;
}

export interface SystemAuditSnapshot {
  fdUsed: number | null;
  fdMax: number | null;
  loggedInUsers: Array<{ user: string; tty: string; from: string; since: string }>;
  recentLogins: string[];
  failedAuthCount: number | null;
  rebootRequired: boolean;
}

export type AlertMetric =
  | 'cpu'
  | 'cpuIowait'
  | 'memory'
  | 'swap'
  | 'disk'
  | 'inode'
  | 'loadPerCore'
  | 'netDrops'
  | 'latencyMs'
  | 'offline'
  | 'failedServices'
  | 'containerDown';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertThresholds {
  cpuWarning: number;
  cpuCritical: number;
  iowaitWarning: number;
  iowaitCritical: number;
  memoryWarning: number;
  memoryCritical: number;
  swapWarning: number;
  swapCritical: number;
  diskWarning: number;
  diskCritical: number;
  inodeWarning: number;
  inodeCritical: number;
  loadPerCoreWarning: number;
  loadPerCoreCritical: number;
  netDropsWarning: number;
  netDropsCritical: number;
  latencyWarningMs: number;
  latencyCriticalMs: number;
  consecutivePolls: number;
  alertOnOffline: boolean;
}

export interface AlertEvent {
  id: string;
  hostId: string;
  hostLabel: string;
  metric: AlertMetric;
  severity: AlertSeverity;
  value: number | null;
  threshold: number | null;
  message: string;
  startedAt?: number;
  at: number;
  acknowledged: boolean;
  resolvedAt?: number | null;
}

export interface HealthSummary {
  score: number;
  level: 'healthy' | 'warning' | 'critical' | 'offline' | 'pending';
  badges: Array<{ metric: AlertMetric; severity: AlertSeverity; label: string }>;
}

export interface MonitorProbeResult {
  reachable: boolean;
  protocol: 'rdp' | 'vnc' | 'ssh';
  port: number;
  rttMs: number | null;
  bannerVerified: boolean;
  bannerDetail?: string;
  error?: string;
  checkedAt: number;
}

export interface HostRuntimeState {
  hostId: string;
  mode?: 'ssh' | 'probe';
  status: MonitorHostStatus;
  error?: string | null;
  updatedAt: number;
  stats: MonitorStats | null;
  probe?: MonitorProbeResult | null;
  points: MonitorPoint[];
  lastCommandDurationMs?: number | null;
}
