import { Loader2, Pause, Pencil, Play, Trash2, Zap } from 'lucide-react';
import React, { memo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { DockerContainerAction, DockerContainerInfo, DockerStatInfo } from '../../domain/systemManager/types';
import { getContainerFlags } from '../../domain/systemManager/containerState';
import { DockerInspectView } from './DockerInspectView';
import { ResourceBar } from './ResourceBar';
import {
  SystemPanelActionChip,
  SystemPanelDetailStrip,
  SystemPanelInlineError,
} from './SystemPanelUi';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';

interface DockerContainerDetailProps {
  container: DockerContainerInfo;
  inspect: Record<string, unknown> | null;
  inspectError?: string | null;
  inspectLoading?: boolean;
  stat?: DockerStatInfo | null;
  statsLoading?: boolean;
  pendingAction: DockerContainerAction | null;
  onCloseInspect: () => void;
  onRunAction: (containerId: string, action: DockerContainerAction, newName?: string) => Promise<void>;
}

export const DockerContainerDetail = memo(function DockerContainerDetail({
  container,
  inspect,
  inspectError = null,
  inspectLoading = false,
  stat = null,
  statsLoading = false,
  pendingAction,
  onCloseInspect,
  onRunAction,
}: DockerContainerDetailProps) {
  const { t } = useI18n();
  const shortId = container.id.slice(0, 12);
  const { isRunning, isPaused } = getContainerFlags(container);

  const [renameOpen, setRenameOpen] = useState(false);
  const actionBusy = pendingAction !== null;

  return (
    <>
      <SystemPanelDetailStrip>
        {container.ports && (
          <div className="text-[10px] text-muted-foreground mb-2 break-all">{container.ports}</div>
        )}
        {stat && (
          <div className="space-y-1 mb-2">
            <ResourceBar label="CPU" value={stat.cpuPercent} />
            <ResourceBar label="MEM" value={stat.memPercent} />
            <div className="text-[10px] text-muted-foreground">{stat.netIO} · {stat.memUsage}</div>
          </div>
        )}
        {!stat && statsLoading && (isRunning || isPaused) && (
          <div className="mb-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Loader2 size={11} className="animate-spin" />
            {t('systemManager.common.loadingStats')}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-0.5">
          <SystemPanelActionChip title={t('systemManager.docker.renamePrompt')} disabled={actionBusy} onClick={() => setRenameOpen(true)}>
            <Pencil size={11} /> {t('common.rename')}
          </SystemPanelActionChip>
          {isRunning && (
            <SystemPanelActionChip title={t('systemManager.docker.pause')} disabled={actionBusy} onClick={() => void onRunAction(shortId, 'pause')}>
              <Pause size={11} /> {t('systemManager.docker.pause')}
            </SystemPanelActionChip>
          )}
          {isPaused && (
            <SystemPanelActionChip title={t('systemManager.docker.unpause')} disabled={actionBusy} onClick={() => void onRunAction(shortId, 'unpause')}>
              <Play size={11} /> {t('systemManager.docker.unpause')}
            </SystemPanelActionChip>
          )}
          {(isRunning || isPaused) && (
            <SystemPanelActionChip title={t('systemManager.docker.kill')} disabled={actionBusy} onClick={() => void onRunAction(shortId, 'kill')} destructive>
              <Zap size={11} /> {t('systemManager.docker.kill')}
            </SystemPanelActionChip>
          )}
          <SystemPanelActionChip title={t('systemManager.docker.confirmRemove')} disabled={actionBusy} onClick={() => void onRunAction(shortId, 'rm')} destructive>
            <Trash2 size={11} />
          </SystemPanelActionChip>
        </div>
      </SystemPanelDetailStrip>
      {inspectLoading && !inspect && (
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          {t('systemManager.common.loadingDetails')}
        </div>
      )}
      {inspectError && !inspect && (
        <SystemPanelInlineError message={inspectError} />
      )}
      {inspect && (
        <DockerInspectView
          kind="container"
          data={inspect}
          onClose={onCloseInspect}
        />
      )}

      <SystemPanelPromptDialog
        open={renameOpen}
        title={t('common.rename')}
        fields={[{
          id: 'name',
          label: t('systemManager.docker.renamePrompt'),
          initialValue: container.name || shortId,
        }]}
        confirmLabel={t('common.rename')}
        onOpenChange={setRenameOpen}
        onSubmit={(values) => {
          setRenameOpen(false);
          if (values.name !== container.name) {
            void onRunAction(shortId, 'rename', values.name);
          }
        }}
      />
    </>
  );
});
