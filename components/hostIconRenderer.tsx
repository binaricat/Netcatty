import { Box, Cloud, Code2, Database, Router, Server, Shield, SquareTerminal } from "lucide-react";
import React from "react";
import type { HostIconId } from "../domain/models";

const HOST_ICON_COMPONENTS = {
  server: Server,
  terminal: SquareTerminal,
  database: Database,
  cloud: Cloud,
  router: Router,
  shield: Shield,
  code: Code2,
  box: Box,
} as const satisfies Record<HostIconId, React.ComponentType<{ className?: string; size?: number }>>;

export const HOST_ICON_LABEL_KEYS: Record<HostIconId, string> = {
  server: "hostDetails.icon.option.server",
  terminal: "hostDetails.icon.option.terminal",
  database: "hostDetails.icon.option.database",
  cloud: "hostDetails.icon.option.cloud",
  router: "hostDetails.icon.option.router",
  shield: "hostDetails.icon.option.shield",
  code: "hostDetails.icon.option.code",
  box: "hostDetails.icon.option.box",
};

export const renderHostIconGlyph = (iconId: HostIconId, className?: string): React.ReactNode => {
  const Icon = HOST_ICON_COMPONENTS[iconId] || Server;
  return <Icon className={className} />;
};
