import { useState } from "react";
import { buildMonitorDiskListLayout, type MonitorDiskListStats } from "../../domain/monitorDisks";

/** Volatile per-host disclosure preference; capacity alerts always force it open. */
export function useMonitorDiskGroups() {
  const [expandedHosts, setExpandedHosts] = useState<ReadonlySet<string>>(() => new Set());
  return {
    layoutFor: (hostId: string, stats?: MonitorDiskListStats | null) =>
      buildMonitorDiskListLayout(stats, expandedHosts.has(hostId)),
    toggle: (hostId: string) => setExpandedHosts(previous => {
      const next = new Set(previous);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    }),
  };
}
