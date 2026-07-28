import { STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

/**
 * Persistence boundary for the "enable Network Device Mode" suggestion.
 *
 * The tip is suggested at most once per host. A host is recorded as handled
 * either the first time the tip is *displayed* (so simply closing the session
 * does not re-nag on every reconnect) or when the user explicitly
 * enables/dismisses it. Displaying it is recorded *silently* (no listener
 * notification) so the instance showing the tip keeps it until the user acts,
 * while later-mounting instances for the same host are suppressed.
 *
 * State is stored under one key *per host* rather than a single shared array:
 * localStorage has no atomic read-modify-write, so two windows appending to a
 * shared array concurrently would drop one another's markers. Independent keys
 * never clobber each other.
 */

const keyPrefix = `${STORAGE_KEY_NETWORK_DEVICE_SUGGEST_HANDLED}:`;
const keyForHost = (hostId: string): string => `${keyPrefix}${hostId}`;

export const isNetworkDeviceSuggestionHandled = (hostId: string): boolean =>
  localStorageAdapter.readBoolean(keyForHost(hostId)) === true;

type HandledListener = (hostId: string) => void;
const listeners = new Set<HandledListener>();

/**
 * Subscribe to handled-state changes for any host. The listener receives the
 * host id that changed. Fires for in-process resolves (enable/dismiss) and for
 * changes propagated from other renderer windows via the `storage` event.
 */
export const subscribeNetworkDeviceSuggestionHandled = (
  listener: HandledListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
  localStorageAdapter.writeBoolean(keyForHost(hostId), true);
};

/**
 * Record an explicit enable/dismiss and notify listeners so any other pane or
 * window still showing the tip for this host hides it too.
 */
export const resolveNetworkDeviceSuggestion = (hostId: string): void => {
  localStorageAdapter.writeBoolean(keyForHost(hostId), true);
  notify(hostId);
};

// Cross-window propagation: the native `storage` event fires in *other*
// same-origin windows (e.g. the detached `#/session-window` peer) when a key
// changes there. Per-host keys let us recover the host id directly.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(keyPrefix)) return;
    notify(event.key.slice(keyPrefix.length));
  });
}
