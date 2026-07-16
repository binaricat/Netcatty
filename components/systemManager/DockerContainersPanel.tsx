import { Box, FileText, Play, RotateCcw, Square, Terminal } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { writeSystemManagerDiagnostic } from '../../application/state/systemManagerDiagnostics';
import type { TerminalSession } from '../../types';
import type { DockerContainerAction, DockerContainerInfo, DockerStatInfo, TerminalPopupIcon } from '../../domain/systemManager/types';
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
  SystemPanelLoading,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSearch,
  SystemPanelSegmented,
  SystemPanelStatusBadge,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import { useAsyncRecordCache } from './hooks/useAsyncRecordCache';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';
import { openInteractiveTerminal } from './openInteractiveTerminal';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type ContainerFilter = 'all' | 'running' | 'stopped' | 'paused';
type PendingContainerConfirm = {
  containerId: string;
  action: 'rm' | 'kill';
};

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
  warmupEnabled?: boolean;
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
  warmupEnabled = false,
  backend,
  listRefreshIntervalSec,
  statsRefreshIntervalSec,
}: DockerContainersPanelProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ContainerFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Spinner feedback while a container action (stop/restart/…) runs;
  // cleared only after the follow-up list refresh lands.
  const [pendingAction, setPendingAction] = useState<{ id: string; action: DockerContainerAction } | null>(null);
  const [confirmAction, setConfirmAction] = useState<PendingContainerConfirm | null>(null);

  useEffect(() => {
    // Drop pending confirms/selection when the active terminal session changes so
    // a confirm opened for host A cannot run against host B.
    setConfirmAction(null);
    setPendingAction(null);
    setSelectedId(null);
  }, [sessionId]);

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
    isVisible || warmupEnabled,
    (prev, next) => mergePollListByKey(prev, next, (c) => c.id, dockerContainerInfoEqual),
    { poll: isVisible, resetKey: sessionId },
  );

  const matched = useMemo<DockerContainerInfo[]>(() => {
    const q = query.trim().toLowerCase();
    const containerList = containers ?? [];
    return containerList.filter((container) => {
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
  const displayList = useStableListOrder<DockerContainerInfo, string>(
    matched,
    (c) => c.id,
    `${filter}|${query}`,
    compareContainers,
  );

  const selectedContainer = useMemo(
    () => displayList.find((c) => c.id === selectedId) ?? null,
    [displayList, selectedId],
  );

  const statContainerIds = useMemo(
    () => {
      if (!selectedContainer) return [];
      const { isRunning, isPaused } = getContainerFlags(selectedContainer);
      return isRunning || isPaused ? [selectedContainer.id] : [];
    },
    [selectedContainer],
  );
  const statsFetcher = useCallback(async () => {
    if (statContainerIds.length === 0) return [];
    const result = await backend.getDockerStats({ sessionId, ids: statContainerIds });
    if (!result.success || !result.stats) {
      throw new Error(result.error || stableT('systemManager.errors.loadDockerStats'));
    }
    return result.stats;
  }, [backend, sessionId, stableT, statContainerIds]);

  const statsIntervalMs = Math.max(2, statsRefreshIntervalSec) * 1000;
  const { data: stats, loading: statsLoading } = usePolling<DockerStatInfo[]>(
    statsFetcher,
    statsIntervalMs,
    isVisible && statContainerIds.length > 0,
    undefined,
    { poll: isVisible, resetKey: `${sessionId}:${statContainerIds.join(',')}` },
  );

  const statsByContainerId = useMemo(() => {
    const map = new Map<string, DockerStatInfo>();
    for (const stat of stats ?? []) {
      map.set(stat.id, stat);
      map.set(stat.id.slice(0, 12), stat);
    }
    return map;
  }, [stats]);

  const getContainerInspectKey = useCallback((container: DockerContainerInfo) => (
    `${sessionId}:${container.id}`
  ), [sessionId]);
  const fetchContainerInspect = useCallback(async (container: DockerContainerInfo) => {
    const result = await backend.dockerInspect({
      sessionId,
      containerId: container.id.slice(0, 12),
    });
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.actionFailed'));
    }
    return result.inspect ?? null;
  }, [backend, sessionId, stableT]);
  const {
    records: inspectByContainerId,
    loadRecord: loadContainerInspect,
    refreshRecord: refreshContainerInspect,
    invalidateMatching: invalidateContainerInspectMatching,
  } = useAsyncRecordCache<DockerContainerInfo, Record<string, unknown>>({
    items: containers ?? [],
    enabled: isVisible && (containers?.length ?? 0) > 0,
    getKey: getContainerInspectKey,
    fetchRecord: fetchContainerInspect,
    prefetchLimit: 24,
    prefetchDelayMs: 40,
    staleTimeMs: 20_000,
  });

  const runAction = useCallback(async (
    containerId: string,
    action: DockerContainerAction,
    newName?: string,
    options?: { skipConfirm?: boolean },
  ) => {
    if (!options?.skipConfirm && (action === 'rm' || action === 'kill')) {
      setConfirmAction({ containerId, action });
      return;
    }
    setPendingAction({ id: containerId, action });
    try {
      const result = await backend.dockerAction({ sessionId, containerId, action, newName });
      if (!result.success) {
        showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
        return;
      }
      const affectedContainer = (containers ?? []).find((container) => (
        container.id === containerId || container.id.startsWith(containerId)
      ));
      invalidateContainerInspectMatching((key) => (
        key === `${sessionId}:${containerId}` || key.startsWith(`${sessionId}:${containerId}`)
      ));
      if (action === 'rm') {
        setSelectedId(null);
      }
      await refresh();
      if (affectedContainer && action !== 'rm') {
        void refreshContainerInspect(affectedContainer);
      }
    } finally {
      setPendingAction(null);
    }
  }, [
    backend,
    containers,
    invalidateContainerInspectMatching,
    refresh,
    refreshContainerInspect,
    sessionId,
    t,
  ]);

  const handleRowAction = useCallback((container: DockerContainerInfo, action: DockerContainerAction) => {
    void runAction(container.id.slice(0, 12), action);
  }, [runAction]);

  const selectContainer = useCallback((container: DockerContainerInfo) => {
    const next = selectedId === container.id ? null : container.id;
    setSelectedId(next);
    if (!next) return;
    void loadContainerInspect(container, { force: true, urgent: true });
  }, [loadContainerInspect, selectedId]);

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
        {!error && displayList.length === 0 && loading && (
          <SystemPanelLoading message={t('systemManager.common.loading')} />
        )}
        {!error && displayList.length === 0 && !loading && (
          <SystemPanelEmpty icon={Box} message={t('systemManager.docker.empty')} />
        )}

        {displayList.map((container) => {
          const selected = selectedId === container.id;
          const rowPending = pendingAction && pendingAction.id === container.id.slice(0, 12)
            ? pendingAction.action
            : null;
          const selectedInspectKey = selectedContainer ? getContainerInspectKey(selectedContainer) : null;
          const selectedInspectRecord = selectedInspectKey ? inspectByContainerId[selectedInspectKey] : undefined;
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
                    inspect={selectedInspectRecord?.data ?? null}
                    inspectError={selectedInspectRecord?.error ?? null}
                    inspectLoading={selectedInspectRecord?.loading ?? false}
                    stat={statsByContainerId.get(selectedContainer.id) ?? statsByContainerId.get(selectedContainer.id.slice(0, 12)) ?? null}
                    statsLoading={statsLoading}
                    pendingAction={rowPending}
                    onCloseInspect={() => { setSelectedId(null); }}
                    onRunAction={runAction}
                  />
                )}
              </SystemPanelCollapsible>
            </React.Fragment>
          );
        })}
      </SystemPanelList>

      <SystemPanelConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.action === 'kill'
          ? t('systemManager.docker.kill')
          : t('action.remove')}
        message={confirmAction?.action === 'kill'
          ? t('systemManager.docker.confirmKill')
          : t('systemManager.docker.confirmRemove')}
        confirmLabel={confirmAction?.action === 'kill'
          ? t('systemManager.docker.kill')
          : t('action.remove')}
        destructive
        busy={pendingAction !== null}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
        onConfirm={() => {
          const target = confirmAction;
          setConfirmAction(null);
          if (!target) return;
          void runAction(target.containerId, target.action, undefined, { skipConfirm: true });
        }}
      />
    </div>
  );
});
