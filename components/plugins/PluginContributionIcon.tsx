import {
  Activity,
  Box,
  Code,
  Command,
  Database,
  FileText,
  Folder,
  Globe,
  HardDrive,
  Key,
  Layers,
  LayoutPanelLeft,
  List,
  Network,
  Palette,
  Play,
  Puzzle,
  Server,
  Settings,
  Shield,
  Sparkles,
  Table,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import React from 'react';

import { usePluginContributionIcon } from '../../application/state/usePluginContributionIcon';
import { cn } from '../../lib/utils';

const THEME_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  activity: Activity,
  box: Box,
  code: Code,
  command: Command,
  database: Database,
  file: FileText,
  folder: Folder,
  globe: Globe,
  'hard-drive': HardDrive,
  key: Key,
  layers: Layers,
  'layout-panel': LayoutPanelLeft,
  list: List,
  network: Network,
  palette: Palette,
  play: Play,
  server: Server,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  table: Table,
  terminal: Terminal,
  wrench: Wrench,
});

export function PluginContributionIcon({
  pluginId,
  icon,
  size = 14,
  className,
}: {
  pluginId?: string;
  icon?: NetcattyPluginIconReference;
  size?: number;
  className?: string;
}) {
  const packageIcon = usePluginContributionIcon(pluginId, icon);

  if (icon?.kind === 'theme') {
    const Icon = Object.hasOwn(THEME_ICONS, icon.name) ? THEME_ICONS[icon.name] : Puzzle;
    return <Icon size={size} className={className} aria-hidden="true" data-plugin-icon-kind="theme" />;
  }
  if (packageIcon) {
    return (
      <span
        className={cn('inline-flex items-center justify-center', className)}
        style={{ width: size, height: size }}
        aria-hidden="true"
        data-plugin-icon-kind="package"
      >
        <img src={packageIcon.light} alt="" width={size} height={size} className={packageIcon.dark ? 'h-full w-full object-contain dark:hidden' : 'h-full w-full object-contain'} />
        {packageIcon.dark && <img src={packageIcon.dark} alt="" width={size} height={size} className="hidden h-full w-full object-contain dark:block" />}
      </span>
    );
  }
  return <Puzzle size={size} className={className} aria-hidden="true" data-plugin-icon-kind="fallback" />;
}
