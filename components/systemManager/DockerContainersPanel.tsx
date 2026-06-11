import { Box, FileText, Play, RotateCcw, Square, Terminal } from 'lucide-react';
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { writeSystemManagerDiagnostic } from '../../application/state/systemManagerDiagnostics';
import type { TerminalSession } from '../../types';
import type { DockerContainerAction, DockerContainerInfo, TerminalPopupIcon } from '../../domain/systemManager/types';
import { dockerContainerInfoEqual } from '../../domain/systemManager/pollEquals';
import { getContainerFlags, getContainerTone } from '../../domain/systemManager/containerState';
import { buildDockerExecShellCommand, buildDockerLogsCommand } from '../../domain/systemManager/dockerShell';
import { DockerContainerDetail } from './DockerContainerDetail';
import { DockerImageIcon } from './DockerImageIcon';
import { useStableListOrder, mergePollListByKey } from './listStable';
import {
  SystemPanelCollapsible,
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelList,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSearch,
  SystemPanelSegmented,
  SystemPanelStatusBadge,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';
import { openInteractiveTerminal } from './openInteractiveTerminal';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type ContainerFilter = 'all' | 'running' | 'stopped' | 'paused';

async function buildContainerPopupIcon(image: string): Promise<TerminalPopupIcon> {
  const {
    dockerIconTileStyle,
    resolveDockerIconPresentation,
    resolveDockerImageIcon,
  } = await import('../../domain/systemManager/dockerImageIcons');
  const iconId = resolveDockerImageIcon(image);
  const presentation = resolveDockerIconPresentation(iconId);
  const tile = dockerIconTileStyle(presentation.displayIconId);
  return {
    kind: 'image',
    src: presentation.iconUrl,
    backgroundColor: tile.background,
    alt: '',
  };
}

interface DockerContainersPanelProps {
  sessionId: string;
  parentSession: TerminalSession;
  isVisible: boolean;
  backend: Backend;
  listRefreshIntervalSec: number;
  statsRefreshIntervalSec: number;
}

const DockerContainerRow = memo(function DockerContainerRow({
  container,
  selected,
  pendingAction,
  onSelectContainer,
  onShellContainer,
  onLogsContainer,
  onContainerAction,
}: {
  container: DockerContainerInfo;
  selected: boolean;
  pendingAction: DockerContainerAction | null;
  onSelectContainer: (container: DockerContainerInfo) => void;
  onShellContainer: (container: DockerContainerInfo) => void;
  onLogsContainer: (container: DockerContainerInfo) => void;
  onContainerAction: (container: DockerContainerInfo, action: DockerContainerAction) => void;
}) {
  const { t } = useI18n();
  const shortId = container.id.slice(0, 12);
  const { isRunning, isPaused } = getContainerFlags(container);
  const actionBusy = pendingAction !== null;

  return (
    <SystemPanelRow
      selected={selected}
      onClick={() => onSelectContainer(container)}
      leading={<DockerImageIcon image={container.image} />}
      title={container.name || shortId}
      subtitle={container.image}
      trailing={(
        <div className="flex shrink-0 items-center gap-1">
          <SystemPanelStatusBadge tone={getContainerTone(container)}>
            {isRunning ? t('systemManager.docker.filter.running') : isPaused ? t('systemManager.docker.filter.paused') : t('systemManager.docker.filter.stopped')}
          </SystemPanelStatusBadge>
          {isRunning && (
            <SystemPanelRoundButton title={t('systemManager.docker.shell')} onClick={() => onShellContainer(container)}>
              <Terminal size={12} />
            </SystemPanelRoundButton>
          )}
          <SystemPanelRoundButton title={t('systemManager.docker.logs')} onClick={() => onLogsContainer(container)}>
            <FileText size={12} />
          </SystemPanelRoundButton>
          {isRunning && (
            <>
              <SystemPanelRoundButton
                title={t('systemManager.docker.restart')}
                disabled={actionBusy}
                loading={pendingAction === 'restart'}
                onClick={() => onContainerAction(container, 'restart')}
              >
                <RotateCcw size={12} />
              </SystemPanelRoundButton>
              <SystemPanelRoundButton
                title={t('systemManager.docker.stop')}
                disabled={actionBusy}
                loading={pendingAction === 'stop'}
                onClick={() => onContainerAction(container, 'stop')}
              >
                <Square size={12} />
              </SystemPanelRoundButton>
            </>
          )}
          {isPaused && (
            <SystemPanelRoundButton
              title={t('systemManager.docker.unpause')}
              disabled={actionBusy}
              loading={pendingAction === 'unpause'}
              onClick={() => onContainerAction(container, 'unpause')}
            >
              <Play size={12} />
            </SystemPanelRoundButton>
          )}
          {!isRunning && !isPaused && (
            <SystemPanelRoundButton
              title={t('systemManager.docker.start')}
              disabled={actionBusy}
              loading={pendingAction === 'start'}
              onClick={() => onContainerAction(container, 'start')}
            >
              <Play size={12} />
            </SystemPanelRoundButton>
          )}
        </div>
      )}
    />
  );
});

export const DockerContainersPanel = memo(function DockerContainersPanel({
  sessionId,
  parentSession,
  isVisible,
  backend,
  listRefreshIntervalSec,
  statsRefreshIntervalSec,
}: DockerContainersPanelProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ContainerFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Record<string, unknown> | null>(null);
  // Invalidates in-flight inspect fetches when the selection changes —
  // a slow response for container A must not render under container B.
  const inspectSeqRef = useRef(0);
  // Spinner feedback while a container action (stop/restart/…) runs;
  // cleared only after the follow-up list refresh lands.
  const [pendingAction, setPendingAction] = useState<{ id: string; action: DockerContainerAction } | null>(null);

  const containersFetcher = useCallback(async () => {
    const result = await backend.listDockerContainers(sessionId);
    if (!result.success || !result.containers) {
      throw new Error(result.error || stableT('systemManager.errors.loadDocker'));
    }
    return result.containers;
  }, [backend, sessionId, stableT]);

  const listIntervalMs = Math.max(3, listRefreshIntervalSec) * 1000;
  const { data: containers, error, loading, refresh } = usePolling<DockerContainerInfo[]>(
    containersFetcher,
    listIntervalMs,
    isVisible,
    (prev, next) => mergePollListByKey(prev, next, (c) => c.id, dockerContainerInfoEqual),
  );

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (containers ?? []).filter((container) => {
      const { isRunning, isPaused } = getContainerFlags(container);
      if (filter === 'running' && !isRunning) return false;
      if (filter === 'stopped' && (isRunning || isPaused)) return false;
      if (filter === 'paused' && !isPaused) return false;
      if (!q) return true;
      const shortId = container.id.slice(0, 12);
      return container.name.toLowerCase().includes(q)
        || container.image.toLowerCase().includes(q)
        || shortId.toLowerCase().includes(q);
    });
  }, [containers, filter, query]);

  const compareContainers = useCallback(
    (a: DockerContainerInfo, b: DockerContainerInfo) => a.name.localeCompare(b.name),
    [],
  );
  const displayList = useStableListOrder(
    matched,
    (c) => c.id,
    `${filter}|${query}`,
    compareContainers,
  );

  const selectedContainer = useMemo(
    () => displayList.find((c) => c.id === selectedId) ?? null,
    [displayList, selectedId],
  );

  const runAction = useCallback(async (
    containerId: string,
    action: DockerContainerAction,
    newName?: string,
  ) => {
    if (action === 'rm') {
      const ok = globalThis.confirm(t('systemManager.docker.confirmRemove'));
      if (!ok) return;
    }
    if (action === 'kill') {
      const ok = globalThis.confirm(t('systemManager.docker.confirmKill'));
      if (!ok) return;
    }
    setPendingAction({ id: containerId, action });
    try {
      const result = await backend.dockerAction({ sessionId, containerId, action, newName });
      if (!result.success) {
        showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
        return;
      }
      if (action === 'rm') {
        setSelectedId(null);
        setInspect(null);
        inspectSeqRef.current += 1;
      }
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }, [backend, refresh, sessionId, t]);

  const handleRowAction = useCallback((container: DockerContainerInfo, action: DockerContainerAction) => {
    void runAction(container.id.slice(0, 12), action);
  }, [runAction]);

  const selectContainer = useCallback(async (container: DockerContainerInfo) => {
    const next = selectedId === container.id ? null : container.id;
    setSelectedId(next);
    setInspect(null);
    const seq = ++inspectSeqRef.current;
    if (!next) return;
    const result = await backend.dockerInspect({
      sessionId,
      containerId: container.id.slice(0, 12),
    });
    if (inspectSeqRef.current !== seq) return;
    setInspect(result.success ? (result.inspect ?? null) : null);
  }, [backend, selectedId, sessionId]);

  const openShell = useCallback(async (container: DockerContainerInfo) => {
    const id = container.id.slice(0, 12);
    await writeSystemManagerDiagnostic('docker open shell clicked', {
      sessionId,
      containerId: id,
      containerName: container.name,
      image: container.image,
      state: container.state,
    });
    const result = await openInteractiveTerminal(
      backend,
      parentSession,
      `docker: ${container.name || id}`,
      buildDockerExecShellCommand(id),
      { icon: await buildContainerPopupIcon(container.image) },
    );
    if (!result.success) {
      await writeSystemManagerDiagnostic('docker open shell failed', {
        sessionId,
        containerId: id,
        containerName: container.name,
        error: result.error,
      });
      showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
    }
  }, [backend, parentSession, sessionId, t]);

  const openLogs = useCallback(async (container: DockerContainerInfo) => {
    const id = container.id.slice(0, 12);
    await writeSystemManagerDiagnostic('docker open logs clicked', {
      sessionId,
      containerId: id,
      containerName: container.name,
      image: container.image,
      state: container.state,
    });
    const result = await openInteractiveTerminal(
      backend,
      parentSession,
      `logs: ${container.name || id}`,
      buildDockerLogsCommand(id),
      { icon: await buildContainerPopupIcon(container.image) },
    );
    if (!result.success) {
      await writeSystemManagerDiagnostic('docker open logs failed', {
        sessionId,
        containerId: id,
        containerName: container.name,
        error: result.error,
      });
      showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
    }
  }, [backend, parentSession, sessionId, t]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-section="docker-containers">
      <SystemPanelToolbar
        trailing={(
          <SystemPanelRefreshButton
            title={t('history.action.refresh')}
            loading={loading}
            onClick={() => void refresh()}
          />
        )}
      >
        <SystemPanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t('systemManager.docker.search')}
        />
      </SystemPanelToolbar>

      <SystemPanelSegmented
        value={filter}
        options={[
          { id: 'all', label: t('systemManager.docker.filter.all') },
          { id: 'running', label: t('systemManager.docker.filter.running') },
          { id: 'stopped', label: t('systemManager.docker.filter.stopped') },
          { id: 'paused', label: t('systemManager.docker.filter.paused') },
        ]}
        onChange={setFilter}
      />

      <SystemPanelMetaBar>
        {t('systemManager.docker.meta', { count: String(displayList.length) })}
      </SystemPanelMetaBar>

      <SystemPanelList>
        {error && (
          <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
        )}
        {!error && displayList.length === 0 && !loading && (
          <SystemPanelEmpty icon={Box} message={t('systemManager.docker.empty')} />
        )}

        {displayList.map((container) => {
          const selected = selectedId === container.id;
          const rowPending = pendingAction && pendingAction.id === container.id.slice(0, 12)
            ? pendingAction.action
            : null;
          return (
            <React.Fragment key={container.id}>
              <DockerContainerRow
                container={container}
                selected={selected}
                pendingAction={rowPending}
                onSelectContainer={selectContainer}
                onShellContainer={openShell}
                onLogsContainer={openLogs}
                onContainerAction={handleRowAction}
              />
              <SystemPanelCollapsible open={selected && !!selectedContainer}>
                {selectedContainer && (
                  <DockerContainerDetail
                    container={selectedContainer}
                    sessionId={sessionId}
                    backend={backend}
                    statsRefreshIntervalSec={statsRefreshIntervalSec}
                    inspect={inspect}
                    pendingAction={rowPending}
                    onCloseInspect={() => { setSelectedId(null); setInspect(null); }}
                    onRunAction={runAction}
                  />
                )}
              </SystemPanelCollapsible>
            </React.Fragment>
          );
        })}
      </SystemPanelList>
    </div>
  );
});
