import { Box, Layers } from 'lucide-react';
import React, { memo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { TerminalSession } from '../../types';
import { cn } from '../../lib/utils';
import { DockerContainersPanel } from './DockerContainersPanel';
import { DockerImagesPanel } from './DockerImagesPanel';
import { SystemPanelShell } from './SystemPanelUi';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type DockerSubTab = 'containers' | 'images';

interface DockerManagerTabProps {
  sessionId: string;
  parentSession: TerminalSession;
  isVisible: boolean;
  warmupEnabled?: boolean;
  backend: Backend;
  listRefreshIntervalSec: number;
  statsRefreshIntervalSec: number;
}

export const DockerManagerTab = memo(function DockerManagerTab({
  sessionId,
  parentSession,
  isVisible,
  warmupEnabled = false,
  backend,
  listRefreshIntervalSec,
  statsRefreshIntervalSec,
}: DockerManagerTabProps) {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<DockerSubTab>('containers');

  const tabs: { id: DockerSubTab; icon: typeof Box; label: string }[] = [
    { id: 'containers', icon: Box, label: t('systemManager.docker.subTabs.containers') },
    { id: 'images', icon: Layers, label: t('systemManager.docker.subTabs.images') },
  ];

  return (
    <SystemPanelShell section="system-manager-docker">
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border/30">
        {tabs.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors',
              subTab === id
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setSubTab(id)}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className={cn('flex-1 min-h-0 flex flex-col', subTab !== 'containers' && 'hidden')}>
          <DockerContainersPanel
            sessionId={sessionId}
            parentSession={parentSession}
            isVisible={isVisible && subTab === 'containers'}
            warmupEnabled={warmupEnabled || (isVisible && subTab !== 'containers')}
            backend={backend}
            listRefreshIntervalSec={listRefreshIntervalSec}
            statsRefreshIntervalSec={statsRefreshIntervalSec}
          />
        </div>
        <div className={cn('flex-1 min-h-0 flex flex-col', subTab !== 'images' && 'hidden')}>
          <DockerImagesPanel
            sessionId={sessionId}
            isVisible={isVisible && subTab === 'images'}
            warmupEnabled={warmupEnabled || (isVisible && subTab !== 'images')}
            backend={backend}
            listRefreshIntervalSec={listRefreshIntervalSec}
          />
        </div>
      </div>
    </SystemPanelShell>
  );
});
