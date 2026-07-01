import { RotateCcw } from "lucide-react";
import React from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function HostDetailsOverrideReset({
  label,
  onClick,
  className,
  size = "md",
}: {
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  size?: "md" | "sm";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "shrink-0 border-0 bg-transparent text-primary shadow-none hover:bg-transparent hover:text-primary/80",
            size === "md" ? "h-8 w-8" : "h-7 w-7",
            className,
          )}
          onClick={onClick}
          aria-label={label}
        >
          <RotateCcw size={size === "md" ? 14 : 13} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
