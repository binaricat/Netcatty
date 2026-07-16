import {
  Loader2, MonitorPlay, Pencil, Plus, Trash2, Unplug,
} from 'lucide-react';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { buildTmuxAttachCommand } from '../../domain/systemManager/tmuxShell';
import type {
  TmuxManageAction,
  TmuxSessionInfo,
} from '../../domain/systemManager/types';
import type { TerminalSession } from '../../types';
import type { AsyncRecordState } from './hooks/useAsyncRecordCache';
import type { TmuxSessionDetails } from './TmuxManagerTab';
import {
  SystemPanelCollapsible,
  SystemPanelDetailStrip,
  SystemPanelInlineError,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSectionHeader,
  SystemPanelStatusBadge,
} from './SystemPanelUi';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import { openInteractiveTerminal } from './openInteractiveTerminal';
import { showSystemManagerError } from './systemManagerToast';
import { runTmuxSessionAction } from './tmuxActionFocus';

type Backend = ReturnType<typeof useSystemManagerBackend>;
const TMUX_POPUP_ICON = {
  kind: 'image',
  src: '/system-icons/tmux.svg',
  alt: 'tmux',
} as const;

type RenamePromptTarget =
  | { kind: 'session' }
  | { kind: 'window'; windowIndex: number; currentName: string };

interface PendingTarget {
  action: TmuxManageAction['action'];
  windowIndex?: number;
}

interface ConfirmTmuxDetachOptions {
  sessionName: string;
  confirmMessage: string;
  confirm: (message: string) => boolean;
  runAction: (action: TmuxManageAction) => Promise<void>;
}

export async function runConfirmedTmuxDetachAction({
  sessionName,
  confirmMessage,
  confirm,
  runAction,
}: ConfirmTmuxDetachOptions): Promise<boolean> {
  if (!confirm(confirmMessage)) return false;
  await runAction({ action: 'detachSession', sessionName });
  return true;
}

interface TmuxSessionCardProps {
  session: TmuxSessionInfo;
  sessionId: string;
  parentSession: TerminalSession;
  backend: Backend;
  detailsRecord?: AsyncRecordState<TmuxSessionDetails>;
  onLoadDetails: (session: TmuxSessionInfo, options?: { force?: boolean; urgent?: boolean }) => Promise<void>;
  onRefreshDetails: (session: TmuxSessionInfo) => Promise<void>;
  onSessionsChanged: () => Promise<void>;
  onRequestTerminalFocus?: () => void;
}

export const TmuxSessionCard = memo(function TmuxSessionCard({
  session,
  sessionId,
  parentSession,
  backend,
  detailsRecord,
  onLoadDetails,
  onRefreshDetails,
  onSessionsChanged,
  onRequestTerminalFocus,
}: TmuxSessionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [renamePrompt, setRenamePrompt] = useState<RenamePromptTarget | null>(null);
  const [detachConfirmOpen, setDetachConfirmOpen] = useState(false);
  const [killSessionConfirmOpen, setKillSessionConfirmOpen] = useState(false);
  const [killWindowConfirm, setKillWindowConfirm] = useState<{
    windowIndex: number;
    windowName: string;
  } | null>(null);
  const [newWindowOpen, setNewWindowOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingTarget | null>(null);

  const windows = detailsRecord?.data?.windows ?? [];
  const clients = detailsRecord?.data?.clients ?? [];
  const loadingDetails = detailsRecord?.loading ?? false;
  const windowsLoadDetail = detailsRecord?.error ?? null;
  const summaryKey = useMemo(
    () => `${session.name}|${session.created}|${session.windows}|${session.attached}|${session.activity ?? ''}`,
    [session.activity, session.attached, session.created, session.name, session.windows],
  );
  const lastExpandedSummaryKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!expanded) {
      lastExpandedSummaryKeyRef.current = null;
      return;
    }
    if (lastExpandedSummaryKeyRef.current === null) {
      lastExpandedSummaryKeyRef.current = summaryKey;
      return;
    }
    if (lastExpandedSummaryKeyRef.current === summaryKey) return;
    lastExpandedSummaryKeyRef.current = summaryKey;
    void onRefreshDetails(session);
  }, [expanded, onRefreshDetails, session, summaryKey]);

  const runAction = async (action: TmuxManageAction) => {
    setBusy(true);
    setPending({
      action: action.action,
      windowIndex: 'windowIndex' in action ? action.windowIndex : undefined,
    });
    setActionError(null);
    try {
      const cardWillRemount = action.action === 'killSession' || action.action === 'renameSession';
      const result = await runTmuxSessionAction({
        sessionId,
        action,
        tmuxAction: backend.tmuxAction,
        onRefreshDetails: !cardWillRemount && expanded ? () => onRefreshDetails(session) : undefined,
        onSessionsChanged,
        onRequestTerminalFocus,
      });
      if (!result.success) throw new Error(result.error || t('systemManager.errors.actionFailed'));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('systemManager.errors.actionFailed'));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const isPending = (action: TmuxManageAction['action'], windowIndex?: number) =>
    pending !== null
    && pending.action === action
    && pending.windowIndex === windowIndex;

  const handleAttach = async (windowIndex?: number) => {
    const result = await openInteractiveTerminal(
      backend,
      parentSession,
      windowIndex !== undefined ? `tmux: ${session.name}:${windowIndex}` : `tmux: ${session.name}`,
      buildTmuxAttachCommand(session.name, windowIndex),
      { icon: TMUX_POPUP_ICON },
    );
    if (!result.success) {
      const message = result.error || t('systemManager.errors.actionFailed');
      setActionError(message);
      showSystemManagerError(message, t('common.error'));
    }
  };

  return (
    <>
      <SystemPanelRow
        selected={expanded}
        onClick={() => {
          const nextExpanded = !expanded;
          setExpanded(nextExpanded);
          if (nextExpanded) {
            void onLoadDetails(session, { force: true, urgent: true });
          }
        }}
        title={session.name}
        subtitle={t('systemManager.tmux.windows', { count: String(session.windows) })}
        trailing={(
          <div className="flex shrink-0 items-center gap-1">
            <SystemPanelStatusBadge tone={session.attached ? 'success' : 'muted'}>
              {session.attached ? t('systemManager.tmux.attached') : t('systemManager.tmux.detached')}
            </SystemPanelStatusBadge>
            <SystemPanelRoundButton title={t('systemManager.tmux.attach')} onClick={() => handleAttach()}>
              <MonitorPlay size={12} />
            </SystemPanelRoundButton>
            <SystemPanelRoundButton
              title={t('systemManager.tmux.rename')}
              disabled={busy}
              onClick={() => setRenamePrompt({ kind: 'session' })}
            >
              <Pencil size={12} />
            </SystemPanelRoundButton>
            {session.attached && (
              <SystemPanelRoundButton
                title={t('systemManager.tmux.detach')}
                disabled={busy}
                loading={isPending('detachSession')}
                onClick={() => setDetachConfirmOpen(true)}
              >
                <Unplug size={12} />
              </SystemPanelRoundButton>
            )}
            <SystemPanelRoundButton
              title={t('systemManager.tmux.killSession')}
              destructive
              disabled={busy}
              loading={isPending('killSession')}
              onClick={() => setKillSessionConfirmOpen(true)}
            >
              <Trash2 size={12} />
            </SystemPanelRoundButton>
          </div>
        )}
      />

      {actionError && <SystemPanelInlineError message={actionError} />}

      <SystemPanelCollapsible open={expanded}>
        {loadingDetails && windows.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-muted-foreground border-b border-border/30">
            {t('systemManager.tmux.loadingDetails')}
          </div>
        )}

        {clients.length > 0 && (
          <SystemPanelDetailStrip>
            <div className="text-[10px] text-muted-foreground">
              {t('systemManager.tmux.clients')}: {clients.map((c) => c.tty || c.name).join(', ')}
            </div>
          </SystemPanelDetailStrip>
        )}

        <SystemPanelSectionHeader
          trailing={(
            <button
              type="button"
              disabled={busy}
              onClick={() => setNewWindowOpen(true)}
              className="shrink-0 h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex items-center gap-1 disabled:opacity-40"
            >
              {isPending('createWindow')
                ? <Loader2 size={10} className="animate-spin" />
                : <Plus size={10} />}
              {t('systemManager.tmux.newWindow')}
            </button>
          )}
        >
          {t('systemManager.tmux.windowList')}{windows.length > 0 ? ` · ${windows.length}` : ''}
        </SystemPanelSectionHeader>

        {windows.map((tmuxWindow) => (
          <SystemPanelRow
            key={tmuxWindow.index}
            depth={1}
            title={`#${tmuxWindow.index} ${tmuxWindow.name || t('systemManager.tmux.unnamedWindow')}`}
            trailing={(
              <div className="flex shrink-0 items-center gap-1">
                <SystemPanelRoundButton
                  title={t('systemManager.tmux.attachWindow')}
                  onClick={() => handleAttach(tmuxWindow.index)}
                >
                  <MonitorPlay size={11} />
                </SystemPanelRoundButton>
                <SystemPanelRoundButton
                  title={t('systemManager.tmux.rename')}
                  disabled={busy}
                  onClick={() => setRenamePrompt({
                    kind: 'window',
                    windowIndex: tmuxWindow.index,
                    currentName: tmuxWindow.name,
                  })}
                >
                  <Pencil size={11} />
                </SystemPanelRoundButton>
                <SystemPanelRoundButton
                  title={t('systemManager.tmux.killWindow')}
                  destructive
                  disabled={busy}
                  loading={isPending('killWindow', tmuxWindow.index)}
                  onClick={() => setKillWindowConfirm({
                    windowIndex: tmuxWindow.index,
                    windowName: tmuxWindow.name || String(tmuxWindow.index),
                  })}
                >
                  <Trash2 size={11} />
                </SystemPanelRoundButton>
              </div>
            )}
          />
        ))}

        {!loadingDetails && windows.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-muted-foreground border-b border-border/30 break-all">
            {windowsLoadDetail || actionError || t('systemManager.tmux.noWindows')}
          </div>
        )}
      </SystemPanelCollapsible>

      <SystemPanelConfirmDialog
        open={detachConfirmOpen}
        title={t('systemManager.tmux.detach')}
        message={t('systemManager.tmux.confirmDetachSession', { name: session.name })}
        confirmLabel={t('systemManager.tmux.detach')}
        destructive
        busy={busy}
        onOpenChange={setDetachConfirmOpen}
        onConfirm={() => {
          setDetachConfirmOpen(false);
          void runAction({ action: 'detachSession', sessionName: session.name });
        }}
      />

      <SystemPanelConfirmDialog
        open={killSessionConfirmOpen}
        title={t('systemManager.tmux.killSession')}
        message={t('systemManager.tmux.confirmKillSession', { name: session.name })}
        confirmLabel={t('systemManager.tmux.killSession')}
        destructive
        busy={busy}
        onOpenChange={setKillSessionConfirmOpen}
        onConfirm={() => {
          setKillSessionConfirmOpen(false);
          void runAction({ action: 'killSession', sessionName: session.name });
        }}
      />

      <SystemPanelConfirmDialog
        open={killWindowConfirm !== null}
        title={t('systemManager.tmux.killWindow')}
        message={t('systemManager.tmux.confirmKillWindow', {
          name: killWindowConfirm?.windowName ?? '',
        })}
        confirmLabel={t('systemManager.tmux.killWindow')}
        destructive
        busy={busy}
        onOpenChange={(open) => { if (!open) setKillWindowConfirm(null); }}
        onConfirm={() => {
          const target = killWindowConfirm;
          setKillWindowConfirm(null);
          if (!target) return;
          void runAction({
            action: 'killWindow',
            sessionName: session.name,
            windowIndex: target.windowIndex,
          });
        }}
      />

      <SystemPanelPromptDialog
        open={renamePrompt !== null}
        title={renamePrompt?.kind === 'window'
          ? t('systemManager.tmux.renameWindowPrompt')
          : t('systemManager.tmux.renameSessionPrompt')}
        fields={[{
          id: 'name',
          label: renamePrompt?.kind === 'window'
            ? t('systemManager.tmux.windowName')
            : t('systemManager.tmux.newSessionName'),
          initialValue: renamePrompt?.kind === 'window' ? renamePrompt.currentName : session.name,
        }]}
        confirmLabel={t('common.rename')}
        busy={busy}
        onOpenChange={(open) => { if (!open) setRenamePrompt(null); }}
        onSubmit={(values) => {
          const target = renamePrompt;
          setRenamePrompt(null);
          if (!target) return;
          if (target.kind === 'session') {
            if (values.name !== session.name) {
              void runAction({ action: 'renameSession', sessionName: session.name, newName: values.name });
            }
          } else if (values.name !== target.currentName) {
            void runAction({
              action: 'renameWindow',
              sessionName: session.name,
              windowIndex: target.windowIndex,
              newName: values.name,
            });
          }
        }}
      />

      <SystemPanelPromptDialog
        open={newWindowOpen}
        title={t('systemManager.tmux.newWindow')}
        fields={[{
          id: 'name',
          label: t('systemManager.tmux.windowName'),
          placeholder: t('systemManager.tmux.newWindowPlaceholder'),
          required: false,
        }]}
        confirmLabel={t('common.create')}
        busy={busy}
        onOpenChange={setNewWindowOpen}
        onSubmit={(values) => {
          setNewWindowOpen(false);
          void runAction({
            action: 'createWindow',
            sessionName: session.name,
            windowName: values.name || undefined,
          });
        }}
      />
    </>
  );
});
