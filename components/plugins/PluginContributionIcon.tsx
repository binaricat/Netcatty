import {
  Activity,
  Box,
  Code,
  Command,
  FileText,
  Folder,
  Globe,
  Key,
  LayoutPanelLeft,
  List,
  Network,
  Palette,
  Play,
  Puzzle,
  Settings,
  Shield,
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
  file: FileText,
  folder: Folder,
  globe: Globe,
  key: Key,
  'layout-panel': LayoutPanelLeft,
  list: List,
  network: Network,
  palette: Palette,
  play: Play,
  settings: Settings,
  shield: Shield,
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
