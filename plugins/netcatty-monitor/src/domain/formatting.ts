/** Decimal byte-rate units, shared by disk I/O and network monitoring (exact Netcatty parity). */
export function formatMonitorRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '--';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB/s`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB/s`;
  return `${(value / 1e3).toFixed(1)} KB/s`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${Math.max(0, Math.min(100, value)).toFixed(digits)}%`;
}

export function formatMemoryMiB(mib: number | null | undefined): string {
  if (mib == null || !Number.isFinite(mib) || mib < 0) return '--';
  if (mib >= 1024 * 1024) return `${(mib / (1024 * 1024)).toFixed(1)} TiB`;
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${Math.round(mib)} MiB`;
}

export function formatDiskGiB(gib: number | null | undefined): string {
  if (gib == null || !Number.isFinite(gib) || gib < 0) return '--';
  if (gib >= 1024) return `${(gib / 1024).toFixed(2)} TiB`;
  if (gib >= 100) return `${gib.toFixed(0)} GiB`;
  if (gib >= 10) return `${gib.toFixed(1)} GiB`;
  return `${gib.toFixed(2)} GiB`;
}

export function formatRssKb(kb: number | null | undefined): string {
  if (kb == null || !Number.isFinite(kb) || kb < 0) return '--';
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(2)} GiB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MiB`;
  return `${Math.round(kb)} KiB`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatUptime(seconds: number | null | undefined, locale = 'en'): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const isZh = locale.toLowerCase().startsWith('zh');
  if (days > 0) return isZh ? `${days}天 ${hours}小时` : `${days}d ${hours}h`;
  if (hours > 0) return isZh ? `${hours}小时 ${mins}分` : `${hours}h ${mins}m`;
  return isZh ? `${Math.max(1, mins)}分钟` : `${Math.max(1, mins)}m`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '--';
  return `${Math.round(ms)} ms`;
}

export function formatLoadAverage(load: readonly number[] | null | undefined): string {
  if (!load || load.length === 0) return '--';
  return load.slice(0, 3).map((v) => v.toFixed(2)).join(' / ');
}

export function formatRelativeAge(timestampMs: number, nowMs = Date.now(), locale = 'en'): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return '--';
  const deltaSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  const isZh = locale.toLowerCase().startsWith('zh');
  if (deltaSec < 5) return isZh ? '刚刚' : 'just now';
  if (deltaSec < 60) return isZh ? `${deltaSec}秒前` : `${deltaSec}s ago`;
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return isZh ? `${mins}分钟前` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return isZh ? `${hours}小时前` : `${hours}h ago`;
}

export function formatMemoryPercent(memUsed: number | null | undefined, memTotal: number | null | undefined): number | null {
  if (memUsed == null || memTotal == null || !Number.isFinite(memUsed) || !Number.isFinite(memTotal) || memTotal <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, (memUsed / memTotal) * 100));
}

export function formatCompactCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '--';
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

export function formatIops(readIops: number | null | undefined, writeIops: number | null | undefined): string {
  if (readIops == null && writeIops == null) return '--';
  const r = readIops != null && Number.isFinite(readIops) ? Math.round(readIops) : 0;
  const w = writeIops != null && Number.isFinite(writeIops) ? Math.round(writeIops) : 0;
  return `${formatCompactCount(r)}/${formatCompactCount(w)} IOPS`;
}

export function formatMarkdownDiagnostics(input: {
  title: string;
  generatedAt: string;
  hosts: Array<{
    label: string;
    hostname?: string;
    status: string;
    cpu?: number | null;
    memPercent?: number | null;
    diskPercent?: number | null;
    load?: string;
    latency?: string;
    os?: string;
  }>;
  activeAlerts: Array<{ severity: string; message: string }>;
}): string {
  const lines: string[] = [
    `# Netcatty Monitor Diagnostics — ${input.title}`,
    ``,
    `Generated: ${input.generatedAt}`,
    ``,
    `## Fleet Summary`,
    ``,
    `| Host | Status | CPU | Memory | Disk | Load | Latency | OS |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const h of input.hosts) {
    lines.push(
      `| ${h.label}${h.hostname ? ` (${h.hostname})` : ''} | ${h.status} | ${formatPercent(h.cpu, 1)} | ${formatPercent(h.memPercent, 1)} | ${formatPercent(h.diskPercent, 0)} | ${h.load ?? '--'} | ${h.latency ?? '--'} | ${h.os ?? '--'} |`,
    );
  }
  lines.push(``, `## Active Alerts (${input.activeAlerts.length})`, ``);
  if (input.activeAlerts.length === 0) {
    lines.push(`- None (all monitored hosts healthy)`);
  } else {
    for (const a of input.activeAlerts) {
      lines.push(`- **[${a.severity.toUpperCase()}]** ${a.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
