import {
  Link2,
  Radio,
  Shield,
  Terminal as TerminalIcon,
} from "lucide-react";
import React from "react";
import type { HostProtocol } from "../types";

export type ProtocolVisualKey = Extract<HostProtocol, "ssh" | "mosh" | "et" | "telnet">;

export interface ProtocolVisualStyle {
  icon: React.ReactNode;
  idle: string;
  selected: string;
}

export const PROTOCOL_OPTION_CARD_BASE_CLASS =
  "group w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left";

export const PROTOCOL_OPTION_CARD_SELECTED_CLASS =
  "border-primary bg-primary/12 shadow-sm ring-1 ring-primary/30";

export const PROTOCOL_OPTION_CARD_IDLE_CLASS =
  "border-border/60 bg-background/60 hover:border-border hover:bg-secondary/50";

export const PROTOCOL_OPTION_TITLE_SELECTED_CLASS = "font-semibold text-foreground";

export const PROTOCOL_OPTION_TITLE_IDLE_CLASS =
  "font-medium text-muted-foreground group-hover:text-foreground transition-colors";

export const PROTOCOL_OPTION_SUBTITLE_SELECTED_CLASS = "text-xs text-foreground/75 font-mono";

export const PROTOCOL_OPTION_SUBTITLE_IDLE_CLASS = "text-xs text-muted-foreground font-mono";

export function getProtocolOptionCardClass(selected: boolean): string {
  return `${PROTOCOL_OPTION_CARD_BASE_CLASS} ${
    selected ? PROTOCOL_OPTION_CARD_SELECTED_CLASS : PROTOCOL_OPTION_CARD_IDLE_CLASS
  }`;
}

export const PROTOCOL_VISUAL_STYLES: Record<ProtocolVisualKey, ProtocolVisualStyle> = {
  ssh: {
    icon: <Shield size={18} />,
    idle: "bg-sky-500/10 text-sky-500",
    selected: "bg-sky-500 text-white shadow-sm",
  },
  mosh: {
    icon: <Radio size={18} />,
    idle: "bg-violet-500/10 text-violet-500",
    selected: "bg-violet-500 text-white shadow-sm",
  },
  et: {
    icon: <Link2 size={18} />,
    idle: "bg-emerald-500/10 text-emerald-500",
    selected: "bg-emerald-500 text-white shadow-sm",
  },
  telnet: {
    icon: <TerminalIcon size={18} />,
    idle: "bg-amber-500/10 text-amber-500",
    selected: "bg-amber-500 text-white shadow-sm",
  },
};

export function getProtocolVisualStyle(protocol: ProtocolVisualKey): ProtocolVisualStyle {
  return PROTOCOL_VISUAL_STYLES[protocol];
}
