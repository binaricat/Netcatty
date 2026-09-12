import React from 'react';

import type { useI18n } from '../../application/i18n/I18nProvider';
import type { Host, TerminalSession } from '../../types';
import { ContextMenuContent, ContextMenuItem } from '../ui/context-menu';

type TranslateFn = ReturnType<typeof useI18n>['t'];

interface SessionTabContextMenuContentProps {
  sessionId: string;
  onCloseSession: (sessionId: string) => void;
  onCopySession?: (sessionId: string) => void;
  /** Duplicate the session with a brand-new connection (fresh auth, e.g. a new bastion login). */
  onDuplicateSession?: (sessionId: string) => void;
  onCopySessionToNewWindow?: (sessionId: string) => void;
  onDetachSession?: (sessionId: string) => void;
  onReconnectSession: (sessionId: string) => void;
  sessionStatus: TerminalSession['status'];
  reconnectActive?: boolean;
  onRenameSession: (sessionId: string) => void;
  /** Vault host for this session; omit edit when missing (e.g. local shell). */
  editHost?: Host;
  onEditHost?: (host: Host) => void;
  renderBulkCloseItems?: (anchorId: string) => React.ReactNode;
  t: TranslateFn;
}

export function SessionTabContextMenuContent({
  sessionId,
  onCloseSession,
  onCopySession,
  onDuplicateSession,
  onCopySessionToNewWindow,
  onDetachSession,
  onReconnectSession,
  sessionStatus,
  reconnectActive = false,
  onRenameSession,
  editHost,
  onEditHost,
  renderBulkCloseItems,
  t,
}: SessionTabContextMenuContentProps) {
  return (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={isSessionReconnectDisabled(sessionStatus, reconnectActive)}
        onClick={() => onReconnectSession(sessionId)}
      >
        {t('terminal.menu.reconnect')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRenameSession(sessionId)}>
        {t('common.rename')}
      </ContextMenuItem>
      {editHost && onEditHost && (
        <ContextMenuItem onClick={() => onEditHost(editHost)}>
          {t('terminal.layer.hostTree.editHost')}
        </ContextMenuItem>
      )}
      {onCopySession && (
        <ContextMenuItem onClick={() => onCopySession(sessionId)}>
          {t('tabs.copyTab')}
        </ContextMenuItem>
      )}
      {onDuplicateSession && (
        <ContextMenuItem onClick={() => onDuplicateSession(sessionId)}>
          {t('tabs.duplicateSession')}
        </ContextMenuItem>
      )}
      {onCopySessionToNewWindow && (
        <ContextMenuItem onClick={() => onCopySessionToNewWindow(sessionId)}>
          {t('tabs.copyTabToNewWindow')}
        </ContextMenuItem>
      )}
      {onDetachSession && (
        <ContextMenuItem onClick={() => onDetachSession(sessionId)}>
          {t('terminal.menu.detach')}
        </ContextMenuItem>
      )}
      <ContextMenuItem className="text-destructive" onClick={() => onCloseSession(sessionId)}>
        {t('common.close')}
      </ContextMenuItem>
      {renderBulkCloseItems?.(sessionId)}
    </ContextMenuContent>
  );
}

export const isSessionReconnectDisabled = (
  status: TerminalSession['status'],
  reconnectActive = false,
): boolean => (
  status === 'connecting' || reconnectActive
);
