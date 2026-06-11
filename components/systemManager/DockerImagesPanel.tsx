import { Layers, Tag, Trash2 } from 'lucide-react';
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
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
  SystemPanelList,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelSearch,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface DockerImagesPanelProps {
  sessionId: string;
  isVisible: boolean;
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
  backend,
  listRefreshIntervalSec,
}: DockerImagesPanelProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Record<string, unknown> | null>(null);
  const inspectSeqRef = useRef(0);

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
    isVisible,
    (prev, next) => mergePollListByKey(prev, next, dockerImageRowKey, dockerImageInfoEqual),
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

  const handleRemove = useCallback(async (image: DockerImageInfo) => {
    const label = image.name || image.id.slice(0, 12);
    const ok = window.confirm(t('systemManager.docker.confirmRemoveImage', { name: label }));
    if (!ok) return;
    const result = await backend.dockerImageAction({
      sessionId,
      action: 'rm',
      imageId: image.id.slice(0, 12),
      force: image.tag === '<none>',
    });
    if (!result.success) {
      showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
      return;
    }
    if (selectedId === dockerImageRowKey(image)) {
      setSelectedId(null);
      setInspect(null);
      inspectSeqRef.current += 1;
    }
    await refresh();
  }, [backend, refresh, selectedId, sessionId, t]);

  const handlePrune = async (all: boolean) => {
    const ok = window.confirm(all
      ? t('systemManager.docker.confirmPruneAll')
      : t('systemManager.docker.confirmPrune'));
    if (!ok) return;
    const result = await backend.dockerImageAction({ sessionId, action: 'prune', all });
    if (!result.success) {
      showSystemManagerError(result.error || t('systemManager.errors.actionFailed'), t('common.error'));
      return;
    }
    await refresh();
  };

  const [tagTarget, setTagTarget] = useState<DockerImageInfo | null>(null);

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

  const selectImage = useCallback(async (image: DockerImageInfo) => {
    const rowKey = dockerImageRowKey(image);
    const next = selectedId === rowKey ? null : rowKey;
    setSelectedId(next);
    setInspect(null);
    const seq = ++inspectSeqRef.current;
    if (!next) return;
    const result = await backend.dockerImageInspect({
      sessionId,
      imageId: image.id.slice(0, 12),
    });
    if (inspectSeqRef.current !== seq) return;
    setInspect(result.success ? (result.inspect ?? null) : null);
  }, [backend, selectedId, sessionId]);

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
              onClick={() => void handlePrune(false)}
              className="shrink-0 h-7 px-2 rounded-md text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              {t('systemManager.docker.prune')}
            </button>
            <button
              type="button"
              onClick={() => void handlePrune(true)}
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
        {!error && displayList.length === 0 && !loading && (
          <SystemPanelEmpty icon={Layers} message={t('systemManager.docker.imagesEmpty')} />
        )}

        {displayList.map((image) => {
          const rowKey = dockerImageRowKey(image);
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
                {inspect && (
                  <DockerInspectView
                    kind="image"
                    data={inspect}
                    onClose={() => { setSelectedId(null); setInspect(null); }}
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
    </div>
  );
});
