import { LayoutGrid, Plus } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { Host, Identity, SSHKey, TerminalSession } from '../../types';
import type { ZellijSessionInfo } from '../../domain/systemManager/types';
import { zellijSessionInfoEqual } from '../../domain/systemManager/pollEquals';
import { buildZellijAttachCommand } from '../../domain/systemManager/zellijShell';
import {
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelIconButton,
  SystemPanelList,
  SystemPanelLoading,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelSearch,
  SystemPanelShell,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { usePolling, useStableTranslate } from '../../application/state/useSystemManager';
import { useStableListOrder, mergePollListByKey } from './listStable';
import { useMultiplexerScope } from './useMultiplexerScope';
import { MultiplexerUserSelect } from './MultiplexerUserSelect';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';
import { ZellijSessionCard } from './ZellijSessionCard';
import { openInteractiveTerminal } from './openInteractiveTerminal';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface ZellijManagerTabProps {
  sessionId: string;
  parentSession: TerminalSession;
  isVisible: boolean;
  warmupEnabled?: boolean;
  backend: Backend;
  refreshIntervalSec: number;
  autoSync?: boolean;
  host?: Host | null;
  keys?: SSHKey[];
  identities?: Identity[];
  onUpdateHost?: (host: Host) => void;
  /** Where attach opens: new main-window tab or a popup window (default popup). */
  muxAttachTarget?: 'tab' | 'window';
  onOpenMuxAttachTab?: (sessionId: string, payload: { title: string; startupCommand: string }) => void;
}

export const ZellijManagerTab = memo(function ZellijManagerTab({
  sessionId,
  parentSession,
  isVisible,
  warmupEnabled = false,
  backend,
  refreshIntervalSec,
  autoSync = true,
  host = null,
  keys = [],
  identities,
  onUpdateHost,
  muxAttachTarget,
  onOpenMuxAttachTab,
}: ZellijManagerTabProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const {
    users,
    currentUser,
    selectedUser,
    setSelectedUser,
    needsSudo,
    runScoped,
    passwordDialog,
  } = useMultiplexerScope({
    sessionId,
    host,
    keys,
    identities,
    onUpdateHost,
    fallbackUser: host?.username,
    isVisible,
    backend,
  });

  const fetcher = useCallback(async () => {
    const result = await runScoped((scope) => backend.listZellijSessions(sessionId, scope));
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.loadZellij'));
    }
    return result.sessions ?? [];
  }, [backend, runScoped, sessionId, stableT]);

  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const { data: sessions, error, loading, refresh } = usePolling<ZellijSessionInfo[]>(
    fetcher,
    intervalMs,
    isVisible || warmupEnabled,
    (prev, next) => mergePollListByKey(prev, next, (s) => s.name, zellijSessionInfoEqual),
    { poll: isVisible && autoSync, resetKey: `${sessionId}:${selectedUser}` },
  );

  // Stale-while-revalidate per user: switching back to a previously viewed
  // user shows its last list instantly while the poll refreshes.
  const sessionsCacheRef = useRef(new Map<string, ZellijSessionInfo[]>());
  useEffect(() => {
    if (sessions) sessionsCacheRef.current.set(selectedUser, sessions);
  }, [selectedUser, sessions]);
  const displayBase = sessions ?? sessionsCacheRef.current.get(selectedUser) ?? null;

  const filtered = useMemo<ZellijSessionInfo[]>(() => {
    const q = query.trim().toLowerCase();
    const list = displayBase ?? [];
    if (!q) return list;
    return list.filter((session) => session.name.toLowerCase().includes(q));
  }, [query, displayBase]);

  const compareSessions = useCallback(
    (a: ZellijSessionInfo, b: ZellijSessionInfo) => a.name.localeCompare(b.name),
    [],
  );
  const displaySessions = useStableListOrder<ZellijSessionInfo, string>(
    filtered,
    (s) => s.name,
    query,
    compareSessions,
  );

  const attachTargetUser = needsSudo ? selectedUser : undefined;

  const handleCreate = useCallback(async (name: string) => {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await openInteractiveTerminal(
        backend,
        parentSession,
        `zellij: ${name}`,
        buildZellijAttachCommand(name, { create: true, targetUser: attachTargetUser }),
        {
          target: muxAttachTarget === 'tab' ? 'tab' : 'popup',
          onOpenTab: onOpenMuxAttachTab
            ? (payload) => onOpenMuxAttachTab(sessionId, payload)
            : undefined,
        },
      );
      if (!result.success) throw new Error(result.error || t('systemManager.errors.actionFailed'));
      setNewSessionOpen(false);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('systemManager.errors.actionFailed');
      setCreateError(message);
      showSystemManagerError(message, t('common.error'));
    } finally {
      setCreating(false);
    }
  }, [attachTargetUser, backend, muxAttachTarget, onOpenMuxAttachTab, parentSession, refresh, sessionId, t]);

  return (
    <SystemPanelShell section="system-manager-zellij">
      <SystemPanelToolbar
        trailing={(
          <>
            <SystemPanelIconButton
              title={t('systemManager.zellij.new')}
              onClick={() => {
                setCreateError(null);
                setNewSessionOpen(true);
              }}
            >
              <Plus size={14} />
            </SystemPanelIconButton>
            <SystemPanelRefreshButton
              title={t('history.action.refresh')}
              loading={loading}
              onClick={() => void refresh()}
            />
          </>
        )}
      >
        <MultiplexerUserSelect
          users={users}
          currentUser={currentUser}
          value={selectedUser}
          onChange={(user) => setSelectedUser(user === currentUser ? '' : user)}
        />
        <SystemPanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t('systemManager.zellij.search')}
        />
      </SystemPanelToolbar>

      <SystemPanelMetaBar>
        {t('systemManager.zellij.meta', { count: displaySessions.length })}
      </SystemPanelMetaBar>

      <SystemPanelList>
        {!error && displaySessions.length === 0 && loading && (
          <SystemPanelLoading message={t('systemManager.common.loading')} />
        )}
        {!error && displaySessions.length === 0 && !loading && (
          <SystemPanelEmpty icon={LayoutGrid} message={t('systemManager.zellij.empty')} />
        )}
        {error && (
          <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
        )}
        {displaySessions.map((session) => (
          <ZellijSessionCard
            key={session.name}
            session={session}
            sessionId={sessionId}
            parentSession={parentSession}
            backend={backend}
            runScoped={runScoped}
            attachTargetUser={attachTargetUser}
            muxAttachTarget={muxAttachTarget}
            onOpenMuxAttachTab={onOpenMuxAttachTab}
            onSessionsChanged={refresh}
          />
        ))}
      </SystemPanelList>

      <SystemPanelPromptDialog
        open={newSessionOpen}
        title={t('systemManager.zellij.newSessionTitle')}
        fields={[{
          id: 'name',
          label: t('systemManager.zellij.newSessionName'),
          placeholder: t('systemManager.zellij.newSessionPlaceholder'),
        }]}
        confirmLabel={t('common.create')}
        busy={creating}
        error={createError}
        onOpenChange={setNewSessionOpen}
        onSubmit={(values) => void handleCreate(values.name)}
      />
      {passwordDialog}
    </SystemPanelShell>
  );
});
