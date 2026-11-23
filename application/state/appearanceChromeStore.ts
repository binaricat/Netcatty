import { createExternalStore, type StoreListener } from './createExternalStore';

export type AppearanceChromeSnapshot = {
  accentMode: 'theme' | 'custom';
  customAccent: string;
};

const DEFAULT_SNAPSHOT: AppearanceChromeSnapshot = Object.freeze({
  accentMode: 'theme',
  customAccent: '',
});

/**
 * External store for app accent chrome so Terminal leaves can apply custom
 * accent without TerminalLayer rebuilding on every color-picker drag tick.
 */
const store = createExternalStore<AppearanceChromeSnapshot>(DEFAULT_SNAPSHOT, {
  isEqual: (prev, next) =>
    prev.accentMode === next.accentMode && prev.customAccent === next.customAccent,
});

export const appearanceChromeStore = {
  getSnapshot: store.getSnapshot,
  subscribe: store.subscribe,
  setSnapshot: store.setSnapshot,
};

export function publishAppearanceChromeSnapshot(
  snapshot: AppearanceChromeSnapshot,
): void {
  store.setSnapshot(snapshot);
}

export function getAppearanceChromeSnapshot(): AppearanceChromeSnapshot {
  return store.getSnapshot();
}

export function subscribeAppearanceChrome(listener: StoreListener): () => void {
  return store.subscribe(listener);
}

export function useAppearanceChromeStore(): AppearanceChromeSnapshot {
  return store.useStore();
}
