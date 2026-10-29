import {
  Loader2, MonitorPlay, Trash2, Unplug,
} from 'lucide-react';
import React, { memo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { buildZellijAttachCommand } from '../../domain/systemManager/zellijShell';
import type {
  MultiplexerScope,
  ZellijManageAction,
  ZellijSessionInfo,
} from '../../domain/systemManager/types';
import type { TerminalSession } from '../../types';
import {
  SystemPanelInlineError,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelStatusBadge,
} from './SystemPanelUi';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import { openInteractiveTerminal } from './openInteractiveTerminal';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface ZellijSessionCardProps {
  session: ZellijSessionInfo;
  sessionId: string;
  parentSession: TerminalSession;
  backend: Backend;
  runScoped?: <T extends { success: boolean; error?: string; errorCode?: string }>(
    fn: (scope?: MultiplexerScope) => Promise<T>,
  ) => Promise<T>;
  attachTargetUser?: string;
  /** Where attach opens: new main-window tab or a popup window (default popup). */
  muxAttachTarget?: 'tab' | 'window';
  onOpenMuxAttachTab?: (sessionId: string, payload: { title: string; startupCommand: string }) => void;
  onSessionsChanged: () => Promise<void>;
}

export const ZellijSessionCard = memo(function ZellijSessionCard({
  session,
  sessionId,
  parentSession,
  backend,
  runScoped,
  attachTargetUser,
  muxAttachTarget,
  onOpenMuxAttachTab,
  onSessionsChanged,
}: ZellijSessionCardProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<ZellijManageAction['action'] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const runAction = async (action: ZellijManageAction) => {
    setBusy(true);
    setPendingAction(action.action);
    setActionError(null);
    try {
      const execute = (scope?: MultiplexerScope) => backend.zellijAction({ sessionId, scope, ...action });
      const result = runScoped ? await runScoped(execute) : await execute(undefined);
      if (!result.success) throw new Error(result.error || t('systemManager.errors.actionFailed'));
      await onSessionsChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('systemManager.errors.actionFailed'));
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  };

  const handleAttach = async () => {
    const result = await openInteractiveTerminal(
      backend,
      parentSession,
      `zellij: ${session.name}`,
      buildZellijAttachCommand(session.name, { targetUser: attachTargetUser }),
      {
        target: muxAttachTarget === 'tab' ? 'tab' : 'popup',
        onOpenTab: onOpenMuxAttachTab
          ? (payload) => onOpenMuxAttachTab(sessionId, payload)
          : undefined,
      },
    );
    if (!result.success) {
      const message = result.error || t('systemManager.errors.actionFailed');
      setActionError(message);
      showSystemManagerError(message, t('common.error'));
    }
  };

  const statusBadge = session.exited ? (
    <SystemPanelStatusBadge tone="muted">{t('systemManager.zellij.exited')}</SystemPanelStatusBadge>
  ) : session.isCurrent ? (
    <SystemPanelStatusBadge tone="warning">{t('systemManager.zellij.current')}</SystemPanelStatusBadge>
  ) : (
    <SystemPanelStatusBadge tone={session.attached ? 'success' : 'muted'}>
      {session.attached ? t('systemManager.zellij.attached') : t('systemManager.zellij.detached')}
    </SystemPanelStatusBadge>
  );

  return (
    <>
      <SystemPanelRow
        title={session.name}
        subtitle={session.createdText || undefined}
        trailing={(
          <div className="flex shrink-0 items-center gap-1">
            {statusBadge}
            <SystemPanelRoundButton title={t('systemManager.zellij.attach')} onClick={() => void handleAttach()}>
              <MonitorPlay size={12} />
            </SystemPanelRoundButton>
            {!session.exited && (
              <SystemPanelRoundButton
                title={t('systemManager.zellij.killSession')}
                destructive
                disabled={busy}
                loading={pendingAction === 'killSession'}
                onClick={() => setKillConfirmOpen(true)}
              >
                <Unplug size={12} />
              </SystemPanelRoundButton>
            )}
            <SystemPanelRoundButton
              title={t('systemManager.zellij.deleteSession')}
              destructive
              disabled={busy}
              loading={pendingAction === 'deleteSession'}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              {pendingAction === 'deleteSession' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            </SystemPanelRoundButton>
          </div>
        )}
      />

      {actionError && <SystemPanelInlineError message={actionError} />}

      <SystemPanelConfirmDialog
        open={killConfirmOpen}
        title={t('systemManager.zellij.killSession')}
        message={t('systemManager.zellij.confirmKillSession', { name: session.name })}
        confirmLabel={t('systemManager.zellij.killSession')}
        destructive
        busy={busy}
        onOpenChange={setKillConfirmOpen}
        onConfirm={() => {
          setKillConfirmOpen(false);
          void runAction({ action: 'killSession', sessionName: session.name });
        }}
      />

      <SystemPanelConfirmDialog
        open={deleteConfirmOpen}
        title={t('systemManager.zellij.deleteSession')}
        message={t('systemManager.zellij.confirmDeleteSession', { name: session.name })}
        confirmLabel={t('systemManager.zellij.deleteSession')}
        destructive
        busy={busy}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          void runAction({ action: 'deleteSession', sessionName: session.name, force: session.exited });
        }}
      />
    </>
  );
});
