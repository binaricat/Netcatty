import { FileText } from "lucide-react";
import React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const NOTES_TOOLTIP_MAX = 160;

export function getHostNotesTooltipPreview(notes: string): string {
  const flat = notes.replace(/\s+/g, " ").trim();
  if (flat.length <= NOTES_TOOLTIP_MAX) return flat;
  return `${flat.slice(0, NOTES_TOOLTIP_MAX)}...`;
}

export interface HostNotesIndicatorProps {
  notes?: string;
  className?: string;
}

export const HostNotesIndicator: React.FC<HostNotesIndicatorProps> = ({
  notes,
  className,
}) => {
  if (!notes?.trim()) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={className}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <FileText size={12} className="text-muted-foreground" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs whitespace-pre-wrap">
        {getHostNotesTooltipPreview(notes)}
      </TooltipContent>
    </Tooltip>
  );
};
