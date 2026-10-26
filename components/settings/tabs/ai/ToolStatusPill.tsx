import React from "react";
import { cn } from "../../../../lib/utils";

export type ToolStatusTone = "active" | "inactive" | "error";

/** Non-interactive runtime status, shared by the MCP and HTTP section headers. */
export const ToolStatusPill: React.FC<{ tone: ToolStatusTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span role="status" className={cn(
    "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium leading-5",
    tone === "active" ? "bg-primary/10 text-primary"
      : tone === "error" ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground",
  )}>{children}</span>
);
