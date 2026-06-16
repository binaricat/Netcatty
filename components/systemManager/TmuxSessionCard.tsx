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
import { openInteractiveTerminal } from './openInteractiveTerminal';
import { showSystemManagerError } from './systemManagerToast';

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

interface TmuxSessionCardProps {
  session: TmuxSessionInfo;
  sessionId: string;
  parentSession: TerminalSession;
  backend: Backend;
  detailsRecord?: AsyncRecordState<TmuxSessionDetails>;
  onLoadDetails: (session: TmuxSessionInfo, options?: { force?: boolean; urgent?: boolean }) => Promise<void>;
  onRefreshDetails: (session: TmuxSessionInfo) => Promise<void>;
  onSessionsChanged: () => Promise<void>;
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
}: TmuxSessionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [renamePrompt, setRenamePrompt] = useState<RenamePromptTarget | null>(null);
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
      const result = await backend.tmuxAction({ sessionId, ...action });
      if (!result.success) throw new Error(result.error || t('systemManager.errors.actionFailed'));
      const cardWillRemount = action.action === 'killSession' || action.action === 'renameSession';
      if (!cardWillRemount && expanded) {
        await onRefreshDetails(session);
      }
      await onSessionsChanged();
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
                onClick={() => {
                  if (globalThis.confirm(t('systemManager.tmux.confirmDetachSession', { name: session.name }))) {
                    void runAction({ action: 'detachSession', sessionName: session.name });
                  }
                }}
              >
                <Unplug size={12} />
              </SystemPanelRoundButton>
            )}
            <SystemPanelRoundButton
              title={t('systemManager.tmux.killSession')}
              destructive
              disabled={busy}
              loading={isPending('killSession')}
              onClick={() => {
                if (globalThis.confirm(t('systemManager.tmux.confirmKillSession', { name: session.name }))) {
                  void runAction({ action: 'killSession', sessionName: session.name });
                }
              }}
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
                  onClick={() => {
                    if (globalThis.confirm(t('systemManager.tmux.confirmKillWindow', {
                      name: tmuxWindow.name || String(tmuxWindow.index),
                    }))) {
                      void runAction({
                        action: 'killWindow',
                        sessionName: session.name,
                        windowIndex: tmuxWindow.index,
                      });
                    }
                  }}
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
