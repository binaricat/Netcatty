import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorEngine } from '../src/services/monitorEngine.js';
import type { MonitorHostBridge } from '../src/services/hostBridge.js';

function createMockBridge(handler: (cmd: string) => { stdout: string; latencyMs?: number }): MonitorHostBridge {
  return {
    supportsHostExec: true,
    supportsHostProbe: true,
    async selectHosts() {
      return [];
    },
    async resolveHostBindings() {
      return [];
    },
    async revokeHostBinding() {
      return true;
    },
    async execHostCommand({ command }) {
      const res = handler(command);
      return {
        stdout: res.stdout,
        stderr: '',
        exitCode: 0,
        latencyMs: res.latencyMs ?? 15,
        responseLatencyMs: 20,
      };
    },
    async probeHost({ protocol = 'rdp', port = 3389 }) {
      return {
        reachable: true,
        protocol,
        port,
        rttMs: 28,
        bannerVerified: true,
        bannerDetail: 'RDP-TLS',
        checkedAt: Date.now(),
      };
    },
    async openHostSession() {
      return true;
    },
    async setViewBadge() {},
    async copyText() {
      return true;
    },
    async confirmAction() {
      return true;
    },
    async saveJsonSnapshot() {
      return true;
    },
    async saveMarkdownReport() {
      return true;
    },
    async loadStorage() {
      return undefined;
    },
    async saveStorage() {},
  };
}

test('MonitorEngine polls Linux host, fetches separate disks + GPU, records history & operational tabs', async () => {
  let clock = 1_000_000;
  let cpuTick = 0;
  const bridge = createMockBridge((cmd) => {
    if (cmd.includes('OSFAM:linux')) {
      cpuTick += 1;
      const total = 1000 + cpuTick * 200;
      const idle = 500 + cpuTick * 100;
      return {
        stdout: `OSFAM:linux|CPURAW:${total} ${idle} 4 0|CORES:4|PERCORERAW:250:125,250:125|MEMINFO:8192 2048 256 1024 1024 1024|NET:eth0:${cpuTick * 10000}:${cpuTick * 5000}|DISKIO:${100 + cpuTick * 5};sda:100:200|PARTITIONIO:|DISKMOUNTS:|THERMALS:cpu:48000|HOST:node-1|OS:Debian 12|KERNEL:6.1.0|UPTIME:5000|LOAD:0.40 0.35 0.30`,
        latencyMs: 18,
      };
    }
    if (cmd.includes('DISKS:$disks')) {
      return { stdout: 'DISKS:/:40.0:100.0:40:fs=ext4:/dev/sda1' };
    }
    if (cmd.includes('nvidia-smi')) {
      return { stdout: 'GPU:62 4096 16384 NVIDIA L4 ;; 0\tNVIDIA L4\t62\t4096\t16384\t54\t70.0' };
    }
    if (cmd.includes('__NC_SYSTEMD__')) {
      return { stdout: '__NC_SYSTEMD__\nsshd.service loaded active running OpenSSH\n__NC_DOCKER__\n__NC_PODMAN__' };
    }
    if (cmd.includes('__NC_PORTS__')) {
      return { stdout: '__NC_PORTS__\ntcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=100,fd=3))\n__NC_SOCKSUMMARY__\nLISTEN:1' };
    }
    if (cmd.includes('ps -axo pid=')) {
      return { stdout: ' 100 root 5.0 1.2 12000 Ss 10:00 /usr/sbin/sshd -D' };
    }
    return { stdout: '' };
  });

  const engine = new MonitorEngine(bridge, { now: () => clock });
  const host = { hostId: 'hb_node1', hostBindingToken: 'hb_node1', label: 'Node 1', hostname: '10.0.0.10' };

  engine.reconcileHosts([host], { running: true, interval: 60 });
  await new Promise((r) => setTimeout(r, 40));

  const snap1 = engine.getSnapshot();
  assert.equal(snap1.hosts['hb_node1']?.status, 'live');
  assert.equal(snap1.hosts['hb_node1']?.stats?.disks[0]?.mountPoint, '/');
  assert.equal(snap1.hosts['hb_node1']?.stats?.gpu, 62);
  assert.equal(snap1.hosts['hb_node1']?.points.length, 1);

  // Trigger second sample after advancing clock
  clock += 5000;
  engine.refreshAllNow();
  await new Promise((r) => setTimeout(r, 40));

  const snap2 = engine.getSnapshot();
  assert.equal(snap2.hosts['hb_node1']?.stats?.cpu, 50);
  assert.equal(snap2.hosts['hb_node1']?.points.length, 2);

  // Active-tab probes
  const procs = await engine.fetchProcesses(host);
  assert.equal(procs.length, 1);
  assert.equal(procs[0].pid, 100);

  const { services } = await engine.fetchServicesAndContainers(host);
  assert.equal(services.length, 1);
  assert.equal(services[0].unit, 'sshd.service');

  const { ports, summary } = await engine.fetchPorts(host);
  assert.equal(ports.length, 1);
  assert.equal(summary.listen, 1);

  engine.dispose();
});

test('MonitorEngine caps concurrent execs at 12 and handles stale detection + Windows fallback', async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  const bridge: MonitorHostBridge = {
    supportsHostExec: true,
    supportsHostProbe: true,
    async selectHosts() { return []; },
    async resolveHostBindings() { return []; },
    async revokeHostBinding() { return true; },
    async probeHost({ protocol = 'rdp', port = 3389 }) {
      return { reachable: true, protocol, port, rttMs: 20, bannerVerified: true, checkedAt: Date.now() };
    },
    async execHostCommand({ command }) {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      if (command.includes('powershell')) {
        return {
          stdout: 'OSFAM:windows|CPU:28|CORES:4|MEMINFO:8192 4096 0 0 0 0|DISKS:C::50.0:200.0:25:NTFS|HOST:WIN-01|OS:Windows Server 2022|KERNEL:10.0|UPTIME:1200',
          stderr: '',
          exitCode: 0,
          latencyMs: 12,
          responseLatencyMs: 16,
        };
      }
      return {
        stdout: 'UNSUPPORTED_OS:MINGW64_NT',
        stderr: '',
        exitCode: 0,
        latencyMs: 12,
        responseLatencyMs: 16,
      };
    },
    async openHostSession() { return true; },
    async setViewBadge() {},
    async copyText() { return true; },
    async confirmAction() { return true; },
    async saveJsonSnapshot() { return true; },
    async saveMarkdownReport() { return true; },
    async loadStorage() { return undefined; },
    async saveStorage() {},
  };

  const engine = new MonitorEngine(bridge);
  const hosts = Array.from({ length: 20 }, (_, i) => ({
    hostId: `hb_win_${i}`,
    hostBindingToken: `hb_win_${i}`,
    label: `win-${i}`,
  }));

  try {
    engine.reconcileHosts(hosts, { running: true, interval: 60 });
    await new Promise((r) => setTimeout(r, 140));
    assert.ok(peakInFlight <= 12, `Expected concurrency <= 12, observed ${peakInFlight}`);
    const snap = engine.getSnapshot();
    const liveCount = Object.values(snap.hosts).filter((h) => h.status === 'live' && h.stats?.osFamily === 'windows').length;
    assert.equal(liveCount, 20);
  } finally {
    engine.dispose();
  }
});

test('MonitorEngine probes standalone RDP/VNC hosts via vault.probeHost and records RTT history & offline alerts', async () => {
  let probeOk = true;
  const bridge: MonitorHostBridge = {
    supportsHostExec: true,
    supportsHostProbe: true,
    async selectHosts() { return []; },
    async resolveHostBindings() { return []; },
    async revokeHostBinding() { return true; },
    async execHostCommand() {
      throw new Error('SSH exec should not be called for RDP probe hosts');
    },
    async probeHost({ protocol = 'rdp', port = 3389 }) {
      return probeOk
        ? { reachable: true, protocol, port, rttMs: 32, bannerVerified: true, bannerDetail: 'RDP-NLA', checkedAt: Date.now() }
        : { reachable: false, protocol, port, rttMs: null, bannerVerified: false, error: 'Connection refused', checkedAt: Date.now() };
    },
    async openHostSession() { return true; },
    async setViewBadge() {},
    async copyText() { return true; },
    async confirmAction() { return true; },
    async saveJsonSnapshot() { return true; },
    async saveMarkdownReport() { return true; },
    async loadStorage() { return undefined; },
    async saveStorage() {},
  };

  const engine = new MonitorEngine(bridge);
  const rdpHost = { hostId: 'hb_rdp_1', hostBindingToken: 'hb_rdp_1', label: 'Win Jump', hostname: '10.0.5.8', port: 3389, protocol: 'rdp' };

  try {
    engine.reconcileHosts([rdpHost], { running: true, interval: 60 });
    await new Promise((r) => setTimeout(r, 40));
    const snap1 = engine.getSnapshot();
    assert.equal(snap1.hosts['hb_rdp_1']?.mode, 'probe');
    assert.equal(snap1.hosts['hb_rdp_1']?.status, 'live');
    assert.equal(snap1.hosts['hb_rdp_1']?.probe?.rttMs, 32);
    assert.equal(snap1.hosts['hb_rdp_1']?.probe?.bannerVerified, true);
    assert.equal(snap1.hosts['hb_rdp_1']?.points[0]?.latencyMs, 32);
    assert.equal(snap1.alerts.filter((a) => !a.resolvedAt).length, 0);

    probeOk = false;
    engine.refreshAllNow();
    await new Promise((r) => setTimeout(r, 40));
    const snap2 = engine.getSnapshot();
    assert.equal(snap2.hosts['hb_rdp_1']?.status, 'offline');
    assert.equal(snap2.alerts.some((a) => a.hostId === 'hb_rdp_1' && a.metric === 'offline' && !a.resolvedAt), true);
  } finally {
    engine.dispose();
  }
});

test('MonitorEngine enforces alert hysteresis and supports system audit + service/container actions', async () => {
  let clock = 2_000_000;
  let latency = 240; // breaches 180ms warning threshold
  const executedCommands: string[] = [];
  const bridge = createMockBridge((cmd) => {
    executedCommands.push(cmd);
    if (cmd.includes('OSFAM:linux')) {
      return {
        stdout:
          'OSFAM:linux|CPURAW:1000 500 20 5 300 150|CPUEXTRA:5000 1000 2 0|CORES:4|PERCORERAW:250:125,250:125|MEMINFO:8192 2048 256 1024 1024 1024 2048 512|NET:eth0:10000:5000:100:50:0:0:0:0|TCPRETRANS:12|DISKIO:100;sda:100:200:50:80:400:1|PARTITIONIO:|DISKMOUNTS:|FD:1200:65536|USERS:2|REBOOT:1|THERMALS:|HOST:node-hyst|OS:Ubuntu 24.04|KERNEL:6.8.0|UPTIME:5000|LOAD:0.40 0.35 0.30',
        latencyMs: latency,
      };
    }
    if (cmd.includes('DISKS:$disks')) {
      return { stdout: 'DISKS:/:40.0:100.0:40:fs=ext4:/dev/sda1|INODES:/:12000:100000:12' };
    }
    if (cmd.includes('__NC_FD__')) {
      return {
        stdout: [
          '__NC_FD__',
          '1200:65536',
          '__NC_REBOOT__',
          '1',
          '__NC_WHO__',
          'ops pts/0 2026-11-28 08:00 (10.0.0.5)',
          '__NC_LAST__',
          'ops pts/0 10.0.0.5 Sat Nov 28 08:00 still logged in',
          '__NC_FAILEDAUTH__',
          '4',
        ].join('\n'),
      };
    }
    return { stdout: 'ok' };
  });

  const engine = new MonitorEngine(bridge, { now: () => clock });
  const host = { hostId: 'hb_hyst', hostBindingToken: 'hb_hyst', label: 'Node Hyst', hostname: '10.0.0.99' };

  try {
    // Poll 1: single latency breach is suppressed by default consecutivePolls=2 hysteresis
    engine.reconcileHosts([host], { running: true, interval: 60 });
    await new Promise((r) => setTimeout(r, 40));
    const snap1 = engine.getSnapshot();
    assert.equal(snap1.hosts['hb_hyst']?.stats?.rebootRequired, true);
    assert.equal(snap1.hosts['hb_hyst']?.stats?.disks[0]?.inodePercent, 12);
    assert.equal(snap1.alerts.filter((a) => !a.resolvedAt).length, 0);

    // Poll 2: consecutive breach fires the warning alert
    clock += 5000;
    engine.refreshAllNow();
    await new Promise((r) => setTimeout(r, 40));
    const snap2 = engine.getSnapshot();
    assert.equal(snap2.alerts.some((a) => a.hostId === 'hb_hyst' && a.metric === 'latencyMs' && !a.resolvedAt), true);

    // Poll 3: recovery resolves the alert
    latency = 15;
    clock += 5000;
    engine.refreshAllNow();
    await new Promise((r) => setTimeout(r, 40));
    const snap3 = engine.getSnapshot();
    assert.equal(snap3.alerts.filter((a) => !a.resolvedAt).length, 0);

    // System audit + service/container lifecycle actions
    const audit = await engine.fetchSystemAudit(host);
    assert.equal(audit.fdUsed, 1200);
    assert.equal(audit.fdMax, 65536);
    assert.equal(audit.loggedInUsers.length, 1);
    assert.equal(audit.failedAuthCount, 4);
    assert.equal(audit.rebootRequired, true);
    assert.equal(audit.recentLogins.length, 1);

    await engine.runServiceAction(host, 'nginx.service', 'restart');
    assert.ok(executedCommands.some((c) => c.includes("systemctl restart 'nginx.service'")));

    await engine.runContainerAction(host, 'docker', 'a1b2c3d4e5f6', 'restart');
    assert.ok(executedCommands.some((c) => c.includes("docker restart 'a1b2c3d4e5f6'")));
  } finally {
    engine.dispose();
  }
});
