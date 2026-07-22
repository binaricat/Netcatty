import { HelpCircle } from "lucide-react";
import React from "react";
import { cn } from "../../lib/utils";
import { Card } from "../ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function HostDetailsHelp({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  if (!children) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative -top-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [&>svg]:block",
            className,
          )}
          aria-label={typeof children === "string" ? children : undefined}
        >
          <HelpCircle size={13} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-left leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

export function HostDetailsSection({
  icon,
  title,
  hint,
  children,
  className,
  action,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className={cn("p-3 space-y-3 bg-card border-border/80 shadow-sm", className)}>
      <div className="flex min-h-5 items-center gap-1.5">
        <span className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground [&>img]:block [&>img]:h-4 [&>img]:w-4 [&>img]:object-contain [&>svg]:block [&>svg]:h-4 [&>svg]:w-4">
          {icon}
        </span>
        <p className="flex min-h-5 items-center text-xs font-semibold leading-5 text-foreground">
          {title}
        </p>
        {hint && <HostDetailsHelp>{hint}</HostDetailsHelp>}
        {action && <div className="ml-auto flex items-center">{action}</div>}
      </div>
      {children}
    </Card>
  );
}

export function HostDetailsSettingRow({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Fixed height so switch / select / input rows stay aligned.
        "flex h-12 items-center justify-between gap-3 rounded-lg border border-border/60 bg-secondary/40 px-3",
        className,
      )}
    >
      <div className="flex min-h-5 min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium leading-5 text-foreground">{label}</span>
        {hint && <HostDetailsHelp>{hint}</HostDetailsHelp>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
