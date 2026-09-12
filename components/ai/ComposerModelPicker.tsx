import { Check, ChevronLeft, ChevronRight, Loader2, Pin, Search, Star } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  filterComposerModels,
  resolveComposerEnterModelId,
  resolvePinnedAndRecentModels,
  type ComposerModelPrefEntry,
  type ComposerModelPrefs,
  type ComposerPickerModel,
} from '../../infrastructure/ai/composerPicker';
import type { AgentModelPreset, ProviderConfig } from '../../infrastructure/ai/types';
import { ProviderIconBadge } from '../settings/tabs/ai/ProviderIconBadge';
import { useProviderModelCatalog } from './useProviderModelCatalog';

export const COMPOSER_PROVIDER_PICKER_WIDTH = 260;
export const COMPOSER_MODEL_PICKER_WIDTH = 260;

export interface ComposerModelPickerProps {
  providers?: ProviderConfig[];
  selectedProviderId?: string;
  selectedModelId?: string;
  modelPresets?: AgentModelPreset[];
  prefs: ComposerModelPrefs;
  onSelectProviderModel?: (providerId: string, modelId: string, contextWindow?: number) => void;
  onSelectModel?: (modelId: string) => void;
  onTogglePinned: (entry: ComposerModelPrefEntry) => void;
}

const rowClassName =
  'flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer';

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] tracking-wide text-muted-foreground/45">
    {children}
  </div>
);

const ModelRow: React.FC<{
  model: ComposerPickerModel;
  selected: boolean;
  pinned: boolean;
  onSelect: () => void;
  onTogglePinned: () => void;
  pinLabel: string;
  unpinLabel: string;
}> = ({ model, selected, pinned, onSelect, onTogglePinned, pinLabel, unpinLabel }) => (
  <div className="group/row relative">
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={rowClassName}
    >
      {selected
        ? <Check size={11} className="text-primary shrink-0" />
        : <span className="w-[11px] shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-foreground/88">{model.name}</span>
    </button>
    <button
      type="button"
      aria-label={pinned ? unpinLabel : pinLabel}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onTogglePinned();
      }}
      className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity ${
        pinned
          ? 'text-amber-400/90 opacity-100'
          : 'text-muted-foreground/45 opacity-0 group-hover/row:opacity-100 hover:text-foreground/70'
      }`}
    >
      <Star size={11} fill={pinned ? 'currentColor' : 'none'} />
    </button>
  </div>
);

export const ComposerModelPicker: React.FC<ComposerModelPickerProps> = ({
  providers = [],
  selectedProviderId,
  selectedModelId,
  modelPresets = [],
  prefs,
  onSelectProviderModel,
  onSelectModel,
  onTogglePinned,
}) => {
  const { t } = useI18n();
  const hasProviders = providers.length > 0;
  const [previewProviderId, setPreviewProviderId] = useState(
    selectedProviderId || providers[0]?.id || '',
  );
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'models' | 'providers'>('models');

  useEffect(() => {
    if (selectedProviderId) setPreviewProviderId(selectedProviderId);
  }, [selectedProviderId]);

  const previewProvider = hasProviders
    ? providers.find((provider) => provider.id === previewProviderId) ?? providers[0]
    : undefined;
  const catalog = useProviderModelCatalog(previewProvider, hasProviders);

  const models = useMemo<ComposerPickerModel[]>(() => {
    if (hasProviders) return catalog.models;
    return modelPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
    }));
  }, [catalog.models, hasProviders, modelPresets]);

  const filtered = useMemo(() => filterComposerModels(models, query), [models, query]);
  const grouped = useMemo(
    () => resolvePinnedAndRecentModels({
      models: filtered,
      prefs,
      providerId: previewProvider?.id,
      allowMissing: Boolean(previewProvider?.id) && !query.trim(),
    }),
    [filtered, prefs, previewProvider?.id, query],
  );
  const pinnedKeys = useMemo(
    () => new Set(
      prefs.pinned
        .filter((entry) => !previewProvider || !entry.providerId || entry.providerId === previewProvider.id)
        .map((entry) => entry.modelId),
    ),
    [prefs.pinned, previewProvider],
  );

  const trimmedQuery = query.trim();
  const showCustom = Boolean(
    hasProviders
    && trimmedQuery
    && !models.some((model) => model.id.toLowerCase() === trimmedQuery.toLowerCase()),
  );

  const selectModel = (modelId: string) => {
    const contextWindow = models.find((model) => model.id === modelId)?.contextWindow;
    if (hasProviders && previewProvider) {
      onSelectProviderModel?.(previewProvider.id, modelId, contextWindow);
      return;
    }
    onSelectModel?.(modelId);
  };

  const prefEntryFor = (modelId: string): ComposerModelPrefEntry => (
    previewProvider ? { providerId: previewProvider.id, modelId } : { modelId }
  );

  if (hasProviders && view === 'providers') {
    return (
      <div className="w-[260px] max-w-[calc(100vw-16px)] py-1">
        <button
          type="button"
          onClick={() => setView('models')}
          className={rowClassName}
        >
          <ChevronLeft size={12} className="text-muted-foreground/60 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
            {t('ai.chat.providers')}
          </span>
        </button>
        <div className="mx-2 my-1 border-t border-border/40" />
        {providers.map((provider) => {
          const isBound = provider.id === selectedProviderId;
          return (
            <button
              key={provider.id}
              type="button"
              role="option"
              aria-selected={isBound}
              onClick={() => {
                setPreviewProviderId(provider.id);
                setQuery('');
                setView('models');
              }}
              className={rowClassName}
            >
              <ProviderIconBadge provider={provider} size="xs" />
              <span className="min-w-0 flex-1 truncate text-foreground/88">{provider.name}</span>
              {isBound && <Check size={11} className="text-primary shrink-0" />}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="w-[260px] max-w-[calc(100vw-16px)] py-1">
      {hasProviders && previewProvider && (
        <>
          <button
            type="button"
            aria-label={t('ai.chat.selectProvider')}
            onClick={() => setView('providers')}
            className={rowClassName}
          >
            <ProviderIconBadge provider={previewProvider} size="xs" />
            <span className="min-w-0 flex-1 truncate text-foreground/88">{previewProvider.name}</span>
            <ChevronRight size={12} className="text-muted-foreground/50 shrink-0" />
          </button>
        </>
      )}

      <div className="px-2 pb-1">
        <div className="flex h-7 items-center gap-1.5 rounded-md bg-muted/40 px-2">
          <Search size={11} className="text-muted-foreground/50 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && trimmedQuery) {
                event.preventDefault();
                const nextId = resolveComposerEnterModelId({
                  query: trimmedQuery,
                  models,
                  grouped,
                  filtered,
                  showCustom,
                });
                if (nextId) selectModel(nextId);
              }
            }}
            placeholder={t('ai.chat.searchModels')}
            className="h-full w-full bg-transparent text-[12px] text-foreground/88 outline-none placeholder:text-muted-foreground/40"
          />
        </div>
      </div>

      <div className="max-h-[280px] overflow-y-auto">
        {catalog.loading && (
          <div className="flex h-8 items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground/55">
            <Loader2 size={11} className="animate-spin" />
            {t('ai.chat.loadingModels')}
          </div>
        )}

        {showCustom && (
          <button
            type="button"
            onClick={() => selectModel(trimmedQuery)}
            className={rowClassName}
          >
            <Pin size={11} className="text-muted-foreground/55 shrink-0" />
            <span className="min-w-0 truncate text-foreground/85">
              {t('ai.chat.useCustomModel').replace('{id}', trimmedQuery)}
            </span>
          </button>
        )}

        {grouped.pinned.length > 0 && (
          <>
            <SectionLabel>{t('ai.chat.pinned')}</SectionLabel>
            {grouped.pinned.map((model) => (
              <ModelRow
                key={`pin-${model.id}`}
                model={model}
                selected={model.id === selectedModelId && (!hasProviders || previewProvider?.id === selectedProviderId)}
                pinned
                onSelect={() => selectModel(model.id)}
                onTogglePinned={() => onTogglePinned(prefEntryFor(model.id))}
                pinLabel={t('ai.chat.pinModel')}
                unpinLabel={t('ai.chat.unpinModel')}
              />
            ))}
          </>
        )}

        {grouped.recent.length > 0 && (
          <>
            <SectionLabel>{t('ai.chat.recent')}</SectionLabel>
            {grouped.recent.map((model) => (
              <ModelRow
                key={`recent-${model.id}`}
                model={model}
                selected={model.id === selectedModelId && (!hasProviders || previewProvider?.id === selectedProviderId)}
                pinned={pinnedKeys.has(model.id)}
                onSelect={() => selectModel(model.id)}
                onTogglePinned={() => onTogglePinned(prefEntryFor(model.id))}
                pinLabel={t('ai.chat.pinModel')}
                unpinLabel={t('ai.chat.unpinModel')}
              />
            ))}
          </>
        )}

        {(grouped.pinned.length > 0 || grouped.recent.length > 0) && grouped.rest.length > 0 && (
          <SectionLabel>{t('ai.chat.models')}</SectionLabel>
        )}

        {grouped.rest.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            selected={model.id === selectedModelId && (!hasProviders || previewProvider?.id === selectedProviderId)}
            pinned={pinnedKeys.has(model.id)}
            onSelect={() => selectModel(model.id)}
            onTogglePinned={() => onTogglePinned(prefEntryFor(model.id))}
            pinLabel={t('ai.chat.pinModel')}
            unpinLabel={t('ai.chat.unpinModel')}
          />
        ))}

        {!catalog.loading && filtered.length === 0 && !showCustom && (
          <div className="px-2.5 py-2 text-[11px] text-muted-foreground/50">
            {catalog.error || t('ai.chat.noMatchingModels')}
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(ComposerModelPicker);
