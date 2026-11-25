import React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { MonitorStats } from "../../domain/monitorRuntime";
import { formatMonitorRate } from "../../domain/monitorFormatting";
import { buildMonitorDiskListLayout, type MonitorDiskListLayout } from "../../domain/monitorDisks";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { MonitorSystemDiskToggle } from "./MonitorSystemDiskToggle";

type DiskRates = { diskReadSpeed?: number | null; diskWriteSpeed?: number | null };

function Rates({ stats }: { stats?: DiskRates | null }) {
  const { t } = useI18n();
  return <>
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <ArrowDown size={11} aria-hidden="true" className="shrink-0 text-sky-600 dark:text-sky-400" />
      <span className="sr-only">{t("monitor.diskRead")} </span>
      {formatMonitorRate(stats?.diskReadSpeed)}
    </span>
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <ArrowUp size={11} aria-hidden="true" className="shrink-0 text-violet-600 dark:text-violet-400" />
      <span className="sr-only">{t("monitor.diskWrite")} </span>
      {formatMonitorRate(stats?.diskWriteSpeed)}
    </span>
  </>;
}

/** Same mount order and row height as the adjacent capacity column. */
export function MonitorDiskIo({ stats, listLayout, showSystemToggle = false, onToggleSystem }: {
  stats?: (Pick<MonitorStats, "disks"> & DiskRates) | null;
  listLayout?: MonitorDiskListLayout;
  showSystemToggle?: boolean;
  onToggleSystem?: () => void;
}) {
  const { t } = useI18n();
  const layout = listLayout ?? buildMonitorDiskListLayout(stats);
  return (
    <TooltipProvider delayDuration={180}>
      <div className="w-full min-w-0 space-y-1.5 text-[10px] tabular-nums text-muted-foreground">
        {layout.rows.map((row, index) => {
          if (row.kind === "system") return showSystemToggle
            ? <MonitorSystemDiskToggle key="system" row={row} onToggle={onToggleSystem} />
            : <div key="system" data-monitor-system-io-slot aria-hidden="true" className="h-4" />;
          const { disk } = row;
          return (
            <Tooltip key={`${disk.mountPoint}-${index}`}>
              <TooltipTrigger asChild>
                <div
                  data-monitor-disk-io={disk.mountPoint}
                  aria-label={`${disk.mountPoint}: ${t("monitor.partitionIoHint")}`}
                  className="grid h-4 grid-cols-2 items-center gap-2"
                >
                  <span className="sr-only">{disk.mountPoint} </span>
                  <Rates stats={disk} />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs whitespace-pre-line">
                {`${disk.mountPoint}\n${t("monitor.partitionIoHint")}`}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <div data-monitor-disk-io-total className="flex h-5 items-center justify-between gap-2 border-t border-border/40 pt-1">
              <span>{t("monitor.diskIoTotal")}</span>
              <div className="flex items-center gap-2"><Rates stats={stats} /></div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">{t("monitor.diskIoHint")}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
