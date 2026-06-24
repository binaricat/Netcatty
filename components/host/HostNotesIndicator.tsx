import { FileText } from "lucide-react";
import React from "react";
import { cn } from "../../lib/utils";
import { LazyMessageResponse } from "../ai-elements/LazyMessageResponse";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";

export interface HostNotesIndicatorProps {
  notes?: string;
  className?: string;
}

export const HostNotesIndicator: React.FC<HostNotesIndicatorProps> = ({
  notes,
  className,
}) => {
  const trimmed = notes?.trim();
  if (!trimmed) return null;

  return (
    <HoverCard openDelay={180} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground",
            className,
          )}
          aria-label="Host notes"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <FileText size={12} className="text-muted-foreground" aria-hidden />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        className="w-[320px] max-w-[calc(100vw-32px)] p-3"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="max-h-[240px] overflow-y-auto pr-1">
          <LazyMessageResponse className="text-xs leading-relaxed text-popover-foreground/90 [&_h1]:text-sm [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:mt-1.5 [&_h3]:mb-1 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1">
            {trimmed}
          </LazyMessageResponse>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};
