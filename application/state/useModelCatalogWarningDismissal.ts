import { useCallback, useState } from 'react';

export interface ModelCatalogWarningDismissalState {
  dismissedKeys: ReadonlySet<string>;
  dismissWarning: (cacheKey: string | undefined) => void;
  rearmWarning: (cacheKey: string | undefined) => void;
}

/**
 * Tracks SDK model catalog cache keys whose composer warning banner was
 * dismissed by the user.
 *
 * Dismissals are scoped by cacheKey so switching agents or config re-arms the
 * banner, and a clean catalog load clears that key so a later failure warns
 * again.
 */
export function useModelCatalogWarningDismissal(): ModelCatalogWarningDismissalState {
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const dismissWarning = useCallback((cacheKey: string | undefined) => {
    if (!cacheKey) return;
    setDismissedKeys((current) => {
      if (current.has(cacheKey)) return current;
      const next = new Set(current);
      next.add(cacheKey);
      return next;
    });
  }, []);

  const rearmWarning = useCallback((cacheKey: string | undefined) => {
    if (!cacheKey) return;
    setDismissedKeys((current) => {
      if (!current.has(cacheKey)) return current;
      const next = new Set(current);
      next.delete(cacheKey);
      return next;
    });
  }, []);

  return {
    dismissedKeys,
    dismissWarning,
    rearmWarning,
  };
}
