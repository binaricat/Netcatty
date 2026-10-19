import React from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { Badge } from "../ui/badge";

export function MonitorHostLatency({
  value,
  responseValue,
}: {
  value?: number | null;
  responseValue?: number | null;
}) {
  const { t } = useI18n();
  const isValid = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  const usesResponse = !isValid(value) && isValid(responseValue);
  const latency = usesResponse ? responseValue : value;
  const known = isValid(latency);
  const bars = !known ? 0 : latency <= 100 ? 4 : latency <= 300 ? 2 : 1;
  const tone = !known
    ? "text-muted-foreground"
    : bars === 4
      ? "text-emerald-600 dark:text-emerald-400"
      : bars === 2
        ? "text-amber-500 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";
  const label = `${t(usesResponse ? "monitor.responseLatency" : "monitor.latency")}: ${known ? `${Number(latency.toFixed(1))} ms` : "--"}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={`inline-flex h-5 shrink-0 items-center ${tone}`}
          data-monitor-latency
          data-monitor-signal-bars={bars}
        >
          <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
            {[4, 7, 10, 13].map((height, index) => (
              <rect
                key={height}
                x={1 + index * 4}
                y={14 - height}
                width="3"
                height={height}
                rx="0.8"
                fill="currentColor"
                opacity={index < bars ? 1 : 0.18}
              />
            ))}
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent className={tooltipClass}>{label}</TooltipContent>
    </Tooltip>
  );
}

const tooltipClass =
  "max-w-sm whitespace-pre-wrap break-words bg-popover text-popover-foreground shadow-md ring-1 ring-border/40";
export function MonitorHostTags({ tags = [] }: { tags?: string[] }) {
  if (!tags.length)
    return (
      <span className="inline-flex h-5 items-center text-[10px] text-muted-foreground">
        --
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex h-5 min-w-0 max-w-full items-center gap-1 overflow-hidden"
          data-monitor-tags
        >
          <Badge
            variant="secondary"
            className="inline-block max-w-20 truncate border-0 px-1.5 py-0 text-[10px] font-normal leading-5"
          >
            {tags[0]}
          </Badge>
          {tags.length > 1 && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              +{tags.length - 1}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className={tooltipClass}>
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="max-w-full break-all text-[10px] font-normal"
            >
              {tag}
            </Badge>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
export function MonitorHostNotes({
  notes,
  focusable = false,
}: {
  notes?: string;
  focusable?: boolean;
}) {
  if (!notes?.trim())
    return <span className="text-[10px] text-muted-foreground">--</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-monitor-notes
          tabIndex={focusable ? 0 : undefined}
          className="block min-w-0 truncate text-[10px] text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          {notes}
        </span>
      </TooltipTrigger>
      <TooltipContent className={`${tooltipClass} max-h-64 overflow-y-auto`}>
        {notes}
      </TooltipContent>
    </Tooltip>
  );
}
