import React from 'react';

import type { useI18n } from '../../application/i18n/I18nProvider';
import { ContextMenuContent, ContextMenuItem } from '../ui/context-menu';

type TranslateFn = ReturnType<typeof useI18n>['t'];

interface SessionTabContextMenuContentProps {
  sessionId: string;
  onCloseSession: (sessionId: string) => void;
  onCopySession?: (sessionId: string) => void;
  onCopySessionToNewWindow?: (sessionId: string) => void;
  onDetachSession?: (sessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
  renderBulkCloseItems?: (anchorId: string) => React.ReactNode;
  t: TranslateFn;
}

export function SessionTabContextMenuContent({
  sessionId,
  onCloseSession,
  onCopySession,
  onCopySessionToNewWindow,
  onDetachSession,
  onRenameSession,
  renderBulkCloseItems,
  t,
}: SessionTabContextMenuContentProps) {
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onRenameSession(sessionId)}>
        {t('common.rename')}
      </ContextMenuItem>
      {onCopySession && (
        <ContextMenuItem onClick={() => onCopySession(sessionId)}>
          {t('tabs.copyTab')}
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
