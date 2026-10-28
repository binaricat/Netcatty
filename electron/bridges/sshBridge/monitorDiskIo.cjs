"use strict";

// Read whole hardware-backed block devices only. Partitions live below these
// entries; dm/md/loop/zram layers have no device link and would double-count I/O.
// Linux block-stat sectors are always 512 bytes, regardless of device sector size.
// No iostat dependency, extra exec, sampling sleep, or privileged access is needed.
const DISK_IO_ASSIGNMENT = String.raw`diskio=$(if [ -r /proc/uptime ]; then awk '{printf "%s;",$1}' /proc/uptime; for d in /sys/block/*; do [ -e "$d/device" ] && [ -r "$d/stat" ] || continue; awk -v path="$d" 'NF>=7 {n=split(path,a,"/");printf "%s:%s:%s,",a[n],$3,$7}' "$d/stat"; done; fi)`;

// Match mounts by kernel device number: aliases, LVM and bind mounts need no
// /dev name guessing. Keep these counters separate from the physical total.
const PARTITION_IO_ASSIGNMENT = String.raw`partitionio=$(if [ -r /proc/uptime ]; then awk 'NR==1 {printf "%s;",$1;next} NF>=7 {n=split(FILENAME,a,"/");gsub(/:/,"-",a[n-1]);printf "%s:%s:%s,",a[n-1],$3,$7}' /proc/uptime /sys/dev/block/*/stat 2>/dev/null; fi); diskmounts=$(awk '{gsub(/:/,"-",$3);printf "%s:%s,",$5,$3}' /proc/self/mountinfo 2>/dev/null)`;

function withPartitionIo(disks, mounts, current, previous) {
  const devices = new Map();
  for (const entry of (mounts || "").split(",")) {
    const separator = entry.lastIndexOf(":");
    if (separator < 0) continue;
    const mount = entry.slice(0, separator).replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    devices.set(mount, entry.slice(separator + 1));
  }
  return disks.map(disk => {
    const name = devices.get(disk.mountPoint);
    const sample = snapshot => snapshot?.devices.has(name)
      ? { timestamp: snapshot.timestamp, devices: new Map([[name, snapshot.devices.get(name)]]) }
      : null;
    const rates = diskIoRates(sample(current), sample(previous));
    return rates.diskReadSpeed == null ? disk : { ...disk, ...rates };
  });
}

function parseDiskIo(text) {
  if (typeof text !== "string") return null;
  const [time, counters, ...extra] = text.trim().split(";");
  const timestamp = Number(time);
  if (!time || extra.length || !Number.isFinite(timestamp) || timestamp < 0 || !counters) return null;
  const devices = new Map();
  for (const entry of counters.replace(/,$/, "").split(",")) {
    const fields = entry.split(":");
    const [name, read, write] = fields;
    if (fields.length !== 3 || !/^[a-zA-Z0-9_.!-]+$/.test(name) || devices.has(name) || !/^\d+$/.test(read) || !/^\d+$/.test(write)) return null;
    const readSectors = Number(read);
    const writeSectors = Number(write);
    if (!Number.isSafeInteger(readSectors) || !Number.isSafeInteger(writeSectors)) return null;
    devices.set(name, { readSectors, writeSectors });
  }
  return { timestamp, devices };
}

function diskIoRates(current, previous) {
  const unavailable = { diskReadSpeed: null, diskWriteSpeed: null };
  if (!current || !previous || current.devices.size !== previous.devices.size) return unavailable;
  const seconds = current.timestamp - previous.timestamp;
  if (!(seconds > 0)) return unavailable;
  let read = 0;
  let write = 0;
  for (const [name, counters] of current.devices) {
    const before = previous.devices.get(name);
    if (!before || counters.readSectors < before.readSectors || counters.writeSectors < before.writeSectors) return unavailable;
    read += (counters.readSectors - before.readSectors) * 512;
    write += (counters.writeSectors - before.writeSectors) * 512;
  }
  return { diskReadSpeed: read / seconds, diskWriteSpeed: write / seconds };
}

module.exports = { DISK_IO_ASSIGNMENT, PARTITION_IO_ASSIGNMENT, parseDiskIo, diskIoRates, withPartitionIo };
