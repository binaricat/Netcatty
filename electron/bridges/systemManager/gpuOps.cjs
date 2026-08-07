/* eslint-disable no-undef */

"use strict";

const NVIDIA_GPU_QUERY = [
  "nvidia-smi",
  "--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,driver_version",
  "--format=csv,noheader,nounits",
].join(" ");

const NVIDIA_PROCESS_QUERY = [
  "nvidia-smi",
  "--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory",
  "--format=csv,noheader,nounits",
].join(" ");

/**
 * Local Windows collector — PowerShell (execOnLocalMachine uses powershell.exe).
 * Ascend on Windows is uncommon; still attempt npu-smi when present.
 */
const ACCELERATOR_COLLECT_SCRIPT_WINDOWS = [
  'Write-Output "__NC_ACCEL_BEGIN__"; ',
  "if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { ",
  'Write-Output "__NC_NVIDIA_DEVICES__"; ',
  `${NVIDIA_GPU_QUERY} 2>$null; `,
  'Write-Output "__NC_NVIDIA_PROCESSES__"; ',
  `${NVIDIA_PROCESS_QUERY} 2>$null; `,
  "}; ",
  "if (Get-Command npu-smi -ErrorAction SilentlyContinue) { ",
  'Write-Output "__NC_NPU_BEGIN__"; ',
  'Write-Output "__NC_NPU_INFO__"; ',
  "npu-smi info 2>$null; ",
  'Write-Output "__NC_NPU_PROCS__"; ',
  "npu-smi info -t proc-mem 2>$null; ",
  'Write-Output "__NC_NPU_END__"; ',
  "}; ",
  'Write-Output "__NC_ACCEL_END__"',
].join("");

/**
 * Remote collector body (no outer quoting). Wrapped with JSON.stringify so
 * nested sed single-quotes cannot break `sh -c`.
 */
const ACCELERATOR_COLLECT_INNER = [
  'printf "%s\\n" "__NC_ACCEL_BEGIN__"; ',
  'if command -v nvidia-smi >/dev/null 2>&1; then ',
  'printf "%s\\n" "__NC_NVIDIA_DEVICES__"; ',
  `${NVIDIA_GPU_QUERY} 2>/dev/null || true; `,
  'printf "%s\\n" "__NC_NVIDIA_PROCESSES__"; ',
  `${NVIDIA_PROCESS_QUERY} 2>/dev/null || true; `,
  "fi; ",
  'if command -v npu-smi >/dev/null 2>&1; then ',
  'printf "%s\\n" "__NC_NPU_BEGIN__"; ',
  // Prefer info -l; fall back to info -m (SwanLab / Ascend mapping table).
  "ids=$(npu-smi info -l 2>/dev/null | sed -n 's/^[[:space:]]*NPU ID[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p'); ",
  'if [ -z "$ids" ]; then ',
  "ids=$(npu-smi info -m 2>/dev/null | awk 'NR>1 && $1 ~ /^[0-9]+$/ {print $1}' | sort -nu); ",
  "fi; ",
  'if [ -n "$ids" ]; then ',
  'for id in $ids; do ',
  'printf "%s\\n" "__NC_NPU_DEVICE__=$id"; ',
  'npu-smi info -t board -i "$id" 2>/dev/null || true; ',
  'npu-smi info -t common -i "$id" 2>/dev/null || true; ',
  'npu-smi info -t usages -i "$id" 2>/dev/null || true; ',
  'npu-smi info -t memory -i "$id" 2>/dev/null || true; ',
  "done; ",
  "fi; ",
  // Always keep the summary table; typed queries can be empty on ModelArts /
  // containers, and Windows collectors only emit this dump.
  'printf "%s\\n" "__NC_NPU_INFO__"; ',
  "npu-smi info 2>/dev/null || true; ",
  'printf "%s\\n" "__NC_NPU_PROCS__"; ',
  "npu-smi info -t proc-mem 2>/dev/null || true; ",
  'printf "%s\\n" "__NC_NPU_END__"; ',
  "fi; ",
  'printf "%s\\n" "__NC_ACCEL_END__"',
].join("");

const ACCELERATOR_COLLECT_SCRIPT = `exec sh -c ${JSON.stringify(ACCELERATOR_COLLECT_INNER)}`;

function parseCsvNumber(raw) {
  const text = String(raw ?? "").trim();
  if (
    !text
    || text === "-"
    || /^\[?n\/?a\]?$/i.test(text)
    || /^not\s+supported$/i.test(text)
  ) {
    return null;
  }
  const n = Number.parseFloat(text.replace(/[,%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractAscendDriverVersion(text) {
  const match = String(text || "").match(
    /\|\s*npu-smi\s+(\S+)\s+.*?Version:\s*(\S+)/i,
  );
  if (!match) return null;
  const version = (match[2] || match[1] || "").replace(/\|/g, "").trim();
  return version || null;
}

function applyMemPair(device, used, total, { aggregate = false } = {}) {
  const usedN = parseCsvNumber(used);
  const totalN = parseCsvNumber(total);
  if (!Number.isFinite(usedN) && !Number.isFinite(totalN)) return;
  if (
    aggregate
    && Number.isFinite(device.memoryUsedMb)
    && Number.isFinite(usedN)
  ) {
    device.memoryUsedMb = Number(device.memoryUsedMb) + usedN;
    device.memoryTotalMb = Number(device.memoryTotalMb || 0)
      + (Number.isFinite(totalN) ? totalN : 0);
    return;
  }
  if (Number.isFinite(usedN)) device.memoryUsedMb = usedN;
  if (Number.isFinite(totalN)) device.memoryTotalMb = totalN;
}

function maxFinite(current, next) {
  if (!Number.isFinite(next)) return current;
  if (!Number.isFinite(current)) return next;
  return Math.max(current, next);
}

function parseCsvFields(line) {
  // nvidia-smi csv is simple (no embedded commas in queried fields with nounits)
  return String(line || "")
    .split(",")
    .map((part) => part.trim());
}

function parseNvidiaDevices(sectionText) {
  const devices = [];
  for (const line of String(sectionText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("__NC_")) continue;
    const fields = parseCsvFields(trimmed);
    if (fields.length < 3) continue;
    const index = Number.parseInt(fields[0], 10);
    if (!Number.isFinite(index)) continue;
    devices.push({
      vendor: "nvidia",
      index,
      uuid: fields[1] || "",
      name: fields[2] || `GPU ${index}`,
      utilizationPercent: parseCsvNumber(fields[3]),
      memoryUsedMb: parseCsvNumber(fields[4]),
      memoryTotalMb: parseCsvNumber(fields[5]),
      temperatureC: parseCsvNumber(fields[6]),
      powerDrawW: parseCsvNumber(fields[7]),
      powerLimitW: parseCsvNumber(fields[8]),
      fanPercent: parseCsvNumber(fields[9]),
      driverVersion: fields[10] || null,
      health: null,
    });
  }
  return devices;
}

function parseNvidiaProcesses(sectionText, devices) {
  const uuidToIndex = new Map();
  for (const device of devices) {
    if (device.uuid) uuidToIndex.set(device.uuid, device.index);
  }
  const processes = [];
  for (const line of String(sectionText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("__NC_")) continue;
    const fields = parseCsvFields(trimmed);
    if (fields.length < 3) continue;
    const uuid = fields[0] || "";
    const pid = Number.parseInt(fields[1], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    processes.push({
      vendor: "nvidia",
      gpuIndex: uuidToIndex.has(uuid) ? uuidToIndex.get(uuid) : 0,
      pid,
      processName: fields[2] || "",
      memoryUsedMb: parseCsvNumber(fields[3]),
    });
  }
  return processes;
}

function extractKvNumber(block, labels) {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)`, "i");
    const match = String(block || "").match(re);
    if (match) {
      const n = Number.parseFloat(match[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractKvText(block, labels) {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:=]\\s*(.+)`, "i");
    const match = String(block || "").match(re);
    if (match) {
      const value = match[1].trim().replace(/\s{2,}.*/, "").trim();
      if (value) return value;
    }
  }
  return null;
}

function parseAscendDeviceBlock(index, block) {
  const name =
    extractKvText(block, [
      "Product Name",
      "NPU Name",
      "Chip Name",
      "Model",
      "Board Name",
    ]) || `Ascend NPU ${index}`;
  const utilizationPercent = extractKvNumber(block, [
    "Aicore Usage Rate\\(%\\)",
    "AICore Usage Rate\\(%\\)",
    "Aicore Usage Rate",
    "AI Core Usage",
  ]);
  // Absolute MB fields only — never treat "HBM Usage Rate(%)" as megabytes.
  const hbmUsed = extractKvNumber(block, [
    "HBM Used Memory\\(MB\\)",
    "HBM Memory Usage\\(MB\\)",
    "Used HBM Memory\\(MB\\)",
    "Used HBM Memory",
  ]);
  const hbmTotal = extractKvNumber(block, [
    "HBM Total Memory\\(MB\\)",
    "HBM Capacity\\(MB\\)",
    "Total HBM Memory\\(MB\\)",
    "Total HBM Memory",
  ]);
  const hbmUsageRate = extractKvNumber(block, [
    "HBM Usage Rate\\(%\\)",
    "HBM Usage Rate",
  ]);
  // memory command sometimes reports "Used / Total"
  const hbmPair = String(block || "").match(
    /HBM[^\n]*?(?:Memory|Usage)\([^\n]*?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
  ) || String(block || "").match(
    /HBM Used Memory[^\n]*?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
  );
  let memoryUsedMb = hbmPair ? Number.parseFloat(hbmPair[1]) : hbmUsed;
  let memoryTotalMb = hbmPair ? Number.parseFloat(hbmPair[2]) : hbmTotal;
  // Derive used MB from rate only when total is known and used is missing.
  if (
    !Number.isFinite(memoryUsedMb)
    && Number.isFinite(hbmUsageRate)
    && Number.isFinite(memoryTotalMb)
    && memoryTotalMb > 0
  ) {
    memoryUsedMb = (hbmUsageRate / 100) * memoryTotalMb;
  }
  const temperatureC = extractKvNumber(block, [
    "Temperature\\(C\\)",
    "Temp\\(C\\)",
    "Temperature",
  ]);
  const powerDrawW = extractKvNumber(block, [
    "NPU Real-time Power\\(W\\)",
    "Power Dissipation\\(W\\)",
    "Power\\(W\\)",
    "Power",
  ]);
  const health = extractKvText(block, ["Health", "Health Status"]);

  return {
    vendor: "ascend",
    index,
    uuid: "",
    name,
    utilizationPercent: Number.isFinite(utilizationPercent) ? utilizationPercent : null,
    memoryUsedMb: Number.isFinite(memoryUsedMb) ? memoryUsedMb : null,
    memoryTotalMb: Number.isFinite(memoryTotalMb) ? memoryTotalMb : null,
    temperatureC: Number.isFinite(temperatureC) ? temperatureC : null,
    powerDrawW: Number.isFinite(powerDrawW) ? powerDrawW : null,
    powerLimitW: null,
    fanPercent: null,
    driverVersion: null,
    health,
  };
}

/**
 * Parse `npu-smi info` summary tables.
 *
 * Modern CANN (24.x+) rows look like nputop's fixture:
 *   | 6     910B1 | OK | 100.8  33  0 / 0 |
 *   | 0           | 0000:01:00.0 | 0  0 / 0  3384 / 65536 |
 * Chip-ID on the second row is NOT the NPU ID; attach metrics to the
 * preceding NPU summary row (same approach as youyve/nputop libascend).
 *
 * Multi-chip cards (Atlas A3 / 310P) repeat the NPU summary once per chip.
 * Sidebar shows one row per NPU ID and aggregates chip memory / util.
 */
function parseAscendInfoTable(sectionText) {
  const devices = [];
  const lines = String(sectionText || "").split("\n");
  const driverVersion = extractAscendDriverVersion(sectionText);

  // Summary: NPU ID, Name, Health, Power, Temp; tolerate Hugepages column after Temp.
  // Power may be "NA" / "-"; Name is a single token like 910B1 / Ascend910.
  const summaryRe =
    /^\|\s*(\d+)\s+(\S+)\s+\|\s*(\S+)\s+\|\s*(\S+)\s+(\d+(?:\.\d+)?)\b/;
  // Bus-Id chip row (CANN 24.x): | ChipID [PhyID] | Bus-Id | AICore(%) ... mem pairs ... |
  const busChipRe =
    /^\|\s*(\d+)\s*(\d*)\s*\|\s*([0-9A-Fa-f:.]+|NA)\s*\|\s*(\d+(?:\.\d+)?)\b/;
  // Legacy whitespace chip row: | NPU Chip Logic AICore Mem/Tot HBM/Tot |
  const legacyChipRe =
    /^\|\s*(\d+)\s+\d+\s+\d+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/;

  let lastDevice = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) continue;

    const summary = line.match(summaryRe);
    if (summary) {
      const index = Number.parseInt(summary[1], 10);
      if (!Number.isFinite(index)) continue;
      const name = summary[2].trim();
      if (!name || /^(?:NPU|Chip|Name)$/i.test(name)) continue;
      let device = devices.find((d) => d.index === index);
      const isNew = !device;
      if (!device) {
        device = {
          vendor: "ascend",
          index,
          uuid: "",
          name,
          utilizationPercent: null,
          memoryUsedMb: null,
          memoryTotalMb: null,
          temperatureC: parseCsvNumber(summary[5]),
          powerDrawW: parseCsvNumber(summary[4]),
          powerLimitW: null,
          fanPercent: null,
          driverVersion,
          health: summary[3].trim(),
          _chipCount: 0,
        };
        devices.push(device);
      } else {
        if (!device.name) device.name = name;
        device.temperatureC = maxFinite(device.temperatureC, parseCsvNumber(summary[5]));
        if (device.powerDrawW == null) device.powerDrawW = parseCsvNumber(summary[4]);
        if (!device.health || /^ok$/i.test(device.health)) {
          const health = summary[3].trim();
          if (health) device.health = health;
        }
        if (!device.driverVersion && driverVersion) device.driverVersion = driverVersion;
      }
      lastDevice = device;

      const next = (lines[i + 1] || "").trim();
      const busChip = next.match(busChipRe);
      if (busChip) {
        i += 1;
        const util = parseCsvNumber(busChip[4]);
        device.utilizationPercent = maxFinite(device.utilizationPercent, util);
        const pairs = [...next.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)];
        if (pairs.length > 0) {
          const hbm = pairs[pairs.length - 1];
          applyMemPair(device, hbm[1], hbm[2], { aggregate: !isNew && device._chipCount > 0 });
        }
        device._chipCount = (device._chipCount || 0) + 1;
        continue;
      }
      const legacyNext = next.match(legacyChipRe);
      if (legacyNext) {
        i += 1;
        device.utilizationPercent = maxFinite(
          device.utilizationPercent,
          parseCsvNumber(legacyNext[2]),
        );
        applyMemPair(device, legacyNext[5], legacyNext[6], {
          aggregate: !isNew && device._chipCount > 0,
        });
        device._chipCount = (device._chipCount || 0) + 1;
      }
      continue;
    }

    const legacy = line.match(legacyChipRe);
    if (legacy) {
      const index = Number.parseInt(legacy[1], 10);
      const device = devices.find((d) => d.index === index) || lastDevice;
      if (!device) continue;
      device.utilizationPercent = maxFinite(
        device.utilizationPercent,
        parseCsvNumber(legacy[2]),
      );
      applyMemPair(device, legacy[5], legacy[6], { aggregate: (device._chipCount || 0) > 0 });
      device._chipCount = (device._chipCount || 0) + 1;
      continue;
    }

    const busChip = line.match(busChipRe);
    if (busChip && lastDevice) {
      const util = parseCsvNumber(busChip[4]);
      lastDevice.utilizationPercent = maxFinite(lastDevice.utilizationPercent, util);
      const pairs = [...line.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)];
      if (pairs.length > 0) {
        const hbm = pairs[pairs.length - 1];
        applyMemPair(lastDevice, hbm[1], hbm[2], {
          aggregate: (lastDevice._chipCount || 0) > 0,
        });
      }
      lastDevice._chipCount = (lastDevice._chipCount || 0) + 1;
    }
  }

  for (const device of devices) {
    delete device._chipCount;
  }
  return devices;
}

function parseAscendTypedSections(sectionText) {
  const devices = [];
  const chunks = String(sectionText || "").split(/__NC_NPU_DEVICE__=/);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed.startsWith("__NC_")) continue;
    const nl = trimmed.indexOf("\n");
    const idPart = nl === -1 ? trimmed : trimmed.slice(0, nl);
    const body = nl === -1 ? "" : trimmed.slice(nl + 1);
    const index = Number.parseInt(idPart, 10);
    if (!Number.isFinite(index)) continue;
    devices.push(parseAscendDeviceBlock(index, body));
  }
  return devices;
}

function parseAscendProcesses(sectionText) {
  const processes = [];
  for (const line of String(sectionText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /no running processes/i.test(trimmed)) continue;

    // Common proc-mem lines include NPU/Chip/Pid/Name/Memory
    const match = trimmed.match(
      /(?:NPU|Device)?\s*I?D?\s*[:=]?\s*(\d+).*?\b(?:PID|Pid)\s*[:=]?\s*(\d+).*?\b(?:Name|Process)\s*[:=]?\s*(\S+).*?(?:Memory|Mem)\s*[:=]?\s*(\d+(?:\.\d+)?)/i,
    );
    if (match) {
      processes.push({
        vendor: "ascend",
        gpuIndex: Number.parseInt(match[1], 10) || 0,
        pid: Number.parseInt(match[2], 10),
        processName: match[3],
        memoryUsedMb: parseCsvNumber(match[4]),
      });
      continue;
    }

    // nputop / npu-smi info process table:
    // | 0       0                 | 124528        | python3.8                | 17400                   |
    const infoProc = trimmed.match(
      /^\|\s*(\d+)\s+(\d+)\s+\|\s+(\d+)\s+\|\s*([^|]+?)\s*\|\s*(\d+(?:\.\d+)?)/,
    );
    if (infoProc) {
      processes.push({
        vendor: "ascend",
        gpuIndex: Number.parseInt(infoProc[1], 10) || 0,
        pid: Number.parseInt(infoProc[3], 10),
        processName: infoProc[4].trim(),
        memoryUsedMb: parseCsvNumber(infoProc[5]),
      });
      continue;
    }

    // Pipe-separated: | 0 | 0 | 12345 | python | 1024 |
    const pipeTable = trimmed.match(
      /^\|\s*(\d+)\s*\|\s*\d+\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+(?:\.\d+)?)/,
    );
    if (pipeTable) {
      processes.push({
        vendor: "ascend",
        gpuIndex: Number.parseInt(pipeTable[1], 10) || 0,
        pid: Number.parseInt(pipeTable[2], 10),
        processName: pipeTable[3].trim(),
        memoryUsedMb: parseCsvNumber(pipeTable[4]),
      });
      continue;
    }

    // Whitespace-delimited inside one outer |: | 0 0 12345 python 1024 |
    const wsTable = trimmed.match(
      /^\|\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s*\|?\s*$/,
    );
    if (!wsTable) continue;
    processes.push({
      vendor: "ascend",
      gpuIndex: Number.parseInt(wsTable[1], 10) || 0,
      pid: Number.parseInt(wsTable[3], 10),
      processName: wsTable[4],
      memoryUsedMb: parseCsvNumber(wsTable[5]),
    });
  }
  return processes.filter((p) => Number.isFinite(p.pid) && p.pid > 0);
}

function dedupeAcceleratorProcesses(processes) {
  const seen = new Set();
  const out = [];
  for (const processInfo of processes) {
    const key = `${processInfo.vendor}:${processInfo.gpuIndex}:${processInfo.pid}:${processInfo.processName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(processInfo);
  }
  return out;
}

function sliceMarkedSection(text, beginMarker, endMarkers) {
  const start = text.indexOf(beginMarker);
  if (start === -1) return "";
  const from = start + beginMarker.length;
  let end = text.length;
  for (const marker of endMarkers) {
    const idx = text.indexOf(marker, from);
    if (idx !== -1 && idx < end) end = idx;
  }
  return text.slice(from, end);
}

function parseAcceleratorSnapshot(stdout) {
  const text = String(stdout || "");
  const nvidiaDevicesText = sliceMarkedSection(text, "__NC_NVIDIA_DEVICES__", [
    "__NC_NVIDIA_PROCESSES__",
    "__NC_NPU_BEGIN__",
    "__NC_ACCEL_END__",
  ]);
  const nvidiaProcessesText = sliceMarkedSection(text, "__NC_NVIDIA_PROCESSES__", [
    "__NC_NPU_BEGIN__",
    "__NC_ACCEL_END__",
  ]);
  const npuSection = sliceMarkedSection(text, "__NC_NPU_BEGIN__", ["__NC_NPU_END__", "__NC_ACCEL_END__"]);

  const nvidiaDevices = parseNvidiaDevices(nvidiaDevicesText);
  const nvidiaProcesses = parseNvidiaProcesses(nvidiaProcessesText, nvidiaDevices);

  let ascendDevices = parseAscendTypedSections(npuSection);
  const infoDump = sliceMarkedSection(npuSection, "__NC_NPU_INFO__", [
    "__NC_NPU_PROCS__",
    "__NC_NPU_END__",
  ]);
  const tableDevices = parseAscendInfoTable(infoDump || npuSection);
  if (ascendDevices.length === 0) {
    ascendDevices = tableDevices;
  } else if (tableDevices.length > 0) {
    // Fill gaps when typed -t queries returned stubs but the summary table is rich.
    const byIndex = new Map(ascendDevices.map((d) => [d.index, d]));
    for (const tableDevice of tableDevices) {
      const existing = byIndex.get(tableDevice.index);
      if (!existing) {
        ascendDevices.push(tableDevice);
        byIndex.set(tableDevice.index, tableDevice);
        continue;
      }
      if (!existing.name || /^Ascend NPU\b/i.test(existing.name)) {
        existing.name = tableDevice.name;
      }
      for (const key of [
        "utilizationPercent",
        "memoryUsedMb",
        "memoryTotalMb",
        "temperatureC",
        "powerDrawW",
        "health",
      ]) {
        if (existing[key] == null && tableDevice[key] != null) {
          existing[key] = tableDevice[key];
        }
      }
    }
  }
  const ascendProcText = sliceMarkedSection(npuSection, "__NC_NPU_PROCS__", [
    "__NC_NPU_END__",
  ]);
  // Processes often live in the `npu-smi info` dump (nputop fixtures), not only -t proc-mem.
  const ascendProcesses = dedupeAcceleratorProcesses([
    ...parseAscendProcesses(ascendProcText),
    ...parseAscendProcesses(infoDump || npuSection),
  ]);

  const ascendDriverVersion = extractAscendDriverVersion(infoDump || npuSection);
  if (ascendDriverVersion) {
    for (const device of ascendDevices) {
      if (!device.driverVersion) device.driverVersion = ascendDriverVersion;
    }
  }

  const devices = [...nvidiaDevices, ...ascendDevices].sort((a, b) => {
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
    return a.index - b.index;
  });
  const processes = [...nvidiaProcesses, ...ascendProcesses];
  const nvidiaDriverVersion = nvidiaDevices.find((d) => d.driverVersion)?.driverVersion || null;

  return {
    devices,
    processes,
    nvidiaDriverVersion,
    probedAt: Date.now(),
  };
}

function createGpuOpsApi({
  execOnSession,
  execOnLocalMachine,
  isLocalSession,
  process: nodeProcess = process,
}) {
  async function listAccelerators(event, sessionId) {
    if (!sessionId) return { success: false, error: "Missing sessionId" };

    let result;
    if (
      typeof isLocalSession === "function"
      && isLocalSession(sessionId)
      && nodeProcess.platform === "win32"
      && typeof execOnLocalMachine === "function"
    ) {
      result = await execOnLocalMachine(ACCELERATOR_COLLECT_SCRIPT_WINDOWS, 15000);
    } else {
      result = await execOnSession(event, sessionId, ACCELERATOR_COLLECT_SCRIPT, 15000);
    }

    if (result.pending) return { success: false, pending: true };
    if (!result.success) return { success: false, error: result.error || "Failed to query accelerators" };
    const snapshot = parseAcceleratorSnapshot(result.stdout);
    return { success: true, ...snapshot };
  }

  return { listAccelerators, parseAcceleratorSnapshot };
}

module.exports = {
  createGpuOpsApi,
  parseAcceleratorSnapshot,
  parseNvidiaDevices,
  parseNvidiaProcesses,
  parseAscendDeviceBlock,
  parseAscendInfoTable,
  parseAscendProcesses,
  ACCELERATOR_COLLECT_SCRIPT,
  ACCELERATOR_COLLECT_SCRIPT_WINDOWS,
};
