import React from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { MonitorDiskListRow } from "../../domain/monitorDisks";

export function MonitorSystemDiskToggle({ row, onToggle }: {
  row: Extract<MonitorDiskListRow, { kind: "system" }>;
  onToggle?: () => void;
}) {
  const { t } = useI18n();
  return (
    <button type="button" data-monitor-system-disks aria-expanded={row.expanded}
      disabled={row.alert || !onToggle}
      title={row.alert ? t("monitor.systemDisksAlert") : undefined}
      onClick={event => { event.stopPropagation(); onToggle?.(); }}
      className={`flex h-4 w-full items-center gap-1 rounded text-left text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-ring ${row.alert ? "font-medium text-destructive" : "text-muted-foreground hover:text-foreground"}`}>
      <ChevronRight size={11} aria-hidden="true" className={row.expanded ? "rotate-90" : ""} />
      {t("monitor.systemDisks", { count: row.count })}
      {row.alert && <TriangleAlert size={11} aria-hidden="true" />}
    </button>
  );
}
