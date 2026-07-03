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

export const renderHostIconGlyph = (iconId: HostIconId, className?: string): React.ReactNode => {
  const Icon = HOST_ICON_COMPONENTS[iconId] || Server;
  return <Icon className={className} />;
};
