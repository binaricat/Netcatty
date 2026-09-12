import { localStorageAdapter } from '../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_COMPOSER_MODEL_PREFS } from '../config/storageKeys';
import {
  COMPOSER_PINNED_MODEL_LIMIT,
  COMPOSER_RECENT_MODEL_LIMIT,
  parseComposerModelPrefs,
  toggleComposerPinnedPref,
  upsertComposerPrefFront,
  type ComposerModelPrefEntry,
  type ComposerModelPrefs,
} from './composerPicker';

type PrefsByScope = Record<string, ComposerModelPrefs>;

function emptyPrefs(): ComposerModelPrefs {
  return { recent: [], pinned: [] };
}

function readAllPrefs(): PrefsByScope {
  try {
    const raw = localStorageAdapter.read<PrefsByScope>(STORAGE_KEY_AI_COMPOSER_MODEL_PREFS);
    if (!raw || typeof raw !== 'object') return {};
    const next: PrefsByScope = {};
    for (const [scope, value] of Object.entries(raw)) {
      next[scope] = parseComposerModelPrefs(value);
    }
    return next;
  } catch {
    return {};
  }
}

const prefsListeners = new Set<() => void>();

function notifyComposerModelPrefsChanged(): void {
  for (const listener of prefsListeners) listener();
}

export function subscribeComposerModelPrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => {
    prefsListeners.delete(listener);
  };
}

function writeAllPrefs(prefs: PrefsByScope): void {
  try {
    localStorageAdapter.write(STORAGE_KEY_AI_COMPOSER_MODEL_PREFS, prefs);
  } catch {
    // Tests and SSR have no storage. Recent/pinned stay in-memory only.
  }
  notifyComposerModelPrefsChanged();
}

export function readComposerModelPrefs(scope: string): ComposerModelPrefs {
  return parseComposerModelPrefs(readAllPrefs()[scope] ?? emptyPrefs());
}

export function rememberComposerRecentModel(
  scope: string,
  entry: ComposerModelPrefEntry,
): ComposerModelPrefs {
  const all = readAllPrefs();
  const current = parseComposerModelPrefs(all[scope]);
  const next: ComposerModelPrefs = {
    ...current,
    recent: upsertComposerPrefFront(current.recent, entry, COMPOSER_RECENT_MODEL_LIMIT),
  };
  all[scope] = next;
  writeAllPrefs(all);
  return next;
}

export function toggleComposerPinnedModel(
  scope: string,
  entry: ComposerModelPrefEntry,
): ComposerModelPrefs {
  const all = readAllPrefs();
  const current = parseComposerModelPrefs(all[scope]);
  const next: ComposerModelPrefs = {
    ...current,
    pinned: toggleComposerPinnedPref(current.pinned, entry, COMPOSER_PINNED_MODEL_LIMIT),
  };
  all[scope] = next;
  writeAllPrefs(all);
  return next;
}
