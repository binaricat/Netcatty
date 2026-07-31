import { useCallback, useEffect, useState } from 'react';
import {
  appendComposeBarHistory,
  normalizeComposeBarHistory,
} from '../../domain/composeBarHistory';
import { STORAGE_KEY_COMPOSE_BAR_HISTORY } from '../../infrastructure/config/storageKeys';
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from '../../infrastructure/persistence/localStorageAdapter';

function readHistory(): string[] {
  return normalizeComposeBarHistory(
    localStorageAdapter.read<unknown>(STORAGE_KEY_COMPOSE_BAR_HISTORY),
  );
}

/**
 * Persisted compose-bar send history used for Up/Down recall in the prompt bar.
 */
export function useComposeBarHistory() {
  const [entries, setEntries] = useState(readHistory);

  useEffect(() => {
    const sync = (event: Event) => {
      if (event.type === LOCAL_STORAGE_ADAPTER_CHANGED_EVENT) {
        const key = (event as CustomEvent<{ key?: string }>).detail?.key;
        if (key !== STORAGE_KEY_COMPOSE_BAR_HISTORY) return;
      }
      setEntries(readHistory());
    };

    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
    };
  }, []);

  const push = useCallback((command: string) => {
    // Read and write synchronously so two mounted compose bars cannot append
    // from stale snapshots and overwrite each other's command.
    const next = appendComposeBarHistory(readHistory(), command);
    localStorageAdapter.write(STORAGE_KEY_COMPOSE_BAR_HISTORY, next);
    setEntries(next);
    return next;
  }, []);

  return { entries, push } as const;
}
