"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAcceleratorSnapshot,
  parseAscendDeviceBlock,
  parseAscendInfoTable,
  parseNvidiaDevices,
  parseNvidiaProcesses,
} = require("./gpuOps.cjs");

test("parseNvidiaDevices reads csv nounits rows", () => {
  const devices = parseNvidiaDevices(
    "0, GPU-aaa, NVIDIA GeForce RTX 4090, 42, 1024, 24576, 61, 120.5, 450.0, 35, 550.54.15\n" +
      "1, GPU-bbb, NVIDIA A100-SXM4-80GB, [N/A], 0, 81920, 38, 70.0, 400.0, [N/A], 550.54.15\n",
  );
  assert.equal(devices.length, 2);
  assert.equal(devices[0].vendor, "nvidia");
  assert.equal(devices[0].name, "NVIDIA GeForce RTX 4090");
  assert.equal(devices[0].utilizationPercent, 42);
  assert.equal(devices[0].memoryUsedMb, 1024);
  assert.equal(devices[0].memoryTotalMb, 24576);
  assert.equal(devices[1].utilizationPercent, null);
  assert.equal(devices[1].fanPercent, null);
});

test("parseNvidiaProcesses maps uuid to gpu index", () => {
  const devices = parseNvidiaDevices("0, GPU-aaa, RTX, 10, 1, 2, 30, 40, 50, 20, 1.0\n");
  const processes = parseNvidiaProcesses("GPU-aaa, 1234, python, 2048\n", devices);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].gpuIndex, 0);
  assert.equal(processes[0].pid, 1234);
  assert.equal(processes[0].processName, "python");
  assert.equal(processes[0].memoryUsedMb, 2048);
});

test("parseAscendDeviceBlock extracts usages and memory pair", () => {
  const device = parseAscendDeviceBlock(
    0,
    `
NPU ID                         : 0
Chip ID                        : 0
Product Name                   : Ascend 910B
Aicore Usage Rate(%)           : 17
HBM Usage Rate(%)              : 6
HBM Capacity(MB)               : 32768
HBM Used Memory(MB)            : 2048 / 32768
Temperature(C)                 : 41
NPU Real-time Power(W)         : 71.7
Health                         : OK
`,
  );
  assert.equal(device.vendor, "ascend");
  assert.equal(device.name, "Ascend 910B");
  assert.equal(device.utilizationPercent, 17);
  assert.equal(device.memoryUsedMb, 2048);
  assert.equal(device.memoryTotalMb, 32768);
  assert.equal(device.temperatureC, 41);
  assert.equal(device.powerDrawW, 71.7);
  assert.equal(device.health, "OK");
});

test("parseAscendDeviceBlock does not treat HBM usage rate percent as megabytes", () => {
  const device = parseAscendDeviceBlock(
    2,
    `
Product Name                   : Ascend 910B
Aicore Usage Rate(%)           : 3
HBM Usage Rate(%)              : 25
HBM Capacity(MB)               : 32768
Temperature(C)                 : 40
`,
  );
  assert.equal(device.memoryTotalMb, 32768);
  assert.equal(device.memoryUsedMb, 8192);
});

test("parseAscendProcesses accepts whitespace-delimited table rows", () => {
  const { parseAscendProcesses } = require("./gpuOps.cjs");
  const processes = parseAscendProcesses(`
| NPU Chip PID Name Memory |
| 0 0 12345 python 1024 |
| 1 0 99 train.py 2048 |
`);
  assert.equal(processes.length, 2);
  assert.equal(processes[0].gpuIndex, 0);
  assert.equal(processes[0].pid, 12345);
  assert.equal(processes[0].processName, "python");
  assert.equal(processes[0].memoryUsedMb, 1024);
  assert.equal(processes[1].pid, 99);
});

test("POSIX accelerator collector keeps sed quotes inside JSON-wrapped sh -c", () => {
  const { ACCELERATOR_COLLECT_SCRIPT } = require("./gpuOps.cjs");
  assert.match(ACCELERATOR_COLLECT_SCRIPT, /^exec sh -c "/);
  assert.match(ACCELERATOR_COLLECT_SCRIPT, /sed -n '/);
  // Outer wrapper must not use raw single quotes around the whole script body.
  assert.doesNotMatch(ACCELERATOR_COLLECT_SCRIPT, /^exec sh -c '/);
  // Always dump npu-smi info; discover IDs via info -l then info -m.
  assert.match(ACCELERATOR_COLLECT_SCRIPT, /__NC_NPU_INFO__/);
  assert.match(ACCELERATOR_COLLECT_SCRIPT, /npu-smi info -m/);
  assert.match(ACCELERATOR_COLLECT_SCRIPT, /npu-smi info 2>\/dev\/null/);
});

test("POSIX accelerator collector is syntactically valid for sh -c", () => {
  const { ACCELERATOR_COLLECT_SCRIPT } = require("./gpuOps.cjs");
  const { spawnSync } = require("node:child_process");
  // Replace remote tools with no-ops so we only validate shell syntax/runtime of wrappers.
  const dryRun = ACCELERATOR_COLLECT_SCRIPT
    .replaceAll("nvidia-smi", "false")
    .replaceAll("npu-smi", "false");
  const result = spawnSync("sh", ["-c", dryRun], { encoding: "utf8" });
  assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
  assert.match(result.stdout, /__NC_ACCEL_BEGIN__/);
  assert.match(result.stdout, /__NC_ACCEL_END__/);
});

test("listAccelerators uses PowerShell collector for local Windows sessions", async () => {
  const { createGpuOpsApi, ACCELERATOR_COLLECT_SCRIPT_WINDOWS } = require("./gpuOps.cjs");
  let seenCommand = "";
  const gpuOps = createGpuOpsApi({
    execOnSession: async () => {
      throw new Error("POSIX collector should not run on local Windows");
    },
    execOnLocalMachine: async (command) => {
      seenCommand = command;
      return {
        success: true,
        stdout: "__NC_ACCEL_BEGIN__\n__NC_NVIDIA_DEVICES__\n0, GPU-w, RTX, 1, 2, 3, 4, 5, 6, 7, 8.0\n__NC_ACCEL_END__\n",
      };
    },
    isLocalSession: () => true,
    process: { platform: "win32" },
  });

  const result = await gpuOps.listAccelerators(null, "local-1");
  assert.equal(result.success, true);
  assert.equal(seenCommand, ACCELERATOR_COLLECT_SCRIPT_WINDOWS);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].name, "RTX");
});

test("parseAscendInfoTable reads summary and chip rows", () => {
  const devices = parseAscendInfoTable(`
| NPU   Name                    | Health          | Power(W)   Temp(C)                        |
| 0     910B3                   | OK              | 71.8       42                             |
| Chip   Phy-ID   Chip-Logic-ID   AICore(%)   Memory-Usage(MB)   HBM-Usage(MB) |
| 0      0        0               12          100 / 32768         2048 / 32768  |
`);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "910B3");
  assert.equal(devices[0].utilizationPercent, 12);
  assert.equal(devices[0].memoryUsedMb, 2048);
  assert.equal(devices[0].memoryTotalMb, 32768);
  assert.equal(devices[0].temperatureC, 42);
});

test("parseAscendInfoTable reads CANN 24.x Bus-Id table with Hugepages column", () => {
  // Fixture from GitHub issue #2811 (ModelArts / Ascend 910B1, npu-smi 24.1.rc2).
  // Chip row Chip-ID is 0 while NPU ID is 6; metrics must attach to the NPU row.
  const devices = parseAscendInfoTable(`
+------------------------------------------------------------------------------------------------+
| npu-smi 24.1.rc2                       Version: 24.1.rc2                                       |
+---------------------------+---------------+----------------------------------------------------+
| NPU   Name                | Health          | Power(W)    Temp(C)           Hugepages-Usage(page)|
| Chip                      | Bus-Id          | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)        |
+===========================+===============+====================================================+
| 6     910B1               | OK            | 100.8       33                0    / 0             |
| 0                         | 0000:01:00.0  | 0           0    / 0          3384 / 65536         |
+===========================+===============+====================================================+
| No running processes found in NPU 6                                                            |
+===========================+===============+====================================================+
`);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].index, 6);
  assert.equal(devices[0].name, "910B1");
  assert.equal(devices[0].health, "OK");
  assert.equal(devices[0].powerDrawW, 100.8);
  assert.equal(devices[0].temperatureC, 33);
  assert.equal(devices[0].utilizationPercent, 0);
  assert.equal(devices[0].memoryUsedMb, 3384);
  assert.equal(devices[0].memoryTotalMb, 65536);
});

test("parseAcceleratorSnapshot falls back to modern npu-smi info table", () => {
  const snapshot = parseAcceleratorSnapshot(`
__NC_ACCEL_BEGIN__
__NC_NPU_BEGIN__
__NC_NPU_INFO__
| NPU   Name                | Health          | Power(W)    Temp(C)           Hugepages-Usage(page)|
| Chip                      | Bus-Id          | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)        |
| 6     910B1               | OK            | 100.8       33                0    / 0             |
| 0                         | 0000:01:00.0  | 0           0    / 0          3384 / 65536         |
__NC_NPU_PROCS__
__NC_NPU_END__
__NC_ACCEL_END__
`);
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0].vendor, "ascend");
  assert.equal(snapshot.devices[0].index, 6);
  assert.equal(snapshot.devices[0].memoryTotalMb, 65536);
});

test("parseAcceleratorSnapshot merges nvidia and ascend marked sections", () => {
  const snapshot = parseAcceleratorSnapshot(`
__NC_ACCEL_BEGIN__
__NC_NVIDIA_DEVICES__
0, GPU-aaa, RTX 4090, 55, 8192, 24576, 60, 200.0, 450.0, 40, 550.54
__NC_NVIDIA_PROCESSES__
GPU-aaa, 99, train.py, 4096
__NC_NPU_BEGIN__
__NC_NPU_DEVICE__=1
Product Name                   : Ascend 910B
Aicore Usage Rate(%)           : 8
HBM Used Memory(MB)            : 512 / 32768
Temperature(C)                 : 39
NPU Real-time Power(W)         : 66.0
Health                         : OK
__NC_NPU_PROCS__
__NC_NPU_END__
__NC_ACCEL_END__
`);
  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.devices[0].vendor, "ascend");
  assert.equal(snapshot.devices[1].vendor, "nvidia");
  assert.equal(snapshot.processes.length, 1);
  assert.equal(snapshot.nvidiaDriverVersion, "550.54");
});

test("parseAcceleratorSnapshot enriches typed Ascend stubs from info table", () => {
  const snapshot = parseAcceleratorSnapshot(`
__NC_ACCEL_BEGIN__
__NC_NPU_BEGIN__
__NC_NPU_DEVICE__=6
__NC_NPU_INFO__
| NPU   Name                | Health          | Power(W)    Temp(C)           Hugepages-Usage(page)|
| Chip                      | Bus-Id          | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)        |
| 6     910B1               | OK            | 100.8       33                0    / 0             |
| 0                         | 0000:01:00.0  | 0           0    / 0          3384 / 65536         |
__NC_NPU_PROCS__
__NC_NPU_END__
__NC_ACCEL_END__
`);
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0].index, 6);
  assert.equal(snapshot.devices[0].name, "910B1");
  assert.equal(snapshot.devices[0].memoryUsedMb, 3384);
  assert.equal(snapshot.devices[0].memoryTotalMb, 65536);
  assert.equal(snapshot.devices[0].temperatureC, 33);
  assert.equal(snapshot.devices[0].powerDrawW, 100.8);
});
