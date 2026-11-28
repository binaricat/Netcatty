import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContainerActionCommand,
  buildContainerLogsCommand,
  buildLinuxDiskCommand,
  buildPortsCommand,
  buildPrimaryStatsCommand,
  buildProcessSignalCommand,
  buildServiceActionCommand,
  buildServiceLogsCommand,
  buildSystemAuditCommand,
  DROPBEAR_MAX_COMMAND_BYTES,
} from '../src/domain/collectors.js';
import {
  parsePortsOutput,
  parsePrimaryStatsOutput,
  parseProcessesOutput,
  parseServicesAndContainersOutput,
  parseSystemAuditOutput,
} from '../src/domain/parsers.js';

const HOST_EXEC_MAX_BYTES = 8192;

test('collector commands stay well below Dropbear and host-exec 8192-byte limits', () => {
  const primary = buildPrimaryStatsCommand();
  const linuxDisk = buildLinuxDiskCommand();
  const audit = buildSystemAuditCommand();
  assert.ok(Buffer.byteLength(primary, 'utf8') < Math.min(DROPBEAR_MAX_COMMAND_BYTES, HOST_EXEC_MAX_BYTES), `primary=${Buffer.byteLength(primary, 'utf8')}`);
  assert.ok(Buffer.byteLength(linuxDisk, 'utf8') < Math.min(DROPBEAR_MAX_COMMAND_BYTES, HOST_EXEC_MAX_BYTES), `disk=${Buffer.byteLength(linuxDisk, 'utf8')}`);
  assert.ok(Buffer.byteLength(buildPortsCommand(), 'utf8') < HOST_EXEC_MAX_BYTES);
  assert.ok(Buffer.byteLength(audit, 'utf8') < HOST_EXEC_MAX_BYTES);
});

test('command builders reject shell injection on unit/container/pid and build lifecycle actions', () => {
  assert.throws(() => buildServiceLogsCommand('nginx; rm -rf /'));
  assert.throws(() => buildServiceActionCommand('nginx && id', 'restart'));
  assert.throws(() => buildContainerLogsCommand('docker', '$(whoami)'));
  assert.throws(() => buildContainerActionCommand('docker', 'abc;rm', 'restart'));
  assert.throws(() => buildProcessSignalCommand(1, 'SIGKILL'));
  assert.throws(() => buildProcessSignalCommand(-5, 'SIGTERM'));
  assert.equal(buildProcessSignalCommand(4242, 'SIGTERM'), 'kill -s SIGTERM 4242');
  assert.match(buildServiceLogsCommand('nginx.service', 80), /journalctl -u 'nginx\.service' -n 80/);
  assert.match(buildServiceActionCommand('nginx.service', 'reload'), /systemctl reload 'nginx\.service'/);
  assert.match(buildContainerLogsCommand('podman', 'web_api-1', 50), /podman logs --tail 50 --timestamps 'web_api-1'/);
  assert.equal(buildContainerActionCommand('docker', 'a1b2c3d4e5f6', 'restart'), "docker restart 'a1b2c3d4e5f6' 2>&1");
});

test('parsePrimaryStatsOutput computes Linux CPU/per-core/net/disk-IO deltas accurately', () => {
  const sample1 =
    'OSFAM:linux|CPURAW:1000 500 20 10|CORES:2|PERCORERAW:500:250,500:250|MEMINFO:16384 2048 512 4096 4096 3072|NET:eth0:100000:50000|DISKIO:100.0;nvme0n1:100:200|PARTITIONIO:100.0;259-1:100:200|DISKMOUNTS:/:259-1,|THERMALS:x86_pkg_temp:54500,acpitz:42000|HOST:prod-web-01|OS:Ubuntu 24.04.1 LTS|KERNEL:6.8.0-45-generic|UPTIME:86400|LOAD:0.84 0.72 0.65';
  const diskStdout = 'DISKS:/:40.000000:100.000000:40:fs=ext4:/dev/nvme0n1p1,/var:12.000000:50.000000:24:fs=ext4:/dev/nvme0n1p2';

  const r1 = parsePrimaryStatsOutput(sample1, {}, { now: 100_000, latencyMs: 24, linuxDiskStdout: diskStdout });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.equal(r1.stats.osFamily, 'linux');
  assert.equal(r1.stats.cpu, null); // First delta sample
  assert.equal(r1.stats.cpuCores, 2);
  assert.equal(r1.stats.memTotal, 16384);
  assert.equal(r1.stats.memUsed, 16384 - 2048 - 512 - 4096);
  assert.equal(r1.stats.swapTotal, 4096);
  assert.equal(r1.stats.swapUsed, 1024);
  assert.equal(r1.stats.networkReady, false);
  assert.equal(r1.stats.thermals.length, 2);
  assert.equal(r1.stats.thermals[0].temperatureC, 54.5);
  assert.equal(r1.stats.disks.length, 2);
  assert.equal(r1.stats.diskPercent, 40);

  // 2 seconds later
  const sample2 =
    'OSFAM:linux|CPURAW:1200 550 30 14|CORES:2|PERCORERAW:600:270,600:280|MEMINFO:16384 2048 512 4096 4096 3072|NET:eth0:120000:60000|DISKIO:102.0;nvme0n1:140:280|PARTITIONIO:102.0;259-1:140:280|DISKMOUNTS:/:259-1,|THERMALS:x86_pkg_temp:56000|HOST:prod-web-01|OS:Ubuntu 24.04.1 LTS|KERNEL:6.8.0-45-generic|UPTIME:86402|LOAD:1.10 0.80 0.70';
  const r2 = parsePrimaryStatsOutput(sample2, r1.nextDelta, { now: 102_000, latencyMs: 22, linuxDiskStdout: diskStdout });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  // totalDelta=200, idleDelta=50 -> 75% CPU, iowaitDelta=10 -> 5.0%, stealDelta=4 -> 2.0%
  assert.equal(r2.stats.cpu, 75);
  assert.equal(r2.stats.cpuIowait, 5);
  assert.equal(r2.stats.cpuSteal, 2);
  assert.deepEqual(r2.stats.cpuPerCore, [80, 70]);
  assert.equal(r2.stats.networkReady, true);
  assert.equal(r2.stats.netRxSpeed, 10_000);
  assert.equal(r2.stats.netTxSpeed, 5_000);
  assert.equal(r2.stats.diskReadSpeed, (40 * 512) / 2);
  assert.equal(r2.stats.diskWriteSpeed, (80 * 512) / 2);
  assert.equal(r2.stats.disks[0].diskReadSpeed, (40 * 512) / 2);
});

test('parsePrimaryStatsOutput handles macOS and Windows payloads', () => {
  const mac =
    'OSFAM:macos|CPU:32|CORES:10|MEMINFO:32768 4096 0 8192 2048 1536|DISKS:/:120.5:500.0:24:apfs:/dev/disk3|NET:en0:5000:2500|HOST:mac-studio|OS:macOS 15.2|KERNEL:24.2.0|UPTIME:12345|LOAD:1.25 1.10 0.95';
  const macRes = parsePrimaryStatsOutput(mac, {}, { now: 10_000, latencyMs: 9 });
  assert.equal(macRes.ok, true);
  if (macRes.ok) {
    assert.equal(macRes.stats.osFamily, 'macos');
    assert.equal(macRes.stats.cpu, 32);
    assert.equal(macRes.stats.disks[0].mountPoint, '/');
    assert.equal(macRes.stats.swapUsed, 512);
  }

  const win =
    'OSFAM:windows|CPU:44|CORES:8|MEMINFO:16384 6144 0 0 0 0|DISKS:C::82.4:256.0:32:NTFS|HOST:WIN-SRV01|OS:Windows Server 2022|KERNEL:10.0.20348|UPTIME:43200';
  const winRes = parsePrimaryStatsOutput(win, {}, { now: 10_000 });
  assert.equal(winRes.ok, true);
  if (winRes.ok) {
    assert.equal(winRes.stats.osFamily, 'windows');
    assert.equal(winRes.stats.cpu, 44);
    assert.equal(winRes.stats.disks[0].mountPoint, 'C:');
    assert.equal(winRes.stats.disks[0].percent, 32);
  }
});

test('parseProcessesOutput parses ps rows cleanly', () => {
  const out = `
 1234 root      42.5  3.2 128000 Ssl  02:14:09 /usr/bin/dockerd -H fd://
  882 postgres  12.0 18.4 940120 Ss   3-01:22:10 postgres: writer process
`;
  const rows = parseProcessesOutput(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 1234);
  assert.equal(rows[0].cpuPercent, 42.5);
  assert.equal(rows[0].command, '/usr/bin/dockerd -H fd://');
  assert.equal(rows[1].user, 'postgres');
});

test('parseServicesAndContainersOutput parses systemd + docker + podman', () => {
  const out = [
    '__NC_SYSTEMD__',
    'nginx.service loaded active running A high performance web server',
    'redis-server.service loaded failed failed Advanced key-value store',
    '__NC_DOCKER__',
    'a1b2c3d4e5f67890\tapi-gateway\tnginx:1.27\trunning\tUp 4 days\t0.0.0.0:443->443/tcp',
    '__NC_PODMAN__',
    'ff00112233445566\tworker-1\tghcr.io/app/worker:latest\texited\tExited (0) 2 hours ago\t',
  ].join('\n');
  const { services, containers } = parseServicesAndContainersOutput(out);
  assert.equal(services.length, 2);
  assert.equal(services[1].activeState, 'failed');
  assert.equal(containers.length, 2);
  assert.equal(containers[0].runtime, 'docker');
  assert.equal(containers[0].id, 'a1b2c3d4e5f6');
  assert.equal(containers[1].runtime, 'podman');
});

test('parsePortsOutput parses ss, lsof, and socket summary', () => {
  const out = [
    '__NC_PORTS__',
    'tcp   LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=912,fd=3))',
    'tcp   LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=1402,fd=7))',
    'node 5501 chenqi 21u IPv4 0x123 0t0 TCP 127.0.0.1:5173 (LISTEN)',
    '__NC_SOCKSUMMARY__',
    'ESTAB:18',
    'LISTEN:6',
    'TIME-WAIT:4',
  ].join('\n');
  const { ports, summary } = parsePortsOutput(out);
  assert.equal(ports.length, 3);
  assert.equal(ports[0].port, 22);
  assert.equal(ports[0].process, 'sshd');
  assert.equal(ports[1].localAddress, '::');
  assert.equal(ports[2].port, 5173);
  assert.equal(ports[2].process, 'node');
  assert.equal(summary.established, 18);
  assert.equal(summary.listen, 6);
  assert.equal(summary.timeWait, 4);
  assert.equal(summary.total, 28);
});

test('parsePrimaryStatsOutput parses commercial telemetry (CPU breakdown, PSI, Inodes, pps/drops, TCP retrans, FD/reboot)', () => {
  const sample1 =
    'OSFAM:linux|CPURAW:1000 500 20 10 350 120|CPUEXTRA:10000 4000 3 1|CORES:2|PERCORERAW:500:250,500:250|MEMINFO:16384 2048 512 4096 4096 3072 6144 1024|PSI:1.25,0.80,0.50,0.40,0.10,2.75,2.10,0.80|NET:eth0:100000:50000:1000:500:1:2:3:4|TCPRETRANS:100|DISKIO:100.0;nvme0n1:100:200:50:80:1000:2|PARTITIONIO:|DISKMOUNTS:|FD:4096:65536|USERS:3|REBOOT:1|THERMALS:|HOST:prod-db-01|OS:Ubuntu 24.04|KERNEL:6.8.0|UPTIME:86400|LOAD:1.20 1.00 0.90';
  const diskStdout = 'DISKS:/:40.0:100.0:40:fs=ext4:/dev/nvme0n1p1|INODES:/:85000:100000:85';
  const r1 = parsePrimaryStatsOutput(sample1, {}, { now: 100_000, latencyMs: 18, linuxDiskStdout: diskStdout });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;

  assert.equal(r1.stats.memActive, 6144);
  assert.equal(r1.stats.memSlab, 1024);
  assert.equal(r1.stats.psi?.cpuSome10, 1.25);
  assert.equal(r1.stats.psi?.ioFull10, 0.8);
  assert.equal(r1.stats.fdUsed, 4096);
  assert.equal(r1.stats.fdMax, 65536);
  assert.equal(r1.stats.activeUsers, 3);
  assert.equal(r1.stats.rebootRequired, true);
  assert.equal(r1.stats.disks[0].inodePercent, 85);
  assert.equal(r1.stats.disks[0].inodeUsed, 85000);

  // 2 seconds later
  const sample2 =
    'OSFAM:linux|CPURAW:1200 550 30 14 430 176|CPUEXTRA:16000 6000 5 2|CORES:2|PERCORERAW:600:270,600:280|MEMINFO:16384 2048 512 4096 4096 3072 6144 1024|PSI:2.00,1.10,0.40,0.30,0.10,3.50,2.50,1.00|NET:eth0:120000:60000:1400:700:2:5:4:9|TCPRETRANS:110|DISKIO:102.0;nvme0n1:140:280:250:180:1600:4|PARTITIONIO:|DISKMOUNTS:|FD:4200:65536|USERS:3|REBOOT:1|THERMALS:|HOST:prod-db-01|OS:Ubuntu 24.04|KERNEL:6.8.0|UPTIME:86402|LOAD:1.40 1.05 0.92';
  const r2 = parsePrimaryStatsOutput(sample2, r1.nextDelta, { now: 102_000, latencyMs: 20, linuxDiskStdout: diskStdout });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;

  assert.equal(r2.stats.cpu, 75);
  assert.equal(r2.stats.cpuUser, 40);
  assert.equal(r2.stats.cpuSystem, 28);
  assert.equal(r2.stats.cpuIowait, 5);
  assert.equal(r2.stats.cpuSteal, 2);
  assert.equal(r2.stats.cpuIdle, 25);
  assert.equal(r2.stats.contextSwitchesPerSec, 3000);
  assert.equal(r2.stats.interruptsPerSec, 1000);
  assert.equal(r2.stats.procsRunning, 5);
  assert.equal(r2.stats.procsBlocked, 2);
  assert.equal(r2.stats.netRxPps, 200);
  assert.equal(r2.stats.netTxPps, 100);
  assert.equal(r2.stats.netErrorsDelta, 2);
  assert.equal(r2.stats.netDropsDelta, 8);
  assert.equal(r2.stats.tcpRetransmitsPerSec, 5);
  assert.equal(r2.stats.diskReadIops, 100);
  assert.equal(r2.stats.diskWriteIops, 50);
  assert.equal(r2.stats.diskUtilPercent, 30);
  assert.equal(r2.stats.diskQueueDepth, 4);
});

test('parseSystemAuditOutput and SYN-RECV socket summary parse cleanly', () => {
  const audit = parseSystemAuditOutput(
    [
      '__NC_FD__',
      '2048:131072',
      '__NC_REBOOT__',
      '1',
      '__NC_WHO__',
      'root pts/0 2026-11-28 09:00',
      'ops pts/1 2026-11-28 09:15 (10.0.0.10)',
      '__NC_LAST__',
      'ops pts/1 10.0.0.10 Sat Nov 28 09:15 still logged in',
      'wtmp begins Fri Nov 1 00:00:00 2026',
      '__NC_FAILEDAUTH__',
      '14',
    ].join('\n'),
  );
  assert.equal(audit.fdUsed, 2048);
  assert.equal(audit.fdMax, 131072);
  assert.equal(audit.loggedInUsers.length, 2);
  assert.equal(audit.failedAuthCount, 14);
  assert.equal(audit.rebootRequired, true);
  assert.equal(audit.recentLogins.length, 1);

  const { summary } = parsePortsOutput('__NC_PORTS__\n__NC_SOCKSUMMARY__\nESTAB:10\nSYN-RECV:3\nLISTEN:4');
  assert.equal(summary.synRecv, 3);
  assert.equal(summary.total, 17);
});
