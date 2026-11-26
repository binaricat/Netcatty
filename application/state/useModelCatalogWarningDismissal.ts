import { useSyncExternalStore } from 'react';

export interface ModelCatalogWarningDismissalState {
  dismissedKeys: ReadonlySet<string>;
  dismissWarning: (cacheKey: string | undefined) => void;
  rearmWarning: (cacheKey: string | undefined) => void;
}

type Listener = () => void;

let dismissedKeysSnapshot: ReadonlySet<string> = new Set();
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlySet<string> {
  return dismissedKeysSnapshot;
}

export function dismissModelCatalogWarningKey(cacheKey: string | undefined): void {
  if (!cacheKey || dismissedKeysSnapshot.has(cacheKey)) return;
  const next = new Set(dismissedKeysSnapshot);
  next.add(cacheKey);
  dismissedKeysSnapshot = next;
  emitChange();
}

export function rearmModelCatalogWarningKey(cacheKey: string | undefined): void {
  if (!cacheKey || !dismissedKeysSnapshot.has(cacheKey)) return;
  const next = new Set(dismissedKeysSnapshot);
  next.delete(cacheKey);
  dismissedKeysSnapshot = next;
  emitChange();
}

export function resetModelCatalogWarningDismissals(): void {
  if (dismissedKeysSnapshot.size === 0) return;
  dismissedKeysSnapshot = new Set();
  emitChange();
}

/**
 * Tracks SDK model catalog cache keys whose composer warning banner was
 * dismissed by the user.
 *
 * Stored at module scope so dismissals survive empty-panel unmounts during
 * normal tab/tool navigation and stay consistent with the shared
 * `sdkRuntimeModelCache`. Dismissals remain scoped by cacheKey so switching
 * agents or config re-arms the banner, and a clean catalog load clears that
 * key so a later failure warns again.
 */
export function useModelCatalogWarningDismissal(): ModelCatalogWarningDismissalState {
  const dismissedKeys = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    dismissedKeys,
    dismissWarning: dismissModelCatalogWarningKey,
    rearmWarning: rearmModelCatalogWarningKey,
  };
}
