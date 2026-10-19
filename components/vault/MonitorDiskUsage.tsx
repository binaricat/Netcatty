import React from "react";
import type { MonitorStats } from "../../domain/monitorRuntime";
import { ResourceBar } from "../systemManager/ResourceBar";
import { useI18n } from "../../application/i18n/I18nProvider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const diskCapacity = (value: number) => value >= 1024
  ? `${(value / 1024).toFixed(2)} TiB`
  : value > 0 && value < 1
    ? `${(value * 1024).toFixed(1)} MiB`
    : `${value.toFixed(1)} GiB`;

/** Cards show the largest capacities; the list keeps every reported mount. */
export function MonitorDiskUsage({
  stats,
  limit,
}: {
  stats?: (Pick<MonitorStats, "disks" | "diskPercent"> & Partial<Pick<MonitorStats, "diskUsed" | "diskTotal">>) | null;
  limit?: number;
}) {
  const { t } = useI18n();
  const reported = stats?.disks.length
    ? stats.disks
    : [{ mountPoint: "/", percent: stats?.diskPercent ?? null, used: stats?.diskUsed ?? null, total: stats?.diskTotal ?? null }];
  const disks = limit == null
    ? reported
    : [...reported].sort((a, b) =>
        ("total" in b ? b.total : 0) - ("total" in a ? a.total : 0),
      ).slice(0, limit);
  return (
    <TooltipProvider delayDuration={150}>
      <div className={limit === 2 ? "min-h-[38px] space-y-1.5" : "space-y-1.5"}>
        {disks.map((disk, index) => (
          <Tooltip key={`${disk.mountPoint}-${index}`}>
            <TooltipTrigger asChild>
              <div data-monitor-disk={disk.mountPoint} className="flex min-w-0 items-center gap-2">
                <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground">
                  {disk.mountPoint}
                </span>
                <ResourceBar label="" value={disk.percent} className="flex-1" />
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
        ))}
      </div>
    </TooltipProvider>
  );
}
