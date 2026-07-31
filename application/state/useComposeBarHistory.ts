import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendComposeBarHistory,
  normalizeComposeBarHistory,
} from '../../domain/composeBarHistory';
import { STORAGE_KEY_COMPOSE_BAR_HISTORY } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

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
  const skipNextPersistRef = useRef(true);

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    localStorageAdapter.write(STORAGE_KEY_COMPOSE_BAR_HISTORY, entries);
  }, [entries]);

  const push = useCallback((command: string) => {
    setEntries((prev) => appendComposeBarHistory(prev, command));
  }, []);

  return { entries, push } as const;
}
