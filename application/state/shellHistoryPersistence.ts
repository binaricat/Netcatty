import type { ShellHistoryEntry } from '../../domain/models';
import { sanitizeGlobalHistoryEntries } from '../../domain/globalHistory';
import { STORAGE_KEY_SHELL_HISTORY } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

type ShellHistoryStorage = {
  read<T>(key: string): T | null;
  write<T>(key: string, value: T): boolean;
};

export function loadSanitizedShellHistory(
  storage: ShellHistoryStorage = localStorageAdapter,
  storageKey = STORAGE_KEY_SHELL_HISTORY,
): ShellHistoryEntry[] | null {
  const savedShellHistory = storage.read<ShellHistoryEntry[]>(storageKey);
  if (!savedShellHistory) return null;

  const cleanedShellHistory = sanitizeGlobalHistoryEntries(savedShellHistory);
  if (cleanedShellHistory.length !== savedShellHistory.length) {
    storage.write(storageKey, cleanedShellHistory);
  }
  return cleanedShellHistory;
}
