import { Layers, Loader2, Tag, Trash2 } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { dockerImageRowKey, type DockerImageInfo } from '../../domain/systemManager/types';
import { dockerImageInfoEqual } from '../../domain/systemManager/pollEquals';
import { DockerImageIcon } from './DockerImageIcon';
import { DockerInspectView } from './DockerInspectView';
import { mergePollListByKey, useStableListOrder } from './listStable';
import {
  SystemPanelCollapsible,
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelInlineError,
  SystemPanelList,
  SystemPanelLoading,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSearch,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';
import { useAsyncRecordCache } from './hooks/useAsyncRecordCache';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;

type PendingImageConfirm =
  | { kind: 'remove'; image: DockerImageInfo; label: string }
  | { kind: 'prune'; all: boolean };

interface DockerImagesPanelProps {
  sessionId: string;
  isVisible: boolean;
  warmupEnabled?: boolean;
  backend: Backend;
  listRefreshIntervalSec: number;
}

const DockerImageRow = memo(function DockerImageRow({
  image,
  displayName,
  selected,
  onSelect,
  onTag,
  onRemove,
}: {
  image: DockerImageInfo;
  displayName: string;
  selected: boolean;
  onSelect: (image: DockerImageInfo) => void;
  onTag: (image: DockerImageInfo) => void;
  onRemove: (image: DockerImageInfo) => void;
}) {
  const { t } = useI18n();
  const shortId = image.id.slice(0, 12);

  return (
    <SystemPanelRow
      selected={selected}
      onClick={() => onSelect(image)}
      leading={<DockerImageIcon image={displayName} />}
      title={displayName}
      subtitle={`${shortId} · ${image.size}${image.createdAt ? ` · ${image.createdAt}` : ''}`}
      trailing={(
        <div className="flex shrink-0 items-center gap-1">
          <SystemPanelRoundButton
            title={t('systemManager.docker.tag')}
            onClick={() => onTag(image)}
          >
            <Tag size={12} />
          </SystemPanelRoundButton>
          <SystemPanelRoundButton
            title={t('systemManager.docker.confirmRemoveImage', { name: displayName })}
            destructive
            onClick={() => onRemove(image)}
          >
            <Trash2 size={12} />
          </SystemPanelRoundButton>
        </div>
      )}
    />
  );
});

export const DockerImagesPanel = memo(function DockerImagesPanel({
  sessionId,
  isVisible,
  warmupEnabled = false,
  backend,
  listRefreshIntervalSec,
}: DockerImagesPanelProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tagTarget, setTagTarget] = useState<DockerImageInfo | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<PendingImageConfirm | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionGenerationRef = useRef(0);

  useEffect(() => {
    actionGenerationRef.current += 1;
    setSelectedId(null);
    setTagTarget(null);
    setConfirmTarget(null);
    // Clear busy so a hung/in-flight action from the previous session cannot
    // leave the new session's confirm dialog permanently disabled.
    setActionBusy(false);
  }, [sessionId]);

  const imagesFetcher = useCallback(async () => {
    const result = await backend.listDockerImages(sessionId);
    if (!result.success || !result.images) {
      throw new Error(result.error || stableT('systemManager.errors.loadDockerImages'));
    }
    return result.images;
  }, [backend, sessionId, stableT]);

  const listIntervalMs = Math.max(3, listRefreshIntervalSec) * 1000;
  const { data: images, error, loading, refresh } = usePolling<DockerImageInfo[]>(
    imagesFetcher,
    listIntervalMs,
    isVisible || warmupEnabled,
    (prev, next) => mergePollListByKey(prev, next, dockerImageRowKey, dockerImageInfoEqual),
    { poll: isVisible, resetKey: sessionId },
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = images ?? [];
    if (!q) return list;
    return list.filter((image) => {
      const shortId = image.id.slice(0, 12);
      return image.repository.toLowerCase().includes(q)
        || image.tag.toLowerCase().includes(q)
        || image.name.toLowerCase().includes(q)
        || shortId.toLowerCase().includes(q);
    });
  }, [images, query]);

  const compareImages = useCallback(
    (a: DockerImageInfo, b: DockerImageInfo) => {
      const repo = a.repository.localeCompare(b.repository);
      if (repo !== 0) return repo;
      return a.tag.localeCompare(b.tag);
    },
    [],
  );
  const displayList = useStableListOrder(filtered, dockerImageRowKey, query, compareImages);

  const getImageInspectKey = useCallback((image: DockerImageInfo) => (
    `${sessionId}:${dockerImageRowKey(image)}`
  ), [sessionId]);
  const fetchImageInspect = useCallback(async (image: DockerImageInfo) => {
    const result = await backend.dockerImageInspect({
      sessionId,
      imageId: image.id.slice(0, 12),
    });
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.actionFailed'));
    }
    return result.inspect ?? null;
  }, [backend, sessionId, stableT]);
  const {
    records: inspectByImageKey,
    loadRecord: loadImageInspect,
    invalidateRecord: invalidateImageInspect,
  } = useAsyncRecordCache<DockerImageInfo, Record<string, unknown>>({
    items: images ?? [],
    enabled: isVisible && (images?.length ?? 0) > 0,
    getKey: getImageInspectKey,
    fetchRecord: fetchImageInspect,
    prefetchLimit: 24,
    prefetchDelayMs: 40,
    staleTimeMs: 20_000,
  });

  const executeRemove = useCallback(async (image: DockerImageInfo) => {
    const actionGeneration = actionGenerationRef.current;
    setActionBusy(true);
    try {
      const result = await backend.dockerImageAction({
        sessionId,
        action: 'rm',
        imageId: image.id.slice(0, 12),
        force: image.tag === '<none>',
      });
      if (actionGenerationRef.current !== actionGeneration) return;
      if (!result.success) {
        showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
        return;
      }
      if (selectedId === dockerImageRowKey(image)) {
        setSelectedId(null);
      }
      invalidateImageInspect(getImageInspectKey(image));
      await refresh();
    } finally {
      if (actionGenerationRef.current === actionGeneration) {
        setActionBusy(false);
      }
    }
  }, [backend, getImageInspectKey, invalidateImageInspect, refresh, selectedId, sessionId, t]);

  const handleRemove = useCallback((image: DockerImageInfo) => {
    const label = image.name || image.id.slice(0, 12);
    setConfirmTarget({ kind: 'remove', image, label });
  }, []);

  const executePrune = useCallback(async (all: boolean) => {
    const actionGeneration = actionGenerationRef.current;
    setActionBusy(true);
    try {
      const result = await backend.dockerImageAction({ sessionId, action: 'prune', all });
      if (actionGenerationRef.current !== actionGeneration) return;
      if (!result.success) {
        showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
        return;
      }
      await refresh();
    } finally {
      if (actionGenerationRef.current === actionGeneration) {
        setActionBusy(false);
      }
    }
  }, [backend, refresh, sessionId, t]);

  const handlePrune = useCallback((all: boolean) => {
    setConfirmTarget({ kind: 'prune', all });
  }, []);

  const handleTagSubmit = async (image: DockerImageInfo, repository: string, tag: string) => {
    const result = await backend.dockerImageAction({
      sessionId,
      action: 'tag',
      imageId: image.id.slice(0, 12),
      repository,
      tag: tag || 'latest',
    });
    if (!result.success) {
      showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
      return;
    }
    await refresh();
  };

  const selectImage = useCallback((image: DockerImageInfo) => {
    const rowKey = dockerImageRowKey(image);
    const next = selectedId === rowKey ? null : rowKey;
    setSelectedId(next);
    if (!next) return;
    void loadImageInspect(image, { force: true, urgent: true });
  }, [loadImageInspect, selectedId]);

  const openTagDialog = useCallback((image: DockerImageInfo) => {
    setTagTarget(image);
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-section="docker-images">
      <SystemPanelToolbar
        trailing={(
          <>
            <button
              type="button"
              onClick={() => handlePrune(false)}
              className="shrink-0 h-7 px-2 rounded-md text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              {t('systemManager.docker.prune')}
            </button>
            <button
              type="button"
              onClick={() => handlePrune(true)}
              className="shrink-0 h-7 px-2 rounded-md text-[10px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              {t('systemManager.docker.pruneAll')}
            </button>
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
          placeholder={t('systemManager.docker.searchImages')}
        />
      </SystemPanelToolbar>

      <SystemPanelMetaBar>
        {t('systemManager.docker.imagesMeta', { count: String(displayList.length) })}
      </SystemPanelMetaBar>

      <SystemPanelList>
        {error && (
          <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
        )}
        {!error && displayList.length === 0 && loading && (
          <SystemPanelLoading message={t('systemManager.common.loading')} />
        )}
        {!error && displayList.length === 0 && !loading && (
          <SystemPanelEmpty icon={Layers} message={t('systemManager.docker.imagesEmpty')} />
        )}

        {displayList.map((image) => {
          const rowKey = dockerImageRowKey(image);
          const inspectKey = getImageInspectKey(image);
          const shortId = image.id.slice(0, 12);
          const displayName = image.repository && image.tag
            ? `${image.repository}:${image.tag}`
            : image.name || shortId;
          const selected = selectedId === rowKey;

          return (
            <React.Fragment key={rowKey}>
              <DockerImageRow
                image={image}
                displayName={displayName}
                selected={selected}
                onSelect={selectImage}
                onTag={openTagDialog}
                onRemove={handleRemove}
              />
              <SystemPanelCollapsible open={selected}>
                {inspectByImageKey[inspectKey]?.loading && !inspectByImageKey[inspectKey]?.data && (
                  <div className="flex items-center gap-1.5 border-b border-border/40 bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
                    <Loader2 size={11} className="animate-spin" />
                    {t('systemManager.common.loadingDetails')}
                  </div>
                )}
                {inspectByImageKey[inspectKey]?.error && !inspectByImageKey[inspectKey]?.data && (
                  <SystemPanelInlineError message={inspectByImageKey[inspectKey].error} />
                )}
                {inspectByImageKey[inspectKey]?.data && (
                  <DockerInspectView
                    kind="image"
                    data={inspectByImageKey[inspectKey].data}
                    onClose={() => { setSelectedId(null); }}
                  />
                )}
              </SystemPanelCollapsible>
            </React.Fragment>
          );
        })}
      </SystemPanelList>

      <SystemPanelPromptDialog
        open={tagTarget !== null}
        title={t('systemManager.docker.tag')}
        fields={[
          {
            id: 'repository',
            label: t('systemManager.docker.tagRepoPrompt'),
            initialValue: tagTarget?.repository === '<none>' ? '' : tagTarget?.repository ?? '',
            mono: true,
          },
          {
            id: 'tag',
            label: t('systemManager.docker.tagNamePrompt'),
            initialValue: !tagTarget?.tag || tagTarget.tag === '<none>' ? 'latest' : tagTarget.tag,
            mono: true,
          },
        ]}
        confirmLabel={t('systemManager.docker.tag')}
        onOpenChange={(open) => { if (!open) setTagTarget(null); }}
        onSubmit={(values) => {
          const image = tagTarget;
          setTagTarget(null);
          if (!image) return;
          void handleTagSubmit(image, values.repository, values.tag);
        }}
      />

      <SystemPanelConfirmDialog
        open={confirmTarget !== null}
        title={confirmTarget?.kind === 'prune'
          ? (confirmTarget.all ? t('systemManager.docker.pruneAll') : t('systemManager.docker.prune'))
          : t('action.remove')}
        message={confirmTarget?.kind === 'prune'
          ? (confirmTarget.all
            ? t('systemManager.docker.confirmPruneAll')
            : t('systemManager.docker.confirmPrune'))
          : t('systemManager.docker.confirmRemoveImage', {
            name: confirmTarget?.kind === 'remove' ? confirmTarget.label : '',
          })}
        confirmLabel={confirmTarget?.kind === 'prune'
          ? (confirmTarget.all ? t('systemManager.docker.pruneAll') : t('systemManager.docker.prune'))
          : t('action.remove')}
        destructive
        busy={actionBusy}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setConfirmTarget(null);
        }}
        onConfirm={() => {
          const target = confirmTarget;
          setConfirmTarget(null);
          if (!target) return;
          if (target.kind === 'remove') {
            void executeRemove(target.image);
            return;
          }
          void executePrune(target.all);
        }}
      />
    </div>
  );
});
