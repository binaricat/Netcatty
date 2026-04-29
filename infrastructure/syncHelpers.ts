import type { KnownHost } from '../domain/models';
import { STORAGE_KEY_KNOWN_HOSTS } from './config/storageKeys';
import { localStorageAdapter } from './persistence/localStorageAdapter';

/**
 * Get effective knownHosts for local vault payloads.
 *
 * If the hook/state knownHosts is empty but localStorage has data,
 * read from localStorage so local backups do not miss entries while
 * async store initialization is still settling.
 */
export function getEffectiveKnownHosts(
  knownHostsFromState: KnownHost[] | undefined,
): KnownHost[] | undefined {
  if (knownHostsFromState && knownHostsFromState.length > 0) {
    return knownHostsFromState;
  }

  const stored = localStorageAdapter.read<KnownHost[]>(STORAGE_KEY_KNOWN_HOSTS);
  if (stored && Array.isArray(stored) && stored.length > 0) {
    return stored;
  }

  return knownHostsFromState;
}
