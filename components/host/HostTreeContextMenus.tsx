import { Copy, FileSymlink, Folder, FolderOpen, Monitor, Pencil, Server } from 'lucide-react';
import React from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { sanitizeHost } from '../../domain/host';
import type { Host } from '../../types';
import { ContextMenuContent, ContextMenuItem } from '../ui/context-menu';

export interface HostTreeHostContextMenuHandlers {
  onConnect: (host: Host) => void;
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
  onRenameHost,
  onDuplicateHost,
  onCopyCredentials,
  onDeleteHost,
}) => {
  const { t } = useI18n();
  const safeHost = sanitizeHost(host);

  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onConnect(safeHost)}>
        <Monitor className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
      </ContextMenuItem>
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
    </ContextMenuContent>
  );
};

export interface HostTreeGroupContextMenuHandlers {
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
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
  onUnmanageGroup,
}) => {
  const { t } = useI18n();

  return (
    <ContextMenuContent>
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
