import { Activity, Box, LayoutList, Loader2, TerminalSquare } from 'lucide-react';
import React, { memo, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { TerminalSettings } from '../../domain/models';
import type { Host } from '../../domain/models/connection';
import type { SystemManagerSubTab } from '../../domain/systemManager/types';
import { buildSystemManagerTabs } from '../../domain/systemManager/systemTarget';
import type { Snippet, TerminalSession } from '../../types';
import { cn } from '../../lib/utils';
import { DockerManagerTab } from './DockerManagerTab';
import { ProcessManagerTab } from './ProcessManagerTab';
import { TmuxManagerTab } from './TmuxManagerTab';
import { WorkspaceSidebarHostHeader } from '../terminalLayer/WorkspaceSidebarHostHeader';
import { SystemPanelEmpty, SystemPanelShell } from './SystemPanelUi';
import { useSessionCapabilities } from './hooks/useSystemManager';

const SystemPanelChecking = memo(function SystemPanelChecking({
  message,
}: {
  message: string;
}) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-4 py-10 text-center text-xs text-muted-foreground">
      <Loader2 size={18} className="mb-2 animate-spin opacity-70" />
      <span>{message}</span>
    </div>
  );
});

interface SystemManagerSidePanelProps {
  session: TerminalSession | null;
  sessionHost: Host | null;
  showWorkspaceHostHeader?: boolean;
  isVisible: boolean;
  terminalSettings: TerminalSettings;
  snippets: Snippet[];
}

export const SystemManagerSidePanel = memo(function SystemManagerSidePanel({
  session,
  sessionHost,
  showWorkspaceHostHeader = false,
  isVisible,
  terminalSettings,
  snippets,
}: SystemManagerSidePanelProps) {
  const { t } = useI18n();
  const backend = useSystemManagerBackend();
  const sessionId = session?.id ?? null;
  const isConnected = session?.status === 'connected';

  const capabilitiesTtlMs = terminalSettings.systemManagerProcessRefreshInterval * 1000;

  const { capabilities, probing, refreshCapabilities } = useSessionCapabilities(sessionId, isConnected, backend, isVisible, capabilitiesTtlMs);

  const availableTabs = useMemo(
    () => buildSystemManagerTabs(sessionHost, capabilities, session),
    [capabilities, session, sessionHost],
  );

  const [activeTab, setActiveTab] = useState<SystemManagerSubTab>('processes');
  const resolvedTab = availableTabs.includes(activeTab) ? activeTab : 'processes';

  // Must be defined before early returns to comply with React rules of hooks.
  const prevTabRef = React.useRef(resolvedTab);
  React.useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = resolvedTab;
    if (prev === resolvedTab) return;
    if (resolvedTab === 'docker' && capabilities?.hasDocker !== true) {
      void refreshCapabilities();
    } else if (resolvedTab === 'tmux' && capabilities?.hasTmux !== true) {
      void refreshCapabilities();
    }
  }, [resolvedTab, capabilities, refreshCapabilities]);

  const workspaceHostHeader = showWorkspaceHostHeader && sessionHost ? (
    <WorkspaceSidebarHostHeader
      host={sessionHost}
      section="terminal-system-host-header"
    />
  ) : null;

  if (!sessionId || !session) {
    return (
      <SystemPanelShell section="system-manager-panel">
        {workspaceHostHeader}
        <SystemPanelEmpty icon={Activity} message={t('systemManager.noSession')} />
      </SystemPanelShell>
    );
  }

  if (!isConnected) {
    return (
      <SystemPanelShell section="system-manager-panel">
        {workspaceHostHeader}
        <SystemPanelEmpty icon={Activity} message={t('systemManager.notConnected')} />
      </SystemPanelShell>
    );
  }

  const tabDefs: { id: SystemManagerSubTab; icon: typeof LayoutList; label: string }[] = [
    { id: 'processes', icon: LayoutList, label: t('systemManager.tabs.processes') },
    { id: 'tmux', icon: TerminalSquare, label: t('systemManager.tabs.tmux') },
    { id: 'docker', icon: Box, label: t('systemManager.tabs.docker') },
  ];

  const tmuxReady = capabilities?.hasTmux === true;
  const dockerReady = capabilities?.hasDocker === true;
  const tmuxUnavailable = !probing && capabilities !== undefined && !tmuxReady;
  const dockerUnavailable = !probing && capabilities !== undefined && !dockerReady;
  const tmuxChecking = resolvedTab === 'tmux' && !tmuxReady && !tmuxUnavailable;
  const dockerChecking = resolvedTab === 'docker' && !dockerReady && !dockerUnavailable;

  return (
    <SystemPanelShell section="system-manager-panel">
      {workspaceHostHeader}
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border/50">
        {tabDefs.filter((tab) => availableTabs.includes(tab.id)).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors',
              resolvedTab === id
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'processes' && 'hidden')}>
          <ProcessManagerTab
            sessionId={sessionId}
            isVisible={isVisible && resolvedTab === 'processes'}
            backend={backend}
            refreshIntervalSec={terminalSettings.systemManagerProcessRefreshInterval}
          />
        </div>
        {tmuxUnavailable && resolvedTab === 'tmux' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelEmpty icon={TerminalSquare} message={t('systemManager.tmux.unavailable')} />
          </div>
        ) : tmuxChecking ? (
          <div className="flex-1 min-h-0">
            <SystemPanelChecking message={t('systemManager.common.checkingAvailability')} />
          </div>
        ) : tmuxReady ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'tmux' && 'hidden')}>
            <TmuxManagerTab
              sessionId={sessionId}
              parentSession={session}
              isVisible={isVisible && resolvedTab === 'tmux'}
              warmupEnabled={isVisible && resolvedTab !== 'tmux'}
              backend={backend}
              refreshIntervalSec={terminalSettings.systemManagerTmuxRefreshInterval}
              snippets={snippets}
            />
          </div>
        ) : null}
        {dockerUnavailable && resolvedTab === 'docker' ? (
          <div className="flex-1 min-h-0">
            <SystemPanelEmpty icon={Box} message={t('systemManager.docker.unavailable')} />
          </div>
        ) : dockerChecking ? (
          <div className="flex-1 min-h-0">
            <SystemPanelChecking message={t('systemManager.common.checkingAvailability')} />
          </div>
        ) : dockerReady ? (
          <div className={cn('flex-1 min-h-0 flex flex-col', resolvedTab !== 'docker' && 'hidden')}>
            <DockerManagerTab
              sessionId={sessionId}
              parentSession={session}
              isVisible={isVisible && resolvedTab === 'docker'}
              warmupEnabled={isVisible && resolvedTab !== 'docker'}
              backend={backend}
              listRefreshIntervalSec={terminalSettings.systemManagerDockerListRefreshInterval}
              statsRefreshIntervalSec={terminalSettings.systemManagerDockerStatsRefreshInterval}
            />
          </div>
        ) : null}
      </div>
    </SystemPanelShell>
  );
});
