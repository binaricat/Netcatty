import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchProviderModelCatalog,
  providerModelCacheKey,
  readCachedProviderModelCatalog,
  seedProviderModelCatalog,
} from '../../infrastructure/ai/cattyProviderModels';
import type { ComposerPickerModel } from '../../infrastructure/ai/composerPicker';
import type { ProviderConfig } from '../../infrastructure/ai/types';
import { getFetchBridge } from '../settings/tabs/ai/types';

export interface ProviderModelCatalog {
  models: ComposerPickerModel[];
  fetched: boolean;
  loading: boolean;
  error?: string;
}

export function useProviderModelCatalog(
  provider: ProviderConfig | undefined,
  enabled: boolean,
): ProviderModelCatalog {
  const cacheKey = provider && enabled ? providerModelCacheKey(provider) : '';
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const seed = useMemo(
    () => {
      if (!cacheKey) return { models: [], fetched: false };
      const current = providerRef.current;
      return current ? seedProviderModelCatalog(current) : { models: [], fetched: false };
    },
    [cacheKey],
  );
  const [catalog, setCatalog] = useState<Omit<ProviderModelCatalog, 'loading'>>(() => {
    const current = providerRef.current;
    const hit = current && enabled ? readCachedProviderModelCatalog(current) : null;
    return hit ? { models: hit, fetched: true } : seed;
  });
  const [loading, setLoading] = useState(() => {
    const current = providerRef.current;
    return Boolean(enabled && current && !readCachedProviderModelCatalog(current));
  });

  useEffect(() => {
    const current = providerRef.current;
    if (!enabled || !current) {
      setCatalog({ models: [], fetched: false });
      setLoading(false);
      return;
    }

    const hit = readCachedProviderModelCatalog(current);
    if (hit) {
      setCatalog((prev) => (
        prev.fetched && prev.models === hit ? prev : { models: hit, fetched: true }
      ));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setCatalog(seedProviderModelCatalog(current));
    setLoading(true);
    void fetchProviderModelCatalog(current, getFetchBridge()).then((next) => {
      if (cancelled) return;
      setCatalog(next);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, enabled]);

  return {
    models: catalog.models.length > 0 ? catalog.models : seed.models,
    fetched: catalog.fetched,
    loading,
    error: catalog.error,
  };
}
