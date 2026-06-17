import {
  Activity,
  Box,
  Cloud,
  Code2,
  Container,
  Cpu,
  Database,
  Globe2,
  HardDrive,
  KeyRound,
  Lock,
  Monitor,
  Network,
  Router,
  Server,
  ServerCog,
  Shield,
  SquareTerminal,
  Wifi,
  Zap,
} from "lucide-react";
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
  globe: Globe2,
  cpu: Cpu,
  "hard-drive": HardDrive,
  network: Network,
  wifi: Wifi,
  lock: Lock,
  key: KeyRound,
  monitor: Monitor,
  container: Container,
  activity: Activity,
  zap: Zap,
  "server-cog": ServerCog,
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
  globe: "hostDetails.icon.option.globe",
  cpu: "hostDetails.icon.option.cpu",
  "hard-drive": "hostDetails.icon.option.hard-drive",
  network: "hostDetails.icon.option.network",
  wifi: "hostDetails.icon.option.wifi",
  lock: "hostDetails.icon.option.lock",
  key: "hostDetails.icon.option.key",
  monitor: "hostDetails.icon.option.monitor",
  container: "hostDetails.icon.option.container",
  activity: "hostDetails.icon.option.activity",
  zap: "hostDetails.icon.option.zap",
  "server-cog": "hostDetails.icon.option.server-cog",
};

export const renderHostIconGlyph = (iconId: HostIconId, className?: string): React.ReactNode => {
  const Icon = HOST_ICON_COMPONENTS[iconId] || Server;
  return <Icon className={className} />;
};
