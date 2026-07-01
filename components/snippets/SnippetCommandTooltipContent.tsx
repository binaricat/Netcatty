import React from "react";

import { formatSnippetCommandTooltip } from "@/domain/snippetPreview";
import { cn } from "@/lib/utils";

export function SnippetCommandTooltipContent({
  label,
  command,
  className,
  fallback,
}: {
  label?: string;
  command: string;
  className?: string;
  fallback?: string;
}) {
  const preview = formatSnippetCommandTooltip(command);

  return (
    <div className={cn("max-w-sm", className)}>
      {label ? (
        <div className="mb-1 break-all text-xs font-medium">{label}</div>
      ) : null}
      <pre className="max-h-36 overflow-hidden font-mono text-[11px] leading-snug whitespace-pre-wrap break-all">
        {preview || fallback || "—"}
      </pre>
    </div>
  );
}
