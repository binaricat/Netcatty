import type { MonitorGpuCard, MonitorThermalSensor } from './types';

// Exact parity with Netcatty electron/bridges/sshBridge/monitorGpuStats.cjs + extended temp/power/AMD support.
export const GPU_ASSIGNMENT = `gpustat=$(gpucsv=$(timeout -s KILL 2 nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null) && [ -n "$gpucsv" ] && printf '%s\\n' "$gpucsv" | awk -F', *' 'NF >= 5 {idx=$1; hasExt=(NF>=7); pwr=(hasExt?$NF:"N/A"); temp=(hasExt?$(NF-1):"N/A"); total=(hasExt?$(NF-2):$NF); used=(hasExt?$(NF-3):$(NF-1)); util=(hasExt?$(NF-4):$(NF-2)); nameEnd=(hasExt?NF-5:NF-3); gsub(/^[ \\t"]+|[ \\t"]+$/, "", idx); gsub(/^[ \\t"]+|[ \\t"]+$/, "", util); gsub(/^[ \\t"]+|[ \\t"]+$/, "", used); gsub(/^[ \\t"]+|[ \\t"]+$/, "", total); gsub(/^[ \\t"]+|[ \\t"]+$/, "", temp); gsub(/^[ \\t"]+|[ \\t"]+$/, "", pwr); if (idx !~ /^[0-9]+$/) next; name=$2; for (i=3; i<=nameEnd; i++) name=name ", " $i; gsub(/^[ \\t"]+|[ \\t"]+$/, "", name); gsub(/\\t/, " ", name); gsub(/\\|/, "/", name); gsub(/ ;; /, " ", name); g++; if (util ~ /^[0-9]+(\\.[0-9]+)?$/) {n++; u+=util} if (used ~ /^[0-9]+(\\.[0-9]+)?$/) {mu+=used; uc++} if (total ~ /^[0-9]+(\\.[0-9]+)?$/) {mt+=total; tc++} if (name0=="") name0=name; utilOut=(util ~ /^[0-9]+(\\.[0-9]+)?$/) ? sprintf("%.0f", util) : "N/A"; usedOut=(used ~ /^[0-9]+(\\.[0-9]+)?$/) ? sprintf("%.0f", used) : "N/A"; totalOut=(total ~ /^[0-9]+(\\.[0-9]+)?$/) ? sprintf("%.0f", total) : "N/A"; tempOut=(temp ~ /^[0-9]+(\\.[0-9]+)?$/) ? sprintf("%.0f", temp) : "N/A"; pwrOut=(pwr ~ /^[0-9]+(\\.[0-9]+)?$/) ? sprintf("%.1f", pwr) : "N/A"; rec=idx "\\t" name "\\t" utilOut "\\t" usedOut "\\t" totalOut "\\t" tempOut "\\t" pwrOut; list=(list=="") ? rec : list " ;; " rec} END{if (n>0) {printf "%.0f %s %s %s", u/n, (uc==g ? sprintf("%.0f", mu) : "N/A"), (tc==g ? sprintf("%.0f", mt) : "N/A"), name0; if (list != "") printf " ;; %s", list}}' 2>/dev/null || for c in /sys/class/drm/card[0-9]*/device; do [ -r "$c/gpu_busy_percent" ] || continue; b=$(cat "$c/gpu_busy_percent" 2>/dev/null); vu=$(cat "$c/mem_info_vram_used" 2>/dev/null || echo 0); vt=$(cat "$c/mem_info_vram_total" 2>/dev/null || echo 0); idx=$(basename "$(dirname "$c")" | sed 's/card//'); um=$(awk -v v="$vu" 'BEGIN{printf "%.0f", v/1048576}'); tm=$(awk -v v="$vt" 'BEGIN{printf "%.0f", v/1048576}'); printf "%s %s %s AMD GPU ;; %s\\tAMD GPU %s\\t%s\\t%s\\t%s\\tN/A\\tN/A" "$b" "$um" "$tm" "$idx" "$idx" "$b" "$um" "$tm"; break; done)`;

export const THERMAL_ASSIGNMENT = String.raw`thermals=$(for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] || continue; t=$(cat "$z/temp" 2>/dev/null); lbl=$(cat "$z/type" 2>/dev/null || basename "$z"); printf "%s:%s," "$lbl" "$t"; done | sed 's/,$//')`;

export interface ParsedGpuStats {
  gpu: number | null;
  gpuName: string | null;
  gpuMemUsed: number | null;
  gpuMemTotal: number | null;
  gpus: MonitorGpuCard[];
}

const GPU_LIST_MARK = ' ;; ';

export function emptyGpuStats(): ParsedGpuStats {
  return {
    gpu: null,
    gpuName: null,
    gpuMemUsed: null,
    gpuMemTotal: null,
    gpus: [],
  };
}

function parseGpuNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

export function parseGpuCard(record: string): MonitorGpuCard | null {
  const fields = String(record || '').split('\t');
  if (fields.length < 5) return null;
  const indexRaw = parseGpuNumber(fields[0]);
  if (indexRaw == null) return null;
  const index = Math.trunc(indexRaw);
  const hasExtended = fields.length >= 7;
  const powerWatts = hasExtended ? parseGpuNumber(fields[fields.length - 1]) : null;
  const temperatureC = hasExtended ? parseGpuNumber(fields[fields.length - 2]) : null;
  const memoryTotal = parseGpuNumber(fields[hasExtended ? fields.length - 3 : fields.length - 1]);
  const memoryUsed = parseGpuNumber(fields[hasExtended ? fields.length - 4 : fields.length - 2]);
  const utilization = parseGpuNumber(fields[hasExtended ? fields.length - 5 : fields.length - 3]);
  const nameEnd = hasExtended ? fields.length - 5 : fields.length - 3;
  const name = fields.slice(1, nameEnd).join('\t').trim();
  const vendor = /nvidia|geforce|rtx|gtx|tesla|quadro|a100|h100|l40/i.test(name)
    ? 'nvidia'
    : /amd|radeon|instinct|mi\d+/i.test(name)
      ? 'amd'
      : /intel|arc|iris/i.test(name)
        ? 'intel'
        : 'unknown';
  return {
    index,
    name,
    vendor,
    utilization: utilization == null ? null : Math.max(0, Math.min(100, Math.round(utilization))),
    memoryUsed: memoryUsed == null ? null : Math.round(memoryUsed),
    memoryTotal: memoryTotal == null ? null : Math.round(memoryTotal),
    ...(temperatureC != null ? { temperatureC: Math.round(temperatureC) } : {}),
    ...(powerWatts != null ? { powerWatts } : {}),
  };
}

export function parseGpuStats(output: string | null | undefined): ParsedGpuStats {
  const payload =
    String(output || '')
      .split('|')
      .find((part) => part.startsWith('GPU:'))
      ?.slice(4)
      .trim() ?? '';
  if (!payload) return emptyGpuStats();
  const markAt = payload.indexOf(GPU_LIST_MARK);
  const summary = (markAt === -1 ? payload : payload.slice(0, markAt)).trim();
  const list = markAt === -1 ? '' : payload.slice(markAt + GPU_LIST_MARK.length);
  const raw = summary.split(/\s+/).filter(Boolean);
  const utilization = parseGpuNumber(raw[0]);
  if (utilization == null) return emptyGpuStats();
  const gpus = list
    ? list
        .split(GPU_LIST_MARK)
        .map(parseGpuCard)
        .filter((card): card is MonitorGpuCard => card !== null)
    : [];
  const memUsed = parseGpuNumber(raw[1]);
  const memTotal = parseGpuNumber(raw[2]);
  return {
    gpu: Math.max(0, Math.min(100, Math.round(utilization))),
    gpuName: raw.slice(3).join(' ') || null,
    gpuMemUsed: memUsed == null ? null : Math.round(memUsed),
    gpuMemTotal: memTotal == null ? null : Math.round(memTotal),
    gpus,
  };
}

export function parseThermalSensors(raw: string | null | undefined): MonitorThermalSensor[] {
  if (!raw || !raw.trim()) return [];
  const sensors: MonitorThermalSensor[] = [];
  const seen = new Map<string, number>();
  for (const entry of raw.split(',')) {
    const idx = entry.lastIndexOf(':');
    if (idx <= 0) continue;
    const rawLabel = entry.slice(0, idx).trim();
    const rawValue = Number(entry.slice(idx + 1).trim());
    if (!rawLabel || !Number.isFinite(rawValue)) continue;
    // Linux thermal_zone temp is in millidegrees Celsius when > 200.
    const temperatureC = rawValue > 200 ? Number((rawValue / 1000).toFixed(1)) : Number(rawValue.toFixed(1));
    if (temperatureC < -50 || temperatureC > 180) continue;
    const count = (seen.get(rawLabel) ?? 0) + 1;
    seen.set(rawLabel, count);
    const id = count === 1 ? rawLabel : `${rawLabel}-${count}`;
    const label = count === 1 ? rawLabel : `${rawLabel} #${count}`;
    sensors.push({ id, label, temperatureC });
  }
  return sensors;
}
