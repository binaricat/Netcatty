import { STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

/**
 * Persistence boundary for the "enable Network Device Mode" suggestion.
 *
 * The tip is suggested at most once per host. A host id is recorded as handled
 * either the first time the tip is *displayed* (so simply closing the session
 * does not cause every reconnect to re-nag) or when the user explicitly
 * enables/dismisses it. Displaying it is recorded *silently* (no listener
 * notification) so the instance that is showing the tip keeps it visible until
 * the user acts, while later-mounting panes for the same host are suppressed.
 */

const readHandledIds = (): string[] => {
  const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED);
  return Array.isArray(stored) ? stored : [];
};

export const isNetworkDeviceSuggestionHandled = (hostId: string): boolean =>
  readHandledIds().includes(hostId);

type HandledListener = (hostId: string) => void;
const listeners = new Set<HandledListener>();

/**
 * Subscribe to handled-state changes for any host. The listener receives the
 * host id that changed so callers can match their own host. Fires for in-process
 * resolves (enable/dismiss) and for changes propagated from other windows.
 */
export const subscribeNetworkDeviceSuggestionHandled = (
  listener: HandledListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Mirror of the persisted ids so the cross-window `storage` handler can tell
// which host ids were newly added and notify listeners with a precise id.
let knownHandledIds = readHandledIds();

const persist = (hostId: string): void => {
  const ids = readHandledIds();
  if (!ids.includes(hostId)) {
    localStorageAdapter.write(STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED, [...ids, hostId]);
  }
  knownHandledIds = readHandledIds();
};

const notify = (hostId: string): void => {
  for (const listener of listeners) listener(hostId);
};

/**
 * Record that the tip was shown for a host without notifying listeners, so the
 * instance currently displaying it stays visible while future reconnects and
 * later-mounting instances are suppressed.
 */
export const markNetworkDeviceSuggestionShown = (hostId: string): void => {
  persist(hostId);
};

/**
 * Record an explicit enable/dismiss and notify listeners so any other pane or
 * window still showing the tip for this host hides it too.
 */
export const resolveNetworkDeviceSuggestion = (hostId: string): void => {
  persist(hostId);
  notify(hostId);
};

// Cross-window propagation: the native `storage` event fires in *other*
// same-origin windows (e.g. the detached `#/session-window` peer) when the key
// changes there. localStorageAdapter writes the key verbatim, so we can diff the
// newly added ids and notify listeners for each.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED) return;
    const next = readHandledIds();
    const added = next.filter((id) => !knownHandledIds.includes(id));
    knownHandledIds = next;
    for (const id of added) notify(id);
  });
}
