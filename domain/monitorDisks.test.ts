import test from "node:test";
import assert from "node:assert/strict";
import { buildMonitorDiskListLayout, sortMonitorDisks } from "./monitorDisks";

test("list mounts put root first, group system paths, and naturally sort data paths", () => {
  const paths = ["/bd10", "/home", "/var/log", "/bd03", "/usr/local", "/boot/efi", "/", "/srv", "/bd02", "/etc", "/opt", "/tmp", "/boot", "/bd01", "/var", "/usr", "/bd2/archive10", "/bd2/archive2"];
  const disks = paths.map(mountPoint => ({ mountPoint }));
  assert.deepEqual(sortMonitorDisks(disks).map(disk => disk.mountPoint), [
    "/", "/boot", "/boot/efi", "/etc", "/usr", "/usr/local", "/var", "/var/log", "/home", "/opt", "/srv", "/tmp",
    "/bd01", "/bd02", "/bd2/archive2", "/bd2/archive10", "/bd03", "/bd10",
  ]);
  assert.deepEqual(disks.map(disk => disk.mountPoint), paths);
});

test("healthy system mounts collapse while root and naturally sorted data mounts remain visible", () => {
  const disks = ["/bd10", "/boot/efi", "/", "/bd02", "/boot"].map(mountPoint => ({ mountPoint, percent: 80 }));
  const layout = buildMonitorDiskListLayout({ disks });
  assert.deepEqual(layout.rows.map(row => row.kind === "disk" ? row.disk.mountPoint : "system"), ["/", "/bd02", "/bd10", "system"]);
  assert.equal(layout.forcedExpanded, false);
  assert.equal(layout.expanded, false);
  assert.deepEqual(layout.rows.at(-1), { kind: "system", count: 2, expanded: false, alert: false });
  const expanded = buildMonitorDiskListLayout({ disks }, true);
  assert.deepEqual(expanded.rows.slice(-2).map(row => row.kind === "disk" && row.disk.mountPoint), ["/boot", "/boot/efi"]);
});

test("only finite system usage above 80 forces expansion and highlights the affected mount", () => {
  for (const percent of [80.1, 81, 100]) {
    const layout = buildMonitorDiskListLayout({ disks: [
      { mountPoint: "/", percent: 99 }, { mountPoint: "/boot", percent: 30 },
      { mountPoint: "/boot/efi", percent }, { mountPoint: "/data", percent: 99 },
    ] });
    assert.equal(layout.forcedExpanded, true);
    assert.equal(layout.expanded, true);
    assert.deepEqual(layout.rows.filter(row => row.kind === "disk" && row.alert)
      .map(row => row.kind === "disk" && row.disk.mountPoint), ["/boot/efi"]);
  }
  for (const percent of [null, NaN, Infinity, 0, 80]) {
    assert.equal(buildMonitorDiskListLayout({ disks: [{ mountPoint: "/boot", percent }] }).forcedExpanded, false);
  }
  assert.equal(buildMonitorDiskListLayout({ disks: [{ mountPoint: "/", percent: 99 }, { mountPoint: "/data", percent: 99 }] }).forcedExpanded, false);
});

test("similar data mount names are not treated as system directories", () => {
  const disks = ["/various", "/data", "/boot-data", "/var/log", "/"].map(mountPoint => ({ mountPoint }));
  assert.deepEqual(sortMonitorDisks(disks).map(disk => disk.mountPoint), ["/", "/var/log", "/boot-data", "/data", "/various"]);
  assert.deepEqual(sortMonitorDisks([]), []);
});
