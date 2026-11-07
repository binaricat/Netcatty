import { Plus, TerminalSquare } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { Host, Identity, Snippet, SSHKey, TerminalSession } from '../../types';
import type { TmuxClientInfo, TmuxSessionInfo, TmuxSnapshot, TmuxWindowInfo } from '../../domain/systemManager/types';
import { tmuxSessionInfoEqual } from '../../domain/systemManager/pollEquals';
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
import type { AsyncRecordState } from '../../application/state/systemManager/useAsyncRecordCache';
import { usePolling, useStableTranslate } from '../../application/state/useSystemManager';
import { TmuxNewSessionModal } from './TmuxNewSessionModal';
import { TmuxSessionCard } from './TmuxSessionCard';
import { useStableListOrder, mergePollListByKey } from './listStable';
import { useMultiplexerScope } from './useMultiplexerScope';
import { MultiplexerUserSelect } from './MultiplexerUserSelect';

type Backend = ReturnType<typeof useSystemManagerBackend>;

export interface TmuxSessionDetails {
  windows: TmuxWindowInfo[];
  clients: TmuxClientInfo[];
}

interface TmuxManagerTabProps {
  sessionId: string;
  parentSession: TerminalSession;
  isVisible: boolean;
  warmupEnabled?: boolean;
  backend: Backend;
  refreshIntervalSec: number;
  autoSync?: boolean;
  snippets: Snippet[];
  host?: Host | null;
  keys?: SSHKey[];
  identities?: Identity[];
  onUpdateHost?: (host: Host) => void;
  onRequestTerminalFocus?: () => void;
  /** Where attach opens: new main-window tab or a popup window (default popup). */
  muxAttachTarget?: 'tab' | 'window';
  onOpenMuxAttachTab?: (sessionId: string, payload: { title: string; startupCommand: string }) => void;
}

export const TmuxManagerTab = memo(function TmuxManagerTab({
  sessionId,
  parentSession,
  isVisible,
  warmupEnabled = false,
  backend,
  refreshIntervalSec,
  autoSync = true,
  snippets,
  host = null,
  keys = [],
  identities,
  onUpdateHost,
  onRequestTerminalFocus,
  muxAttachTarget,
  onOpenMuxAttachTab,
}: TmuxManagerTabProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const [tmuxVersion, setTmuxVersion] = useState<string | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

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

  useEffect(() => {
    setTmuxVersion(null);
  }, [sessionId]);

  const fetcher = useCallback(async () => {
    const fetchSessionId = sessionId;
    // One round trip per poll: sessions + all windows + clients together, so a
    // sudo-scoped poll pays PAM auth once instead of once per session record.
    const result = await runScoped((scope) => backend.listTmuxSnapshot(sessionId, scope));
    const version = result.tmuxVersion ?? null;
    if (currentSessionIdRef.current === fetchSessionId) {
      setTmuxVersion((prev) => (prev === version ? prev : version));
    }
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.loadTmux'));
    }
    return {
      sessions: result.sessions ?? [],
      windowsBySession: result.windowsBySession ?? {},
      clients: result.clients ?? [],
      tmuxVersion: result.tmuxVersion,
    } satisfies TmuxSnapshot;
  }, [backend, runScoped, sessionId, stableT]);

  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const { data: snapshotData, error, loading, refresh } = usePolling<TmuxSnapshot>(
    fetcher,
    intervalMs,
    isVisible || warmupEnabled,
    (prev, next) => ({
      ...next,
      sessions: mergePollListByKey(prev?.sessions ?? null, next.sessions, (s) => s.name, tmuxSessionInfoEqual),
    }),
    { poll: isVisible && autoSync, resetKey: `${sessionId}:${selectedUser}` },
  );

  // Stale-while-revalidate per user: switching back to a previously viewed
  // user shows its last snapshot instantly while the poll refreshes.
  const snapshotCacheRef = useRef(new Map<string, TmuxSnapshot>());
  useEffect(() => {
    if (snapshotData) snapshotCacheRef.current.set(selectedUser, snapshotData);
  }, [selectedUser, snapshotData]);
  const snapshot = snapshotData ?? snapshotCacheRef.current.get(selectedUser) ?? null;
  const sessions = snapshot?.sessions ?? null;

  const filtered = useMemo<TmuxSessionInfo[]>(() => {
    const q = query.trim().toLowerCase();
    const list = sessions ?? [];
    if (!q) return list;
    return list.filter((session) => session.name.toLowerCase().includes(q));
  }, [query, sessions]);

  const compareSessions = useCallback(
    (a: TmuxSessionInfo, b: TmuxSessionInfo) => a.name.localeCompare(b.name),
    [],
  );
  const displaySessions = useStableListOrder<TmuxSessionInfo, string>(
    filtered,
    (s) => s.name,
    query,
    compareSessions,
  );

  const detailsByName = useMemo(() => {
    if (!snapshot) return null;
    const map: Record<string, AsyncRecordState<TmuxSessionDetails>> = {};
    for (const session of snapshot.sessions) {
      map[session.name] = {
        data: {
          windows: snapshot.windowsBySession[session.name] ?? [],
          clients: snapshot.clients.filter((client) => client.session === session.name),
        },
        loading: false,
        error: null,
        updatedAt: null,
      };
    }
    return map;
  }, [snapshot]);

  // Details ride along with every snapshot poll, so expand needs no fetch and
  // a post-action refresh simply repolls the snapshot.
  const loadDetailsNoop = useCallback(async () => {}, []);
  const handleRefreshDetails = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const handleCreate = useCallback(async (name: string, command: string) => {
    setCreating(true);
    setModalError(null);
    try {
      const result = await runScoped((scope) => backend.createTmuxSession({
        sessionId,
        name,
        command: command || undefined,
        scope,
      }));
      if (!result.success) throw new Error(result.error);
      setModalOpen(false);
      await refresh();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t('systemManager.errors.actionFailed'));
    } finally {
      setCreating(false);
    }
  }, [backend, refresh, runScoped, sessionId, t]);

  return (
    <SystemPanelShell section="system-manager-tmux">
      <SystemPanelToolbar
        trailing={(
          <>
            <SystemPanelIconButton
              title={t('systemManager.tmux.new')}
              onClick={() => {
                setModalError(null);
                setModalOpen(true);
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
          placeholder={t('systemManager.tmux.search')}
        />
      </SystemPanelToolbar>

      <SystemPanelMetaBar trailing={tmuxVersion ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{tmuxVersion}</span>
      ) : undefined}>
        {t('systemManager.tmux.meta', { count: displaySessions.length })}
      </SystemPanelMetaBar>

      <SystemPanelList>
        {!error && displaySessions.length === 0 && loading && (
          <SystemPanelLoading message={t('systemManager.common.loading')} />
        )}
        {!error && displaySessions.length === 0 && !loading && (
          <SystemPanelEmpty icon={TerminalSquare} message={t('systemManager.tmux.empty')} />
        )}
        {error && (
          <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
        )}
        {displaySessions.map((session) => (
          <TmuxSessionCard
            key={`${session.name}:${session.created}`}
            session={session}
            sessionId={sessionId}
            parentSession={parentSession}
            backend={backend}
            runScoped={runScoped}
            attachTargetUser={needsSudo ? selectedUser : undefined}
            muxAttachTarget={muxAttachTarget}
            onOpenMuxAttachTab={onOpenMuxAttachTab}
            detailsRecord={detailsByName?.[session.name]}
            onLoadDetails={loadDetailsNoop}
            onRefreshDetails={handleRefreshDetails}
            onSessionsChanged={refresh}
            onRequestTerminalFocus={onRequestTerminalFocus}
          />
        ))}
      </SystemPanelList>

      <TmuxNewSessionModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreate={handleCreate}
        snippets={snippets}
        creating={creating}
        error={modalError}
      />
      {passwordDialog}
    </SystemPanelShell>
  );
});
