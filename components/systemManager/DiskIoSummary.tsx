import React from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { formatMonitorRate as rate } from "../../domain/monitorFormatting";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** Shared rate formatting for aggregate summaries and per-mount readings. */
export function DiskIoSummary({ stats }: {
  stats?: { diskReadSpeed?: number | null; diskWriteSpeed?: number | null } | null;
}) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div data-disk-io className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
          <span>{t("monitor.diskIo")}</span>
          <span className="whitespace-nowrap">{t("monitor.diskRead")} {rate(stats?.diskReadSpeed)}</span>
          <span className="whitespace-nowrap">{t("monitor.diskWrite")} {rate(stats?.diskWriteSpeed)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{t("monitor.diskIoHint")}</TooltipContent>
    </Tooltip>
  );
}
