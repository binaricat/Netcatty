import { STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

/**
 * Persistence boundary for the "enable Network Device Mode" suggestion.
 * We only nag once per host, so the set of already-handled host IDs (whether
 * the user enabled the mode or dismissed the toast) is stored locally.
 */

const readHandledIds = (): string[] => {
  const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED);
  return Array.isArray(stored) ? stored : [];
};

export const isNetworkDeviceSuggestionHandled = (hostId: string): boolean =>
  readHandledIds().includes(hostId);

/**
 * In-process listeners so that dismissing/enabling the tip in one terminal pane
 * immediately hides it in every other mounted instance for the same host.
 * (The DOM `storage` event does not fire in the document that made the write.)
 */
const listeners = new Set<(hostId: string) => void>();

export const subscribeNetworkDeviceSuggestionHandled = (
  listener: (hostId: string) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const markNetworkDeviceSuggestionHandled = (hostId: string): void => {
  const ids = readHandledIds();
  if (!ids.includes(hostId)) {
    localStorageAdapter.write(STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED, [...ids, hostId]);
  }
  for (const listener of listeners) {
    listener(hostId);
  }
};
