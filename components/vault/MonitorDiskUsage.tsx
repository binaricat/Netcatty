import React from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import type { MonitorStats } from "../../domain/monitorRuntime";
import { buildMonitorDiskListLayout, type MonitorDiskListLayout, type MonitorDiskListRow } from "../../domain/monitorDisks";
import { ResourceBar } from "../systemManager/ResourceBar";
import { useI18n } from "../../application/i18n/I18nProvider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const diskCapacity = (value: number) => value >= 1024
  ? `${(value / 1024).toFixed(2)} TiB`
  : value > 0 && value < 1
    ? `${(value * 1024).toFixed(1)} MiB`
    : `${value.toFixed(1)} GiB`;

/** Cards show the largest capacities; the list puts system mounts first. */
export function MonitorDiskUsage({
  stats,
  limit,
  listLayout,
  onToggleSystem,
}: {
  stats?: (Pick<MonitorStats, "disks" | "diskPercent"> & Partial<Pick<MonitorStats, "diskUsed" | "diskTotal" | "diskReadSpeed" | "diskWriteSpeed">>) | null;
  limit?: number;
  listLayout?: MonitorDiskListLayout;
  onToggleSystem?: () => void;
}) {
  const { t } = useI18n();
  const reported = stats?.disks.length
    ? stats.disks
    : [{ mountPoint: "/", percent: stats?.diskPercent ?? null, used: stats?.diskUsed ?? null, total: stats?.diskTotal ?? null }];
  const rows: MonitorDiskListRow[] = limit == null ? (listLayout ?? buildMonitorDiskListLayout(stats)).rows
    : [...reported].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
      .slice(0, limit).map(disk => ({ kind: "disk", disk, alert: false }));
  return (
    <TooltipProvider delayDuration={150}>
      <div className={limit === 2 ? "min-h-[38px] space-y-1.5" : "space-y-1.5"}>
        {rows.map((row, index) => {
          if (row.kind === "system") return (
            <button key="system" type="button" data-monitor-system-disks
              aria-expanded={row.expanded}
              disabled={row.alert || !onToggleSystem}
              title={row.alert ? t("monitor.systemDisksAlert") : undefined}
              onClick={event => { event.stopPropagation(); onToggleSystem?.(); }}
              className={`flex h-4 w-full items-center gap-1 rounded text-left text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-ring ${row.alert ? "font-medium text-destructive" : "text-muted-foreground hover:text-foreground"}`}>
              <ChevronRight size={11} aria-hidden="true" className={row.expanded ? "rotate-90" : ""} />
              {t("monitor.systemDisks", { count: row.count })}
              {row.alert && <TriangleAlert size={11} aria-hidden="true" />}
            </button>
          );
          const { disk, alert } = row;
          return (
          <Tooltip key={`${disk.mountPoint}-${index}`}>
            <TooltipTrigger asChild>
              <div data-monitor-disk={disk.mountPoint} data-monitor-disk-alert={alert || undefined} className={`flex h-4 min-w-0 items-center gap-2 ${alert ? "rounded bg-destructive/10" : ""}`}>
                <span className={`w-24 shrink-0 truncate text-[10px] ${alert ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                  {disk.mountPoint}
                </span>
                <ResourceBar label="" value={disk.percent} className="flex-1" danger={alert} />
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-80 bg-popover text-popover-foreground shadow-md ring-1 ring-border/40">
              <div className="mb-1 break-all font-medium">{disk.mountPoint}</div>
              <div className="tabular-nums text-muted-foreground">
                {typeof disk.used === "number" && Number.isFinite(disk.used) && disk.used >= 0 && typeof disk.total === "number" && Number.isFinite(disk.total) && disk.total > 0
                  ? t("monitor.diskCapacity", { used: diskCapacity(disk.used), total: diskCapacity(disk.total) })
                  : t("monitor.diskCapacityUnknown")}
              </div>
            </TooltipContent>
          </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
