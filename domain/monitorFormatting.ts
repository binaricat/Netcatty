/** Decimal byte-rate units, shared by disk I/O and network monitoring. */
export function formatMonitorRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "--";
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB/s`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB/s`;
  return `${(value / 1e3).toFixed(1)} KB/s`;
}
