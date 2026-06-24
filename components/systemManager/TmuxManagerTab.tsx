import { Plus, TerminalSquare } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { Snippet, TerminalSession } from '../../types';
import type { TmuxClientInfo, TmuxSessionInfo, TmuxWindowInfo } from '../../domain/systemManager/types';
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
import { useAsyncRecordCache } from './hooks/useAsyncRecordCache';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';
import { TmuxNewSessionModal } from './TmuxNewSessionModal';
import { TmuxSessionCard } from './TmuxSessionCard';
import { useStableListOrder, mergePollListByKey } from './listStable';

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
  snippets: Snippet[];
  onRequestTerminalFocus?: () => void;
}

export const TmuxManagerTab = memo(function TmuxManagerTab({
  sessionId,
  parentSession,
  isVisible,
  warmupEnabled = false,
  backend,
  refreshIntervalSec,
  snippets,
  onRequestTerminalFocus,
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

  useEffect(() => {
    setTmuxVersion(null);
  }, [sessionId]);

  const fetcher = useCallback(async () => {
    const fetchSessionId = sessionId;
    const result = await backend.listTmuxSessions(sessionId);
    const version = result.tmuxVersion ?? null;
    if (currentSessionIdRef.current === fetchSessionId) {
      setTmuxVersion((prev) => (prev === version ? prev : version));
    }
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.loadTmux'));
    }
    return result.sessions ?? [];
  }, [backend, sessionId, stableT]);

  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const { data: sessions, error, loading, refresh } = usePolling<TmuxSessionInfo[]>(
    fetcher,
    intervalMs,
    isVisible || warmupEnabled,
    (prev, next) => mergePollListByKey(prev, next, (s) => s.name, tmuxSessionInfoEqual),
    { poll: isVisible, resetKey: sessionId },
  );

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

  const formatTmuxLoadError = useCallback((
    message: string,
    debug?: { lastOutput?: string; tried?: string[] },
  ) => {
    const parts = [message];
    if (debug?.lastOutput) parts.push(debug.lastOutput);
    if (debug?.tried?.length) {
      parts.push(t('systemManager.tmux.lastCommand', { command: debug.tried[debug.tried.length - 1] ?? '' }));
    }
    return parts.filter(Boolean).join(' · ');
  }, [t]);

  const getTmuxDetailsKey = useCallback((session: TmuxSessionInfo) => (
    `${sessionId}:${session.name}:${session.created}`
  ), [sessionId]);
  const fetchTmuxDetails = useCallback(async (session: TmuxSessionInfo): Promise<TmuxSessionDetails> => {
    const [windowsResult, clientsResult] = await Promise.all([
      backend.listTmuxWindows({ sessionId, sessionName: session.name }),
      backend.listTmuxClients({ sessionId, sessionName: session.name }),
    ]);
    if (!windowsResult.success) {
      throw new Error(formatTmuxLoadError(
        windowsResult.error || stableT('systemManager.errors.loadTmuxWindows'),
        windowsResult.debug,
      ));
    }
    if (!clientsResult.success) {
      throw new Error(clientsResult.error || stableT('systemManager.errors.loadTmuxClients'));
    }
    const freshWindows = windowsResult.windows ?? [];
    if (freshWindows.length === 0 && session.windows > 0) {
      throw new Error(formatTmuxLoadError(
        stableT('systemManager.tmux.windowsMismatch', { count: String(session.windows) }),
        windowsResult.debug,
      ));
    }
    return {
      windows: freshWindows,
      clients: clientsResult.clients ?? [],
    };
  }, [backend, formatTmuxLoadError, sessionId, stableT]);

  const {
    records: tmuxDetailsByName,
    loadRecord: loadTmuxDetails,
    refreshRecord: refreshTmuxDetails,
  } = useAsyncRecordCache<TmuxSessionInfo, TmuxSessionDetails>({
    items: sessions ?? [],
    enabled: isVisible && (sessions?.length ?? 0) > 0,
    getKey: getTmuxDetailsKey,
    fetchRecord: fetchTmuxDetails,
    prefetchLimit: 16,
    prefetchDelayMs: 40,
    staleTimeMs: 20_000,
  });

  const handleCreate = useCallback(async (name: string, command: string) => {
    setCreating(true);
    setModalError(null);
    try {
      const result = await backend.createTmuxSession({
        sessionId,
        name,
        command: command || undefined,
      });
      if (!result.success) throw new Error(result.error);
      setModalOpen(false);
      await refresh();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t('systemManager.errors.actionFailed'));
    } finally {
      setCreating(false);
    }
  }, [backend, refresh, sessionId, t]);

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
            detailsRecord={tmuxDetailsByName[getTmuxDetailsKey(session)]}
            onLoadDetails={loadTmuxDetails}
            onRefreshDetails={refreshTmuxDetails}
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
    </SystemPanelShell>
  );
});
