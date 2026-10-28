const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const shellPath = value => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
const { execFileSync } = require("node:child_process");
const { DISK_IO_ASSIGNMENT, PARTITION_IO_ASSIGNMENT, parseDiskIo, diskIoRates, withPartitionIo } = require("./monitorDiskIo.cjs");
const unknown = { diskReadSpeed: null, diskWriteSpeed: null };

test("mount rates isolate partitions, support shared devices and escaped mounts, and tolerate unrelated hotplug", () => {
  const disks = ["/", "/data space", "/bind", "/pool"].map(mountPoint => ({ mountPoint }));
  const mounts = "/:8-1,/data\\040space:253-0,/bind:8-1,/pool:0-42,";
  const previous = parseDiskIo("10;8-1:100:200,253-0:10:20,");
  const current = parseDiskIo("12;8-1:104:208,253-0:30:60,8-2:0:0,");
  const result = withPartitionIo(disks, mounts, current, previous);
  assert.deepEqual(result.slice(0, 3).map(({ diskReadSpeed, diskWriteSpeed }) => ({ diskReadSpeed, diskWriteSpeed })), [
    { diskReadSpeed: 1024, diskWriteSpeed: 2048 },
    { diskReadSpeed: 5120, diskWriteSpeed: 10240 },
    { diskReadSpeed: 1024, diskWriteSpeed: 2048 },
  ]);
  assert.equal(result[3], disks[3]);
  for (const snapshot of [null, parseDiskIo("12;8-1:99:200,253-0:10:20,")]) {
    assert.deepEqual(withPartitionIo(disks, mounts, snapshot, previous)[0], { mountPoint: "/" });
  }
  assert.deepEqual(withPartitionIo(disks, mounts, current, null)[0], { mountPoint: "/" });
});

test("partition collection reads hundreds of devices with two awk processes", () => {
  const dir = mkdtempSync(join(tmpdir(), "partition-io-"));
  try {
    const block = join(dir, "block");
    mkdirSync(block);
    writeFileSync(join(dir, "uptime"), "123.45 100.00\n");
    writeFileSync(join(dir, "mountinfo"), "1 0 8:1 / / rw - ext4 /dev/root rw\n2 0 253:0 / /data rw - ext4 /dev/mapper/data rw\n");
    const names = Array.from({ length: 256 }, (_, index) => `8-${index + 1}`);
    names.push("253-0");
    for (const name of names) {
      // Use portable fixture names; Linux kernel names use a colon.
      mkdirSync(join(block, name.replace(":", "-")));
      writeFileSync(join(block, name.replace(":", "-"), "stat"), "1 2 100 4 5 6 200\n");
    }
    const command = PARTITION_IO_ASSIGNMENT
      .replaceAll("/proc/uptime", shellPath(join(dir, "uptime")))
      .replaceAll("/sys/dev/block", shellPath(block))
      .replaceAll("/proc/self/mountinfo", shellPath(join(dir, "mountinfo")));
    const count = shellPath(join(dir, "awk-count"));
    const output = execFileSync("sh", ["-c", `awk() { printf x >> ${count}; command awk "$@"; }; ${command}; printf '%s|%s|' "$partitionio" "$diskmounts"; cat ${count}`], { encoding: "utf8" });
    const [counters, mounts, processes] = output.split("|");
    assert.deepEqual([...parseDiskIo(counters).devices.keys()].sort(), names.sort());
    assert.equal(processes, "xx", "device count must not increase awk process count");
    assert.equal(mounts, "/:8-1,/data:253-0,");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disk rates use remote fractional sample time and fixed 512-byte sectors", () => {
  const before = parseDiskIo("100.25;sda:100:200,nvme0n1:50:100,");
  const after = parseDiskIo("101.75;nvme0n1:80:140,sda:130:220,");
  assert.deepEqual(diskIoRates(after, before), { diskReadSpeed: 20480, diskWriteSpeed: 20480 });
  assert.deepEqual(diskIoRates(parseDiskIo("102.75;nvme0n1:80:140,sda:130:220,"), after), { diskReadSpeed: 0, diskWriteSpeed: 0 });
});

test("first sample, unavailable counters, reset, and topology changes never look idle", () => {
  const before = parseDiskIo("100;sda:100:200,");
  assert.deepEqual(diskIoRates(before, null), unknown);
  assert.deepEqual(diskIoRates(null, before), unknown);
  for (const text of ["100;sda:110:210", "99;sda:110:210", "101;sda:99:210", "101;sda:110:199", "101;sdb:110:210", "101;sda:110:210,sdb:0:0"]) {
    assert.deepEqual(diskIoRates(parseDiskIo(text), before), unknown, text);
  }
  for (const text of [undefined, "", "100;", "NaN;sda:1:2", "100;sda:-1:2", "100;sda:1:NaN", "100;sda:1:2,sda:1:2", "100;sda:9007199254740992:1", "100;sda:1:2:3", "100;sda:1:2;extra"]) {
    assert.equal(parseDiskIo(text), null, String(text));
  }
});

test("Linux collection includes whole hardware devices, excludes partitions and stacked devices", () => {
  const dir = mkdtempSync(join(tmpdir(), "disk-io-"));
  try {
    const block = join(dir, "block");
    mkdirSync(block);
    writeFileSync(join(dir, "uptime"), "123.45 100.00\n");
    for (const name of ["sda", "nvme0n1", "dm-0", "md0", "loop0", "zram0"]) {
      mkdirSync(join(block, name));
      writeFileSync(join(block, name, "stat"), "1 2 100 4 5 6 200 8 9 10 11\n");
      if (["sda", "nvme0n1"].includes(name)) mkdirSync(join(block, name, "device"));
    }
    mkdirSync(join(block, "sda", "sda1"));
    writeFileSync(join(block, "sda", "sda1", "stat"), "1 2 100 4 5 6 200\n");
    const command = DISK_IO_ASSIGNMENT.replaceAll("/proc/uptime", shellPath(join(dir, "uptime"))).replaceAll("/sys/block", shellPath(block));
    const output = execFileSync("sh", ["-c", `${command}; printf '%s' "$diskio"`], { encoding: "utf8" });
    const parsed = parseDiskIo(output);
    assert.equal(parsed.timestamp, 123.45);
    assert.deepEqual([...parsed.devices.keys()].sort(), ["nvme0n1", "sda"]);
    assert.deepEqual(parsed.devices.get("sda"), { readSectors: 100, writeSectors: 200 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
