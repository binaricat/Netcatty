import { useSyncExternalStore } from 'react';

import type { KnownHost } from '../../types';
import type { AppActiveTabChromeProps } from './AppActiveTabChrome';
import { appViewDomainsEqual, type AppViewDomains } from './appViewDomains';

type Listener = () => void;

export type AppShellOverlays = {
  onAddKnownHost: (knownHost: KnownHost) => void;
  deleteHostConfirm: { hostId: string; name: string } | null;
  onCancelDeleteHost: () => void;
  onConfirmDeleteHost: () => void;
};

export type AppShellPropsSnapshot = {
  domains: AppViewDomains | null;
  chrome: AppActiveTabChromeProps | null;
  overlays: AppShellOverlays | null;
};

const EMPTY: AppShellPropsSnapshot = Object.freeze({
  domains: null,
  chrome: null,
  overlays: null,
});

/**
 * Host islands publish domain / chrome / overlay bags here. `AppShell`
 * subscribes via `useSyncExternalStore` and only re-renders when bag
 * identities change (`appViewDomainsEqual` + chrome/overlays identity).
 */
class AppShellPropsStore {
  private snapshot: AppShellPropsSnapshot = EMPTY;
  private listeners = new Set<Listener>();

  getSnapshot = (): AppShellPropsSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setDomains(domains: AppViewDomains): void {
    const prev = this.snapshot;
    if (prev.domains && appViewDomainsEqual(prev.domains, domains)) {
      return;
    }
    this.snapshot = { ...prev, domains };
    for (const listener of this.listeners) listener();
  }

  setChrome(chrome: AppActiveTabChromeProps): void {
    if (this.snapshot.chrome === chrome) return;
    this.snapshot = { ...this.snapshot, chrome };
    for (const listener of this.listeners) listener();
  }

  setOverlays(overlays: AppShellOverlays): void {
    if (this.snapshot.overlays === overlays) return;
    this.snapshot = { ...this.snapshot, overlays };
    for (const listener of this.listeners) listener();
  }

  setDomainSlice<K extends keyof AppViewDomains>(
    key: K,
    slice: AppViewDomains[K],
  ): void {
    const prev = this.snapshot.domains;
    if (prev && prev[key] === slice) return;
    const domains = {
      vault: prev?.vault ?? {},
      terminal: prev?.terminal ?? {},
      chrome: prev?.chrome ?? {},
      dialogs: prev?.dialogs ?? {},
      mounts: prev?.mounts ?? {},
      [key]: slice,
    } as AppViewDomains;
    this.setDomains(domains);
  }
}

export const appShellPropsStore = new AppShellPropsStore();

export function publishAppShellDomainSlice<K extends keyof AppViewDomains>(
  key: K,
  slice: AppViewDomains[K],
): void {
  appShellPropsStore.setDomainSlice(key, slice);
}

export function publishAppShellChrome(chrome: AppActiveTabChromeProps): void {
  appShellPropsStore.setChrome(chrome);
}

export function publishAppShellOverlays(overlays: AppShellOverlays): void {
  appShellPropsStore.setOverlays(overlays);
}

export function getAppShellPropsSnapshot(): AppShellPropsSnapshot {
  return appShellPropsStore.getSnapshot();
}

export function subscribeAppShellProps(listener: Listener): () => void {
  return appShellPropsStore.subscribe(listener);
}

export function useAppShellProps(): AppShellPropsSnapshot {
  return useSyncExternalStore(
    subscribeAppShellProps,
    getAppShellPropsSnapshot,
    getAppShellPropsSnapshot,
  );
}
