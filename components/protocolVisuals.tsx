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

export const PROTOCOL_VISUAL_STYLES: Record<ProtocolVisualKey, ProtocolVisualStyle> = {
  ssh: {
    icon: <Shield size={18} />,
    idle: "bg-sky-500/10 text-sky-500",
    selected: "bg-sky-500/20 text-sky-500",
  },
  mosh: {
    icon: <Radio size={18} />,
    idle: "bg-violet-500/10 text-violet-500",
    selected: "bg-violet-500/20 text-violet-500",
  },
  et: {
    icon: <Link2 size={18} />,
    idle: "bg-emerald-500/10 text-emerald-500",
    selected: "bg-emerald-500/20 text-emerald-500",
  },
  telnet: {
    icon: <TerminalIcon size={18} />,
    idle: "bg-amber-500/10 text-amber-500",
    selected: "bg-amber-500/20 text-amber-500",
  },
};

export function getProtocolVisualStyle(protocol: ProtocolVisualKey): ProtocolVisualStyle {
  return PROTOCOL_VISUAL_STYLES[protocol];
}
