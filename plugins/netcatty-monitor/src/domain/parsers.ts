import { diskIoRates, parseDiskIo, withPartitionIo, type DiskIoSnapshot } from './disks';
import { parseGpuStats, parseThermalSensors } from './gpu';
import type {
  ContainerRow,
  MonitorDiskRow,
  MonitorNetInterface,
  MonitorOsFamily,
  MonitorPsiMetrics,
  MonitorStats,
  MonitorTopProcess,
  PortRow,
  ProcessRow,
  SocketSummary,
  SystemAuditSnapshot,
  SystemdServiceRow,
} from './types';

interface RawNetInterfaceSample {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxPackets?: number;
  txPackets?: number;
  rxErrors?: number;
  rxDrops?: number;
  txErrors?: number;
  txDrops?: number;
}

export interface TelemetryDeltaState {
  prevCpu?: {
    total: number;
    idle: number;
    iowait: number;
    steal: number;
    user: number;
    system: number;
    ctxt?: number;
    intr?: number;
    perCore: Array<{ total: number; idle: number }>;
    timestamp: number;
  };
  prevNet?: {
    interfaces: RawNetInterfaceSample[];
    tcpRetransmits?: number | null;
    timestamp: number;
  };
  prevDiskIo?: DiskIoSnapshot | null;
  prevPartitionIo?: DiskIoSnapshot | null;
}

export interface PrimaryStatsParseResult {
  ok: true;
  stats: MonitorStats;
  needsSeparateLinuxDisks: boolean;
  nextDelta: TelemetryDeltaState;
}

export interface PrimaryStatsParseError {
  ok: false;
  unsupported?: boolean;
  error: string;
}

export function parseDisksPayload(disksStr: string): MonitorDiskRow[] {
  const disks: MonitorDiskRow[] = [];
  const trimmed = disksStr.trim();
  if (!trimmed) return disks;
  for (const entry of trimmed.split(',')) {
    const diskParts = entry.split(':');
    if (diskParts.length < 4) continue;
    let mountPoint = diskParts[0];
    let offset = 1;
    if (/^[A-Za-z]$/.test(mountPoint) && diskParts.length >= 5 && diskParts[1] === '') {
      mountPoint = `${mountPoint}:`;
      offset = 2;
    }
    const used = Number.parseFloat(diskParts[offset]);
    const total = Number.parseFloat(diskParts[offset + 1]);
    let percent = Number.parseInt(diskParts[offset + 2], 10);
    if (Number.isNaN(percent) && Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      percent = Math.round((used / total) * 100);
    }
    if (!Number.isNaN(used) && !Number.isNaN(total) && !Number.isNaN(percent) && total > 0) {
      const diskMetadata = diskParts.slice(offset + 3).join(':').trim();
      let capacityKey = diskMetadata;
      let filesystemType: string | undefined;
      if (diskMetadata.startsWith('fs=')) {
        const separator = diskMetadata.indexOf(':');
        if (separator > 3) {
          filesystemType = diskMetadata.slice(3, separator).trim();
          capacityKey = diskMetadata.slice(separator + 1).trim();
        }
      }
      disks.push({
        mountPoint,
        used,
        total,
        percent: Math.max(0, Math.min(100, percent)),
        ...(capacityKey ? { capacityKey } : {}),
        ...(filesystemType ? { filesystemType } : {}),
      });
    }
  }
  return disks;
}

export function parseInodesPayload(inodesStr: string): Map<string, { inodeUsed: number; inodeTotal: number; inodePercent: number }> {
  const map = new Map<string, { inodeUsed: number; inodeTotal: number; inodePercent: number }>();
  const trimmed = inodesStr.trim();
  if (!trimmed) return map;
  for (const entry of trimmed.split(',')) {
    const parts = entry.split(':');
    if (parts.length < 4) continue;
    const mount = parts[0];
    const used = Number.parseInt(parts[1], 10);
    const total = Number.parseInt(parts[2], 10);
    const pct = Number.parseInt(parts[3], 10);
    if (mount && Number.isFinite(used) && Number.isFinite(total) && total > 0 && Number.isFinite(pct)) {
      map.set(mount, { inodeUsed: used, inodeTotal: total, inodePercent: Math.max(0, Math.min(100, pct)) });
    }
  }
  return map;
}

function parsePsiPayload(raw: string): MonitorPsiMetrics | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cols = trimmed.split(',');
  if (cols.length < 8) return null;
  const parseNum = (s: string) => {
    const v = Number(s);
    return s !== '' && Number.isFinite(v) && v >= 0 ? v : null;
  };
  const psi: MonitorPsiMetrics = {
    cpuSome10: parseNum(cols[0]),
    cpuSome60: parseNum(cols[1]),
    memSome10: parseNum(cols[2]),
    memSome60: parseNum(cols[3]),
    memFull10: parseNum(cols[4]),
    ioSome10: parseNum(cols[5]),
    ioSome60: parseNum(cols[6]),
    ioFull10: parseNum(cols[7]),
  };
  if (Object.values(psi).every((v) => v === null)) return null;
  return psi;
}

export function parsePrimaryStatsOutput(
  rawStdout: string,
  prevDelta: TelemetryDeltaState = {},
  options: { now?: number; latencyMs?: number | null; responseLatencyMs?: number | null; linuxDiskStdout?: string } = {},
): PrimaryStatsParseResult | PrimaryStatsParseError {
  const now = options.now ?? Date.now();
  let combined = String(rawStdout || '').trim().replace(/^NC_LATENCY_MARK\|?/, '');
  if (options.linuxDiskStdout) {
    const diskTrim = String(options.linuxDiskStdout).trim();
    if (diskTrim) combined = `${combined}|${diskTrim}`;
  }
  if (!combined) {
    return { ok: false, error: 'Empty telemetry response' };
  }
  if (combined.startsWith('UNSUPPORTED_OS:')) {
    return {
      ok: false,
      unsupported: true,
      error: `Server stats not supported on this OS (${combined.slice(15).trim() || 'Unknown'})`,
    };
  }

  const parts = combined.split('|');
  let osFamily: MonitorOsFamily = 'unknown';
  let cpuDirect: number | null = null;
  let cpuRawTotal: number | null = null;
  let cpuRawIdle: number | null = null;
  let cpuRawIowait = 0;
  let cpuRawSteal = 0;
  let cpuRawUser: number | null = null;
  let cpuRawSystem: number | null = null;
  let cpuRawCtxt: number | null = null;
  let cpuRawIntr: number | null = null;
  let procsRunning: number | null = null;
  let procsBlocked: number | null = null;
  let cpuPerCoreRaw: Array<{ total: number; idle: number }> = [];
  let cpuCores: number | null = null;
  let memTotal: number | null = null;
  let memFree: number | null = null;
  let memBuffers: number | null = null;
  let memCached: number | null = null;
  let memUsed: number | null = null;
  let memActive: number | null = null;
  let memSlab: number | null = null;
  let swapTotal: number | null = null;
  let swapUsed: number | null = null;
  let psi: MonitorPsiMetrics | null = null;
  const topProcesses: MonitorTopProcess[] = [];
  let disks: MonitorDiskRow[] = [];
  let inodesMap = new Map<string, { inodeUsed: number; inodeTotal: number; inodePercent: number }>();
  let diskIo: DiskIoSnapshot | null = null;
  let partitionIo: DiskIoSnapshot | null = null;
  let diskMounts = '';
  const networkInterfaces: RawNetInterfaceSample[] = [];
  let tcpRetransmitsRaw: number | null = null;
  let fdUsed: number | null = null;
  let fdMax: number | null = null;
  let activeUsers: number | null = null;
  let rebootRequired = false;
  let hostname = '';
  let osName = '';
  let kernelRelease = '';
  let uptimeSeconds: number | null = null;
  let loadAverage: number[] = [];
  let gpu: number | null = null;
  let gpuName: string | null = null;
  let gpuMemUsed: number | null = null;
  let gpuMemTotal: number | null = null;
  let gpus: MonitorStats['gpus'] = [];
  let thermals: MonitorStats['thermals'] = [];
  let sawCpuRaw = false;

  for (const part of parts) {
    if (part.startsWith('OSFAM:')) {
      const fam = part.slice(6).trim().toLowerCase();
      if (fam === 'linux' || fam === 'macos' || fam === 'freebsd' || fam === 'openbsd' || fam === 'netbsd' || fam === 'windows') {
        osFamily = fam;
      }
    } else if (part.startsWith('CPU:')) {
      const val = Number.parseFloat(part.slice(4).trim());
      if (Number.isFinite(val)) cpuDirect = Math.min(100, Math.max(0, Math.round(val)));
    } else if (part.startsWith('PARTITIONIO:')) {
      partitionIo = parseDiskIo(part.slice(12));
    } else if (part.startsWith('DISKMOUNTS:')) {
      diskMounts = part.slice(11);
    } else if (part.startsWith('DISKIO:')) {
      diskIo = parseDiskIo(part.slice(7));
    } else if (part.startsWith('CPURAW:')) {
      sawCpuRaw = true;
      const rawParts = part.slice(7).trim().split(/\s+/);
      if (rawParts.length >= 2) {
        const t = Number.parseInt(rawParts[0], 10);
        const i = Number.parseInt(rawParts[1], 10);
        if (Number.isFinite(t) && Number.isFinite(i)) {
          cpuRawTotal = t;
          cpuRawIdle = i;
          if (rawParts.length >= 3) cpuRawIowait = Number.parseInt(rawParts[2], 10) || 0;
          if (rawParts.length >= 4) cpuRawSteal = Number.parseInt(rawParts[3], 10) || 0;
          if (rawParts.length >= 6) {
            const u = Number.parseInt(rawParts[4], 10);
            const s = Number.parseInt(rawParts[5], 10);
            if (Number.isFinite(u) && Number.isFinite(s)) {
              cpuRawUser = u;
              cpuRawSystem = s;
            }
          }
        }
      }
    } else if (part.startsWith('CPUEXTRA:')) {
      const extra = part.slice(9).trim().split(/\s+/);
      if (extra.length >= 4) {
        const cx = Number.parseInt(extra[0], 10);
        const ir = Number.parseInt(extra[1], 10);
        const pr = Number.parseInt(extra[2], 10);
        const pb = Number.parseInt(extra[3], 10);
        if (Number.isFinite(cx)) cpuRawCtxt = cx;
        if (Number.isFinite(ir)) cpuRawIntr = ir;
        if (Number.isFinite(pr)) procsRunning = pr;
        if (Number.isFinite(pb)) procsBlocked = pb;
      }
    } else if (part.startsWith('CORES:')) {
      const val = Number.parseInt(part.slice(6).trim(), 10);
      if (Number.isFinite(val) && val > 0) cpuCores = val;
    } else if (part.startsWith('PERCORERAW:')) {
      const coreStr = part.slice(11).trim();
      if (coreStr) {
        cpuPerCoreRaw = coreStr
          .split(',')
          .map((v) => {
            const coreParts = v.trim().split(':');
            if (coreParts.length >= 2) {
              const total = Number.parseInt(coreParts[0], 10);
              const idle = Number.parseInt(coreParts[1], 10);
              if (Number.isFinite(total) && Number.isFinite(idle)) return { total, idle };
            }
            return null;
          })
          .filter((v): v is { total: number; idle: number } => v !== null);
      }
    } else if (part.startsWith('MEMINFO:')) {
      const memParts = part.slice(8).trim().split(/\s+/);
      if (memParts.length >= 4) {
        const total = Number.parseInt(memParts[0], 10);
        const free = Number.parseInt(memParts[1], 10);
        const buffers = Number.parseInt(memParts[2], 10);
        const cached = Number.parseInt(memParts[3], 10);
        if (Number.isFinite(total)) memTotal = total;
        if (Number.isFinite(free)) memFree = free;
        if (Number.isFinite(buffers)) memBuffers = buffers;
        if (Number.isFinite(cached)) memCached = cached;
        if (memTotal !== null && memFree !== null && memBuffers !== null && memCached !== null) {
          memUsed = Math.max(0, memTotal - memFree - memBuffers - memCached);
        }
        if (memParts.length >= 6) {
          const st = Number.parseInt(memParts[4], 10);
          const sf = Number.parseInt(memParts[5], 10);
          if (Number.isFinite(st)) swapTotal = st;
          if (Number.isFinite(sf) && swapTotal !== null) {
            swapUsed = Math.max(0, swapTotal - sf);
          }
        }
        if (memParts.length >= 8) {
          const ac = Number.parseInt(memParts[6], 10);
          const sl = Number.parseInt(memParts[7], 10);
          if (Number.isFinite(ac)) memActive = ac;
          if (Number.isFinite(sl)) memSlab = sl;
        }
      }
    } else if (part.startsWith('PSI:')) {
      psi = parsePsiPayload(part.slice(4));
    } else if (part.startsWith('PROCS:')) {
      const procsStr = part.slice(6).trim();
      if (procsStr) {
        for (const entry of procsStr.split(',')) {
          const procParts = entry.split(';');
          if (procParts.length >= 3) {
            const pid = procParts[0];
            const memPercent = Number.parseFloat(procParts[1]);
            const command = procParts.slice(2).join(';');
            if (Number.isFinite(memPercent)) topProcesses.push({ pid, memPercent, command });
          }
        }
      }
    } else if (part.startsWith('DISKS:')) {
      disks = parseDisksPayload(part.slice(6));
    } else if (part.startsWith('INODES:')) {
      inodesMap = parseInodesPayload(part.slice(7));
    } else if (part.startsWith('NET:')) {
      const netStr = part.slice(4).trim();
      if (netStr) {
        for (const entry of netStr.split(',')) {
          const netParts = entry.split(':');
          if (netParts.length >= 3) {
            const name = netParts[0];
            const rxBytes = Number.parseInt(netParts[1], 10);
            const txBytes = Number.parseInt(netParts[2], 10);
            if (Number.isFinite(rxBytes) && Number.isFinite(txBytes)) {
              const sample: RawNetInterfaceSample = { name, rxBytes, txBytes };
              if (netParts.length >= 9) {
                sample.rxPackets = Number.parseInt(netParts[3], 10) || 0;
                sample.txPackets = Number.parseInt(netParts[4], 10) || 0;
                sample.rxErrors = Number.parseInt(netParts[5], 10) || 0;
                sample.rxDrops = Number.parseInt(netParts[6], 10) || 0;
                sample.txErrors = Number.parseInt(netParts[7], 10) || 0;
                sample.txDrops = Number.parseInt(netParts[8], 10) || 0;
              }
              networkInterfaces.push(sample);
            }
          }
        }
      }
    } else if (part.startsWith('TCPRETRANS:')) {
      const val = Number.parseInt(part.slice(11).trim(), 10);
      if (Number.isFinite(val) && val >= 0) tcpRetransmitsRaw = val;
    } else if (part.startsWith('FD:')) {
      const [u, m] = part.slice(3).trim().split(':');
      const used = Number.parseInt(u, 10);
      const max = Number.parseInt(m, 10);
      if (Number.isFinite(used) && Number.isFinite(max) && max > 0) {
        fdUsed = used;
        fdMax = max;
      }
    } else if (part.startsWith('USERS:')) {
      const val = Number.parseInt(part.slice(6).trim(), 10);
      if (Number.isFinite(val) && val >= 0) activeUsers = val;
    } else if (part.startsWith('REBOOT:')) {
      rebootRequired = part.slice(7).trim() === '1';
    } else if (part.startsWith('GPU:')) {
      ({ gpu, gpuName, gpuMemUsed, gpuMemTotal, gpus } = parseGpuStats(part));
    } else if (part.startsWith('THERMALS:')) {
      thermals = parseThermalSensors(part.slice(9));
    } else if (part.startsWith('HOST:')) {
      hostname = part.slice(5).trim();
    } else if (part.startsWith('OS:')) {
      osName = part.slice(3).trim();
    } else if (part.startsWith('KERNEL:')) {
      kernelRelease = part.slice(7).trim();
    } else if (part.startsWith('UPTIME:')) {
      const u = Number(part.slice(7).trim());
      if (part.slice(7).trim() !== '' && Number.isFinite(u) && u >= 0) uptimeSeconds = u;
    } else if (part.startsWith('LOAD:')) {
      const loadText = part.slice(5).trim();
      if (loadText) {
        loadAverage = loadText
          .split(/\s+/)
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v >= 0)
          .slice(0, 3);
      }
    }
  }

  if (osFamily === 'unknown' && sawCpuRaw) osFamily = 'linux';

  const diskRates = diskIoRates(diskIo, prevDelta.prevDiskIo);
  disks = withPartitionIo(disks, diskMounts, partitionIo, prevDelta.prevPartitionIo).map((disk) => {
    const inode = inodesMap.get(disk.mountPoint);
    return inode ? { ...disk, ...inode } : disk;
  });

  // Network rates (bytes/s, pps, errors/drops delta, TCP retransmits/s)
  const prevNet = prevDelta.prevNet;
  const timeDelta = prevNet && prevNet.timestamp > 0 ? (now - prevNet.timestamp) / 1000 : 0;
  let netRxSpeed = 0;
  let netTxSpeed = 0;
  let netRxPps = 0;
  let netTxPps = 0;
  let netErrorsDelta = 0;
  let netDropsDelta = 0;
  const netInterfaces: MonitorNetInterface[] = [];
  const networkReady = Boolean(prevNet && prevNet.timestamp > 0 && prevNet.interfaces.length > 0 && timeDelta > 0);
  for (const iface of networkInterfaces) {
    const prevIface = networkReady ? prevNet!.interfaces.find((p) => p.name === iface.name) : undefined;
    const rxDelta = prevIface ? iface.rxBytes - prevIface.rxBytes : 0;
    const txDelta = prevIface ? iface.txBytes - prevIface.txBytes : 0;
    const rxSpeed = prevIface && rxDelta > 0 ? Math.round(rxDelta / timeDelta) : 0;
    const txSpeed = prevIface && txDelta > 0 ? Math.round(txDelta / timeDelta) : 0;
    netRxSpeed += rxSpeed;
    netTxSpeed += txSpeed;

    let rxPps = 0;
    let txPps = 0;
    if (prevIface && iface.rxPackets != null && prevIface.rxPackets != null && iface.rxPackets >= prevIface.rxPackets) {
      rxPps = Math.round((iface.rxPackets - prevIface.rxPackets) / timeDelta);
      netRxPps += rxPps;
    }
    if (prevIface && iface.txPackets != null && prevIface.txPackets != null && iface.txPackets >= prevIface.txPackets) {
      txPps = Math.round((iface.txPackets - prevIface.txPackets) / timeDelta);
      netTxPps += txPps;
    }
    if (prevIface && iface.rxErrors != null && prevIface.rxErrors != null && iface.rxErrors > prevIface.rxErrors) {
      netErrorsDelta += iface.rxErrors - prevIface.rxErrors;
    }
    if (prevIface && iface.txErrors != null && prevIface.txErrors != null && iface.txErrors > prevIface.txErrors) {
      netErrorsDelta += iface.txErrors - prevIface.txErrors;
    }
    if (prevIface && iface.rxDrops != null && prevIface.rxDrops != null && iface.rxDrops > prevIface.rxDrops) {
      netDropsDelta += iface.rxDrops - prevIface.rxDrops;
    }
    if (prevIface && iface.txDrops != null && prevIface.txDrops != null && iface.txDrops > prevIface.txDrops) {
      netDropsDelta += iface.txDrops - prevIface.txDrops;
    }
    netInterfaces.push({
      ...iface,
      rxSpeed,
      txSpeed,
      rxPps,
      txPps,
    });
  }

  let tcpRetransmitsPerSec: number | null = null;
  if (
    networkReady &&
    tcpRetransmitsRaw != null &&
    prevNet?.tcpRetransmits != null &&
    tcpRetransmitsRaw >= prevNet.tcpRetransmits
  ) {
    tcpRetransmitsPerSec = Number(((tcpRetransmitsRaw - prevNet.tcpRetransmits) / timeDelta).toFixed(2));
  }

  // CPU delta + breakdown
  const prevCpu = prevDelta.prevCpu;
  let cpu: number | null = null;
  let cpuUser: number | null = null;
  let cpuSystem: number | null = null;
  let cpuIdle: number | null = null;
  let cpuIowait: number | null = null;
  let cpuSteal: number | null = null;
  let contextSwitchesPerSec: number | null = null;
  let interruptsPerSec: number | null = null;
  let cpuPerCore: number[] = [];

  if (cpuRawTotal !== null && cpuRawIdle !== null && prevCpu && prevCpu.total > 0) {
    const totalDelta = cpuRawTotal - prevCpu.total;
    const idleDelta = cpuRawIdle - prevCpu.idle;
    if (totalDelta > 0) {
      cpu = Math.max(0, Math.min(100, Math.round(100 - (idleDelta / totalDelta) * 100)));
      cpuIdle = Number(Math.max(0, Math.min(100, (idleDelta / totalDelta) * 100)).toFixed(1));
      const iowaitDelta = cpuRawIowait - prevCpu.iowait;
      const stealDelta = cpuRawSteal - prevCpu.steal;
      if (iowaitDelta >= 0) cpuIowait = Number(Math.max(0, Math.min(100, (iowaitDelta / totalDelta) * 100)).toFixed(1));
      if (stealDelta >= 0) cpuSteal = Number(Math.max(0, Math.min(100, (stealDelta / totalDelta) * 100)).toFixed(1));
      if (cpuRawUser !== null && cpuRawSystem !== null && prevCpu.user >= 0 && prevCpu.system >= 0) {
        const userDelta = cpuRawUser - prevCpu.user;
        const sysDelta = cpuRawSystem - prevCpu.system;
        if (userDelta >= 0) cpuUser = Number(Math.max(0, Math.min(100, (userDelta / totalDelta) * 100)).toFixed(1));
        if (sysDelta >= 0) cpuSystem = Number(Math.max(0, Math.min(100, (sysDelta / totalDelta) * 100)).toFixed(1));
      }
    }
    const cpuSec = (now - prevCpu.timestamp) / 1000;
    if (cpuSec > 0) {
      if (cpuRawCtxt != null && prevCpu.ctxt != null && cpuRawCtxt >= prevCpu.ctxt) {
        contextSwitchesPerSec = Math.round((cpuRawCtxt - prevCpu.ctxt) / cpuSec);
      }
      if (cpuRawIntr != null && prevCpu.intr != null && cpuRawIntr >= prevCpu.intr) {
        interruptsPerSec = Math.round((cpuRawIntr - prevCpu.intr) / cpuSec);
      }
    }
  }
  if (cpu === null && cpuDirect !== null) {
    cpu = cpuDirect;
  }

  if (cpuPerCoreRaw.length > 0 && prevCpu && prevCpu.perCore.length > 0) {
    cpuPerCore = cpuPerCoreRaw.map((core, index) => {
      const prevCore = prevCpu.perCore[index];
      if (prevCore) {
        const totalDelta = core.total - prevCore.total;
        const idleDelta = core.idle - prevCore.idle;
        if (totalDelta > 0) {
          return Math.max(0, Math.min(100, Math.round(100 - (idleDelta / totalDelta) * 100)));
        }
      }
      return 0;
    });
  } else if (cpuPerCoreRaw.length > 0) {
    cpuPerCore = cpuPerCoreRaw.map(() => 0);
  }

  if (cpu === null && memTotal === null && cpuCores === null) {
    return { ok: false, error: 'Unable to parse server stats (unsupported OS or shell)' };
  }

  const rootDisk = disks.find((d) => d.mountPoint === '/') ?? disks[0];
  const nextDelta: TelemetryDeltaState = {
    prevCpu:
      cpuRawTotal !== null && cpuRawIdle !== null
        ? {
            total: cpuRawTotal,
            idle: cpuRawIdle,
            iowait: cpuRawIowait,
            steal: cpuRawSteal,
            user: cpuRawUser ?? -1,
            system: cpuRawSystem ?? -1,
            ctxt: cpuRawCtxt ?? undefined,
            intr: cpuRawIntr ?? undefined,
            perCore: cpuPerCoreRaw,
            timestamp: now,
          }
        : prevDelta.prevCpu,
    prevNet: {
      interfaces: networkInterfaces,
      tcpRetransmits: tcpRetransmitsRaw,
      timestamp: now,
    },
    prevDiskIo: diskIo,
    prevPartitionIo: partitionIo,
  };

  return {
    ok: true,
    needsSeparateLinuxDisks: sawCpuRaw && disks.length === 0,
    nextDelta,
    stats: {
      osFamily,
      cpu,
      cpuUser,
      cpuSystem,
      cpuIdle,
      cpuIowait,
      cpuSteal,
      cpuCores,
      cpuPerCore,
      contextSwitchesPerSec,
      interruptsPerSec,
      procsRunning,
      procsBlocked,
      gpu,
      gpuName,
      gpuMemUsed,
      gpuMemTotal,
      gpus,
      thermals,
      psi,
      memTotal,
      memUsed,
      memFree,
      memActive,
      memSlab,
      memBuffers,
      memCached,
      swapTotal,
      swapUsed,
      topProcesses,
      diskPercent: rootDisk ? rootDisk.percent : null,
      diskUsed: rootDisk ? rootDisk.used : null,
      diskTotal: rootDisk ? rootDisk.total : null,
      disks,
      ...diskRates,
      networkReady,
      netRxSpeed,
      netTxSpeed,
      netRxPps,
      netTxPps,
      netErrorsDelta,
      netDropsDelta,
      tcpRetransmitsPerSec,
      fdUsed,
      fdMax,
      activeUsers,
      rebootRequired,
      latencyMs: options.latencyMs ?? null,
      responseLatencyMs: options.responseLatencyMs ?? null,
      netInterfaces,
      hostname,
      osName,
      kernelRelease,
      uptimeSeconds,
      loadAverage,
    },
  };
}

export function parseProcessesOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\S+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const cpuPercent = Number.parseFloat(match[3]);
    const memPercent = Number.parseFloat(match[4]);
    const rssKb = Number.parseInt(match[5], 10);
    if (!Number.isSafeInteger(pid) || !Number.isFinite(cpuPercent) || !Number.isFinite(memPercent)) continue;
    rows.push({
      pid,
      user: match[2],
      cpuPercent,
      memPercent,
      rssKb: Number.isFinite(rssKb) ? rssKb : 0,
      state: match[6],
      elapsed: match[7],
      command: match[8].trim(),
    });
  }
  return rows;
}

export function parseServicesAndContainersOutput(stdout: string): {
  services: SystemdServiceRow[];
  containers: ContainerRow[];
} {
  const services: SystemdServiceRow[] = [];
  const containers: ContainerRow[] = [];
  let section: 'none' | 'systemd' | 'docker' | 'podman' = 'none';

  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '__NC_SYSTEMD__') {
      section = 'systemd';
      continue;
    }
    if (trimmed === '__NC_DOCKER__') {
      section = 'docker';
      continue;
    }
    if (trimmed === '__NC_PODMAN__') {
      section = 'podman';
      continue;
    }
    if (!trimmed) continue;

    if (section === 'systemd') {
      const m = trimmed.match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (m) {
        services.push({
          unit: m[1],
          loadState: m[2],
          activeState: m[3],
          subState: m[4],
          description: m[5].trim(),
        });
      }
    } else if (section === 'docker' || section === 'podman') {
      const cols = rawLine.split('\t');
      if (cols.length >= 5) {
        const id = cols[0].trim();
        if (!id) continue;
        containers.push({
          runtime: section,
          id: id.slice(0, 12),
          name: cols[1].trim(),
          image: cols[2].trim(),
          state: cols[3].trim(),
          status: cols[4].trim(),
          ports: (cols[5] ?? '').trim(),
        });
      }
    }
  }
  return { services, containers };
}

function parseAddressPort(endpoint: string): { address: string; port: number | null } {
  const clean = endpoint.trim();
  const idx = clean.lastIndexOf(':');
  if (idx < 0) return { address: clean, port: null };
  const address = clean.slice(0, idx).replace(/^\[|\]$/g, '');
  const portStr = clean.slice(idx + 1);
  const port = /^\d+$/.test(portStr) ? Number.parseInt(portStr, 10) : null;
  return { address, port };
}

export function parsePortsOutput(stdout: string): {
  ports: PortRow[];
  summary: SocketSummary;
} {
  const ports: PortRow[] = [];
  const summary: SocketSummary = {
    total: 0,
    established: 0,
    listen: 0,
    synRecv: 0,
    timeWait: 0,
    closeWait: 0,
    other: 0,
  };
  let section: 'ports' | 'summary' = 'ports';

  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '__NC_PORTS__') {
      section = 'ports';
      continue;
    }
    if (line === '__NC_SOCKSUMMARY__') {
      section = 'summary';
      continue;
    }

    if (section === 'summary') {
      const [stateKey, countRaw] = line.split(':');
      const count = Number.parseInt(countRaw, 10);
      if (!Number.isFinite(count) || count <= 0) continue;
      summary.total += count;
      const upper = stateKey.toUpperCase();
      if (upper === 'ESTAB' || upper === 'ESTABLISHED') summary.established += count;
      else if (upper === 'LISTEN') summary.listen += count;
      else if (upper === 'SYN-RECV' || upper === 'SYN_RECV') summary.synRecv += count;
      else if (upper === 'TIME-WAIT' || upper === 'TIME_WAIT') summary.timeWait += count;
      else if (upper === 'CLOSE-WAIT' || upper === 'CLOSE_WAIT') summary.closeWait += count;
      else summary.other += count;
      continue;
    }

    const ssMatch = line.match(/^(tcp|udp|tcp6|udp6)\s+(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/i);
    if (ssMatch) {
      const { address, port } = parseAddressPort(ssMatch[3]);
      const extra = ssMatch[5] ?? '';
      const procMatch = extra.match(/"([^"]+)",pid=(\d+)/);
      ports.push({
        protocol: ssMatch[1].toLowerCase(),
        state: ssMatch[2].toUpperCase(),
        localAddress: address,
        port,
        peerAddress: ssMatch[4],
        process: procMatch ? procMatch[1] : '',
        pid: procMatch ? Number.parseInt(procMatch[2], 10) : null,
      });
      continue;
    }

    const nsMatch = line.match(/^(tcp|udp|tcp6|udp6)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(\S+)?(?:\s+(\d+)\/(\S+))?$/i);
    if (nsMatch) {
      const { address, port } = parseAddressPort(nsMatch[2]);
      ports.push({
        protocol: nsMatch[1].toLowerCase(),
        state: (nsMatch[4] && !nsMatch[4].includes('/') ? nsMatch[4] : 'LISTEN').toUpperCase(),
        localAddress: address,
        port,
        peerAddress: nsMatch[3],
        process: nsMatch[6] ?? '',
        pid: nsMatch[5] ? Number.parseInt(nsMatch[5], 10) : null,
      });
      continue;
    }

    const lsofMatch = line.match(/^(\S+)\s+(\d+)\s+\S+\s+\S+\s+(IPv[46])\s+\S+\s+\S+\s+(TCP|UDP)\s+(\S+)\s+\(LISTEN\)$/);
    if (lsofMatch) {
      const { address, port } = parseAddressPort(lsofMatch[5]);
      ports.push({
        protocol: lsofMatch[4].toLowerCase() + (lsofMatch[3] === 'IPv6' ? '6' : ''),
        state: 'LISTEN',
        localAddress: address,
        port,
        peerAddress: '*',
        process: lsofMatch[1],
        pid: Number.parseInt(lsofMatch[2], 10),
      });
    }
  }

  if (summary.total === 0 && ports.length > 0) {
    summary.listen = ports.filter((p) => p.state === 'LISTEN' || p.state === 'UNCONN').length;
    summary.total = ports.length;
  }

  return { ports, summary };
}

export function parseSystemAuditOutput(stdout: string): SystemAuditSnapshot {
  const result: SystemAuditSnapshot = {
    fdUsed: null,
    fdMax: null,
    loggedInUsers: [],
    recentLogins: [],
    failedAuthCount: null,
    rebootRequired: false,
  };
  let section: 'none' | 'fd' | 'reboot' | 'who' | 'last' | 'failed' = 'none';
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '__NC_FD__') { section = 'fd'; continue; }
    if (line === '__NC_REBOOT__') { section = 'reboot'; continue; }
    if (line === '__NC_WHO__') { section = 'who'; continue; }
    if (line === '__NC_LAST__') { section = 'last'; continue; }
    if (line === '__NC_FAILEDAUTH__') { section = 'failed'; continue; }
    if (!line) continue;

    if (section === 'fd') {
      const [u, m] = line.split(':');
      const used = Number.parseInt(u, 10);
      const max = Number.parseInt(m, 10);
      if (Number.isFinite(used) && Number.isFinite(max) && max > 0) {
        result.fdUsed = used;
        result.fdMax = max;
      }
    } else if (section === 'reboot') {
      result.rebootRequired = line === '1';
    } else if (section === 'who') {
      const m = line.match(/^(\S+)\s+(\S+)\s+(\S+\s+\S+(?:\s+\S+)?)(?:\s+\(([^)]+)\))?/);
      if (m) {
        result.loggedInUsers.push({
          user: m[1],
          tty: m[2],
          since: m[3],
          from: m[4] ?? 'local',
        });
      }
    } else if (section === 'last') {
      if (!/^wtmp begins/i.test(line) && !/^reboot\s+/i.test(line)) {
        result.recentLogins.push(line);
      }
    } else if (section === 'failed') {
      const n = Number.parseInt(line, 10);
      if (Number.isFinite(n) && n >= 0) result.failedAuthCount = n;
    }
  }
  return result;
}
