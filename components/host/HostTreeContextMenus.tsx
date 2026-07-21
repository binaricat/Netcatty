import { Copy, FileSymlink, Folder, FolderOpen, Monitor, Pencil, Plus, Server, Settings2 } from 'lucide-react';
import React from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { sanitizeHost } from '../../domain/host';
import type { Host } from '../../types';
import { ContextMenuContent, ContextMenuItem, ContextMenuShortcut } from '../ui/context-menu';
import { collectOwnedPluginMenus, comparePluginMenus, usePluginContributions } from '../../application/state/usePluginContributions';
import { PluginContributionIcon } from '../plugins/PluginContributionIcon';

export interface HostTreeHostContextMenuHandlers {
  onConnect: (host: Host) => void;
  onEditHost?: (host: Host) => void;
  onRenameHost?: (host: Host) => void;
  onDuplicateHost: (host: Host) => void;
  onCopyCredentials: (host: Host) => void;
  onDeleteHost: (host: Host) => void;
}

export const HostTreeHostContextMenuContent: React.FC<
  HostTreeHostContextMenuHandlers & { host: Host }
> = ({
  host,
  onConnect,
  onEditHost,
  onRenameHost,
  onDuplicateHost,
  onCopyCredentials,
  onDeleteHost,
}) => {
  const { t } = useI18n();
  const safeHost = sanitizeHost(host);
  const pluginContributions = usePluginContributions({
    context: {
      'netcatty.surface': 'host/context',
      'host.id': safeHost.id,
      'host.protocol': safeHost.protocol ?? 'ssh',
    },
  });
  const pluginMenus = collectOwnedPluginMenus(pluginContributions.snapshot.plugins)
    .filter((menu) => menu.location === 'host/context' && menu.visible)
    .sort(comparePluginMenus);

  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onConnect(safeHost)}>
        <Monitor className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
      </ContextMenuItem>
      {onEditHost && (
        <ContextMenuItem onClick={() => onEditHost(host)}>
          <Settings2 className="mr-2 h-4 w-4" /> {t('terminal.layer.hostTree.editHost')}
        </ContextMenuItem>
      )}
      {onRenameHost && (
        <ContextMenuItem onClick={() => onRenameHost(host)}>
          <Pencil className="mr-2 h-4 w-4" /> {t('common.rename')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onDuplicateHost(host)}>
        <Copy className="mr-2 h-4 w-4" /> {t('action.duplicate')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyCredentials(host)}>
        <Server className="mr-2 h-4 w-4" /> {t('vault.hosts.copyCredentials')}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => onDeleteHost(host)}
        className="text-destructive focus:text-destructive"
      >
        <Server className="mr-2 h-4 w-4" /> {t('action.delete')}
      </ContextMenuItem>
      {pluginMenus.map((menu) => (
        <ContextMenuItem
          key={menu.id}
          disabled={!menu.enabled}
          onClick={(event) => void pluginContributions.executeCommand(event.altKey && menu.alt ? menu.alt : menu.command, { hostId: safeHost.id }, {
            'netcatty.surface': 'host/context',
            'host.id': safeHost.id,
            'host.protocol': safeHost.protocol ?? 'ssh',
          }).catch(() => {})}
        >
          <PluginContributionIcon pluginId={menu.pluginId} icon={menu.icon} className="mr-2" />
          {menu.title}
          {menu.checked && <span className="ml-auto pl-4" aria-hidden="true">✓</span>}
          {menu.shortcut && <ContextMenuShortcut>{menu.shortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  );
};

export interface HostTreeGroupContextMenuHandlers {
  onNewHost?: (groupPath: string) => void;
  onNewGroup: (parentPath?: string) => void;
  onRenameGroup: (groupPath: string) => void;
  onDeleteGroup: (groupPath: string) => void;
  onUnmanageGroup?: (groupPath: string) => void;
}

export const HostTreeGroupContextMenuContent: React.FC<
  HostTreeGroupContextMenuHandlers & { groupPath: string; isManaged: boolean }
> = ({
  groupPath,
  isManaged,
  onNewHost,
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
  onUnmanageGroup,
}) => {
  const { t } = useI18n();

  return (
    <ContextMenuContent>
      {onNewHost && (
        <ContextMenuItem onClick={() => onNewHost(groupPath)}>
          <Plus className="mr-2 h-4 w-4" /> {t('terminal.layer.hostTree.newHostInGroup')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onNewGroup(groupPath)}>
        <Folder className="mr-2 h-4 w-4" /> {t('vault.hosts.newGroup')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRenameGroup(groupPath)}>
        <FolderOpen className="mr-2 h-4 w-4" /> {t('vault.groups.rename')}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => onDeleteGroup(groupPath)}
        className="text-destructive focus:text-destructive"
      >
        <FolderOpen className="mr-2 h-4 w-4" /> {t('vault.groups.delete')}
      </ContextMenuItem>
      {isManaged && onUnmanageGroup && (
        <ContextMenuItem onClick={() => onUnmanageGroup(groupPath)}>
          <FileSymlink className="mr-2 h-4 w-4" /> {t('vault.managedSource.unmanage')}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
};
