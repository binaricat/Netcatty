import { Plus, TerminalSquare } from 'lucide-react';
import React, { memo, useCallback, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { Snippet, TerminalSession } from '../../types';
import type { TmuxSessionInfo } from '../../domain/systemManager/types';
import { tmuxSessionInfoEqual } from '../../domain/systemManager/pollEquals';
import {
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelIconButton,
  SystemPanelList,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelSearch,
  SystemPanelShell,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';
import { TmuxNewSessionModal } from './TmuxNewSessionModal';
import { TmuxSessionCard } from './TmuxSessionCard';
import { useStableListOrder, mergePollListByKey } from './listStable';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface TmuxManagerTabProps {
  sessionId: string;
  parentSession: TerminalSession;
  isVisible: boolean;
  backend: Backend;
  refreshIntervalSec: number;
  snippets: Snippet[];
}

export const TmuxManagerTab = memo(function TmuxManagerTab({
  sessionId,
  parentSession,
  isVisible,
  backend,
  refreshIntervalSec,
  snippets,
}: TmuxManagerTabProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const [tmuxVersion, setTmuxVersion] = useState<string | null>(null);

  const fetcher = useCallback(async () => {
    const result = await backend.listTmuxSessions(sessionId);
    const version = result.tmuxVersion ?? null;
    setTmuxVersion((prev) => (prev === version ? prev : version));
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.loadTmux'));
    }
    return result.sessions ?? [];
  }, [backend, sessionId, stableT]);

  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const { data: sessions, error, loading, refresh } = usePolling<TmuxSessionInfo[]>(
    fetcher,
    intervalMs,
    isVisible,
    (prev, next) => mergePollListByKey(prev, next, (s) => s.name, tmuxSessionInfoEqual),
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sessions ?? [];
    if (!q) return list;
    return list.filter((session) => session.name.toLowerCase().includes(q));
  }, [query, sessions]);

  const compareSessions = useCallback(
    (a: TmuxSessionInfo, b: TmuxSessionInfo) => a.name.localeCompare(b.name),
    [],
  );
  const displaySessions = useStableListOrder(
    filtered,
    (s) => s.name,
    query,
    compareSessions,
  );

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
        {!error && displaySessions.length === 0 && !loading && (
          <SystemPanelEmpty icon={TerminalSquare} message={t('systemManager.tmux.empty')} />
        )}
        {error && (
          <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
        )}
        {displaySessions.map((session) => (
          <TmuxSessionCard
            key={session.name}
            session={session}
            sessionId={sessionId}
            parentSession={parentSession}
            backend={backend}
            onSessionsChanged={refresh}
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
