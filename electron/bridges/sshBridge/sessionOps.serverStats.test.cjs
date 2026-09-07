const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");

const { createSessionOpsApi } = require("./sessionOps.cjs");

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function unwrapExecShC(command) {
  const prefix = "exec sh -c ";
  if (!String(command).startsWith(prefix)) return command;
  const quoted = command.slice(prefix.length);
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) return command;
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}
const { selectServerStatsFixtureOutput } = require("./serverStatsTestHelpers.cjs");
const {
  borrowTransport,
  createTransport,
  findTransportByEndpoint,
  getTransportStats,
  resetSshTransportRegistryForTests,
} = require("../sshConnectionPool.cjs");

// A fake ssh2 exec stream that emits the canned stdout then closes.
function fakeStream(stdout) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    if (stdout) stream.emit("data", Buffer.from(stdout));
    stream.emit("close", 0);
  };
  stream.write = () => true;
  setImmediate(send);
  return stream;
}

// A fake connection whose exec() always returns the same canned Linux stats
// line so getServerStats parses a successful result.
function fakeConn(stdout) {
  return {
    exec(command, cb) {
      cb(null, fakeStream(selectServerStatsFixtureOutput(command, stdout)));
    },
  };
}

// Minimal Linux stats payload: enough for the parser to report success
// (memTotal present). CPU needs two samples for a delta, which is fine — the
// success gate only requires cpu OR memTotal OR cpuCores to be non-null.
const LINUX_STATS =
  "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:|NET:";
const MACOS_STATS =
  "NC_LATENCY_MARK|CPU:27|CORES:10|MEMINFO:32768 4096 0 8192 2048 1536|PROCS:123;1.2;Finder|DISKS:/:120:460:26:apfs:/dev/disk3|NET:en0:1000:3000";

function makeSessionOps(sessions) {
  return createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    measureTcpConnectLatency: async () => 3,
    // The rest of the sessionOps surface isn't exercised by getServerStats.
  });
}

function runStatsCommandWithBusyBoxTools(command) {
  command = unwrapExecShC(command);
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 4; }",
    "ps() { return 1; }",
    "top() {",
    "  printf '%s\\n' 'Mem: 256000K used, 768000K free, 0K shrd, 0K buff, 0K cached'",
    "  printf '%s\\n' 'CPU:   0% usr   0% sys   0% nic 100% idle   0% io   0% irq   0% sirq'",
    "  printf '%s\\n' '  PID  PPID USER     STAT   VSZ %VSZ %CPU COMMAND'",
    "  printf '%s\\n' '    1     0 root     S     2048   2%   3% /sbin/procd'",
    "}",
    "mount() { return 1; }",
    "df() {",
    "  if [ \"$1\" = '-kPT' ]; then return 1; fi",
    "  if [ \"$1\" = '-BG' ]; then return 1; fi",
    "  printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    "  printf '%s\\n' 'overlayfs:/overlay 1048576 262144 786432 25% /'",
    "  printf '%s\\n' '/dev/loop0 131072 131072 0 100% /snap/example/1'",
    "}",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

function runStatsCommandWithBusyBoxSmpTop(command) {
  command = unwrapExecShC(command);
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 4; }",
    "ps() { return 1; }",
    "top() {",
    "  printf '%s\\n' 'Mem: 256000K used, 768000K free, 0K shrd, 0K buff, 0K cached'",
    "  printf '%s\\n' 'CPU:   0% usr   0% sys   0% nic 100% idle   0% io   0% irq   0% sirq'",
    "  printf '%s\\n' '  PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND'",
    "  printf '%s\\n' '    1     0 root     S     2048   2.0   0   3.0 /sbin/procd sh -c echo a,b|c'",
    "}",
    "df() { return 1; }",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

// Proxmox LXC (CT) guests often expose ZFS datasets / host bind mounts as the
// df "Filesystem" column instead of /dev/* block devices.
function runStatsCommandWithPveCtDf(command) {
  command = unwrapExecShC(command);
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 2; }",
    "ps() { return 1; }",
    "top() { return 1; }",
    "mount() { return 1; }",
    "df() {",
    "  path=",
    "  for a in \"$@\"; do",
    "    case \"$a\" in /*) path=$a ;; esac",
    "  done",
    "  if [ \"$1\" = '-kPT' ]; then",
    "    printf '%s\\n' 'Filesystem Type 1024-blocks Used Available Capacity Mounted on'",
    "    if [ -n \"$path\" ]; then",
    "      printf '%s\\n' 'rpool/data/subvol-101-disk-0 zfs 8388608 1048576 7340032 13% /'",
    "      return 0",
    "    fi",
    "    printf '%s\\n' 'rpool/data/subvol-101-disk-0 zfs 8388608 1048576 7340032 13% /'",
    "    printf '%s\\n' 'rpool/data/subvol-101-disk-1 zfs 20971520 5242880 15728640 25% /mnt/data'",
    "    printf '%s\\n' '/tank/shared ext4 104857600 52428800 52428800 50% /srv'",
    "    printf '%s\\n' 'tmpfs tmpfs 102400 100 102300 1% /run'",
    "    printf '%s\\n' 'udev devtmpfs 1024652 0 1024652 0% /dev'",
    "    printf '%s\\n' '/dev/loop0 squashfs 131072 131072 0 100% /snap/example/1'",
    "    printf '%s\\n' 'rpool/data/subvol-101-disk-2 zfs 4194304 1048576 3145728 - /mnt/scratch'",
    "    return 0",
    "  fi",
    "  printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    "  if [ -n \"$path\" ]; then",
    "    printf '%s\\n' 'rpool/data/subvol-101-disk-0 8388608 1048576 7340032 13% /'",
    "    return 0",
    "  fi",
    "  printf '%s\\n' 'rpool/data/subvol-101-disk-0 8388608 1048576 7340032 13% /'",
    "  printf '%s\\n' 'rpool/data/subvol-101-disk-1 20971520 5242880 15728640 25% /mnt/data'",
    "  printf '%s\\n' '/tank/shared 104857600 52428800 52428800 50% /srv'",
    "  printf '%s\\n' 'tmpfs 102400 100 102300 1% /run'",
    "  printf '%s\\n' 'udev 1024652 0 1024652 0% /dev'",
    "  printf '%s\\n' '/dev/loop0 131072 131072 0 100% /snap/example/1'",
    "  printf '%s\\n' 'rpool/data/subvol-101-disk-2 4194304 1048576 3145728 - /mnt/scratch'",
    "}",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

test("getServerStats falls back to BusyBox tools and excludes loop-backed images", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "router.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithBusyBoxTools(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.topProcesses, [
    { pid: "1", memPercent: 2, command: "/sbin/procd" },
  ]);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 0.25, total: 1, percent: 25, capacityKey: "overlayfs:/overlay" },
  ]);
  assert.equal(result.stats.diskPercent, 25);
});

test("getServerStats keeps PVE CT ZFS/bind mounts and recovers dash Capacity", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "ct.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithPveCtDf(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 1, total: 8, percent: 13, capacityKey: "rpool/data/subvol-101-disk-0", filesystemType: "zfs" },
    { mountPoint: "/mnt/data", used: 5, total: 20, percent: 25, capacityKey: "rpool/data/subvol-101-disk-1", filesystemType: "zfs" },
    { mountPoint: "/srv", used: 50, total: 100, percent: 50, capacityKey: "/tank/shared", filesystemType: "ext4" },
    { mountPoint: "/mnt/scratch", used: 1, total: 4, percent: 25, capacityKey: "rpool/data/subvol-101-disk-2", filesystemType: "zfs" },
  ]);
  assert.equal(result.stats.diskPercent, 13);
  assert.equal(result.stats.diskUsed, 1);
  assert.equal(result.stats.diskTotal, 8);
});

// rclone / CloudDrive / union-style FUSE mounts expose cloud quotas that should
// not inflate System Overview disk totals after the PVE CT filter broadening.
function runStatsCommandWithNetworkFuseDf(command, { forceLegacy = false } = {}) {
  command = unwrapExecShC(command);
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 2; }",
    "ps() { return 1; }",
    "top() { return 1; }",
    "mount() {",
    "  printf '%s\\n' 'remote:gdrive on /mnt/rclone type fuse.rclone (rw)'",
    "  printf '%s\\n' 'remote:gdrive on /mnt/gdrive type fuse.rclone (rw)'",
    "  printf '%s\\n' 'user@host:/media on /mnt/sshfs type fuse.sshfs (rw)'",
    "  printf '%s\\n' 'CloudNAS on /CloudNAS type fuse.CloudDrive (rw)'",
    "  printf '%s\\n' 'ufs-backend on /mnt/ufs type fuse.ufs (rw)'",
    "  printf '%s\\n' 'nas.local:/volume1/media on /mnt/nas type nfs4 (rw)'",
    "  printf '%s\\n' '//nas.local/share on /mnt/smb type cifs (rw)'",
    "  printf '%s\\n' 'mergerfs on /mnt/pool type fuse.mergerfs (rw)'",
    "  printf '%s\\n' 'gluster on /mnt/gluster type fuse.glusterfs (rw)'",
    "  printf '%s\\n' 'ceph-fuse on /mnt/ceph type fuse.ceph-fuse (rw)'",
    "  printf '%s\\n' 'unionfs on /mnt/unionfs type fuse.unionfs-fuse (rw)'",
    "  printf '%s\\n' 'CloudFS on /mnt/CloudNAS/openlist type fuse (rw)'",
    "}",
    "df() {",
    ...(forceLegacy ? ["  if [ \"$1\" = '-kPT' ]; then return 1; fi"] : []),
    "  path=",
    "  for a in \"$@\"; do",
    "    case \"$a\" in /*) path=$a ;; esac",
    "  done",
    "  if [ \"$1\" = '-kPT' ]; then",
    "    printf '%s\\n' 'Filesystem Type 1024-blocks Used Available Capacity Mounted on'",
    "    if [ -n \"$path\" ]; then",
    "      printf '%s\\n' '/dev/sda1 ext4 104857600 20971520 83886080 20% /'",
    "      return 0",
    "    fi",
    "    printf '%s\\n' '/dev/sda1 ext4 104857600 20971520 83886080 20% /'",
    "    printf '%s\\n' '/dev/sdb1 ext4 52428800 10485760 41943040 20% /data'",
    "    printf '%s\\n' 'remote:gdrive fuse.rclone 1073741824 536870912 536870912 50% /mnt/rclone'",
    "    printf '%s\\n' 'user@host:/media fuse.sshfs 2147483648 1073741824 1073741824 50% /mnt/sshfs'",
    "    printf '%s\\n' 'CloudNAS fuse.CloudDrive 4294967296 2147483648 2147483648 50% /CloudNAS'",
    "    printf '%s\\n' 'ufs-backend fuse.ufs 1048576000 524288000 524288000 50% /mnt/ufs'",
    "    printf '%s\\n' 'nas.local:/volume1/media nfs4 20971520000 8388608000 12582912000 40% /mnt/nas'",
    "    printf '%s\\n' '//nas.local/share cifs 10485760000 4194304000 6291456000 40% /mnt/smb'",
    "    printf '%s\\n' 'mergerfs fuse.mergerfs 31457280000 9437184000 22020096000 30% /mnt/pool'",
    "    printf '%s\\n' 'gluster fuse.glusterfs 15728640000 7340032000 8388608000 47% /mnt/gluster'",
    "    printf '%s\\n' 'ceph-fuse fuse.ceph-fuse 12582912000 6291456000 6291456000 50% /mnt/ceph'",
    "    printf '%s\\n' 'unionfs fuse.unionfs-fuse 8388608000 2097152000 6291456000 25% /mnt/unionfs'",
    "    printf '%s\\n' 'CloudFS fuse 10995116277760 0 10995116277760 0% /mnt/CloudNAS/openlist'",
    "    printf '%s\\n' 'tmpfs tmpfs 102400 100 102300 1% /run'",
    "    return 0",
    "  fi",
    "  printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    "  if [ -n \"$path\" ]; then",
    "    printf '%s\\n' '/dev/sda1 104857600 20971520 83886080 20% /'",
    "    return 0",
    "  fi",
    "  printf '%s\\n' '/dev/sda1 104857600 20971520 83886080 20% /'",
    "  printf '%s\\n' '/dev/sdb1 52428800 10485760 41943040 20% /data'",
    "  printf '%s\\n' 'fuse.rclone 1073741824 536870912 536870912 50% /mnt/rclone'",
    "  printf '%s\\n' 'remote:gdrive:media 2147483648 1073741824 1073741824 50% /mnt/gdrive'",
    "  printf '%s\\n' 'user@host:/media 2147483648 1073741824 1073741824 50% /mnt/sshfs'",
    "  printf '%s\\n' 'CloudDrive 4294967296 2147483648 2147483648 50% /CloudNAS/CloudDrive'",
    "  printf '%s\\n' 'ufs 1048576000 524288000 524288000 50% /mnt/ufs'",
    "  printf '%s\\n' 'nas.local:/volume1/media 20971520000 8388608000 12582912000 40% /mnt/nas'",
    "  printf '%s\\n' '//nas.local/share 10485760000 4194304000 6291456000 40% /mnt/smb'",
    "  printf '%s\\n' 'mergerfs 31457280000 9437184000 22020096000 30% /mnt/pool'",
    "  printf '%s\\n' 'gluster 15728640000 7340032000 8388608000 47% /mnt/gluster'",
    "  printf '%s\\n' 'ceph-fuse 12582912000 6291456000 6291456000 50% /mnt/ceph'",
    "  printf '%s\\n' 'unionfs 8388608000 2097152000 6291456000 25% /mnt/unionfs'",
    "  printf '%s\\n' 'tmpfs 102400 100 102300 1% /run'",
    "}",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

function runStatsCommandWithRootFuseDf(command, filesystemType = "fuse.rclone") {
  command = unwrapExecShC(command);
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 2; }",
    "ps() { return 1; }",
    "top() { return 1; }",
    "mount() { return 1; }",
    "df() {",
    "  if [ \"$1\" != '-kPT' ]; then return 1; fi",
    "  printf '%s\\n' 'Filesystem Type 1024-blocks Used Available Capacity Mounted on'",
    `  printf '%s\\n' 'remote:gdrive ${filesystemType} 1073741824 536870912 536870912 50% /'`,
    "}",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

test("getServerStats excludes FUSE mounts using df filesystem types", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "nas.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithNetworkFuseDf(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 20, total: 100, percent: 20, capacityKey: "/dev/sda1", filesystemType: "ext4" },
    { mountPoint: "/data", used: 10, total: 50, percent: 20, capacityKey: "/dev/sdb1", filesystemType: "ext4" },
  ]);
  assert.equal(result.stats.diskPercent, 20);
  assert.equal(result.stats.diskUsed, 20);
  assert.equal(result.stats.diskTotal, 100);
});

test("getServerStats uses mount metadata when df filesystem types are unavailable", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "legacy-fuse.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithNetworkFuseDf(command, { forceLegacy: true });
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 20, total: 100, percent: 20, capacityKey: "/dev/sda1" },
    { mountPoint: "/data", used: 10, total: 50, percent: 20, capacityKey: "/dev/sdb1" },
  ]);
  assert.equal(result.stats.diskPercent, 20);
  assert.equal(result.stats.diskUsed, 20);
  assert.equal(result.stats.diskTotal, 100);
});

function runStatsCommandWithUntypedScopedIpv6NfsDf(command) {
  command = unwrapExecShC(command);
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 2; }",
    "ps() { return 1; }",
    "top() { return 1; }",
    "mount() { return 1; }",
    "df() {",
    "  if [ \"$1\" = '-kPT' ]; then return 1; fi",
    "  printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    "  printf '%s\\n' '/dev/sda1 104857600 20971520 83886080 20% /'",
    "  printf '%s\\n' '[fe80::1%eth0]:/export 20971520000 8388608000 12582912000 40% /mnt/nfs6'",
    "  printf '%s\\n' 'ceph-fuse 12582912000 6291456000 6291456000 50% /mnt/ceph'",
    "  printf '%s\\n' 'gluster 15728640000 7340032000 8388608000 47% /mnt/gluster'",
    "}",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

test("getServerStats excludes scoped IPv6 NFS sources without filesystem types", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "nfs6.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithUntypedScopedIpv6NfsDf(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 20, total: 100, percent: 20, capacityKey: "/dev/sda1" },
  ]);
  assert.equal(result.stats.diskPercent, 20);
  assert.equal(result.stats.diskUsed, 20);
  assert.equal(result.stats.diskTotal, 100);
});

test("getServerStats does not fall back to a root FUSE quota", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "fuse-root.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithRootFuseDf(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, []);
  assert.equal(result.stats.diskPercent, null);
  assert.equal(result.stats.diskUsed, null);
  assert.equal(result.stats.diskTotal, null);
});

test("getServerStats keeps a local fuseblk root filesystem", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "ntfs-root.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithRootFuseDf(command, "fuseblk");
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 512, total: 1024, percent: 50, capacityKey: "remote:gdrive", filesystemType: "fuseblk" },
  ]);
  assert.equal(result.stats.diskPercent, 50);
  assert.equal(result.stats.diskUsed, 512);
  assert.equal(result.stats.diskTotal, 1024);
});

function runStatsCommandWithLoopRootDf(command) {
  command = unwrapExecShC(command);
  const script = [
    "uname() { printf '%s\\n' Linux; }",
    "nproc() { printf '%s\\n' 2; }",
    "ps() { return 1; }",
    "top() { return 1; }",
    "mount() { return 1; }",
    "df() {",
    "  if [ \"$1\" != '-kPT' ]; then return 1; fi",
    "  printf '%s\\n' 'Filesystem Type 1024-blocks Used Available Capacity Mounted on'",
    "  printf '%s\\n' '/dev/loop0 ext4 8388608 2097152 6291456 25% /'",
    "  printf '%s\\n' '/dev/loop1 squashfs 131072 131072 0 100% /snap/example/1'",
    "}",
    command,
  ].join("\n");
  return spawnSync("sh", ["-c", script], { encoding: "utf8" });
}

test("getServerStats keeps a loop-backed root while skipping snap loops", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "ct-loop.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithLoopRootDf(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 2, total: 8, percent: 25, capacityKey: "/dev/loop0", filesystemType: "ext4" },
  ]);
  assert.equal(result.stats.diskPercent, 25);
  assert.equal(result.stats.diskUsed, 2);
  assert.equal(result.stats.diskTotal, 8);
});

test("getServerStats reads commands after BusyBox top's CPU column", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "router.test", port: 22 },
    conn: {
      exec(command, cb) {
        const execution = runStatsCommandWithBusyBoxSmpTop(command);
        assert.equal(execution.status, 0, execution.stderr);
        cb(null, fakeStream(execution.stdout));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.topProcesses, [
    { pid: "1", memPercent: 2, command: "/sbin/procd" },
  ]);
});

test("getServerStats opens a Mosh stats companion connection when session.conn is missing", async () => {
  const sessions = new Map();
  const session = { type: "mosh", moshStatsAuth: { hostname: "h", password: "p" } };
  sessions.set("sid", session);

  let ensureCalls = 0;
  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    ensureMoshStatsConnection: async (s, id) => {
      ensureCalls += 1;
      assert.equal(s, session);
      assert.equal(id, "sid");
      // Simulate a successful companion connection. The real helper stores it
      // on moshStatsConn (NOT conn) so it stays invisible to other bridges.
      s.moshStatsConn = fakeConn(LINUX_STATS);
      return s.moshStatsConn;
    },
    measureTcpConnectLatency: async () => 3,
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(ensureCalls, 1);
  // session.conn must remain unset — only moshStatsConn carries the companion.
  assert.equal(session.conn, undefined);
  assert.equal(result.success, true);
  assert.equal(result.stats.memTotal, 8000);
  assert.equal(result.stats.cpuCores, 4);
  assert.equal(typeof result.stats.latencyMs, "number");
});

test("getServerStats fails gracefully when the companion connection cannot be established", async () => {
  const sessions = new Map();
  const session = { type: "mosh", moshStatsAuth: { hostname: "h" } };
  sessions.set("sid", session);

  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    ensureMoshStatsConnection: async () => null, // no usable auth, etc.
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, false);
  assert.match(result.error, /not connected/);
});

test("getServerStats does not touch the companion path for a normal SSH session", async () => {
  const sessions = new Map();
  const session = { type: "ssh", conn: fakeConn(LINUX_STATS) };
  sessions.set("sid", session);

  let ensureCalls = 0;
  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    ensureMoshStatsConnection: async () => {
      ensureCalls += 1;
      return null;
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(ensureCalls, 0);
  assert.equal(result.success, true);
});

test("getServerStats measures TCP connectivity instead of SSH protocol latency", async () => {
  const sessions = new Map();
  const session = {
    type: "mosh",
    hostname: "vm.example.test",
    moshStatsAuth: { hostname: "vm.example.test", port: 2222 },
    moshStatsConn: fakeConn(LINUX_STATS),
  };
  sessions.set("sid", session);

  const probes = [];
  const api = createSessionOpsApi({
    sessions,
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    measureTcpConnectLatency: async (target) => {
      probes.push(target);
      return 2;
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.latencyMs, 2);
  assert.deepEqual(probes, [{ hostname: "vm.example.test", port: 2222 }]);
});

test("getServerStats skips a misleading direct probe for jump-host sessions", async () => {
  const sessions = new Map([["sid", {
    type: "mosh",
    moshStatsAuth: { hostname: "private.example.test", port: 22, hasJumpHost: true },
    moshStatsConn: fakeConn(LINUX_STATS),
  }]]);
  let probeCalls = 0;
  const api = createSessionOpsApi({
    sessions,
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    measureTcpConnectLatency: async () => {
      probeCalls += 1;
      return 2;
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.latencyMs, null);
  assert.equal(probeCalls, 0);
});

test("getServerStats closes a blocked probe channel when stats time out", async () => {
  let fireTimeout;
  let closeCalls = 0;
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = () => true;
  stream.close = () => { closeCalls += 1; };
  const api = createSessionOpsApi({
    sessions: new Map([["sid", { type: "ssh", conn: { exec: (_command, cb) => cb(null, stream) } }]]),
    Date,
    setTimeout: (callback) => {
      fireTimeout = callback;
      return 1;
    },
    clearTimeout: () => {},
    Buffer,
    quoteShellArg,
  });

  const pending = api.getServerStats({ sender: {} }, { sessionId: "sid" });
  fireTimeout();
  const result = await pending;

  assert.equal(result.success, false);
  assert.match(result.error, /Timeout/);
  assert.equal(closeCalls, 1);
});

test("getServerStats closes a stats stream delivered after timeout", async () => {
  let execCallback;
  let fireTimeout;
  let closeCalls = 0;
  const api = createSessionOpsApi({
    sessions: new Map([["sid", {
      type: "ssh",
      conn: { exec: (_command, callback) => { execCallback = callback; } },
    }]]),
    Date,
    setTimeout: (callback) => {
      fireTimeout = callback;
      return 1;
    },
    clearTimeout: () => {},
    Buffer,
    quoteShellArg,
  });

  const pending = api.getServerStats({ sender: {} }, { sessionId: "sid" });
  fireTimeout();
  const result = await pending;
  const lateStream = new EventEmitter();
  lateStream.stderr = new EventEmitter();
  lateStream.close = () => { closeCalls += 1; };
  execCallback(null, lateStream);

  assert.equal(result.success, false);
  assert.equal(closeCalls, 1);
});

test("three stats retries on an unresponsive exec open leave no pooled transport or channel callbacks", async () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const endpoint = { hostId: "stats-host", hostname: "wedged.example", username: "root" };
  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn.pendingChannelCallbacks = [];
  conn.exec = (_command, callback) => {
    if (conn._sock.destroyed) throw new Error("Not connected");
    conn.pendingChannelCallbacks.push(callback);
  };
  conn.end = () => {};
  conn.destroy = () => {
    if (conn._sock.destroyed) return;
    conn._sock.destroyed = true;
    conn.pendingChannelCallbacks.length = 0;
    conn.emit("close");
  };
  const transport = createTransport({ conn, endpoint });
  borrowTransport(transport, { kind: "shell", holder: {} });

  const timers = [];
  const api = createSessionOpsApi({
    sessions: new Map([["sid", { type: "ssh", conn }]]),
    Date,
    setTimeout: (callback) => {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    Buffer,
    quoteShellArg,
  });

  const first = api.getServerStats({ sender: {} }, { sessionId: "sid" });
  const openingTimer = timers.find((timer) => !timer.cleared);
  assert.ok(openingTimer);
  openingTimer.callback();
  const results = [await first];
  results.push(await api.getServerStats({ sender: {} }, { sessionId: "sid" }));
  results.push(await api.getServerStats({ sender: {} }, { sessionId: "sid" }));

  assert.ok(results.every((result) => result.success === false));
  assert.equal(conn.pendingChannelCallbacks.length, 0);
  assert.equal(getTransportStats().transports, 0);
  assert.equal(findTransportByEndpoint(endpoint), null);

  const replacement = new EventEmitter();
  replacement._sock = { destroyed: false };
  replacement.end = () => {};
  const replacementTransport = createTransport({ conn: replacement, endpoint });
  assert.equal(findTransportByEndpoint(endpoint), replacementTransport);
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
});

test("getServerStats includes host identity, load average, and uptime", async () => {
  const sessions = new Map();
  const session = {
    type: "ssh",
    conn: fakeConn(
      "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:/:20:80:25|NET:eth0:1000:2000|HOST:demo-box|OS:Ubuntu 24.04 LTS|KERNEL:6.8.0|UPTIME:12345|LOAD:0.10 0.20 0.30",
    ),
  };
  sessions.set("sid", session);

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.hostname, "demo-box");
  assert.equal(result.stats.osName, "Ubuntu 24.04 LTS");
  assert.equal(result.stats.kernelRelease, "6.8.0");
  assert.equal(result.stats.uptimeSeconds, 12345);
  assert.deepEqual(result.stats.loadAverage, [0.1, 0.2, 0.3]);
});

test("getServerStats derives disk percent when the Capacity field is non-numeric", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    conn: fakeConn(
      "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:/:1:8:-:rpool/data/subvol-101-disk-0|NET:",
    ),
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.deepEqual(result.stats.disks, [
    { mountPoint: "/", used: 1, total: 8, percent: 13, capacityKey: "rpool/data/subvol-101-disk-0" },
  ]);
  assert.equal(result.stats.diskPercent, 13);
});

test("getServerStats keeps blank load average and uptime as missing data", async () => {
  const sessions = new Map();
  const session = {
    type: "ssh",
    conn: fakeConn(
      "CPURAW:1000 900|CORES:4|PERCORERAW:|MEMINFO:8000 4000 100 900 0 0|PROCS:|DISKS:|NET:|UPTIME:|LOAD:",
    ),
  };
  sessions.set("sid", session);

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(result.stats.uptimeSeconds, null);
  assert.deepEqual(result.stats.loadAverage, []);
});

test("getServerStats parses macOS stats and avoids blocking top command", async () => {
  const sessions = new Map();
  let command = "";
  const session = {
    type: "ssh",
    _reuseEndpoint: { hostname: "mac.example.test", port: 22 },
    conn: {
      exec(cmd, cb) {
        command = cmd;
        cb(null, fakeStream(MACOS_STATS));
      },
    },
  };
  sessions.set("sid", session);

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.match(command, /Darwin/);
  assert.match(command, /ps -A -o %cpu=/);
  assert.match(command, /awk -v c="\$cores"/);
  assert.match(command, /s=s\/c/);
  assert.match(command, /u=\(\$2-\$4\)\/1048576/);
  assert.doesNotMatch(command, /top -l/);
  assert.equal(result.stats.cpu, 27);
  assert.equal(result.stats.cpuCores, 10);
  assert.equal(result.stats.memTotal, 32768);
  assert.equal(result.stats.memUsed, 20480);
  assert.equal(result.stats.diskPercent, 26);
  assert.equal(result.stats.disks[0].capacityKey, "apfs:/dev/disk3");
  assert.equal(result.stats.netInterfaces.length, 1);
  assert.equal(result.stats.netInterfaces[0].name, "en0");
  assert.equal(result.stats.netInterfaces[0].rxBytes, 1000);
  assert.equal(result.stats.netInterfaces[0].txBytes, 3000);
  assert.equal(typeof result.stats.latencyMs, "number");
});

test("getServerStats keeps every remote command within Dropbear's command limit", async () => {
  const commands = [];
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "openwrt.example.test", port: 22 },
    conn: {
      exec(command, cb) {
        commands.push(command);
        const output = command.includes("CPURAW:")
          ? `NC_LATENCY_MARK|${LINUX_STATS}`
          : command.includes("DISKS:")
            ? "DISKS:"
            : "";
        cb(null, fakeStream(output));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(commands.length, 2, "Linux base and disk stats must use separate commands");
  for (const command of commands) {
    assert.ok(
      Buffer.byteLength(command, "utf8") <= 9000,
      `remote command is ${Buffer.byteLength(command, "utf8")} bytes`,
    );
  }
});

test("getServerStats settles when the split disk command fails", async () => {
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    conn: {
      exec(command, cb) {
        if (command.includes('echo "DISKS:$disks"')) {
          cb(new Error("disk stats rejected"));
          return;
        }
        cb(null, fakeStream(`NC_LATENCY_MARK|${LINUX_STATS}`));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await Promise.race([
    api.getServerStats({ sender: {} }, { sessionId: "sid" }),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 100)),
  ]);

  assert.notEqual(result.timedOut, true);
  assert.equal(result.success, false);
  assert.equal(result.error, "disk stats rejected");
});

test("getServerStats reports pending (not a hard failure) for a Mosh session before the handshake swap", async () => {
  const sessions = new Map();
  // Connected (renderer polls) but moshStatsAuth not yet assigned.
  const session = { type: "mosh" };
  sessions.set("sid", session);

  let ensureCalls = 0;
  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    ensureMoshStatsConnection: async () => {
      ensureCalls += 1;
      return null; // nothing to connect with yet
    },
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(ensureCalls, 1);
  assert.equal(result.success, false);
  // pending must be set so the renderer doesn't count this toward give-up.
  assert.equal(result.pending, true);
});

test("getServerStats reports a hard failure (not pending) once the companion permanently failed", async () => {
  const sessions = new Map();
  // moshStatsAuth present but the companion has permanently failed (e.g. auth
  // rejected) — this is a real failure, the renderer should be allowed to give
  // up.
  const session = { type: "mosh", moshStatsAuth: { hostname: "h" }, moshStatsConnFailed: true };
  sessions.set("sid", session);

  const api = createSessionOpsApi({
    get sessions() {
      return sessions;
    },
    setTimeout,
    clearTimeout,
    Buffer,
    quoteShellArg,
    ensureMoshStatsConnection: async () => null,
  });

  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, false);
  assert.notEqual(result.pending, true);
});

test("getServerStats returns an error for an unknown session", async () => {
  const sessions = new Map();
  const api = makeSessionOps(sessions);

  const result = await api.getServerStats({ sender: {} }, { sessionId: "missing" });

  assert.equal(result.success, false);
});

test("getServerStats wraps probes in a remote watchdog matching the client timeout", async () => {
  const commands = [];
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    _reuseEndpoint: { hostname: "slow.example", port: 22 },
    conn: {
      exec(command, cb) {
        commands.push(command);
        cb(null, fakeStream(LINUX_STATS));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getServerStats({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(commands.length, 2);
  for (const command of commands) {
    // The watchdog must be armed before the probe and killed after it, with
    // the same 10s bound the client enforces, so an abandoned probe cannot
    // linger and burn CPU on the remote host (#3187). It must also kill the
    // probe's whole descendant tree: a probe blocked in an external child
    // (df, ps, lsof, ...) would otherwise survive `kill -9 $$` and keep
    // holding the channel's output descriptors.
    assert.ok(
      command.startsWith('exec sh -c '),
      `missing POSIX sh wrap: ${command.slice(0, 120)}`,
    );
    assert.ok(
      command.includes('( sleep 10 &&'),
      `missing watchdog arm: ${command.slice(0, 160)}`,
    );
    assert.ok(
      command.includes('kill -9 $nc_tree "$$"'),
      "watchdog must kill the probe's descendant tree, not only the shell",
    );
    // The watchdog's stdio must be detached from the channel so its `sleep`
    // child cannot hold the channel's output descriptors open.
    assert.ok(
      command.includes(") </dev/null >/dev/null 2>&1 & nc_watchdog_pid=$!"),
      "watchdog subshell must not inherit the channel's stdio",
    );
    // Cleanup must reap the watchdog's pending `sleep` (before killing the
    // subshell, while the PPID walk can still find it): killing only the
    // subshell would leave the `sleep` alive for the full watchdog duration,
    // delaying the channel close and racing the client-side timeout.
    assert.ok(
      command.includes('kill -9 $nc_kids "$nc_watchdog_pid"'),
      "watchdog cleanup must reap the watchdog's pending sleep child",
    );
    assert.ok(
      command.includes("exit $nc_status"),
      "watchdog cleanup must preserve the probe exit status",
    );
    assert.ok(command.includes("( sleep 10 &&"), "watchdog bound must match the 10s stats run timeout");
  }
  assert.ok(commands[0].includes("NC_LATENCY_MARK"));
  assert.ok(commands[1].includes('echo "DISKS:$disks"'));
});

test("getSessionDistroInfo wraps the os-release probe in a remote watchdog", async () => {
  const commands = [];
  const sessions = new Map();
  sessions.set("sid", {
    type: "ssh",
    conn: {
      exec(command, cb) {
        commands.push(command);
        cb(null, fakeStream('NAME="UnionTech OS Server 20"\nID=uos'));
      },
    },
  });

  const api = makeSessionOps(sessions);
  const result = await api.getSessionDistroInfo({ sender: {} }, { sessionId: "sid" });

  assert.equal(result.success, true);
  assert.equal(commands.length, 1);
  assert.ok(
    commands[0].startsWith('exec sh -c '),
    "distro probe must force POSIX sh so fish/zsh login shells can parse it",
  );
  assert.ok(
    commands[0].includes('( sleep 5 &&'),
    "distro probe must carry a 5s remote watchdog",
  );
  assert.ok(
    commands[0].includes('kill -9 $nc_tree "$$"'),
    "distro watchdog must kill the probe's descendant tree, not only the shell",
  );
  assert.ok(
    commands[0].includes(") </dev/null >/dev/null 2>&1 & nc_watchdog_pid=$!"),
    "distro watchdog subshell must not inherit the channel's stdio",
  );
  assert.ok(
    commands[0].includes('kill -9 $nc_kids "$nc_watchdog_pid"'),
    "distro watchdog cleanup must reap the watchdog's pending sleep child",
  );
  assert.ok(commands[0].includes("cat /etc/os-release"));
});

for (const blocked of [false, true]) {
  test(`real distro probe ${blocked ? 'kills blocked children' : 'cleans its watchdog after success'}`, {
    skip: process.platform === 'win32', timeout: 10000,
  }, async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const directory = require('../tempDirBridge.cjs').getTempFilePath('watchdog-test');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'cat'), blocked
      ? '#!/bin/sh\nexec /bin/sleep 30\n'
      : '#!/bin/sh\nprintf probe_completed\n', { mode: 0o700 });
    const commands = [];
    const api = makeSessionOps(new Map([['watchdog-smoke', {
      type: 'ssh', conn: { exec(command, cb) { commands.push(command); cb(null, fakeStream('fixture')); } },
    }]]));
    const captured = await api.getSessionDistroInfo({}, { sessionId: 'watchdog-smoke' });
    assert.equal(captured.success, true);
    assert.equal(commands.length, 1);
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', commands[0]], {
      detached: true, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', outcome = null;
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { outcome = { code, signal }; resolve(); });
    });
    let timer;
    try {
      await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, 7000); })]);
      const ps = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
      assert.equal(ps.status, 0, ps.stderr);
      const living = ps.stdout.split('\n').map(line => line.trim().split(/\s+/))
        .filter(row => Number(row[1]) === child.pid && !row[2].startsWith('Z'));
      assert.ok(outcome, `probe did not close; descendants still alive: ${JSON.stringify(living)}`);
      assert.deepEqual(living, [], 'probe must not leave a child or watchdog sleep running');
      if (blocked) {
        assert.equal(outcome.signal, 'SIGKILL');
        assert.ok(Date.now() - started >= 4500, 'remote watchdog must own the timeout');
      } else {
        assert.equal(outcome.code, 0);
        assert.equal(output, 'probe_completed');
        assert.ok(Date.now() - started < 2000, 'success must not wait for the watchdog deadline');
      }
    } finally {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await finished;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
